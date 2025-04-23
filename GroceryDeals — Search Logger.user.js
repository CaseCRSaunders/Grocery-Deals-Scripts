// ==UserScript==
// @name         GroceryDeals — Search Logger
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Capture every unique search term and export as JSON.
// @match        https://admin.mygrocerydeals.com/admin/tasks/*
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://raw.githubusercontent.com/YOUR_USERNAME/Grocery-Deals/main/Search-Logger.user.js
// @updateURL    https://raw.githubusercontent.com/YOUR_USERNAME/Grocery-Deals/main/Search-Logger.user.js
// ==/UserScript==


(function() {
  'use strict';

  // ————————————— SPA URL-change detection —————————————
  function patchHistory(type) {
    const orig = history[type];
    history[type] = function() {
      const ret = orig.apply(this, arguments);
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    };
  }
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));

  // ———————— GM storage helpers ————————
  async function loadTerms() {
    return await GM_getValue('GDSearchLoggedTerms', []);
  }
  async function saveTerms(arr) {
    await GM_setValue('GDSearchLoggedTerms', arr);
  }

  // ———————— Hook the search-field logger ————————
  async function hookSearchLogger() {
    if (window.__gd_searchLoggerHooked) return;
    window.__gd_searchLoggerHooked = true;

    const FIELD_SELECTOR = 'input[name="query"]';

    function logTerm(raw) {
      const val = raw.trim();
      if (!val) return;
      loadTerms().then(terms => {
        if (!terms.includes(val)) {
          terms.push(val);
          saveTerms(terms);
          console.log('✅ Logged term:', val);
        }
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches(FIELD_SELECTOR)) {
        logTerm(e.target.value);
      }
    });

    document.addEventListener('blur', e => {
      if (e.target.matches(FIELD_SELECTOR)) {
        logTerm(e.target.value);
      }
    }, true);
  }

  // ———————— Inject a floating “Export” button ————————
  function injectExportButton() {
    if (document.getElementById('gd-export-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'gd-export-btn';
    btn.textContent = 'Export Logged Terms';
    Object.assign(btn.style, {
      position:    'fixed',
      bottom:      '1rem',
      right:       '50%',
      padding:     '0.6rem 1.2rem',
      background:  '#28a745',
      color:       '#fff',
      border:      'none',
      borderRadius:'4px',
      cursor:      'pointer',
      zIndex:      9999,
      fontSize:    '0.9rem',
    });
    btn.addEventListener('click', () => {
      loadTerms().then(terms => {
        const blob = new Blob([JSON.stringify(terms, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'logged_terms.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    });
    document.body.appendChild(btn);
  }

  // ———————— Initialization ————————
  function init() {
    const path = location.pathname;
    // only on the search page
    if (path.includes('/deal-entry/products/search')) {
      hookSearchLogger();
      injectExportButton();
    }
  }

  window.addEventListener('locationchange', init);
  init();
  console.log('⚙️ GroceryDeals Search Logger initialized');
})();

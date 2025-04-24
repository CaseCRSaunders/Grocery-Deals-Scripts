// ==UserScript==
// @name         GroceryDeals_Search_Logger
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Capture every unique search term and export as JSON.
// @match        https://admin.mygrocerydeals.com/admin/tasks/*
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Search_Logger.user.js
// @updateURL    https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Search_Logger.user.js
// ==/UserScript==


(function() {
  'use strict';

  // —— SPA URL-change detection ——
  function patchHistory(type) {
    const orig = history[type];
    history[type] = function() {
      const rv = orig.apply(this, arguments);
      window.dispatchEvent(new Event('locationchange'));
      return rv;
    };
  }
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));

  // —— Configuration ——
  const FIELD_SELECTOR = 'input[name="query"]';   // your search box
  const STORAGE_KEY    = 'GDSearchLogV5';          // storage key

  // —— Storage helpers ——
  async function loadLog() {
    return await GM_getValue(STORAGE_KEY, []);
  }
  async function saveLog(arr) {
    await GM_setValue(STORAGE_KEY, arr);
  }

  // —— In-memory tracker ——
  let lastTerm = null;

  // —— Log a search term ——
  async function logSearch(term) {
    let log = await loadLog();
    let status;

    if (lastTerm) {
      // refinement?
      if (term.toLowerCase().startsWith(lastTerm.toLowerCase())) {
        status = 'vague';
      } else {
        // chain ended ⇒ finalize previous
        let prev = log[log.length - 1];
        if (prev && prev.status !== 'final') {
          prev.status = 'final';
        }
        await saveLog(log);
        status = 'broad';
      }
    } else {
      status = 'broad';
    }

    // add new entry
    const entry = { term, status };
    log.push(entry);
    await saveLog(log);
    console.log('🔍 Logged search:', entry);

    lastTerm = term;
  }

  // —— Handle user pressing Enter or blurring the field ——
  function onSearchEvent(e) {
    if (!e.target.matches(FIELD_SELECTOR)) return;
    const term = e.target.value.trim();
    if (!term) return;
    // slight delay so any UI updates settle
    setTimeout(() => logSearch(term), 50);
  }

  // —— Hook listeners once ——
  function hookLogger() {
    if (window.__gd_searchLoggerV5) return;
    window.__gd_searchLoggerV5 = true;

    document.addEventListener('keydown', e => {
      if (e.key === 'Enter') onSearchEvent(e);
    });
    document.addEventListener('blur', onSearchEvent, true);
  }

  // —— Export button ——
  function injectExportButton() {
    if (document.getElementById('gd-export-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'gd-export-btn';
    btn.textContent = 'Export Search Log';
    Object.assign(btn.style, {
      position:     'fixed',
      bottom:       '1rem',
      right:        '50%',
      padding:      '0.6rem 1.2rem',
      background:   '#007bff',
      color:        '#fff',
      border:       'none',
      borderRadius: '4px',
      cursor:       'pointer',
      zIndex:       9999,
    });
    btn.addEventListener('click', async () => {
      const log = await loadLog();
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'search_log.json';
      a.click();
      URL.revokeObjectURL(url);
    });
    document.body.appendChild(btn);
  }

  function removeExportButton() {
    const btn = document.getElementById('gd-export-btn');
    if (btn) btn.remove();
  }

  // —— Finalize the last entry when you leave the search page ——
  async function finalizeOnExit() {
    let log = await loadLog();
    let prev = log[log.length - 1];
    if (prev && prev.status !== 'final') {
      prev.status = 'final';
      await saveLog(log);
      console.log('🔍 Finalized previous entry as final');
    }
    lastTerm = null;
  }

  // —— Initialization on SPA navigation ——  
  function init() {
    const path = location.pathname;
    if (path.includes('/deal-entry/products/search')) {
      hookLogger();
      injectExportButton();
    } else {
      removeExportButton();
      finalizeOnExit();
    }
  }

  window.addEventListener('locationchange', init);
  init();

  console.log('⚙️ GroceryDeals Search Logger v1.0 loaded');
})();

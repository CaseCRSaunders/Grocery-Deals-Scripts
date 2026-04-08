// ==UserScript==
// @name         MGD Deal Formatter — Auto "QTY/$PRICE" for SLASH banners on Deal Entry
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  On admin.mygrocerydeals.com deal-entry pages: detect banner from the toolbar. If it's a SLASH-style banner (e.g., Albertsons/Carrs), auto-set Sale Type to "Custom Deal" and write `QTY/$PRICE` (e.g., 2/$3) into the Custom Deal Price Description. FOR-style banners: no change.
// @author       CaseCRSaunders
// @match        https://admin.mygrocerydeals.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/MGD_Deal_Formatter_Auto_QTY_Price.user.js
// @updateURL    https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/MGD_Deal_Formatter_Auto_QTY_Price.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ——— Patch History API for SPA navigation ———
  function patchHistory(type) {
    const orig = history[type];
    history[type] = function(...args) {
      const ret = orig.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    };
  }
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));

  // --- Normalizer: lowercases, removes diacritics, collapses spaces, strips leading "store" label ---
  const normalize = (s) => (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^store\s+/, '')
    .replace(/&/g, ' and ')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // SLASH banners → use "QTY/$PRICE" Custom Deal
  const SLASH_BANNERS = new Set(['fiesta mart','hannaford','meijer','qfc','sendiks food market','harris teeter','giant','fresco y mas', 'green valley marketplace', 'food city', 'dierbergs', 'hy vee' ,'buschs', 'pricerite', 'shop n save', 'brookshire', 'kroger', 'dillons', 'frys','stater bros.', 'festival foods', 'food 4 less', 'marcs', 'save mart', 'marianos', 'sunset foods', 'save-a-lot', 'food lion', 'market square', 'rouses market', 'western beef', 'foodtown', 'kings food markets', 'price chopper', 'green valley marketplace', 'giant eagle','ralphs'].map(normalize));

  const SEL = {
    storeInfo: 'mgd-toolbar-info',
    qty: '#saleQuantity',
    priceNumber: '#salePriceDollarAmount',
    saleTypeInput:
      'mgd-generic-autocomplete[formcontrolname="saleType"] input[placeholder="Sale Type"], ' +
      '#generic-autocomplete-10 input[placeholder="Sale Type"]',
    priceTextarea:
      'textarea#salePriceCustomPrice, textarea[formcontrolname="salePriceCustomPrice"], textarea[placeholder="Price Description"]',
    priceTextFallback:
      'input[placeholder="Price"]:not([type="number"]), input#salePriceString, input[name*="price"][type="text"]'
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getBannerName() {
    const el = document.querySelector(SEL.storeInfo);
    return el ? normalize(el.textContent || el.innerText) : null;
  }

  function isSlashBanner() {
    const name = getBannerName();
    if (!name) return false;
    for (const key of SLASH_BANNERS) {
      if (name.includes(key)) return true;
    }
    return false;
  }

  function getNumber(el) {
    if (!el) return null;
    const v = (el.value ?? '').toString().trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function setVal(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function pickCustomDeal() {
    const input = document.querySelector(SEL.saleTypeInput);
    if (!input) return false;

    input.focus();
    setVal(input, '');
    setVal(input, 'Custom Deal');
    await sleep(60);

    const opt = Array.from(document.querySelectorAll('mat-option, .mat-mdc-option'))
      .find(o => /custom deal/i.test(o.textContent || ''));
    if (opt) opt.click();
    else {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      input.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter'  }));
    }
    await sleep(80);
    return true;
  }

  function getCustomPriceField() {
    const ta = document.querySelector(SEL.priceTextarea);
    if (ta) return ta;
    const txt = document.querySelector(SEL.priceTextFallback);
    if (txt) return txt;
    return document.querySelector(SEL.priceNumber);
  }

  function toMoneyString(n) {
    return (Math.round(n * 100) % 100 === 0) ? String(Math.round(n)) : n.toFixed(2);
  }

  let lock = false;
  let debounceTimer = null;
  const schedule = (fn) => { clearTimeout(debounceTimer); debounceTimer = setTimeout(fn, 40); };

  async function maybeApplySlashDeal(triggerEl) {
    if (lock || !isSlashBanner()) return;

    const qtyEl = document.querySelector(SEL.qty);
    const priceNumEl = document.querySelector(SEL.priceNumber);
    const qty = getNumber(qtyEl);
    const price = getNumber(priceNumEl);

    if (!qty || qty < 2 || price == null) return;

    lock = true;
    try {
      await pickCustomDeal();

      const deal = `${qty}/$${toMoneyString(price)}`;
      const dest = getCustomPriceField();
      if (dest) {
        setVal(dest, deal);
        dest.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      if (triggerEl) triggerEl.setAttribute('data-slash-deal-applied', '1');
    } finally {
      lock = false;
    }
  }

  // ——— Wire listeners once — document-level listeners persist through SPA navigation ———
  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;

    const handler = (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.id === 'saleQuantity' || t.id === 'salePriceDollarAmount') {
        schedule(() => maybeApplySlashDeal(t));
      }
    };

    document.addEventListener('blur', handler, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(e); }, true);

    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches(SEL.saleTypeInput)) {
        schedule(() => maybeApplySlashDeal());
      }
    }, true);
  }

  wire();
  window.addEventListener('locationchange', wire);

})();

// ==UserScript==
// @name         GroceryDeals_Auto_Transformer_v6
// @namespace    http://tampermonkey.net/
// @version      0.7
// @description  Convert 0.89 → 89¢, switch Sale Type to Custom Deal, then populate the custom-price field.
// @match        https://admin.mygrocerydeals.com/admin/tasks/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Auto_Transformer_v6.user.js
// @updateURL    https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Auto_Transformer_v6.user.js
// ==/UserScript==
alert('🚀 Transformer v7 loaded on ' + location.href);


(function() {
  'use strict';

  //
  // 1) Patch history for SPA navigation
  //
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

  //
  // 2) Selectors
  //
  // Use formcontrolname rather than brittle IDs
  const PRICE_INPUT_SEL       = 'input[formcontrolname="salePriceDollarAmount"]';
  const CUSTOM_TEXTAREA_SEL   = 'textarea[formcontrolname="salePriceCustomPrice"]';
  const SALE_TYPE_TRIGGER_SEL = 'sale-type-selector mat-select';
  const CUSTOM_OPTION_TEXT    = 'Custom Deal';

  //
  // 3) Helper to grab whichever field is active
  //
  function getPriceField() {
    return document.querySelector(PRICE_INPUT_SEL)
        || document.querySelector(CUSTOM_TEXTAREA_SEL);
  }

  //
  // 4) Open the dropdown & pick “Custom Deal”
  //
  function selectCustomDeal(cb) {
    const trigger = document.querySelector(SALE_TYPE_TRIGGER_SEL);
    if (!trigger) {
      console.warn('[Auto-¢ v7] Sale Type trigger not found');
      return cb && cb();
    }
    trigger.click();
    setTimeout(() => {
      const pick = Array.from(document.querySelectorAll('mat-option'))
                        .find(o => o.textContent.trim() === CUSTOM_OPTION_TEXT);
      if (pick) pick.click();
      else console.warn('[Auto-¢ v7] “Custom Deal” option not found');
      setTimeout(cb, 200);
    }, 100);
  }

  //
  // 5) Main transform logic
  //
  function handlePriceEvent(e) {
    const field = getPriceField();
    if (!field || e.target !== field) return;

    const raw = field.value.trim();
    const m   = /^0?\.([0-9]{1,2})$/.exec(raw);
    if (!m) return;  // only 0.05-style inputs

    const cents = m[1].replace(/^0+/, '') || '0';

    selectCustomDeal(() => {
      const f2 = getPriceField();
      if (!f2) {
        console.error('[Auto-¢ v7] price field missing after switch');
        return;
      }
      f2.value = `${cents}¢`;
      f2.dispatchEvent(new Event('input',  { bubbles: true }));
      f2.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`[Auto-¢ v7] Populated custom price: ${cents}¢`);
    });
  }

  //
  // 6) Attach listeners once
  //
  function hookTransformer() {
    if (window.__gd_transformerHooked_v7) return;
    window.__gd_transformerHooked_v7 = true;

    document.addEventListener('keydown', e => {
      if (e.key === 'Enter') handlePriceEvent(e);
    });
    document.addEventListener('blur', handlePriceEvent, true);
  }

  //
  // 7) Initialize on create page (and re-init on SPA navigation)
  //
  function init() {
    hookTransformer();
    console.log('🛠️ GroceryDeals Auto-¢ Transformer v7 loaded');
  }

  window.addEventListener('locationchange', init);
  init();
})();

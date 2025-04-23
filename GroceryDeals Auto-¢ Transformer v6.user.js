// ==UserScript==
// @name         GroceryDeals Auto-¢ Transformer v6
// @namespace    http://tampermonkey.net/
// @version      0.6
// @description  Convert 0.89 → 89¢, switch Sale Type to Custom Deal, then populate the custom-price field.
// @match        https://admin.mygrocerydeals.com/admin/tasks/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/YOUR_USERNAME/Grocery-Deals/main/Auto-¢-Transformer.user.js
// @updateURL    https://raw.githubusercontent.com/YOUR_USERNAME/Grocery-Deals/main/Auto-¢-Transformer.user.js
// ==/UserScript==

(function() {
  'use strict';

  // ————————————— SPA URL-change detection —————————————
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

  // ————————————— Selectors & constants —————————————
  const PRICE_INPUT_SEL = 'input#salePriceDollarAmount';
  const CUSTOM_TEXTAREA_SEL = 'textarea#salePriceCustomPrice';
  const SALE_TYPE_TRIGGER_SEL = 'sale-type-selector mat-select';
  const CUSTOM_DEAL_OPTION_TEXT = 'Custom Deal';

  // ————————————— Field helper —————————————
  function getPriceField() {
    // return the dollar-input if present, otherwise the custom-price textarea
    return document.querySelector(PRICE_INPUT_SEL)
        || document.querySelector(CUSTOM_TEXTAREA_SEL);
  }

  // ————————————— Select “Custom Deal” option —————————————
  function selectCustomDeal(callback) {
    const trigger = document.querySelector(SALE_TYPE_TRIGGER_SEL);
    if (!trigger) {
      console.warn('[Auto-¢] Sale Type trigger not found');
      callback && callback();
      return;
    }
    // open the dropdown
    trigger.click();

    // wait for the menu panel to render
    setTimeout(() => {
      const opts = Array.from(document.querySelectorAll('mat-option'));
      const pick = opts.find(o => o.textContent.trim() === CUSTOM_DEAL_OPTION_TEXT);
      if (pick) {
        pick.click();
      } else {
        console.warn('[Auto-¢] “Custom Deal” option not found');
      }
      // give the app a moment to swap fields
      setTimeout(callback, 200);
    }, 100);
  }

  // ————————————— Transform routine —————————————
  function handlePriceEvent(e) {
    const field = getPriceField();
    // only proceed if this event’s target is the active price field
    if (!field || e.target !== field) return;

    const raw = field.value.trim();
    const m = /^0?\.([0-9]{1,2})$/.exec(raw);
    if (!m) return; // not a 0.xx pattern

    const cents = m[1].replace(/^0+/, '') || '0';

    // switch to Custom Deal, then populate whichever field appears
    selectCustomDeal(() => {
      const f2 = getPriceField();
      if (!f2) {
        console.error('[Auto-¢] No price field found after switching to Custom Deal');
        return;
      }
      f2.value = `${cents}¢`;
      f2.dispatchEvent(new Event('input', { bubbles: true }));
      f2.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`[Auto-¢] Populated custom price: ${cents}¢`);
    });
  }

  // ————————————— Hook listeners once —————————————
  function hookTransformer() {
    if (window.__gd_priceTransformerHooked) return;
    window.__gd_priceTransformerHooked = true;

    document.addEventListener('keydown', e => {
      if (e.key === 'Enter') handlePriceEvent(e);
    });
    document.addEventListener('blur', handlePriceEvent, true);

    console.log('🛠️ GroceryDeals Auto-¢ Transformer hooked');
  }

  // ————————————— Init on load & SPA navigations —————————————
  function init() {
    const p = location.pathname;
    if (p.includes('/deal-entry/products/') && p.includes('/create')) {
      hookTransformer();
    }
  }

  window.addEventListener('locationchange', init);
  init();

  console.log('🛠️ GroceryDeals Auto-¢ Transformer v6 loaded');
})();

// ==UserScript==
// @name         Deal Entry — Autofocus + Keyboard Shortcuts
// @namespace    http://tampermonkey.net/
// @version      4.2
// @description  Autofocuses price field on product select and restores Ctrl+3/4/5/6/8
// @author       CaseCRSaunders
// @match        https://admin.mygrocerydeals.com/tasks/*/deal-entry/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Deal_Entry_Autofocus_Shortcuts.user.js
// @downloadURL  https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Deal_Entry_Autofocus_Shortcuts.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function focusById(id) {
    const el = document.getElementById(id);
    if (el) { el.focus(); el.select(); return true; }
    return false;
  }

  function focusByPlaceholder(placeholder) {
    const el = document.querySelector(`input[placeholder="${placeholder}"]`);
    if (el) { el.focus(); el.select(); return true; }
    return false;
  }

  function waitAndFocus(finder, maxMs = 8000) {
    if (finder()) return;
    const start = Date.now();
    const obs = new MutationObserver(() => {
      if (finder() || Date.now() - start > maxMs) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Shortcut map ─────────────────────────────────────────────────────────

  const SHORTCUTS = {
    '3': () => focusByPlaceholder('Sale Type'),
    '4': () => focusById('salePriceDollarAmount')
          || focusById('salePriceCustomPrice')
          || focusById('salePriceMultiBuy')
          || focusById('salePricePercentage'),
    '5': () => focusById('saleQuantity'),
    '6': () => focusByPlaceholder('Unit of Measure'),
    '8': () => focusById('limit'),
  };

  // ── Keyboard listener ────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const handler = SHORTCUTS[e.key];
    if (!handler) return;
    e.preventDefault();
    waitAndFocus(handler);
  }, true);

  // ── Route change detection ────────────────────────────────────────────────
  // Angular uses the History API for SPA navigation — patch pushState and
  // replaceState so we're notified on every route change without polling.

  const PRODUCT_URL = /\/deal-entry\/products\//;

  function onRouteChange(url) {
    if (!PRODUCT_URL.test(url)) return;
    waitAndFocus(() => focusById('salePriceDollarAmount'));
  }

  function patchHistory(method) {
    const original = history[method];
    history[method] = function (state, title, url) {
      original.apply(this, arguments);
      onRouteChange(url || location.href);
    };
  }

  patchHistory('pushState');
  patchHistory('replaceState');

  // Catches browser back/forward navigation
  window.addEventListener('popstate', () => onRouteChange(location.href));

  // ── Sale type change → re-focus price field ──────────────────────────────
  // Angular Material autocomplete doesn't fire a native 'change' event when
  // an option is selected.  Instead we:
  //   1. Track when the Sale Type input gains focus.
  //   2. Intercept the mat-option click in the CDK overlay while it's active.
  //   3. Also catch keyboard selection (Enter / Tab on the input).
  // In all cases we wait a tick for Angular to swap the price field in, then
  // focus it via the same SHORTCUTS['4'] chain used by Ctrl+4.

  let saleTypeWasActive = false;

  // Mark active when Sale Type input is focused
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.placeholder === 'Sale Type') {
      saleTypeWasActive = true;
    }
  }, true);

  // Mousedown (not click) fires before the overlay closes, which is when the
  // mat-option element is still in the DOM.
  document.addEventListener('mousedown', (e) => {
    if (!saleTypeWasActive) return;
    if (!e.target.closest('mat-option')) return;
    saleTypeWasActive = false;
    // 250 ms lets Angular re-render the correct price input for the chosen type
    setTimeout(() => waitAndFocus(SHORTCUTS['4']), 250);
  }, true);

  // Keyboard selection: Enter confirms the highlighted option; Tab moves on
  document.addEventListener('keydown', (e) => {
    if (!saleTypeWasActive) return;
    if (e.target.placeholder !== 'Sale Type') return;
    if (e.key === 'Enter' || e.key === 'Tab') {
      saleTypeWasActive = false;
      setTimeout(() => waitAndFocus(SHORTCUTS['4']), 250);
    }
  }, true);

  // ── Initial load (handles hard refresh on a product URL) ─────────────────

  onRouteChange(location.href);

})();

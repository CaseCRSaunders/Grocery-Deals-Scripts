// ==UserScript==
// @name         Deal Entry — Autofocus + Keyboard Shortcuts
// @namespace    http://tampermonkey.net/
// @version      4.3
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

  // ── Sale type detection helper ────────────────────────────────────────────
  // Works for both mat-select (no input placeholder) and mat-autocomplete.

  function isSaleTypeEl(el) {
    if (!el) return false;
    if (el.placeholder === 'Sale Type') return true;
    // mat-select: focus lands on the host element; check its parent form-field label
    const field = el.closest('mat-form-field');
    if (field) {
      const label = field.querySelector('mat-label, label');
      if (label && /sale\s*type/i.test(label.textContent)) return true;
    }
    return false;
  }

  // ── Shortcut map ─────────────────────────────────────────────────────────

  const SHORTCUTS = {
    // Ctrl+3 explicitly marks Sale Type as active so the change handler fires
    '3': () => { saleTypeWasActive = true; return focusByPlaceholder('Sale Type'); },
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
  // Angular Material mat-select doesn't focus an <input> — focus lands on the
  // host element.  We detect the Sale Type field via label text as well as
  // placeholder, track it as active, then intercept the mat-option selection
  // in the CDK overlay.

  let saleTypeWasActive = false;

  // Set active when the Sale Type field (or any child) is focused.
  // Clear it when focus moves to any real form element that isn't the overlay.
  document.addEventListener('focusin', (e) => {
    if (isSaleTypeEl(e.target)) {
      saleTypeWasActive = true;
    } else if (!e.target.closest('.cdk-overlay-container')) {
      saleTypeWasActive = false;
    }
  }, true);

  // mousedown fires before the overlay closes — mat-option is still in the DOM.
  // 300 ms gives Angular time to swap in the correct price input for the new type.
  document.addEventListener('mousedown', (e) => {
    if (!saleTypeWasActive) return;
    if (!e.target.closest('mat-option')) return;
    saleTypeWasActive = false;
    setTimeout(() => waitAndFocus(SHORTCUTS['4']), 300);
  }, true);

  // Keyboard selection: Enter / Tab on the Sale Type input confirms the choice.
  document.addEventListener('keydown', (e) => {
    if (!saleTypeWasActive) return;
    if (!isSaleTypeEl(e.target)) return;
    if (e.key === 'Enter' || e.key === 'Tab') {
      saleTypeWasActive = false;
      setTimeout(() => waitAndFocus(SHORTCUTS['4']), 300);
    }
  }, true);

  // ── Initial load (handles hard refresh on a product URL) ─────────────────

  onRouteChange(location.href);

})();

// ==UserScript==
// @name         Deal Entry — Autofocus + Keyboard Shortcuts
// @namespace    http://tampermonkey.net/
// @version      4.1
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

  // ── Initial load (handles hard refresh on a product URL) ─────────────────

  onRouteChange(location.href);

})();

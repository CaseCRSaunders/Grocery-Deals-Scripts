// ==UserScript==
// @name         GroceryDeals_Drag_Select_Checkboxes
// @namespace    https://github.com/CaseCRSaunders/Grocery-Deals-Scripts
// @version      0.5
// @description  Hold Shift + drag to select/deselect multiple deal-review checkboxes at once (SPA-aware & Angular-friendly).
// @author       CaseCRSaunders
// @homepageURL  https://github.com/CaseCRSaunders/Grocery-Deals-Scripts
// @supportURL   https://github.com/CaseCRSaunders/Grocery-Deals-Scripts/issues
// @downloadURL  https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Drag_Select_Checkboxes.user.js
// @updateURL    https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/GroceryDeals_Drag_Select_Checkboxes.user.js
// @match        https://admin.mygrocerydeals.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
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

  // ——— Selectors ———
  const ROW_SELECTOR      = 'mat-row.mat-mdc-row[role="row"]';
  const CHECKBOX_SELECTOR = `${ROW_SELECTOR} input[type="checkbox"]`;

  let marquee = null;
  let startX = 0, startY = 0;

  function createMarquee() {
    const m = document.createElement('div');
    Object.assign(m.style, {
      position:        'absolute',
      border:          '2px dashed #008cff',
      backgroundColor: 'rgba(0, 140, 255, 0.1)',
      pointerEvents:   'none',
      zIndex:          9999
    });
    document.body.appendChild(m);
    return m;
  }

  function onMouseDown(e) {
    if (e.button !== 0 || !e.shiftKey) return;  // only Shift + left-click
    startX = e.pageX;
    startY = e.pageY;
    marquee = createMarquee();
    marquee.style.left   = `${startX}px`;
    marquee.style.top    = `${startY}px`;
    marquee.style.width  = '0px';
    marquee.style.height = '0px';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    const x = Math.min(e.pageX, startX);
    const y = Math.min(e.pageY, startY);
    const w = Math.abs(e.pageX - startX);
    const h = Math.abs(e.pageY - startY);
    Object.assign(marquee.style, {
      left:   `${x}px`,
      top:    `${y}px`,
      width:  `${w}px`,
      height: `${h}px`
    });
  }

  function onMouseUp(e) {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);

    if (!marquee) return;
    const selRect = marquee.getBoundingClientRect();
    document.querySelectorAll(CHECKBOX_SELECTOR).forEach(cb => {
      const row = cb.closest(ROW_SELECTOR);
      if (!row) return;
      const r = row.getBoundingClientRect();
      if (
        r.left   < selRect.right  &&
        r.right  > selRect.left   &&
        r.top    < selRect.bottom &&
        r.bottom > selRect.top
      ) {
        cb.click();  // toggles on/off and triggers Angular's change detection
      }
    });

    marquee.remove();
    marquee = null;
  }

  function init() {
    document.removeEventListener('mousedown', onMouseDown);

    if (location.pathname.includes('/deal-entry/deals/list')) {
      document.addEventListener('mousedown', onMouseDown);
    }
  }

  // ——— Reliable SPA re-init via MutationObserver ———
  // locationchange can race with Angular's router; watching for DOM changes
  // ensures we re-attach once Angular finishes rendering the list.
  let rowObserverDebounce = null;
  const rowObserver = new MutationObserver(() => {
    clearTimeout(rowObserverDebounce);
    rowObserverDebounce = setTimeout(init, 150);
  });
  rowObserver.observe(document.body, { childList: true, subtree: true });

  // Keep locationchange as a backup
  window.addEventListener('locationchange', init);
  init();

})();

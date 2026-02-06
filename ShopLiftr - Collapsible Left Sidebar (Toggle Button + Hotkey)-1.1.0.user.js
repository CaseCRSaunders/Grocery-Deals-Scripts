// ==UserScript==
// @name         ShopLiftr - Collapsible Left Sidebar (Toggle Button + Hotkey)
// @downloadURL https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/ShopLiftr%20-%20Collapsible%20Left%20Sidebar%20(Toggle%20Button%20+%20Hotkey)-1.1.0.user.js
// @updateURL   https://raw.githubusercontent.com/CaseCRSaunders/Grocery-Deals-Scripts/main/ShopLiftr%20-%20Collapsible%20Left%20Sidebar%20(Toggle%20Button%20+%20Hotkey)-1.1.0.user.js
// @namespace    https://admin.mygrocerydeals.com/
// @version      1.1.0
// @description  Makes the left mat-sidenav collapsible with a floating toggle button and Alt+S hotkey.
// @match        https://admin.mygrocerydeals.com/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'shopliftr_sidebar_collapsed_v1'; // "1" collapsed, "0" expanded

  const css = `
    /* When collapsed, hide sidenav and remove push-left spacing */
    html.__sl_sidebar_collapsed mat-sidenav.mat-sidenav.sidenav,
    html.__sl_sidebar_collapsed mat-sidenav.mat-drawer.mat-sidenav.sidenav,
    html.__sl_sidebar_collapsed mat-sidenav.mat-drawer-side {
      display: none !important;
      width: 0 !important;
      min-width: 0 !important;
      max-width: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    html.__sl_sidebar_collapsed .mat-drawer-content {
      margin-left: 0 !important;
      transform: none !important;
      width: 100% !important;
    }

    /* Floating toggle button */
    #__sl_sidebar_toggle_btn {
      position: fixed;
      top: 92px;            /* tweak if you want it higher/lower */
      left: 12px;
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(0,0,0,0.12);
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(6px);
      box-shadow: 0 8px 20px rgba(0,0,0,0.12);
      font: 600 12px/1.1 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      color: #222;
      cursor: pointer;
      user-select: none;
    }

    #__sl_sidebar_toggle_btn:hover {
      background: rgba(255,255,255,0.98);
    }

    #__sl_sidebar_toggle_btn .__sl_icon {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      border: 1px solid rgba(0,0,0,0.12);
      background: #f7f7f7;
      font-weight: 800;
    }

    #__sl_sidebar_toggle_btn .__sl_hint {
      opacity: 0.7;
      font-weight: 600;
    }

    /* When sidebar is expanded, move button slightly so it doesn't sit under the sidenav */
    html:not(.__sl_sidebar_collapsed) #__sl_sidebar_toggle_btn {
      left: 270px;          /* approx sidenav width + padding; adjust if needed */
    }

    /* Make sure button is still reachable on small screens */
    @media (max-width: 900px) {
      html:not(.__sl_sidebar_collapsed) #__sl_sidebar_toggle_btn {
        left: 12px;
      }
    }
  `;

  // Add CSS ASAP
  if (typeof GM_addStyle === 'function') {
    GM_addStyle(css);
  } else {
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  function getCollapsed() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setCollapsed(val) {
    try {
      localStorage.setItem(STORAGE_KEY, val ? '1' : '0');
    } catch {}
  }

  function applyState(collapsed) {
    document.documentElement.classList.toggle('__sl_sidebar_collapsed', collapsed);
    setCollapsed(collapsed);

    // Also directly enforce critical inline overrides (Angular can re-apply styles)
    enforce(collapsed);

    // Update button label
    const btn = document.getElementById('__sl_sidebar_toggle_btn');
    if (btn) {
      const label = btn.querySelector('.__sl_label');
      if (label) label.textContent = collapsed ? 'Show menu' : 'Hide menu';
      const icon = btn.querySelector('.__sl_icon');
      if (icon) icon.textContent = collapsed ? '☰' : '×';
    }
  }

  function enforce(collapsed) {
    const sidenav = document.querySelector('mat-sidenav.mat-sidenav.sidenav, mat-sidenav.mat-drawer-side, mat-sidenav');
    const drawerContent = document.querySelector('.mat-drawer-content');

    if (collapsed) {
      if (sidenav) {
        sidenav.style.setProperty('display', 'none', 'important');
        sidenav.style.setProperty('width', '0', 'important');
        sidenav.style.setProperty('min-width', '0', 'important');
        sidenav.style.setProperty('max-width', '0', 'important');
        sidenav.style.setProperty('visibility', 'hidden', 'important');
        sidenav.style.setProperty('pointer-events', 'none', 'important');
      }
      if (drawerContent) {
        drawerContent.style.setProperty('margin-left', '0', 'important');
        drawerContent.style.setProperty('transform', 'none', 'important');
        drawerContent.style.setProperty('width', '100%', 'important');
      }
    } else {
      // When expanded, remove our inline overrides so site defaults take over
      if (sidenav) {
        sidenav.style.removeProperty('display');
        sidenav.style.removeProperty('width');
        sidenav.style.removeProperty('min-width');
        sidenav.style.removeProperty('max-width');
        sidenav.style.removeProperty('visibility');
        sidenav.style.removeProperty('pointer-events');
      }
      if (drawerContent) {
        drawerContent.style.removeProperty('margin-left');
        drawerContent.style.removeProperty('transform');
        drawerContent.style.removeProperty('width');
      }
    }
  }

  function ensureToggleButton() {
    if (document.getElementById('__sl_sidebar_toggle_btn')) return;

    const btn = document.createElement('button');
    btn.id = '__sl_sidebar_toggle_btn';
    btn.type = 'button';
    btn.innerHTML = `
      <span class="__sl_icon">☰</span>
      <span class="__sl_label">Show menu</span>
      <span class="__sl_hint">(Alt+S)</span>
    `;

    btn.addEventListener('click', () => {
      applyState(!document.documentElement.classList.contains('__sl_sidebar_collapsed'));
    });

    document.documentElement.appendChild(btn);
  }

  function start() {
    ensureToggleButton();

    // Apply saved state (default: collapsed = true? choose false if you prefer)
    const collapsed = getCollapsed();
    applyState(collapsed);

    // Keep enforcing state as Angular re-renders
    const obs = new MutationObserver(() => {
      ensureToggleButton();
      enforce(document.documentElement.classList.contains('__sl_sidebar_collapsed'));
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    // Hotkey: Alt+S
    window.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        applyState(!document.documentElement.classList.contains('__sl_sidebar_collapsed'));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

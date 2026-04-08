// content/portal.js — Portal content script
// Runs on admin.mygrocerydeals.com
// Provides: keyboard shortcut enhancements (ported from Tampermonkey) + automation engine

(function () {
  'use strict';

  // ── Utilities ───────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Angular-compatible value setter — triggers change detection */
  function setAngularValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc  = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function focusAndSelect(el) {
    if (!el) return false;
    el.focus();
    if (typeof el.select === 'function') el.select();
    return true;
  }

  function focusById(id) {
    return focusAndSelect(document.getElementById(id));
  }

  function focusByPlaceholder(placeholder) {
    return focusAndSelect(document.querySelector(`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`));
  }

  /** Waits for an element to appear then focuses it */
  function waitAndFocus(finder, maxMs = 8000) {
    if (finder()) return;
    const start = Date.now();
    const obs = new MutationObserver(() => {
      if (finder() || Date.now() - start > maxMs) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /** Fires a keyboard shortcut programmatically */
  function fireShortcut(key, { ctrl = false, shift = false, alt = false } = {}) {
    const opts = {
      bubbles: true, cancelable: true,
      ctrlKey: ctrl, shiftKey: shift, altKey: alt,
      key,
    };
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.activeElement?.dispatchEvent(new KeyboardEvent('keyup',   opts));
  }

  // ── SPA navigation patching ─────────────────────────────────────────────────

  function patchHistory(method) {
    const orig = history[method];
    history[method] = function (state, title, url) {
      orig.apply(this, arguments);
      window.dispatchEvent(new Event('locationchange'));
    };
  }
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));

  // ── Keyboard shortcuts (Tampermonkey port) ──────────────────────────────────

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

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const handler = SHORTCUTS[e.key];
    if (!handler) return;
    e.preventDefault();
    waitAndFocus(handler);
  }, true);

  // ── Autofocus on product URL navigation ─────────────────────────────────────

  const PRODUCT_URL = /\/deal-entry\/products\//;

  function onRouteChange(url) {
    if (!PRODUCT_URL.test(url)) return;
    waitAndFocus(() => focusById('salePriceDollarAmount'));
  }

  window.addEventListener('locationchange', () => onRouteChange(location.href));
  onRouteChange(location.href);

  // ── Field selectors ─────────────────────────────────────────────────────────

  const SEL = {
    productSearch:  'input[placeholder="Enter Product Name / UPC code (ctrl+shift+f)"], input[placeholder="Enter Product Name / UPC code"]',
    searchResults:  'mat-row.mat-mdc-row[role="row"]',
    saleType:       'mgd-generic-autocomplete[formcontrolname="saleType"] input[placeholder="Sale Type"], input[placeholder="Sale Type"]',
    price:          '#salePriceDollarAmount',
    customPrice:    '#salePriceCustomPrice, textarea[formcontrolname="salePriceCustomPrice"]',
    multiBuyBuy:    '#salePriceMultiBuy',
    multiBuyGet:    '#salePriceMultiBuyGet',
    quantity:       '#saleQuantity',
    uom:            'input[placeholder="Unit of Measure"]',
    limit:          '#limit',
    additionalInfo: '#additionalItem, input[placeholder="Add Additional Info"]',
    topDeal:        'input[type="checkbox"][id*="topDeal"], mat-checkbox:has(+ label:contains("Top Deal")) input',
    coupon:         'input[type="checkbox"][id*="coupon"], input[id*="Coupon"]',
    loyaltyCard:    'input[type="checkbox"][id*="loyalty"], input[id*="Loyalty"]',
    minQty:         'input[type="checkbox"][id*="minimum"], input[id*="Minimum"]',
  };

  // ── Automation — product search & selection ─────────────────────────────────

  /**
   * Types a query into the product search field and waits for results.
   * Returns an array of result row objects { name, description, brand, size, el }
   */
  async function searchProduct(query) {
    const searchEl = document.querySelector(SEL.productSearch);
    if (!searchEl) throw new Error('Product search field not found');

    searchEl.focus();
    setAngularValue(searchEl, query);
    await sleep(800); // wait for results to load

    const rows = Array.from(document.querySelectorAll(SEL.searchResults));
    return rows.map((row, index) => {
      const cells = row.querySelectorAll('td, mat-cell');
      return {
        index,
        el:          row,
        brand:       cells[1]?.textContent?.trim() ?? '',
        name:        cells[2]?.textContent?.trim() ?? '',
        description: cells[3]?.textContent?.trim() ?? '',
        size:        cells[4]?.textContent?.trim() ?? '',
        category:    cells[5]?.textContent?.trim() ?? '',
        upc:         cells[7]?.textContent?.trim() ?? '',
      };
    });
  }

  /** Scores a product row against a deal object for matching quality */
  function scoreProduct(row, deal) {
    let score = 0;

    const name  = row.name.toLowerCase();
    const desc  = row.description.toLowerCase();
    const brand = row.brand.toLowerCase();

    // Seasonal penalty — always exclude
    const SEASONAL = ['halloween', 'winter', 'christmas', 'holiday', 'easter',
                      'valentine', 'pumpkin', 'limited edition', 'seasonal'];
    if (SEASONAL.some(s => desc.includes(s) || name.includes(s))) return -100;

    // Brand match
    if (deal.brand && brand && brand.includes(deal.brand.toLowerCase())) score += 40;

    // Name / product type match (word by word)
    const dealWords = (deal.productName || '').toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3);
    dealWords.forEach(word => {
      if (name.includes(word)) score += 8;
    });

    // Size match
    const rowSize = parseFloat(row.size);
    if (deal.sizeMin != null && deal.sizeMax != null) {
      if (rowSize >= deal.sizeMin && rowSize <= deal.sizeMax) score += 30;
      else if (rowSize > deal.sizeMax) score -= 20; // over range
    } else if (deal.size != null) {
      if (Math.abs(rowSize - deal.size) <= 0.5) score += 30;
    }

    // Prefer "Original" when no variety specified
    if (!deal.variety && (desc.includes('original') || name.includes('original'))) score += 5;

    // Exact variety match if specified
    if (deal.variety && (desc.includes(deal.variety.toLowerCase()) || name.includes(deal.variety.toLowerCase()))) {
      score += 25;
    }

    return score;
  }

  /**
   * Finds and clicks the best matching product row.
   * Returns { success, tier, row } or throws if no match.
   */
  async function selectBestMatch(rows, deal) {
    if (rows.length === 0) {
      return { success: false, tier: 4, reason: `No results found for "${deal.productName}"` };
    }

    const scored = rows
      .map(row => ({ row, score: scoreProduct(row, deal) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];

    // Tier 1/2: confident match
    if (best.score >= 30) {
      best.row.el.click();
      await sleep(400);
      return { success: true, tier: best.score >= 50 ? 1 : 2, row: best.row };
    }

    // Tier 3: weak match — select but flag for review
    if (best.score >= 10) {
      best.row.el.click();
      await sleep(400);
      return { success: true, tier: 3, row: best.row, needsReview: true,
               reason: `Low-confidence match for "${deal.productName}" — please verify` };
    }

    // Tier 4: no usable match
    return { success: false, tier: 4,
             reason: `Could not find a match for "${deal.productName}" — manual selection required` };
  }

  // ── Automation — field filling ──────────────────────────────────────────────

  const SALE_TYPE_MAP = {
    'regular':           'Sale Price',
    'sale':              'Sale Price',
    'custom':            'Custom Deal',
    'multibuy':          'Multiple Purchase Deal',
    'multiplepurchase':  'Multiple Purchase Deal',
    'bogo':              'Multiple Purchase Deal',
    'percentage':        'Percentage Off',
  };

  async function setSaleType(type) {
    const label = SALE_TYPE_MAP[type?.toLowerCase()] ?? type;
    const input = document.querySelector(SEL.saleType);
    if (!input) return;

    input.focus();
    setAngularValue(input, '');
    setAngularValue(input, label);
    await sleep(80);

    const opt = Array.from(document.querySelectorAll('mat-option, .mat-mdc-option'))
      .find(o => o.textContent.trim().toLowerCase() === label.toLowerCase());
    if (opt) opt.click();
    else {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    }
    await sleep(300); // wait for Angular to re-render form layout
  }

  async function setPrice(value) {
    const el = document.querySelector(SEL.price)
            ?? document.querySelector(SEL.customPrice);
    if (!el) return;
    setAngularValue(el, String(value));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  async function setMultiBuy(buyQty, getQty) {
    const buyEl = document.querySelector(SEL.multiBuyBuy);
    const getEl = document.querySelector(SEL.multiBuyGet);
    if (buyEl) setAngularValue(buyEl, String(buyQty));
    if (getEl) setAngularValue(getEl, String(getQty));
  }

  async function setQuantity(qty) {
    const el = document.getElementById('saleQuantity');
    if (!el) return;
    setAngularValue(el, String(qty));
  }

  async function setLimit(limit) {
    const el = document.getElementById('limit');
    if (!el) return;
    setAngularValue(el, String(limit));
  }

  /** Checks a checkbox tag by dispatching the portal's keyboard shortcut */
  function checkTag(key, shift = false) {
    const opts = { bubbles: true, cancelable: true, ctrlKey: true, shiftKey: shift, key };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup',   opts));
  }

  /**
   * Adds additional info tags and optional custom text.
   * tags: array of tag keys — 'minQty', 'basedOnRegular', 'selectedVarieties',
   *       'includesAll', 'featured', 'seeStore', 'coupon', 'loyalty', 'topDeal'
   */
  async function addAdditionalInfo(tags = [], customText = '') {
    const TAG_SHORTCUTS = {
      basedOnRegular:    () => checkTag('b', true),
      featured:          () => checkTag('f', true),
      includesAll:       () => checkTag('i', true),
      selectedVarieties: () => checkTag('v', true),
      seeStore:          () => checkTag('s', true),
      coupon:            () => checkTag('c', true),
      loyalty:           () => checkTag('l', true),
      minQty:            () => checkTag('m', true),
    };

    for (const tag of tags) {
      const fn = TAG_SHORTCUTS[tag];
      if (fn) { fn(); await sleep(100); }
    }

    if (customText) {
      const infoEl = document.querySelector(SEL.additionalInfo);
      if (infoEl) {
        infoEl.focus();
        setAngularValue(infoEl, customText);
        infoEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
        infoEl.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter' }));
        await sleep(150);
      }
    }
  }

  async function createDeal() {
    // Ctrl+Enter
    document.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, ctrlKey: true, key: 'Enter',
    }));
    await sleep(500);
  }

  // ── Automation — full deal entry orchestrator ───────────────────────────────

  /**
   * Enters a single deal into the portal.
   * Returns { success, needsReview, reason }
   *
   * Deal object shape:
   * {
   *   id, productName, brand, size, sizeMin, sizeMax, variety,
   *   saleType,        // 'regular' | 'custom' | 'multibuy' | 'percentage'
   *   price,           // number for regular/custom
   *   buyQty,          // for multibuy
   *   getQty,          // for multibuy
   *   minQtyRequired,  // boolean
   *   loyaltyCard,     // boolean
   *   couponRequired,  // boolean
   *   topDeal,         // boolean
   *   limit,           // number or null
   *   additionalTags,  // array: 'selectedVarieties' | 'includesAll' | 'basedOnRegular' | 'seeStore' | 'featured'
   *   customText,      // string — typed into Additional Info
   *   needsUOMReview,  // boolean — flag for agent to verify unit of measure
   * }
   */
  async function enterDeal(deal) {
    try {
      // 1. Search for product
      const rows = await searchProduct(deal.productName);
      const match = await selectBestMatch(rows, deal);

      if (!match.success || match.tier === 4) {
        return { success: false, needsReview: true, reason: match.reason };
      }

      // Tier 3 or UOM review — pause after entry for agent confirmation
      const needsReview = match.needsReview || deal.needsUOMReview;

      // 2. Set sale type (may change form layout)
      await setSaleType(deal.saleType);

      // 3. Fill price / buy-get fields
      if (deal.saleType === 'multibuy' || deal.saleType === 'bogo') {
        await setMultiBuy(deal.buyQty, deal.getQty);
      } else {
        await setPrice(deal.price);
      }

      // 4. Quantity (for regular deals with a min-buy qty > 1)
      if (deal.quantity && deal.quantity > 1) {
        await setQuantity(deal.quantity);
      }

      await sleep(150);

      // 5. Limit
      if (deal.limit) {
        await setLimit(deal.limit);
      }

      // 6. Checkbox tags
      if (deal.topDeal)       checkTag('7');                 // Ctrl+7
      if (deal.couponRequired) checkTag('c', true);          // Ctrl+Shift+C
      if (deal.loyaltyCard)    checkTag('l', true);          // Ctrl+Shift+L
      if (deal.minQtyRequired) checkTag('m', true);          // Ctrl+Shift+M
      await sleep(150);

      // 7. Additional Info tags + custom text
      const additionalTags = [...(deal.additionalTags ?? [])];
      if (deal.saleType === 'multibuy' || deal.saleType === 'bogo') {
        additionalTags.push('basedOnRegular');
      }
      await addAdditionalInfo(additionalTags, deal.customText ?? '');

      // 8. Create deal
      await createDeal();

      return { success: true, needsReview, reason: match.reason ?? null };

    } catch (err) {
      return { success: false, needsReview: false, error: err.message };
    }
  }

  // ── Message listener ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ENTER_DEAL') {
      enterDeal(msg.deal).then(result => sendResponse(result));
      return true; // async
    }

    if (msg.type === 'PING') {
      sendResponse({ alive: true });
    }
  });

  console.log('[GD] Portal content script loaded');
})();

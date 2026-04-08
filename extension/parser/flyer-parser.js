// parser/flyer-parser.js
// Injected into web-based flyer viewer tabs (non-PDF).
// Scrapes deal text from the DOM and sends raw blocks back to background.js.

(function () {
  'use strict';

  // ── Detect flyer viewer type ────────────────────────────────────────────────

  function detectViewerType() {
    // Flipp — most common grocery flyer platform
    if (document.querySelector('[data-testid="flyer-page"], .flipp-flyer, .flyer-page')) {
      return 'flipp';
    }
    // Generic grid-based viewer
    if (document.querySelector('.flyer-item, .weekly-ad-item, .ad-item, [class*="flyerItem"]')) {
      return 'generic-grid';
    }
    // Fallback — try to extract any meaningful text blocks
    return 'generic-text';
  }

  // ── Flipp viewer scraper ────────────────────────────────────────────────────

  function scrapeFlipp() {
    const items = document.querySelectorAll('[data-testid="flyer-item"], .item-content, .flyer-item');
    return Array.from(items).map(el => {
      const name  = el.querySelector('.item-name, .product-name, h3, h4')?.textContent?.trim() ?? '';
      const price = el.querySelector('.item-price, .price, [class*="price"]')?.textContent?.trim() ?? '';
      const desc  = el.querySelector('.item-description, .description, p')?.textContent?.trim() ?? '';
      return {
        productLines:  name ? [name] : [],
        priceText:     price,
        conditionText: desc,
      };
    }).filter(b => b.productLines.length > 0 || b.priceText);
  }

  // ── Generic grid scraper ────────────────────────────────────────────────────

  function scrapeGenericGrid() {
    const cells = document.querySelectorAll(
      '.flyer-item, .weekly-ad-item, .ad-item, [class*="flyerItem"], [class*="adItem"]'
    );
    return Array.from(cells).map(el => {
      const allText  = el.innerText?.trim() ?? '';
      const lines    = allText.split('\n').map(l => l.trim()).filter(Boolean);
      const priceIdx = lines.findIndex(l => /\$[\d.]+|[\d]+\/\$[\d]+|[\d]+¢/.test(l));

      return {
        productLines:  priceIdx > 0 ? lines.slice(0, priceIdx) : lines.slice(0, 2),
        priceText:     priceIdx >= 0 ? lines[priceIdx] : '',
        conditionText: priceIdx >= 0 ? lines.slice(priceIdx + 1).join(', ') : lines.slice(2).join(', '),
      };
    }).filter(b => b.priceText);
  }

  // ── Generic text fallback ───────────────────────────────────────────────────

  function scrapeGenericText() {
    // Grab all visible text, split on price patterns, build rough blocks
    const body     = document.body.innerText ?? '';
    const segments = body.split(/(?=\$[\d.]+|[\d]+\/\$[\d]+)/);
    return segments.slice(1).map(seg => {
      const lines = seg.split('\n').map(l => l.trim()).filter(Boolean);
      return {
        productLines:  [],
        priceText:     lines[0] ?? '',
        conditionText: lines.slice(1, 4).join(', '),
      };
    }).filter(b => b.priceText);
  }

  // ── Main ────────────────────────────────────────────────────────────────────

  const type   = detectViewerType();
  let rawBlocks = [];

  switch (type) {
    case 'flipp':        rawBlocks = scrapeFlipp();        break;
    case 'generic-grid': rawBlocks = scrapeGenericGrid();  break;
    default:             rawBlocks = scrapeGenericText();  break;
  }

  chrome.runtime.sendMessage({
    type:      'FLYER_PARSED',
    rawBlocks,
    viewerType: type,
    pageUrl:   location.href,
  });

  console.log(`[GD] Web flyer scraped (${type}): ${rawBlocks.length} blocks found`);
})();

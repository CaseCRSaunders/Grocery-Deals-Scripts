// parser/deal-structurer.js
// Converts raw parsed flyer text into structured deal objects ready for entry.
// Used by flyer-parser.js after text extraction.

'use strict';

// ── Seasonal exclusion ────────────────────────────────────────────────────────

const SEASONAL_KEYWORDS = [
  'halloween', 'winter', 'christmas', 'holiday', 'easter',
  'valentine', 'pumpkin', 'limited edition', 'seasonal',
  'gingerbread', 'spring', 'summer', 'fall edition',
];

// ── Patterns ──────────────────────────────────────────────────────────────────

const PRICE_PATTERNS = {
  // 4/$5, 3/$10, 2/$4
  multiSlash:    /(\d+)\s*\/\s*\$\s*(\d+(?:\.\d{1,2})?)/,
  // $X.XX when you buy N  or  N for $X.XX
  whenYouBuy:    /(\d+)\s+for\s+\$\s*(\d+(?:\.\d{1,2})?)|when\s+you\s+buy\s+(\d+)/i,
  // Buy X Get X Free / BOGO
  buyXGetY:      /buy\s+(\d+)\s+get\s+(\d+)\s*(free)?/i,
  bogo:          /\bbogo\b|buy\s+one\s+get\s+one/i,
  // X¢ sub-dollar
  cents:         /\b(\d{1,2})¢/,
  subDollar:     /\b0?\.(\d{2})\b/,
  // $X.XX straight
  straight:      /\$\s*(\d+(?:\.\d{1,2})?)/,
};

const TAG_PATTERNS = {
  loyaltyCard:    /with\s+card|loyalty\s+card|price\s+card|membership|member\s+price|club\s+price/i,
  coupon:         /coupon|clip|digital\s+deal/i,
  selectedVarieties: /select\s+variet/i,
  includesAll:    /all\s+variet/i,
  topDeal:        /top\s+deal|feature[d]?\s+item|ad\s+special/i,
  butcherBlock:   /butcher\s+block|deli\s+fresh|bakery|sold\s+individually|per\s+piece|by\s+the\s+piece/i,
  seeStore:       /see\s+store|additional\s+terms|conditions\s+apply/i,
  basedOnRegular: /based\s+on\s+regular|regular\s+in.store\s+prices/i,
};

const LIMIT_PATTERN = /limit\s+(\d+)\s+(?:per\s+(?:customer|household|transaction|offer))/i;
const MULTI_LIMIT   = /limit\s+\d+.*limit\s+\d+/i; // multiple limit clauses

const SIZE_RANGE_PATTERN = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(oz|lb|ct|count|fl\.?\s*oz|liter|ml|g|kg)/i;
const SIZE_SINGLE_PATTERN = /(\d+(?:\.\d+)?)\s*(oz|lb|ct|count|fl\.?\s*oz|liter|ml|g|kg)/i;

// ── Size parser ───────────────────────────────────────────────────────────────

function parseSize(text) {
  const rangeMatch = SIZE_RANGE_PATTERN.exec(text);
  if (rangeMatch) {
    return {
      sizeMin: parseFloat(rangeMatch[1]),
      sizeMax: parseFloat(rangeMatch[2]),
      sizeUnit: rangeMatch[3].toLowerCase(),
    };
  }
  const singleMatch = SIZE_SINGLE_PATTERN.exec(text);
  if (singleMatch) {
    return {
      size:     parseFloat(singleMatch[1]),
      sizeUnit: singleMatch[2].toLowerCase(),
    };
  }
  return {};
}

// ── Price / sale type parser ──────────────────────────────────────────────────

function parsePriceAndType(text) {
  // X/$Y or N for $Y
  const multiSlash = PRICE_PATTERNS.multiSlash.exec(text);
  if (multiSlash) {
    const qty   = parseInt(multiSlash[1]);
    const total = parseFloat(multiSlash[2]);
    return {
      saleType:       'regular',
      price:          parseFloat((total / qty).toFixed(2)),
      minBuyQty:      qty,
      minQtyRequired: true,
      priceDisplay:   `${qty}/$${total}`,
    };
  }

  const whenYouBuy = PRICE_PATTERNS.whenYouBuy.exec(text);
  if (whenYouBuy) {
    const qty   = parseInt(whenYouBuy[1] || whenYouBuy[3]);
    const price = whenYouBuy[2] ? parseFloat(whenYouBuy[2]) : null;
    return {
      saleType:       'regular',
      price,
      minBuyQty:      qty,
      minQtyRequired: true,
    };
  }

  // Buy X Get Y Free
  const buyGet = PRICE_PATTERNS.buyXGetY.exec(text);
  if (buyGet) {
    return {
      saleType:       'multibuy',
      buyQty:         parseInt(buyGet[1]),
      getQty:         parseInt(buyGet[2]),
      minQtyRequired: true,
      additionalTags: ['basedOnRegular'],
    };
  }

  if (PRICE_PATTERNS.bogo.test(text)) {
    return {
      saleType:       'multibuy',
      buyQty:         1,
      getQty:         1,
      minQtyRequired: true,
      additionalTags: ['basedOnRegular'],
    };
  }

  // Sub-dollar / cents
  const cents = PRICE_PATTERNS.cents.exec(text);
  if (cents) {
    return { saleType: 'custom', price: parseInt(cents[1]) / 100, customText: `${cents[1]}¢` };
  }
  const subDollar = PRICE_PATTERNS.subDollar.exec(text);
  if (subDollar) {
    return { saleType: 'custom', price: parseFloat(`0.${subDollar[1]}`), customText: `${subDollar[1]}¢` };
  }

  // Straight price
  const straight = PRICE_PATTERNS.straight.exec(text);
  if (straight) {
    return { saleType: 'regular', price: parseFloat(straight[1]) };
  }

  return { saleType: 'regular', price: null };
}

// ── Tag parser ────────────────────────────────────────────────────────────────

function parseTags(text) {
  const tags   = [];
  const flags  = {};

  if (TAG_PATTERNS.loyaltyCard.test(text))       flags.loyaltyCard      = true;
  if (TAG_PATTERNS.coupon.test(text))             flags.couponRequired   = true;
  if (TAG_PATTERNS.topDeal.test(text))            flags.topDeal          = true;
  if (TAG_PATTERNS.butcherBlock.test(text))       flags.needsUOMReview   = true;
  if (TAG_PATTERNS.seeStore.test(text))           tags.push('seeStore');
  if (TAG_PATTERNS.basedOnRegular.test(text))     tags.push('basedOnRegular');
  if (TAG_PATTERNS.selectedVarieties.test(text))  tags.push('selectedVarieties');
  else if (TAG_PATTERNS.includesAll.test(text))   tags.push('includesAll');

  return { ...flags, additionalTags: tags };
}

// ── Limit parser ──────────────────────────────────────────────────────────────

function parseLimit(text) {
  if (MULTI_LIMIT.test(text)) {
    return { limit: null, limitNeedsReview: true };
  }
  const m = LIMIT_PATTERN.exec(text);
  return m ? { limit: parseInt(m[1]) } : {};
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Structures a single raw flyer deal block into one or more deal objects.
 *
 * @param {Object} raw - Raw deal block from flyer parser
 *   {
 *     productLines: string[],  // lines of product names/brands
 *     priceText:    string,    // raw price text
 *     conditionText: string,   // size, variety notes, fine print
 *   }
 * @returns {Object[]} Array of structured deal objects (one per product)
 */
function structureDeal(raw) {
  const fullText  = [
    ...(raw.productLines ?? []),
    raw.priceText     ?? '',
    raw.conditionText ?? '',
  ].join(' ');

  const priceInfo = parsePriceAndType(raw.priceText ?? fullText);
  const tagInfo   = parseTags(fullText);
  const limitInfo = parseLimit(fullText);
  const sizeInfo  = parseSize(raw.conditionText ?? fullText);

  // Build one deal per product line (multi-brand blocks create multiple deals)
  const products = raw.productLines ?? ['Unknown Product'];

  return products.map((productLine, i) => {
    const { brand, productName } = extractBrandAndName(productLine);
    const isSeasonal = SEASONAL_KEYWORDS.some(kw => productLine.toLowerCase().includes(kw));

    // Build custom text from original flyer line if it contains brand-specific info
    // (used for store-brand / generic matches — Tier 3)
    const customText = priceInfo.customText
      ?? (raw.conditionText ? buildCustomText(productLine, raw.conditionText) : '');

    return {
      id:             `${Date.now()}-${i}`,
      status:         'pending',

      // Product matching fields
      productName,
      brand,
      isSeasonal,
      ...sizeInfo,

      // Sale details
      ...priceInfo,
      ...tagInfo,
      ...limitInfo,

      // Override additionalTags merging (priceInfo + tagInfo can both add tags)
      additionalTags: [
        ...(priceInfo.additionalTags ?? []),
        ...(tagInfo.additionalTags  ?? []),
      ].filter((v, i, a) => a.indexOf(v) === i), // dedupe

      customText: customText || undefined,

      // Review flags
      confidence:       null, // set by product matcher after search
      needsUOMReview:   tagInfo.needsUOMReview ?? false,
      limitNeedsReview: limitInfo.limitNeedsReview ?? false,

      // Raw source for reference in review panel
      _raw: raw,
    };
  });
}

/** Splits "Brand Name ProductType" into { brand, productName } */
function extractBrandAndName(line) {
  // Heuristic: first 1-2 title-cased words before a lowercase or descriptive word are the brand
  // e.g. "Betty Crocker Pancake Mix" → brand: "Betty Crocker", productName: "Pancake Mix"
  // This is intentionally simple — the portal search handles fuzzy matching
  const words  = line.trim().split(/\s+/);
  let brandEnd = 0;

  for (let i = 0; i < Math.min(words.length - 1, 3); i++) {
    if (/^[A-Z]/.test(words[i])) brandEnd = i + 1;
    else break;
  }

  return {
    brand:       brandEnd > 0 ? words.slice(0, brandEnd).join(' ')         : '',
    productName: brandEnd > 0 ? words.slice(brandEnd).join(' ') || line    : line,
  };
}

/** Builds custom text from original flyer copy (for Tier 3 generic matches) */
function buildCustomText(productLine, conditions) {
  const parts = [productLine];
  if (conditions && conditions.toLowerCase() !== productLine.toLowerCase()) {
    parts.push(conditions);
  }
  return parts.join(', ');
}

// ── Batch processing ──────────────────────────────────────────────────────────

/**
 * Structures an array of raw deal blocks from the flyer parser.
 * Flattens multi-product blocks into individual deals.
 * @param {Object[]} rawBlocks
 * @returns {Object[]} Flat array of structured deal objects
 */
function structureDeals(rawBlocks) {
  return rawBlocks.flatMap(block => structureDeal(block));
}

// Export for use by flyer-parser.js and popup
if (typeof module !== 'undefined') {
  module.exports = { structureDeal, structureDeals, parseSize, parsePriceAndType, parseTags };
} else {
  window.GD_DealStructurer = { structureDeal, structureDeals, parseSize, parsePriceAndType, parseTags };
}

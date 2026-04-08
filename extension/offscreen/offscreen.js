// offscreen/offscreen.js
// Runs in the hidden offscreen document.
// Receives a PDF URL from background.js, parses it with pdf.js,
// extracts deal blocks spatially, and returns structured deals.

import * as pdfjsLib from '../lib/pdf.mjs';

// ── pdf.js worker setup ───────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PARSE_PDF') {
    parsePdf(msg.url, msg.storeName)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true; // async
  }
});

// ── PDF parsing ───────────────────────────────────────────────────────────────

async function parsePdf(url, storeName) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('pdf.js not loaded — place pdf.min.js in extension/lib/');
  }

  // Fetch the PDF bytes
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();

  // Load with pdf.js
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  console.log(`[GD] PDF loaded: ${pdf.numPages} pages`);

  const allBlocks = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page    = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items   = normaliseItems(content.items, page);
    const blocks  = extractDealBlocks(items);
    allBlocks.push(...blocks);
  }

  return { rawBlocks: allBlocks, pageCount: pdf.numPages };
}

// ── Text item normalisation ───────────────────────────────────────────────────

/**
 * Converts pdf.js text items to a consistent format with absolute coordinates.
 * transform = [scaleX, skewX, skewY, scaleY, x, y]
 */
function normaliseItems(items, page) {
  const viewport = page.getViewport({ scale: 1 });
  return items
    .filter(item => item.str.trim())
    .map(item => {
      const [scaleX, , , scaleY, x, y] = item.transform;
      const fontSize = Math.abs(scaleY) || Math.abs(scaleX);
      return {
        text:     item.str.trim(),
        x:        Math.round(x),
        // pdf.js y is bottom-up; flip to top-down for easier spatial logic
        y:        Math.round(viewport.height - y),
        w:        Math.round(item.width),
        fontSize: Math.round(fontSize),
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

// ── Language detection ────────────────────────────────────────────────────────

const SPANISH_CHARS_RE = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/;
const SPANISH_WORDS_RE = /\b(de|el|la|los|las|con|por|para|en|del|se|al|una?|es|son|sin|sobre|entre)\b/i;

// Common Spanish grocery vocabulary (no diacritics required)
const SPANISH_VOCAB = new Set([
  // produce
  'naranja','naranjas','manzana','manzanas','cebolla','cebollas',
  'aguacate','aguacates','tomate','tomates','jitomate','papa','papas',
  'chile','chiles','limon','platano','platanos','uva','uvas',
  'zanahoria','zanahorias','pepino','pepinos','nopal','nopales',
  'ejote','ejotes','elote','elotes','calabaza','calabazas',
  // meat / deli / dairy
  'pollo','carne','chorizo','queso','leche','crema','mantequilla',
  'jamon','carnitas','birria','res','cerdo','pescado','camarones',
  'longaniza','machaca','barbacoa','chicharron',
  // bread / pantry
  'pan','tortilla','tortillas','arroz','frijol','frijoles','maiz',
  'salsa','mole','chile','adobo','masa',
  // descriptors
  'grande','grandes','chico','chica','chicas','chicos','mediano','medianos',
  'fresco','fresca','frescos','frescas',
  'blanco','blanca','blancos','blancas',
  'rojo','roja','rojos','rojas',
  'verde','verdes','amarillo','amarilla',
  'mexicano','mexicana','mexicanos','mexicanas',
  'entero','entera','molido','molida',
  // common flyer words
  'rancho','marca','precio','oferta','especial','surtido','variedad',
  'paquete','piezas','pieza','unidad','unidades',
]);

function looksSpanish(text) {
  if (SPANISH_CHARS_RE.test(text)) return true;
  if (SPANISH_WORDS_RE.test(text)) return true;
  return text.toLowerCase().split(/\s+/).some(w => SPANISH_VOCAB.has(w));
}

// Strings that look English but are NOT valid product names
const JUNK_PRODUCT_RE = /^(lb|lbs|oz|fl\.?oz|ct|g|kg|ml|l|each|ea|pk|pkg|per|and|or|the|with|for|from|use)$/i;

function isValidProductName(text) {
  if (text.length < 3) return false;                     // too short: "/", "lb"
  if (JUNK_PRODUCT_RE.test(text.trim())) return false;   // unit or stop word
  if (/^[\d\s\/\-\.,]+$/.test(text)) return false;       // all numbers/punctuation
  return true;
}

function looksEnglish(text) {
  // English: has Latin letters, no Spanish diacritics, and is a valid product name
  return !SPANISH_CHARS_RE.test(text) && /[a-zA-Z]{2,}/.test(text) && isValidProductName(text);
}

// ── Price detection ───────────────────────────────────────────────────────────

const PRICE_RE = /^\$?\d+(?:\.\d{1,2})?$|^\d+\/\$\d+(?:\.\d{1,2})?$|^\d+¢$|^BOGO$/i;
// Fragments that are price-related but not useful standalone (e.g. bare "/")
const PRICE_FRAGMENT_RE = /^[\d\/\$\.\s¢]+$/;

function isPrice(item) {
  const t = item.text.replace(/\s+/g, '');
  return PRICE_RE.test(t) || (PRICE_FRAGMENT_RE.test(t) && t.length <= 5);
}

// ── Spatial deal block extraction ─────────────────────────────────────────────

/**
 * Groups text items into deal blocks.
 *
 * Strategy:
 *  1. Identify "anchor" items — price text, typically the largest font on the page
 *     or text matching a price pattern.
 *  2. For each anchor, collect all items within a proximity radius to form a block.
 *  3. Split collected text into product lines vs price vs conditions by font size.
 */
function extractDealBlocks(items) {
  if (items.length === 0) return [];

  // Find median and max font sizes to calibrate thresholds
  const sizes     = items.map(i => i.fontSize).sort((a, b) => a - b);
  const maxFont   = sizes[sizes.length - 1];
  const medFont   = sizes[Math.floor(sizes.length / 2)];

  // Price items: match pattern OR very large font (>= 1.5x median)
  const priceItems = items.filter(item =>
    isPrice(item) || item.fontSize >= Math.max(medFont * 1.8, 20)
  );

  if (priceItems.length === 0) {
    // Fallback: treat whole page as one block (rare)
    return [buildBlock(items, items, medFont)];
  }

  // Cluster price items that are close together (part of the same price badge)
  const priceClusters = clusterByProximity(priceItems, 60);

  const blocks = [];
  const used   = new Set();

  for (const cluster of priceClusters) {
    // Centre of this price cluster
    const cx = cluster.reduce((s, i) => s + i.x, 0) / cluster.length;
    const cy = cluster.reduce((s, i) => s + i.y, 0) / cluster.length;

    // Collect all items within a generous radius around the price centre
    const RADIUS = 280; // px — covers most deal block sizes
    const nearby = items.filter(item => {
      const dist = Math.hypot(item.x - cx, item.y - cy);
      return dist <= RADIUS;
    });

    // Mark items as used (avoid same item appearing in two blocks)
    const freshItems = nearby.filter(item => {
      const key = `${item.x},${item.y},${item.text}`;
      if (used.has(key)) return false;
      used.add(key);
      return true;
    });

    if (freshItems.length > 0) {
      blocks.push(buildBlock(freshItems, cluster, medFont));
    }
  }

  return blocks;
}

/**
 * Clusters items that are within `maxDist` px of each other.
 */
function clusterByProximity(items, maxDist) {
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [items[i]];
    assigned.add(i);
    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;
      if (Math.hypot(items[i].x - items[j].x, items[i].y - items[j].y) <= maxDist) {
        cluster.push(items[j]);
        assigned.add(j);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Builds a raw block object from a set of nearby items.
 * Separates product lines, price text and condition text by font size.
 *
 * Language awareness: if large-font items are predominantly Spanish, we look for
 * English sub-text (smaller font, directly below each Spanish line) and prefer
 * that for productLines so the portal search works against its English database.
 */
function buildBlock(nearby, priceCluster, medFont) {
  const priceTexts = new Set(priceCluster.map(i => i.text));

  // Sort top-to-bottom
  const sorted = [...nearby].sort((a, b) => a.y - b.y || a.x - b.x);

  const largeItems = [];
  const smallItems = [];
  let   priceText  = '';

  for (const item of sorted) {
    if (priceTexts.has(item.text) || isPrice(item)) {
      priceText += ' ' + item.text;
      continue;
    }
    if (item.fontSize >= medFont * 1.1) {
      largeItems.push(item);
    } else {
      smallItems.push(item);
    }
  }

  // ── Spanish flyer detection ───────────────────────────────────────────────
  // If ≥50% of the large-font (product name) items look Spanish, try to find
  // English sub-text beneath each one and use that for the product name.
  const spanishCount = largeItems.filter(i => looksSpanish(i.text)).length;
  const isSpanishBlock = largeItems.length > 0 && spanishCount / largeItems.length >= 0.5;

  const productLines = [];
  const condLines    = [];
  const spanishLines = [];
  const usedAsTranslation = new Set();

  if (isSpanishBlock) {
    for (const large of largeItems) {
      spanishLines.push(large.text);

      // Find small English items spatially below this large item
      // Criteria: y is 0–45px below, x ranges overlap, text looks English
      const candidates = smallItems.filter(small => {
        const yDiff   = small.y - large.y;
        const xStart  = large.x;
        const xEnd    = large.x + (large.w || 120);
        const sxEnd   = small.x + (small.w || 60);
        const xOverlap = small.x < xEnd && sxEnd > xStart;
        return yDiff >= 0 && yDiff <= 45 && xOverlap && looksEnglish(small.text);
      });

      if (candidates.length > 0) {
        // Take the topmost English candidate (closest below the Spanish line)
        candidates.sort((a, b) => a.y - b.y);
        const best = candidates[0];
        productLines.push(best.text);
        usedAsTranslation.add(`${best.x},${best.y},${best.text}`);
      } else {
        // No English sub-text found — keep the Spanish name (flagged for review)
        productLines.push(large.text);
      }
    }

    // Remaining small items not used as translations go to condLines
    for (const small of smallItems) {
      const key = `${small.x},${small.y},${small.text}`;
      if (!usedAsTranslation.has(key)) condLines.push(small.text);
    }
  } else {
    for (const item of largeItems) {
      if (isValidProductName(item.text)) productLines.push(item.text);
      else condLines.push(item.text);
    }
    for (const item of smallItems) condLines.push(item.text);
  }

  return {
    productLines:  dedupeLines(productLines.filter(isValidProductName)),
    priceText:     priceText.trim(),
    conditionText: dedupeLines(condLines).join(', '),
    spanishLines:  spanishLines.length ? spanishLines : undefined,
    _rawItems:     nearby,
  };
}

function dedupeLines(lines) {
  return [...new Set(lines.map(l => l.trim()).filter(Boolean))];
}

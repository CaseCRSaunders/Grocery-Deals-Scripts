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
    let   items   = normaliseItems(content.items, page);

    // Fallback: fewer than 5 text items means this is a raster/image page (e.g. Kroger printable PDF).
    // Render the page to canvas and run Tesseract OCR to get word-level bounding boxes.
    if (items.length < 5) {
      console.log(`[GD] Page ${pageNum}: no text layer detected — falling back to OCR`);
      items = await ocrPageItems(page, pageNum, pdf.numPages);
      console.log(`[GD] Page ${pageNum}: OCR found ${items.length} items`);
    }

    // ── DEBUG: send first page raw items to background.js service worker ───
    if (pageNum === 1) {
      const sizes = items.map(i => i.fontSize).sort((a,b) => a-b);
      const med   = sizes[Math.floor(sizes.length / 2)];
      chrome.runtime.sendMessage({
        type:       'DEBUG_ITEMS',
        medFont:    med,
        totalItems: items.length,
        items:      items.slice(0, 80),
      }).catch(() => {}); // ignore if background isn't ready
    }
    // ── END DEBUG ────────────────────────────────────────────────────────────

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
  'chile','chiles','limon','limones','platano','platanos','uva','uvas',
  'zanahoria','zanahorias','pepino','pepinos','nopal','nopales',
  'ejote','ejotes','elote','elotes','calabaza','calabazas',
  'mango','mangos','papaya','papayas','sandia','melon','melones',
  'durazno','duraznos','pera','peras','fresa','fresas','kiwi',
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

// Strings that look English but are NOT valid product names.
// Includes variants with trailing period (e.g. "ea." "lb.") as pdf.js often
// attaches a period from the surrounding layout.
const JUNK_PRODUCT_RE = /^(ea\.?|lbs?\.?|ozs?\.?|fl\.?\s*ozs?\.?|kgs?\.?|cts?\.?|mls?\.?|gs?\.?|each|pk\.?|pkg\.?|per|pint|and|or|the|with|for|from|use|card|off|buy|get|more|save|extra|sale|deal|new|free|only|bonus|price|just|now|out|back|up|to|of|in|at|is|are|was|win|enter|add)$/i;

function isValidProductName(text) {
  if (text.length < 4) return false;                     // too short: OCR fragments like "Cru", "tor", "iid"
  if (JUNK_PRODUCT_RE.test(text.trim())) return false;   // unit or stop word
  if (/^[\d\s\/\-\.,]+$/.test(text)) return false;       // all numbers/punctuation
  if (/^[(\[{_\-$@#]/.test(text)) return false;          // starts with bracket/symbol — OCR noise
  if (/^\d/.test(text) && text.length < 6) return false; // short digit-leading strings ("99g", "100%", "5%")
  return true;
}

function looksEnglish(text) {
  // English: has Latin letters, no Spanish diacritics, and is a valid product name
  return !SPANISH_CHARS_RE.test(text) && /[a-zA-Z]{2,}/.test(text) && isValidProductName(text);
}

// ── Price detection ───────────────────────────────────────────────────────────

const PRICE_RE = new RegExp([
  /^\$?\d+(?:\.\d{1,2})?$/,           // $1.99  or  1.99
  /^\d+\/\$\d+(?:\.\d{1,2})?$/,       // 3/$1.99
  /^\d+\/\d+¢?$/,                      // 3/99  or  3/99¢
  /^\d+¢$/,                            // 89¢
  /^\d+(?:\.\d{1,2})?¢$/,             // 99.9¢
  /^BOGO$/i,
].map(r => r.source).join('|'));

// Loose price fragments — short strings of digits / $ / ¢ / slash that sit
// adjacent to a real price item (e.g. bare "99" next to a "3/" badge)
const PRICE_FRAGMENT_RE = /^[\d\/\$\.\s¢]+$/;

function isPrice(item) {
  const t = item.text.replace(/\s+/g, '');
  return PRICE_RE.test(t) || (PRICE_FRAGMENT_RE.test(t) && t.length <= 5);
}

// ── Continuation-line detection ───────────────────────────────────────────────
// Words/phrases that mark packaging/condition lines rather than product name
// continuations.  If a small-font line below the primary translation matches
// this pattern it goes to condLines, not the product name.
const CONDITION_LINE_RE = /\b(jumbo|family\s*pack|bulk|bag|box|case|tray|each|per\s*(lbs?|ozs?)|bundle|\d+\s*(lbs?|ozs?|kgs?|cts?|pcs?|pieces?|count))\b/i;

// ── Spatial deal block extraction ─────────────────────────────────────────────

/**
 * Groups text items into deal blocks using a Voronoi (nearest-wins) strategy.
 *
 * Each non-price text item is assigned to whichever price cluster centroid it is
 * closest to (capped at MAX_RADIUS px).  This prevents large fixed-radius circles
 * from bleeding text from one deal cell into a neighbouring cell — the main cause
 * of "additional info" showing the wrong product's description.
 */
function extractDealBlocks(items) {
  if (items.length === 0) return [];

  const sizes   = items.map(i => i.fontSize).sort((a, b) => a - b);
  const medFont = sizes[Math.floor(sizes.length / 2)];

  // Price anchors: pattern match OR very large font composed only of price characters.
  // We deliberately exclude large-font items whose text contains letters — those are
  // product names rendered at display size, not prices.
  //
  // For loose PRICE_FRAGMENT_RE matches (bare "3", "99", etc.) we require the item to
  // be at least as tall as the median font — this filters out small-font quantity/size
  // numbers in OCR output while still catching text-PDF split prices (which have the
  // same font size as the surrounding price and are therefore >= medFont).
  const PRICE_CHARS_RE = /^[\d\/\$¢\.\s]+$/;
  const priceItems = items.filter(item => {
    const t = item.text.replace(/\s+/g, '');
    if (PRICE_RE.test(t)) return true;                                              // exact price pattern
    if (PRICE_FRAGMENT_RE.test(t) && t.length <= 5
        && item.fontSize >= medFont) return true;                                   // split fragment, must be full-size
    if (PRICE_CHARS_RE.test(item.text)
        && item.fontSize >= Math.max(medFont * 1.8, 20)) return true;              // large badge price
    return false;
  });

  if (priceItems.length === 0) {
    return [buildBlock(items, items, medFont)];
  }

  // Cluster price items that belong to the same badge (e.g. "3" + "/" + "99¢").
  // 90 px radius (not 60) because the ¢ superscript sits up to ~82 px from the
  // main digit — e.g. "3"(x=123) and "¢"(x=205) in "3/99¢" are 82 px apart.
  const priceClusters = clusterByProximity(priceItems, 90);

  // Pre-compute centroid for each cluster
  const centroids = priceClusters.map(cluster => ({
    cluster,
    cx: cluster.reduce((s, i) => s + i.x, 0) / cluster.length,
    cy: cluster.reduce((s, i) => s + i.y, 0) / cluster.length,
  }));

  // Build a lookup set so we can skip items that are already price anchors
  const priceItemSet = new Set(priceItems);

  // Voronoi assignment: each item goes to its nearest price cluster centroid
  const MAX_RADIUS = 320; // hard cap — items beyond this are ignored
  const blockItems  = new Map(priceClusters.map(c => [c, [...c]])); // seed with own price items

  for (const item of items) {
    if (priceItemSet.has(item)) continue; // already in its cluster

    let minDist = Infinity;
    let nearest = null;

    for (const { cluster, cx, cy } of centroids) {
      // In this flyer layout text always sits to the LEFT of its price badge.
      // relX > 0 means the price is to the right of the text (natural direction).
      // relX < -80 means the price is well to the LEFT — almost certainly a
      // different deal cell, so skip it entirely.
      const relX = cx - item.x;
      if (relX < -80) continue;

      // Slightly-left prices (–80 → 0) get a 3× penalty; right-of-text prices
      // are used as-is.  This keeps "Family Pack"(x=157) assigned to the pork
      // price(x=252) rather than the nearby chicken price(x=119).
      const effectiveDx = relX >= 0 ? relX : -relX * 3;
      const dist = Math.hypot(effectiveDx, Math.abs(item.y - cy));

      if (dist < minDist) { minDist = dist; nearest = cluster; }
    }

    if (nearest && minDist <= 500) {
      blockItems.get(nearest).push(item);
    }
  }

  // Build one block per price cluster
  return centroids
    .map(({ cluster }) => {
      const nearby = blockItems.get(cluster);
      return nearby.length > 0 ? buildBlock(nearby, cluster, medFont) : null;
    })
    .filter(Boolean);
}

/**
 * Groups items into runs of consecutive lines within maxYGap px of each other.
 * Used to merge multi-line Spanish product names before translation.
 * e.g. ["Pierna de Pollo", "con Muslo"] → one group → one English translation.
 */
function groupConsecutiveLines(items, maxYGap = 28) {
  if (items.length === 0) return [];
  const groups = [[items[0]]];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const curr = items[i];
    if (curr.y - prev.y <= maxYGap) {
      groups[groups.length - 1].push(curr);
    } else {
      groups.push([curr]);
    }
  }
  return groups;
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
  // Use object identity to identify price items — avoids false matches when
  // the same digit appears elsewhere in the block (e.g. "3" in "3 oz").
  const priceItemSet = new Set(priceCluster);

  // Sort top-to-bottom for product/condition classification
  const sorted = [...nearby].sort((a, b) => a.y - b.y || a.x - b.x);

  const collectedPriceItems = [];
  const largeItems = [];
  const smallItems = [];

  for (const item of sorted) {
    if (priceItemSet.has(item)) {
      collectedPriceItems.push(item);
      continue;
    }
    if (item.fontSize >= medFont * 1.1) {
      largeItems.push(item);
    } else {
      smallItems.push(item);
    }
  }

  // Sort price items LEFT→RIGHT so "89 ¢" not "¢ 89", "1 99" not "99 1".
  // The ¢ superscript has a smaller Y (sits above) but larger X (sits right),
  // so Y-order produces wrong assembly; X-order matches reading order.
  collectedPriceItems.sort((a, b) => a.x - b.x);
  const priceText = collectedPriceItems.map(i => i.text).join(' ').trim();

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
    // Split largeItems into Spanish-only and English-large.
    // English large items (e.g. "Fresh Chicken" printed at subtitle size) are
    // treated as translation candidates alongside smallItems — NOT as Spanish
    // product name lines.  Merging them into the Spanish group would cause
    // the translation search to start below the English text, skipping it.
    const spanishLargeItems  = largeItems.filter(i =>  looksSpanish(i.text));
    const englishLargeItems  = largeItems.filter(i => !looksSpanish(i.text));
    const translationPool    = [...englishLargeItems, ...smallItems]
                                 .sort((a, b) => a.y - b.y);

    // Group consecutive Spanish lines so multi-line product names like
    // "Pierna de Pollo" + "con Muslo" produce ONE English translation, not two.
    const spanishGroups = groupConsecutiveLines(spanishLargeItems);

    for (const group of spanishGroups) {
      const spanishText = group.map(i => i.text).join(' ');
      spanishLines.push(spanishText);

      // X extent covers all lines in this group
      const groupXStart = Math.min(...group.map(i => i.x));
      const groupXEnd   = Math.max(...group.map(i => i.x + (i.w || 120)));
      // Search for English translation below the LAST line of the group
      const lastLine    = group[group.length - 1];

      const candidates = translationPool.filter(small => {
        const yDiff    = small.y - lastLine.y;
        const sxEnd    = small.x + (small.w || 60);
        const xOverlap = small.x < groupXEnd && sxEnd > groupXStart;
        return yDiff >= 0 && yDiff <= 60 && xOverlap && looksEnglish(small.text);
      });

      if (candidates.length > 0) {
        candidates.sort((a, b) => a.y - b.y);
        const best = candidates[0];
        usedAsTranslation.add(`${best.x},${best.y},${best.text}`);

        // Grab one continuation line from translationPool if it looks like a
        // name word (not a packaging/condition phrase)
        const nameParts = [best.text];
        const continuation = translationPool.find(small => {
          const key = `${small.x},${small.y},${small.text}`;
          if (usedAsTranslation.has(key)) return false;
          const yDiff    = small.y - best.y;
          const sxEnd    = small.x + (small.w || 60);
          const xOverlap = small.x < groupXEnd && sxEnd > groupXStart;
          return yDiff > 0 && yDiff <= 35 && xOverlap
              && looksEnglish(small.text)
              && !CONDITION_LINE_RE.test(small.text);
        });
        if (continuation) {
          nameParts.push(continuation.text);
          usedAsTranslation.add(`${continuation.x},${continuation.y},${continuation.text}`);
        }

        productLines.push(nameParts.join(' '));
      } else {
        // No English sub-text — keep Spanish text for manual review
        productLines.push(spanishText);
      }
    }

    // Remaining translationPool items not used as translations go to condLines
    for (const item of translationPool) {
      const key = `${item.x},${item.y},${item.text}`;
      if (!usedAsTranslation.has(key)) condLines.push(item.text);
    }
  } else {
    for (const item of largeItems) {
      const clean = item.text.replace(/[,.:;!]+$/, '').trim();
      if (isValidProductName(clean)) productLines.push(clean);
      else condLines.push(clean);
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

// ── OCR progress + error reporting ───────────────────────────────────────────

function sendOcrProgress(page, totalPages, stage, progress) {
  chrome.runtime.sendMessage({ type: 'OCR_PROGRESS', page, totalPages, stage, progress })
    .catch(() => {}); // popup may not be open
}

// Routes offscreen console messages to the service worker (visible in bg console)
function ocrLog(...args)  {
  chrome.runtime.sendMessage({ type: 'OCR_LOG',   text: args.join(' ') }).catch(() => {});
}
function ocrError(...args) {
  chrome.runtime.sendMessage({ type: 'OCR_ERROR', text: args.join(' ') }).catch(() => {});
}

// ── OCR fallback for image-based PDFs ─────────────────────────────────────────

/**
 * Renders a pdf.js page to an OffscreenCanvas and runs Tesseract.js OCR on it.
 * Returns items in the same normalised format as normaliseItems() so the rest
 * of the pipeline (extractDealBlocks etc.) works unchanged.
 *
 * Requires Tesseract.js loaded as a classic <script> in offscreen.html, which
 * exposes the global `Tesseract` object.
 */
async function ocrPageItems(page, pageNum, totalPages) {
  if (typeof Tesseract === 'undefined') {
    ocrError('[GD OCR] Tesseract global not found — tesseract.min.js did not load');
    return [];
  }
  ocrLog(`[GD OCR] Starting page ${pageNum}/${totalPages}`);

  try {
    sendOcrProgress(pageNum, totalPages, 'rendering', 0);

    // Extract the embedded page image directly — avoids the pdf.js render() pipeline
    // which deadlocks on large JPEG pages in the offscreen document context.
    const { canvas, scale } = await extractPageCanvas(page, pageNum);
    if (!canvas) {
      ocrLog(`[GD OCR] Page ${pageNum}: no extractable image, skipping`);
      return [];
    }
    // Validate canvas has actual pixel data (not blank)
    const sampleCtx = canvas.getContext('2d');
    const sample = sampleCtx.getImageData(
      Math.floor(canvas.width * 0.1), Math.floor(canvas.height * 0.1),
      10, 10
    );
    const hasPixels = sample.data.some((v, i) => i % 4 !== 3 && v !== 0 && v !== 255);
    ocrLog(`[GD OCR] Page ${pageNum}: canvas ${canvas.width}×${canvas.height} hasPixels=${hasPixels}`);

    // Upscale to ~300 DPI for better OCR accuracy.
    // Embedded images are typically ~127 DPI (1080px / 8.5in) — too low for Tesseract.
    const OCR_SCALE = 2.5;
    const ocrCanvas = document.createElement('canvas');
    ocrCanvas.width  = Math.round(canvas.width  * OCR_SCALE);
    ocrCanvas.height = Math.round(canvas.height * OCR_SCALE);
    ocrCanvas.getContext('2d').drawImage(canvas, 0, 0, ocrCanvas.width, ocrCanvas.height);
    ocrLog(`[GD OCR] Page ${pageNum}: upscaled to ${ocrCanvas.width}×${ocrCanvas.height} for OCR`);

    sendOcrProgress(pageNum, totalPages, 'recognizing', 0);

    const worker = await Tesseract.createWorker('eng', 1, {
      workerPath:    chrome.runtime.getURL('lib/worker.min.js'),
      workerBlobURL: false,
      langPath:      chrome.runtime.getURL('lib/lang/'),
      corePath:      chrome.runtime.getURL('lib/'),
      gzip:          false, // eng.traineddata is plain tessdata, not gzip-compressed
      logger: (m) => {
        ocrLog(`[GD OCR] p${pageNum} ${m.status} ${Math.round((m.progress ?? 0) * 100)}%`);
        if (m.status === 'recognizing text') {
          sendOcrProgress(pageNum, totalPages, 'recognizing', m.progress);
        }
      },
    });

    const result = await worker.recognize(ocrCanvas, {}, { text: true, hocr: true, tsv: true });
    await worker.terminate();

    const recogData = result?.data ?? result ?? {};
    const hocr = recogData.hocr ?? '';
    ocrLog(`[GD OCR] Page ${pageNum}: hocr length=${hocr.length} text="${(recogData.text ?? '').substring(0, 80).replace(/\n/g, '↵')}"`);

    // Parse hOCR output for word-level bounding boxes.
    // Each word is: <span class='ocrx_word' ... title='bbox x0 y0 x1 y1; x_wconf N'>word</span>
    // hOCR bbox coordinates are in the upscaled canvas space.
    // Tesseract escapes HTML entities in word text — decode them back to plain text.
    const decodeEntities = s => s
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g,  "'")
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c));

    const WORD_RE = /<span[^>]*class=['"]ocrx_word['"][^>]*title=['"]([^'"]+)['"][^>]*>([^<]*)<\/span>/g;
    const words = [];
    let m;
    while ((m = WORD_RE.exec(hocr)) !== null) {
      const title = m[1];
      const text  = decodeEntities(m[2].trim());
      if (!text) continue;
      const bboxM = /bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(title);
      const confM = /x_wconf\s+(\d+)/.exec(title);
      if (!bboxM) continue;
      words.push({
        text,
        confidence: confM ? parseInt(confM[1], 10) : 50,
        left:   parseInt(bboxM[1], 10),
        top:    parseInt(bboxM[2], 10),
        right:  parseInt(bboxM[3], 10),
        bottom: parseInt(bboxM[4], 10),
      });
    }
    ocrLog(`[GD OCR] Page ${pageNum}: ${words.length} words from hOCR`);

    // Minimum word height in OCR-scaled pixels: 12 native px × OCR_SCALE.
    // Sub-pixel / tiny detections (decorative borders, icons, noise) have heights
    // of 1–10 native px.  12 px ≈ 6.8 pt at 127 DPI — below any real flyer text.
    // Keeping this floor high enough ensures medFont is a useful signal (~15-20 px)
    // so that extractDealBlocks' font-size thresholds (medFont*1.1/1.8) behave correctly.
    const MIN_HEIGHT_OCR = Math.round(12 * OCR_SCALE); // 30 px at 2.5×

    // Coordinates are in upscaled space — divide by OCR_SCALE to get native pixel coords
    const items = words
      .filter(w =>
        w.confidence > 50 &&
        (w.bottom - w.top) >= MIN_HEIGHT_OCR &&
        // Drop single non-price chars (decorative glyphs read as letters)
        (w.text.length >= 2 || /^[\d$¢]/.test(w.text))
      )
      .map(w => ({
        text:     w.text,
        x:        Math.round(w.left                    / OCR_SCALE),
        y:        Math.round(w.top                     / OCR_SCALE),
        w:        Math.round((w.right  - w.left)       / OCR_SCALE),
        fontSize: Math.round((w.bottom - w.top)        / OCR_SCALE),
      }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    ocrLog(`[GD OCR] Page ${pageNum}: ${items.length} items after noise filtering`);
    return items;

  } catch (err) {
    ocrError(`[GD OCR] Error on page ${pageNum}: ${err.message}`);
    return [];
  }
}

/**
 * Extracts an image-based PDF page to an HTMLCanvasElement without going through
 * page.render() (which deadlocks on large embedded images in the offscreen context).
 *
 * Strategy:
 *  1. Call page.getOperatorList() — forces pdf.js to load and decode all XObject images.
 *  2. Find the first paintImageXObject / paintJpegXObject operation.
 *  3. Retrieve the decoded image via page.objs.get().
 *  4. Put the pixel data onto a canvas and return it.
 *
 * Returns { canvas, scale } where scale=1 (image extracted at native resolution).
 */
async function extractPageCanvas(page, pageNum) {
  // Trigger decoding of all page resources (images, fonts, …)
  const ops = await page.getOperatorList();
  ocrLog(`[GD OCR] Page ${pageNum}: operator list has ${ops.fnArray.length} ops`);

  // PDF paint-image op codes (stable across pdf.js versions)
  const PAINT_OPS = new Set([
    82,  // OPS.paintJpegXObject
    83,  // OPS.paintImageMaskXObject
    85,  // OPS.paintImageXObject
    88,  // OPS.paintImageXObjectRepeat
  ]);

  const seen = new Set();
  const imageNames = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (PAINT_OPS.has(ops.fnArray[i])) {
      const name = ops.argsArray[i]?.[0];
      if (name && !seen.has(name)) { seen.add(name); imageNames.push(name); }
    }
  }
  ocrLog(`[GD OCR] Page ${pageNum}: found image names: ${imageNames.join(', ') || 'none'}`);

  if (imageNames.length === 0) return { canvas: null, scale: 1 };

  // Retrieve the decoded image object (pdf.js decodes it during getOperatorList)
  const img = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('page.objs.get timed out')), 20000);
    page.objs.get(imageNames[0], obj => { clearTimeout(timeout); resolve(obj); });
  });

  if (!img) throw new Error('page.objs.get returned null/undefined');

  // Log all keys so we can see what pdf.js v4 actually gives us
  const keys = Object.keys(img).join(', ');
  ocrLog(`[GD OCR] Page ${pageNum}: img keys = ${keys}`);

  const canvas = document.createElement('canvas');

  if (img.bitmap instanceof ImageBitmap) {
    // pdf.js v4 path: image decoded as ImageBitmap (GPU-accelerated)
    ocrLog(`[GD OCR] Page ${pageNum}: ImageBitmap ${img.bitmap.width}×${img.bitmap.height}`);
    canvas.width  = img.bitmap.width;
    canvas.height = img.bitmap.height;
    canvas.getContext('2d').drawImage(img.bitmap, 0, 0);

  } else if (img.data && img.width && img.height) {
    // pdf.js v3 path: raw pixel buffer
    ocrLog(`[GD OCR] Page ${pageNum}: raw pixels ${img.width}×${img.height} kind=${img.kind}`);
    canvas.width  = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').putImageData(new ImageData(toRGBA(img), img.width, img.height), 0, 0);

  } else {
    throw new Error(`Unrecognised image object shape — keys: ${keys}`);
  }

  return { canvas, scale: 1 };
}

/** Converts a pdf.js image object (any ImageKind) to a Uint8ClampedArray of RGBA pixels. */
function toRGBA(img) {
  const { data, width, height, kind } = img;
  const total = width * height;

  if (kind === 3) {
    // Already RGBA
    return data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  }

  const rgba = new Uint8ClampedArray(total * 4);

  if (kind === 2) {
    // RGB → RGBA
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i]; rgba[j + 1] = data[i + 1]; rgba[j + 2] = data[i + 2]; rgba[j + 3] = 255;
    }
  } else {
    // GRAYSCALE_1BPP or other — expand each value to RGB
    for (let i = 0, j = 0; j < rgba.length; i++, j += 4) {
      const v = data[i] ?? 0;
      rgba[j] = rgba[j + 1] = rgba[j + 2] = v; rgba[j + 3] = 255;
    }
  }

  return rgba;
}

// background.js — Service Worker
// Handles: tab tracking, queue storage, message routing, automation state

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let portalTabId  = null;
let flyerTabId   = null;
let automationState = 'idle'; // 'idle' | 'running' | 'paused'
let currentDealIndex = 0;
let currentStoreIndex = 0;

// ── Tab tracking ──────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('admin.mygrocerydeals.com')) {
    portalTabId = tabId;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === portalTabId) portalTabId = null;
  if (tabId === flyerTabId)  flyerTabId  = null;
});

// ── Queue helpers ─────────────────────────────────────────────────────────────

async function getQueue() {
  const { dealQueue = [] } = await chrome.storage.local.get('dealQueue');
  return dealQueue;
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ dealQueue: queue });
}

async function addStoreToQueue(storeEntry) {
  const queue = await getQueue();
  queue.push({
    id:        Date.now(),
    storeName: storeEntry.storeName,
    taskId:    storeEntry.taskId,
    deals:     storeEntry.deals.map((d, i) => ({ ...d, id: `${Date.now()}-${i}`, status: 'pending' })),
    status:    'pending',
    addedAt:   new Date().toISOString(),
  });
  await saveQueue(queue);
  updateBadge(queue);
}

async function updateDealStatus(dealId, status, error = null) {
  const queue = await getQueue();
  for (const store of queue) {
    const deal = store.deals.find(d => d.id === dealId);
    if (deal) {
      deal.status = status;
      if (error) deal.error = error;
      if (status === 'done' && store.deals.every(d => d.status === 'done')) {
        store.status = 'done';
      }
      break;
    }
  }
  await saveQueue(queue);
}

function updateBadge(queue) {
  const pending = queue.reduce((n, s) => n + s.deals.filter(d => d.status === 'pending').length, 0);
  chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2196F3' });
}

// ── Automation orchestrator ───────────────────────────────────────────────────

async function runAutomation() {
  if (automationState === 'running') return;
  if (!portalTabId) {
    console.warn('[BG] No portal tab found — cannot start automation.');
    return;
  }

  automationState = 'running';
  setBadgeRunning();

  const queue = await getQueue();
  const stores = queue.filter(s => s.status === 'pending');

  for (const store of stores) {
    const pendingDeals = store.deals.filter(d => d.status === 'pending');

    for (const deal of pendingDeals) {
      if (automationState !== 'running') break;

      // Send deal to portal content script and wait for result
      const result = await sendDealToPortal(deal);

      if (result?.needsReview) {
        // Pause and alert user — they'll resume via popup
        automationState = 'paused';
        setBadgePaused(deal);
        await chrome.storage.local.set({ pausedDeal: deal, pauseReason: result.reason });
        return;
      }

      await updateDealStatus(deal.id, result?.success ? 'done' : 'failed', result?.error);

      // Human-realistic pacing between deals
      await sleep(600);
    }
  }

  automationState = 'idle';
  clearBadge();
  notifyPopup({ type: 'AUTOMATION_COMPLETE' });
}

function sendDealToPortal(deal) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(portalTabId, { type: 'ENTER_DEAL', deal }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

async function resumeAutomation() {
  await chrome.storage.local.remove(['pausedDeal', 'pauseReason']);
  automationState = 'running';
  await runAutomation();
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

function setBadgeRunning() {
  chrome.action.setBadgeText({ text: '▶' });
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

function setBadgePaused(deal) {
  chrome.action.setBadgeText({ text: '⏸' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup may not be open
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'SET_FLYER_TAB':
        flyerTabId = sender.tab?.id ?? msg.tabId;
        sendResponse({ success: true, tabId: flyerTabId });
        break;

      case 'GET_STATE':
        sendResponse({
          portalTabId,
          flyerTabId,
          automationState,
          queue: await getQueue(),
        });
        break;

      case 'ADD_TO_QUEUE':
        await addStoreToQueue(msg.storeEntry);
        sendResponse({ success: true });
        break;

      case 'CLEAR_QUEUE':
        await saveQueue([]);
        clearBadge();
        sendResponse({ success: true });
        break;

      case 'REMOVE_FROM_QUEUE':
        const queue = await getQueue();
        await saveQueue(queue.filter(s => s.id !== msg.storeId));
        sendResponse({ success: true });
        break;

      case 'START_AUTOMATION':
        runAutomation(); // intentionally not awaited — runs in background
        sendResponse({ success: true });
        break;

      case 'PAUSE_AUTOMATION':
        automationState = 'paused';
        sendResponse({ success: true });
        break;

      case 'RESUME_AUTOMATION':
        resumeAutomation();
        sendResponse({ success: true });
        break;

      case 'DEAL_NEEDS_REVIEW':
        automationState = 'paused';
        setBadgePaused();
        sendResponse({ success: true });
        break;

      case 'PARSE_FLYER':
        if (!flyerTabId) {
          sendResponse({ success: false, error: 'No flyer tab set. Click "Set as Flyer Tab" while on the flyer page.' });
          break;
        }
        try {
          const tab = await chrome.tabs.get(flyerTabId);
          const isPdf = await tabIsPdf(tab);

          if (isPdf) {
            await parsePdfTab(tab);
            sendResponse({ success: true, message: 'PDF parsing started — deals will appear in the queue.' });
          } else {
            await chrome.scripting.executeScript({
              target: { tabId: flyerTabId },
              files: ['parser/flyer-parser.js'],
            });
            sendResponse({ success: true, message: 'Web flyer parsing started — deals will appear in the queue.' });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;

      case 'FLYER_PARSED':
        // Result from flyer-parser.js (web viewer) injected into flyer tab
        await handleFlyerParsed(msg.rawBlocks, msg.pageUrl);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: `Unknown message type: ${msg.type}` });
    }
  })();
  return true; // keep channel open for async response
});

// ── PDF detection & routing ───────────────────────────────────────────────────

async function tabIsPdf(tab) {
  const url = tab.url ?? '';
  // Direct PDF URL
  if (url.toLowerCase().endsWith('.pdf')) return true;
  // Content-Type sniff via HEAD request
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const ct  = res.headers.get('content-type') ?? '';
    return ct.includes('pdf');
  } catch {
    return false;
  }
}

async function parsePdfTab(tab) {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');

  // Create offscreen document if not already open
  const existing = await chrome.offscreen.hasDocument?.() ?? false;
  if (!existing) {
    await chrome.offscreen.createDocument({
      url:    offscreenUrl,
      reasons: ['BLOBS'],
      justification: 'Parse PDF flyer using pdf.js',
    });
  }

  // Send PDF URL to offscreen document for parsing
  const result = await sendOffscreen({ type: 'PARSE_PDF', url: tab.url, storeName: tab.title });

  if (!result?.success) {
    throw new Error(result?.error ?? 'PDF parsing failed');
  }

  await handleFlyerParsed(result.rawBlocks, tab.url, tab.title);

  // Close offscreen document when done
  await chrome.offscreen.closeDocument?.();
}

function sendOffscreen(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

// ── Parsed flyer handler ──────────────────────────────────────────────────────

async function handleFlyerParsed(rawBlocks, pageUrl, storeName) {
  if (!rawBlocks?.length) {
    console.warn('[GD] No deal blocks found in flyer');
    return;
  }

  // Load deal-structurer via scripting into a temporary context
  // (structureDeals is available globally after the script runs)
  const structured = structureDealsFromRaw(rawBlocks);

  const entry = {
    storeName: storeName ?? new URL(pageUrl).hostname,
    flyerUrl:  pageUrl,
    deals:     structured,
  };

  await addStoreToQueue(entry);
  notifyPopup({ type: 'QUEUE_UPDATED' });
  console.log(`[GD] Added ${structured.length} deals for "${entry.storeName}"`);
}

/**
 * Inline deal structurer — mirrors deal-structurer.js logic.
 * Kept here so background.js is self-contained without needing importScripts.
 */
function structureDealsFromRaw(rawBlocks) {
  return rawBlocks.flatMap((block, blockIdx) => {
    const fullText = [
      ...(block.productLines ?? []),
      block.priceText     ?? '',
      block.conditionText ?? '',
    ].join(' ');

    const price   = parsePriceInfo(block.priceText ?? fullText);
    const tags    = parseTagInfo(fullText);
    const limit   = parseLimitInfo(fullText);
    const size    = parseSizeInfo(block.conditionText ?? fullText);
    const products = block.productLines?.length ? block.productLines : ['Unknown Product'];

    return products.map((line, i) => ({
      id:             `${Date.now()}-${blockIdx}-${i}`,
      status:         'pending',
      productName:    line,
      brand:          '',
      ...size,
      ...price,
      ...tags,
      ...limit,
      additionalTags: [...(price.additionalTags ?? []), ...(tags.additionalTags ?? [])]
                        .filter((v, i, a) => a.indexOf(v) === i),
      customText:     block.conditionText || undefined,
      needsUOMReview: tags.needsUOMReview ?? false,
      _raw:           block,
    }));
  });
}

function parsePriceInfo(text) {
  const t = (text ?? '').replace(/\s+/g, ' ');
  const multiSlash = /(\d+)\s*\/\s*\$\s*(\d+(?:\.\d{1,2})?)/.exec(t);
  if (multiSlash) {
    const qty = parseInt(multiSlash[1]), total = parseFloat(multiSlash[2]);
    return { saleType: 'regular', price: parseFloat((total/qty).toFixed(2)), minQtyRequired: true, additionalTags: [] };
  }
  if (/buy\s+\d+\s+get\s+\d+/i.test(t) || /\bbogo\b/i.test(t)) {
    const m = /buy\s+(\d+)\s+get\s+(\d+)/i.exec(t);
    return { saleType: 'multibuy', buyQty: parseInt(m?.[1]??'1'), getQty: parseInt(m?.[2]??'1'),
             minQtyRequired: true, additionalTags: ['basedOnRegular'] };
  }
  if (/\d+¢|^0?\.\d{2}$/.test(t)) {
    const c = /(\d+)¢|0?\.(\d{2})/.exec(t);
    return { saleType: 'custom', price: c ? parseInt(c[1]||c[2])/100 : null, additionalTags: [] };
  }
  const straight = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(t);
  return { saleType: 'regular', price: straight ? parseFloat(straight[1]) : null, additionalTags: [] };
}

function parseTagInfo(text) {
  const t = (text ?? '').toLowerCase();
  return {
    loyaltyCard:    /with card|loyalty|price card|membership|member price/.test(t),
    couponRequired: /coupon|clip/.test(t),
    topDeal:        /top deal|featured/.test(t),
    needsUOMReview: /butcher block|deli|bakery|per piece/.test(t),
    additionalTags: [
      ...((/select variet/.test(t))  ? ['selectedVarieties'] : []),
      ...((/all variet/.test(t))     ? ['includesAll']        : []),
      ...((/see store|terms apply/.test(t)) ? ['seeStore']   : []),
    ],
  };
}

function parseLimitInfo(text) {
  const m = /limit\s+(\d+)\s+per/i.exec(text ?? '');
  return m ? { limit: parseInt(m[1]) } : {};
}

function parseSizeInfo(text) {
  const range  = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(oz|lb|ct)/i.exec(text ?? '');
  if (range) return { sizeMin: parseFloat(range[1]), sizeMax: parseFloat(range[2]), sizeUnit: range[3] };
  const single = /(\d+(?:\.\d+)?)\s*(oz|lb|ct)/i.exec(text ?? '');
  if (single) return { size: parseFloat(single[1]), sizeUnit: single[2] };
  return {};
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

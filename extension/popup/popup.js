// popup.js — Extension popup controller

'use strict';

// ── Element refs ──────────────────────────────────────────────────────────────

const stateBadge    = document.getElementById('state-badge');
const dotPortal     = document.getElementById('dot-portal');
const dotFlyer      = document.getElementById('dot-flyer');
const btnSetFlyer   = document.getElementById('btn-set-flyer');
const flyerUrlEl    = document.getElementById('flyer-url');
const btnParse      = document.getElementById('btn-parse');
const parseStatus   = document.getElementById('parse-status');
const reviewBanner  = document.getElementById('review-banner');
const reviewReason  = document.getElementById('review-reason');
const btnResume     = document.getElementById('btn-resume');
const queueList     = document.getElementById('queue-list');
const btnClearQueue = document.getElementById('btn-clear-queue');
const btnReview     = document.getElementById('btn-review');
const btnExportCsv  = document.getElementById('btn-export-csv');
const btnStart      = document.getElementById('btn-start');
const btnPause      = document.getElementById('btn-pause');

// ── State refresh ─────────────────────────────────────────────────────────────

async function refreshState() {
  const state = await sendBg({ type: 'GET_STATE' });
  if (!state) return;

  // Portal tab indicator
  setDot(dotPortal, !!state.portalTabId);

  // Flyer tab indicator + URL display
  setDot(dotFlyer, !!state.flyerTabId);
  if (state.flyerTabId) {
    chrome.tabs.get(state.flyerTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      flyerUrlEl.textContent = tab.url;
      flyerUrlEl.classList.remove('hidden');
    });
  } else {
    flyerUrlEl.classList.add('hidden');
  }

  // Automation state badge
  setStateBadge(state.automationState);

  // Queue
  renderQueue(state.queue ?? []);

  // Button states
  const hasQueue    = (state.queue ?? []).some(s => s.status === 'pending');
  const isRunning   = state.automationState === 'running';
  const isPaused    = state.automationState === 'paused';

  btnParse.disabled     = !state.flyerTabId;
  btnReview.disabled    = !hasQueue;
  btnExportCsv.disabled = !hasQueue;
  btnStart.disabled     = !hasQueue || !state.portalTabId || isRunning;
  btnPause.disabled     = !isRunning;

  // Pause/review banner
  if (isPaused) {
    const { pauseReason } = await chrome.storage.local.get('pauseReason');
    reviewReason.textContent = pauseReason ?? 'A deal needs manual attention.';
    reviewBanner.classList.remove('hidden');
  } else {
    reviewBanner.classList.add('hidden');
  }
}

// ── Queue rendering ───────────────────────────────────────────────────────────

function renderQueue(queue) {
  if (queue.length === 0) {
    queueList.innerHTML = '<p class="empty-msg">No stores queued yet.</p>';
    return;
  }

  queueList.innerHTML = queue.map(store => {
    const total  = store.deals?.length ?? 0;
    const done   = store.deals?.filter(d => d.status === 'done').length ?? 0;
    const failed = store.deals?.filter(d => d.status === 'failed').length ?? 0;
    const label  = done > 0 ? `${done}/${total} entered` : `${total} deals`;

    return `
      <div class="queue-item" data-id="${store.id}">
        <span class="item-status ${store.status}">${store.status}</span>
        <span class="store-name" title="${store.storeName}">${store.storeName}</span>
        <span class="deal-count">${label}${failed > 0 ? ` · ${failed} failed` : ''}</span>
        <button class="btn-remove" data-id="${store.id}" title="Remove">×</button>
      </div>
    `;
  }).join('');

  // Remove buttons
  queueList.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await sendBg({ type: 'REMOVE_FROM_QUEUE', storeId: Number(btn.dataset.id) });
      refreshState();
    });
  });
}

// ── Button handlers ───────────────────────────────────────────────────────────

btnSetFlyer.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await sendBg({ type: 'SET_FLYER_TAB', tabId: tab.id });
  showParseStatus('Flyer tab set.', false);
  refreshState();
});

btnParse.addEventListener('click', async () => {
  btnParse.disabled = true;
  showParseStatus('Parsing flyer…', false);
  const result = await sendBg({ type: 'PARSE_FLYER' });
  if (result?.success) {
    showParseStatus('Parsing started — check queue when complete.', false);
  } else {
    showParseStatus(`Error: ${result?.error ?? 'Unknown error'}`, true);
    btnParse.disabled = false;
  }
});

btnStart.addEventListener('click', async () => {
  await sendBg({ type: 'START_AUTOMATION' });
  refreshState();
});

btnPause.addEventListener('click', async () => {
  await sendBg({ type: 'PAUSE_AUTOMATION' });
  refreshState();
});

btnResume.addEventListener('click', async () => {
  await sendBg({ type: 'RESUME_AUTOMATION' });
  reviewBanner.classList.add('hidden');
  refreshState();
});

btnReview.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') });
});

btnExportCsv.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html?export=1') });
});

btnClearQueue.addEventListener('click', async () => {
  if (!confirm('Clear the entire queue?')) return;
  await sendBg({ type: 'CLEAR_QUEUE' });
  refreshState();
});

// ── Listen for background updates ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTOMATION_COMPLETE') {
    setStateBadge('idle');
    refreshState();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

function setDot(el, connected) {
  el.className = `dot ${connected ? 'connected' : 'disconnected'}`;
}

function setStateBadge(state) {
  stateBadge.textContent = state ?? 'idle';
  stateBadge.className   = `badge ${state ?? 'idle'}`;
}

function showParseStatus(msg, isError) {
  parseStatus.textContent  = msg;
  parseStatus.style.color  = isError ? '#e53935' : '#555';
  parseStatus.classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────────

refreshState();
// Refresh every 3s while popup is open to reflect automation progress
setInterval(refreshState, 3000);

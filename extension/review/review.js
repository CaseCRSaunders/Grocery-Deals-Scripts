'use strict';

// ── Load queue from storage ───────────────────────────────────────────────────

async function loadQueue() {
  return new Promise(resolve => {
    chrome.storage.local.get('dealQueue', ({ dealQueue = [] }) => resolve(dealQueue));
  });
}

async function saveQueue(queue) {
  return new Promise(resolve => {
    chrome.storage.local.set({ dealQueue: queue }, resolve);
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

async function render() {
  const queue = await loadQueue();
  const container = document.getElementById('stores-container');
  container.innerHTML = '';

  const totalDeals = queue.reduce((n, s) => n + (s.deals?.length ?? 0), 0);
  document.getElementById('deal-count').textContent = `${totalDeals} deals`;

  if (queue.length === 0) {
    container.innerHTML = '<p style="padding:40px;text-align:center;color:#aaa">No deals in queue.</p>';
    return;
  }

  for (const store of queue) {
    container.appendChild(buildStoreSection(store));
  }
}

function buildStoreSection(store) {
  const section = document.createElement('div');
  section.className = 'store-section';
  section.dataset.storeId = store.id;

  const dealCount = store.deals?.length ?? 0;
  const flagged   = store.deals?.filter(d => d.needsUOMReview || d.limitNeedsReview).length ?? 0;

  section.innerHTML = `
    <div class="store-header">
      <h2>${escHtml(store.storeName)}</h2>
      <span class="store-meta">${dealCount} deals${flagged ? ` · ${flagged} flagged` : ''}</span>
    </div>
  `;

  const table = document.createElement('table');
  table.className = 'deal-table';
  table.innerHTML = `
    <colgroup>
      <col class="col-flags">
      <col class="col-product">
      <col class="col-brand">
      <col class="col-size">
      <col class="col-type">
      <col class="col-price">
      <col class="col-tags">
      <col class="col-custom">
      <col class="col-actions">
    </colgroup>
    <thead>
      <tr>
        <th></th>
        <th>Product</th>
        <th>Brand</th>
        <th>Size</th>
        <th>Sale Type</th>
        <th>Price</th>
        <th>Tags</th>
        <th>Additional Info</th>
        <th></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody');
  for (const deal of (store.deals ?? [])) {
    tbody.appendChild(buildDealRow(deal, store.id));
  }

  section.appendChild(table);
  return section;
}

function buildDealRow(deal, storeId) {
  const tr = document.createElement('tr');
  tr.dataset.dealId  = deal.id;
  tr.dataset.storeId = storeId;

  // Row state classes
  if (deal.needsUOMReview)   tr.classList.add('needs-uom');
  if (deal.limitNeedsReview) tr.classList.add('limit-review');
  if (deal.isSeasonal)       tr.classList.add('is-seasonal');

  // Flags
  const spanishOriginal = (deal._raw?.spanishLines ?? []).join(' / ');
  const flags = [
    deal.needsUOMReview   ? '<span title="Unit of Measure needs checking">📐</span>' : '',
    deal.limitNeedsReview ? '<span title="Limit is unclear">⚠️</span>'               : '',
    deal.isSeasonal       ? '<span title="Seasonal — will be skipped">🚫</span>'      : '',
    spanishOriginal       ? `<span title="Translated from: ${escHtml(spanishOriginal)}">🌐</span>` : '',
  ].join('');

  // Size display
  const sizeText = deal.sizeMin != null
    ? `${deal.sizeMin}–${deal.sizeMax} ${deal.sizeUnit ?? ''}`
    : deal.size != null ? `${deal.size} ${deal.sizeUnit ?? ''}` : '—';

  // Price display
  const priceText = deal.saleType === 'multibuy'
    ? `Buy ${deal.buyQty} Get ${deal.getQty}`
    : deal.price != null ? `$${deal.price}` : '—';

  // Tags
  const tagHtml = buildTagHtml(deal);

  tr.innerHTML = `
    <td><div class="flags">${flags || '—'}</div></td>
    <td><span class="editable" contenteditable="true" data-field="productName">${escHtml(deal.productName ?? '')}</span></td>
    <td><span class="editable" contenteditable="true" data-field="brand">${escHtml(deal.brand ?? '')}</span></td>
    <td>${escHtml(sizeText)}</td>
    <td><span class="type-badge type-${deal.saleType ?? 'regular'}">${escHtml(deal.saleType ?? 'regular')}</span></td>
    <td>${escHtml(priceText)}</td>
    <td><div class="tag-list">${tagHtml}</div></td>
    <td><span class="editable" contenteditable="true" data-field="customText">${escHtml(deal.customText ?? '')}</span></td>
    <td><button class="btn-remove" title="Remove deal">×</button></td>
  `;

  // Save edits back to storage on blur
  tr.querySelectorAll('.editable').forEach(el => {
    el.addEventListener('blur', () => saveCellEdit(storeId, deal.id, el.dataset.field, el.textContent.trim()));
  });

  // Remove deal
  tr.querySelector('.btn-remove').addEventListener('click', () => removeDeal(storeId, deal.id, tr));

  return tr;
}

function buildTagHtml(deal) {
  const tags = [];
  if (deal.loyaltyCard)    tags.push('<span class="tag loyalty">Loyalty Card</span>');
  if (deal.couponRequired) tags.push('<span class="tag coupon">Coupon</span>');
  if (deal.minQtyRequired) tags.push('<span class="tag minqty">Min Qty</span>');
  if (deal.topDeal)        tags.push('<span class="tag topdeal">Top Deal</span>');

  for (const t of (deal.additionalTags ?? [])) {
    if (t === 'selectedVarieties') tags.push('<span class="tag selvar">Select Varieties</span>');
    if (t === 'includesAll')       tags.push('<span class="tag incall">All Varieties</span>');
    if (t === 'basedOnRegular')    tags.push('<span class="tag basedreg">Based on Regular</span>');
    if (t === 'seeStore')          tags.push('<span class="tag seestore">See Store</span>');
  }

  if (deal.limit)          tags.push(`<span class="tag minqty">Limit ${deal.limit}</span>`);
  return tags.join('') || '<span style="color:#bbb;font-size:11px">none</span>';
}

// ── Edits ─────────────────────────────────────────────────────────────────────

async function saveCellEdit(storeId, dealId, field, value) {
  const queue = await loadQueue();
  const store = queue.find(s => s.id === storeId);
  const deal  = store?.deals?.find(d => d.id === dealId);
  if (deal) { deal[field] = value; await saveQueue(queue); }
}

async function removeDeal(storeId, dealId, tr) {
  tr.classList.add('removed');
  const queue = await loadQueue();
  const store = queue.find(s => s.id === storeId);
  if (store) {
    store.deals = store.deals.filter(d => d.id !== dealId);
    await saveQueue(queue);
  }
  setTimeout(() => tr.remove(), 400);
}

// ── CSV export ────────────────────────────────────────────────────────────────

async function exportCsv() {
  const queue = await loadQueue();
  const rows  = [
    ['Store', 'Product', 'Brand', 'Size', 'Sale Type', 'Price', 'Buy Qty', 'Get Qty',
     'Min Qty Required', 'Loyalty Card', 'Coupon', 'Top Deal', 'Limit',
     'Additional Tags', 'Additional Info', 'Needs UOM Review', 'Flagged', 'Original (Spanish)'],
  ];

  for (const store of queue) {
    for (const deal of (store.deals ?? [])) {
      rows.push([
        store.storeName,
        deal.productName ?? '',
        deal.brand ?? '',
        deal.sizeMin != null ? `${deal.sizeMin}-${deal.sizeMax} ${deal.sizeUnit ?? ''}` : `${deal.size ?? ''} ${deal.sizeUnit ?? ''}`,
        deal.saleType ?? '',
        deal.price ?? '',
        deal.buyQty ?? '',
        deal.getQty ?? '',
        deal.minQtyRequired ? 'Yes' : '',
        deal.loyaltyCard    ? 'Yes' : '',
        deal.couponRequired ? 'Yes' : '',
        deal.topDeal        ? 'Yes' : '',
        deal.limit ?? '',
        (deal.additionalTags ?? []).join('; '),
        deal.customText ?? '',
        deal.needsUOMReview   ? 'Yes' : '',
        deal.limitNeedsReview ? 'Yes' : '',
        (deal._raw?.spanishLines ?? []).join('; '),
      ]);
    }
  }

  const csv  = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `GroceryDeals_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Button handlers ───────────────────────────────────────────────────────────

document.getElementById('btn-export-csv').addEventListener('click', exportCsv);

document.getElementById('btn-confirm-all').addEventListener('click', () => window.close());

document.getElementById('btn-clear-flagged').addEventListener('click', async () => {
  const queue = await loadQueue();
  for (const store of queue) {
    store.deals = store.deals.filter(d => !d.isSeasonal);
  }
  await saveQueue(queue);
  render();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

render().then(() => {
  // Auto-trigger CSV export if opened via the CSV button in the popup
  if (new URLSearchParams(location.search).get('export') === '1') {
    exportCsv();
  }
});

// ==UserScript==
// @name         MGD Deal List Paginator
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Paginates the deals list on admin.mygrocerydeals.com by injecting
//               page/size parameters into the search API POST body so the server
//               returns only one page of results, reducing memory and render time.
// @author       Memory Monitor
// @match        https://admin.mygrocerydeals.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  console.log('[DPL] Deal List Paginator v2 loaded');

  // ── CONFIGURATION ─────────────────────────────────────────────────────────
  const CFG = {
    defaultPageSize: 50,
    pageSizeOptions: [50, 100, 150],
    storageKey:   'mgd_dpl',
    // Page route scope — XHR is only intercepted while this string appears in the
    // current page pathname.
    routeScope:   'deal-entry',
    // Unique substring of the deals search API URL.
    endpointHint: 'data-entry-deal/search',
    // Dot-path to the total-count field in the response JSON.
    // Leave empty to auto-detect from common field names.
    totalPath:    '',
    discoveryMode: true,
  };

  // ── STATE ─────────────────────────────────────────────────────────────────
  // Minimal state: just the current page number and last-known total.
  // No item caching needed — the server handles slicing.
  function loadState() {
    try {
      const raw = sessionStorage.getItem(CFG.storageKey);
      const s   = raw ? JSON.parse(raw) : {};
      return {
        page:     s.page     ?? 0,
        total:    s.total    ?? null,
        pageSize: s.pageSize ?? CFG.defaultPageSize,
      };
    } catch (e) { return { page: 0, total: null, pageSize: CFG.defaultPageSize }; }
  }

  function saveState(s) {
    try { sessionStorage.setItem(CFG.storageKey, JSON.stringify(s)); }
    catch (e) {}
  }

  function clearState() { sessionStorage.removeItem(CFG.storageKey); }

  // ── URL HELPERS ───────────────────────────────────────────────────────────
  function isOnDealRoute() {
    return window.location.pathname.includes(CFG.routeScope);
  }

  function shouldIntercept(url) {
    if (!url) return false;
    if (!isOnDealRoute()) return false;
    if (!url.includes(CFG.endpointHint)) return false;
    return true;
  }

  // ── REQUEST BODY MODIFIER ─────────────────────────────────────────────────
  // Modifies the JSON POST body to request only one page of results.
  // The API uses Elasticsearch-style pagination: `from` (item offset) + `size`.
  // We only touch those two fields and leave everything else untouched.
  function injectPagination(bodyStr, page, pageSize) {
    let body;
    try { body = JSON.parse(bodyStr); }
    catch (e) {
      if (CFG.discoveryMode) console.log('[DPL] Request body is not JSON — skipping');
      return bodyStr;
    }

    // Skip count-only requests. The dealCountResolver sends size: 0 or size: 1
    // to fetch a count without item data; we must not inflate those.
    const existingSize = body.size ?? body.limit ?? body.pageSize;
    if (existingSize !== undefined && existingSize <= 1) {
      if (CFG.discoveryMode) {
        console.log('[DPL] Skipping count-only request (size=' + existingSize + ')');
      }
      return bodyStr;
    }

    // The API uses `from` (item offset) + `size` (page size).
    // Only modify the fields that already exist — injecting unknown fields
    // causes the API to return an error response.
    if ('from' in body) {
      body.from = page * pageSize;
      body.size = pageSize;
    } else if ('page' in body) {
      body.page = page;
      if ('size' in body)     body.size     = pageSize;
      if ('limit' in body)    body.limit    = pageSize;
      if ('pageSize' in body) body.pageSize = pageSize;
    } else {
      if ('size' in body)     body.size     = pageSize;
      if ('limit' in body)    body.limit    = pageSize;
      if ('pageSize' in body) body.pageSize = pageSize;
    }

    if (CFG.discoveryMode) {
      console.log('[DPL] Injected pagination into request body —', JSON.stringify(body));
    }
    return JSON.stringify(body);
  }

  // ── RESPONSE TOTAL FINDER ─────────────────────────────────────────────────
  // Looks for a numeric total-count value in the response JSON.
  function findTotal(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // User-specified dot-path takes priority
    if (CFG.totalPath) {
      const val = CFG.totalPath.split('.').reduce(
        function (o, k) { return o != null ? o[k] : undefined; }, obj
      );
      if (typeof val === 'number') return val;
    }

    // Auto-detect from common field names at the top level
    const candidates = [
      'total', 'totalElements', 'totalCount', 'count',
      'totalRecords', 'recordCount', 'totalItems', 'rowCount',
    ];
    for (const k of candidates) {
      if (typeof obj[k] === 'number') return obj[k];
    }

    // One level deep (e.g. { data: { total: 312, items: [...] } })
    for (const k of Object.keys(obj)) {
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
        for (const ck of candidates) {
          if (typeof obj[k][ck] === 'number') return obj[k][ck];
        }
      }
    }

    return null;
  }

  // ── XHR OVERRIDE ─────────────────────────────────────────────────────────
  // Angular's HttpClient uses XHR exclusively. We intercept open() to capture
  // the URL and send() to modify the request body and read the response total.
  const _XHR = window.XMLHttpRequest;

  function PatchedXHR() {
    const xhr = new _XHR();
    let _url  = '';

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url) {
      _url = typeof url === 'string' ? url : (url ? String(url) : '');
      return origOpen.apply(xhr, arguments);
    };

    const origSend = xhr.send.bind(xhr);
    xhr.send = function (body) {
      if (!shouldIntercept(_url)) return origSend.call(xhr, body);

      const state = loadState();

      if (CFG.discoveryMode) {
        console.log('[DPL] XHR intercepted:', _url, '— requesting page', state.page);
      }

      // Modify the request body to ask the server for only our page
      let modifiedBody = body;
      if (typeof body === 'string' && body.length > 0) {
        modifiedBody = injectPagination(body, state.page, state.pageSize);
      } else if (body && typeof body === 'object' && !(body instanceof FormData)) {
        try {
          modifiedBody = injectPagination(JSON.stringify(body), state.page, state.pageSize);
        } catch (e) { /* leave as-is */ }
      }

      // After the response arrives, read the total count and refresh the UI
      xhr.addEventListener('load', function () {
        const ct = xhr.getResponseHeader('content-type') || '';
        if (!ct.includes('json')) return;

        let data;
        try { data = JSON.parse(xhr.responseText); }
        catch (e) {
          if (CFG.discoveryMode) console.log('[DPL] Response JSON parse error');
          return;
        }

        if (CFG.discoveryMode) {
          console.log('[DPL] Response top-level keys:', Object.keys(data || {}));
        }

        const total = findTotal(data);
        if (CFG.discoveryMode) {
          console.log('[DPL] Total count detected:', total);
        }

        // Persist: keep a previously-captured total if this response doesn't carry one.
        // The dealCountResolver fires first and sets the total; the main search
        // response may not include it.
        const prevState = loadState();
        saveState({
          page:     prevState.page,
          pageSize: prevState.pageSize,
          total:    total !== null ? total : prevState.total,
        });
        setTimeout(buildUI, 0);
      });

      return origSend.call(xhr, modifiedBody);
    };

    return xhr;
  }

  PatchedXHR.prototype = _XHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ── FETCH OVERRIDE ────────────────────────────────────────────────────────
  // Angular primarily uses XHR, but kept here for completeness in case other
  // code paths use the Fetch API.
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!shouldIntercept(url)) return _fetch(input, init);

    const state = loadState();
    if (CFG.discoveryMode) {
      console.log('[DPL] Fetch intercepted:', url, '— requesting page', state.page);
    }

    let body = (init && init.body) || null;
    if (typeof body === 'string' && body.length > 0) {
      body = injectPagination(body, state.page, state.pageSize);
      init = Object.assign({}, init, { body });
    }

    let response;
    try { response = await _fetch(input, init); }
    catch (e) { throw e; }

    if (!response.ok) return response;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('json')) return response;

    let data;
    try { data = await response.json(); }
    catch (e) { return response; }

    const total = findTotal(data);
    if (CFG.discoveryMode) console.log('[DPL] Fetch — total count detected:', total);
    const prevState = loadState();
    saveState({ page: prevState.page, pageSize: prevState.pageSize, total: total !== null ? total : prevState.total });
    setTimeout(buildUI, 0);

    // Return the response unchanged — the server already sliced the data
    return new Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // ── PAGINATION UI ─────────────────────────────────────────────────────────
  function buildUI() {
    const existing = document.getElementById('mgd-dpl-ui');
    if (existing) existing.remove();

    if (!isOnDealRoute()) return;

    const state      = loadState();
    const page       = state.page;
    const pageSize   = state.pageSize;
    const total      = state.total;
    const totalPages = total !== null ? Math.ceil(total / pageSize) : null;
    const start      = page * pageSize + 1;
    const end        = total !== null ? Math.min((page + 1) * pageSize, total) : (page + 1) * pageSize;
    const atLastPage = totalPages !== null ? page >= totalPages - 1 : false;

    const ui = document.createElement('div');
    ui.id = 'mgd-dpl-ui';
    ui.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px',
      'background:#1a1a2e', 'border:1px solid #0f3460', 'border-radius:8px',
      'padding:8px 14px', 'display:flex', 'align-items:center', 'gap:8px',
      'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:12px', 'color:#e0e0e0', 'box-shadow:0 4px 24px rgba(0,0,0,0.5)',
      'user-select:none',
    ].join(';');

    function btn(label, disabled, onClick) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'background:#0f3460', 'color:#7eb8f7', 'border:1px solid #1a5276',
        'border-radius:4px', 'padding:3px 10px', 'font-size:11px', 'cursor:pointer',
        'font-family:inherit', 'white-space:nowrap',
        disabled ? 'opacity:0.35;cursor:default' : '',
      ].join(';');
      if (!disabled) b.addEventListener('click', onClick);
      return b;
    }

    function txt(content, color) {
      const s = document.createElement('span');
      s.textContent = content;
      s.style.color = color || '#888';
      s.style.whiteSpace = 'nowrap';
      return s;
    }

    const rangeLabel = total !== null
      ? start + '–' + end + ' of ' + total + ' deals'
      : 'Page ' + (page + 1) + ' — loading total…';
    const pageLabel = totalPages !== null
      ? 'Page ' + (page + 1) + ' / ' + totalPages
      : 'Page ' + (page + 1);

    ui.appendChild(btn('← Prev', page === 0, function () { goToPage(page - 1); }));
    ui.appendChild(txt(rangeLabel));
    ui.appendChild(txt(pageLabel, '#7eb8f7'));
    ui.appendChild(btn('Next →', atLastPage, function () { goToPage(page + 1); }));

    // ── Page-size selector ──────────────────────────────────────────────────
    const divider1 = document.createElement('span');
    divider1.style.cssText = 'width:1px;height:16px;background:#0f3460;flex-shrink:0';
    ui.appendChild(divider1);

    const sel = document.createElement('select');
    sel.title = 'Deals per page';
    sel.style.cssText = [
      'background:#0f3460', 'color:#7eb8f7', 'border:1px solid #1a5276',
      'border-radius:4px', 'padding:3px 6px', 'font-size:11px', 'cursor:pointer',
      'font-family:inherit',
    ].join(';');
    CFG.pageSizeOptions.forEach(function (n) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n + ' / page';
      if (n === pageSize) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      const newSize = parseInt(sel.value, 10);
      // Changing page size resets to page 0 so we don't land mid-set
      saveState({ page: 0, pageSize: newSize, total: state.total });
      window.location.reload();
    });
    ui.appendChild(sel);

    // ── Divider + Refresh ───────────────────────────────────────────────────
    const divider2 = document.createElement('span');
    divider2.style.cssText = 'width:1px;height:16px;background:#0f3460;flex-shrink:0';
    ui.appendChild(divider2);

    ui.appendChild(btn('↺ Refresh', false, function () {
      clearState();
      window.location.reload();
    }));

    document.body.appendChild(ui);
  }

  function goToPage(newPage) {
    const state = loadState();
    state.page = newPage;
    saveState(state);
    window.location.reload();
  }

  // ── ROUTE WATCHER ─────────────────────────────────────────────────────────
  let _lastPath = '';

  function onRouteChange() {
    const path = window.location.pathname;
    if (path === _lastPath) return;
    _lastPath = path;

    if (isOnDealRoute()) {
      // Give Angular time to mount components before injecting the UI.
      // The UI will also be rebuilt automatically when the XHR load event fires.
      setTimeout(buildUI, 1500);
    } else {
      document.getElementById('mgd-dpl-ui')?.remove();
      // Clear page state when leaving deal-entry so the next visit starts at page 0
      if (!path.includes('deal-entry')) clearState();
    }
  }

  ['pushState', 'replaceState'].forEach(function (method) {
    const orig = history[method].bind(history);
    history[method] = function () {
      orig.apply(history, arguments);
      onRouteChange();
    };
  });
  window.addEventListener('popstate', onRouteChange);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(onRouteChange, 500); });
  } else {
    setTimeout(onRouteChange, 500);
  }

})();

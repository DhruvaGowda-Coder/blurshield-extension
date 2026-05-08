// BlurShield — Leak Simulation Mode (leakPreview.js)
// Highlights detected sensitive elements with red outlines instead of blurring,
// so users can see exactly what would be exposed during a screen share.
// All detection is local; nothing leaves the browser.

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────
  const LP_PANEL_ID      = 'bs-lp-panel';
  const LP_STYLE_ID      = 'bs-lp-styles';
  const LP_HIGHLIGHT_CLS = 'bs-lp-highlight';
  const LP_TOOLTIP_CLS   = 'bs-lp-tooltip';
  const LP_ATTR          = 'data-bs-lp';

  // ── State ──────────────────────────────────────────────────────────────
  let lpActive   = false;
  let lpResults  = [];     // [{name, service, severity, count, el}]
  let lpMutObs   = null;
  let lpDebTimer = null;
  let lpLastUrl  = location.href;

  // ── Styles ─────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(LP_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = LP_STYLE_ID;
    s.textContent = `
      /* ── Highlight overlays ──────────────────────────── */
      .${LP_HIGHLIGHT_CLS} {
        outline: 2px solid #ef4444 !important;
        outline-offset: 2px !important;
        background-color: rgba(239,68,68,0.08) !important;
        border-radius: 3px !important;
        position: relative !important;
        cursor: help !important;
        transition: outline-color 0.15s, background-color 0.15s !important;
      }
      .${LP_HIGHLIGHT_CLS}:hover {
        outline-color: #fca5a5 !important;
        background-color: rgba(239,68,68,0.16) !important;
      }

      /* ── Tooltip ─────────────────────────────────────── */
      .${LP_TOOLTIP_CLS} {
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: #1a0a0a;
        color: #fca5a5;
        font-family: 'Segoe UI Variable','Segoe UI',sans-serif;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        padding: 4px 9px;
        border-radius: 6px;
        border: 1px solid rgba(239,68,68,0.4);
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        pointer-events: none;
        z-index: 2147483645;
      }
      .${LP_HIGHLIGHT_CLS}:hover .${LP_TOOLTIP_CLS} { display: block; }

      /* ── Summary panel ───────────────────────────────── */
      #${LP_PANEL_ID} {
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 2147483646;
        width: 240px;
        background: linear-gradient(180deg,#130c0c 0%,#0e0707 100%);
        border: 1px solid rgba(239,68,68,0.35);
        border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03) inset;
        font-family: 'Segoe UI Variable','Segoe UI','Helvetica Neue',sans-serif;
        color: #e4e4f0;
        overflow: hidden;
        animation: bs-lp-in 0.22s cubic-bezier(0.16,1,0.3,1);
      }
      @keyframes bs-lp-in {
        from { transform: translateX(20px) scale(0.95); opacity: 0; }
        to   { transform: none; opacity: 1; }
      }
      #${LP_PANEL_ID} .bs-lp-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 13px 14px 10px;
        border-bottom: 1px solid rgba(239,68,68,0.15);
      }
      #${LP_PANEL_ID} .bs-lp-title {
        flex: 1;
        font-size: 13px;
        font-weight: 700;
        color: #fca5a5;
      }
      #${LP_PANEL_ID} .bs-lp-close {
        background: none;
        border: none;
        color: #6b6b80;
        cursor: pointer;
        font-size: 15px;
        line-height: 1;
        padding: 0 2px;
        transition: color 0.12s;
      }
      #${LP_PANEL_ID} .bs-lp-close:hover { color: #ef4444; }
      #${LP_PANEL_ID} .bs-lp-count {
        padding: 10px 14px 6px;
        font-size: 11px;
        color: #8b8ba6;
      }
      #${LP_PANEL_ID} .bs-lp-count strong {
        font-size: 22px;
        font-weight: 700;
        color: #ef4444;
        font-family: 'Cascadia Mono','Consolas',monospace;
        margin-right: 4px;
      }
      #${LP_PANEL_ID} .bs-lp-list {
        padding: 4px 14px 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 220px;
        overflow-y: auto;
      }
      #${LP_PANEL_ID} .bs-lp-row {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 11px;
        padding: 4px 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      #${LP_PANEL_ID} .bs-lp-row:last-child { border-bottom: none; }
      #${LP_PANEL_ID} .bs-lp-dot {
        width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      }
      #${LP_PANEL_ID} .bs-lp-name { flex: 1; color: #c8c8d8; }
      #${LP_PANEL_ID} .bs-lp-badge {
        font-family: 'Cascadia Mono','Consolas',monospace;
        font-size: 10px;
        color: #5a5a72;
        background: rgba(255,255,255,0.05);
        padding: 1px 6px;
        border-radius: 4px;
      }
      #${LP_PANEL_ID} .bs-lp-footer {
        padding: 8px 14px 13px;
        border-top: 1px solid rgba(255,255,255,0.05);
      }
      #${LP_PANEL_ID} .bs-lp-clear {
        width: 100%;
        background: rgba(239,68,68,0.1);
        border: 1px solid rgba(239,68,68,0.25);
        border-radius: 8px;
        color: #fca5a5;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        padding: 8px;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
      }
      #${LP_PANEL_ID} .bs-lp-clear:hover {
        background: rgba(239,68,68,0.2);
        border-color: rgba(239,68,68,0.5);
      }
      #${LP_PANEL_ID} .bs-lp-empty {
        padding: 20px 14px;
        font-size: 12px;
        color: #5a5a72;
        text-align: center;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Severity dot colour (reuses BS_SEVERITY if available) ──────────────
  function sevColor(severity) {
    const sev = window.BS_SEVERITY?.[severity];
    return sev?.dot || '#8b8ba6';
  }

  // ── Scan DOM for secrets — returns grouped results ─────────────────────
  // Uses the same window.BS_PATTERNS already loaded by patterns.js.
  // Walks text nodes; skips already-blurred elements and our own UI.
  function lpScan() {
    const patterns = (window.BS_PATTERNS || []).filter(p => !p.multiline);
    if (!patterns.length) return [];

    const found = new Map(); // key = pattern id, value = {name, service, severity, count, elements[]}
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const el = node.parentElement;
          if (!el) return NodeFilter.FILTER_REJECT;
          // Skip invisible nodes
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_SKIP;
          // Skip script/style/our own panel UI
          const tag = el.tagName?.toUpperCase();
          if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA'].includes(tag)) return NodeFilter.FILTER_REJECT;
          if (el.closest(`#${LP_PANEL_ID}`)) return NodeFilter.FILTER_REJECT;
          // NOTE: we intentionally include elements that are already blurred (.bs-blur / data-bs-processed)
          // so that leakPreview shows ALL secrets — including ones BlurShield is actively hiding.
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      if (text.length < 6) continue;
      const el   = node.parentElement;

      for (const pat of patterns) {
        pat.pattern.lastIndex = 0;
        const m = pat.pattern.exec(text);
        pat.pattern.lastIndex = 0;
        if (!m) continue;

        const key = pat.id;
        if (!found.has(key)) {
          found.set(key, { name: pat.name, service: pat.service, severity: pat.severity, count: 0, elements: [] });
        }
        const entry = found.get(key);
        entry.count++;
        // Avoid adding the same element twice for the same pattern
        if (!entry.elements.includes(el)) entry.elements.push(el);
      }
    }

    return [...found.values()];
  }

  // ── Highlight a single element ─────────────────────────────────────────
  function highlightElement(el, name, severity) {
    if (el.hasAttribute(LP_ATTR)) return; // already highlighted
    el.setAttribute(LP_ATTR, '1');
    el.classList.add(LP_HIGHLIGHT_CLS);

    // Inject tooltip — only if there isn't one yet
    if (!el.querySelector(`.${LP_TOOLTIP_CLS}`)) {
      const tip = document.createElement('span');
      tip.className = LP_TOOLTIP_CLS;
      tip.style.cssText = `border-left: 3px solid ${sevColor(severity)};`;
      tip.textContent = `⚠ ${name}`;
      el.appendChild(tip);
    }
  }

  // ── Remove all highlights ───────────────────────────────────────────────
  function removeHighlights() {
    document.querySelectorAll(`.${LP_HIGHLIGHT_CLS}`).forEach(el => {
      el.classList.remove(LP_HIGHLIGHT_CLS);
      el.removeAttribute(LP_ATTR);
      el.querySelector(`.${LP_TOOLTIP_CLS}`)?.remove();
    });
  }

  // ── Build & show summary panel ──────────────────────────────────────────
  function showPanel(results) {
    removePanel();
    ensureStyles();

    const total = results.reduce((s, r) => s + r.count, 0);
    const panel = document.createElement('div');
    panel.id = LP_PANEL_ID;

    if (total === 0) {
      panel.innerHTML = `
        <div class="bs-lp-header" style="justify-content:center; padding-bottom:0; border-bottom:none;">
          <div class="bs-lp-title" style="color:#22c55e">✅ Safe: No Risk Found</div>
          <button class="bs-lp-close" id="bs-lp-close-btn" style="position:absolute; right:16px" title="Close">✕</button>
        </div>
        <div style="font-size:13px; color:#a1a1b5; padding-top:4px; text-align:center; padding-bottom:10px;">
          Your screen is completely safe to share right now.
        </div>
      `;
      (document.body || document.documentElement).appendChild(panel);
      panel.querySelector('#bs-lp-close-btn')?.addEventListener('click', clearLeakPreview);
      setTimeout(() => { if (lpActive && document.getElementById(LP_PANEL_ID)) clearLeakPreview(); }, 4000);
      return;
    }

    const listHtml = results.map(r => `
          <div class="bs-lp-row">
            <div class="bs-lp-dot" style="background:${sevColor(r.severity)}"></div>
            <div class="bs-lp-name">${escHtml(r.name)}</div>
            <div class="bs-lp-badge">×${r.count}</div>
          </div>`).join('');

    panel.innerHTML = `
      <div class="bs-lp-header">
        <div class="bs-lp-title">⚠️ Risk Preview</div>
        <button class="bs-lp-close" id="bs-lp-close-btn" title="Clear preview">✕</button>
      </div>
      <div class="bs-lp-count"><strong>${total}</strong> ${total === 1 ? 'secret' : 'secrets'} exposed</div>
      <div class="bs-lp-list">${listHtml}</div>
      <div class="bs-lp-footer">
        <button class="bs-lp-clear" id="bs-lp-clear-btn">✕ Clear Preview</button>
      </div>
    `;

    (document.body || document.documentElement).appendChild(panel);

    panel.querySelector('#bs-lp-close-btn')?.addEventListener('click', clearLeakPreview);
    panel.querySelector('#bs-lp-clear-btn')?.addEventListener('click', clearLeakPreview);
  }

  function removePanel() {
    document.getElementById(LP_PANEL_ID)?.remove();
  }

  // ── Escape HTML for panel content ──────────────────────────────────────
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Main: enter leak preview mode ─────────────────────────────────────
  function enterLeakPreview() {
    if (lpActive) clearLeakPreview(); // reset if already on
    ensureStyles();

    lpResults = lpScan();
    lpActive  = true;

    // Apply highlights
    for (const result of lpResults) {
      for (const el of result.elements) {
        highlightElement(el, result.name, result.severity);
      }
    }

    showPanel(lpResults);
    watchForChanges();
  }

  // ── Clear everything ───────────────────────────────────────────────────
  function clearLeakPreview() {
    lpActive = false;
    removeHighlights();
    removePanel();
    stopWatching();
    lpResults = [];
    lpLastUrl = '';
  }

  function lpStop() {
    clearLeakPreview();
  }

  // ── MutationObserver — handle SPA re-renders ───────────────────────────
  // Re-runs highlight (using cache) when DOM changes significantly
  function watchForChanges() {
    if (lpMutObs) return;
    lpMutObs = new MutationObserver(() => {
      if (!lpActive) { stopWatching(); return; }

      // URL change = SPA navigation → clear stale highlights
      if (location.href !== lpLastUrl) {
        lpLastUrl = location.href;
        clearLeakPreview();
        return;
      }

      // Debounce re-highlight on DOM mutations
      clearTimeout(lpDebTimer);
      lpDebTimer = setTimeout(() => {
        if (!lpActive) return;
        removeHighlights();
        lpResults = lpScan();
        for (const result of lpResults) {
          for (const el of result.elements) {
            highlightElement(el, result.name, result.severity);
          }
        }
        showPanel(lpResults);
      }, 600);
    });

    lpMutObs.observe(document.body, { childList: true, subtree: true });
  }

  function stopWatching() {
    lpMutObs?.disconnect();
    lpMutObs = null;
    clearTimeout(lpDebTimer);
  }

  // ── Message listener ──────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.action === 'leakPreview') {
      enterLeakPreview();
      respond({ ok: true, count: lpResults.reduce((s, r) => s + r.count, 0) });
      return true;
    }
    if (msg.action === 'clearLeakPreview') {
      clearLeakPreview();
      respond({ ok: true });
      return true;
    }
    if (msg.action === 'toggle') {
      // If BlurShield is being turned off, clear the leak preview
      if (msg.enabled === false && lpActive) {
        lpStop();
      }
      return false;
    }
    if (msg.action === 'keyboard-toggle') {
      if (msg.enabled === false && lpActive) {
        lpStop();
      }
      return false;
    }
  });
})();

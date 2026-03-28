(() => {
  'use strict';

  if (window.top !== window) return;
  if (window.__BS_PRECHECK_INTERCEPT_LOADED__) return;
  window.__BS_PRECHECK_INTERCEPT_LOADED__ = true;

  // ── Trusted Types safe HTML helper ────────────────────────────────────
  // Some sites (e.g. Google AI Studio) enforce a Trusted Types CSP that blocks
  // direct innerHTML assignments. Since intercept.js runs in the MAIN world,
  // it is subject to the page's CSP. We create a TT policy to allow our HTML.
  let _bsTrustedPolicy = null;
  function safeSetHTML(element, html) {
    try {
      // Try direct assignment first (works on most sites)
      element.innerHTML = html;
    } catch {
      // Trusted Types enforcement — create a policy if we haven't yet
      if (!_bsTrustedPolicy) {
        try {
          _bsTrustedPolicy = window.trustedTypes?.createPolicy?.('blurshield-intercept', {
            createHTML: (s) => s
          });
        } catch {
          // Policy creation may also fail if max policies exceeded — fall back to DOM parsing
          _bsTrustedPolicy = null;
        }
      }
      if (_bsTrustedPolicy) {
        element.innerHTML = _bsTrustedPolicy.createHTML(html);
      } else {
        // Last resort: use DOMParser to safely create the HTML
        const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        element.textContent = '';
        while (doc.body.firstChild) {
          element.appendChild(document.adoptNode(doc.body.firstChild));
        }
      }
    }
  }

  /** Escape user-supplied strings before embedding in HTML templates. */
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Message relay helpers ────────────────────────────────────────────
  // intercept.js runs in the MAIN world and has NO access to chrome.runtime.
  // All messages to the extension are sent via window.postMessage and relayed
  // by the content script (which runs in the ISOLATED world and has API access).

  let _msgId = 0;
  const _pendingCallbacks = new Map();

  /**
   * Send a message to the extension background script via the content script relay.
   * Returns a Promise that resolves with the background's response.
   */
  function sendToExtension(payload) {
    return new Promise((resolve) => {
      const id = `bs-intercept-${++_msgId}-${Date.now()}`;
      _pendingCallbacks.set(id, resolve);

      // Timeout: if content script is missing or slow, resolve with empty obj
      setTimeout(() => {
        if (_pendingCallbacks.has(id)) {
          _pendingCallbacks.delete(id);
          resolve({});
        }
      }, 15000);

      window.postMessage({
        source: 'blurshield-intercept',
        id,
        payload
      }, '*');
    });
  }

  /**
   * Send a fire-and-forget message (no response needed).
   */
  function fireToExtension(payload) {
    window.postMessage({
      source: 'blurshield-intercept',
      id: null,
      payload
    }, '*');
  }

  // Listen for responses relayed back from the content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'blurshield-content-response') return;
    const { id, response } = event.data;
    if (id && _pendingCallbacks.has(id)) {
      _pendingCallbacks.get(id)(response);
      _pendingCallbacks.delete(id);
    }
  });

  // Listen for manual trigger from popup → content.js → here
  // This lets users trigger the pre-meeting scan from the popup button on any page
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'blurshield-content-trigger') return;
    if (event.data?.action === 'triggerMeetingScan') {
      // Reset the fired flag so it always runs when manually triggered
      _meetingScanFired = false;
      runMeetingPreScan(event.data?.platformName || getCurrentMeetingPlatform() || 'All Platforms');
    }
  });

  // ── UI constants ─────────────────────────────────────────────────────
  const OVERLAY_ID = 'bs-precheck-overlay';
  const STYLE_ID = 'bs-precheck-style';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID}{
        position:fixed;
        inset:0;
        z-index:2147483647;
        background:rgba(3,6,13,0.82);
        backdrop-filter:blur(6px);
        display:flex;
        align-items:center;
        justify-content:center;
        font-family:'Segoe UI Variable','Segoe UI','Helvetica Neue',sans-serif;
        color:#e4e4f0;
      }
      #${OVERLAY_ID} *{box-sizing:border-box}
      .bs-precheck-card{
        width:min(560px,calc(100vw - 32px));
        background:linear-gradient(180deg,#111118 0%,#0b0b10 100%);
        border:1px solid rgba(239,68,68,0.28);
        border-radius:18px;
        box-shadow:0 22px 70px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.03) inset;
        padding:22px;
      }
      .bs-precheck-header{
        display:flex;
        align-items:center;
        gap:12px;
        margin-bottom:14px;
      }
      .bs-precheck-shield{
        width:38px;
        height:38px;
        border-radius:12px;
        background:rgba(29,158,117,0.14);
        border:1px solid rgba(29,158,117,0.28);
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:18px;
      }
      .bs-precheck-title{
        margin:0;
        font-size:18px;
        font-weight:600;
        color:#fff;
      }
      .bs-precheck-sub{
        margin:3px 0 0;
        font-size:12px;
        color:#8b8ba6;
      }
      .bs-precheck-alert{
        margin:0 0 16px;
        padding:12px 14px;
        border-radius:12px;
        border:1px solid rgba(239,68,68,0.22);
        background:rgba(127,29,29,0.18);
        color:#fca5a5;
        font-size:13px;
        line-height:1.5;
      }
      .bs-precheck-list{
        display:flex;
        flex-direction:column;
        gap:10px;
        margin-bottom:18px;
        max-height:min(48vh,420px);
        overflow:auto;
        padding-right:4px;
      }
      .bs-precheck-row{
        display:flex;
        align-items:flex-start;
        justify-content:space-between;
        gap:14px;
        padding:12px 14px;
        border-radius:14px;
        background:#15151d;
        border:1px solid rgba(255,255,255,0.06);
      }
      .bs-precheck-row-main{
        min-width:0;
      }
      .bs-precheck-row-title{
        font-size:13px;
        font-weight:600;
        color:#f8fafc;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .bs-precheck-row-meta{
        margin-top:4px;
        font-size:11px;
        color:#8b8ba6;
      }
      .bs-precheck-row-reason{
        margin-top:6px;
        font-size:11px;
        color:#c0c0d4;
      }
      .bs-precheck-badges{
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        justify-content:flex-end;
      }
      .bs-precheck-pill{
        border-radius:999px;
        padding:4px 8px;
        font-size:11px;
        font-weight:600;
        white-space:nowrap;
      }
      .bs-precheck-pill--critical{
        background:#300a0a;
        color:#fca5a5;
        border:1px solid #7f1d1d;
      }
      .bs-precheck-pill--high{
        background:#2d1b00;
        color:#fcd34d;
        border:1px solid #78350f;
      }
      .bs-precheck-pill--scan{
        background:#1f2937;
        color:#d1d5db;
        border:1px solid #4b5563;
      }
      .bs-precheck-footer{
        display:flex;
        gap:10px;
      }
      .bs-precheck-btn{
        flex:1;
        border:none;
        border-radius:12px;
        padding:12px 14px;
        cursor:pointer;
        font-size:13px;
        font-weight:600;
        transition:transform 0.12s ease,opacity 0.12s ease;
      }
      .bs-precheck-btn:hover{transform:translateY(-1px)}
      .bs-precheck-btn:active{transform:translateY(0)}
      .bs-precheck-btn--fix{
        background:#1D9E75;
        color:#fff;
      }
      .bs-precheck-btn--continue{
        background:#232330;
        color:#cbd5e1;
        border:1px solid rgba(255,255,255,0.08);
      }
      .bs-precheck-loading{
        display:flex;
        align-items:center;
        gap:12px;
        padding:6px 2px;
      }
      .bs-precheck-spinner{
        width:18px;
        height:18px;
        border-radius:50%;
        border:2px solid rgba(29,158,117,0.18);
        border-top-color:#1D9E75;
        animation:bs-precheck-spin 0.8s linear infinite;
        flex-shrink:0;
      }
      .bs-precheck-loading-copy{
        font-size:13px;
        color:#d1d5db;
      }
      .bs-precheck-loading-note{
        display:block;
        margin-top:4px;
        font-size:11px;
        color:#8b8ba6;
      }
      @keyframes bs-precheck-spin{
        to{transform:rotate(360deg)}
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function getOverlayRoot() {
    return document.body || document.documentElement;
  }

  function escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function el(tag, attrs = {}, children = []) {
    const elem = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'className') elem.className = val;
      else if (key === 'textContent') elem.textContent = val;
      else elem.setAttribute(key, val);
    }
    for (const child of children) {
      if (typeof child === 'string') elem.appendChild(document.createTextNode(child));
      else if (child) elem.appendChild(child);
    }
    return elem;
  }

  function renderLoadingOverlay() {
    ensureStyles();
    removeOverlay();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;

    const shield = el('div', { className: 'bs-precheck-shield', textContent: '🛡' });
    const headerText = el('div', {}, [
      el('h2', { className: 'bs-precheck-title', textContent: 'BlurShield Pre-Recording Check' }),
      el('p', { className: 'bs-precheck-sub', textContent: 'Scanning your open tabs before screen sharing starts' })
    ]);
    const header = el('div', { className: 'bs-precheck-header' }, [shield, headerText]);

    const spinner = el('div', { className: 'bs-precheck-spinner' });
    const loadingNote = el('span', { className: 'bs-precheck-loading-note', textContent: 'This usually finishes in a few seconds.' });
    const loadingCopy = el('div', { className: 'bs-precheck-loading-copy' }, [
      'Checking for exposed secrets across your tabs…',
      loadingNote
    ]);
    const loading = el('div', { className: 'bs-precheck-loading' }, [spinner, loadingCopy]);

    const card = el('div', { className: 'bs-precheck-card' }, [header, loading]);
    overlay.appendChild(card);

    getOverlayRoot()?.appendChild(overlay);
    return overlay;
  }

  function buildIssueRows(issues = []) {
    return issues.map((issue) => {
      const badges = [];
      if (issue.state === 'unscannable') {
        badges.push(el('span', { className: 'bs-precheck-pill bs-precheck-pill--scan', textContent: 'Unable to scan' }));
      } else {
        if (issue.critical) badges.push(el('span', { className: 'bs-precheck-pill bs-precheck-pill--critical', textContent: `${issue.critical} Critical` }));
        if (issue.high) badges.push(el('span', { className: 'bs-precheck-pill bs-precheck-pill--high', textContent: `${issue.high} High` }));
      }

      const titleStr = issue.title || issue.hostname || issue.url || 'Untitled tab';
      const hostStr = issue.hostname || issue.url || '';

      const titleEl = el('div', { className: 'bs-precheck-row-title', textContent: titleStr });
      const metaEl = el('div', { className: 'bs-precheck-row-meta', textContent: hostStr });
      const mainChildren = [titleEl, metaEl];
      
      if (issue.reason) {
        mainChildren.push(el('div', { className: 'bs-precheck-row-reason', textContent: issue.reason }));
      }

      const mainEl = el('div', { className: 'bs-precheck-row-main' }, mainChildren);
      const badgesEl = el('div', { className: 'bs-precheck-badges' }, badges);

      return el('div', { className: 'bs-precheck-row' }, [mainEl, badgesEl]);
    });
  }

  function showPreRecordingChecklist(result) {
    return new Promise((resolve) => {
      ensureStyles();
      removeOverlay();

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;

      const issues = Array.isArray(result?.issues) ? result.issues : [];
      const riskyTabs = Array.isArray(result?.riskyTabs) ? result.riskyTabs : issues.filter((issue) => issue.state === 'exposed');
      const unscannableTabs = Array.isArray(result?.unscannableTabs) ? result.unscannableTabs : issues.filter((issue) => issue.state === 'unscannable');
      const criticalCount = riskyTabs.reduce((sum, issue) => sum + (issue.critical || 0), 0);
      const highCount = riskyTabs.reduce((sum, issue) => sum + (issue.high || 0), 0);

      let alertText = '';
      if (riskyTabs.length) {
        alertText = `Found ${criticalCount} critical and ${highCount} high-risk secret${criticalCount + highCount === 1 ? '' : 's'} across ${riskyTabs.length} tab${riskyTabs.length === 1 ? '' : 's'}.`;
      } else if (unscannableTabs.length) {
        alertText = `BlurShield could not scan ${unscannableTabs.length} tab${unscannableTabs.length === 1 ? '' : 's'} before recording starts.`;
      } else {
        alertText = result?.error || 'BlurShield could not finish the pre-recording check.';
      }

      const shield = el('div', { className: 'bs-precheck-shield', textContent: '🛡' });
      const headerText = el('div', {}, [
        el('h2', { className: 'bs-precheck-title', id: 'bs-precheck-title', textContent: 'BlurShield Pre-Recording Check' }),
        el('p', { className: 'bs-precheck-sub', textContent: 'Review the tabs below before your recording continues' })
      ]);
      const header = el('div', { className: 'bs-precheck-header' }, [shield, headerText]);

      const alertEl = el('p', { className: 'bs-precheck-alert', textContent: alertText });
      const listEl = el('div', { className: 'bs-precheck-list' }, buildIssueRows(issues));

      const fixBtn = el('button', { type: 'button', className: 'bs-precheck-btn bs-precheck-btn--fix', id: 'bs-precheck-fix', textContent: 'Fix Issues First' });
      const contBtn = el('button', { type: 'button', className: 'bs-precheck-btn bs-precheck-btn--continue', id: 'bs-precheck-continue', textContent: 'Continue Anyway' });
      const footer = el('div', { className: 'bs-precheck-footer' }, [fixBtn, contBtn]);

      const card = el('div', { 
        className: 'bs-precheck-card', 
        role: 'dialog', 
        'aria-modal': 'true', 
        'aria-labelledby': 'bs-precheck-title' 
      }, [header, alertEl, listEl, footer]);

      overlay.appendChild(card);

      const cleanup = (approved) => {
        window.removeEventListener('keydown', handleKeydown, true);
        overlay.remove();
        resolve(approved);
      };

      const handleKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(false);
        }
      };

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) cleanup(false);
      });

      overlay.querySelector('#bs-precheck-fix')?.addEventListener('click', async () => {
        const firstIssue = riskyTabs[0] || unscannableTabs[0];
        
        // Let the user know exactly why the screenshare was cancelled via system notification
        fireToExtension({ 
          action: 'notifyScreenshareBlocked', 
          message: 'Screen share blocked. Please resolve the detected secrets on this tab.' 
        });

        if (firstIssue?.tabId) {
          // Use relay instead of chrome.runtime.sendMessage
          await sendToExtension({ action: 'openIssueTab', tabId: firstIssue.tabId });
        }
        cleanup(false);
      });

      overlay.querySelector('#bs-precheck-continue')?.addEventListener('click', () => cleanup(true));
      window.addEventListener('keydown', handleKeydown, true);

      getOverlayRoot()?.appendChild(overlay);
    });
  }

  async function legacyRunPreRecordingCheck() {
    const loadingOverlay = renderLoadingOverlay();

    try {
      // Use relay instead of chrome.runtime.sendMessage
      const result = await sendToExtension({ action: 'preRecordingCheck' });
      
      if (!result?.hasIssues) {
        // Show success state briefly before removing
        const textEl = loadingOverlay.querySelector('.bs-precheck-loading-copy');
        const spinner = loadingOverlay.querySelector('.bs-precheck-spinner');
        if (textEl && spinner) {
          spinner.style.display = 'none';
          textEl.textContent = '';
          textEl.appendChild(el('span', { style: 'color:#22c55e; font-weight:600; display:flex; align-items:center; gap:8px;' }, [
            el('span', { style: 'font-size:16px;', textContent: '✓' }),
            ' All tabs are secure. Starting screen share...'
          ]));
        }
        await new Promise(r => setTimeout(r, 1500));
        loadingOverlay.remove();
        return true;
      }
      
      loadingOverlay.remove();
      return await showPreRecordingChecklist(result);
    } catch {
      loadingOverlay.remove();
      return await showPreRecordingChecklist({
        hasIssues: true,
        issues: [{
          title: 'Pre-recording check unavailable',
          hostname: 'BlurShield',
          state: 'unscannable',
          reason: 'BlurShield could not complete the tab scan. Continue only if you have manually verified your screen.'
        }],
        riskyTabs: [],
        unscannableTabs: [{
          title: 'Pre-recording check unavailable',
          hostname: 'BlurShield',
          state: 'unscannable',
          reason: 'BlurShield could not complete the tab scan. Continue only if you have manually verified your screen.'
        }]
      });
    }
  }

  async function runPreRecordingCheck() {
    const loadingOverlay = renderLoadingOverlay();
    const unavailableResult = {
      hasIssues: true,
      issues: [{
        title: 'Pre-recording check unavailable',
        hostname: 'BlurShield',
        state: 'unscannable',
        reason: 'BlurShield could not complete the tab scan. Continue only if you have manually verified your screen.'
      }],
      riskyTabs: [],
      unscannableTabs: [{
        title: 'Pre-recording check unavailable',
        hostname: 'BlurShield',
        state: 'unscannable',
        reason: 'BlurShield could not complete the tab scan. Continue only if you have manually verified your screen.'
      }]
    };

    try {
      const result = await sendToExtension({ action: 'preRecordingCheck' });
      if (!isValidPrecheckResult(result)) {
        throw new Error('BlurShield did not receive a valid pre-recording scan response');
      }

      if (!result.hasIssues) {
        const textEl = loadingOverlay.querySelector('.bs-precheck-loading-copy');
        const spinner = loadingOverlay.querySelector('.bs-precheck-spinner');
        if (textEl && spinner) {
          spinner.style.display = 'none';
          textEl.textContent = '';
          textEl.appendChild(el('span', { style: 'color:#22c55e; font-weight:600; display:flex; align-items:center; gap:8px;' }, [
            el('span', { style: 'font-size:16px;', textContent: 'âœ“' }),
            ' All tabs are secure. Starting screen share...'
          ]));
        }
        await new Promise(r => setTimeout(r, 1500));
        loadingOverlay.remove();
        return true;
      }

      loadingOverlay.remove();
      return await showPreRecordingChecklist(result);
    } catch {
      loadingOverlay.remove();
      return await showPreRecordingChecklist(unavailableResult);
    }
  }

  async function notifyRecordingState(state, sessionId) {
    // Fire-and-forget via relay (no response needed)
    fireToExtension({ action: 'recordingStateChange', state, sessionId });
  }

  const mediaDevices = navigator.mediaDevices;
  const originalGetDisplayMedia = mediaDevices?.getDisplayMedia?.bind(mediaDevices);
  if (!originalGetDisplayMedia) return;

  mediaDevices.getDisplayMedia = async function(...args) {
    // 1. Call the original API *immediately* to preserve the "user gesture" context.
    // If we await our preRecordingCheck first, the browser throws an error because
    // getDisplayMedia must be called synchronously after a user interaction (like a click).
    const stream = await originalGetDisplayMedia(...args);

    // 2. Now run the pre-recording check while the app waits for the stream.
    const approved = await runPreRecordingCheck();
    
    // 3. If BlurShield blocks it or the user cancels, stop the capture entirely.
    if (!approved) {
      stream.getTracks().forEach(track => track.stop());
      throw new DOMException('Screen capture cancelled by BlurShield', 'NotAllowedError');
    }

    // 4. Everything is safe! Hand the stream over to the app (e.g., Google Meet).
    const sessionId = `bs-rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await notifyRecordingState('started', sessionId);

    const tracks = stream.getTracks();
    const handleEnded = () => {
      tracks.forEach(track => track.removeEventListener('ended', handleEnded));
      notifyRecordingState('stopped', sessionId);
    };

    tracks.forEach(track => track.addEventListener('ended', handleEnded, { once: true }));
    return stream;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // PRE-MEETING SCAN — Hero Feature
  // Automatically fires when user navigates to Zoom / Google Meet / Teams.
  // Scans all open tabs for exposed secrets BEFORE the meeting starts.
  // ══════════════════════════════════════════════════════════════════════════

  const MEETING_DOMAINS = [
    { name: 'Zoom',         patterns: ['zoom.us/j/', 'zoom.us/wc/', 'zoom.us/my/'] },
    { name: 'Google Meet',  patterns: ['meet.google.com/'] },
    { name: 'Microsoft Teams', patterns: ['teams.microsoft.com/l/meetup', 'teams.live.com/meet/'] },
    { name: 'Webex',        patterns: ['webex.com/meet', 'webex.com/join'] },
    { name: 'Whereby',      patterns: ['whereby.com/'] },
  ];

  const MEETING_STYLE_ID = 'bs-meeting-scan-style';
  const MEETING_OVERLAY_ID = 'bs-meeting-scan-overlay';
  let _meetingScanFired = false;

  function getCurrentMeetingPlatform() {
    const url = location.href;
    for (const platform of MEETING_DOMAINS) {
      if (platform.patterns.some(p => url.includes(p))) return platform.name;
    }
    return null;
  }

  function ensureMeetingStyles() {
    if (document.getElementById(MEETING_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = MEETING_STYLE_ID;
    style.textContent = `
      #${MEETING_OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: rgba(3, 6, 13, 0.88);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Segoe UI Variable', 'Segoe UI', 'Helvetica Neue', sans-serif;
        color: #e4e4f0;
        animation: bs-meeting-fade-in 0.3s ease;
      }
      @keyframes bs-meeting-fade-in {
        from { opacity: 0; backdrop-filter: blur(0px); }
        to   { opacity: 1; backdrop-filter: blur(8px); }
      }
      #${MEETING_OVERLAY_ID} * { box-sizing: border-box; }

      .bs-meeting-card {
        width: min(580px, calc(100vw - 24px));
        background: linear-gradient(160deg, #12121c 0%, #0b0b10 100%);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 20px;
        box-shadow: 0 32px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.03) inset;
        overflow: hidden;
        animation: bs-meeting-card-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes bs-meeting-card-in {
        from { transform: translateY(24px) scale(0.96); opacity: 0; }
        to   { transform: translateY(0) scale(1); opacity: 1; }
      }

      /* Hero header */
      .bs-meeting-hero {
        padding: 24px 24px 20px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: linear-gradient(135deg, rgba(29,158,117,0.08) 0%, transparent 60%);
      }
      .bs-meeting-platform-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
      }
      .bs-meeting-icon {
        width: 40px;
        height: 40px;
        border-radius: 12px;
        background: rgba(29,158,117,0.15);
        border: 1px solid rgba(29,158,117,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        flex-shrink: 0;
      }
      .bs-meeting-platform-label {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #1D9E75;
        margin-bottom: 2px;
      }
      .bs-meeting-headline {
        font-size: 18px;
        font-weight: 700;
        color: #fff;
        line-height: 1.2;
      }
      .bs-meeting-subline {
        font-size: 13px;
        color: #8b8ba6;
        margin-top: 4px;
        line-height: 1.5;
      }

      /* Scanning state */
      .bs-meeting-scanning {
        padding: 28px 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        text-align: center;
      }
      .bs-meeting-scan-rings {
        position: relative;
        width: 56px;
        height: 56px;
        flex-shrink: 0;
      }
      .bs-meeting-scan-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid transparent;
        border-top-color: #1D9E75;
        animation: bs-scan-spin 1s linear infinite;
      }
      .bs-meeting-scan-ring:nth-child(2) {
        inset: 8px;
        border-top-color: rgba(29,158,117,0.4);
        animation-duration: 1.6s;
        animation-direction: reverse;
      }
      .bs-meeting-scan-ring:nth-child(3) {
        inset: 16px;
        border-top-color: rgba(29,158,117,0.2);
        animation-duration: 2.2s;
      }
      @keyframes bs-scan-spin { to { transform: rotate(360deg); } }
      .bs-meeting-scanning-title {
        font-size: 15px;
        font-weight: 600;
        color: #fff;
      }
      .bs-meeting-scanning-sub {
        font-size: 12px;
        color: #8b8ba6;
        line-height: 1.5;
        max-width: 320px;
      }
      .bs-meeting-scan-tabs-counter {
        font-size: 11px;
        color: #1D9E75;
        font-weight: 600;
      }

      /* Results body */
      .bs-meeting-body {
        padding: 0 24px 20px;
        max-height: min(45vh, 360px);
        overflow-y: auto;
      }
      .bs-meeting-status-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 16px 0 14px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        margin-bottom: 14px;
      }
      .bs-meeting-status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .bs-meeting-status-dot--ok   { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.5); }
      .bs-meeting-status-dot--warn { background: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,0.5); }
      .bs-meeting-status-text {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
      }
      .bs-meeting-status-sub {
        font-size: 11px;
        color: #8b8ba6;
        margin-top: 2px;
      }
      .bs-meeting-tab-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 11px 14px;
        border-radius: 12px;
        background: #15151d;
        border: 1px solid rgba(255,255,255,0.05);
        margin-bottom: 8px;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
      }
      .bs-meeting-tab-row:hover {
        border-color: rgba(239,68,68,0.3);
        background: #1a151d;
      }
      .bs-meeting-tab-title {
        font-size: 13px;
        font-weight: 600;
        color: #f1f1f5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 280px;
      }
      .bs-meeting-tab-host {
        font-size: 11px;
        color: #5a5a72;
        margin-top: 2px;
      }
      .bs-meeting-tab-badges {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
        justify-content: flex-end;
        flex-shrink: 0;
      }
      .bs-meeting-pill {
        font-size: 10px;
        font-weight: 700;
        padding: 3px 8px;
        border-radius: 999px;
        white-space: nowrap;
      }
      .bs-meeting-pill--crit { background: #300a0a; color: #fca5a5; border: 1px solid #7f1d1d; }
      .bs-meeting-pill--high { background: #2d1b00; color: #fcd34d; border: 1px solid #78350f; }
      .bs-meeting-pill--scan { background: #1f2937; color: #9ca3af; border: 1px solid #374151; }

      /* All-clear state */
      .bs-meeting-allclear {
        padding: 28px 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        text-align: center;
      }
      .bs-meeting-allclear-icon {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: rgba(34,197,94,0.12);
        border: 2px solid rgba(34,197,94,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 24px;
        animation: bs-allclear-pop 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes bs-allclear-pop {
        from { transform: scale(0.5); opacity: 0; }
        to   { transform: scale(1);   opacity: 1; }
      }
      .bs-meeting-allclear-title {
        font-size: 16px;
        font-weight: 700;
        color: #22c55e;
      }
      .bs-meeting-allclear-sub {
        font-size: 12px;
        color: #8b8ba6;
        line-height: 1.5;
      }

      /* Footer */
      .bs-meeting-footer {
        padding: 16px 24px 20px;
        display: flex;
        gap: 10px;
        border-top: 1px solid rgba(255,255,255,0.05);
      }
      .bs-meeting-btn {
        flex: 1;
        border: none;
        border-radius: 12px;
        padding: 12px 16px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        font-family: inherit;
        transition: transform 0.12s ease, opacity 0.12s ease;
      }
      .bs-meeting-btn:hover  { transform: translateY(-1px); }
      .bs-meeting-btn:active { transform: translateY(0); }
      .bs-meeting-btn--fix {
        background: #ef4444;
        color: #fff;
      }
      .bs-meeting-btn--fix-ok {
        background: #1D9E75;
        color: #fff;
      }
      .bs-meeting-btn--skip {
        background: #1e1e2e;
        color: #94a3b8;
        border: 1px solid rgba(255,255,255,0.07);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeMeetingOverlay() {
    document.getElementById(MEETING_OVERLAY_ID)?.remove();
  }

  function isValidPrecheckResult(result) {
    return !!result &&
      typeof result === 'object' &&
      Array.isArray(result.issues) &&
      Array.isArray(result.riskyTabs) &&
      Array.isArray(result.unscannableTabs);
  }

  function showMeetingScanning(platformName) {
    ensureMeetingStyles();
    removeMeetingOverlay();

    const overlay = document.createElement('div');
    overlay.id = MEETING_OVERLAY_ID;

    safeSetHTML(overlay, `
      <div class="bs-meeting-card">
        <div class="bs-meeting-hero">
          <div class="bs-meeting-platform-row">
            <div class="bs-meeting-icon">🎥</div>
            <div>
              <div class="bs-meeting-platform-label">${platformName === 'All Platforms' ? 'Manual scan' : platformName + ' detected'}</div>
              <div class="bs-meeting-headline">Pre-Meeting Security Scan</div>
            </div>
          </div>
          <div class="bs-meeting-subline">BlurShield is checking your open tabs for exposed API keys, passwords, and secrets before your meeting starts.</div>
        </div>
        <div class="bs-meeting-scanning" id="bs-meeting-scanning-body">
          <div class="bs-meeting-scan-rings">
            <div class="bs-meeting-scan-ring"></div>
            <div class="bs-meeting-scan-ring"></div>
            <div class="bs-meeting-scan-ring"></div>
          </div>
          <div class="bs-meeting-scanning-title">Scanning all open tabs…</div>
          <div class="bs-meeting-scanning-sub">Checking for API keys, tokens, passwords, and PII that could be exposed during screen sharing.</div>
          <div class="bs-meeting-scan-tabs-counter" id="bs-scan-counter">This takes just a moment</div>
        </div>
      </div>
    `);

    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function showMeetingResults(overlay, result, platformName) {
    const card = overlay.querySelector('.bs-meeting-card');
    if (!card) return;

    const issues = Array.isArray(result?.riskyTabs) ? result.riskyTabs : [];
    const hasIssues = issues.length > 0;
    const hasError = typeof result?.error === 'string' && !!result.error.trim();
    const totalSecrets = issues.reduce((s, t) => s + (t.count || 0), 0);
    const critTotal   = issues.reduce((s, t) => s + (t.critical || 0), 0);
    const highTotal   = issues.reduce((s, t) => s + (t.high || 0), 0);

    // Replace scanning body
    const body = card.querySelector('#bs-meeting-scanning-body');
    if (body) body.remove();
    const hero = card.querySelector('.bs-meeting-hero');

    if (hasError && !hasIssues) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'bs-meeting-body';

      const statusRow = document.createElement('div');
      statusRow.className = 'bs-meeting-status-row';
      safeSetHTML(statusRow, `
        <div class="bs-meeting-status-dot bs-meeting-status-dot--warn"></div>
        <div>
          <div class="bs-meeting-status-text">Scan unavailable before ${escapeHtml(platformName)}</div>
          <div class="bs-meeting-status-sub">${escapeHtml(result.error)}</div>
        </div>
      `);
      bodyEl.appendChild(statusRow);
      hero.after(bodyEl);

      const footer = document.createElement('div');
      footer.className = 'bs-meeting-footer';
      safeSetHTML(footer, `
        <button class="bs-meeting-btn bs-meeting-btn--fix-ok" id="bs-meeting-retry">Try Again</button>
        <button class="bs-meeting-btn bs-meeting-btn--skip" id="bs-meeting-close">Close</button>
      `);
      bodyEl.after(footer);

      footer.querySelector('#bs-meeting-retry')?.addEventListener('click', () => {
        runMeetingPreScan(platformName);
      });
      footer.querySelector('#bs-meeting-close')?.addEventListener('click', () => {
        removeMeetingOverlay();
      });

      overlay.addEventListener('click', e => { if (e.target === overlay) removeMeetingOverlay(); });
      return;
    }

    if (!hasIssues) {
      // All clear
      const allClear = document.createElement('div');
      allClear.className = 'bs-meeting-allclear';
      safeSetHTML(allClear, `
        <div class="bs-meeting-allclear-icon">✓</div>
        <div class="bs-meeting-allclear-title">All clear — safe to share your screen</div>
        <div class="bs-meeting-allclear-sub">No exposed secrets found across your ${result?.issues?.length ? 'scanned ' : ''}tabs.<br>You can proceed with your meeting safely.</div>
      `);
      hero.after(allClear);

      const footer = document.createElement('div');
      footer.className = 'bs-meeting-footer';
      safeSetHTML(footer, `<button class="bs-meeting-btn bs-meeting-btn--fix-ok" id="bs-meeting-join">✓ Join Meeting</button>`);
      allClear.after(footer);

      footer.querySelector('#bs-meeting-join')?.addEventListener('click', () => {
        removeMeetingOverlay();
      });

      // Auto-dismiss after 3 seconds
      setTimeout(() => removeMeetingOverlay(), 3000);
      return;
    }

    // Issues found
    const bodyEl = document.createElement('div');
    bodyEl.className = 'bs-meeting-body';

    const statusRow = document.createElement('div');
    statusRow.className = 'bs-meeting-status-row';
    safeSetHTML(statusRow, `
      <div class="bs-meeting-status-dot bs-meeting-status-dot--warn"></div>
      <div>
        <div class="bs-meeting-status-text">⚠ ${totalSecrets} secret${totalSecrets !== 1 ? 's' : ''} exposed across ${issues.length} tab${issues.length !== 1 ? 's' : ''}</div>
        <div class="bs-meeting-status-sub">These could be visible if you share your screen during ${escapeHtml(platformName)}</div>
      </div>
    `);
    bodyEl.appendChild(statusRow);

    issues.forEach(tab => {
      const row = document.createElement('div');
      row.className = 'bs-meeting-tab-row';
      row.title = 'Click to switch to this tab and fix issues';
      const critPill = tab.critical ? `<span class="bs-meeting-pill bs-meeting-pill--crit">${tab.critical} Critical</span>` : '';
      const highPill = tab.high     ? `<span class="bs-meeting-pill bs-meeting-pill--high">${tab.high} High</span>` : '';
      safeSetHTML(row, `
        <div>
          <div class="bs-meeting-tab-title">${escapeHtml(tab.title || tab.hostname || 'Untitled tab')}</div>
          <div class="bs-meeting-tab-host">${escapeHtml(tab.hostname || '')}</div>
        </div>
        <div class="bs-meeting-tab-badges">${critPill}${highPill}</div>
      `);
      row.addEventListener('click', async () => {
        if (tab.tabId) await sendToExtension({ action: 'openIssueTab', tabId: tab.tabId });
        removeMeetingOverlay();
      });
      bodyEl.appendChild(row);
    });

    hero.after(bodyEl);

    const footer = document.createElement('div');
    footer.className = 'bs-meeting-footer';
    safeSetHTML(footer, `
      <button class="bs-meeting-btn bs-meeting-btn--fix" id="bs-meeting-fix">Fix ${issues.length} Tab${issues.length !== 1 ? 's' : ''} First</button>
      <button class="bs-meeting-btn bs-meeting-btn--skip" id="bs-meeting-skip">Join Anyway</button>
    `);
    bodyEl.after(footer);

    footer.querySelector('#bs-meeting-fix')?.addEventListener('click', async () => {
      const firstTab = issues[0];
      if (firstTab?.tabId) await sendToExtension({ action: 'openIssueTab', tabId: firstTab.tabId });
      removeMeetingOverlay();
    });

    footer.querySelector('#bs-meeting-skip')?.addEventListener('click', () => {
      removeMeetingOverlay();
    });

    overlay.addEventListener('click', e => { if (e.target === overlay) removeMeetingOverlay(); });
  }

  async function legacyRunMeetingPreScan(platformName) {
    const overlay = showMeetingScanning(platformName);

    try {
      // Animate counter while scanning
      let tabCount = 0;
      const counter = overlay.querySelector('#bs-scan-counter');
      const ticker = setInterval(() => {
        tabCount++;
        if (counter) counter.textContent = `Checked ${tabCount} tab${tabCount !== 1 ? 's' : ''}…`;
      }, 180);

      const result = await sendToExtension({ action: 'preRecordingCheck' });
      clearInterval(ticker);

      // Small pause so user sees the scan completing
      await new Promise(r => setTimeout(r, 400));
      showMeetingResults(overlay, result, platformName);
    } catch (err) {
      // On failure show safe fallback
      showMeetingResults(overlay, { hasIssues: false, riskyTabs: [], issues: [] }, platformName);
    }
  }

  async function legacyRunMeetingPreScanV2(platformName) {
    const overlay = showMeetingScanning(platformName);
    let ticker = null;

    try {
      let tabCount = 0;
      const counter = overlay.querySelector('#bs-scan-counter');
      ticker = setInterval(() => {
        tabCount++;
        if (counter) counter.textContent = `Checked ${tabCount} tab${tabCount !== 1 ? 's' : ''}â€¦`;
      }, 180);

      const result = await sendToExtension({ action: 'preRecordingCheck' });
      clearInterval(ticker);
      ticker = null;

      if (!isValidPrecheckResult(result)) {
        throw new Error('BlurShield did not receive a valid pre-meeting scan response');
      }

      await new Promise(r => setTimeout(r, 400));
      showMeetingResults(overlay, result, platformName);
    } catch {
      if (ticker) clearInterval(ticker);
      showMeetingResults(overlay, {
        hasIssues: false,
        issues: [],
        riskyTabs: [],
        unscannableTabs: [],
        error: 'BlurShield could not complete the pre-meeting scan. Refresh the meeting tab and try again before you share your screen.'
      }, platformName);
    }
  }

  async function runMeetingPreScan(platformName) {
    const overlay = showMeetingScanning(platformName);
    let ticker = null;

    try {
      let tabCount = 0;
      const counter = overlay.querySelector('#bs-scan-counter');
      ticker = setInterval(() => {
        tabCount++;
        if (counter) counter.textContent = `Checked ${tabCount} tab${tabCount !== 1 ? 's' : ''}...`;
      }, 180);

      const result = await sendToExtension({ action: 'preRecordingCheck' });
      clearInterval(ticker);
      ticker = null;

      if (!isValidPrecheckResult(result)) {
        throw new Error('BlurShield did not receive a valid pre-meeting scan response');
      }

      await new Promise(r => setTimeout(r, 400));
      showMeetingResults(overlay, result, platformName);
    } catch {
      if (ticker) clearInterval(ticker);
      showMeetingResults(overlay, {
        hasIssues: false,
        issues: [],
        riskyTabs: [],
        unscannableTabs: [],
        error: 'BlurShield could not complete the pre-meeting scan. Refresh the meeting tab and try again before you share your screen.'
      }, platformName);
    }
  }

  function initMeetingDetection() {
    // Check current page on load
    function checkCurrentPage() {
      if (_meetingScanFired) return;
      const platform = getCurrentMeetingPlatform();
      if (!platform) return;

      // Delay slightly to let the meeting page render first
      setTimeout(() => {
        if (_meetingScanFired) return;
        _meetingScanFired = true;
        runMeetingPreScan(platform);
      }, 1200);
    }

    // Also watch for SPA navigation (Zoom, Meet use pushState heavily)
    const origPushState = history.pushState.bind(history);
    history.pushState = function(...args) {
      origPushState(...args);
      _meetingScanFired = false; // reset so new meeting rooms re-trigger
      setTimeout(checkCurrentPage, 800);
    };

    window.addEventListener('popstate', () => {
      _meetingScanFired = false;
      setTimeout(checkCurrentPage, 800);
    });

    // Initial check
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkCurrentPage);
    } else {
      checkCurrentPage();
    }
  }

  // Only initialise meeting detection if we are on a supported meeting platform
  // (avoids running on every page for no reason)
  // Always init detection — it internally checks if current URL is a meeting page.
  // We run on all pages because SPA navigation means we don't know future URLs.
  
  // Also allow closing the overlay with ESC
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById(OVERLAY_ID)?.remove();
      document.getElementById(MEETING_OVERLAY_ID)?.remove();
    }
  }, true);

  initMeetingDetection();
})();

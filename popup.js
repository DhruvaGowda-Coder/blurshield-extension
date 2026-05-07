// BlurShield Popup v3 — Firebase Auth flow


document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);

  const SEV = {
    critical: { bg:'#300a0a', border:'#7f1d1d', badge:'#fca5a5', dot:'#ef4444' },
    high:     { bg:'#2d1b00', border:'#78350f', badge:'#fcd34d', dot:'#f59e0b' },
    medium:   { bg:'#1a1040', border:'#3730a3', badge:'#a5b4fc', dot:'#818cf8' },
    low:      { bg:'#002818', border:'#14532d', badge:'#86efac', dot:'#22c55e' },
  };
  const SCORE_COLOR = s => s >= 80 ? '#1D9E75' : s >= 50 ? '#f59e0b' : '#ef4444';

  function show(id)  { const el = $(id); if (el) el.style.display = 'flex'; }
  function hide(id)  { const el = $(id); if (el) el.style.display = 'none'; }
  function isInjectableUrl(url = '') { return /^(https?|file):\/\//i.test(url); }
  let popupFeedbackTimer = null;

  function hidePopupFeedback() {
    const el = $('popup-feedback');
    if (!el) return;
    clearTimeout(popupFeedbackTimer);
    el.style.display = 'none';
    el.textContent = '';
    el.className = 'popup-feedback';
  }

  function showPopupFeedback(message, tone = 'error') {
    const el = $('popup-feedback');
    if (!el) return;
    clearTimeout(popupFeedbackTimer);
    el.textContent = message;
    el.className = `popup-feedback popup-feedback--${tone}`;
    el.style.display = 'flex';
    popupFeedbackTimer = setTimeout(() => {
      el.style.display = 'none';
      el.textContent = '';
      el.className = 'popup-feedback';
    }, 5000);
  }

  function renderShortcut(targetId, shortcut) {
    const el = $(targetId); if (!el) return;
    el.textContent = '';
    (shortcut || 'Not assigned').split('+').forEach(part => {
      const key = document.createElement('kbd');
      key.textContent = part.trim();
      el.appendChild(key);
    });
  }

  // ── 1. Get trial status from background ─────────────────────────────────
  const trialStatus = await new Promise(res => {
    chrome.runtime.sendMessage({ action: 'getTrialStatus' }, status => {
      res(status || { signedIn: false, active: false, isPro: false, daysLeft: 0 });
    });
  });

  // ── 2. Route to correct screen ──────────────────────────────────────────
  if (trialStatus.isPro) {
    showAppScreen(trialStatus);
    return;
  }

  // Grace period: 3 free days, no sign-in required
  if (trialStatus.gracePeriod && trialStatus.active) {
    showAppScreen(trialStatus);
    return;
  }

  if (!trialStatus.signedIn) {
    showLoginScreen();
    return;
  }

  if (!trialStatus.active) {
    showUpgradeScreen(null, trialStatus);
    return;
  }

  // ── 3. Normal app flow ──────────────────────────────────────────────────
  showAppScreen(trialStatus);

  // ════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ════════════════════════════════════════════════════════════════════════
  function showLoginScreen() {
    hide('app');
    hide('upgrade-screen');
    show('login-screen');

    const btn = $('google-signin-btn');
    const errEl = $('login-error');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      $('signin-btn-text').textContent = 'Signing in…';
      errEl.style.display = 'none';

      try {
        const user = await window.BS_AUTH.signInWithGoogle();
        await window.BS_AUTH.saveUserSession(user);
        // Re-check trial status (creates Firestore record on first login)
        const newStatus = await new Promise(res =>
          chrome.runtime.sendMessage({ action: 'getTrialStatus' }, res)
        );
        if (newStatus.active || newStatus.isPro) {
          window.location.reload();
        } else {
          showUpgradeScreen(null, newStatus);
        }
      } catch (e) {
        errEl.textContent = e.message || 'Sign in failed. Please try again.';
        errEl.style.display = 'block';
        btn.disabled = false;
        $('signin-btn-text').textContent = 'Continue with Google';
      }
    });

    // Skip to license key entry
    $('skip-to-license')?.addEventListener('click', e => {
      e.preventDefault();
      showUpgradeScreen('license-only', trialStatus);
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // UPGRADE / EXPIRED SCREEN
  // ════════════════════════════════════════════════════════════════════════
  function showUpgradeScreen(mode, status) {
    hide('app');
    hide('login-screen');
    show('upgrade-screen');

    if (status && status.signedIn) {
      injectUserPill(status, '.upgrade-header');
    }

    if ($('upgrade-heading')) {
      $('upgrade-heading').textContent = mode === 'license-only'
        ? 'Activate your Pro license'
        : 'Your 7-day trial has ended';
    }

    let selected = 'annual';
    $('pick-annual')?.classList.add('selected');
    $('pick-monthly')?.addEventListener('click', () => {
      selected = 'monthly';
      $('pick-monthly').classList.add('selected');
      $('pick-annual').classList.remove('selected');
    });
    $('pick-annual')?.addEventListener('click', () => {
      selected = 'annual';
      $('pick-annual').classList.add('selected');
      $('pick-monthly').classList.remove('selected');
    });

    $('btn-upgrade')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openCheckout', plan: selected });
    });

    $('license-submit')?.addEventListener('click', async () => {
      const key = $('license-input').value.trim();
      if (!key) { showLicenseMsg('Please enter your license key', false); return; }
      $('license-submit').textContent = 'Checking…';
      $('license-submit').disabled = true;
      const result = await new Promise(res =>
        chrome.runtime.sendMessage({ action: 'validateLicense', licenseKey: key }, res)
      );
      if (result?.valid) {
        showLicenseMsg('License activated! Loading…', true);
        setTimeout(() => window.location.reload(), 1200);
      } else {
        showLicenseMsg(result?.error || 'Invalid license key', false);
        $('license-submit').textContent = 'Activate';
        $('license-submit').disabled = false;
      }
    });

    $('license-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') $('license-submit')?.click();
    });

    $('switch-account-link')?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Sign out of BlurShield?')) return;
      await new Promise(res => chrome.runtime.sendMessage({ action: 'signOut' }, res));
      window.location.reload();
    });
  }

  function showLicenseMsg(msg, ok) {
    const el = $('license-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'license-msg ' + (ok ? 'ok' : 'err');
  }

  // ════════════════════════════════════════════════════════════════════════
  // MAIN APP SCREEN
  // ════════════════════════════════════════════════════════════════════════
  async function showAppScreen(status) {
    hide('login-screen');
    hide('upgrade-screen');
    show('app');
    // show() already sets flex — no override needed

    // ── Grace period banner (“3 free days”, sign-in nudge) ────────────
    if (status.gracePeriod && !status.signedIn) {
      const banner = document.getElementById('grace-banner');
      if (banner) {
        const d = status.daysLeft;
        const timeStr = d === 0 ? 'Last free hours' : d === 1 ? '1 free day left' : `${d} free days left`;
        banner.className = 'grace-banner' + (d <= 1 ? ' grace-banner--urgent' : '');
        banner.innerHTML = `<span class="grace-banner-text">⏳ ${timeStr} — <a href="#" id="grace-signin-link">Sign in to keep access →</a></span><button class="grace-banner-close" id="grace-banner-close">×</button>`;
        banner.style.display = 'flex';
        document.getElementById('grace-signin-link')?.addEventListener('click', e => {
          e.preventDefault();
          hide('app'); show('login-screen');
          showLoginScreen();
        });
        document.getElementById('grace-banner-close')?.addEventListener('click', () => {
          banner.style.display = 'none';
        });
      }
    }

    // ── Load settings ──────────────────────────────────────────────────
    const cfg = await new Promise(res => chrome.storage.sync.get({
      enabled:true, blurEmails:true, blurPII:true, blurKeys:true,
      blurCrypto:true, revealOnHover:false, blurIntensity:7,
      whitelistedDomains:[], customZones:[]
    }, res));
    cfg.isPro = !!status.isPro;

    const defaultShortcuts = {
      toggle: 'Alt+Shift+B', reveal: 'Alt+Shift+U',
      meeting: 'Alt+Shift+M', preview: 'Alt+Shift+K'
    };
    renderShortcut('toggle-shortcut', cfg.customShortcuts?.toggle || defaultShortcuts.toggle);
    renderShortcut('reveal-shortcut', cfg.customShortcuts?.reveal || defaultShortcuts.reveal);
    renderShortcut('meeting-shortcut', cfg.customShortcuts?.meeting || defaultShortcuts.meeting);
    renderShortcut('preview-shortcut', cfg.customShortcuts?.preview || defaultShortcuts.preview);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const domain = tab?.url ? (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })() : '';
    let isWhitelisted = (cfg.whitelistedDomains || []).some(d => domain.includes(d));
    const isSupportedPage = isInjectableUrl(tab?.url || '');
    const whitelistNotice = $('whitelist-notice');

    // ── User pill in header ────────────────────────────────────────────
    if (status.signedIn) injectUserPill(status);

    // ── Trial badge ────────────────────────────────────────────────────
    if (!status.isPro && status.daysLeft <= 7) {
      const d = status.daysLeft;
      const badge = document.createElement('span');
      badge.className = 'trial-badge ' + (d > 3 ? 'trial-ok' : d > 1 ? 'trial-warn' : 'trial-exp');
      badge.textContent = d === 1 ? 'Last day!' : `${d}d left`;
      const footerBar = document.querySelector('.footer-bar');
      if (footerBar) footerBar.insertBefore(badge, footerBar.firstChild);
    }

    // ── Pro badge ──────────────────────────────────────────────────────
    if (status.isPro) {
      const pb = $('pro-badge');
      if (pb) pb.style.display = 'inline-block';
    }

    // ── Apply toggles ─────────────────────────────────────────────────
    $('master').checked    = cfg.enabled;
    $('t-keys').checked    = cfg.blurKeys !== false;
    $('t-crypto').checked  = cfg.blurCrypto !== false;
    $('t-emails').checked  = cfg.blurEmails !== false;
    $('t-pii').checked     = cfg.blurPII !== false;
    $('t-hover').checked   = cfg.revealOnHover || false;
    $('intensity').value   = cfg.blurIntensity || 7;
    $('intensity-val').textContent = (cfg.blurIntensity || 7) + 'px';

    // ── Whitelist notice ───────────────────────────────────────────────
    if (isWhitelisted) {
      whitelistNotice.style.display = 'flex';
      $('unwhitelist-btn').onclick = async () => {
        const { whitelistedDomains: wd = [] } = await new Promise(r => chrome.storage.sync.get({ whitelistedDomains: [] }, r));
        const nextWhitelistedDomains = wd.filter(d => !domain.includes(d));
        isWhitelisted = false;
        whitelistNotice.style.display = 'none';
        await saveCfg({ whitelistedDomains: nextWhitelistedDomains });
        setStatus(cfg.enabled);
      };
    } else if (whitelistNotice) {
      whitelistNotice.style.display = 'none';
    }

    // ── Status text ────────────────────────────────────────────────────
    function setStatus(enabled) {
      const el = $('status-text');
      if (!isSupportedPage) { el.textContent = 'not available on this page'; el.className = 'header-status off'; return; }
      if (!enabled)         { el.textContent = 'paused'; el.className = 'header-status off'; return; }
      if (isWhitelisted)    { el.textContent = 'whitelisted'; el.className = 'header-status off'; return; }
      el.textContent = domain || 'active';
      el.className = 'header-status active';
    }
    function setRevealButtonState(allRevealed) {
      const button = $('reveal-btn');
      const label = button?.querySelector('span:last-child');
      if (!label) return;
      label.textContent = allRevealed ? 'Hide all' : 'Reveal all';
    }
    function setMeetingButtonState(active) {
      const button = $('meeting-btn');
      const label = button?.querySelector('span:last-child');
      if (!button || !label) return;
      button.classList.toggle('action-btn--active', !!active);
      label.textContent = active ? 'Exit Meeting' : 'Meeting Mode';
    }
    setStatus(cfg.enabled);
    setRevealButtonState(false);
    setMeetingButtonState(false);

    // ── Score helpers ──────────────────────────────────────────────────
    function computeScore(items) {
      if (!items?.length) return 100;
      const w = { critical:30, high:15, medium:8, low:2 };
      return Math.max(0, 100 - items.reduce((a,i) => a + (w[i.severity]||5), 0));
    }
    function animateScore(score) {
      const ring = $('score-ring'), text = $('score-text');
      if (!ring || !text) return;
      const offset = 138 - (138 * score / 100);
      const color = SCORE_COLOR(score);
      ring.style.strokeDashoffset = offset;
      ring.style.stroke = color;
      text.textContent = score;
      text.style.fill = color;
    }
    function buildPills(items) {
      const grouped = {};
      items.forEach(i => { grouped[i.severity] = (grouped[i.severity]||0)+1; });
      const container = $('severity-pills');
      if (!container) return;
      container.innerHTML = '';
      ['critical','high','medium','low'].forEach(sev => {
        if (!grouped[sev]) return;
        const s = SEV[sev];
        const pill = document.createElement('span');
        pill.className = 'sev-pill';
        pill.style.background = s.bg; pill.style.color = s.badge; pill.style.borderColor = s.border;
        pill.textContent = `${sev[0].toUpperCase()+sev.slice(1)} ×${grouped[sev]}`;
        container.appendChild(pill);
      });
    }
    function buildDetectedList(items) {
      if (!items?.length) { $('detected-wrap').style.display = 'none'; return; }
      $('detected-wrap').style.display = 'block';
      const list = $('detected-list');
      list.innerHTML = '';
      const grouped = {};
      const esc = str => String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      items.forEach(i => { const k = i.patternId; if (!grouped[k]) grouped[k] = {...i, count:0}; grouped[k].count++; });
      Object.values(grouped).slice(0, 6).forEach(item => {
        const s = SEV[item.severity] || SEV.medium;
        const div = document.createElement('div');
        div.className = 'det-item';
        div.innerHTML = `<div class="det-dot" style="background:${s.dot}"></div><div class="det-name">${esc(item.name)}</div>${item.count>1?`<div class="det-count">×${item.count}</div>`:''}<div class="det-svc">${esc(item.service)}</div>`;
        list.appendChild(div);
      });
    }

    // ── Page readiness ─────────────────────────────────────────────────
    async function ensurePageReady() {
      if (!tab?.id) return false;
      try { await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }); return true; }
      catch {
        if (!isSupportedPage) return false;
        try {
          await chrome.scripting.insertCSS({ target:{tabId:tab.id}, files:['content.css'] }).catch(()=>{});
          await chrome.scripting.executeScript({ target:{tabId:tab.id}, files:['patterns.js','content.js'] });
          return true;
        } catch { return false; }
      }
    }
    function showUnavailableState() {
      $('secret-count').textContent = '—';
      $('secret-count').className = 'secret-num';
      animateScore(100);
      if ($('severity-pills')) $('severity-pills').innerHTML = '';
      $('detected-wrap').style.display = 'none';
      $('status-text').textContent = 'not available on this page';
      $('status-text').className = 'header-status off';
      setRevealButtonState(false);
      setMeetingButtonState(false);
    }

    // ── Refresh ────────────────────────────────────────────────────────
    async function refresh() {
      if (!(await ensurePageReady())) { showUnavailableState(); return; }
      try {
        // Request fresh status from content script
        const resp = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
        
        // If content script reports 0 but we visually see elements (or vice versa), 
        // we can trust the current response but we'll ensure it's not stale.
        const count = resp?.count ?? 0;
        const items = resp?.items ?? [];
        
        const num = $('secret-count');
        num.textContent = count;
        num.className = 'secret-num' + (count > 0 ? ' danger' : '');
        
        // Calculate and animate score
        const newScore = computeScore(items);
        animateScore(newScore);
        
        buildPills(items);
        buildDetectedList(items);
        
        setStatus(cfg.enabled);
        setRevealButtonState(!!resp?.allRevealed);
        setMeetingButtonState(!!resp?.meetingMode);
        
        // If count is 0 but master is enabled, check if we should do a soft rescan
        // This handles cases where the page content loaded after the content script's init.
        if (count === 0 && cfg.enabled && items.length === 0) {
           // We don't force a full rescan automatically to avoid flicker,
           // but the UI is now ready for the user to hit 'Rescan'.
        }
      } catch (e) { 
        console.error('BlurShield: Refresh failed', e);
        showUnavailableState(); 
      }
    }
    refresh();

    // ── Save config ────────────────────────────────────────────────────
    async function saveCfg(patch) {
      Object.assign(cfg, patch);
      chrome.storage.sync.set(patch);
      if (!(await ensurePageReady())) return;
      try { await chrome.tabs.sendMessage(tab.id, { action: 'updateCfg', cfg }); refresh(); } catch {}
    }

    // ── Event listeners ────────────────────────────────────────────────
    $('master').addEventListener('change', async () => {
      const enabled = $('master').checked;
      setStatus(enabled);
      chrome.storage.sync.set({ enabled });
      if (!(await ensurePageReady())) { if (!isSupportedPage) showUnavailableState(); return; }
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle', enabled });
        if (enabled) refresh();
        else {
          $('secret-count').textContent = '0';
          animateScore(100);
          $('severity-pills').innerHTML = '';
          $('detected-wrap').style.display = 'none';
          setRevealButtonState(false);
        }
      } catch {}
    });

    $('t-keys').addEventListener('change',   () => saveCfg({ blurKeys:    $('t-keys').checked }));
    $('t-crypto').addEventListener('change', () => saveCfg({ blurCrypto:  $('t-crypto').checked }));
    $('t-emails').addEventListener('change', () => saveCfg({ blurEmails:  $('t-emails').checked }));
    $('t-pii').addEventListener('change',    () => saveCfg({ blurPII:     $('t-pii').checked }));
    $('t-hover').addEventListener('change',  () => saveCfg({ revealOnHover: $('t-hover').checked }));

    $('intensity').addEventListener('input', () => {
      const v = parseInt($('intensity').value);
      $('intensity-val').textContent = v + 'px';
      try { chrome.tabs.sendMessage(tab.id, { action: 'setIntensity', blurIntensity: v }); } catch {}
    });
    $('intensity').addEventListener('change', () => {
      saveCfg({ blurIntensity: parseInt($('intensity').value) });
    });

    $('rescan').addEventListener('click', async () => {
      $('rescan').textContent = '↺ Scanning…';
      $('rescan').disabled = true;
      if (await ensurePageReady()) {
        try { await chrome.tabs.sendMessage(tab.id, { action: 'rescan' }); refresh(); } catch {}
      } else { showUnavailableState(); }
      $('rescan').textContent = '↺ Rescan';
      $('rescan').disabled = false;
    });

    $('zone-btn').addEventListener('click', async () => {
      if (!(await ensurePageReady())) return;
      try { await chrome.tabs.sendMessage(tab.id, { action: 'startZoneSelect' }); window.close(); } catch {}
    });

    $('reveal-btn').addEventListener('click', async () => {
      if (!(await ensurePageReady())) return;
      const revealButton = $('reveal-btn');
      let previousState = false;
      try {
        const current = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
        previousState = !!current?.allRevealed;
        const nextAction = current?.allRevealed ? 'hideAll' : 'revealAll';
        const nextState = nextAction === 'revealAll';
        setRevealButtonState(nextState);
        revealButton.disabled = true;
        const resp = await chrome.tabs.sendMessage(tab.id, { action: nextAction });
        setRevealButtonState(!!resp?.allRevealed);
        await refresh();
      } catch {
        setRevealButtonState(previousState);
      } finally {
        revealButton.disabled = false;
      }
    });

    $('clear-zones-btn').addEventListener('click', async () => {
      if (!(await ensurePageReady())) return;
      try { await chrome.tabs.sendMessage(tab.id, { action: 'startZoneErase' }); window.close(); } catch {}
    });

    // ── Pre-Meeting Scan button ────────────────────────────────────
    const prescanBtn = $('prescan-btn');

    // ── Meeting Scan Logic ────────────────────────────────────────────
    prescanBtn?.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      const btn = $('prescan-btn');
      const label = btn?.querySelector('span:last-child');
      hidePopupFeedback();
      if (label) label.textContent = 'Scanning...';
      if (btn) btn.disabled = true;

      try {
        const resp = await new Promise(res => {
          chrome.runtime.sendMessage({
            action: 'startMeetingScan',
            preferredTabId: tab?.id || null,
            fallbackToCurrentTab: true
          }, res);
        });

        if (resp?.ok) {
          window.close();
          return;
        }

        if (resp?.reason === 'noMeetingTab') {
          showPopupFeedback('Cannot run scan on this page. Open a supported webpage first.');
        } else {
          showPopupFeedback('BlurShield could not start the meeting scan. Refresh the tab and try again.');
        }
      } catch {
        showPopupFeedback('BlurShield could not start the meeting scan. Try again.');
      }

      if (label) label.textContent = 'Pre-Meeting Scan';
      if (btn) btn.disabled = false;
    });

    const meetingBtn = $('meeting-btn');
    meetingBtn?.addEventListener('click', async () => {
      if (!(await ensurePageReady())) return;
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { action: 'meetingMode' });
        setMeetingButtonState(!!resp?.meetingMode);
      } catch {}
    });

    // ── Screenshot button ──────────────────────────────────────────────
    $('screenshot-btn')?.addEventListener('click', async () => {
      const btn = $('screenshot-btn');
      const label = btn?.querySelector('span:last-child');
      if (label) label.textContent = 'Capturing…';
      if (btn) btn.disabled = true;
      try {
        const resp = await new Promise(res =>
          chrome.runtime.sendMessage({ action: 'captureTab' }, res)
        );
        if (resp?.dataUrl) {
          const a = document.createElement('a');
          a.href = resp.dataUrl;
          a.download = `blurshield-screenshot-${Date.now()}.png`;
          a.click();
        }
      } catch {}
      if (label) label.textContent = 'Screenshot';
      if (btn) btn.disabled = false;
    });

    $('options-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('custom-patterns-btn')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '#patterns' });
    });

    // ── Leak Simulation Mode ──────────────────────────────────────────────
    $('preview-risk-btn')?.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      // Try sending directly; if leakPreview.js isn't injected yet, inject it first
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'leakPreview' });
        if (!res) throw new Error('Not injected');
      } catch {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['leakPreview.js'] });
          await new Promise(r => setTimeout(r, 80)); // allow script to register listener
          await chrome.tabs.sendMessage(tab.id, { action: 'leakPreview' });
        } catch (e) {
          // Silent catch
        }
      }
      window.close();
    });
    $('clear-preview-btn')?.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      try { await chrome.tabs.sendMessage(tab.id, { action: 'clearLeakPreview' }); } catch {}
    });
    $('patterns-link')?.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '#patterns' });
    });
    $('stats-link')?.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '#stats' });
    });
  }

  // ── User pill: avatar + name in header, click to sign out ──────────────
  function injectUserPill(status, targetSelector = '.header') {
    const emailStr = status.email || 'User';
    const nameStr  = status.name  || emailStr;
    const photoUrl = status.photo || '';
    const header = document.querySelector(targetSelector);
    if (!header) return;
    const pill = document.createElement('div');
    pill.className = 'user-pill';
    pill.title = `${nameStr}\n${emailStr}\nClick to sign out`;
    const initial = nameStr[0].toUpperCase();
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'user-avatar';
    if (photoUrl) {
      const img = document.createElement('img');
      img.src = photoUrl;
      img.alt = initial;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
      avatarDiv.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.textContent = initial;
      avatarDiv.appendChild(span);
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name';
    nameSpan.textContent = nameStr.split(' ')[0];
    const logoutDiv = document.createElement('div');
    logoutDiv.className = 'user-logout';
    logoutDiv.title = 'Sign out';
    logoutDiv.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>`;
    pill.appendChild(avatarDiv);
    pill.appendChild(nameSpan);
    pill.appendChild(logoutDiv);
    pill.addEventListener('click', async () => {
      if (!confirm('Sign out of BlurShield?')) return;
      await new Promise(res => chrome.runtime.sendMessage({ action: 'signOut' }, res));
      window.location.reload();
    });
    // Insert before the master toggle
    const toggle = header.querySelector('.master-toggle');
    if (toggle) {
      header.insertBefore(pill, toggle);
    } else {
      pill.style.marginLeft = 'auto';
      header.appendChild(pill);
    }
  }
});

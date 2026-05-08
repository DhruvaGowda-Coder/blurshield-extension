// BlurShield Background v3 — Firebase Auth + Firestore trial system
importScripts('app-config.js', 'firebase.js');

const CHECKOUT_URLS = globalThis.BS_APP_CONFIG?.checkoutUrls || {};
const activeRecordingSessions = new Map();

function persistRecordingSessions() {
  if (!chrome.storage.session) return;
  const serialized = [...activeRecordingSessions.entries()].map(([k, v]) => [k, [...v]]);
  chrome.storage.session.set({ activeRecordingSessions: serialized }).catch?.(() => {});
}

// Restore recording sessions from storage on SW restart
if (chrome.storage.session) {
  chrome.storage.session.get({ activeRecordingSessions: [] }).then((data) => {
    if (Array.isArray(data?.activeRecordingSessions)) {
      data.activeRecordingSessions.forEach(([tabId, sessions]) => {
        activeRecordingSessions.set(tabId, new Set(sessions));
      });
    }
  }).catch(() => {});
}

function getCheckoutUrl(plan) {
  return (
    CHECKOUT_URLS[plan] ||
    CHECKOUT_URLS.default ||
    CHECKOUT_URLS.annual ||
    CHECKOUT_URLS.monthly ||
    'https://blurshield.lemonsqueezy.com/checkout/buy/02d5a635-7a74-4839-9149-5977c3864d16'
  );
}

function isInjectableUrl(url = '') {
  return /^(https?|file):\/\//i.test(url);
}

const MEETING_DOMAINS = [
  { name: 'Zoom', patterns: ['zoom.us/j/', 'zoom.us/wc/', 'zoom.us/my/'] },
  { name: 'Google Meet', patterns: ['meet.google.com/'] },
  { name: 'Microsoft Teams', patterns: ['teams.microsoft.com/l/meetup', 'teams.live.com/meet/'] },
  { name: 'Webex', patterns: ['webex.com/meet', 'webex.com/join'] },
  { name: 'Whereby', patterns: ['whereby.com/'] }
];

function getMeetingPlatformName(url = '') {
  for (const platform of MEETING_DOMAINS) {
    if (platform.patterns.some(pattern => url.includes(pattern))) {
      return platform.name;
    }
  }
  return null;
}

async function ensureContentScript(tab) {
  if (!tab?.id || !isInjectableUrl(tab.url)) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
    return true;
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['patterns.js', 'content.js', 'leakPreview.js'] });
      await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      return true;
    } catch {
      return false;
    }
  }
}

async function findMeetingTab(preferredTabId) {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentWindowId = currentTab?.windowId;
  const tabs = await chrome.tabs.query({});

  const meetingTabs = tabs
    .map(tab => ({ ...tab, platformName: getMeetingPlatformName(tab.url || '') }))
    .filter(tab => !!tab.platformName);

  if (!meetingTabs.length) return null;

  const score = (tab) => {
    let value = 0;
    if (tab.id === preferredTabId) value += 100;
    if (tab.active && tab.windowId === currentWindowId) value += 80;
    if (tab.windowId === currentWindowId) value += 30;
    if (tab.active) value += 10;
    return value;
  };

  meetingTabs.sort((a, b) => score(b) - score(a));
  return meetingTabs[0];
}

async function ensureMeetingScanReady(tab) {
  if (!tab?.id || !isInjectableUrl(tab.url)) return false;

  const ready = await ensureContentScript(tab);
  if (!ready) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['intercept.js'],
      world: 'MAIN'
    });
    return true;
  } catch {
    return false;
  }
}

async function startMeetingScan(preferredTabId, fallbackToCurrentTab = false) {
  const meetingTab = await findMeetingTab(preferredTabId);

  // Determine which tab to use: meeting tab if found, otherwise fall back to current tab
  let targetTab = meetingTab;
  let platformName = meetingTab?.platformName || 'All Platforms';

  if (!targetTab?.id && fallbackToCurrentTab && preferredTabId) {
    // No meeting tab found — fall back to the user's current tab
    try {
      const currentTab = await chrome.tabs.get(preferredTabId);
      if (currentTab?.id && isInjectableUrl(currentTab.url)) {
        targetTab = currentTab;
        platformName = getMeetingPlatformName(currentTab.url) || 'All Platforms';
      }
    } catch {}
  }

  if (!targetTab?.id) {
    return { ok: false, reason: 'noMeetingTab' };
  }

  const ready = await ensureMeetingScanReady(targetTab);
  if (!ready) {
    return {
      ok: false,
      reason: 'scanUnavailable',
      tabId: targetTab.id,
      platformName
    };
  }

  try {
    await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(targetTab.id, { active: true });
    const response = await chrome.tabs.sendMessage(targetTab.id, {
      action: 'triggerMeetingScan',
      platformName
    });

    return {
      ok: !!response?.ok,
      reason: response?.ok ? null : 'scanUnavailable',
      tabId: targetTab.id,
      platformName
    };
  } catch {
    return {
      ok: false,
      reason: 'scanUnavailable',
      tabId: targetTab.id,
      platformName
    };
  }
}

function hasRecordingSessionForTab(tabId) {
  return !!activeRecordingSessions.get(tabId)?.size;
}

function hasAnyRecordingSession() {
  for (const sessions of activeRecordingSessions.values()) {
    if (sessions.size) return true;
  }
  return false;
}

function setBadge(tabId, text, color) {
  if (!tabId) return;
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
}

function applyBadgeState(tabId, { count = 0, off = false } = {}) {
  if (!tabId) return;
  if (hasRecordingSessionForTab(tabId)) {
    setBadge(tabId, 'CHK', '#1D9E75');
    return;
  }
  if (off) {
    setBadge(tabId, 'OFF', '#ef4444');
    return;
  }
  setBadge(tabId, count > 0 ? String(count) : '', count > 0 ? '#ef4444' : '#1D9E75');
}

function buildSeverityCounts(items = []) {
  return items.reduce((acc, item) => {
    acc[item.severity] = (acc[item.severity] || 0) + 1;
    return acc;
  }, { critical: 0, high: 0, medium: 0, low: 0 });
}

function getHostname(url = '') {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isSkippablePrecheckUrl(url = '') {
  return (
    !url ||
    url === 'about:blank' ||
    url.startsWith('about:newtab') ||
    url.startsWith('chrome://newtab') ||
    url.startsWith(`chrome-extension://${chrome.runtime.id}/`)
  );
}

async function inspectTabForPrecheck(tab) {
  if (!tab?.id || isSkippablePrecheckUrl(tab.url)) return null;

  const meta = {
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || getHostname(tab.url) || 'Untitled tab',
    favicon: tab.favIconUrl || '',
    hostname: getHostname(tab.url)
  };

  if (!isInjectableUrl(tab.url)) {
    // Ignore restricted browser pages (like chrome://) rather than flagging them
    // as "unscannable" errors, which annoys users testing the extension.
    return null;
  }

  const ready = await ensureContentScript(tab);
  if (!ready) {
    return {
      ...meta,
      state: 'unscannable',
      reason: 'BlurShield could not scan this tab'
    };
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action: 'getDetectedItems' });
    const items = Array.isArray(result?.items) ? result.items : [];
    const state = result?.state || (items.length ? 'exposed' : 'clean');
    if (state === 'clean') return null;

    const severity = buildSeverityCounts(items);
    return {
      ...meta,
      state,
      reason: result?.reason || '',
      items,
      count: items.length,
      critical: severity.critical || 0,
      high: severity.high || 0,
      medium: severity.medium || 0,
      low: severity.low || 0
    };
  } catch {
    return {
      ...meta,
      state: 'unscannable',
      reason: 'BlurShield did not receive a scan response from this tab'
    };
  }
}

async function runPreRecordingCheck() {
  const tabs = await chrome.tabs.query({});
  const settled = await Promise.allSettled(tabs.map(inspectTabForPrecheck));
  const collected = settled
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);

  const riskyTabs = collected
    .filter(item => item.state === 'exposed')
    .sort((a, b) => (
      (b.critical - a.critical) ||
      (b.high - a.high) ||
      (b.count - a.count) ||
      a.hostname.localeCompare(b.hostname)
    ));

  const unscannableTabs = collected
    .filter(item => item.state === 'unscannable')
    .sort((a, b) => a.hostname.localeCompare(b.hostname));

  const issues = [...riskyTabs, ...unscannableTabs];
  return {
    hasIssues: issues.length > 0,
    issues,
    riskyTabs,
    unscannableTabs,
    issueCount: riskyTabs.length,
    unscannableCount: unscannableTabs.length,
    userApproved: false
  };
}

async function broadcastRecordingState(action) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter(tab => tab?.id && isInjectableUrl(tab.url))
      .map(tab => chrome.tabs.sendMessage(tab.id, { action }))
  );
}

async function refreshBadgeForTab(tabId) {
  if (!tabId) return;
  if (hasRecordingSessionForTab(tabId)) {
    applyBadgeState(tabId);
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id || !isInjectableUrl(tab.url)) {
      setBadge(tabId, '', '#1D9E75');
      return;
    }
    const ready = await ensureContentScript(tab);
    if (!ready) {
      setBadge(tabId, '', '#1D9E75');
      return;
    }
    const status = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' }).catch(() => null);
    applyBadgeState(tabId, { count: status?.count || 0, off: false });
  } catch {
    setBadge(tabId, '', '#1D9E75');
  }
}

async function handleRecordingStateChange(tabId, state, sessionId) {
  if (!tabId) return { ok: false };

  const key = sessionId || 'default';
  const hadAnyRecording = hasAnyRecordingSession();
  const sessions = activeRecordingSessions.get(tabId) || new Set();

  if (state === 'started') {
    sessions.add(key);
    activeRecordingSessions.set(tabId, sessions);
    applyBadgeState(tabId);
  } else if (state === 'stopped') {
    sessions.delete(key);
    if (sessions.size) activeRecordingSessions.set(tabId, sessions);
    else activeRecordingSessions.delete(tabId);
  }

  // After any add/delete to activeRecordingSessions, persist it:
  persistRecordingSessions();

  const hasRecordingNow = hasAnyRecordingSession();
  if (!hadAnyRecording && hasRecordingNow) {
    await broadcastRecordingState('recording-started');
  } else if (hadAnyRecording && !hasRecordingNow) {
    await broadcastRecordingState('recording-stopped');
  }

  if (state === 'stopped') {
    await refreshBadgeForTab(tabId);
  }

  return { ok: true, recordingActive: hasRecordingNow };
}

async function focusIssueTab(tabId) {
  if (!tabId) return { ok: false };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return { ok: false };
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(tabId, { active: true });
    if (await ensureContentScript(tab)) {
      await chrome.tabs.sendMessage(tabId, { action: 'highlightDetectedItems' }).catch(() => {});
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}


// ── No-sign-in grace period (3 days free on install, no account needed) ──
async function getNoSignInGracePeriod() {
  try {
    const { bsFirstInstall } = await chrome.storage.local.get({ bsFirstInstall: null });
    if (!bsFirstInstall) {
      const now = Date.now();
      await chrome.storage.local.set({ bsFirstInstall: now });
      return { active: true, gracePeriod: true, daysLeft: 3 };
    }
    const elapsedDays = Math.floor((Date.now() - bsFirstInstall) / (1000 * 60 * 60 * 24));
    const daysLeft = Math.max(0, 3 - elapsedDays);
    return { active: daysLeft > 0, gracePeriod: true, daysLeft };
  } catch {
    return { active: true, gracePeriod: true, daysLeft: 3 }; // fail-open
  }
}

async function getTrialStatus() {
  try {
    // If Firebase auth not loaded yet, fall back to grace period
    if (!globalThis.BS_AUTH) {
      const grace = await getNoSignInGracePeriod();
      return { signedIn: false, active: grace.active, isPro: false, daysLeft: grace.daysLeft, gracePeriod: true };
    }
    const status = await globalThis.BS_AUTH.getAuthAndTrialStatus();
    // If user has not signed in and is not Pro, check if they are in grace period
    if (!status.signedIn && !status.isPro) {
      const grace = await getNoSignInGracePeriod();
      if (grace.active) {
        return { signedIn: false, active: true, isPro: false, daysLeft: grace.daysLeft, gracePeriod: true };
      }
    }
    chrome.storage.local.set({ bsCachedStatus: { ...status, cachedAt: Date.now() } }).catch(() => {});
    return status;
  } catch {
    try {
      const { bsCachedStatus } = await chrome.storage.local.get({ bsCachedStatus: null });
      if (bsCachedStatus) return bsCachedStatus;
    } catch {}
    // Last resort: check grace period
    try {
      const grace = await getNoSignInGracePeriod();
      if (grace.active) return { signedIn: false, active: true, isPro: false, daysLeft: grace.daysLeft, gracePeriod: true };
    } catch {}
    return { signedIn: false, active: false, isPro: false, daysLeft: 0 };
  }
}

// ── Installed ──────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'bs-blur-element',    title: '🛡 BlurShield: Blur this element',    contexts: ['all'] });
    chrome.contextMenus.create({ id: 'bs-whitelist-domain',title: '🛡 BlurShield: Whitelist this domain', contexts: ['all'] });
    chrome.contextMenus.create({ id: 'bs-sep', type: 'separator', contexts: ['all'] });
    chrome.contextMenus.create({ id: 'bs-options',         title: '🛡 BlurShield: Open Settings',         contexts: ['all'] });
  });
  // Create alarm only on install — prevents duplicate alarms on every SW restart
  chrome.alarms.get('hourly-check', (alarm) => {
    if (!alarm) chrome.alarms.create('hourly-check', { periodInMinutes: 60 });
  });
});

// ── Context menu ───────────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'bs-blur-element') {
    const status = await getTrialStatus();
    if (!status.active) {
      if (!status.signedIn && !status.isPro) {
        chrome.action.openPopup?.().catch(() => {
          chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
        });
      } else {
        chrome.tabs.create({ url: getCheckoutUrl() });
      }
      return;
    }
    if (!(await ensureContentScript(tab))) return;
    chrome.tabs.sendMessage(tab.id, { action: 'startZoneSelect' }).catch(() => {});
  }
  if (info.menuItemId === 'bs-whitelist-domain') {
    try {
      const url = new URL(tab.url);
      const domain = url.hostname;
      const { whitelistedDomains = [] } = await chrome.storage.sync.get({ whitelistedDomains: [] });
      if (!whitelistedDomains.includes(domain)) {
        whitelistedDomains.push(domain);
        chrome.storage.sync.set({ whitelistedDomains });
      }
    } catch {}
  }
  if (info.menuItemId === 'bs-options') chrome.runtime.openOptionsPage();
});

// ── Keyboard commands ──────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const status = await getTrialStatus();
  if (!status.active) {
    if (!status.signedIn && !status.isPro) {
      chrome.action.openPopup?.().catch(() => {
        chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
      });
    } else {
      chrome.tabs.create({ url: getCheckoutUrl() });
    }
    return;
  }
  if (!(await ensureContentScript(tab))) return;
  if (command === 'toggle-blur') {
    const { enabled } = await chrome.storage.sync.get({ enabled: true });
    const next = !enabled;
    chrome.storage.sync.set({ enabled: next });
    chrome.tabs.sendMessage(tab.id, { action: 'keyboard-toggle', enabled: next }).catch(() => {});
    applyBadgeState(tab.id, { off: !next });
  }
  if (command === 'reveal-all') chrome.tabs.sendMessage(tab.id, { action: 'keyboard-reveal' }).catch(() => {});
  if (command === 'meeting-mode') chrome.tabs.sendMessage(tab.id, { action: 'meetingMode' }).catch(() => {});
  if (command === 'leak-preview') {
    (async () => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['leakPreview.js'] });
        await new Promise(r => setTimeout(r, 80));
      } catch {}
      chrome.tabs.sendMessage(tab.id, { action: 'leakPreview' }).catch(() => {});
    })();
  }
});

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'updateBadge' && sender.tab?.id) {
    applyBadgeState(sender.tab.id, { count: msg.count || 0, off: !!msg.off });
    return false;
  }
  if (msg.action === 'preRecordingCheck') {
    runPreRecordingCheck()
      .then(result => sendResponse(result))
      .catch(() => sendResponse({
        hasIssues: true,
        issues: [],
        riskyTabs: [],
        unscannableTabs: [],
        issueCount: 0,
        unscannableCount: 0,
        error: 'BlurShield could not complete the pre-recording scan',
        userApproved: false
      }));
    return true;
  }
  if (msg.action === 'startMeetingScan') {
    startMeetingScan(msg.preferredTabId, !!msg.fallbackToCurrentTab)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, reason: 'scanUnavailable' }));
    return true;
  }
  if (msg.action === 'getTrialStatus') {
    getTrialStatus().then(s => sendResponse(s)).catch(() => sendResponse({ signedIn: false, active: false }));
    return true;
  }
  if (msg.action === 'validateLicense') {
    if (!globalThis.BS_AUTH) { sendResponse({ valid: false }); return false; }
    globalThis.BS_AUTH.activateProLicense(msg.licenseKey).then(r => sendResponse(r)).catch(() => sendResponse({ valid: false }));
    return true;
  }
  if (msg.action === 'signOut') {
    if (!globalThis.BS_AUTH) { sendResponse({ ok: false }); return false; }
    globalThis.BS_AUTH.signOut().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.action === 'openCheckout') {
    chrome.tabs.create({ url: getCheckoutUrl(msg.plan) });
    return false;
  }
  if (msg.action === 'captureTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse({ error: 'No active tab' }); return; }
      chrome.windows.getCurrent({}, (win) => {
        chrome.tabs.captureVisibleTab(win.id, { format: 'png' }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ dataUrl });
        });
      });
    });
    return true;
  }
  if (msg.action === 'recordingStateChange' && sender.tab?.id) {
    handleRecordingStateChange(sender.tab.id, msg.state, msg.sessionId)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.action === 'openIssueTab') {
    focusIssueTab(msg.tabId)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.action === 'triggerLeakPreview' && sender.tab?.id) {
    (async () => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, files: ['leakPreview.js'] });
        await new Promise(r => setTimeout(r, 80));
      } catch {}
      chrome.tabs.sendMessage(sender.tab.id, { action: 'leakPreview' });
    })();
    return false;
  }
  if (msg.action === 'notifyScreenshareBlocked') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'BlurShield Protection',
      message: msg.message || 'Screen share cancelled to prevent secret exposure.',
      priority: 2
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'shortcutsUpdated') {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id && isInjectableUrl(tab.url)) {
          chrome.tabs.sendMessage(tab.id, { action: 'shortcutsUpdated', shortcuts: msg.shortcuts }).catch(() => {});
        }
      });
    });
    return false;
  }
  return false;
});

// ── Badge updater ──────────────────────────────────────────────────────────
async function updateAllBadges() {
  try {
    const status = await getTrialStatus();
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      if (hasRecordingSessionForTab(tab.id)) {
        applyBadgeState(tab.id);
        return;
      }
      if (status.active) {
        setBadge(tab.id, '', '#1D9E75');
        return;
      }
      setBadge(tab.id, !status.signedIn ? '' : 'EXP', '#ef4444');
    });
  } catch {}
}

chrome.tabs.onActivated.addListener(activeInfo => {
  refreshBadgeForTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && !hasRecordingSessionForTab(tabId)) {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!activeRecordingSessions.has(tabId)) return;
  const hadAnyRecording = hasAnyRecordingSession();
  activeRecordingSessions.delete(tabId);
  persistRecordingSessions();
  if (hadAnyRecording && !hasAnyRecordingSession()) {
    broadcastRecordingState('recording-stopped').catch(() => {});
  }
});

// ── Alarm handler ──────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'hourly-check') {
    chrome.storage.local.get({ stats: {} }, ({ stats }) => {
      const keys = Object.keys(stats).sort();
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach(k => delete stats[k]);
        chrome.storage.local.set({ stats });
      }
    });
    updateAllBadges();
  }
});

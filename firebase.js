// BlurShield Firebase v3.0
// Uses Firebase REST API + chrome.identity — no SDK needed (works in MV3)
//
// ═══════════════════════════════════════════════════════════════════
//  SETUP INSTRUCTIONS — fill in your Firebase config below
//  1. Go to https://console.firebase.google.com
//  2. Create project → "BlurShield"
//  3. Add Web App → copy the config values below
//  4. Enable Authentication → Google provider
//  5. Enable Firestore → Start in production mode
//  6. Go to Google Cloud Console → APIs & Services → Credentials
//     → Your OAuth 2.0 Client ID → copy to manifest.json oauth2.client_id
//  7. In Firebase Console → Authentication → Settings → Authorized domains
//     → Add: <your-extension-id>.chromiumapp.org
// ═══════════════════════════════════════════════════════════════════

const FIREBASE_CONFIG = globalThis.BS_APP_CONFIG?.firebase || {
  apiKey: '',
  projectId: '',
  authDomain: '',
};

const TRIAL_DAYS = 7;
const LICENSE_REVALIDATE_MS = 12 * 60 * 60 * 1000;
const LICENSE_OFFLINE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const STATUS_CACHE_MS = 12 * 60 * 60 * 1000;

// ── Google Sign-In via chrome.identity (with account picker) ─────────────
// Uses launchWebAuthFlow with prompt=select_account so user always picks
// which Google account to use — never auto-logs in with default account.
// We use the Web Application client ID here because it supports redirect URIs;
// the Chrome Extension client ID (in manifest oauth2 field) does not.
async function signInWithGoogle() {
  // Prefer a dedicated Web OAuth client for launchWebAuthFlow.
  const clientId = globalThis.BS_APP_CONFIG?.googleWebClientId ||
    globalThis.BS_APP_CONFIG?.googleOAuthClientId ||
    '889364031508-eq81m9q0oue9s7rcil03url8usfmpeem.apps.googleusercontent.com';
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ].join(' ');

  // Build the OAuth2 authorization URL — prompt=select_account forces picker
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&prompt=select_account`;

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (url) => {
        if (chrome.runtime.lastError || !url) {
          reject(new Error(chrome.runtime.lastError?.message || 'Login cancelled'));
          return;
        }
        resolve(url);
      }
    );
  });

  // Extract access_token from the redirect URL fragment
  const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  const accessToken = params.get('access_token');
  if (!accessToken) throw new Error('No access token received from Google');

  // Exchange the access token with Firebase
  return exchangeTokenWithFirebase(accessToken);
}

// ── Exchange Google token with Firebase Auth REST API ─────────────────────
async function exchangeTokenWithFirebase(googleAccessToken) {
  const extensionId = chrome.runtime.id;
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `access_token=${googleAccessToken}&providerId=google.com`,
        requestUri: `https://${extensionId}.chromiumapp.org/`,
        returnIdpCredential: true,
        returnSecureToken: true
      })
    }
  );
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'Firebase auth failed');
  return {
    uid:      data.localId,
    email:    data.email,
    name:     data.displayName,
    photo:    data.photoUrl,
    idToken:  data.idToken,
    refreshToken: data.refreshToken
  };
}

// ── Refresh Firebase ID token ─────────────────────────────────────────────
async function refreshIdToken(refreshToken) {
  const resp = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken })
    }
  );
  const data = await resp.json();
  if (data.error) throw new Error('Token refresh failed');
  return { idToken: data.id_token, refreshToken: data.refresh_token };
}

// ── Get current valid ID token (auto-refresh if needed) ───────────────────
async function getValidIdToken() {
  const stored = await new Promise(res =>
    chrome.storage.local.get({ bsUser: null }, r => res(r.bsUser))
  );
  if (!stored?.idToken) return null;

  // Try using existing token — Firebase tokens last 1 hour
  const tokenAge = Date.now() - (stored.tokenSavedAt || 0);
  if (tokenAge < 55 * 60 * 1000) return stored.idToken; // < 55 min, still good

  // Refresh the token
  try {
    const fresh = await refreshIdToken(stored.refreshToken);
    await chrome.storage.local.set({
      bsUser: { ...stored, idToken: fresh.idToken, refreshToken: fresh.refreshToken, tokenSavedAt: Date.now() }
    });
    return fresh.idToken;
  } catch {
    return null;
  }
}

// ── Firestore REST helpers ────────────────────────────────────────────────
async function getStoredLicenseKey() {
  const data = await chrome.storage.sync.get({ licenseKey: '' });
  return data.licenseKey?.trim() || '';
}

async function getLicenseCache() {
  const data = await chrome.storage.local.get({ bsLicenseCache: null });
  return data.bsLicenseCache;
}

async function setLicenseCache(cache) {
  await chrome.storage.local.set({ bsLicenseCache: cache });
}

function buildLicenseCache(licenseKey, data) {
  return {
    licenseKey,
    validatedAt: Date.now(),
    licenseName: data?.license_key?.key || '',
    licenseStatus: data?.license_key?.status || '',
  };
}

async function validateLicenseWithServer(licenseKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, instance_name: 'BlurShield' }),
      signal: controller.signal
    });
    const data = await resp.json();
    if (data.valid || data.activated) return { valid: true, data };
    return { valid: false, error: data.error || 'Invalid license key' };
  } catch (error) {
    return {
      valid: false,
      error: error?.name === 'AbortError' ? 'License validation timed out' : 'Could not connect to validation server',
      networkError: true
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getValidatedLicenseStatus() {
  const licenseKey = await getStoredLicenseKey();
  if (!licenseKey) return { isPro: false };

  const cache = await getLicenseCache();
  const cacheMatches = cache?.licenseKey === licenseKey;
  const cacheAge = cacheMatches ? Date.now() - (cache.validatedAt || 0) : Infinity;

  if (cacheMatches && cacheAge < LICENSE_REVALIDATE_MS) {
    return { isPro: true, licenseKey, offline: false, cached: true };
  }

  const result = await validateLicenseWithServer(licenseKey);
  if (result.valid) {
    await setLicenseCache(buildLicenseCache(licenseKey, result.data));
    return { isPro: true, licenseKey, offline: false };
  }

  if (result.networkError && cacheMatches && cacheAge < LICENSE_OFFLINE_GRACE_MS) {
    return { isPro: true, licenseKey, offline: true, cached: true };
  }

  return { isPro: false, licenseKey, error: result.error, networkError: !!result.networkError };
}

function firestoreUrl(path) {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${path}`;
}

function toFirestoreDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')  fields[k] = { stringValue: v };
    if (typeof v === 'number')  fields[k] = { integerValue: String(v) };
    if (typeof v === 'boolean') fields[k] = { booleanValue: v };
  }
  return { fields };
}

function fromFirestoreDoc(doc) {
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    if (v.stringValue  !== undefined) obj[k] = v.stringValue;
    if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue);
    if (v.doubleValue  !== undefined) obj[k] = v.doubleValue;
    if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
  }
  return obj;
}

async function firestoreGet(path, idToken) {
  const resp = await fetch(firestoreUrl(path), {
    headers: { 'Authorization': `Bearer ${idToken}` }
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Firestore GET failed: ${resp.status}`);
  const data = await resp.json();
  return fromFirestoreDoc(data);
}

async function firestoreSet(path, obj, idToken) {
  const fields = toFirestoreDoc(obj).fields;
  const resp = await fetch(
    firestoreUrl(path) + `?updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    }
  );
  if (!resp.ok) throw new Error(`Firestore SET failed: ${resp.status}`);
  return resp.json();
}

async function firestoreCreate(collectionPath, documentId, obj, idToken) {
  const resp = await fetch(
    `${firestoreUrl(collectionPath)}?documentId=${encodeURIComponent(documentId)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(toFirestoreDoc(obj))
    }
  );
  if (!resp.ok) throw new Error(`Firestore CREATE failed: ${resp.status}`);
  return resp.json();
}

// ── Core: get or create trial record for this user ────────────────────────
async function getOrCreateTrialRecord(uid, idToken) {
  let record = await firestoreGet(`trials/${uid}`, idToken);
  if (!record) {
    // First time — create trial
    record = {
      uid,
      trialStartDate: Date.now()
    };
    try {
      await firestoreCreate('trials', uid, record, idToken);
    } catch {
      record = await firestoreGet(`trials/${uid}`, idToken);
      if (record) return record;
      throw new Error('Could not create trial record');
    }
  }
  return record;
}

// ── Main: get full auth + trial status ────────────────────────────────────
async function getAuthAndTrialStatus() {
  const stored = await new Promise(res =>
    chrome.storage.local.get({ bsUser: null }, r => res(r.bsUser))
  );

  const licenseStatus = await getValidatedLicenseStatus();
  if (licenseStatus.isPro) {
    return {
      signedIn: !!stored?.uid,
      active: true,
      isPro: true,
      daysLeft: 999,
      offline: !!licenseStatus.offline,
      email: stored?.email,
      name: stored?.name,
      photo: stored?.photo
    };
  }

  if (!stored?.uid) {
    return { signedIn: false, active: false, isPro: false, daysLeft: 0 };
  }

  try {
    const idToken = await getValidIdToken();
    if (!idToken) return { signedIn: false, active: false, isPro: false, daysLeft: 0 };

    const record = await getOrCreateTrialRecord(stored.uid, idToken);

    const elapsed = Math.floor((Date.now() - record.trialStartDate) / (1000 * 60 * 60 * 24));
    const daysLeft = Math.max(0, TRIAL_DAYS - elapsed);
    return {
      signedIn: true,
      active: daysLeft > 0,
      isPro: false,
      daysLeft,
      trialStartDate: record.trialStartDate,
      email: stored.email,
      name: stored.name,
      photo: stored.photo
    };
  } catch (e) {
    console.warn('BlurShield Firebase Auth/Trial Error:', e.message || e);
    // Network error — fall back to cached status
    const cached = await new Promise(res =>
      chrome.storage.local.get({ bsCachedStatus: null }, r => res(r.bsCachedStatus))
    );
    if (cached?.cachedAt && (Date.now() - cached.cachedAt) < STATUS_CACHE_MS) return cached;
    return {
      signedIn: !!stored?.uid,
      active: false,
      isPro: false,
      daysLeft: 0,
      offline: true,
      email: stored?.email,
      name: stored?.name,
      photo: stored?.photo
    };
  }
}

// ── Save user session to local storage ───────────────────────────────────
async function saveUserSession(user) {
  await chrome.storage.local.set({
    bsUser: {
      uid:          user.uid,
      email:        user.email,
      name:         user.name,
      photo:        user.photo,
      idToken:      user.idToken,
      refreshToken: user.refreshToken,
      tokenSavedAt: Date.now()
    }
  });
}

// ── Sign out ──────────────────────────────────────────────────────────────
async function signOut() {
  await chrome.storage.local.remove(['bsUser', 'bsCachedStatus']);
  chrome.identity.clearAllCachedAuthTokens(() => {});
  // Note: 'isPro' is derived from licenseKey validation, not stored directly.
}

// ── Activate Pro via license key ──────────────────────────────────────────
async function activateProLicense(licenseKey) {
  const trimmed = licenseKey?.trim();
  if (!trimmed) return { valid: false, error: 'No license key provided' };

  const result = await validateLicenseWithServer(trimmed);
  if (!result.valid) return { valid: false, error: result.error || 'Invalid license key' };

  await chrome.storage.sync.set({ licenseKey: trimmed });
  await setLicenseCache(buildLicenseCache(trimmed, result.data));
  // 'isPro' is not stored in sync — derived from licenseKey validation. No removal needed.
  return { valid: true };
}

// Export for use in background and popup
if (typeof window !== 'undefined') {
  window.BS_AUTH = { signInWithGoogle, signOut, getAuthAndTrialStatus, saveUserSession, activateProLicense };
}
if (typeof globalThis !== 'undefined') {
  globalThis.BS_AUTH = { signInWithGoogle, signOut, getAuthAndTrialStatus, saveUserSession, activateProLicense };
}

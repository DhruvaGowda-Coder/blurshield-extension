// BlurShield Content Script v3.0.1
(() => {
  'use strict';

  if (window.__BLURSHIELD_CONTENT_LOADED__) return;
  window.__BLURSHIELD_CONTENT_LOADED__ = true;

  // ── State ─────────────────────────────────────────────────────────────
  let cfg = {
    enabled: true, blurEmails: true, blurPII: true,
    blurKeys: true, blurCrypto: true, revealOnHover: false,
    showBanner: true, showToasts: true,
    whitelistedDomains: [],
    customShortcuts: {
      toggle: 'Alt+Shift+B',
      reveal: 'Alt+Shift+U',
      meeting: 'Alt+Shift+M',
      preview: 'Alt+Shift+K'
    }
  };
  let detectedItems = [];
  let isSelectingZone = false;
  let isErasingZone = false;
  let recordingBanner = null;
  let recordingDetectionStarted = false;
  let isAllRevealed = false;
  const blurredEls = new WeakSet();
  let isMeetingMode = false;
  let meetingBanner = null;
  let hasActiveAccess = false;
  const domain = location.hostname;
  let lastCopiedSecrets = []; // In-memory: recently copied secret matches — never persisted externally
  let pasteCfg = { pasteWarning: true, pasteTrustedDomains: [] };
  const SCAN_PASS_LIMIT = 10;
  const PRECHECK_ITEM_LIMIT = 25;
  const ZONE_TEXT_LIMIT = 140;
  const ZONE_CANDIDATE_LIMIT = 150;
  const ZONE_ANCHOR_DEPTH = 4;

  // ── Set CSS custom property for blur intensity ─────────────────────────
  function setBlurIntensity(px) {
    document.documentElement.style.setProperty('--bs-blur', px + 'px');
  }

  async function loadCfg() {
    return new Promise(res => {
      chrome.storage.sync.get({
        enabled: true, blurEmails: true, blurPII: true,
        blurKeys: true, blurCrypto: true, revealOnHover: false,
        blurIntensity: 7, customZones: [], customPatterns: [],
        showBanner: true, showToasts: true,
        whitelistedDomains: [],
        pasteWarning: true, pasteTrustedDomains: []
      }, async data => {
        Object.assign(cfg, data);
        pasteCfg.pasteWarning = data.pasteWarning !== false;
        pasteCfg.pasteTrustedDomains = Array.isArray(data.pasteTrustedDomains) ? data.pasteTrustedDomains : [];
        try {
          const status = await new Promise(r => chrome.runtime.sendMessage({ action: 'getTrialStatus' }, r));
          cfg.isPro = !!status?.isPro;
        } catch {
          cfg.isPro = false;
        }
      chrome.storage.local.get({ customShortcuts: null }, storageLocal => {
        if (storageLocal.customShortcuts) {
          cfg.customShortcuts = storageLocal.customShortcuts;
        }
        res();
      });
    });
    });
  }

  function syncPatternSet() {
    if (!window.BS_PATTERNS_TRIAL) return;
    window.BS_PATTERNS = cfg.isPro && window.BS_PATTERNS_PRO
      ? [...window.BS_PATTERNS_TRIAL, ...window.BS_PATTERNS_PRO]
      : [...window.BS_PATTERNS_TRIAL];
      
    if (cfg.isPro && cfg.customPatterns && cfg.customPatterns.length > 0) {
      const compiled = cfg.customPatterns.reduce((acc, p) => {
        try {
          acc.push({
            id: p.id,
            name: p.name,
            service: p.service || 'Custom',
            severity: p.severity || 'high',
            confidence: 99,
            pattern: new RegExp(p.patternString, 'g')
          });
        } catch(e) {}
        return acc;
      }, []);
      window.BS_PATTERNS.push(...compiled);
    }
  }

  // ── Domain whitelist check ─────────────────────────────────────────────
  // Built-in skip list: login/auth pages where blurring emails is disruptive
  const BUILTIN_SKIP = [
    'login.microsoftonline.com',
    'appleid.apple.com',
    'github.com/login',
    'gitlab.com/users/sign_in',
    'accounts.lemonsqueezy.com',
  ];

  function isDomainWhitelisted() {
    const path = domain + location.pathname;
    if (BUILTIN_SKIP.some(s => path.includes(s))) return true;
    return (cfg.whitelistedDomains || []).some(d => domain.includes(d));
  }

  // ── Get all text nodes ─────────────────────────────────────────────────
  function getTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName?.toLowerCase();
        if (['script','style','noscript','textarea','code'].includes(tag)) return NodeFilter.FILTER_REJECT;
        // Skip anything already processed by BlurShield
        if (p.closest('.bs-blur,.bs-badge,.bs-toast,.bs-recording-banner')) return NodeFilter.FILTER_REJECT;
        if (p.hasAttribute('data-bs-processed')) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-bs-processed]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = []; let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // ── Should pattern run? ────────────────────────────────────────────────
  function shouldRun(pat) {
    if (pat.id === 'email' && !cfg.blurEmails) return false;
    if (pat.id === 'phone' && !cfg.blurPII) return false;
    if (pat.id === 'creditcard' && !cfg.blurPII) return false;
    if (['rsa-private','ec-private','openssh-private','pgp-private'].includes(pat.id) && !cfg.blurCrypto) return false;
    if (!cfg.blurKeys && !['email','phone','creditcard'].includes(pat.id)) return false;
    return true;
  }

  // ── Context-key check — boosts confidence for generic patterns ─────────
  function hasContextKey(textNode, pat) {
    if (!pat.contextKeys?.length) return true;
    const parent = textNode.parentElement;
    const nearby = parent?.closest('[class],[id]')?.textContent?.slice(0, 500) || '';
    const attrText = (parent?.getAttribute('class') || '') + (parent?.getAttribute('id') || '');
    const combined = (nearby + attrText).toLowerCase();
    return pat.contextKeys.some(k => combined.includes(k.toLowerCase()));
  }

  // ── Wrap a matched secret ─────────────────────────────────────────────
  function wrapSecret(textNode, matchStr, pat) {
    if (!textNode?.parentNode) return false;
    const text = textNode.textContent;
    const idx = text.indexOf(matchStr);
    if (idx === -1) return false;

    const sev = window.BS_SEVERITY[pat.severity] || window.BS_SEVERITY.medium;
    const before = text.slice(0, idx);
    const after  = text.slice(idx + matchStr.length);
    const frag   = document.createDocumentFragment();

    if (before) frag.appendChild(document.createTextNode(before));

    // Blurred span
    const span = document.createElement('span');
    span.className = 'bs-blur';
    span.textContent = matchStr;
    span.dataset.bsPatternId  = pat.id;
    span.dataset.bsService    = pat.service;
    span.dataset.bsSeverity   = pat.severity;
    span.dataset.bsName       = pat.name;
    span.title = `BlurShield: ${pat.name} — double-click to reveal`;
    // Blur is handled by CSS class .bs-blur using --bs-blur custom property
    // No inline style needed — this allows .bs-revealed to override properly

    if (cfg.revealOnHover) {
      span.addEventListener('mouseenter', () => {
        if (!isAllRevealed) span.classList.add('bs-revealed');
      });
      span.addEventListener('mouseleave', () => {
        if (!isAllRevealed) span.classList.remove('bs-revealed');
      });
    }
    span.addEventListener('dblclick', e => {
      e.preventDefault();
      span.classList.toggle('bs-revealed');
      updateStats('reveals');
    });

    // Badge
    let badge = null;
    if (cfg.isPro) {
      badge = document.createElement('span');
      badge.className = 'bs-badge';
      badge.style.background = sev.bg;
      badge.style.color = sev.badge;
      badge.style.borderColor = sev.border;
      badge.style.border = `0.5px solid ${sev.border}`;

      const dot = document.createElement('span');
      dot.className = 'bs-badge-dot';
      dot.style.background = sev.dot;
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(pat.service));
    }

    frag.appendChild(span);
    if (badge) frag.appendChild(badge);
    if (after) frag.appendChild(document.createTextNode(after));

    const pNode = textNode.parentNode;
    pNode.replaceChild(frag, textNode);
    span.setAttribute('data-bs-processed','1');
    blurredEls.add(span);

    detectedItems.push({ patternId: pat.id, name: pat.name, service: pat.service, severity: pat.severity });
    return true;
  }

  // ── Scan container ─────────────────────────────────────────────────────
  function scanPass(root = document.body) {
    if (!cfg.enabled || !root || isDomainWhitelisted()) return 0;
    let found = 0;
    const nodes = getTextNodes(root);
    const patterns = window.BS_PATTERNS || [];

    for (const node of nodes) {
      const text = node.textContent;
      if (!text || text.trim().length < 6) continue;

      for (const pat of patterns) {
        if (pat.multiline) continue; // handled separately below
        if (!shouldRun(pat)) continue;
        if (pat.contextKeys?.length && !hasContextKey(node, pat)) continue;

        pat.pattern.lastIndex = 0;
        const m = pat.pattern.exec(text);
        pat.pattern.lastIndex = 0;

        if (m?.[0] && m[0].length >= 6) {
          if (wrapSecret(node, m[0], pat)) { found++; break; }
        }
      }
    }
    // ── Line-level scan for patterns spanning child elements ──────────────
    // Handles cases like: <span class="key">SECRET_KEY</span>=<span class="val">value</span>
    // where KEY=value spans multiple text nodes
    if (root.querySelectorAll) {
      const lineContainers = [...root.querySelectorAll(
        '.code-line, .code-text, tr, .info-row, .info-val, .progress-val, [class*="line"], [class*="row"]'
      )];

      for (const line of lineContainers) {
        if (line.closest('.bs-blur,.bs-badge') || line.hasAttribute('data-bs-processed')) continue;
        if (line.querySelector('[data-bs-processed]')) continue;
        const lineText = line.textContent;
        if (!lineText || lineText.trim().length < 8) continue;

        for (const pat of patterns) {
          if (pat.multiline) continue;
          if (!shouldRun(pat)) continue;

          pat.pattern.lastIndex = 0;
          const m = pat.pattern.exec(lineText);
          pat.pattern.lastIndex = 0;

          if (m?.[0] && m[0].length >= 6) {
            // Determine the value to blur: use capture group if available, otherwise full match
            const valueStr = m[1] || m[0];
            if (valueStr.length < 6) continue;

            // Try to find this value in a child text node and blur it
            let blurred = false;
            const childNodes = getTextNodes(line);
            for (const cNode of childNodes) {
              if (cNode.textContent.includes(valueStr)) {
                if (wrapSecret(cNode, valueStr, pat)) { found++; blurred = true; break; }
              }
            }
            if (blurred) break;
          }
        }
      }
    }

    // ── Element-level scan for multiline patterns (private keys, etc.) ──
    const multilinePatterns = patterns.filter(p => p.multiline && shouldRun(p));
    if (multilinePatterns.length > 0) {
      // Only scan leaf content containers — avoid broad wrappers like .code-block
      // which would blur headers, filenames, and labels alongside the secret.
      const containers = root.querySelectorAll
        ? [...root.querySelectorAll('pre, code, textarea')]
        : [];
      // Also include root itself if it's an element
      if (root !== document.body && root.textContent) containers.push(root);

      for (const container of containers) {
        if (container.closest('.bs-blur,.bs-badge,[data-bs-processed]')) continue;
        const fullText = container.textContent;
        if (!fullText || fullText.length < 30) continue;

        for (const pat of multilinePatterns) {
          pat.pattern.lastIndex = 0;
          const m = pat.pattern.exec(fullText);
          pat.pattern.lastIndex = 0;

          if (m?.[0]) {
            // Blur the entire container element
            if (!container.classList.contains('bs-blur') && !container.hasAttribute('data-bs-processed')) {
              const sev = window.BS_SEVERITY[pat.severity] || window.BS_SEVERITY.medium;

              container.classList.add('bs-blur');
              container.setAttribute('data-bs-processed', '1');
              container.title = `BlurShield: ${pat.name} — double-click to reveal`;
              blurredEls.add(container);

              if (cfg.revealOnHover) {
                container.addEventListener('mouseenter', () => {
                  if (!isAllRevealed) container.classList.add('bs-revealed');
                });
                container.addEventListener('mouseleave', () => {
                  if (!isAllRevealed) container.classList.remove('bs-revealed');
                });
              }
              container.addEventListener('dblclick', e => {
                e.preventDefault();
                container.classList.toggle('bs-revealed');
                updateStats('reveals');
              });

              // Add badge after the container
              if (cfg.isPro) {
                const badge = document.createElement('span');
                badge.className = 'bs-badge';
                badge.style.background = sev.bg;
                badge.style.color = sev.badge;
                badge.style.borderColor = sev.border;
                badge.style.border = `0.5px solid ${sev.border}`;
                const dot = document.createElement('span');
                dot.className = 'bs-badge-dot';
                dot.style.background = sev.dot;
                badge.appendChild(dot);
                badge.appendChild(document.createTextNode(pat.service));
                container.parentNode?.insertBefore(badge, container.nextSibling);
              }

              detectedItems.push({ patternId: pat.id, name: pat.name, service: pat.service, severity: pat.severity });
              found++;
            }
            break;
          }
        }
      }
    }

    return found;
  }

  function scan(root = document.body) {
    if (!cfg.enabled || !root || isDomainWhitelisted()) return 0;

    let totalFound = 0;
    let foundThisPass = 0;
    let pass = 0;

    do {
      foundThisPass = scanPass(root);
      totalFound += foundThisPass;
      pass++;
    } while (foundThisPass > 0 && pass < SCAN_PASS_LIMIT);

    return totalFound;
  }

  function addPrecheckItem(items, seen, pat, matchValue) {
    const value = (matchValue || '').trim();
    if (!value || value.length < 6) return false;

    const key = `${pat.id}:${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    items.push({ patternId: pat.id, name: pat.name, service: pat.service, severity: pat.severity });
    return items.length >= PRECHECK_ITEM_LIMIT;
  }

  function collectDryScanItems(root = document.body) {
    if (!root) return [];

    const items = [];
    const seen = new Set();
    const patterns = window.BS_PATTERNS || [];
    const pushMatch = (pat, value) => addPrecheckItem(items, seen, pat, value);

    const textNodes = getTextNodes(root);
    for (const node of textNodes) {
      const text = node.textContent;
      if (!text || text.trim().length < 6) continue;

      for (const pat of patterns) {
        if (pat.multiline) continue;
        if (!shouldRun(pat)) continue;
        if (pat.contextKeys?.length && !hasContextKey(node, pat)) continue;

        pat.pattern.lastIndex = 0;
        let match;
        while ((match = pat.pattern.exec(text))) {
          if (pushMatch(pat, match[1] || match[0])) return items;
          if (!pat.pattern.global) break;
        }
        pat.pattern.lastIndex = 0;
      }
    }

    if (root.querySelectorAll) {
      const lineContainers = [...root.querySelectorAll(
        '.code-line, .code-text, tr, .info-row, .info-val, .progress-val, [class*="line"], [class*="row"]'
      )];

      for (const line of lineContainers) {
        if (line.closest('.bs-blur,.bs-badge') || line.hasAttribute('data-bs-processed')) continue;
        if (line.querySelector('[data-bs-processed]')) continue;
        const lineText = line.textContent;
        if (!lineText || lineText.trim().length < 8) continue;

        for (const pat of patterns) {
          if (pat.multiline) continue;
          if (!shouldRun(pat)) continue;

          pat.pattern.lastIndex = 0;
          let match;
          while ((match = pat.pattern.exec(lineText))) {
            if (pushMatch(pat, match[1] || match[0])) return items;
            if (!pat.pattern.global) break;
          }
          pat.pattern.lastIndex = 0;
        }
      }

      const multilinePatterns = patterns.filter(p => p.multiline && shouldRun(p));
      if (multilinePatterns.length) {
        const containers = [...root.querySelectorAll('pre, .code-body, .code-block, [class*="code"], [class*="snippet"]')];
        if (root !== document.body && root.textContent) containers.push(root);

        for (const container of containers) {
          if (container.closest('.bs-blur,.bs-badge,[data-bs-processed]')) continue;
          const fullText = container.textContent;
          if (!fullText || fullText.length < 30) continue;

          for (const pat of multilinePatterns) {
            pat.pattern.lastIndex = 0;
            const match = pat.pattern.exec(fullText);
            pat.pattern.lastIndex = 0;
            if (match?.[0] && pushMatch(pat, match[0])) return items;
          }
        }
      }
    }

    return items;
  }

  function buildDetectedItemsReport() {
    const whitelisted = isDomainWhitelisted();
    const protectionActive = hasActiveAccess && cfg.enabled && !whitelisted && !isAllRevealed;

    const hasRevealedElements = !!document.querySelector('.bs-blur.bs-revealed, .bs-zone-selected.bs-revealed');
    const isFullyProtected = protectionActive && !hasRevealedElements;

    if (protectionActive) {
      setBlurIntensity(cfg.blurIntensity);
      // NOTE: do NOT call rescanProtection() here.
      // This function is invoked every time the popup opens or a pre-recording
      // check fires. Rescanning on every call causes visible DOM flicker and
      // wastes CPU. The MutationObserver + init() already handle scanning at
      // the right times.
    }

    const items = protectionActive
      ? [...detectedItems]
      : detectedItems.length
        ? [...detectedItems]
        : collectDryScanItems();

    if (!items.length) {
      return {
        state: 'clean',
        reason: '',
        items: [],
        count: 0,
        enabled: cfg.enabled,
        whitelisted,
        allRevealed: isAllRevealed,
        protectionActive: isFullyProtected
      };
    }

    let reason = 'Sensitive data is visible on this tab';
    if (!hasActiveAccess) reason = 'BlurShield access is inactive on this tab';
    else if (!cfg.enabled) reason = 'Protection is paused on this tab';
    else if (whitelisted) reason = 'This domain is whitelisted';
    else if (isAllRevealed) reason = 'Secrets are currently revealed on this tab';
    else if (hasRevealedElements) reason = 'Some secrets are temporarily revealed on this tab';

    return {
      state: isFullyProtected ? 'protected' : 'exposed',
      reason: isFullyProtected ? 'BlurShield is already protecting this tab' : reason,
      items,
      count: items.length,
      enabled: cfg.enabled,
      whitelisted,
      allRevealed: isAllRevealed,
      protectionActive: isFullyProtected
    };
  }

  // ── Remove all blurs ───────────────────────────────────────────────────
  function normalizeZoneText(text = '') {
    return text.replace(/\s+/g, ' ').trim();
  }

  function getZoneTextSample(el) {
    return normalizeZoneText(el?.innerText || el?.textContent || '').slice(0, ZONE_TEXT_LIMIT);
  }

  function getStableClassList(el) {
    return [...(el?.classList || [])]
      .filter(cls => cls && !cls.startsWith('bs-') && cls.length <= 48)
      .slice(0, 4);
  }

  function getElementPath(el) {
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      const parent = current.parentElement;
      if (!parent) break;
      path.unshift([...parent.children].indexOf(current));
      current = parent;
    }
    return path;
  }

  function resolveElementPath(path) {
    if (!Array.isArray(path) || !path.length) return null;
    let current = document.body;
    for (const index of path) {
      if (typeof index !== 'number' || index < 0 || index >= current.children.length) return null;
      current = current.children[index];
    }
    return current;
  }

  function getElementAttr(el, attr) {
    return el?.getAttribute?.(attr) || '';
  }

  function buildAttrSelector(tagName, attr, value) {
    if (!tagName || !attr || !value) return '';
    return `${tagName}[${attr}="${CSS.escape(value)}"]`;
  }

  function safeQuery(selector, root = document) {
    if (!selector) return null;
    try { return root.querySelector(selector); } catch { return null; }
  }

  function getStableElementSelector(el) {
    if (!el?.tagName) return '';
    const tagName = el.tagName.toLowerCase();
    if (el.id) return `#${CSS.escape(el.id)}`;

    const attrs = ['data-testid', 'data-qa', 'data-cy', 'aria-label', 'name'];
    for (const attr of attrs) {
      const value = getElementAttr(el, attr);
      if (!value) continue;
      const selector = buildAttrSelector(tagName, attr, value);
      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch {}
    }

    const classes = getStableClassList(el);
    if (!classes.length) return '';
    const selector = `${tagName}${classes.slice(0, 2).map(cls => `.${CSS.escape(cls)}`).join('')}`;
    try {
      const count = document.querySelectorAll(selector).length;
      return count >= 1 && count <= 5 ? selector : '';
    } catch {
      return '';
    }
  }

  function getAnchorSelector(el) {
    let current = el?.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < ZONE_ANCHOR_DEPTH) {
      const selector = getStableElementSelector(current);
      if (selector) return selector;
      current = current.parentElement;
      depth++;
    }
    return '';
  }

  function createZoneId() {
    return `zone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function buildZoneDescriptor(el, existing = {}) {
    return {
      ...existing,
      zoneId: existing.zoneId || createZoneId(),
      selector: getUniqueSelector(el),
      domain: existing.domain || domain,
      timestamp: existing.timestamp || Date.now(),
      tagName: el.tagName?.toLowerCase() || '',
      id: el.id || '',
      classes: getStableClassList(el),
      textSample: getZoneTextSample(el),
      path: getElementPath(el),
      anchorSelector: getAnchorSelector(el),
      role: getElementAttr(el, 'role'),
      ariaLabel: getElementAttr(el, 'aria-label'),
      name: getElementAttr(el, 'name'),
      type: getElementAttr(el, 'type')
    };
  }

  function needsZoneMigration(zone) {
    return !zone?.zoneId ||
      !zone?.tagName ||
      !Array.isArray(zone?.classes) ||
      !Array.isArray(zone?.path) ||
      typeof zone?.textSample !== 'string' ||
      typeof zone?.anchorSelector !== 'string';
  }

  function comparePathSimilarity(currentPath, savedPath) {
    if (!Array.isArray(currentPath) || !Array.isArray(savedPath) || !currentPath.length || !savedPath.length) return 0;
    let samePrefix = 0;
    const max = Math.min(currentPath.length, savedPath.length);
    for (let i = 0; i < max; i++) {
      if (currentPath[i] !== savedPath[i]) break;
      samePrefix++;
    }
    if (samePrefix === currentPath.length && samePrefix === savedPath.length) return 20;
    return Math.round((samePrefix / Math.max(currentPath.length, savedPath.length)) * 12);
  }

  function scoreZoneCandidate(el, zone, anchorEl = null) {
    if (!el?.tagName) return -Infinity;
    let score = 0;
    const tagName = el.tagName.toLowerCase();

    if (zone.tagName) {
      if (tagName !== zone.tagName) return -Infinity;
      score += 20;
    }

    if (zone.id) {
      if (el.id === zone.id) score += 60;
      else if (el.id) score -= 20;
    }

    if (zone.textSample) {
      const text = getZoneTextSample(el);
      if (text === zone.textSample) score += 40;
      else if (text && (text.includes(zone.textSample) || zone.textSample.includes(text))) score += 25;
    }

    if (Array.isArray(zone.classes) && zone.classes.length) {
      const classSet = new Set([...el.classList]);
      const overlap = zone.classes.filter(cls => classSet.has(cls)).length;
      score += overlap * 8;
    }

    if (zone.role && getElementAttr(el, 'role') === zone.role) score += 6;
    if (zone.ariaLabel && getElementAttr(el, 'aria-label') === zone.ariaLabel) score += 10;
    if (zone.name && getElementAttr(el, 'name') === zone.name) score += 10;
    if (zone.type && getElementAttr(el, 'type') === zone.type) score += 4;
    if (anchorEl && anchorEl.contains(el)) score += 12;
    if (Array.isArray(zone.path)) score += comparePathSimilarity(getElementPath(el), zone.path);

    return score;
  }

  function collectZoneCandidates(zone, root = document) {
    const candidates = [];
    const seen = new Set();
    const tagName = zone.tagName || '*';
    const selectors = [];

    const pushCandidate = (el) => {
      if (!el || seen.has(el)) return;
      if (el.closest?.('.bs-toast,.bs-badge,.bs-recording-banner')) return;
      seen.add(el);
      candidates.push(el);
    };

    if (zone.id) pushCandidate(document.getElementById(zone.id));

    if (Array.isArray(zone.classes) && zone.classes.length) {
      selectors.push(`${tagName}${zone.classes.slice(0, 2).map(cls => `.${CSS.escape(cls)}`).join('')}`);
    }
    if (zone.ariaLabel) selectors.push(buildAttrSelector(tagName, 'aria-label', zone.ariaLabel));
    if (zone.name) selectors.push(buildAttrSelector(tagName, 'name', zone.name));
    if (zone.type) selectors.push(buildAttrSelector(tagName, 'type', zone.type));
    selectors.push(tagName);

    for (const selector of selectors) {
      if (!selector) continue;
      let found = [];
      try { found = [...root.querySelectorAll(selector)]; } catch {}
      for (const el of found) {
        pushCandidate(el);
        if (candidates.length >= ZONE_CANDIDATE_LIMIT) return candidates;
      }
    }

    return candidates;
  }

  function findBestZoneCandidate(zone, anchorEl = null) {
    let bestCandidate = null;
    let bestScore = -Infinity;
    const searchRoots = anchorEl ? [anchorEl, document] : [document];

    for (const root of searchRoots) {
      const scopeAnchor = root === anchorEl ? anchorEl : null;
      const candidates = collectZoneCandidates(zone, root);
      for (const candidate of candidates) {
        const score = scoreZoneCandidate(candidate, zone, scopeAnchor);
        if (score > bestScore) {
          bestCandidate = candidate;
          bestScore = score;
        }
      }
      if (bestScore >= 40) break;
    }

    return bestScore >= 30 ? bestCandidate : null;
  }

  function resolveZoneElement(zone) {
    if (!zone) return { element: null, resolvedBy: 'none' };

    const anchorEl = zone.anchorSelector ? safeQuery(zone.anchorSelector) : null;

    if (zone.selector) {
      const exact = safeQuery(zone.selector);
      if (exact) {
        if (!zone.tagName || scoreZoneCandidate(exact, zone, anchorEl) >= 24) {
          return { element: exact, resolvedBy: 'selector' };
        }
      }
    }

    const fromPath = resolveElementPath(zone.path);
    if (fromPath && (!zone.tagName || scoreZoneCandidate(fromPath, zone, anchorEl) >= 24)) {
      return { element: fromPath, resolvedBy: 'path' };
    }

    if (!zone.tagName && zone.id) {
      const byId = document.getElementById(zone.id);
      if (byId) return { element: byId, resolvedBy: 'id' };
    }

    const fallback = zone.tagName ? findBestZoneCandidate(zone, anchorEl) : null;
    return { element: fallback, resolvedBy: fallback ? 'fuzzy' : 'none' };
  }

  function findSavedZoneForElement(el) {
    const zoneId = el?.dataset?.bsZoneId;
    const zones = cfg.customZones || [];
    if (zoneId) return zones.find(zone => zone.zoneId === zoneId) || null;

    const selector = getUniqueSelector(el);
    return zones.find(zone => (zone.domain === domain || !zone.domain) && zone.selector === selector) || null;
  }

  function getCustomZoneCount() {
    return document.querySelectorAll('.bs-zone-selected').length;
  }

  function getProtectedCount() {
    return detectedItems.length + getCustomZoneCount();
  }

  function getStatusPayload() {
    return {
      count: getProtectedCount(),
      items: detectedItems,
      domain,
      allRevealed: isAllRevealed,
      meetingMode: isMeetingMode
    };
  }

  function highlightDetectedItems() {
    const report = buildDetectedItemsReport();
    const targets = [...document.querySelectorAll('.bs-blur, .bs-zone-selected')];

    document.querySelectorAll('.bs-precheck-focus').forEach(el => el.classList.remove('bs-precheck-focus'));

    if (!targets.length) {
      showToast(report.reason || 'No BlurShield items are highlighted on this tab yet', 'info');
      return { ok: false, count: report.count, reason: report.reason };
    }

    const focusTargets = targets.slice(0, 200);
    focusTargets.forEach(el => el.classList.add('bs-precheck-focus'));
    try {
      focusTargets[0]?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch {}

    showToast(`Review ${focusTargets.length} protected item${focusTargets.length !== 1 ? 's' : ''} on this tab`, 'info');
    window.clearTimeout(window._bsPrecheckHighlightTimer);
    window._bsPrecheckHighlightTimer = window.setTimeout(() => {
      focusTargets.forEach(el => el.classList.remove('bs-precheck-focus'));
    }, 5000);

    return { ok: true, count: report.count };
  }

  function markCustomZone(el, zoneId = '') {
    if (!el) return;
    el.classList.add('bs-zone-selected');
    el.classList.toggle('bs-revealed', isAllRevealed);
    if (zoneId) el.dataset.bsZoneId = zoneId;
    else el.removeAttribute('data-bs-zone-id');

    // Double-click to reveal/hide (same as pattern-detected blurs)
    if (!el._bsZoneDblclick) {
      el.addEventListener('dblclick', e => {
        e.preventDefault();
        el.classList.toggle('bs-revealed');
      });
      el._bsZoneDblclick = true;
    }

    // Hover reveal if enabled
    if (cfg.revealOnHover && !el._bsZoneHover) {
      el.addEventListener('mouseenter', () => {
        if (!isAllRevealed) el.classList.add('bs-revealed');
      });
      el.addEventListener('mouseleave', () => {
        if (!isAllRevealed) el.classList.remove('bs-revealed');
      });
      el._bsZoneHover = true;
    }
  }

  function applyRevealState(revealed) {
    isAllRevealed = !!revealed;
    document.querySelectorAll('.bs-blur, .bs-zone-selected').forEach(el => {
      el.classList.toggle('bs-revealed', isAllRevealed);
    });
  }

  function clearDetectedBlurs() {
    const parentsToNormalize = new Set();
    document.querySelectorAll('.bs-blur').forEach(el => {
      if (el.tagName === 'SPAN' && el.dataset.bsPatternId) {
        // Text-node blur span: replace with original text
        if (el.parentNode) parentsToNormalize.add(el.parentNode);
        const text = document.createTextNode(el.textContent);
        el.replaceWith(text);
      } else {
        // Container-level blur (multiline patterns): just remove the class
        el.classList.remove('bs-blur', 'bs-revealed');
        el.removeAttribute('title');
      }
    });
    document.querySelectorAll('.bs-badge').forEach(el => el.remove());
    document.querySelectorAll('[data-bs-processed]').forEach(el => el.removeAttribute('data-bs-processed'));
    parentsToNormalize.forEach(parent => parent.normalize?.());
    detectedItems = [];
  }

  function clearCustomZoneBlurs() {
    document.querySelectorAll('.bs-zone-selected').forEach(el => {
      el.classList.remove('bs-zone-selected', 'bs-revealed');
      el.removeAttribute('data-bs-zone-id');
      el.style.removeProperty('filter');
    });
  }

  function clearAll() {
    isAllRevealed = false;
    clearDetectedBlurs();
    clearCustomZoneBlurs();
  }

  function rescanProtection() {
    clearDetectedBlurs();
    clearCustomZoneBlurs();
    if (!cfg.enabled || isDomainWhitelisted()) return 0;
    const count = scan();
    applyCustomZones();
    applyRevealState(isAllRevealed);
    return count;
  }

  function syncBadge(count = getProtectedCount(), off = false) {
    try {
      chrome.runtime.sendMessage({ action: 'updateBadge', count, off }, () => {
        void chrome.runtime.lastError; // suppress unchecked error
      });
    } catch {}
  }

  function removeZoneToast() {
    document.querySelector('.bs-toast[data-bs-toast-type="zone"]')?.remove();
  }

  // ── Custom zone selector ───────────────────────────────────────────────
  function startZoneSelector() {
    if (isErasingZone) endZoneEraser();
    if (isSelectingZone) endZoneSelector();
    isSelectingZone = true;
    document.body.classList.add('bs-selecting');
    showToast('Click any element to blur it. Press Esc or click close to cancel.', 'zone');
    try { window.focus(); } catch {}

    const hover = e => {
      document.querySelectorAll('.bs-zone-hover').forEach(el => el.classList.remove('bs-zone-hover'));
      if (!e.target.closest('.bs-toast,.bs-badge,.bs-recording-banner')) {
        e.target.classList.add('bs-zone-hover');
      }
    };
    const click = e => {
      const el = e.target.closest(':not(.bs-toast):not(.bs-badge)');
      if (!el) return;
      e.preventDefault(); e.stopPropagation();
      el.classList.remove('bs-zone-hover');

      // Save zone
      const existingZone = findSavedZoneForElement(el);
      const zones = cfg.customZones || [];
      if (!existingZone && !cfg.isPro && zones.length >= 3) {
        showToast('Trial limit reached: Max 3 custom zones. Upgrade to Pro for unlimited.', 'info');
        endZoneSelector();
        return;
      }
      const zoneRecord = buildZoneDescriptor(el, existingZone || {});
      markCustomZone(el, zoneRecord.zoneId);
      // Blur handled by CSS classes .bs-zone-selected and .bs-revealed using --bs-blur
      if (existingZone) {
        if (needsZoneMigration(existingZone)) {
          const nextZones = zones.map(zone => zone === existingZone ? zoneRecord : zone);
          cfg.customZones = nextZones;
          chrome.storage.sync.set({ customZones: nextZones }, () => {
            if (chrome.runtime.lastError) console.error('BlurShield: Error saving zone', chrome.runtime.lastError);
          });
        }
      } else {
        const nextZones = [...zones, zoneRecord];
        cfg.customZones = nextZones;
        chrome.storage.sync.set({ customZones: nextZones }, () => {
          if (chrome.runtime.lastError) console.error('BlurShield: Error saving zone', chrome.runtime.lastError);
        });
      }

      // Continuous mode: Do not end selector on click
      syncBadge();
    };
    const escape = e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      endZoneSelector();
    };

    document.addEventListener('mouseover', hover);
    document.addEventListener('click', click, true);
    window.addEventListener('keydown', escape, true);

    window._bsZoneCleanup = () => {
      document.removeEventListener('mouseover', hover);
      document.removeEventListener('click', click, true);
      window.removeEventListener('keydown', escape, true);
    };
  }

  function endZoneSelector() {
    isSelectingZone = false;
    document.body.classList.remove('bs-selecting');
    document.querySelectorAll('.bs-zone-hover').forEach(el => el.classList.remove('bs-zone-hover'));
    window._bsZoneCleanup?.();
    window._bsZoneCleanup = null;
    removeZoneToast();
  }

  // ── Custom zone eraser ─────────────────────────────────────────────────
  function startZoneEraser() {
    if (isErasingZone) endZoneEraser();
    if (isSelectingZone) endZoneSelector();
    isErasingZone = true;
    document.body.classList.add('bs-erasing');
    showToast('Click a custom blurred element to unblur it. Press Esc to cancel.', 'zone');
    try { window.focus(); } catch {}

    const hover = e => {
      document.querySelectorAll('.bs-zone-hover-erase').forEach(el => el.classList.remove('bs-zone-hover-erase'));
      const el = e.target.closest('.bs-zone-selected');
      if (el) el.classList.add('bs-zone-hover-erase');
    };
    const click = e => {
      const el = e.target.closest('.bs-zone-selected');
      if (!el) {
        // Cancel if clicked completely outside
        if (!e.target.closest('.bs-toast')) {
          e.preventDefault(); e.stopPropagation();
          endZoneEraser();
        }
        return;
      }
      e.preventDefault(); e.stopPropagation();
      const zoneId = el.dataset.bsZoneId;
      const selector = getUniqueSelector(el);
      el.classList.remove('bs-zone-hover-erase');
      el.classList.remove('bs-zone-selected', 'bs-revealed');
      el.removeAttribute('data-bs-zone-id');
      el.style.removeProperty('filter');
      
      const zones = cfg.customZones || [];
      const newZones = zones.filter(zone => {
        if (zone.domain && zone.domain !== domain) return true;
        if (zoneId && zone.zoneId) return zone.zoneId !== zoneId;
        return zone.selector !== selector;
      });
      cfg.customZones = newZones;
      chrome.storage.sync.set({ customZones: newZones }, () => {
        if (chrome.runtime.lastError) console.error('BlurShield: Error removing zone', chrome.runtime.lastError);
      });

      // Continuous mode: Do not end eraser on click
      syncBadge();
    };
    const escape = e => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      endZoneEraser();
    };

    document.addEventListener('mouseover', hover);
    document.addEventListener('click', click, true);
    window.addEventListener('keydown', escape, true);

    window._bsZoneEraseCleanup = () => {
      document.removeEventListener('mouseover', hover);
      document.removeEventListener('click', click, true);
      window.removeEventListener('keydown', escape, true);
    };
  }

  function endZoneEraser() {
    isErasingZone = false;
    document.body.classList.remove('bs-erasing');
    document.querySelectorAll('.bs-zone-hover-erase').forEach(el => el.classList.remove('bs-zone-hover-erase'));
    window._bsZoneEraseCleanup?.();
    window._bsZoneEraseCleanup = null;
    removeZoneToast();
  }

  // ── Apply saved custom zones ───────────────────────────────────────────
  function applyCustomZones() {
    const zones = cfg.customZones || [];
    let updated = false;
    const nextZones = zones.map(zone => {
      if (zone.domain && zone.domain !== domain) return zone;

      const { element, resolvedBy } = resolveZoneElement(zone);
      if (!element) return zone;

      let nextZone = zone;
      if (needsZoneMigration(zone) || resolvedBy !== 'selector') {
        nextZone = buildZoneDescriptor(element, zone);
        updated = true;
      }

      markCustomZone(element, nextZone.zoneId);
      return nextZone;
    });

    if (updated) {
      cfg.customZones = nextZones;
      chrome.storage.sync.set({ customZones: nextZones }, () => {
        if (chrome.runtime.lastError) console.error('BlurShield: Error applying custom zones', chrome.runtime.lastError);
      });
    }
  }

  // ── Get unique CSS selector for element ───────────────────────────────
  function getUniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let sel = current.tagName.toLowerCase();
      if (current.className) {
        const cls = [...current.classList].filter(c => !c.startsWith('bs-')).slice(0,2).join('.');
        if (cls) sel += '.' + cls;
      }
      const siblings = current.parentElement?.children;
      if (siblings && siblings.length > 1) {
        const idx = [...siblings].indexOf(current) + 1;
        sel += `:nth-child(${idx})`;
      }
      parts.unshift(sel);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  // ── Recording detection ────────────────────────────────────────────────
  function detectRecording() {
    if (!cfg.isPro || recordingDetectionStarted) return;
    recordingDetectionStarted = true;

    // Detect via screen capture API state change
    navigator.mediaDevices?.addEventListener?.('devicechange', checkMediaState);

    // Watch for common recording indicators in the DOM
    const recObs = new MutationObserver(() => {
      const hasRecordingUI = document.querySelector('[class*="record"],[class*="Record"],[id*="record"],[id*="Record"]');
      if (hasRecordingUI && !recordingBanner) showRecordingBanner();
    });
    recObs.observe(document.body, { childList: true, subtree: true, attributeFilter: ['class','id'] });

    // Listen from background script
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.action === 'recording-started') showRecordingBanner();
      if (msg.action === 'recording-stopped') hideRecordingBanner();
    });
  }

  function showRecordingBanner() {
    if (!cfg.isPro || cfg.showBanner === false || recordingBanner) return;
    recordingBanner = document.createElement('div');
    recordingBanner.className = 'bs-recording-banner';
    recordingBanner.innerHTML = `<div class="bs-rec-dot"></div>BlurShield active — ${detectedItems.length} secret${detectedItems.length !== 1 ? 's' : ''} protected`;
    document.body.appendChild(recordingBanner);
  }

  function hideRecordingBanner() {
    recordingBanner?.remove();
    recordingBanner = null;
  }

  function checkMediaState() {
    if (cfg.showBanner === false) {
      hideRecordingBanner();
      return;
    }
    navigator.mediaDevices?.enumerateDevices?.().then(devices => {
      const capturing = devices.some(d => d.label.includes('screen') || d.label.includes('capture'));
      if (capturing) showRecordingBanner();
      else hideRecordingBanner();
    }).catch(() => {});
  }

  // ── Stats tracking ─────────────────────────────────────────────────────
  async function updateStats(type, amount = 1) {
    const today = new Date().toISOString().slice(0,10);
    const { stats = {} } = await new Promise(res => chrome.storage.local.get({ stats: {} }, res));
    if (!stats[today]) stats[today] = { scanned: 0, blurred: 0, reveals: 0 };
    stats[today][type] = (stats[today][type] || 0) + amount;
    chrome.storage.local.set({ stats });
  }

  // ── Toast ──────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, type = 'info', items = []) {
    if (type !== 'zone' && cfg.showToasts === false) return;
    document.querySelector('.bs-toast')?.remove();
    clearTimeout(toastTimer);

    const toast = document.createElement('div');
    toast.className = 'bs-toast';
    toast.dataset.bsToastType = type;

    const icon = type === 'zone' ? '✎' : '🛡';
    const grouped = {};
    items.forEach(i => { grouped[i.severity] = (grouped[i.severity]||0)+1; });

    const pillsHTML = Object.entries(grouped).map(([sev, cnt]) => {
      const s = window.BS_SEVERITY[sev];
      return `<span class="bs-toast-pill" style="background:${s.bg};color:${s.badge};border-color:${s.border}">${s.label}: ${cnt}</span>`;
    }).join('');

    toast.innerHTML = `
      <div class="bs-toast-row">
        <div class="bs-toast-icon">${icon}</div>
        <div style="flex:1">
          <div class="bs-toast-title">BlurShield</div>
          <div class="bs-toast-sub">${msg}</div>
        </div>
        <button class="bs-toast-close" type="button" aria-label="Close">×</button>
      </div>
      ${pillsHTML ? `<div class="bs-toast-pills">${pillsHTML}</div>` : ''}
    `;
    toast.querySelector('.bs-toast-close')?.addEventListener('click', () => {
      toast.remove();
      if (type === 'zone') {
        if (isErasingZone) endZoneEraser();
        else endZoneSelector();
      }
    });
    document.body.appendChild(toast);
    if (type !== 'zone') toastTimer = setTimeout(() => toast?.remove(), 6000);
  }

  // ── Meeting Mode — blur ALL visible text instantly ────────────────────
  function enterMeetingMode() {
    isMeetingMode = true;
    document.documentElement.classList.add('bs-meeting-mode');
    if (!meetingBanner) {
      meetingBanner = document.createElement('div');
      meetingBanner.className = 'bs-recording-banner bs-meeting-banner';
      meetingBanner.innerHTML = `<div class="bs-rec-dot" style="background:#ef4444"></div>🎥 Meeting Mode — all content blurred <button id="bs-exit-meeting" style="margin-left:8px;background:rgba(255,255,255,0.15);border:none;color:#fff;cursor:pointer;padding:2px 8px;border-radius:4px;font-size:11px">Exit</button>`;
      document.body.appendChild(meetingBanner);
      document.getElementById('bs-exit-meeting')?.addEventListener('click', exitMeetingMode);
    }
  }

  function exitMeetingMode() {
    isMeetingMode = false;
    document.documentElement.classList.remove('bs-meeting-mode');
    meetingBanner?.remove();
    meetingBanner = null;
  }

  // ── Clipboard Guard ────────────────────────────────────────────────────
  function initClipboardGuard() {
    document.addEventListener('copy', () => {
      if (!cfg.enabled) return;
      try {
        const selected = window.getSelection()?.toString() || '';
        if (!selected || selected.length < 6) return;
        const patterns = window.BS_PATTERNS || [];
        lastCopiedSecrets = [];
        let toastFired = false;
        for (const pat of patterns) {
          if (pat.multiline) continue;
          pat.pattern.lastIndex = 0;
          const m = pat.pattern.exec(selected);
          pat.pattern.lastIndex = 0;
          if (m?.[0]) {
            lastCopiedSecrets.push({
              name: pat.name,
              service: pat.service,
              severity: pat.severity,
              matchedValue: m[0],
              sample: m[0].slice(0, 4) + '••••'
            });
            if (!toastFired) {
              showToast(`⚠️ Sensitive data copied: ${pat.name}`, 'info');
              toastFired = true;
            }
          }
        }
      } catch {
        lastCopiedSecrets = [];
      }
    });
  }

  // ── Paste Guard ────────────────────────────────────────────────────────
  // Intercepts paste events and warns when a secret is being pasted into
  // an untrusted context. All processing is local — nothing leaves the browser.

  /** Run a quick scan of arbitrary text against all active BS_PATTERNS. */
  function detectSecretsInText(text) {
    if (!text || text.length < 6) return [];
    const patterns = window.BS_PATTERNS || [];
    const matches = [];
    for (const pat of patterns) {
      // Respect user toggles for paste scanning just like visual blurring
      if (!shouldRun(pat)) continue;

      pat.pattern.lastIndex = 0;
      const m = pat.pattern.exec(text);
      pat.pattern.lastIndex = 0;
      if (m?.[0]) {
        matches.push({
          name: pat.name,
          service: pat.service,
          severity: pat.severity,
          matchedValue: m[0],
          sample: m[0].slice(0, 4) + '••••'
        });
      }
    }
    return matches;
  }

  /** Insert text into the active input / textarea / contenteditable element. */
  function insertTextAtCaret(el, text, selStart, selEnd) {
    if (!text || !el) return;
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.focus();
        const start = typeof selStart === 'number' ? selStart : (el.selectionStart ?? el.value.length);
        const end   = typeof selEnd   === 'number' ? selEnd   : (el.selectionEnd   ?? el.value.length);
        if (typeof el.setRangeText === 'function') {
          el.setRangeText(text, start, end, 'end');
        } else {
          el.value = el.value.slice(0, start) + text + el.value.slice(end);
          el.selectionStart = el.selectionEnd = start + text.length;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        if (!document.execCommand('insertText', false, text)) {
          const sel = window.getSelection();
          if (sel?.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(document.createTextNode(text));
            range.collapse(false);
          } else {
            el.textContent += text;
          }
        }
      }
    } catch {
      // Silently fail — never crash the host page
    }
  }

  /** Replace every matched secret value in `originalText` with [REDACTED]. */
  function buildRedactedText(originalText, matches) {
    let result = originalText;
    for (const m of matches) {
      try { result = result.split(m.matchedValue).join('[REDACTED]'); } catch {}
    }
    return result;
  }

  /** Escape user-sourced strings before embedding in the modal HTML. */
  function escapeModalHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const BS_PASTE_STYLE_ID   = 'bs-paste-modal-style';
  const BS_PASTE_OVERLAY_ID = 'bs-paste-modal-overlay';

  function ensurePasteModalStyles() {
    if (document.getElementById(BS_PASTE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = BS_PASTE_STYLE_ID;
    style.textContent = `
      #${BS_PASTE_OVERLAY_ID}{
        position:fixed;inset:0;z-index:2147483647;
        background:rgba(3,6,13,0.78);backdrop-filter:blur(5px);
        display:flex;align-items:center;justify-content:center;
        font-family:'Segoe UI Variable','Segoe UI','Helvetica Neue',sans-serif;
      }
      #${BS_PASTE_OVERLAY_ID} *{box-sizing:border-box}
      .bs-pm-card{
        width:min(440px,calc(100vw - 32px));
        background:linear-gradient(180deg,#111118 0%,#0b0b10 100%);
        border:1px solid rgba(239,68,68,0.32);
        border-radius:16px;
        box-shadow:0 20px 60px rgba(0,0,0,0.65),0 0 0 1px rgba(255,255,255,0.03) inset;
        padding:20px;color:#e4e4f0;
        animation:bs-pm-in 0.22s cubic-bezier(0.16,1,0.3,1);
      }
      @keyframes bs-pm-in{
        from{transform:translateY(14px) scale(0.96);opacity:0}
        to{transform:none;opacity:1}
      }
      .bs-pm-header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
      .bs-pm-icon{
        width:36px;height:36px;border-radius:10px;
        background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);
        display:flex;align-items:center;justify-content:center;
        font-size:17px;flex-shrink:0;
      }
      .bs-pm-title{font-size:15px;font-weight:600;color:#fff;margin:0}
      .bs-pm-sub{font-size:11px;color:#8b8ba6;margin:2px 0 0}
      .bs-pm-secret{
        background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.18);
        border-radius:10px;padding:11px 13px;margin-bottom:12px;
      }
      .bs-pm-secret-label{
        font-size:10px;font-weight:700;text-transform:uppercase;
        letter-spacing:0.06em;color:#8b8ba6;margin-bottom:5px;
      }
      .bs-pm-secret-name{font-size:13px;font-weight:600;color:#fca5a5;margin-bottom:5px}
      .bs-pm-secret-preview{
        font-family:'Cascadia Mono','Consolas','SF Mono',monospace;font-size:12px;
        color:#94a3b8;background:rgba(0,0,0,0.3);padding:3px 8px;border-radius:5px;
      }
      .bs-pm-target{font-size:11px;color:#8b8ba6;margin-bottom:16px}
      .bs-pm-target strong{color:#c0c0d4;font-weight:500}
      .bs-pm-actions{display:flex;gap:8px}
      .bs-pm-btn{
        flex:1;border:none;border-radius:10px;padding:11px 8px;
        cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;
        transition:transform 0.12s ease,opacity 0.12s ease;
      }
      .bs-pm-btn:hover{transform:translateY(-1px)}
      .bs-pm-btn:active{transform:none;opacity:0.85}
      .bs-pm-btn:focus-visible{outline:2px solid #1D9E75;outline-offset:2px}
      .bs-pm-btn-allow{background:#1D9E75;color:#fff}
      .bs-pm-btn-redact{background:#2d1b00;color:#fcd34d;border:1px solid #78350f}
      .bs-pm-btn-cancel{background:#1e1e2e;color:#94a3b8;border:1px solid rgba(255,255,255,0.08)}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function removePasteModal() {
    document.getElementById(BS_PASTE_OVERLAY_ID)?.remove();
  }

  /**
   * Show the paste-warning modal.
   * @param {Array}  matches      - Detected secret descriptors
   * @param {Element} targetEl   - The element the user was pasting into
   * @param {string}  origText   - The full clipboard text (may be '')
   * @param {number|null} selStart - Saved selectionStart (input/textarea)
   * @param {number|null} selEnd   - Saved selectionEnd (input/textarea)
   */
  function showPasteWarningModal(matches, targetEl, origText, selStart, selEnd) {
    ensurePasteModalStyles();
    removePasteModal();

    const primary   = matches[0];
    const moreCount = matches.length - 1;
    const moreHtml  = moreCount > 0
      ? ` <span style="font-size:10px;color:#8b8ba6;font-weight:400">+${moreCount} more type${moreCount > 1 ? 's' : ''}</span>`
      : '';

    const overlay = document.createElement('div');
    overlay.id = BS_PASTE_OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'bs-pm-title-el');

    overlay.innerHTML = `
      <div class="bs-pm-card">
        <div class="bs-pm-header">
          <div class="bs-pm-icon">⚠️</div>
          <div>
            <p class="bs-pm-title" id="bs-pm-title-el">Paste Warning</p>
            <p class="bs-pm-sub">BlurShield detected a secret in your clipboard</p>
          </div>
        </div>
        <div class="bs-pm-secret">
          <div class="bs-pm-secret-label">Detected secret</div>
          <div class="bs-pm-secret-name">${escapeModalHtml(primary.name)}${moreHtml}</div>
          <span class="bs-pm-secret-preview">${escapeModalHtml(primary.sample)}</span>
        </div>
        <p class="bs-pm-target">Pasting into: <strong>${escapeModalHtml(location.hostname || 'this page')}</strong></p>
        <div class="bs-pm-actions">
          <button class="bs-pm-btn bs-pm-btn-allow" id="bs-pm-allow" type="button">Allow paste</button>
          <button class="bs-pm-btn bs-pm-btn-redact" id="bs-pm-redact" type="button">Redact</button>
          <button class="bs-pm-btn bs-pm-btn-cancel" id="bs-pm-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;

    const cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      removePasteModal();
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    };
    window.addEventListener('keydown', onKey, true);

    overlay.querySelector('#bs-pm-allow').addEventListener('click', () => {
      cleanup();
      if (origText) insertTextAtCaret(targetEl, origText, selStart, selEnd);
    });

    overlay.querySelector('#bs-pm-redact').addEventListener('click', () => {
      cleanup();
      const redacted = origText ? buildRedactedText(origText, matches) : '[REDACTED]';
      insertTextAtCaret(targetEl, redacted, selStart, selEnd);
    });

    overlay.querySelector('#bs-pm-cancel').addEventListener('click', cleanup);

    // Dismiss on backdrop click
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

    (document.body || document.documentElement).appendChild(overlay);
    // Auto-focus Allow for keyboard users
    requestAnimationFrame(() => overlay.querySelector('#bs-pm-allow')?.focus());
  }

  /**
   * Set up the paste-event interceptor.
   * Called once from init() alongside initClipboardGuard().
   */
  function initPasteGuard() {
    document.addEventListener('paste', (event) => {
      // 1. Feature gate checks
      if (!pasteCfg.pasteWarning) return;          // feature disabled by user
      if (!cfg.enabled) return;                    // BlurShield master switch off
      if (isDomainWhitelisted()) return;           // domain fully whitelisted

      const targetEl = event.target;

      // 2. Always allow password fields
      if (targetEl?.type === 'password') return;

      // 3. Check paste-trusted domains list
      const host = location.hostname;
      if ((pasteCfg.pasteTrustedDomains || []).some(d => d && host.includes(d))) return;

      // 4. Read clipboard text from the event
      let text = '';
      try { text = event.clipboardData?.getData('text/plain') || ''; } catch {}

      // 5a. If clipboard text is available, scan it
      if (text) {
        const matches = detectSecretsInText(text);
        if (!matches.length) return; // not a secret → allow normally

        event.preventDefault();
        const selStart = typeof targetEl?.selectionStart === 'number' ? targetEl.selectionStart : null;
        const selEnd   = typeof targetEl?.selectionEnd   === 'number' ? targetEl.selectionEnd   : null;
        showPasteWarningModal(matches, targetEl, text, selStart, selEnd);
        return;
      }

      // 5b. No clipboard text readable, but we tracked a copy — warn based on last copy
      if (lastCopiedSecrets.length) {
        event.preventDefault();
        showPasteWarningModal(lastCopiedSecrets, targetEl, '', null, null);
      }
    }, true); // capture phase — fires before the page's own paste handlers
  }

  // ── MutationObserver — dynamic content ────────────────────────────────
  let scanDebounce;
  const observer = new MutationObserver(mutations => {
    if (!cfg.enabled) return;
    // Ignore mutations caused by BlurShield itself
    const realMutations = mutations.filter(mut => {
      for (const node of mut.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.classList?.contains('bs-blur') ||
              node.classList?.contains('bs-badge') ||
              node.classList?.contains('bs-toast') ||
              node.classList?.contains('bs-recording-banner') ||
              node.hasAttribute?.('data-bs-processed')) return false;
        }
      }
      // Skip attribute mutations from data-bs-processed
      if (mut.type === 'attributes' && mut.attributeName === 'data-bs-processed') return false;
      return true;
    });
    if (!realMutations.length) return;
    clearTimeout(scanDebounce);
    scanDebounce = setTimeout(() => {
      let newFound = 0;
      observer.disconnect();
      for (const mut of realMutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE &&
              !node.classList?.contains('bs-blur') &&
              !node.classList?.contains('bs-badge') &&
              !node.hasAttribute?.('data-bs-processed')) {
            newFound += scan(node);
          }
        }
      }
      applyCustomZones();
      applyRevealState(isAllRevealed);
      observer.observe(document.body, { childList: true, subtree: true, attributes: false });
      syncBadge();
      if (newFound > 0) {
        updateStats('blurred', newFound);
      }
    }, 500);
  });

  // ── Messages from popup / background ─────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    switch (msg.action) {
      case 'toggle':
        cfg.enabled = msg.enabled;
        if (cfg.enabled) {
          setBlurIntensity(cfg.blurIntensity);
          const c = rescanProtection();
          if (c > 0) showToast(`${c} secret${c!==1?'s':''} blurred on this page`, 'info', detectedItems);
        } else {
          clearAll();
        }
        syncBadge(cfg.enabled ? getProtectedCount() : 0, !cfg.enabled);
        respond(getStatusPayload()); break;

      case 'getStatus':
        // Perform a quick verification of blurred elements count before responding
        // This ensures popup data matches the visual state of the page
        respond(getStatusPayload()); 
        break;

      case 'getDetectedItems':
        respond(buildDetectedItemsReport()); break;

      case 'highlightDetectedItems':
        respond(highlightDetectedItems()); break;

      case 'rescan': {
        const n = cfg.enabled ? rescanProtection() : 0;
        if (n>0) showToast(`${n} secret${n!==1?'s':''} found`, 'info', detectedItems);
        syncBadge(cfg.enabled ? getProtectedCount() : 0, !cfg.enabled);
        respond({ ...getStatusPayload(), rescannedCount: n }); break;
      }

      case 'setIntensity':
        setBlurIntensity(msg.blurIntensity); break;

      case 'updateCfg':
        Object.assign(cfg, { ...(msg.cfg || {}), isPro: msg.cfg?.isPro ?? cfg.isPro });
        syncPatternSet();
        setBlurIntensity(cfg.blurIntensity);
        if (!cfg.isPro || cfg.showBanner === false) hideRecordingBanner();
        detectRecording();
        if (cfg.enabled) {
          const nc = rescanProtection();
          syncBadge();
          respond({ ...getStatusPayload(), rescannedCount: nc });
        } else {
          clearAll();
          syncBadge(0, true);
          respond(getStatusPayload());
        }
        break;

      case 'startZoneSelect':
        startZoneSelector(); respond({ ok: true }); break;

      case 'startZoneErase':
        startZoneEraser(); respond({ ok: true }); break;

      case 'revealAll':
        applyRevealState(true);
        respond(getStatusPayload()); break;

      case 'hideAll':
        if (cfg.enabled && !isDomainWhitelisted()) {
          setBlurIntensity(cfg.blurIntensity);
          rescanProtection();
        }
        applyRevealState(false);
        syncBadge(cfg.enabled ? getProtectedCount() : 0, !cfg.enabled);
        respond(getStatusPayload()); break;

      case 'meetingMode':
        if (isMeetingMode) exitMeetingMode();
        else enterMeetingMode();
        respond({ meetingMode: isMeetingMode }); break;

      case 'keyboard-toggle':
        cfg.enabled = typeof msg.enabled === 'boolean' ? msg.enabled : !cfg.enabled;
        if (cfg.enabled) {
          setBlurIntensity(cfg.blurIntensity);
          const c = rescanProtection();
          if (c>0) showToast(`${c} secret${c!==1?'s':''} blurred`, 'info', detectedItems);
        }
        else clearAll();
        syncBadge(cfg.enabled ? getProtectedCount() : 0, !cfg.enabled);
        break;

      case 'triggerMeetingScan':
        // Forward to intercept.js (MAIN world) via window.postMessage
        // intercept.js listens for 'blurshield-content-trigger' messages
        window.postMessage({
          source: 'blurshield-content-trigger',
          action: 'triggerMeetingScan',
          platformName: msg.platformName || null
        }, '*');
        respond({ ok: true });
        break;

      case 'keyboard-reveal':
        if (isAllRevealed) {
          if (cfg.enabled && !isDomainWhitelisted()) {
            setBlurIntensity(cfg.blurIntensity);
            rescanProtection();
          }
          applyRevealState(false);
        } else {
          applyRevealState(true);
        }
        syncBadge(cfg.enabled ? getProtectedCount() : 0, !cfg.enabled);
        break;

      case 'shortcutsUpdated':
        if (msg.shortcuts) cfg.customShortcuts = msg.shortcuts;
        break;
    }
    // All synchronous; no need to return true
  });


  // ── Trial / Pro check ─────────────────────────────────────────────────
  async function getAccessStatus(retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const status = await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout')), 3000);
          chrome.runtime.sendMessage({ action: 'getTrialStatus' }, s => {
            clearTimeout(t);
            if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
            else res(s);
          });
        });
        if (status) return status;
      } catch (e) {
        if (i === retries - 1) return { active: false, isPro: false, error: e.message };
        await new Promise(r => setTimeout(r, 500 * (i + 1))); // Exponential backoff
      }
    }
    return { active: false, isPro: false };
  }

  function activateProPatterns() {
    syncPatternSet();
  }

  // ── Init ──────────────────────────────────────────────────────────────
  async function init() {
    await loadCfg();
    setBlurIntensity(cfg.blurIntensity);

    // Clipboard & paste guards run unconditionally
    initClipboardGuard();
    initPasteGuard();

    if (isDomainWhitelisted()) return;
    
    // On heavy SPAs, we might need to wait a moment for the initial DOM
    if (document.body && document.body.children.length === 0) {
      await new Promise(r => setTimeout(r, 500));
    }

    const accessStatus = await getAccessStatus();
    hasActiveAccess = !!accessStatus.active;
    cfg.isPro = !!accessStatus.isPro;
    syncPatternSet();

    if (!accessStatus.active) {
      // If we are Pro but access check failed temporarily, we don't want to lock the user out
      // but for trial users we must be strict.
      if (!cfg.isPro) {
        chrome.runtime.sendMessage({ action: 'updateBadge', off: true }, () => void chrome.runtime.lastError);
        return;
      }
      hasActiveAccess = true; // Fail-open for Pro users if background is temporarily unresponsive
    }

    if (cfg.isPro) activateProPatterns();

    if (cfg.enabled) {
      const count = rescanProtection();
      if (count > 0) updateStats('blurred', count);
      detectRecording();
      syncBadge();

      if (count > 0 && cfg.showToasts !== false) {
        showToast(`${count} secret${count!==1?'s':''} auto-detected and blurred`, 'info', detectedItems);
      }
    }

    observer.observe(document.body, { 
      childList: true, 
      subtree: true, 
      attributes: false, 
      characterData: true // Watch for text changes in existing nodes
    });
  }

  // ── Listen for settings changes from options/popup pages ──────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    // Reload config and re-scan when settings change
    loadCfg().then(async () => {
      const accessStatus = await getAccessStatus();
      hasActiveAccess = !!accessStatus.active;
      cfg.isPro = !!accessStatus.isPro;
      syncPatternSet();
      setBlurIntensity(cfg.blurIntensity);
      if (!cfg.isPro || cfg.showBanner === false) hideRecordingBanner();
      detectRecording();
      if (!cfg.enabled || isDomainWhitelisted() || !accessStatus.active) {
        clearAll();
        syncBadge(0, !accessStatus.active || !cfg.enabled);
      } else {
        rescanProtection();
        syncBadge();
      }
    });
  });

  // ── Message relay: intercept.js (MAIN world) → content.js → background ──
  // intercept.js cannot access chrome.runtime because it runs in the MAIN world.
  // It uses window.postMessage to send messages here, and we forward them to the
  // background script via chrome.runtime.sendMessage, then relay the response back.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'blurshield-intercept') return;

    const { id, payload } = event.data;
    if (!payload?.action) return;

    try {
      chrome.runtime.sendMessage(payload, (response) => {
        void chrome.runtime.lastError;
        // If there's an id, the sender expects a response back
        if (id) {
          window.postMessage({
            source: 'blurshield-content-response',
            id,
            response: response || {}
          }, '*');
        }
      });
    } catch (e) {
      // Catch "Extension context invalidated" errors (happens if extension is reloaded but tab isn't)
      if (id) {
        window.postMessage({
          source: 'blurshield-content-response',
          id,
          response: {} // Send empty response to let intercept.js timeout or fail gracefully
        }, '*');
      }
    }
  });

  // ── Custom Keyboard Shortcuts Handling ─────────────────────────────────
  function formatKeyEvent(e) {
    if (['Control','Alt','Shift','Meta'].includes(e.key)) return null;
    let parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key.toUpperCase();
    if (key === ' ') key = 'Space';
    parts.push(key);
    return parts.join('+');
  }

  document.addEventListener('keydown', (e) => {
    // Escape always closes meeting mode or custom zone tools, regardless of focus
    if (e.key === 'Escape') {
      if (isMeetingMode) exitMeetingMode();
      if (isSelectingZone) toggleZoneSelect();
      if (isErasingZone) toggleZoneErase();
      
      const toast = document.querySelector('.bs-toast');
      if (toast) toast.querySelector('.bs-toast-close')?.click();
      return;
    }

    // Ignore other shortcuts when typing in inputs/textareas, unless explicitly needed
    const tag = e.target.tagName?.toUpperCase();
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
    if (isInput) return;

    if (!cfg.customShortcuts) return;
    const combo = formatKeyEvent(e);
    if (!combo) return;

    if (combo === cfg.customShortcuts.toggle) {
      e.preventDefault();
      cfg.enabled = !cfg.enabled;
      chrome.storage.sync.set({ enabled: cfg.enabled }, () => {
        if (cfg.enabled) {
          setBlurIntensity(cfg.blurIntensity);
          const c = rescanProtection();
          if (c>0) showToast(`${c} secret${c!==1?'s':''} blurred`, 'info', detectedItems);
        } else clearAll();
        syncBadge(cfg.enabled ? getProtectedCount() : 0, !cfg.enabled);
      });
    } else if (combo === cfg.customShortcuts.reveal) {
      e.preventDefault();
      if (isAllRevealed) {
        if (cfg.enabled && !isDomainWhitelisted()) {
          setBlurIntensity(cfg.blurIntensity);
          rescanProtection();
        }
        applyRevealState(false);
      } else applyRevealState(true);
      syncBadge(cfg.enabled ? getProtectedCount() : 0, !cfg.enabled);
    } else if (combo === cfg.customShortcuts.meeting) {
      e.preventDefault();
      if (isMeetingMode) exitMeetingMode();
      else enterMeetingMode();
    } else if (combo === cfg.customShortcuts.preview) {
      e.preventDefault();
      try { chrome.runtime.sendMessage({ action: 'triggerLeakPreview' }); } catch {}
    }
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

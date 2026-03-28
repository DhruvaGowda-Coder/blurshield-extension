(() => {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const checkoutUrls = globalThis.BS_APP_CONFIG?.checkoutUrls || {};
    const resolveCheckoutUrl = (plan) =>
      checkoutUrls[plan] ||
      checkoutUrls.default ||
      checkoutUrls.annual ||
      checkoutUrls.monthly ||
      'https://blurshield.lemonsqueezy.com/checkout/buy/02d5a635-7a74-4839-9149-5977c3864d16';
    const hasChromeAPI = typeof chrome !== 'undefined' && chrome.storage && chrome.runtime;

    function replaceHash(hash) {
      try {
        history.replaceState(null, '', hash);
      } catch {}
    }

    function switchPage(pageName) {
      document.querySelectorAll('.nav-item').forEach((navItem) => navItem.classList.remove('active'));
      document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));

      const navItem = document.querySelector(`[data-page="${pageName}"]`);
      const page = $('page-' + pageName);
      if (navItem) navItem.classList.add('active');
      if (page) page.classList.add('active');
    }

    function createProLockedBox(onClick) {
      const box = document.createElement('div');
      box.className = 'pro-locked-box';

      const title = document.createElement('div');
      title.style.fontSize = '14px';
      title.style.color = 'var(--text)';
      title.style.fontWeight = '500';
      title.textContent = 'Pro feature disabled';

      const desc = document.createElement('div');
      desc.style.fontSize = '12px';
      desc.style.color = 'var(--muted)';
      desc.textContent = 'Full 7-day visual stats dashboard is exclusive to BlurShield Pro.';

      const button = document.createElement('button');
      button.className = 'btn btn-ghost';
      button.style.marginTop = '4px';
      button.style.color = 'var(--green)';
      button.style.borderColor = 'var(--green)';
      button.type = 'button';
      button.textContent = 'Get Pro to unlock ->';

      box.append(title, desc, button);
      box.addEventListener('click', onClick);
      return box;
    }

    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        if (!page) return;
        switchPage(page);
        replaceHash('#' + page);
      });
    });

    const hash = location.hash.replace('#', '') || 'stats';
    switchPage(hash);

    const aboutPatternsName = Array.from(document.querySelectorAll('#page-about .setting-name'))
      .find((element) => element.textContent.includes('Pattern library'));
    if (aboutPatternsName) aboutPatternsName.textContent = 'Pattern library';

    const aboutPatternsLink = document.querySelector('#page-about a[href="#patterns"]');
    if (aboutPatternsLink) {
      aboutPatternsLink.addEventListener('click', (event) => {
        event.preventDefault();
        switchPage('patterns');
        replaceHash('#patterns');
      });
    }

    $('s-intensity')?.addEventListener('input', function onInput() {
      $('s-intensity-val').textContent = this.value + 'px';
    });

    (async () => {
      try {
        if (!hasChromeAPI || !chrome.commands) return;
        const commands = await chrome.commands.getAll();
        const byName = Object.fromEntries(commands.map((command) => [command.name, command.shortcut]));
        $('shortcut-toggle').textContent = byName['toggle-blur'] || 'Not assigned';
        $('shortcut-reveal').textContent = byName['reveal-all'] || 'Not assigned';
      } catch {}
    })();

    (async () => {
      let cfg = {
        blurKeys: true,
        blurCrypto: true,
        blurEmails: true,
        blurPII: true,
        revealOnHover: false,
        blurIntensity: 7,
        whitelistedDomains: [],
        showBanner: true,
        showToasts: true,
        customZones: [],
        isPro: false,
        pasteWarning: true,
        pasteTrustedDomains: []
      };

      try {
        cfg = await new Promise((resolve) => chrome.storage.sync.get(cfg, resolve));
      } catch (error) {
        console.warn('BlurShield: Could not load settings', error);
      }

      let accessStatus = { active: false, isPro: false };
      try {
        accessStatus = await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'getTrialStatus' }, resolve));
      } catch {}
      cfg.isPro = !!accessStatus?.isPro;

      if (!cfg.isPro) {
        const nudge = $('sidebar-pro-nudge');
        if (nudge) {
          nudge.style.display = 'block';
          nudge.addEventListener('click', () => {
            switchPage('subscription');
            replaceHash('#subscription');
          });
          nudge.addEventListener('mouseover', () => {
            nudge.style.borderColor = 'rgba(29,158,117,0.6)';
          });
          nudge.addEventListener('mouseout', () => {
            nudge.style.borderColor = 'rgba(29,158,117,0.25)';
          });
        }
      }

      $('s-keys').checked = cfg.blurKeys;
      $('s-crypto').checked = cfg.blurCrypto;
      $('s-emails').checked = cfg.blurEmails;
      $('s-pii').checked = cfg.blurPII;
      $('s-hover').checked = cfg.revealOnHover;
      $('s-toasts').checked = cfg.showToasts !== false;
      $('s-paste-warning').checked = cfg.pasteWarning !== false;
      renderPasteTrustedDomains();

      if (!cfg.isPro) {
        $('s-banner').disabled = true;
        $('s-banner').checked = false;
        $('t-banner-wrap').style.opacity = '0.5';
        $('t-banner-wrap').addEventListener('click', (event) => {
          event.preventDefault();
          switchPage('subscription');
          replaceHash('#subscription');
        });
      } else {
        $('s-banner').checked = cfg.showBanner !== false;
      }

      $('s-intensity').value = cfg.blurIntensity || 7;
      $('s-intensity-val').textContent = (cfg.blurIntensity || 7) + 'px';

      $('save-settings')?.addEventListener('click', async () => {
        const patch = {
          blurKeys: $('s-keys').checked,
          blurCrypto: $('s-crypto').checked,
          blurEmails: $('s-emails').checked,
          blurPII: $('s-pii').checked,
          revealOnHover: $('s-hover').checked,
          showBanner: $('s-banner').checked,
          showToasts: $('s-toasts').checked,
          blurIntensity: parseInt($('s-intensity').value, 10),
          pasteWarning: $('s-paste-warning').checked
        };

        try {
          await new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
          const button = $('save-settings');
          button.textContent = 'Saved';
          button.style.opacity = '0.7';
          setTimeout(() => {
            button.textContent = 'Save settings';
            button.style.opacity = '1';
          }, 1500);
        } catch (error) {
          console.error('BlurShield: Could not save settings', error);
          $('save-settings').textContent = 'Error saving';
          setTimeout(() => {
            $('save-settings').textContent = 'Save settings';
          }, 2000);
        }
      });

      try {
        const localData = await new Promise((resolve) => chrome.storage.local.get({ stats: {} }, resolve));
        const stats = localData.stats || {};
        const days = Object.keys(stats).sort().slice(-7);
        const totalBlurred = Object.values(stats).reduce((acc, day) => acc + (day.blurred || 0), 0);
        const totalReveals = Object.values(stats).reduce((acc, day) => acc + (day.reveals || 0), 0);

        $('total-blurred').textContent = totalBlurred || 0;
        $('total-reveals').textContent = totalReveals || 0;
        $('active-days').textContent = Object.keys(stats).length || 0;
        $('custom-zones').textContent = (cfg.customZones || []).length;

        const chart = $('daily-chart');
        chart.innerHTML = '';
        if (!days.length) {
          chart.innerHTML = '<div class="empty" style="padding:20px">No activity yet - browse some pages with BlurShield active</div>';
        } else if (!cfg.isPro) {
          chart.appendChild(createProLockedBox(() => {
            switchPage('subscription');
            replaceHash('#subscription');
          }));
        } else {
          const maxVal = Math.max(1, ...days.map((day) => stats[day]?.blurred || 0));
          days.forEach((day) => {
            const value = stats[day]?.blurred || 0;
            const percent = Math.round((value / maxVal) * 100);
            const label = day.slice(5);
            const row = document.createElement('div');
            row.className = 'chart-row';
            row.innerHTML = `<div class="chart-label">${label}</div><div class="chart-bar-track"><div class="chart-bar-fill" style="width:${percent}%"></div></div><div class="chart-count">${value}</div>`;
            chart.appendChild(row);
          });
        }
      } catch (error) {
        console.warn('BlurShield: Could not load stats', error);
        $('total-blurred').textContent = '0';
        $('total-reveals').textContent = '0';
        $('active-days').textContent = '0';
        $('custom-zones').textContent = '0';
      }

      function renderDomains() {
        try {
          chrome.storage.sync.get({ whitelistedDomains: [] }, ({ whitelistedDomains }) => {
            const list = $('domain-list');
            if (!whitelistedDomains || !whitelistedDomains.length) {
              list.innerHTML = '<div class="empty">No whitelisted domains yet</div>';
              return;
            }

            list.innerHTML = '';
            whitelistedDomains.forEach((domain) => {
              const item = document.createElement('div');
              item.className = 'domain-item';
              const domainSpan = document.createElement('span');
              domainSpan.textContent = domain;
              const removeBtn = document.createElement('button');
              removeBtn.className = 'domain-remove';
              removeBtn.type = 'button';
              removeBtn.textContent = 'Remove';
              item.appendChild(domainSpan);
              item.appendChild(removeBtn);
              item.querySelector('button').onclick = async () => {
                try {
                  const { whitelistedDomains: stored = [] } = await new Promise((resolve) =>
                    chrome.storage.sync.get({ whitelistedDomains: [] }, resolve)
                  );
                  chrome.storage.sync.set({ whitelistedDomains: stored.filter((entry) => entry !== domain) }, renderDomains);
                } catch {}
              };
              list.appendChild(item);
            });
          });
        } catch {}
      }

      renderDomains();

      async function addDomain() {
        const input = $('domain-input');
        const value = input.value.trim().replace(/^https?:\/\//, '').split('/')[0];
        if (!value) return;

        try {
          const { whitelistedDomains: stored = [] } = await new Promise((resolve) =>
            chrome.storage.sync.get({ whitelistedDomains: [] }, resolve)
          );
          if (!stored.includes(value)) {
            chrome.storage.sync.set({ whitelistedDomains: [...stored, value] }, renderDomains);
          }
        } catch {}

        input.value = '';
      }

      $('add-domain-btn').onclick = addDomain;
      $('domain-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') addDomain();
      });

      // â”€â”€ Paste-trusted domain list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      function renderPasteTrustedDomains() {
        try {
          chrome.storage.sync.get({ pasteTrustedDomains: [] }, ({ pasteTrustedDomains }) => {
            const list = $('paste-trusted-list');
            if (!list) return;
            if (!pasteTrustedDomains || !pasteTrustedDomains.length) {
              list.innerHTML = '<div class="empty">No paste-trusted domains yet</div>';
              return;
            }
            list.innerHTML = '';
            pasteTrustedDomains.forEach((domain) => {
              const item = document.createElement('div');
              item.className = 'domain-item';
              const span = document.createElement('span');
              span.textContent = domain;
              const removeBtn = document.createElement('button');
              removeBtn.className = 'domain-remove';
              removeBtn.type = 'button';
              removeBtn.textContent = 'Remove';
              item.appendChild(span);
              item.appendChild(removeBtn);
              item.querySelector('button').onclick = async () => {
                try {
                  const { pasteTrustedDomains: stored = [] } = await new Promise((resolve) =>
                    chrome.storage.sync.get({ pasteTrustedDomains: [] }, resolve)
                  );
                  chrome.storage.sync.set(
                    { pasteTrustedDomains: stored.filter((entry) => entry !== domain) },
                    renderPasteTrustedDomains
                  );
                } catch {}
              };
              list.appendChild(item);
            });
          });
        } catch {}
      }

      async function addPasteTrustedDomain() {
        const input = $('paste-trusted-input');
        if (!input) return;
        const value = input.value.trim().replace(/^https?:\/\//, '').split('/')[0];
        if (!value) return;
        try {
          const { pasteTrustedDomains: stored = [] } = await new Promise((resolve) =>
            chrome.storage.sync.get({ pasteTrustedDomains: [] }, resolve)
          );
          if (!stored.includes(value)) {
            chrome.storage.sync.set(
              { pasteTrustedDomains: [...stored, value] },
              renderPasteTrustedDomains
            );
          }
        } catch {}
        input.value = '';
      }

      $('add-paste-trusted-btn')?.addEventListener('click', addPasteTrustedDomain);
      $('paste-trusted-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') addPasteTrustedDomain();
      });
    })();

    const SEV_COLORS = {
      critical: { bg: '#300a0a', color: '#fca5a5' },
      high: { bg: '#2d1b00', color: '#fcd34d' },
      medium: { bg: '#1a1040', color: '#a5b4fc' },
      low: { bg: '#002818', color: '#86efac' }
    };
    const grid = $('pattern-grid');
    const trialPatterns = globalThis.BS_PATTERNS_TRIAL || [];
    const proPatterns = globalThis.BS_PATTERNS_PRO || [];
    const trialIds = new Set(trialPatterns.map((pattern) => pattern.id));
    const allPatterns = [...trialPatterns, ...proPatterns];

    if (!allPatterns.length) {
      grid.innerHTML = '<div class="empty">No patterns loaded</div>';
    } else {
      allPatterns.forEach((pattern) => {
        const severity = SEV_COLORS[pattern.severity] || SEV_COLORS.medium;
        const isPro = !trialIds.has(pattern.id);
        const card = document.createElement('div');
        card.className = 'pattern-card';
        card.innerHTML = `<div class="pattern-name">${pattern.name}${isPro ? '<span class="pro-tag">PRO</span>' : ''}</div><div class="pattern-svc">${pattern.service}</div><span class="pattern-sev" style="background:${severity.bg};color:${severity.color}">${pattern.severity}</span>`;
        grid.appendChild(card);
      });
    }

    function renderCustomPatterns() {
      try {
        chrome.storage.sync.get({ customPatterns: [] }, ({ customPatterns }) => {
          const list = $('custom-patterns-list');
          if (!list) return;
          if (!customPatterns || !customPatterns.length) {
            list.innerHTML = '<div class="empty" style="padding:16px"><span style="font-size:16px;display:block;margin-bottom:8px;opacity:0.5">âŠ˜</span>No custom patterns added yet</div>';
            return;
          }

          list.innerHTML = '';
          customPatterns.forEach((pat) => {
            const item = document.createElement('div');
            item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--bg3);border:0.5px solid var(--border);border-radius:8px';
            item.innerHTML = `
              <div style="min-width:0;flex:1">
                <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${escapeHtml(pat.name)}</div>
                <div style="font-size:11px;font-family:var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(pat.patternString)}">/${escapeHtml(pat.patternString)}/g</div>
              </div>
              <button class="domain-remove" type="button" style="margin-left:12px;flex-shrink:0">Remove</button>
            `;
            item.querySelector('button').onclick = async () => {
              try {
                 const stored = await new Promise(r => chrome.storage.sync.get({customPatterns:[]}, r));
                 const filtered = stored.customPatterns.filter(p => p.id !== pat.id);
                 chrome.storage.sync.set({customPatterns: filtered}, renderCustomPatterns);
              } catch {}
            };
            list.appendChild(item);
          });
        });
      } catch {}
    }

    // Helper for escaping HTML in custom patterns to prevent XSS
    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    renderCustomPatterns();

    $('add-custom-pattern-btn')?.addEventListener('click', async () => {
      const status = await new Promise(r => chrome.runtime.sendMessage({ action: 'getTrialStatus' }, r));
      if (!status?.isPro) {
         switchPage('subscription'); 
         window.location.hash = '#subscription';
         return;
      }

      const nameInput = $('custom-pattern-name');
      const regInput = $('custom-pattern-regex');
      const name = nameInput.value.trim();
      const regexStr = regInput.value.trim();
      if (!name || !regexStr) return;
      
      try { 
        const testRe = new RegExp(regexStr, 'g'); 
        const start = Date.now();
        testRe.test('a'.repeat(200));
        if (Date.now() - start > 50) {
           alert('Pattern is too complex (potential ReDoS). Please simplify.'); return;
        }
      } catch(e) {
         alert('Invalid Regular Expression: ' + e.message); return;
      }

      const button = $('add-custom-pattern-btn');
      button.disabled = true;
      button.textContent = 'Adding...';

      try {
        const stored = await new Promise(r => chrome.storage.sync.get({customPatterns:[]}, r));
        const list = stored.customPatterns || [];
        const newPat = {
          id: 'custom-' + Date.now(),
          name: name,
          patternString: regexStr,
          service: 'Custom',
          severity: 'high'
        };
        chrome.storage.sync.set({customPatterns: [...list, newPat]}, () => {
          renderCustomPatterns();
          nameInput.value = '';
          regInput.value = '';
          button.disabled = false;
          button.textContent = 'Add pattern';
        });
      } catch {
        button.disabled = false;
        button.textContent = 'Add pattern';
      }
    });

    async function loadSubStatus() {
      const status = await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'getTrialStatus' }, resolve));
      const { licenseKey = '' } = await new Promise((resolve) => chrome.storage.sync.get({ licenseKey: '' }, resolve));
      const statusEl = $('sub-status-text');
      const trialRow = $('trial-row');
      const accountRow = $('account-row');
      const licenseRow = $('license-key-row');
      const activateCard = $('activate-card');
      const authActionBtn = $('auth-action-btn');

      trialRow.style.display = 'none';
      accountRow.style.display = 'none';
      licenseRow.style.display = 'none';
      activateCard.style.display = '';

      if (status?.signedIn) {
        accountRow.style.display = 'flex';
        $('account-email').textContent = status.email || 'Signed in';
        authActionBtn.textContent = 'Sign out';
        authActionBtn.onclick = async () => {
          if (!confirm('Sign out of BlurShield?')) return;
          if (globalThis.BS_AUTH) {
            await globalThis.BS_AUTH.signOut();
          } else {
            await new Promise(r => chrome.runtime.sendMessage({ action: 'signOut' }, r));
          }
          window.location.reload();
        };
      } else {
        accountRow.style.display = 'flex';
        $('account-email').textContent = 'Not signed in';
        authActionBtn.textContent = 'Sign in';
        authActionBtn.onclick = async () => {
          authActionBtn.disabled = true;
          authActionBtn.textContent = 'Signing in...';
          try {
            if (globalThis.BS_AUTH) {
              const user = await globalThis.BS_AUTH.signInWithGoogle();
              await globalThis.BS_AUTH.saveUserSession(user);
            } else {
               alert('Auth module not loaded. Please try from popup.');
            }
            window.location.reload();
          } catch (e) {
            alert('Sign in failed: ' + e.message);
            authActionBtn.disabled = false;
            authActionBtn.textContent = 'Sign in';
          }
        };
      }

      if (status?.isPro) {
        statusEl.textContent = 'Pro - Active';
        statusEl.style.color = '#1D9E75';
        if (licenseKey) {
          licenseRow.style.display = 'flex';
          $('license-key-display').textContent = licenseKey.slice(0, 8) + '........';
          const removeBtn = $('remove-license-btn');
          if (removeBtn) {
            removeBtn.onclick = async () => {
              if (confirm('Are you sure you want to unlink this license key? You will lose Pro access until you configure it again.')) {
                await new Promise(r => chrome.storage.sync.remove(['licenseKey'], r));
                await new Promise(r => chrome.storage.local.remove(['bsLicenseCache'], r));
                window.location.reload();
              }
            };
          }
        }
        activateCard.style.display = 'none';
        return;
      }

      if (status?.active) {
        statusEl.textContent = 'Trial active';
        statusEl.style.color = '#f59e0b';
        trialRow.style.display = 'flex';
        $('trial-days-text').textContent = `${status.daysLeft} day${status.daysLeft !== 1 ? 's' : ''} left`;
        return;
      }

      statusEl.textContent = 'Trial expired - upgrade required';
      statusEl.style.color = '#ef4444';
    }

    loadSubStatus();

    $('opt-activate-btn')?.addEventListener('click', async () => {
      const key = $('opt-license-input').value.trim();
      if (!key) {
        $('opt-license-msg').textContent = 'Please enter a license key';
        $('opt-license-msg').style.color = '#ef4444';
        return;
      }

      const button = $('opt-activate-btn');
      button.textContent = 'Checking...';
      button.disabled = true;

      const result = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'validateLicense', licenseKey: key }, resolve)
      );
      const message = $('opt-license-msg');
      if (result?.valid) {
        message.textContent = 'License activated successfully!';
        message.style.color = '#1D9E75';
        await loadSubStatus();
        setTimeout(() => window.location.reload(), 900);
        return;
      }

      message.textContent = result?.error || 'Invalid license key';
      message.style.color = '#ef4444';
      button.textContent = 'Activate';
      button.disabled = false;
    });

    let selectedPlan = 'annual';
    const planMonthly = $('plan-monthly');
    const planAnnual = $('plan-annual');

    function updatePlanUI() {
      if (!planMonthly || !planAnnual) return;

      if (selectedPlan === 'annual') {
        planAnnual.style.border = '1.5px solid #1D9E75';
        planAnnual.querySelector('div:nth-child(3)').style.color = '#1D9E75';
        planAnnual.querySelector('div:nth-child(4)').style.color = '#1D9E75';

        planMonthly.style.border = '0.5px solid var(--border)';
        planMonthly.querySelector('div:nth-child(2)').style.color = 'var(--text)';
        planMonthly.querySelector('div:nth-child(3)').style.color = 'var(--muted)';
        return;
      }

      planMonthly.style.border = '1.5px solid #1D9E75';
      planMonthly.querySelector('div:nth-child(2)').style.color = '#1D9E75';
      planMonthly.querySelector('div:nth-child(3)').style.color = '#1D9E75';

      planAnnual.style.border = '0.5px solid var(--border)';
      planAnnual.querySelector('div:nth-child(3)').style.color = 'var(--text)';
      planAnnual.querySelector('div:nth-child(4)').style.color = 'var(--muted)';
    }

    planMonthly?.addEventListener('click', () => {
      selectedPlan = 'monthly';
      updatePlanUI();
    });
    planAnnual?.addEventListener('click', () => {
      selectedPlan = 'annual';
      updatePlanUI();
    });
    updatePlanUI();

    $('opt-buy-btn')?.addEventListener('click', () => {
      if (hasChromeAPI) {
        chrome.runtime.sendMessage({ action: 'openCheckout', plan: selectedPlan });
        return;
      }
      window.open(resolveCheckoutUrl(selectedPlan), '_blank');
    });

    // â”€â”€ Keyboard Shortcuts Recorder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const defaultShortcuts = {
      toggle: 'Alt+Shift+B',
      reveal: 'Alt+Shift+U',
      meeting: 'Alt+Shift+M',
      preview: 'Alt+Shift+K'
    };
    let activeRecorder = null;
    
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

    function updateShortcutsUI(shortcuts) {
      Object.keys(defaultShortcuts).forEach(action => {
        const el = $(`sck-${action}`);
        if (el) el.textContent = shortcuts[action] || defaultShortcuts[action];
      });
    }

    if (hasChromeAPI) {
      chrome.storage.local.get('customShortcuts', (res) => {
        const shortcuts = res.customShortcuts || { ...defaultShortcuts };
        updateShortcutsUI(shortcuts);
      });
    }

    document.querySelectorAll('.sck-input').forEach(input => {
      input.addEventListener('click', (e) => {
        if (activeRecorder) {
          activeRecorder.classList.remove('recording');
          activeRecorder.textContent = activeRecorder.dataset.oldVal;
        }
        activeRecorder = e.target;
        activeRecorder.dataset.oldVal = activeRecorder.textContent;
        activeRecorder.textContent = 'Listening...';
        activeRecorder.classList.add('recording');
        activeRecorder.focus();
        $('sck-status').textContent = 'Press your desired key combination...';
      });

      input.addEventListener('keydown', (e) => {
        if (!activeRecorder || e.target !== activeRecorder) return;
        e.preventDefault();
        e.stopPropagation();
        
        if (e.key === 'Escape') {
          activeRecorder.textContent = activeRecorder.dataset.oldVal;
          finishRecording();
          return;
        }

        const combo = formatKeyEvent(e);
        if (combo) {
          activeRecorder.textContent = combo;
          saveShortcut(activeRecorder.id.replace('sck-', ''), combo);
          finishRecording(`Shortcut saved! Changes apply immediately to all tabs.`);
        }
      });

      input.addEventListener('blur', () => {
        if (activeRecorder === input) {
          activeRecorder.textContent = activeRecorder.dataset.oldVal;
          finishRecording();
        }
      });
    });

    document.querySelectorAll('.sck-reset').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        const defaultVal = defaultShortcuts[action];
        $(`sck-${action}`).textContent = defaultVal;
        saveShortcut(action, defaultVal);
        const status = $('sck-status');
        status.textContent = 'Reset to default.';
        setTimeout(() => { if (status.textContent === 'Reset to default.') status.textContent = ''; }, 2000);
      });
    });

    function finishRecording(msg = '') {
      const el = activeRecorder;
      if (el) {
        activeRecorder = null; // nullify BEFORE blur so the cancel-listener ignores it
        el.classList.remove('recording');
        el.blur();
      }
      $('sck-status').textContent = msg;
      if (msg) setTimeout(() => { if ($('sck-status').textContent === msg) $('sck-status').textContent = ''; }, 3000);
    }

    function saveShortcut(action, combo) {
      if (!hasChromeAPI) return;
      chrome.storage.local.get('customShortcuts', (res) => {
        const customShortcuts = res.customShortcuts || { ...defaultShortcuts };
        customShortcuts[action] = combo;
        chrome.storage.local.set({ customShortcuts }, () => {
          chrome.runtime.sendMessage({ action: 'shortcutsUpdated', shortcuts: customShortcuts });
        });
      });
    }
  });
})();

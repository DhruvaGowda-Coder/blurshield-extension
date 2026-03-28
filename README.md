<div align="center">
  <img src="icons/icon128.png" width="128" height="128" alt="BlurShield Logo">
  <h1>🛡️ BlurShield</h1>
  <p><strong>Developer Screen Privacy — Never leak an API key on a screen share again.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3">
    <img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-0078D7?style=flat-square&logo=microsoftedge&logoColor=white" alt="Chrome & Edge">
    <img src="https://img.shields.io/badge/License-Freemium-1D9E75?style=flat-square" alt="License">
    <img src="https://img.shields.io/badge/Privacy-100%25%20Local-22c55e?style=flat-square&logo=shieldsdotio&logoColor=white" alt="100% Local">
  </p>
</div>

---

## 🤔 The Problem

You're screen sharing in a meeting, live coding on a stream, or demoing your app — and your `.env` file, AWS credentials, or Stripe secret key is right there on your screen for everyone to see.

**BlurShield fixes this.** It silently runs in the background, detecting and blurring sensitive data in real-time before anyone else can see it.

---

## ✨ Features

### 🔮 Auto-Detection & Real-time Blur
Instantly detects and blurs **55+ patterns** including API keys (Stripe, AWS, OpenAI, GitHub, Firebase, etc.), passwords, emails, crypto wallets, and PII — all using local regex matching.

### 💼 Meeting Mode — The Panic Button
Hit **`Alt+Shift+M`** and *everything* sensitive on your screen blurs instantly. Perfect for surprise calls or when someone walks up to your desk.

### 👀 Leak Preview
Press **`Alt+Shift+K`** to simulate what others see during a screen share — *before* you actually start sharing. Catch leaks before they happen.

### ✏️ Custom Blur Zones
Draw persistent privacy zones on any webpage to hide proprietary UI, dashboards, or internal metrics.

### 🚫 Clipboard Guard
Accidentally copied a live API key? BlurShield warns you instantly before you paste it somewhere dangerous.

### 🔧 Custom Patterns
Add your own regex patterns to detect internal company secrets, project tokens, or custom formats that only your team uses.

### 🌐 100% Local Scanning
**Zero screen data leaves your browser.** No cloud APIs, no telemetry, no remote servers for scanning. All scanning happens locally using DOM analysis and regex pattern matching (account auth syncing uses standard Firebase/Chrome Sync).

---

## 🚀 Quick Start

### Chrome Web Store / Edge Add-ons
1. Install BlurShield from the [Chrome Web Store](#) or [Edge Add-ons Store](#)
2. Pin the 🛡️ icon to your toolbar
3. Sign in with Google to start your **7-day free trial**
4. BlurShield runs silently in the background — you're protected!

### Developer / Local Installation
```bash
# 1. Clone or download this repository
git clone https://github.com/DhruvaGowda-Coder/BlurShield.git

# 2. Open your browser's extension page
#    Chrome → chrome://extensions
#    Edge   → edge://extensions

# 3. Enable "Developer Mode" (toggle in top right)

# 4. Click "Load unpacked" and select this folder
```

---

## ⌨️ Keyboard Shortcuts

| Action | Shortcut |
| :--- | :---: |
| 🔄 Toggle BlurShield On/Off | `Alt+Shift+B` |
| 💼 Meeting Mode (Panic Button) | `Alt+Shift+M` |
| 👁️ Reveal All Temporarily | `Alt+Shift+U` |
| 👀 Simulate Leak Preview | `Alt+Shift+K` |

> **Tip:** Customize shortcuts at `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`

---

## 🏗️ Architecture

```
BlurShield/
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker — auth, licensing, commands
├── content.js           # Core scanner — regex matching + DOM blurring
├── patterns.js          # 55 detection patterns (32 trial + 23 Pro)
├── intercept.js         # MAIN world script — recording detection
├── leakPreview.js       # Leak simulation overlay
├── firebase.js          # Auth & Firestore via REST API (no SDK)
├── app-config.js        # Client-side config (Firebase, OAuth, checkout)
├── popup.html/js/css    # Extension popup UI
├── options.html/js      # Settings dashboard
├── privacy.html         # Privacy policy page
├── features.html        # Features landing page
├── contact.html         # Contact page
└── icons/               # Extension icons (16–512px)
```

---

## 🔒 Privacy & Security

BlurShield is built on a strict **zero-trust, zero-transmission** model:

- ✅ **All scanning is local** — regex + DOM queries only, no cloud AI
- ✅ **No telemetry** — we don't track URLs, page content, or browsing activity
- ✅ **No external data** — detected secrets are never logged or transmitted
- ✅ **Strict CSP** — `script-src 'self'` enforced on all extension pages
- ✅ **Manifest V3** — modern security model with service workers

📄 [Read our full Privacy Policy](https://dhruvagowda-coder.github.io/BlurShield-Website/privacy.html)

---

## 💰 Pricing

| | Free Trial | Pro |
|:---|:---:|:---:|
| Duration | 7 days | Unlimited |
| Basic patterns (32) | ✅ | ✅ |
| Advanced patterns (23) | ❌ | ✅ |
| Meeting Mode | ✅ | ✅ |
| Leak Preview | ✅ | ✅ |
| Custom Blur Zones | ✅ | ✅ |
| Custom Patterns | ❌ | ✅ |
| Clipboard Guard | ❌ | ✅ |
| Recording Banner | ❌ | ✅ |

---

## 💬 Support & Contact

- 📧 **Email:** [blurshield2006@gmail.com](mailto:blurshield2006@gmail.com)
- 🌐 **Features:** [View all features](https://dhruvagowda-coder.github.io/BlurShield-Website/features.html)
- 📄 **Privacy:** [Privacy Policy](https://dhruvagowda-coder.github.io/BlurShield-Website/privacy.html)
- 📞 **Contact:** [Contact Us](https://dhruvagowda-coder.github.io/BlurShield-Website/contact.html)

---

<div align="center">
  <sub>Built with 🛡️ by <a href="https://github.com/DhruvaGowda-Coder">Dhruva Gowda</a> · Made for developers who care about privacy.</sub>
</div>

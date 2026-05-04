<div align="center">
  <img src="icons/icon128.png" width="128" height="128" alt="BlurShield Logo">
  <h1>🛡️ BlurShield</h1>
  <p><strong>Developer Screen Privacy — Prevent sensitive data leaks during screen sharing.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3">
    <img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-0078D7?style=flat-square&logo=microsoftedge&logoColor=white" alt="Chrome & Edge">
    <img src="https://img.shields.io/badge/License-Freemium-1D9E75?style=flat-square" alt="License">
    <img src="https://img.shields.io/badge/Privacy-100%25%20Local-22c55e?style=flat-square&logo=shieldsdotio&logoColor=white" alt="100% Local">
  </p>
</div>

---

## 🌐 Live Demo

👉 Chrome Web Store: https://chromewebstore.google.com/detail/dgpihknippnloandcngnipbponnnlhmd
👉 Edge Add-ons: https://microsoftedge.microsoft.com/addons/detail/hpkdndhpbjionebkkpmpjmdampomnonh

---

## 🎯 The Problem

While screen sharing, live coding, or demoing applications, developers often accidentally expose sensitive data such as API keys, tokens, credentials, or personal information.

---

## 💡 The Solution

**BlurShield** runs locally in the browser and automatically detects and blurs sensitive data in real-time using regex-based pattern matching and DOM scanning — preventing accidental data leaks before they happen.

---

## ✨ Key Features

### 🔮 Real-Time Detection & Blur

Detects and blurs **55+ sensitive patterns** including API keys (AWS, Stripe, OpenAI, GitHub), emails, passwords, crypto wallets, and PII using local regex matching.

### 💼 Meeting Mode — Instant Protection

Press **`Alt+Shift+M`** to instantly blur all sensitive content during screen sharing or unexpected meetings.

### 👀 Leak Preview

Simulate what others will see during a screen share using **`Alt+Shift+K`** and detect leaks before presenting.

### ✏️ Custom Blur Zones

Create persistent privacy zones to hide internal dashboards, analytics, or proprietary UI elements.

### 🚫 Clipboard Guard

Warns users when copying or pasting sensitive data to prevent accidental exposure.

### 🔧 Custom Detection Patterns

Add custom regex rules for internal tokens or organization-specific secrets.

### 🌐 100% Local Processing

All detection runs locally — **no screen data is sent to any server**, ensuring complete privacy.

---

## 🧠 How It Works

DOM Scan → Pattern Matching (Regex Engine) → Detect Sensitive Data → Apply Blur Overlay → Continuous Monitoring via MutationObserver

---

## 🏗️ Architecture

```
BlurShield/
├── manifest.json        # Extension config (MV3)
├── background.js        # Service worker — auth, licensing, commands
├── content.js           # Core detection engine (regex + DOM)
├── patterns.js          # 55 detection patterns
├── intercept.js         # Screen recording detection
├── leakPreview.js       # Leak simulation system
├── firebase.js          # Auth + sync (no SDK)
├── popup/               # Extension UI
├── options/             # Settings dashboard
└── icons/               # Assets
```

---

## 🔒 Privacy & Security

BlurShield follows a strict **zero-transmission model**:

* ✅ All detection is local (no cloud processing)
* ✅ No telemetry or tracking
* ✅ No storage of sensitive data
* ✅ Secure Manifest V3 architecture
* ✅ Strict CSP policies

📄 Privacy Policy: https://dhruvagowda-coder.github.io/BlurShield-Website/privacy.html

---

## 💰 Pricing

| Feature           | Free Trial | Pro       |
| ----------------- | ---------- | --------- |
| Duration          | 7 days     | Unlimited |
| Basic patterns    | ✅          | ✅         |
| Advanced patterns | ❌          | ✅         |
| Meeting Mode      | ✅          | ✅         |
| Leak Preview      | ✅          | ✅         |
| Custom Patterns   | ❌          | ✅         |
| Clipboard Guard   | ❌          | ✅         |

---

## 🚀 Developer Setup

```bash
git clone https://github.com/DhruvaGowda-Coder/blurshield-extension
```

* Open: `chrome://extensions`
* Enable Developer Mode
* Click **Load Unpacked**
* Select project folder

---

## 💬 Contact

* 📧 Email: [blurshield2006@gmail.com](mailto:blurshield2006@gmail.com)
* 🌐 Features: https://dhruvagowda-coder.github.io/BlurShield-Website/features.html
* 📄 Privacy: https://dhruvagowda-coder.github.io/BlurShield-Website/privacy.html

---

<div align="center">
  <sub>Built by Dhruva Gowda · Focused on privacy-first developer tools.</sub>
</div>

# Cookie-Editor-Next

Independent maintenance of [buigiathanh/Cookie_Editor](https://github.com/buigiathanh/Cookie_Editor), originally by Thanh Bui (buigiathanh) and upstream contributors. This is not the official upstream distribution. The original [GPL-3.0 license](LICENSE), author attribution and upstream README below are retained.

- `upstream-main` preserves the complete, unmodified upstream Git history at `ca3996694dd2559e1f1f9472cced42a2d02435a3`. Our `main` uses a separate linear source-snapshot baseline, with independent maintenance commits.
- The supplied ChatGPT-oriented adaptation replaces the `sidePanel` entry with a 640×600 toolbar popup and omits the wetab.org ad-detector content-script registration. The upstream JSON Cookie import fixes remain unchanged; they are not new fixes authored by this project.
- [Validation run 40482149539](https://github.com/xue-ding-e/Cookie-Editor-Next/actions/runs/40482149539) passed **4 Cookie-import unit tests, 5 static popup checks, and the Vite build** for `289c45b2931ed478150544c5e945fd26ad108723`. This does **not** verify installation or opening in the native ChatGPT browser, real login sessions, or all import formats. No real Cookies were used.
- **Runtime privacy:** this is not a purely local editor. The upstream opt-in n8n integration is retained: when enabled, it can retrieve Cookies requested through the remote service and send password-encrypted Cookie data to cookieeditor.org. Upstream analytics, remote sharing/import and other network features are also retained. No user Cookie exports or credentials are intentionally bundled; static secret screening is not a guarantee about every runtime behavior.

The upstream README follows unchanged; its descriptions, sponsorship and links refer to the original project.

---

<div align="center">

<br/>

<table>
<tr>
<td align="center" width="100%">

### 🏆 Project Sponsor

**[Ads.extension.vn](https://ads.extension.vn)**

*An advertising platform for browser extensions that helps extension developers monetize their products. Sponsor of Cookie Editor.*

<br/>

[![Visit Ads.extension.vn](https://img.shields.io/badge/Ads.extension.vn-Visit-6366f1?style=for-the-badge)](https://ads.extension.vn)

</td>
</tr>
</table>

<br/>

---

</div>

<br/>

# Cookie-Editor

## Description

Cookie Editor – Manage, Edit & Secure Your Cookies Easily

Cookie Editor is a powerful yet easy-to-use tool designed for seamless cookie management. Whether you're a developer testing web pages or need manual control over cookies for privacy reasons, this extension provides all the essential cookie operations in a simple interface.

⚠️ Stay Safe! Never share your cookies with anyone you don’t trust. Cookies can store sensitive data, including login credentials. If someone gains access to your cookies, they may take full control of your account.

🔹 Key Features of Cookie Editor:

✅ View all cookies for the current tab

✅ Search, create, edit, and delete cookies effortlessly

✅ Import and export cookies in multiple formats (JSON)

✅ Instantly clear all cookies for the current tab

✅ Support customizing Clear browsing data

💡 Support our development
To help Cookie Editor continue to improve its features, we display promotions for other useful extensions and banner ads. This helps us maintain and improve the tool to provide the best user experience.

## Install

### Install on Google Chrome

Find this extension on the [Chrome Web Store.](https://chromewebstore.google.com/detail/cookie-editor/ookdjilphngeeeghgngjabigmpepanpl)

## How to build

```bash
git clone git@github.com:buigiathanh/Cookie_Editor.git
cd Cookie_Editor
```

```bash
npm install
```

```bash
npm run build:extension
```

## Info
Website: [https://cookieeditor.org](https://cookieeditor.org)

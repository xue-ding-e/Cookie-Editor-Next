# Cookie-Editor-Next

Independent maintenance of [buigiathanh/Cookie_Editor](https://github.com/buigiathanh/Cookie_Editor), originally by Thanh Bui (buigiathanh) and upstream contributors. This is not the official upstream distribution. The original [GPL-3.0 license](LICENSE), author attribution and upstream README below are retained.

- `upstream-main` preserves the complete, unmodified upstream Git history at `ca3996694dd2559e1f1f9472cced42a2d02435a3`. Our `main` uses a separate linear source-snapshot baseline, with independent maintenance commits.
- The supplied ChatGPT-oriented adaptation replaces the `sidePanel` entry with a 640×600 toolbar popup and omits the wetab.org ad-detector content-script registration. The upstream JSON Cookie import fixes remain unchanged; they are not new fixes authored by this project.
- [Validation run 40482149539](https://github.com/xue-ding-e/Cookie-Editor-Next/actions/runs/40482149539) passed **4 Cookie-import unit tests, 5 static popup checks, and the Vite build** for `289c45b2931ed478150544c5e945fd26ad108723`. This does **not** verify installation or opening in the native ChatGPT browser, real login sessions, or all import formats. No real Cookies were used.
- **Runtime privacy:** this is not a purely local editor. The upstream opt-in n8n integration is retained: when enabled, it can retrieve Cookies requested through the remote service and send password-encrypted Cookie data to cookieeditor.org. Upstream analytics, remote sharing/import and other network features are also retained. No user Cookie exports or credentials are intentionally bundled; static secret screening is not a guarantee about every runtime behavior.

## 安装 Cookie-Editor-Next / Install this Next edition

[下载最新 Next 预览版 / Download Next previews](https://github.com/xue-ding-e/Cookie-Editor-Next/releases) · [已验证源码构建 5787e812](https://github.com/xue-ding-e/Cookie-Editor-Next/releases/tag/v1.1.0.1-next.build.5787e812d3c4)

`main` 推送由 GitHub Actions 自动运行源码测试、构建和包装检查，通过后发布对应 SHA 的独立预览版与校验清单；失败不覆盖已有版本。连续推送可能合并排队，优先验证最新提交。当前浏览器安装仍为手动加载 ZIP，不是商店自动升级。

1. 下载最新预览 Release 中以 `Cookie-Editor-Next_` 开头、以 `_unpacked.zip` 结尾的安装包，按同页 `SHA256SUMS` 校验后解压到一个固定目录。不要选择 GitHub 自动生成的 Source code ZIP。
2. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`；如你的浏览器或组织策略允许，打开“开发者模式”，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的目录。
3. 检查权限后启用扩展并将它固定到工具栏，通过工具栏图标打开 popup。它会请求 Cookie、标签页以及 HTTP/HTTPS 网站访问权限；不需要开启远程 n8n 功能。
4. 更新时先保留自己的导出/配置备份，用新版本文件替换该固定目录，再在扩展管理页点“重新加载”。这不是浏览器商店的自动更新通道。卸载请在同一页面选择“移除”。

This is a prebuilt **unpacked Chromium extension**, not a Chrome Web Store listing or signed CRX. Extract the release ZIP, then use **Load unpacked** on Chrome/Edge's extensions page if your browser and organization allow it. Review the requested permissions. Keep the extracted folder; reload it after replacing it with a newer release. Do not disable browser security protections or bypass organization policy.

**验证范围 / Validation:** source tests (including mocked browser handlers), 54 Node checks and the Vite build passed for `5787e812d3c4536118238e96975e92c03dff803d`. Actual installation in Chrome/Edge and the ChatGPT built-in browser has **not** been verified. A browser without extension loading cannot use these steps. Firefox/Safari support and a store listing are not provided.

**隐私 / Privacy:** 上述 Runtime privacy 提醒仍适用，保留上游统计、远程分享及可选 n8n 功能；本次构建及测试未读取真实 Cookie。请勿把包含登录凭据的 Cookie 分享给不可信方。The retained network features are not removed by this packaging change. The GPL license and corresponding source are included/linked with the release.

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

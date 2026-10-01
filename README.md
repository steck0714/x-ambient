# x-ambient (Unofficial Chrome .crx / Firefox .xpi Port)

This project provides unofficial **Chrome (`.crx`) and Firefox (`.xpi`) pre-built packages** of **[x-ambient](https://github.com)**, originally developed by mmnga. 

The core light-emission and real-time color analysis logic remains entirely unchanged. This fork focuses purely on multi-browser compatibility and easier deployment.

---

## ✨ Features
* **Dynamic Ambient Light:** Hover your mouse over photos, videos, or avatars on your X (formerly Twitter) timeline to diffuse a beautiful, glowing ambient light effect across the page.
* **Real-time Video Sync:** The glow dynamically synchronizes and changes colors in real-time as video content plays.
* **Highly Customizable:** Adjust the intensity, blur, and spread of the light directly from the extension's menu to fit your preference.

---

## 📦 Downloads
Choose the package that matches your web browser:

* **For Google Chrome / Chromium-based browsers:** `x-ambient.crx`
* **For Mozilla Firefox / Firefox-based browsers:** `x-ambient.xpi`

---

## 🛠️ Package Modifications & Compatibility
While the core functional code is identical to the original repository, the following adjustments were made to ensure seamless cross-browser support:
* **Firefox (`.xpi`) Support:** Integrated a lightweight compatibility script (`src/firefox-compat.js`) to bridge `chrome.*` API to Promise-based calls, and configured a dedicated Gecko ID.
* **Optimized Manifest:** Refined host permissions for accurate domain matching.
* **Privacy First:** Explicitly declared a zero-data-collection policy in the manifest settings.

---

## 📜 License & Credits
This project is distributed under the **MIT License**, matching the original repository. 

* **Original Creator:** mmnga
* **Original Repository:** [mmnga/x-ambient](https://github.com)

The original `LICENSE` file containing the copyright notice `Copyright (c) 2024 mmnga` is preserved and packaged inside both files.

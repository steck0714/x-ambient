(() => {
  "use strict";

  const LANGUAGE_OPTIONS = Object.freeze([
    { locale: "en", label: "English" },
    { locale: "es", label: "Español" },
    { locale: "ja", label: "日本語" },
    { locale: "ko", label: "한국어" },
    { locale: "zh_CN", label: "简体中文" },
    { locale: "zh_TW", label: "繁體中文" },
    { locale: "th", label: "ไทย" },
    { locale: "vi", label: "Tiếng Việt" },
    { locale: "id", label: "Bahasa Indonesia" },
    { locale: "fr", label: "Français" },
    { locale: "de", label: "Deutsch" },
    { locale: "pt_BR", label: "Português (Brasil)" },
    { locale: "pt_PT", label: "Português (Portugal)" },
    { locale: "it", label: "Italiano" },
    { locale: "ru", label: "Русский" },
    { locale: "ar", label: "العربية", direction: "rtl" },
    { locale: "hi", label: "हिन्दी" },
  ].map(Object.freeze));
  const LANGUAGES = Object.freeze(LANGUAGE_OPTIONS.map(option => option.locale));
  const LANGUAGE_STORAGE_KEY = "xAmbientLanguage";
  const catalogBase = typeof document !== "undefined" && document.currentScript?.src
    ? new URL("../_locales/", document.currentScript.src) : null;
  const catalogs = new Map();

  function localeForTag(value) {
    const parts = String(value).toLowerCase().replaceAll("_", "-").split("-");
    const exact = LANGUAGES.find(locale => locale.toLowerCase().replaceAll("_", "-") === parts.join("-"));
    if (exact) return exact;
    const base = parts[0];
    if (base === "pt") {
      const region = parts.slice(1).find(part => /^[a-z]{2}$|^\d{3}$/.test(part));
      const locale = region && region !== "br" ? "pt_PT" : "pt_BR";
      return LANGUAGES.includes(locale) ? locale : null;
    }
    if (base === "zh") {
      const traditional = parts.includes("hant") || (!parts.includes("hans") && parts.some(part => ["tw", "hk", "mo"].includes(part)));
      const locale = traditional ? "zh_TW" : "zh_CN";
      return LANGUAGES.includes(locale) ? locale : null;
    }
    return LANGUAGES.includes(base) ? base : null;
  }

  function normalizeLanguage(value) {
    return localeForTag(value) || "auto";
  }

  function resolveLocale(language, uiLanguage = "en") {
    const selected = normalizeLanguage(language);
    return selected === "auto" ? localeForTag(uiLanguage) || "en" : selected;
  }

  function populateLanguageSelect(select) {
    const selected = normalizeLanguage(select.value);
    for (const option of select.querySelectorAll('option:not([value="auto"])')) option.remove();
    for (const { locale, label } of LANGUAGE_OPTIONS) {
      const option = select.ownerDocument.createElement("option");
      option.value = locale;
      option.lang = locale.replaceAll("_", "-");
      option.dir = "auto";
      option.textContent = label;
      select.append(option);
    }
    select.value = selected;
  }

  function createTranslator(locale, messages, fallback = {}, nativeGetMessage) {
    const direction = LANGUAGE_OPTIONS.find(option => option.locale === locale)?.direction || "ltr";
    function getMessage(key) {
      return messages[key]?.message || nativeGetMessage?.(key) || fallback[key]?.message || "";
    }

    function apply(root) {
      const attributes = ["title", "aria-label", "alt"];
      const selector = ["[data-i18n]", ...attributes.map(name => `[data-i18n-${name}]`)].join(",");
      for (const element of root.querySelectorAll(selector)) {
        if (element.dataset.i18n) {
          const text = getMessage(element.dataset.i18n);
          if (text) element.textContent = text;
        }
        for (const attribute of attributes) {
          const key = element.getAttribute(`data-i18n-${attribute}`);
          if (key) {
            const text = getMessage(key);
            if (text) element.setAttribute(attribute, text);
          }
        }
      }
      if (root.documentElement) {
        root.documentElement.lang = locale.replaceAll("_", "-");
        root.documentElement.dir = direction;
      }
    }

    return Object.freeze({ locale, getMessage, apply });
  }

  async function readCatalog(locale) {
    if (!catalogs.has(locale)) {
      const url = typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL(`_locales/${locale}/messages.json`)
        : new URL(`${locale}/messages.json`, catalogBase).href;
      const request = fetch(url).then(response => {
        if (!response.ok) throw new Error(`Unable to load locale: ${locale}`);
        return response.json();
      }).catch(error => {
        catalogs.delete(locale);
        throw error;
      });
      catalogs.set(locale, request);
    }
    return catalogs.get(locale);
  }

  async function load(language = "auto", options = {}) {
    const native = typeof chrome !== "undefined" ? chrome.i18n : undefined;
    const uiLanguage = options.uiLanguage ?? native?.getUILanguage?.()
      ?? (typeof navigator !== "undefined" ? navigator.language : "en");
    const locale = resolveLocale(language, uiLanguage);
    const loader = options.readCatalog || readCatalog;
    const fallback = await loader("en");
    const messages = locale === "en" ? fallback : await loader(locale);
    const nativeGetMessage = normalizeLanguage(language) === "auto" && native?.getMessage
      ? key => native.getMessage(key) : undefined;
    return createTranslator(locale, messages, fallback, nativeGetMessage);
  }

  const api = Object.freeze({ LANGUAGES, LANGUAGE_OPTIONS, LANGUAGE_STORAGE_KEY, normalizeLanguage, resolveLocale, populateLanguageSelect, createTranslator, load });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.XAmbientI18n = api;
})();

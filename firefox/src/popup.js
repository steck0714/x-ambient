(() => {
  "use strict";
  const { STORAGE_KEY, DEFAULTS, normalize } = globalThis.XAmbientSettings;
  const I18n = globalThis.XAmbientI18n;
  const ids = ["enabled", "mode", "intensity", "blur", "spread", "scope", "animateVideo", "fitCards"];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const status = document.getElementById("status");
  const languageInput = document.getElementById("language");
  I18n.populateLanguageSelect(languageInput);
  // 表示モードが「自動」のときは端末から判断する（content.js と同じ条件。タッチ機能がなければモバイル扱いにしない）。
  const deviceTouch = navigator.maxTouchPoints > 0
    && (matchMedia("(hover: none) and (pointer: coarse)").matches || /Android|iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent));
  const fitCardsRow = elements.fitCards.closest("label");
  let settings = { ...DEFAULTS };
  let translator;
  let languageRequest = 0;
  let writes = Promise.resolve();

  function setStatus(key) {
    status.dataset.i18n = key;
    const text = translator?.getMessage(key) || chrome.i18n?.getMessage(key)
      || (key === "statusLoadError" ? "Unable to load settings. Reopen the extension." : "");
    if (text) status.textContent = text;
  }

  function render() {
    for (const [id, input] of Object.entries(elements)) {
      if (input.type === "checkbox") input.checked = settings[id];
      else input.value = settings[id];
    }
    for (const id of ["intensity", "blur", "spread"]) {
      document.getElementById(`${id}-value`).value = `${settings[id]}${id === "blur" ? " px" : "%"}`;
    }
    document.body.dataset.enabled = String(settings.enabled && settings.intensity > 0);
    // モバイルモードはホバーできないので、X では「画面の中央に来た投稿」に光を当てる。
    const mobile = settings.mode === "mobile" || (settings.mode === "auto" && deviceTouch);
    fitCardsRow.style.display = mobile ? "none" : ""; // 画面幅に合わせる機能はPC向け
    const ready = settings.enabled && settings.intensity > 0;
    setStatus(ready ? (mobile ? "statusReadyMobile" : "statusReady") : "statusDisabled");
  }

  function save(value) {
    writes = writes.then(() => chrome.storage.local.set(value)).catch(() => setStatus("statusSaveError"));
  }

  async function setLanguage(value, persist = false) {
    const language = I18n.normalizeLanguage(value);
    const request = ++languageRequest;
    const next = await I18n.load(language);
    if (request !== languageRequest) return;
    translator = next;
    translator.apply(document);
    languageInput.value = language;
    render();
    if (persist) save({ [I18n.LANGUAGE_STORAGE_KEY]: language });
  }

  languageInput.addEventListener("change", () => {
    setLanguage(languageInput.value, true).catch(() => setStatus("statusLoadError"));
  });

  for (const [id, input] of Object.entries(elements)) {
    input.addEventListener(input.type === "range" ? "input" : "change", () => {
      settings = normalize({ ...settings, [id]: input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value });
      render();
      save({ [STORAGE_KEY]: { ...settings } });
    });
  }
  document.getElementById("reset").addEventListener("click", () => {
    settings = { ...DEFAULTS };
    render();
    save({ [STORAGE_KEY]: { ...settings } });
  });

  async function initialize() {
    await setLanguage("auto");
    setStatus("statusLoading");
    const result = await chrome.storage.local.get([STORAGE_KEY, I18n.LANGUAGE_STORAGE_KEY]);
    settings = normalize(result[STORAGE_KEY]);
    await setLanguage(result[I18n.LANGUAGE_STORAGE_KEY]);
    document.getElementById("controls").disabled = false;
    elements.enabled.disabled = false;
    languageInput.disabled = false;
    document.getElementById("reset").disabled = false;
  }
  initialize().catch(() => setStatus("statusLoadError"));
})();

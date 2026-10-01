(() => {
  "use strict";
  const { STORAGE_KEY, DEFAULTS, normalize } = globalThis.XAmbientSettings;
  const ids = ["enabled", "intensity", "blur", "spread", "scope", "animateVideo", "fitCards"];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const status = document.getElementById("status");
  let settings = { ...DEFAULTS };
  let writes = Promise.resolve();

  function render() {
    for (const [id, input] of Object.entries(elements)) {
      if (input.type === "checkbox") input.checked = settings[id];
      else input.value = settings[id];
    }
    for (const id of ["intensity", "blur", "spread"]) {
      document.getElementById(`${id}-value`).value = `${settings[id]}${id === "blur" ? "px" : "%"}`;
    }
    document.body.dataset.enabled = String(settings.enabled && settings.intensity > 0);
    status.textContent = settings.enabled && settings.intensity > 0
      ? "Xで投稿にホバーすると光が広がります。"
      : "アンビエントライトはオフです。";
  }

  function save() {
    const next = { ...settings };
    writes = writes.then(() => chrome.storage.local.set({ [STORAGE_KEY]: next })).catch(() => {
      status.textContent = "保存できませんでした。拡張を開き直してください。";
    });
  }

  for (const [id, input] of Object.entries(elements)) {
    input.addEventListener(input.type === "range" ? "input" : "change", () => {
      settings = normalize({ ...settings, [id]: input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value });
      render();
      save();
    });
  }
  document.getElementById("reset").addEventListener("click", () => {
    settings = { ...DEFAULTS };
    render();
    save();
  });

  chrome.storage.local.get(STORAGE_KEY).then((result) => {
    settings = normalize(result[STORAGE_KEY]);
    render();
    document.getElementById("controls").disabled = false;
    elements.enabled.disabled = false;
    document.getElementById("reset").disabled = false;
  }).catch(() => {
    status.textContent = "設定を読み込めませんでした。拡張を開き直してください。";
  });
})();

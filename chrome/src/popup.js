(() => {
  "use strict";
  const { STORAGE_KEY, DEFAULTS, normalize } = globalThis.XAmbientSettings;
  const ids = ["enabled", "mode", "intensity", "blur", "spread", "scope", "animateVideo", "fitCards"];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const status = document.getElementById("status");
  // 表示モードが「自動」のときは端末から判断する（content.js と同じ条件。タッチ機能がなければモバイル扱いにしない）。
  const deviceTouch = navigator.maxTouchPoints > 0
    && (matchMedia("(hover: none) and (pointer: coarse)").matches || /Android|iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent));
  const footerHint = document.querySelector("footer > span");
  const fitCardsRow = elements.fitCards.closest("label");
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
    // モバイルモードはホバーできないので「画面の中央に来た投稿」に光を当てる。
    const mobile = settings.mode === "mobile" || (settings.mode === "auto" && deviceTouch);
    footerHint.textContent = mobile ? "画像・動画のある投稿を画面の中央へ" : "画像・動画のある投稿にホバー";
    fitCardsRow.style.display = mobile ? "none" : ""; // 画面幅に合わせる機能はPC向け
    status.textContent = settings.enabled && settings.intensity > 0
      ? (mobile ? "画面の中央に来た投稿から光が広がります。" : "Xで投稿にホバーすると光が広がります。")
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

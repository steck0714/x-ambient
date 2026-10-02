// iOS / iPadOS / Android の拡張ポップアップ用: 表示領域に合わせて UI の大きさを調整する。
// Orion などでは viewport メタが効かず、ポップアップが約980px幅のレイアウトで描画されて
// 画面の左上に小さく縮んで表示されることがある。実際のレイアウト幅・高さを測り、
// body を拡大して「画面の幅いっぱい・できるだけスクロール不要」に収める。
// 拡大には CSS の zoom ではなく transform を使う。iOS の WebKit は zoom 下で font-size を
// 個別に指定した要素の拡大を無視することがあり、文字の大きさがバラバラになるため。
// デスクトップのブラウザ（Chrome / Firefox / macOS 版 Orion など）では何もしない。
(() => {
  "use strict";

  const mobile = navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  if (!mobile) return;

  const root = document.documentElement;
  const body = document.body;
  const MIN_SHRINK = 0.8; // 高さに合わせて縮めるのは、幅いっぱいの大きさの80%まで（文字を小さくしすぎない）
  let frame = 0;

  root.classList.add("mobile"); // popup.css のスマホ向けの文字サイズ・余白

  function fit() {
    frame = 0;
    body.style.transform = "";
    body.style.width = "";
    root.style.height = "";
    const box = body.getBoundingClientRect(); // 拡大前の素の大きさ
    const viewWidth = root.clientWidth;
    if (!box.width || !viewWidth) return;
    const visibleHeight = Math.min(window.innerHeight, window.visualViewport?.height || Infinity);
    const byWidth = viewWidth / box.width;
    const byHeight = visibleHeight >= 200 && box.height ? (visibleHeight * 0.98) / box.height : byWidth;
    const scale = Math.min(6, Math.max(0.5, Math.min(byWidth, Math.max(byHeight, byWidth * MIN_SHRINK))));
    if (!Number.isFinite(scale)) return;
    body.style.transformOrigin = "0 0";
    body.style.width = `${Math.floor(viewWidth / scale)}px`; // 余った幅はレイアウトを広げて埋める
    body.style.transform = `scale(${scale})`;
    // transform はレイアウトの大きさを変えないので、拡大後の高さ分だけスクロールできるようにする。
    root.style.height = `${Math.ceil(body.offsetHeight * scale)}px`;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(fit);
  }

  fit();
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("orientationchange", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  // 設定の読み込み後に案内文などの行数が変わっても測り直す。
  if ("ResizeObserver" in window) new ResizeObserver(schedule).observe(body);
  // シートの表示アニメーション中はサイズが確定していないことがあるため、少し遅れて測り直す。
  for (const delay of [150, 500, 1200]) setTimeout(schedule, delay);
})();

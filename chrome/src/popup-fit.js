// iOS / iPadOS の拡張ポップアップ用: 表示領域に合わせて UI の大きさを調整する。
// Orion などでは viewport メタが効かず、ポップアップが約980px幅のレイアウトで描画されて
// 画面の左上に小さく縮んで表示されることがある。実際のレイアウト幅・高さを測り、
// body に CSS zoom を掛けて「画面の幅いっぱい・できるだけスクロール不要」に収める。
// デスクトップのブラウザ（Chrome / Firefox / macOS 版 Orion など）では何もしない。
(() => {
  "use strict";

  const isIOS = navigator.maxTouchPoints > 1 && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  if (!isIOS) return;

  const root = document.documentElement;
  const body = document.body;
  const MIN_SHRINK = 0.7; // 高さに合わせて縮めるのは、幅いっぱいの大きさの70%まで
  let frame = 0;

  function fit() {
    frame = 0;
    body.style.zoom = "";
    body.style.width = "";
    const box = body.getBoundingClientRect(); // zoom を外した素の大きさ
    const viewWidth = root.clientWidth;
    if (!box.width || !viewWidth) return;
    const visibleHeight = Math.min(window.innerHeight, window.visualViewport?.height || Infinity);
    const byWidth = viewWidth / box.width;
    const byHeight = visibleHeight >= 200 && box.height ? (visibleHeight * 0.98) / box.height : byWidth;
    const zoom = Math.min(6, Math.max(0.5, Math.min(byWidth, Math.max(byHeight, byWidth * MIN_SHRINK))));
    if (!Number.isFinite(zoom)) return;
    body.style.zoom = String(zoom);
    body.style.width = `${Math.floor(viewWidth / zoom)}px`; // 余った幅はレイアウトを広げて埋める
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(fit);
  }

  fit();
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("orientationchange", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  // シートの表示アニメーション中はサイズが確定していないことがあるため、少し遅れて測り直す。
  for (const delay of [150, 500, 1200]) setTimeout(schedule, delay);
})();

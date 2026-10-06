(() => {
  "use strict";

  const POST_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';
  const BACKGROUND_PROTECTED_SELECTOR = 'button, input, select, textarea, [role="button"], [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [aria-modal="true"], [data-testid="Dropdown"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid^="UserAvatar"]';

  function statusId(pathname) {
    return String(pathname).match(/^\/(?:[^/]+\/status|i\/web\/status)\/(\d+)(?:\/|$)/)?.[1] || null;
  }

  function findDetailPost(root, pathname) {
    const id = statusId(pathname);
    if (!id) return null;
    // Match the post's own timestamp, rather than a quoted post or a link in its text.
    for (const time of root.querySelectorAll("time")) {
      const post = time.closest(POST_SELECTOR);
      const link = time.closest("a[href]");
      if (post && link && link.closest(POST_SELECTOR) === post
        && !time.closest('[data-testid="quoteTweet"]') && statusId(link.pathname) === id) return post;
    }
    return null;
  }

  // Keep the browser entry self-contained: already loaded manifests may have an older script list.
  const Posts = Object.freeze({ POST_SELECTOR, statusId, findDetailPost });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Posts;
    return;
  }

  const Core = globalThis.XAmbientCore;
  const Settings = globalThis.XAmbientSettings;
  const Streaming = globalThis.XAmbientStreaming;
  const Instagram = globalThis.XAmbientInstagram;
  if (!Core || !Settings) return;
  globalThis.__xAmbientDispose?.();
  const platform = Streaming?.platformForHostname(location.hostname) || "x";
  const instagram = platform === "instagram";
  const streaming = platform === "twitch" || platform === "kick";
  const automatic = streaming || instagram;
  const cards = platform === "x" ? globalThis.XAmbientCardLayout?.create() : null;

  const IMAGE_SELECTOR = instagram ? "img" : [
    '[data-testid="tweetPhoto"] img',
    'img[src*="pbs.twimg.com/media/"]',
    'img[src*="pbs.twimg.com/tweet_video_thumb/"]',
    'img[src*="pbs.twimg.com/ext_tw_video_thumb/"]',
    'img[src*="pbs.twimg.com/amplify_video_thumb/"]',
  ].join(",");
  // 描画は動画のフレーム単位で間引く（stride）。目標は 15fps 以上で、余裕があれば 30fps まで上げ、
  // どんなに重くても 10fps（間隔 100ms）を下回らない。重いときは先に画質（tier）を落とす。
  const FLOOR_GAP_MS = 100;
  const PRESSURE_WINDOW_MS = 1000; // 落ちた動画フレームの割合を見る間隔
  const PRESSURE_DROP_RATIO = 0.1; // この割合を超えて落ちていたら、負荷が高いとみなす
  const PRESSURE_MIN_DROPS = 4; // ...ただし窓の中で最低でもこの数のフレームが落ちていること
  const SATURATION = "saturate(1.65)"; // X 以外（ページの上に重ねるサイト）は彩度を上げる
  // 彩度の強調は、画面いっぱいの CSS レイヤーに毎フレーム掛けると重く、ページ全体（動画やスクロールまで）が遅くなる。
  // 線形変換なので、小さな canvas に描くときに掛けても結果はほぼ同じ。canvas の filter が使えないブラウザだけ CSS に戻す。
  const bakeSaturation = platform !== "x" && typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;
  const EDGE_MARGIN = 16; // ページ全体に光を広げるときの、画面の外側の余白(px)
  const SETTLE_MS = 140; // スクロールが止まったとみなすまでの時間
  const hasStorage = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const coarsePointer = matchMedia("(hover: none) and (pointer: coarse)");
  const removers = [];
  const posterCache = new WeakMap();
  let settings = { ...Settings.DEFAULTS };
  let pathname = location.pathname;
  let pointer = null;
  let activePost = null;
  let previewPost = null;
  let pendingPost = null;
  let hoverTimer = 0;
  let reconcileFrame = 0;
  let frameHandle = null;
  let lastPaint = 0;
  let media = [];
  let signature = "";
  let bounds = null;
  let projection = null;
  let protectionKey = "";
  let backgroundActive = false;
  let backgroundDirty = true;
  let backgroundRestoreTimer = 0;
  const clearedBackgrounds = new Set();
  let front = 0;
  let disposed = false;
  // モバイルモード（タッチ操作が主の端末）ではホバーできないので、画面の中央にある投稿に光を当てる。
  // 「自動」のときは端末から判断する。タッチ機能がない端末（PC・リモートデスクトップ・VM など）は、
  // (hover: none) と報告されることがあってもモバイル扱いにしない。
  // モバイルモード（画面の中央の投稿に光を当てる・スクロール中は消灯）の対象は X だけ。
  // Instagram・Twitch・Kick はもともとホバーなしで自動追従するので、モードに関係なく従来どおりに動く
  // （Twitch・Kick はチャット欄のスクロールで消灯してしまうため、スクロール連動は X 以外に入れない）。
  // 軽い描画と画質の自動調整は、モードに関係なくすべてのサイトで働く。
  const touchCapable = platform === "x";
  let autoTouch = touchCapable && navigator.maxTouchPoints > 0 && coarsePointer.matches;
  let touchMode = autoTouch;
  let scrolling = false;
  let scrollTimer = 0;
  // 画質と描画間隔は、実測した描画コストで自動調整する。タッチ端末は軽い段から始め、余裕があれば上げる。
  const touchDevice = navigator.maxTouchPoints > 0 && coarsePointer.matches;
  const weakCpu = (navigator.hardwareConcurrency || 4) <= 2;
  const startTier = () => Math.min(Core.QUALITY_TIERS.length - 1, (touchMode || touchDevice ? 3 : 1) + (weakCpu ? 1 : 0));
  const governor = Core.createGovernor({ startTier: startTier(), bestTier: 0, goodFps: 15, topFps: 30, floorGap: FLOOR_GAP_MS });
  let projectionTier = -1;
  let fieldCss = "";
  let themeDirty = true;
  let lastRecover = 0;
  let protectScanKey = "";
  let paintedKey = ""; // 最後に描いた配置（projection.key）
  let protectScanAt = 0;

  const host = document.createElement("div");
  host.id = "x-ambient-light";
  host.dataset.platform = platform;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `all:initial;position:fixed;inset:0;z-index:${platform === "x" ? -1 : 2147483600};pointer-events:none;display:block;overflow:hidden;contain:strict;`;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { --xa-opacity: .65; --xa-blur: 56px; }
    .light { position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity 320ms ease; mask-repeat:no-repeat; mask-composite:add; -webkit-mask-composite:source-over; }
    .light.visible { opacity:var(--xa-opacity); }
    .field { position:absolute; inset:0; pointer-events:none; }
    canvas { position:absolute; inset:0; width:100%; height:100%; opacity:0; transition:opacity 300ms ease; }
    canvas.front { opacity:1; }
    @media (prefers-reduced-motion:reduce) { .light, canvas { transition:none; } }
  `;
  const light = document.createElement("div");
  light.className = "light";
  host.dataset.interaction = touchMode ? "center" : "hover";
  const field = document.createElement("div");
  field.className = "field";
  const canvases = [document.createElement("canvas"), document.createElement("canvas")];
  for (const canvas of canvases) {
    canvas.width = 144;
    canvas.height = 96;
    field.append(canvas);
  }
  light.append(field);
  shadow.append(style, light);
  const backgroundStyle = document.createElement("style");
  backgroundStyle.textContent = ".xa-background-clear { background-color:transparent !important; }";
  backgroundStyle.disabled = true;
  if (platform === "x") {
    document.documentElement.append(backgroundStyle); // X は元の色のまま（彩度を上げない）
  } else if (!bakeSaturation) {
    style.textContent += `canvas { filter:${SATURATION}; }`;
  }
  document.documentElement.append(host);
  const contexts = canvases.map((canvas) => canvas.getContext("2d"));
  const mosaic = document.createElement("canvas");
  mosaic.width = 144;
  const mosaicContext = mosaic.getContext("2d");
  const raw = document.createElement("canvas"); // 光線を描く下絵（画面には出さない）。ぼかしてから画面用の canvas に写す
  // 作業用の canvas（下絵とピラミッドの各段）は CPU 側に固定する。GPU 加速される大きさだと、小さな canvas へ
  // drawImage するたびに GPU からの読み戻しで待たされる。小さいので CPU で十分速い。
  const SCRATCH = { willReadFrequently: true };
  const rawContext = raw.getContext("2d", SCRATCH);
  const pyramid = new Map();
  const fade = { key: "", canvas: document.createElement("canvas") };
  if (!mosaicContext || !rawContext || contexts.some((context) => !context)) {
    host.remove();
    return;
  }

  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options);
    removers.push(() => target.removeEventListener(type, callback, options));
  }

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function stage(key, width, height) {
    let entry = pyramid.get(key);
    if (!entry) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", SCRATCH);
      if (!context) return null;
      entry = { canvas, context };
      pyramid.set(key, entry);
    }
    if (entry.canvas.width !== width || entry.canvas.height !== height) {
      entry.canvas.width = width;
      entry.canvas.height = height;
      entry.context.globalCompositeOperation = "copy"; // 描くたびに中身を丸ごと置き換える（サイズ変更で状態が戻るので毎回設定）
    }
    return entry;
  }

  // CSS の blur は画面いっぱいの面積に毎回かけると重く、コンポジタ全体（動画やスクロールまで）を遅くする。
  // 代わりに、小さな下絵を何段か縮小し、2 倍ずつ拡大して戻すことで「ぼかした見た目」を作る。段ごとにバイリニア補間が
  // 掛かるので滑らかで、CSS の Gaussian blur との差は RMSE で 2〜3% ほど（段数は Core.blurDepth で換算）。
  // 段数は小数にも対応し、隣り合う 2 つの段数の結果を重ねてスライダーの値に連続的に合わせる。drawImage だけなので、
  // クロスオリジンの画像・動画でもピクセルを読まずに済む。
  function pyramidUp(down, depth, tag) {
    let current = down[depth];
    for (let i = depth - 1; i >= 1; i--) {
      const entry = stage(`${tag}${i}`, down[i].width, down[i].height);
      if (!entry) return null;
      entry.context.drawImage(current, 0, 0, entry.canvas.width, entry.canvas.height);
      current = entry.canvas;
    }
    return current;
  }

  function softBlur(source, targetCanvas, targetContext, depth) {
    if (!(depth > 0) || !source.width || !source.height) {
      targetContext.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      return;
    }
    const lower = Math.max(1, Math.floor(depth));
    const mix = Math.min(1, Math.max(0, depth - lower)); // 次の段数の結果をどれだけ重ねるか
    const deepest = mix > 0.02 ? lower + 1 : lower;
    const down = [source];
    for (let i = 1; i <= deepest; i++) {
      const previous = down[i - 1];
      const entry = stage(`down${i}`, Math.max(2, Math.ceil(previous.width / 2)), Math.max(2, Math.ceil(previous.height / 2)));
      if (!entry) return;
      entry.context.drawImage(previous, 0, 0, entry.canvas.width, entry.canvas.height);
      down.push(entry.canvas);
    }
    const first = pyramidUp(down, lower, "a");
    const second = deepest > lower ? pyramidUp(down, deepest, "b") : null;
    if (!first) return;
    if (targetCanvas.width !== first.width) targetCanvas.width = first.width;
    if (targetCanvas.height !== first.height) targetCanvas.height = first.height;
    if (bakeSaturation) targetContext.filter = SATURATION;
    targetContext.globalCompositeOperation = "copy";
    targetContext.drawImage(first, 0, 0);
    targetContext.globalCompositeOperation = "source-over";
    if (second) {
      targetContext.globalAlpha = mix;
      targetContext.drawImage(second, 0, 0);
      targetContext.globalAlpha = 1;
    }
    if (bakeSaturation) targetContext.filter = "none";
  }

  function eligible() {
    return settings.enabled && settings.intensity > 0 && !document.hidden && !document.fullscreenElement;
  }

  function scheduleReconcile() {
    if (disposed || reconcileFrame) return;
    reconcileFrame = requestAnimationFrame(() => {
      reconcileFrame = 0;
      reconcile();
    });
  }

  function updateTheme() {
    if (platform === "x" || !themeDirty) return;
    themeDirty = false;
    const backgrounds = [document.documentElement, document.body].filter(Boolean)
      .map(element => getComputedStyle(element).backgroundColor);
    let dark = colorScheme.matches;
    for (const color of backgrounds) dark = Core.isDarkColor(color, dark);
    host.style.mixBlendMode = dark ? "screen" : "multiply";
  }

  function observeBackgrounds() {
    if (platform !== "x" || !backgroundActive) return;
    backgroundObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "role", "aria-modal"] });
    backgroundObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  }

  function syncBackgrounds() {
    if (platform !== "x") return;
    clearTimeout(backgroundRestoreTimer);
    backgroundRestoreTimer = 0;
    if (backgroundActive && !backgroundDirty) return;
    backgroundActive = true;
    backgroundDirty = false;
    backgroundObserver.disconnect();
    // Temporarily reveal native styles for theme detection, then expose only plain page surfaces.
    // Normal compositing behind the UI lets intensity mix the theme with unmodified media colors.
    backgroundStyle.disabled = true;
    const nativeColors = [document.documentElement, document.body].map(element => getComputedStyle(element).backgroundColor);
    host.style.backgroundColor = Core.resolveBackgroundColor(nativeColors, colorScheme.matches);
    const next = new Set();
    for (const element of document.querySelectorAll("body, body :is(div, main, article, section, aside, header, footer, nav)")) {
      if (element.closest(BACKGROUND_PROTECTED_SELECTOR)) continue;
      if (settings.scope === "post" && activePost?.contains(element)) continue;
      const computed = getComputedStyle(element);
      if (computed.backgroundColor === "rgba(0, 0, 0, 0)" || computed.backgroundImage !== "none"
        || Number(computed.zIndex) > 10) continue;
      const rect = element.getBoundingClientRect();
      if (element !== document.body && (rect.width < 150 || rect.height < 32)) continue;
      if (!element.classList.contains("xa-background-clear")) element.classList.add("xa-background-clear");
      next.add(element);
    }
    for (const element of clearedBackgrounds) if (!next.has(element)) element.classList.remove("xa-background-clear");
    clearedBackgrounds.clear();
    for (const element of next) clearedBackgrounds.add(element);
    backgroundStyle.disabled = false;
    observeBackgrounds();
  }

  function restoreBackgrounds() {
    clearTimeout(backgroundRestoreTimer);
    backgroundRestoreTimer = 0;
    backgroundActive = false;
    backgroundDirty = true;
    backgroundObserver.disconnect();
    backgroundStyle.disabled = true;
    for (const element of clearedBackgrounds) element.classList.remove("xa-background-clear");
    clearedBackgrounds.clear();
    host.style.removeProperty("background-color");
  }

  function releaseBackgrounds() {
    if (platform !== "x" || !backgroundActive || backgroundRestoreTimer) return;
    backgroundRestoreTimer = window.setTimeout(restoreBackgrounds, reducedMotion.matches ? 0 : 320);
  }

  function applySettings(value) {
    const scope = settings.scope;
    settings = Settings.normalize(value);
    if (settings.scope !== scope) backgroundDirty = true;
    syncMode();
    cards?.setEnabled(settings.fitCards && !touchMode);
    host.style.setProperty("--xa-opacity", String(settings.intensity / 100));
    host.style.setProperty("--xa-blur", `${settings.blur}px`);
    if (!eligible()) deactivate();
    else scheduleReconcile();
  }

  function stopFrames() {
    if (!frameHandle) return;
    if (frameHandle.type === "video") frameHandle.video.cancelVideoFrameCallback(frameHandle.id);
    else cancelAnimationFrame(frameHandle.id);
    frameHandle = null;
  }

  function deactivate() {
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    pendingPost = null;
    activePost = null;
    media = [];
    signature = "";
    bounds = null;
    projection = null;
    host.dataset.mediaCount = "0";
    activeObserver.disconnect();
    activeResizeObserver?.disconnect();
    stopFrames();
    light.classList.remove("visible");
    releaseBackgrounds();
  }

  // 祖先ごとのスタイル（透明・はみ出しのクリップ）は 1 回の走査の間は変わらないので、memo に覚えておく。
  // チャット欄の絵文字のように同じ祖先を共有する画像が何百とあっても、祖先の getComputedStyle は 1 回で済む。
  function ancestorInfo(parent, memo) {
    let info = memo?.get(parent);
    if (info) return info;
    const style = getComputedStyle(parent);
    const clipX = ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
    const clipY = ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
    info = {
      hidden: style.opacity === "0" || (instagram && (parent.hidden || parent.getAttribute("aria-hidden") === "true")),
      clipX,
      clipY,
      // Root overflow clips to the viewport, already applied by the caller, not its scrolled DOM box.
      box: (clipX || clipY) && parent !== document.documentElement && style.display !== "contents" ? parent.getBoundingClientRect() : null,
    };
    memo?.set(parent, info);
    return info;
  }

  function visibleRect(element, fullRect, minSize = 48, minIntersection = 16, memo = null) {
    const view = viewport();
    if (!Core.isVisibleRect(fullRect, view, minSize, minIntersection)) return null;
    const computed = getComputedStyle(element);
    if (computed.visibility === "hidden" || computed.visibility === "collapse" || computed.opacity === "0") return null;
    let rect = Core.intersectRect(fullRect, { left: 0, top: 0, right: view.width, bottom: view.height });
    for (let parent = element.parentElement; rect && parent; parent = parent.parentElement) {
      const info = ancestorInfo(parent, memo);
      if (info.hidden) return null;
      if (info.box) rect = Core.intersectRect(rect, info.box, info.clipX, info.clipY);
      if (!instagram && parent === activePost) break;
    }
    return rect && rect.width >= minIntersection && rect.height >= minIntersection ? rect : null;
  }

  function imageDescriptor(source, owner, rect, fullRect) {
    const computed = getComputedStyle(owner);
    const backgroundImage = owner !== source && owner.tagName !== "VIDEO";
    const values = (backgroundImage ? computed.backgroundPosition : computed.objectPosition).split(" ");
    const position = values.map((value) => value.endsWith("%") ? Math.max(0, Math.min(1, parseFloat(value) / 100)) : 0.5);
    const fit = backgroundImage ? (computed.backgroundSize === "contain" ? "contain" : "cover") : computed.objectFit;
    const normalizedPosition = [position[0] ?? 0.5, position[1] ?? 0.5];
    const content = Core.contentRect(source.videoWidth || source.naturalWidth, source.videoHeight || source.naturalHeight, fullRect, fit, normalizedPosition);
    const visible = Core.intersectRect(rect, content);
    if (!visible) return null;
    return { source, owner, rect: visible, fullRect: content, fit: fit === "contain" || fit === "scale-down" ? "fill" : fit, position: normalizedPosition };
  }

  function imagePresenter(image) {
    if (getComputedStyle(image).opacity !== "0") return image;
    // X's React Native Image displays a background div and keeps its loaded img transparent.
    return [...image.parentElement.children].find((element) => element !== image
      && getComputedStyle(element).backgroundImage !== "none") || image;
  }

  function posterFor(video) {
    if (!video.poster) return null;
    let entry = posterCache.get(video);
    if (!entry || entry.url !== video.poster) {
      const image = new Image();
      entry = { url: video.poster, image };
      posterCache.set(video, entry);
      image.addEventListener("load", () => {
        if (!disposed && activePost?.contains(video)) scheduleReconcile();
      }, { once: true });
      image.src = video.poster;
    }
    return entry.image.complete && entry.image.naturalWidth ? entry.image : null;
  }

  function instagramPoster(video) {
    const box = video.getBoundingClientRect();
    for (let parent = video.parentElement; parent && !parent.matches('main, [role="main"]'); parent = parent.parentElement) {
      if (parent.querySelectorAll("video").length > 1) break;
      const image = [...parent.querySelectorAll("img")].find(image => image.complete && image.naturalWidth
        && Core.overlapFraction(box, image.getBoundingClientRect()) > 0.8);
      if (image) return image;
      if (parent.matches("article")) break;
    }
    return null;
  }

  function instagramCandidate(post) {
    const items = [];
    let playing = false;
    for (const element of post.matches("video") ? [post] : post.querySelectorAll("img, video")) {
      if (element.tagName === "IMG" && !Instagram.isPostImage(element)) continue;
      const fullRect = element.getBoundingClientRect();
      if (fullRect.width < 160 || fullRect.height < 90) continue;
      const rect = visibleRect(element, fullRect, 90, 24);
      if (!rect) continue;
      items.push({ rect, fullRect });
      if (element.tagName === "VIDEO" && !element.paused && !element.ended) playing = true;
    }
    return {
      post, playing, dialog: Boolean(post.closest('[role="dialog"]')),
      rect: Core.unionRects(items.map(item => item.rect)),
      fullRect: Core.unionRects(items.map(item => item.fullRect)),
    };
  }

  function findMedia(post) {
    const videos = [];
    for (const video of post.matches("video") ? [post] : post.querySelectorAll("video")) {
      const fullRect = video.getBoundingClientRect();
      const rect = visibleRect(video, fullRect);
      if (!rect) continue;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const descriptor = imageDescriptor(video, video, rect, fullRect);
        if (descriptor) videos.push(descriptor);
      }
      else {
        const poster = posterFor(video);
        const sibling = !poster && instagram && instagramPoster(video);
        const descriptor = poster ? imageDescriptor(poster, video, rect, fullRect)
          : sibling && imageDescriptor(sibling, sibling, rect, sibling.getBoundingClientRect());
        if (descriptor) videos.push(descriptor);
      }
    }
    const images = [];
    for (const image of post.querySelectorAll(IMAGE_SELECTOR)) {
      if (image.closest('[data-testid^="UserAvatar"]') || !image.complete || !image.naturalWidth) continue;
      if (instagram && !Instagram.isPostImage(image)) continue;
      const presenter = imagePresenter(image);
      const fullRect = presenter.getBoundingClientRect();
      if (instagram && (fullRect.width < 160 || fullRect.height < 90)) continue;
      const rect = visibleRect(presenter, fullRect);
      if (!rect || videos.some((video) => Core.overlapFraction(rect, video.rect) > 0.8)) continue;
      if (images.some((other) => Core.overlapFraction(rect, other.rect) > 0.9)) continue;
      const descriptor = imageDescriptor(image, presenter, rect, fullRect);
      if (descriptor) images.push(descriptor);
    }
    const found = [...videos, ...images];
    // A carousel contributes its current slide, not hidden/preloaded neighbors.
    if (instagram) return found.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height).slice(0, 1);
    return found.slice(0, 4);
  }

  function sourceKey(item) {
    return `${item.source.tagName}:${item.source.currentSrc || item.source.src || ""}:${Math.round(item.rect.width)}x${Math.round(item.rect.height)}:${Math.round(item.rect.left - item.fullRect.left)},${Math.round(item.rect.top - item.fullRect.top)}`;
  }

  // 影を落とす先（メディア）を避けるためのマスク。X ではこの光はページの背後にあって、メディアは不透明に
  // 上へ重なるので、避ける必要がない。マスクをやめると、コンポジタの 1 パスと、画面内の画像・動画をすべて
  // 調べる走査（スクロールのたびに走っていた）がなくなる。ほかのサイトは光がページの上に重なるので必要。
  function protectMedia(view) {
    if (platform === "x") {
      if (protectionKey !== "behind") {
        light.style.maskImage = "none";
        protectionKey = "behind";
      }
      return;
    }
    if (streaming) {
      // 動画プレーヤーは動かない。チャット欄の絵文字がずれるたびに調べ直さず、間引く（動画やビューが変われば即座に調べる）。
      const key = `${view.width}x${view.height}:${[bounds.left, bounds.top, bounds.width, bounds.height].map(Math.round).join(",")}`;
      const now = performance.now();
      if (key === protectScanKey && now - protectScanAt < 600) return;
      protectScanKey = key;
      protectScanAt = now;
    }
    const memo = new Map();
    const protectedRects = [];
    for (const element of document.querySelectorAll("img, video, canvas")) {
      // Instagram's decorative Reel backdrop must remain part of the lit background.
      if (instagram && element.tagName === "IMG" && element.getAttribute("aria-hidden") === "true") continue;
      const presenter = element.tagName === "IMG" ? imagePresenter(element) : element;
      const box = presenter.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) continue;
      const picture = imageDescriptor(element, presenter, box, box)?.fullRect || box;
      const rect = visibleRect(presenter, picture, 8, 8, memo);
      if (!rect) continue;
      const rounded = presenter.closest('[data-testid="tweetPhoto"], [data-testid^="UserAvatar"], [data-testid="videoPlayer"]') || presenter;
      const radiusValue = getComputedStyle(rounded).borderTopLeftRadius;
      const radius = radiusValue.endsWith("%") ? Math.min(rect.width, rect.height) * parseFloat(radiusValue) / 100 : parseFloat(radiusValue) || 0;
      const letterboxed = Math.abs(picture.width - box.width) > 2 || Math.abs(picture.height - box.height) > 2;
      protectedRects.push({ ...rect, radius: letterboxed ? 0 : Math.min(radius, rect.width / 2, rect.height / 2) });
    }
    const nextKey = `${view.width}:${view.height}:${protectedRects.map((rect) => [rect.left, rect.top, rect.width, rect.height, rect.radius].map(Math.round).join(",")).join(";")}`;
    if (nextKey !== protectionKey) {
      light.style.maskImage = Core.buildMediaMask(protectedRects, view);
      protectionKey = nextKey;
    }
  }

  // 投稿の周りだけに光を出すとき、領域の端で光が急に途切れないよう、端をなだらかに消す下絵を作る。
  // （以前は CSS の blur が領域の端も一緒にぼかしていた）
  function edgeFade(size, feather) {
    const key = `${size.width}x${size.height}:${Math.round(feather)}`;
    if (fade.key === key) return fade.canvas;
    fade.canvas.width = size.width;
    fade.canvas.height = size.height;
    const context = fade.canvas.getContext("2d", SCRATCH);
    context.fillStyle = "#000";
    context.fillRect(0, 0, size.width, size.height);
    context.globalCompositeOperation = "destination-in";
    for (const [x0, y0, x1, y1] of [[0, 0, feather, 0], [size.width, 0, size.width - feather, 0], [0, 0, 0, feather], [0, size.height, 0, size.height - feather]]) {
      const gradient = context.createLinearGradient(x0, y0, x1, y1);
      // smoothstep: 端で 0、feather の半分で 0.5、内側で 1（CSS blur が領域の端に作っていた S 字の落ち方に合わせる）
      for (const step of [0, 0.25, 0.5, 0.75, 1]) gradient.addColorStop(step, `rgba(0,0,0,${3 * step * step - 2 * step ** 3})`);
      context.fillStyle = gradient;
      context.fillRect(0, 0, size.width, size.height);
    }
    fade.key = key;
    return fade.canvas;
  }

  function updateLayout() {
    if (!activePost || !bounds) return;
    const view = viewport();
    const scope = settings.scope;
    const tier = Core.QUALITY_TIERS[governor.tier];
    projectionTier = governor.tier;
    host.dataset.scope = scope;
    host.dataset.projection = "rays";
    let region;
    if (scope === "page") {
      protectMedia(view);
      // 光は画面の外まで要らない（端の色は引き伸ばされる）。余白は少しだけにして、下絵の解像度を画面に使う。
      region = { left: -EDGE_MARGIN, top: -EDGE_MARGIN, width: view.width + EDGE_MARGIN * 2, height: view.height + EDGE_MARGIN * 2 };
    } else {
      protectionKey = "";
      light.style.maskImage = Core.buildPostMask(activePost.getBoundingClientRect(), view);
      // 以前は CSS の blur が領域の外へ約 1.5σ 滲んでいた。今は端をなだらかに消す（下の edgeFade）ので、その分だけ領域を広げて見える範囲を揃える。
      const padding = 60 + settings.spread * 3.4 + settings.blur * 1.5;
      region = { left: bounds.left - padding, top: bounds.top - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
    }
    const nextFieldCss = `position:absolute;left:${region.left}px;top:${region.top}px;width:${region.width}px;height:${region.height}px;`;
    if (nextFieldCss !== fieldCss) {
      field.style.cssText = nextFieldCss;
      fieldCss = nextFieldCss;
    }
    const scale = tier.size / Math.max(region.width, region.height);
    const size = { width: Math.round(region.width * scale), height: Math.round(region.height * scale) };
    const target = {
      left: (bounds.left - region.left) / region.width * size.width,
      top: (bounds.top - region.top) / region.height * size.height,
      width: bounds.width / region.width * size.width,
      height: bounds.height / region.height * size.height,
    };
    const source = {
      width: tier.mosaic,
      height: Math.max(Math.round(tier.mosaic / 3), Math.min(tier.mosaic, Math.round(tier.mosaic * bounds.height / bounds.width))),
    };
    // 画面が小さい端末（モバイルモード、またはタッチ端末で自動追従するサイト）は、PC と同じ減衰だと画面全体が
    // 一様に色づいてしまう。画面の高さに合わせて減衰させ、メディアの近くが明るく、離れるほど薄くなるようにする。
    const compact = touchMode || (automatic && touchDevice);
    const reach = (compact ? view.height * (0.2 + settings.spread / 100 * 0.5) : 120 + settings.spread * 12) * scale;
    // X は端の色を下限として保つ（本家 0.3.0 の見た目）。モバイルでも同じにする。
    const edgeStrength = platform === "x" ? settings.intensity / 100 : 0;
    // 見えないほど薄い帯は描かない。
    const strips = Core.buildRayProjection(source, target, size, reach, edgeStrength, tier.steps).filter((strip) => strip.alpha >= 0.012);
    const deepest = Math.max(1, Math.floor(Math.log2(Math.min(size.width, size.height))) - 1);
    const depth = Core.blurDepth(settings.blur * scale, deepest);
    const feather = scope === "post" ? Math.max(2, Math.min(3 * settings.blur * scale, Math.min(size.width, size.height) / 2.5)) : 0;
    const key = [region.left, region.top, region.width, region.height, bounds.left, bounds.top, bounds.width, bounds.height].map(Math.round).join(",") + `|${governor.tier}|${settings.blur}|${settings.spread}|${settings.intensity}`;
    projection = { size, source, target, depth, strips, feather, key };
    updateTheme();
  }

  function paint(index) {
    if (!bounds || !media.length || !projection) return false;
    const canvas = canvases[index];
    const context = contexts[index];
    if (mosaic.width !== projection.source.width) mosaic.width = projection.source.width;
    if (mosaic.height !== projection.source.height) mosaic.height = projection.source.height;
    mosaicContext.clearRect(0, 0, mosaic.width, mosaic.height);
    let drawn = false;
    for (const item of media) {
      const source = item.source;
      const sourceWidth = source.videoWidth || source.naturalWidth;
      const sourceHeight = source.videoHeight || source.naturalHeight;
      const target = {
        left: (item.fullRect.left - bounds.left) / bounds.width * mosaic.width,
        top: (item.fullRect.top - bounds.top) / bounds.height * mosaic.height,
        width: item.fullRect.width / bounds.width * mosaic.width,
        height: item.fullRect.height / bounds.height * mosaic.height,
      };
      const crop = Core.fitImage(sourceWidth, sourceHeight, target, item.fit, item.position);
      if (!crop) continue;
      mosaicContext.save();
      try {
        mosaicContext.beginPath();
        mosaicContext.rect((item.rect.left - bounds.left) / bounds.width * mosaic.width, (item.rect.top - bounds.top) / bounds.height * mosaic.height, item.rect.width / bounds.width * mosaic.width, item.rect.height / bounds.height * mosaic.height);
        mosaicContext.clip();
        // Display-only: never read/export pixels, so cross-origin media can be drawn too.
        mosaicContext.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, crop.dx, crop.dy, crop.dw, crop.dh);
        drawn = true;
      } catch {
        // The site may replace a video source while React reuses its element. Retry once in a while, not every frame.
        const now = performance.now();
        if (now - lastRecover > 500) {
          lastRecover = now;
          scheduleReconcile();
        }
      } finally {
        mosaicContext.restore();
      }
    }
    if (raw.width !== projection.size.width) raw.width = projection.size.width;
    if (raw.height !== projection.size.height) raw.height = projection.size.height;
    rawContext.clearRect(0, 0, raw.width, raw.height);
    if (drawn) {
      const target = projection.target;
      rawContext.drawImage(mosaic, target.left, target.top, target.width, target.height);
      for (const strip of projection.strips) {
        rawContext.globalAlpha = strip.alpha;
        rawContext.drawImage(mosaic, strip.sx, strip.sy, strip.sw, strip.sh, strip.dx, strip.dy, strip.dw, strip.dh);
      }
      rawContext.globalAlpha = 1;
    }
    softBlur(raw, canvas, context, drawn ? projection.depth : 0);
    paintedKey = projection.key;
    if (drawn && projection.feather > 0) {
      // ぼかした後の出力に掛ける。先に掛けると、ぼかしで端の透明が内側へ滲み、端が 0 まで消えず段差になる。
      context.globalCompositeOperation = "destination-in";
      context.drawImage(edgeFade({ width: canvas.width, height: canvas.height }, projection.feather * canvas.width / raw.width), 0, 0);
      context.globalCompositeOperation = "source-over";
    }
    return drawn;
  }

  function startFrames() {
    if (!eligible() || !settings.animateVideo || reducedMotion.matches) {
      stopFrames();
      return;
    }
    const video = media.find((item) => item.source.tagName === "VIDEO" && !item.source.paused && !item.source.ended)?.source;
    if (!video) {
      stopFrames();
      return;
    }
    if (frameHandle?.video === video) return; // すでにこの動画を追っている。間隔の学習を捨てないよう作り直さない
    stopFrames();
    const type = typeof video.requestVideoFrameCallback === "function" ? "video" : "raf";
    let lastFrame = 0;
    let framesSince = 0;
    let pressure = false;
    let strikes = 0;
    let qualityAt = 0;
    let qualityTotal = 0;
    let qualityDropped = 0;
    let paints = 0;
    let statsAt = 0;
    // 動画のフレームが落ちている割合。描画が重すぎてページ全体が追いつかないと、ここに出る。
    // 起動直後の数コマ落ちや一瞬の引っかかりで画質を下げないよう、落ちが続く（2 回連続の窓）ときだけ負荷とみなす。
    const samplePressure = (time) => {
      if (time - qualityAt < PRESSURE_WINDOW_MS) return pressure;
      const quality = video.getVideoPlaybackQuality?.();
      const first = qualityAt === 0;
      qualityAt = time;
      if (!quality) return false;
      const total = quality.totalVideoFrames - qualityTotal;
      const dropped = quality.droppedVideoFrames - qualityDropped;
      qualityTotal = quality.totalVideoFrames;
      qualityDropped = quality.droppedVideoFrames;
      const heavy = !first && total >= 12 && dropped >= PRESSURE_MIN_DROPS && dropped / total > PRESSURE_DROP_RATIO;
      strikes = heavy ? strikes + 1 : 0;
      return strikes >= 2;
    };
    const next = (time) => {
      frameHandle = null;
      if (!eligible() || !activePost?.isConnected || video.paused || video.ended) return;
      if (lastFrame) governor.observePeriod(time - lastFrame);
      lastFrame = time;
      framesSince++;
      // stride フレームに 1 回描く。ただし、次を待つと間隔が下限（10fps）を超えるなら今描く。
      if (framesSince >= governor.stride || time - lastPaint + governor.period * 0.5 >= FLOOR_GAP_MS) {
        framesSince = 0;
        if (projectionTier !== governor.tier) updateLayout();
        const started = performance.now();
        paint(front);
        const cost = performance.now() - started;
        lastPaint = time;
        pressure = samplePressure(time);
        governor.sample({ cost, now: time, pressure });
        paints++;
        if (globalThis.__xAmbientDebug) {
          globalThis.__xAmbientStats = { tier: governor.tier, stride: governor.stride, period: governor.period, cost: governor.cost, pressure, interaction: host.dataset.interaction, platform };
        }
      }
      // 実機で確かめられるよう、1 秒ごとの実測の描画 fps と現在の画質を data 属性に出す（DevTools で #x-ambient-light を見る）。
      if (!statsAt) statsAt = time;
      else if (time - statsAt >= 1000) {
        host.dataset.fps = (paints * 1000 / (time - statsAt)).toFixed(1);
        host.dataset.tier = String(governor.tier);
        host.dataset.stride = String(governor.stride);
        paints = 0;
        statsAt = time;
      }
      queue();
    };
    const queue = () => {
      frameHandle = { type, video, id: type === "video" ? video.requestVideoFrameCallback(next) : requestAnimationFrame(next) };
    };
    queue();
  }

  function refreshMedia(changedPost = false) {
    if (!activePost) return;
    const nextMedia = findMedia(activePost);
    const nextSignature = nextMedia.map(sourceKey).join("|");
    const changed = changedPost || nextSignature !== signature
      || nextMedia.some((item, index) => item.source !== media[index]?.source);
    media = nextMedia;
    signature = nextSignature;
    bounds = Core.unionRects(media.map((item) => item.rect));
    host.dataset.mediaCount = String(media.length);
    if (!media.length || !bounds?.width || !bounds.height) {
      light.classList.remove("visible");
      releaseBackgrounds();
      stopFrames();
      return;
    }
    updateLayout();
    if (changed) {
      const back = 1 - front;
      if (paint(back)) {
        syncBackgrounds();
        canvases[front].classList.remove("front");
        canvases[back].classList.add("front");
        front = back;
        light.classList.add("visible");
      }
      lastPaint = performance.now();
    } else {
      // 動画のフレームが今描いたばかりで、配置も変わっていないなら、同じ絵をもう一度描かない
      // （チャットの更新などで reconcile だけが走る場合）。スクロールやリサイズで配置が変われば、すぐ描き直す。
      const fresh = frameHandle !== null && performance.now() - lastPaint < FLOOR_GAP_MS && projection.key === paintedKey;
      if (fresh || paint(front)) {
        syncBackgrounds();
        light.classList.add("visible");
      }
      if (!fresh) lastPaint = performance.now(); // この描画も間引きの勘定に入れる
    }
    startFrames();
  }

  function activate(post) {
    // 先に保留を外す。外さないと、ここで中断したときに pendingPost が残り、reconcile が「もう予約済み」と
    // 見なして同じ投稿をずっと点灯させなくなる（スクロール開始の直前に予約された場合など）。
    pendingPost = null;
    if (disposed || !eligible() || !post.isConnected || (touchMode && scrolling)) return;
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    // 「投稿の周りだけ」のときだけ、アクティブな投稿が変わると透明にする面が変わる。ページ全体なら変わらないので
    // 走査し直さない（走査はページ全体の div を調べるので重い）。
    if (activePost !== post && settings.scope === "post") backgroundDirty = true;
    activePost = post;
    activeObserver.disconnect();
    activeObserver.observe(post, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "poster"] });
    activeResizeObserver?.disconnect();
    activeResizeObserver?.observe(post);
    refreshMedia(true);
  }

  function postAt(x, y) {
    return document.elementFromPoint(x, y)?.closest(POST_SELECTOR) || null;
  }

  function reconcile() {
    if (pathname !== location.pathname) {
      pathname = location.pathname;
      // Coordinates from the previous page must not select a reply on arrival.
      pointer = null;
      deactivate();
    }
    if (!eligible()) {
      deactivate();
      return;
    }
    if (instagram) {
      const candidates = Instagram?.findPosts(document, pathname).map(instagramCandidate) || [];
      const post = Instagram?.pickActive(candidates, viewport(), activePost);
      if (!post) deactivate();
      else if (post === activePost) refreshMedia();
      else activate(post);
      return;
    }
    if (streaming) {
      const candidates = [...document.querySelectorAll("video")].map(video => ({
        video, rect: visibleRect(video, video.getBoundingClientRect(), 160, 48),
      }));
      const video = Streaming.pickVideo(candidates);
      if (!video) deactivate();
      else if (video === activePost) refreshMedia();
      else activate(video);
      return;
    }
    // モバイルモード: ホバーの代わりに画面の中央を「ポインタ」として扱う。スクロールが止まってから当て直す。
    if (touchMode) {
      if (scrolling) return;
      const view = viewport();
      pointer = { x: view.width / 2, y: view.height / 2 };
    }
    const detailPost = Posts.findDetailPost(document, pathname) || (previewPost?.isConnected ? previewPost : null);
    let post = pointer ? postAt(pointer.x, pointer.y) : null;
    // 画面中央が投稿どうしの隙間に当たっても、すぐ上下の投稿を拾う
    if (!post && touchMode) post = postAt(pointer.x, pointer.y - 24) || postAt(pointer.x, pointer.y + 24);
    post = post || detailPost;
    if (post === activePost && post) {
      refreshMedia();
      return;
    }
    if (!post) {
      deactivate();
      return;
    }
    if (post === detailPost) {
      activate(post);
      return;
    }
    if (post === pendingPost) return;
    deactivate();
    pendingPost = post;
    hoverTimer = window.setTimeout(() => {
      hoverTimer = 0;
      if (pendingPost === post) activate(post);
    }, touchMode ? 0 : 70);
  }

  const activeObserver = new MutationObserver(scheduleReconcile);
  const backgroundObserver = new MutationObserver(records => {
    const changed = records.some(record => {
      const target = record.target;
      if (!(target instanceof Element)) return false;
      if (clearedBackgrounds.has(target)) return true;
      if (target.closest(BACKGROUND_PROTECTED_SELECTOR)) return Boolean(target.querySelector(".xa-background-clear"));
      if (record.type === "childList") return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE);
      return target === document.documentElement || target === document.body || clearedBackgrounds.has(target)
        || getComputedStyle(target).backgroundColor !== "rgba(0, 0, 0, 0)";
    });
    if (changed) {
      backgroundDirty = true;
      scheduleReconcile();
    }
  });
  const activeResizeObserver = automatic ? new ResizeObserver(scheduleReconcile) : null;
  const watchedMedia = streaming ? "video" : "article, img, video";
  const pageObserver = new MutationObserver((records) => {
    if (pathname !== location.pathname) scheduleReconcile();
    if ((!automatic && !pointer && !Posts.statusId(location.pathname)) || !eligible()) return;
    if (!automatic && records.some(record => record.type === "attributes" && record.target.matches('a[href*="/status/"]'))) scheduleReconcile();
    if (instagram && records.some(record => record.type === "attributes"
      && (record.target.matches('article, img, video, [role="dialog"]') || record.target.querySelector("article, img, video")))) scheduleReconcile();
    if (streaming && records.some(record => record.type === "attributes"
      && (record.target.matches("video") || record.target.querySelector("video")))) scheduleReconcile();
    if (activePost && !activePost.isConnected) scheduleReconcile();
    else if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
      // Twitch・Kick は動画の出入りだけが関係する。チャットの絵文字（img）は毎秒何度も増減するので、拾うと
      // そのたびにページ全体の走査が走ってしまう。
      node.nodeType === Node.ELEMENT_NODE && (node.matches(watchedMedia) || node.querySelector(watchedMedia))))) scheduleReconcile();
  });
  pageObserver.observe(document.body, {
    childList: true, subtree: true,
    attributes: true,
    attributeFilter: automatic ? ["style", "class", "hidden", "aria-hidden", "src", "srcset", "poster"] : ["href"],
  });
  const themeObserver = new MutationObserver(() => { themeDirty = true; scheduleReconcile(); });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });

  // 表示モード: auto は端末から判断 / pc はマウスでホバー / mobile は画面の中央の投稿。
  function syncMode() {
    setTouchMode(touchCapable && (settings.mode === "mobile" ? true : settings.mode === "pc" ? false : autoTouch));
  }

  function setTouchMode(next) {
    if (touchMode === next) return;
    touchMode = next;
    host.dataset.interaction = touchMode ? "center" : "hover";
    governor.reset({ startTier: startTier() });
    scrolling = false;
    clearTimeout(scrollTimer);
    scrollTimer = 0;
    pointer = null;
    cards?.setEnabled(settings.fitCards && !touchMode);
    deactivate();
    scheduleReconcile();
  }

  // 「自動」のとき、マウスとタッチの両方がある端末では最後に使った入力に合わせて切り替える。
  function setAutoTouch(next) {
    autoTouch = next;
    syncMode();
  }
  if (touchCapable) {
    listen(document, "pointerdown", (event) => {
      if (settings.mode === "auto" && event.isTrusted) setAutoTouch(event.pointerType === "touch" && navigator.maxTouchPoints > 0);
    }, { passive: true, capture: true });
    listen(coarsePointer, "change", () => setAutoTouch(navigator.maxTouchPoints > 0 && coarsePointer.matches));
  }
  listen(document, "pointermove", (event) => {
    if (automatic) return;
    if (event.pointerType === "touch") return;
    if (settings.mode === "auto" && autoTouch) setAutoTouch(false);
    if (touchMode) return; // モバイルモード固定のときはマウスの動きを見ない
    pointer = { x: event.clientX, y: event.clientY };
    // Within the same post, mouse motion does not need another media repaint.
    if (event.target instanceof Element && event.target.closest(POST_SELECTOR) === activePost && activePost) return;
    scheduleReconcile();
  }, { passive: true });
  listen(document, "pointerout", (event) => {
    if (automatic || touchMode || event.pointerType === "touch") return;
    if (!event.relatedTarget) {
      pointer = null;
      scheduleReconcile();
    }
  }, { passive: true });
  listen(document, "scroll", () => {
    if (!touchMode) {
      scheduleReconcile();
      return;
    }
    // スマホ: スクロール中は光を消し、止まってから画面中央の投稿に当て直す。
    // 動いている最中に追従させるとマスクがずれ、負荷も高くなるため。
    scrolling = true;
    pendingPost = null; // スクロール中に予約済みの投稿を点灯させない（止まってから当て直す）
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    light.classList.remove("visible");
    stopFrames();
    clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      scrollTimer = 0;
      scrolling = false;
      scheduleReconcile();
    }, SETTLE_MS);
  }, { passive: true, capture: true });
  for (const type of ["transitionend", "transitioncancel", "animationend"]) {
    listen(document, type, event => {
      if (instagram && event.target instanceof Element
        && (event.target.matches("img, video") || event.target.querySelector("img, video"))) scheduleReconcile();
    }, true);
  }
  listen(window, "resize", () => { backgroundDirty = true; scheduleReconcile(); }, { passive: true });
  listen(document, "xambient:layout", scheduleReconcile);
  listen(window, "blur", () => { if (!automatic && !touchMode) { pointer = null; scheduleReconcile(); } });
  listen(window, "focus", scheduleReconcile);
  listen(window, "popstate", scheduleReconcile);
  if (window.navigation) listen(window.navigation, "currententrychange", scheduleReconcile);
  listen(document, "visibilitychange", scheduleReconcile);
  listen(document, "fullscreenchange", scheduleReconcile);
  for (const event of ["load", "loadeddata", "play", "pause", "ended", "seeked", "emptied", "resize"]) {
    listen(document, event, (event) => {
      if (event.target instanceof Element && ((automatic && event.target.matches("img, video"))
        || (activePost && (activePost.contains(event.target) || event.type === "load")))) scheduleReconcile();
    }, true);
  }
  listen(reducedMotion, "change", scheduleReconcile);
  listen(colorScheme, "change", () => { backgroundDirty = true; themeDirty = true; scheduleReconcile(); });

  if (hasStorage) {
    chrome.storage.local.get(Settings.STORAGE_KEY).then((result) => {
      if (!disposed) applySettings(result[Settings.STORAGE_KEY]);
    }).catch(() => {});
    const onStorageChange = (changes, area) => {
      if (area === "local" && changes[Settings.STORAGE_KEY]) applySettings(changes[Settings.STORAGE_KEY].newValue);
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    removers.push(() => chrome.storage.onChanged.removeListener(onStorageChange));
  } else {
    // The local demo uses the same renderer without an installed extension.
    listen(document, "xambient:settings", (event) => applySettings(event.detail));
    listen(document, "xambient:preview", (event) => {
      const post = event.detail;
      previewPost = post instanceof Element && post.matches(POST_SELECTOR) ? post : null;
      scheduleReconcile();
    });
  }
  applySettings(settings);

  function dispose() {
    disposed = true;
    clearTimeout(scrollTimer);
    deactivate();
    cancelAnimationFrame(reconcileFrame);
    activeObserver.disconnect();
    pageObserver.disconnect();
    themeObserver.disconnect();
    cards?.dispose();
    restoreBackgrounds();
    backgroundStyle.remove();
    for (const remove of removers) remove();
    host.remove();
  }
  globalThis.__xAmbientDispose = dispose;
  listen(window, "pagehide", (event) => { if (!event.persisted) dispose(); });
})();

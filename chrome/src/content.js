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
  const FRAME_INTERVAL = 1000 / 12;
  // モバイル: 目標 10fps。描画が重いときだけ 8fps まで落とす（30fps の動画なら 3〜4 フレームに 1 回 = 10〜7.5fps で、7fps を下回らない）。
  const MOBILE_FPS = 10;
  const MOBILE_FPS_SLOW = 8;
  const MOBILE_SLOW_MS = 9; // 1回の描画がこれより重いときは 8fps に落とす
  const MOBILE_MAX_GAP = 1000 / 7.2; // 描画の間隔の上限（約139ms）。フレームの粗い動画でも 7fps 以上を保つ
  const LITE_SIZE = 128; // モバイルの光の下絵の大きさ（長辺）。PC は 256
  const LITE_DEPTH_FACTOR = 2; // ぼかしの大きさ → 縮小段数の換算
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
  // モバイルモード（画面の中央の投稿に光を当てる・軽い描画・スクロール中は消灯）の対象は X だけ。
  // Instagram・Twitch・Kick はもともとホバーなしで自動追従するので、モードに関係なく従来どおりに動く
  // （Twitch・Kick はチャット欄のスクロールで消灯してしまうため、スクロール連動は X 以外に入れない）。
  const touchCapable = platform === "x";
  let autoTouch = touchCapable && navigator.maxTouchPoints > 0 && coarsePointer.matches;
  let touchMode = autoTouch;
  let scrolling = false;
  let scrollTimer = 0;
  let paintCost = 0; // 直近の描画にかかった時間（ms, 指数移動平均）

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
    canvas { position:absolute; inset:0; width:100%; height:100%; opacity:0; transition:opacity 300ms ease; filter:blur(var(--xa-blur)) saturate(1.65); }
    canvas.front { opacity:1; }
    @media (prefers-reduced-motion:reduce) { .light, canvas { transition:none; } }
  `;
  const light = document.createElement("div");
  light.className = "light";
  if (touchMode) light.classList.add("lite");
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
    document.documentElement.append(backgroundStyle);
    // X は元の色のまま（彩度を上げない）。モバイルの軽い描画（.lite）は CSS の blur も掛けない。
    style.textContent += "canvas { filter:blur(var(--xa-blur)); } .light.lite canvas { filter:none; }";
  }
  document.documentElement.append(host);
  const contexts = canvases.map((canvas) => canvas.getContext("2d"));
  const mosaic = document.createElement("canvas");
  mosaic.width = 144;
  const mosaicContext = mosaic.getContext("2d");
  const raw = document.createElement("canvas"); // モバイル用の下絵（画面には出さない）
  const rawContext = raw.getContext("2d");
  const pyramid = new Map();
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
      const context = canvas.getContext("2d");
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

  // CSS の blur は画面いっぱいの面積に毎回かけると重い（特に iOS）。モバイルでは小さな下絵を
  // 何段か縮小し、2 倍ずつ拡大して戻すことで「ぼかした見た目」を作る。段ごとにバイリニア補間が
  // 掛かるので滑らかで、GPU の補間だけで済む。drawImage だけなので、クロスオリジンの画像・動画でも
  // ピクセルを読まずに済む。
  function softBlur(source, targetCanvas, targetContext, depth) {
    if (depth < 2 || !source.width || !source.height) {
      targetContext.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      return;
    }
    const down = [source];
    for (let i = 1; i <= depth; i++) {
      const previous = down[i - 1];
      const entry = stage(`down${i}`, Math.max(2, Math.ceil(previous.width / 2)), Math.max(2, Math.ceil(previous.height / 2)));
      if (!entry) return;
      entry.context.drawImage(previous, 0, 0, entry.canvas.width, entry.canvas.height);
      down.push(entry.canvas);
    }
    let current = down[depth];
    for (let i = depth - 1; i >= 1; i--) {
      const entry = stage(`up${i}`, down[i].width, down[i].height);
      if (!entry) return;
      entry.context.drawImage(current, 0, 0, entry.canvas.width, entry.canvas.height);
      current = entry.canvas;
    }
    if (targetCanvas.width !== current.width) targetCanvas.width = current.width;
    if (targetCanvas.height !== current.height) targetCanvas.height = current.height;
    targetContext.globalCompositeOperation = "copy";
    targetContext.drawImage(current, 0, 0);
    targetContext.globalCompositeOperation = "source-over"; // PC モードの描画で使うので元に戻す
  }

  function frameInterval() {
    if (!touchMode) return FRAME_INTERVAL;
    // 動画のフレーム間隔に合わせて 0.8 倍の余裕を持たせる（12fps の動画でも毎フレーム描画できるように）。
    return (paintCost > MOBILE_SLOW_MS ? 1000 / MOBILE_FPS_SLOW : 1000 / MOBILE_FPS) * 0.8;
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
    if (platform === "x") return;
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

  function visibleRect(element, fullRect, minSize = 48, minIntersection = 16) {
    const view = viewport();
    if (!Core.isVisibleRect(fullRect, view, minSize, minIntersection)) return null;
    const computed = getComputedStyle(element);
    if (computed.visibility === "hidden" || computed.visibility === "collapse" || computed.opacity === "0") return null;
    let rect = Core.intersectRect(fullRect, { left: 0, top: 0, right: view.width, bottom: view.height });
    for (let parent = element.parentElement; rect && parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.opacity === "0" || (instagram && (parent.hidden || parent.getAttribute("aria-hidden") === "true"))) return null;
      const clipX = ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
      const clipY = ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
      // Root overflow clips to the viewport, already applied above, not its scrolled DOM box.
      if ((clipX || clipY) && parent !== document.documentElement && style.display !== "contents") {
        rect = Core.intersectRect(rect, parent.getBoundingClientRect(), clipX, clipY);
      }
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

  function updateLayout() {
    if (!activePost || !bounds) return;
    const view = viewport();
    const scope = settings.scope;
    host.dataset.scope = scope;
    host.dataset.projection = "rays";
    let region;
    if (scope === "page") {
      const protectedRects = [];
      for (const element of document.querySelectorAll("img, video, canvas")) {
        // Instagram's decorative Reel backdrop must remain part of the lit background.
        if (instagram && element.tagName === "IMG" && element.getAttribute("aria-hidden") === "true") continue;
        const presenter = element.tagName === "IMG" ? imagePresenter(element) : element;
        const box = presenter.getBoundingClientRect();
        const picture = imageDescriptor(element, presenter, box, box)?.fullRect || box;
        const rect = visibleRect(presenter, picture, 8, 8);
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
      const padding = touchMode ? 24 : settings.blur * 2; // モバイルは blur を使わないので端の余白は小さくてよい
      region = { left: -padding, top: -padding, width: view.width + padding * 2, height: view.height + padding * 2 };
    } else {
      protectionKey = "";
      light.style.maskImage = Core.buildPostMask(activePost.getBoundingClientRect(), view);
      const padding = 60 + settings.spread * 3.4;
      region = { left: bounds.left - padding, top: bounds.top - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
    }
    field.style.cssText = `position:absolute;left:${region.left}px;top:${region.top}px;width:${region.width}px;height:${region.height}px;`;
    const scale = (touchMode ? LITE_SIZE : 256) / Math.max(region.width, region.height);
    const size = { width: Math.round(region.width * scale), height: Math.round(region.height * scale) };
    const target = {
      left: (bounds.left - region.left) / region.width * size.width,
      top: (bounds.top - region.top) / region.height * size.height,
      width: bounds.width / region.width * size.width,
      height: bounds.height / region.height * size.height,
    };
    const source = { width: mosaic.width, height: Math.max(48, Math.min(144, Math.round(144 * bounds.height / bounds.width))) };
    // モバイルは画面が小さく、PC と同じ減衰だと画面全体が一様に色づいてしまう。画面の高さに合わせて減衰させ、
    // メディアの近くが明るく、離れるほど薄くなるようにする。
    const reach = (touchMode ? view.height * (0.2 + settings.spread / 100 * 0.5) : 120 + settings.spread * 12) * scale;
    const depth = touchMode ? Math.max(2, Math.min(6, Math.round(Math.log2(Math.max(2, settings.blur * scale * LITE_DEPTH_FACTOR))))) : 0;
    // 本家 0.3.0 の edgeStrength（X の端の色を下限として保つ）は PC のみ。モバイルは上の減衰を優先し、
    // 0.2.2.4 と同じく「メディアの近くが明るく、離れるほど薄い」見た目を保つ。
    const edgeStrength = platform === "x" && !touchMode ? settings.intensity / 100 : 0;
    projection = { size, source, target, depth, strips: Core.buildRayProjection(source, target, size, reach, edgeStrength, touchMode ? 24 : 96) };
    updateTheme();
  }

  function paint(index) {
    if (!bounds || !media.length || !projection) return false;
    const canvas = touchMode ? raw : canvases[index];
    const context = touchMode ? rawContext : contexts[index];
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
        // The site may replace a video source while React reuses its element.
        scheduleReconcile();
      } finally {
        mosaicContext.restore();
      }
    }
    if (canvas.width !== projection.size.width) canvas.width = projection.size.width;
    if (canvas.height !== projection.size.height) canvas.height = projection.size.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (drawn) {
      const target = projection.target;
      context.drawImage(mosaic, target.left, target.top, target.width, target.height);
      for (const strip of projection.strips) {
        context.globalAlpha = strip.alpha;
        context.drawImage(mosaic, strip.sx, strip.sy, strip.sw, strip.sh, strip.dx, strip.dy, strip.dw, strip.dh);
      }
      context.globalAlpha = 1;
    }
    if (touchMode) softBlur(raw, canvases[index], contexts[index], drawn ? projection.depth : 0);
    return drawn;
  }

  function startFrames() {
    stopFrames();
    if (!eligible() || !settings.animateVideo || reducedMotion.matches) return;
    const video = media.find((item) => item.source.tagName === "VIDEO" && !item.source.paused && !item.source.ended)?.source;
    if (!video) return;
    const type = typeof video.requestVideoFrameCallback === "function" ? "video" : "raf";
    let lastFrame = 0;
    const next = (time) => {
      frameHandle = null;
      if (!eligible() || !activePost?.isConnected || video.paused || video.ended) return;
      const period = Math.min(time - lastFrame, 200); // 直近の動画フレームの間隔
      lastFrame = time;
      const elapsed = time - lastPaint;
      // モバイルは、次のフレームを待つと間隔が上限を超えるなら今描く（12fps の動画などでも 7fps を下回らない）。
      if (elapsed >= frameInterval() || (touchMode && elapsed + period > MOBILE_MAX_GAP)) {
        const started = performance.now();
        paint(front);
        lastPaint = time;
        if (touchMode) {
          const cost = performance.now() - started;
          paintCost = paintCost ? paintCost * 0.8 + cost * 0.2 : cost;
        }
      }
      queue();
    };
    const queue = () => {
      frameHandle = type === "video"
        ? { type, video, id: video.requestVideoFrameCallback(next) }
        : { type, id: requestAnimationFrame(next) };
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
    } else if (paint(front)) {
      syncBackgrounds();
      light.classList.add("visible");
    }
    startFrames();
  }

  function activate(post) {
    if (disposed || !eligible() || !post.isConnected || (touchMode && scrolling)) return;
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    if (activePost !== post) backgroundDirty = true;
    activePost = post;
    pendingPost = null;
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
      node.nodeType === Node.ELEMENT_NODE && (node.matches("article, img, video") || node.querySelector("article, img, video"))))) scheduleReconcile();
  });
  pageObserver.observe(document.body, {
    childList: true, subtree: true,
    attributes: true,
    attributeFilter: automatic ? ["style", "class", "hidden", "aria-hidden", "src", "srcset", "poster"] : ["href"],
  });
  const themeObserver = new MutationObserver(scheduleReconcile);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });

  // 表示モード: auto は端末から判断 / pc はマウスでホバー / mobile は画面の中央の投稿。
  function syncMode() {
    setTouchMode(touchCapable && (settings.mode === "mobile" ? true : settings.mode === "pc" ? false : autoTouch));
  }

  function setTouchMode(next) {
    if (touchMode === next) return;
    touchMode = next;
    light.classList.toggle("lite", touchMode);
    paintCost = 0;
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
  listen(colorScheme, "change", () => { backgroundDirty = true; scheduleReconcile(); });

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

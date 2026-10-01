(() => {
  "use strict";

  const Core = globalThis.XAmbientCore;
  const Settings = globalThis.XAmbientSettings;
  if (!Core || !Settings) return;
  globalThis.__xAmbientDispose?.();
  const cards = globalThis.XAmbientCardLayout?.create();

  const POST_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';
  const IMAGE_SELECTOR = [
    '[data-testid="tweetPhoto"] img',
    'img[src*="pbs.twimg.com/media/"]',
    'img[src*="pbs.twimg.com/tweet_video_thumb/"]',
    'img[src*="pbs.twimg.com/ext_tw_video_thumb/"]',
    'img[src*="pbs.twimg.com/amplify_video_thumb/"]',
  ].join(",");
  const FRAME_INTERVAL = 1000 / 12;
  const hasStorage = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const removers = [];
  const posterCache = new WeakMap();
  let settings = { ...Settings.DEFAULTS };
  let pointer = null;
  let activePost = null;
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
  let front = 0;
  let disposed = false;

  const host = document.createElement("div");
  host.id = "x-ambient-light";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483600;pointer-events:none;display:block;overflow:hidden;contain:strict;";
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
  document.documentElement.append(host);
  const contexts = canvases.map((canvas) => canvas.getContext("2d"));
  const mosaic = document.createElement("canvas");
  mosaic.width = 144;
  const mosaicContext = mosaic.getContext("2d");
  if (!mosaicContext || contexts.some((context) => !context)) {
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
    let dark = colorScheme.matches;
    for (const element of [document.documentElement, document.body]) {
      if (element) dark = Core.isDarkColor(getComputedStyle(element).backgroundColor, dark);
    }
    host.style.mixBlendMode = dark ? "screen" : "multiply";
  }

  function applySettings(value) {
    settings = Settings.normalize(value);
    cards?.setEnabled(settings.fitCards);
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
    activeObserver.disconnect();
    stopFrames();
    light.classList.remove("visible");
  }

  function visibleRect(element, fullRect, minSize = 48, minIntersection = 16) {
    const view = viewport();
    if (!Core.isVisibleRect(fullRect, view, minSize, minIntersection)) return null;
    const computed = getComputedStyle(element);
    if (computed.visibility === "hidden" || computed.visibility === "collapse" || computed.opacity === "0") return null;
    let rect = Core.intersectRect(fullRect, { left: 0, top: 0, right: view.width, bottom: view.height });
    for (let parent = element.parentElement; rect && parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.opacity === "0") return null;
      const clipX = ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
      const clipY = ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
      if (clipX || clipY) rect = Core.intersectRect(rect, parent.getBoundingClientRect(), clipX, clipY);
      if (parent === activePost) break;
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

  function findMedia(post) {
    const videos = [];
    for (const video of post.querySelectorAll("video")) {
      const fullRect = video.getBoundingClientRect();
      const rect = visibleRect(video, fullRect);
      if (!rect) continue;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const descriptor = imageDescriptor(video, video, rect, fullRect);
        if (descriptor) videos.push(descriptor);
      }
      else {
        const poster = posterFor(video);
        const descriptor = poster && imageDescriptor(poster, video, rect, fullRect);
        if (descriptor) videos.push(descriptor);
      }
    }
    const images = [];
    for (const image of post.querySelectorAll(IMAGE_SELECTOR)) {
      if (image.closest('[data-testid^="UserAvatar"]') || !image.complete || !image.naturalWidth) continue;
      const presenter = imagePresenter(image);
      const fullRect = presenter.getBoundingClientRect();
      const rect = visibleRect(presenter, fullRect);
      if (!rect || videos.some((video) => Core.overlapFraction(rect, video.rect) > 0.8)) continue;
      if (images.some((other) => Core.overlapFraction(rect, other.rect) > 0.9)) continue;
      const descriptor = imageDescriptor(image, presenter, rect, fullRect);
      if (descriptor) images.push(descriptor);
    }
    return [...videos, ...images].slice(0, 4);
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
      const padding = settings.blur * 2;
      region = { left: -padding, top: -padding, width: view.width + padding * 2, height: view.height + padding * 2 };
    } else {
      protectionKey = "";
      light.style.maskImage = Core.buildPostMask(activePost.getBoundingClientRect(), view);
      const padding = 60 + settings.spread * 3.4;
      region = { left: bounds.left - padding, top: bounds.top - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
    }
    field.style.cssText = `position:absolute;left:${region.left}px;top:${region.top}px;width:${region.width}px;height:${region.height}px;`;
    const scale = 256 / Math.max(region.width, region.height);
    const size = { width: Math.round(region.width * scale), height: Math.round(region.height * scale) };
    const target = {
      left: (bounds.left - region.left) / region.width * size.width,
      top: (bounds.top - region.top) / region.height * size.height,
      width: bounds.width / region.width * size.width,
      height: bounds.height / region.height * size.height,
    };
    const source = { width: mosaic.width, height: Math.max(48, Math.min(144, Math.round(144 * bounds.height / bounds.width))) };
    projection = { size, source, target, strips: Core.buildRayProjection(source, target, size, (120 + settings.spread * 12) * scale) };
    updateTheme();
  }

  function paint(index) {
    if (!bounds || !media.length || !projection) return false;
    const canvas = canvases[index];
    const context = contexts[index];
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
        // X may replace a video source while React reuses its element.
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
    return drawn;
  }

  function startFrames() {
    stopFrames();
    if (!eligible() || !settings.animateVideo || reducedMotion.matches) return;
    const video = media.find((item) => item.source.tagName === "VIDEO" && !item.source.paused && !item.source.ended)?.source;
    if (!video) return;
    const type = typeof video.requestVideoFrameCallback === "function" ? "video" : "raf";
    const next = (time) => {
      frameHandle = null;
      if (!eligible() || !activePost?.isConnected || video.paused || video.ended) return;
      if (time - lastPaint >= FRAME_INTERVAL) {
        paint(front);
        lastPaint = time;
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
      stopFrames();
      return;
    }
    updateLayout();
    if (changed) {
      const back = 1 - front;
      if (paint(back)) {
        canvases[front].classList.remove("front");
        canvases[back].classList.add("front");
        front = back;
        light.classList.add("visible");
      }
    } else if (paint(front)) light.classList.add("visible");
    startFrames();
  }

  function activate(post) {
    if (disposed || !eligible() || !post.isConnected) return;
    activePost = post;
    pendingPost = null;
    activeObserver.disconnect();
    activeObserver.observe(post, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "poster"] });
    refreshMedia(true);
  }

  function reconcile() {
    if (!eligible() || !pointer) {
      deactivate();
      return;
    }
    const element = document.elementFromPoint(pointer.x, pointer.y);
    const post = element?.closest(POST_SELECTOR) || null;
    if (post === activePost && post) {
      refreshMedia();
      return;
    }
    if (!post) {
      deactivate();
      return;
    }
    if (post === pendingPost) return;
    deactivate();
    pendingPost = post;
    hoverTimer = window.setTimeout(() => {
      hoverTimer = 0;
      if (pendingPost === post) activate(post);
    }, 70);
  }

  const activeObserver = new MutationObserver(scheduleReconcile);
  const pageObserver = new MutationObserver((records) => {
    if (!pointer || !eligible()) return;
    if (activePost && !activePost.isConnected) scheduleReconcile();
    else if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
      node.nodeType === Node.ELEMENT_NODE && (node.matches(`${POST_SELECTOR}, img, video`) || node.querySelector(`${POST_SELECTOR}, img, video`))))) scheduleReconcile();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });
  const themeObserver = new MutationObserver(scheduleReconcile);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });

  listen(document, "pointermove", (event) => {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    // Within the same post, mouse motion does not need another media repaint.
    if (event.target instanceof Element && event.target.closest(POST_SELECTOR) === activePost && activePost) return;
    scheduleReconcile();
  }, { passive: true });
  listen(document, "pointerout", (event) => {
    if (!event.relatedTarget) {
      pointer = null;
      deactivate();
    }
  }, { passive: true });
  listen(document, "scroll", scheduleReconcile, { passive: true, capture: true });
  listen(window, "resize", scheduleReconcile, { passive: true });
  listen(document, "xambient:layout", scheduleReconcile);
  listen(window, "blur", () => { pointer = null; deactivate(); });
  listen(document, "visibilitychange", scheduleReconcile);
  listen(document, "fullscreenchange", scheduleReconcile);
  for (const event of ["load", "loadeddata", "play", "pause", "ended", "seeked", "emptied", "resize"]) {
    listen(document, event, (event) => {
      if (event.target instanceof Element && activePost
        && (activePost.contains(event.target) || event.type === "load")) scheduleReconcile();
    }, true);
  }
  listen(reducedMotion, "change", scheduleReconcile);
  listen(colorScheme, "change", scheduleReconcile);

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
  }
  applySettings(settings);

  function dispose() {
    disposed = true;
    deactivate();
    cancelAnimationFrame(reconcileFrame);
    activeObserver.disconnect();
    pageObserver.disconnect();
    themeObserver.disconnect();
    cards?.dispose();
    for (const remove of removers) remove();
    host.remove();
  }
  globalThis.__xAmbientDispose = dispose;
  listen(window, "pagehide", (event) => { if (!event.persisted) dispose(); });
})();

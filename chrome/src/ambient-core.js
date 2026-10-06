(() => {
  "use strict";

  function unionRects(rects) {
    if (!rects.length) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function isVisibleRect(rect, viewport, minSize = 48, minIntersection = 16) {
    return rect.width >= minSize && rect.height >= minSize
      && Math.min(rect.right, viewport.width) - Math.max(rect.left, 0) >= minIntersection
      && Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0) >= minIntersection;
  }

  function overlapFraction(rect, covering) {
    const width = Math.max(0, Math.min(rect.right, covering.right) - Math.max(rect.left, covering.left));
    const height = Math.max(0, Math.min(rect.bottom, covering.bottom) - Math.max(rect.top, covering.top));
    return rect.width * rect.height > 0 ? width * height / (rect.width * rect.height) : 0;
  }

  function intersectRect(rect, clip, clipX = true, clipY = true) {
    const left = clipX ? Math.max(rect.left, clip.left) : rect.left;
    const right = clipX ? Math.min(rect.right, clip.right) : rect.right;
    const top = clipY ? Math.max(rect.top, clip.top) : rect.top;
    const bottom = clipY ? Math.min(rect.bottom, clip.bottom) : rect.bottom;
    if (right <= left || bottom <= top) return null;
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  }

  // Map the source's visible crop to its position in a small media mosaic.
  function fitImage(sourceWidth, sourceHeight, target, fit = "cover", position = [0.5, 0.5]) {
    if (sourceWidth <= 0 || sourceHeight <= 0 || target.width <= 0 || target.height <= 0) return null;
    const scale = fit === "contain"
      ? Math.min(target.width / sourceWidth, target.height / sourceHeight)
      : Math.max(target.width / sourceWidth, target.height / sourceHeight);
    if (fit === "fill") {
      return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: target.left, dy: target.top, dw: target.width, dh: target.height };
    }
    if (fit === "contain") {
      const dw = sourceWidth * scale;
      const dh = sourceHeight * scale;
      return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: target.left + (target.width - dw) * position[0], dy: target.top + (target.height - dh) * position[1], dw, dh };
    }
    const sw = Math.min(sourceWidth, target.width / scale);
    const sh = Math.min(sourceHeight, target.height / scale);
    return { sx: (sourceWidth - sw) * position[0], sy: (sourceHeight - sh) * position[1], sw, sh, dx: target.left, dy: target.top, dw: target.width, dh: target.height };
  }

  function axisMask(start, end, size, direction, feather = 32) {
    const a = Math.max(0, Math.min(size, start));
    const b = Math.max(a, Math.min(size, end));
    const f = Math.min(feather, (b - a) / 3);
    return `linear-gradient(to ${direction}, #000 ${Math.max(0, a - f)}px, transparent ${a}px, transparent ${b}px, #000 ${Math.min(size, b + f)}px)`;
  }

  function contentRect(sourceWidth, sourceHeight, rect, fit, position = [.5, .5]) {
    if (fit !== "contain" && fit !== "scale-down") return rect;
    const crop = fitImage(sourceWidth, sourceHeight, rect, "contain", position);
    if (!crop) return rect;
    const scale = fit === "scale-down" ? Math.min(1, crop.dw / sourceWidth) : crop.dw / sourceWidth;
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    const left = rect.left + (rect.width - width) * position[0];
    const top = rect.top + (rect.height - height) * position[1];
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function buildPostMask(rect, viewport) {
    const horizontal = axisMask(rect.left, rect.right, viewport.width, "right");
    return `${horizontal}, ${axisMask(rect.top, rect.bottom, viewport.height, "bottom", 24)}`;
  }

  function buildMediaMask(rects, viewport) {
    // This SVG describes only DOM rectangles; it contains no image or video pixels.
    const number = (value) => Math.round(value * 2) / 2;
    const holes = rects.map((rect) => `<rect x="${number(rect.left)}" y="${number(rect.top)}" width="${number(rect.width)}" height="${number(rect.height)}" rx="${number(rect.radius || 0)}" fill="black"/>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}"><defs><mask id="media" maskUnits="userSpaceOnUse" x="0" y="0" width="${viewport.width}" height="${viewport.height}"><rect width="100%" height="100%" fill="white"/>${holes}</mask></defs><rect width="100%" height="100%" fill="white" mask="url(#media)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  function buildRayProjection(source, target, frame, reach, edgeStrength = 0, maxSteps = 96) {
    if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0 || reach <= 0) return [];
    const cx = target.left + target.width / 2;
    const cy = target.top + target.height / 2;
    const halfWidth = target.width / 2;
    const halfHeight = target.height / 2;
    const outerScale = Math.max(1, cx / halfWidth, (frame.width - cx) / halfWidth, cy / halfHeight, (frame.height - cy) / halfHeight);
    const steps = Math.max(24, Math.min(maxSteps, Math.ceil(Math.max(frame.width, frame.height) / 3)));
    const edgeX = Math.max(1, Math.round(source.width * .04));
    const edgeY = Math.max(1, Math.round(source.height * .04));
    const strips = [];
    const minimumAlpha = Math.max(0, Math.min(1, edgeStrength));
    // Concentric edge strips fan out from the media's own center. drawImage works
    // with cross-origin sources without reading pixels or uploading a WebGL texture.
    for (let i = 0; i < steps; i++) {
      const inner = 1 + (outerScale - 1) * i / steps;
      const outer = 1 + (outerScale - 1) * (i + 1) / steps;
      const left = cx - halfWidth * outer;
      const top = cy - halfHeight * outer;
      const dx = halfWidth * (outer - inner) + .6;
      const dy = halfHeight * (outer - inner) + .6;
      const alphaX = minimumAlpha + (1 - minimumAlpha) * Math.exp(-halfWidth * (inner - 1) / reach);
      const alphaY = minimumAlpha + (1 - minimumAlpha) * Math.exp(-halfHeight * (inner - 1) / reach);
      strips.push(
        { sx: 0, sy: 0, sw: source.width, sh: edgeY, dx: left, dy: top, dw: target.width * outer, dh: dy, alpha: alphaY },
        { sx: 0, sy: source.height - edgeY, sw: source.width, sh: edgeY, dx: left, dy: cy + halfHeight * inner - .3, dw: target.width * outer, dh: dy, alpha: alphaY },
        { sx: 0, sy: 0, sw: edgeX, sh: source.height, dx: left, dy: cy - halfHeight * inner, dw: dx, dh: target.height * inner + .6, alpha: alphaX },
        { sx: source.width - edgeX, sy: 0, sw: edgeX, sh: source.height, dx: cx + halfWidth * inner - .3, dy: cy - halfHeight * inner, dw: dx, dh: target.height * inner + .6, alpha: alphaX },
      );
    }
    return strips;
  }

  function parseRgb(color) {
    const match = String(color).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/);
    if (!match) return null;
    const values = [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    if (!values.every(Number.isFinite)) return null;
    return { rgb: values.slice(0, 3).map(value => Math.max(0, Math.min(255, value)) / 255), alpha: Math.max(0, Math.min(1, values[3])) };
  }

  function isDarkColor(color, fallback = true) {
    const parsed = parseRgb(color);
    if (!parsed || parsed.alpha < 0.1) return fallback;
    return (0.2126 * parsed.rgb[0] + 0.7152 * parsed.rgb[1] + 0.0722 * parsed.rgb[2]) * 255 < 128;
  }

  function resolveBackgroundColor(backgrounds, fallbackDark = true) {
    let rgb = fallbackDark ? [0, 0, 0] : [1, 1, 1];
    for (const color of backgrounds) {
      const parsed = parseRgb(color);
      if (parsed) rgb = rgb.map((backdrop, index) => backdrop * (1 - parsed.alpha) + parsed.rgb[index] * parsed.alpha);
    }
    return `rgb(${rgb.map(channel => Math.round(channel * 255)).join(", ")})`;
  }

  // ---- rendering quality and frame pacing ----------------------------------------------------
  // Each tier trades resolution and ray count for cost. The governor below walks these tiers, and the
  // paint stride, so the frame rate stays high without ever dropping under the floor.
  const QUALITY_TIERS = Object.freeze([
    Object.freeze({ size: 256, steps: 64, mosaic: 144 }),
    Object.freeze({ size: 192, steps: 48, mosaic: 128 }),
    Object.freeze({ size: 144, steps: 36, mosaic: 112 }),
    Object.freeze({ size: 112, steps: 28, mosaic: 96 }),
    Object.freeze({ size: 80, steps: 24, mosaic: 80 }),
  ]);

  // The canvas blur is a pyramid: halve the picture `depth` times, then double it back. Each halve/double
  // pair adds a fixed amount of variance, so depth = log2(sigma) + 0.8 matches a CSS Gaussian blur
  // (fitted against Chromium's filter: blur(), RMSE about 2-3%). `sigma` is in canvas pixels.
  function blurDepth(sigma, maxDepth = 6) {
    if (!(sigma > 0)) return 1;
    return Math.max(1, Math.min(maxDepth, Math.log2(sigma) + 0.8));
  }

  // Painting happens on video frames, so a paint interval is a whole number of frames (the stride).
  //   min  - fastest allowed (topFps cap)      max  - slowest allowed (a gap of at most floorGap ms)
  //   good - the stride closest to goodFps without going below it
  function paintStrideBounds(period, { topFps = 30, goodFps = 15, floorGap = 100 } = {}) {
    const p = Math.max(4, Math.min(200, Number(period) || 1000 / 30));
    const min = Math.max(1, Math.ceil(1000 / (topFps * p) - 0.1));
    const max = Math.max(min, Math.floor(floorGap / p + 0.05));
    const good = Math.max(min, Math.min(max, Math.floor(1000 / (goodFps * p) + 0.1)));
    return { min, max, good };
  }

  // Chooses the quality tier and paint stride from measured paint cost (and dropped-frame pressure).
  // Order of preference: keep at least `goodFps`, spend spare time on frame rate first and then on
  // quality, give up quality before frame rate, and only go below `goodFps` at the lowest tier.
  function createGovernor(options = {}) {
    const lastTier = QUALITY_TIERS.length - 1;
    const config = {
      goodFps: 15, topFps: 30, floorGap: 100,
      overload: 0.3, calm: 0.12, promote: 0.2,
      cooldown: 1500, calmHold: 3000, pressureHold: 20000,
      ...options,
    };
    const clampTier = (value) => Math.max(0, Math.min(lastTier, Math.round(Number(value) || 0)));
    let tier = clampTier(options.startTier);
    let bestTier = clampTier(options.bestTier);
    let stride = 0; // 0: not chosen yet
    let period = 1000 / 30;
    let periodSamples = 0;
    let cost = 0;
    let costSamples = 0;
    let lastChange = -Infinity;
    let calmSince = -1;
    let holdUntil = 0;

    function settle() {
      const range = paintStrideBounds(period, config);
      stride = stride ? Math.max(range.min, Math.min(range.max, stride)) : range.good;
      return range;
    }

    function observePeriod(ms) {
      if (!(ms > 3 && ms < 250)) return;
      period = periodSamples++ ? period * 0.9 + ms * 0.1 : ms;
    }

    function sample({ cost: spent, now, pressure = false }) {
      cost = costSamples++ ? cost * 0.75 + spent * 0.25 : spent;
      if (pressure) holdUntil = now + config.pressureHold; // promotion waits until pressure has been gone for a while
      const range = settle();
      const interval = stride * period;
      const load = cost / interval;
      const cooled = now - lastChange >= config.cooldown;
      let moved = false;
      if (cooled && (load > config.overload || pressure)) {
        if (tier < lastTier) {
          tier++;
          cost *= 0.7;
          moved = true;
        } else if (load > config.overload && stride < range.max) {
          stride++; // dropped frames alone are not evidence that fewer paints would help
          moved = true;
        }
        if (moved) {
          lastChange = now;
          calmSince = -1;
        }
      } else if (load < config.calm && !pressure) {
        if (calmSince < 0) calmSince = now;
        if (cooled && now - calmSince >= config.calmHold && now >= holdUntil) {
          if (stride > range.min && cost / ((stride - 1) * period) < config.promote) {
            stride--;
            moved = true;
          } else if (tier > bestTier && cost * 1.5 / interval < config.promote) {
            tier--;
            cost *= 1.5;
            moved = true;
          }
          if (moved) {
            lastChange = now;
            calmSince = now;
          }
        }
      } else {
        calmSince = -1;
      }
      return { tier, stride, moved };
    }

    function reset(next = {}) {
      tier = clampTier(next.startTier ?? tier);
      bestTier = clampTier(next.bestTier ?? bestTier);
      stride = 0;
      cost = 0;
      costSamples = 0;
      lastChange = -Infinity;
      calmSince = -1;
      holdUntil = 0;
    }

    return {
      observePeriod, sample, reset,
      get tier() { return tier; },
      get stride() { settle(); return stride; },
      get period() { return period; },
      get cost() { return cost; },
    };
  }

  const api = Object.freeze({ unionRects, isVisibleRect, overlapFraction, intersectRect, fitImage, contentRect, buildPostMask, buildMediaMask, buildRayProjection, isDarkColor, resolveBackgroundColor, QUALITY_TIERS, blurDepth, paintStrideBounds, createGovernor });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.XAmbientCore = api;
})();

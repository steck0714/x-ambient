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

  function buildRayProjection(source, target, frame, reach) {
    if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0 || reach <= 0) return [];
    const cx = target.left + target.width / 2;
    const cy = target.top + target.height / 2;
    const halfWidth = target.width / 2;
    const halfHeight = target.height / 2;
    const outerScale = Math.max(1, cx / halfWidth, (frame.width - cx) / halfWidth, cy / halfHeight, (frame.height - cy) / halfHeight);
    const steps = Math.max(24, Math.min(96, Math.ceil(Math.max(frame.width, frame.height) / 3)));
    const edgeX = Math.max(1, Math.round(source.width * .04));
    const edgeY = Math.max(1, Math.round(source.height * .04));
    const strips = [];
    // Concentric edge strips fan out from the media's own center. drawImage works
    // with cross-origin sources without reading pixels or uploading a WebGL texture.
    for (let i = 0; i < steps; i++) {
      const inner = 1 + (outerScale - 1) * i / steps;
      const outer = 1 + (outerScale - 1) * (i + 1) / steps;
      const left = cx - halfWidth * outer;
      const top = cy - halfHeight * outer;
      const dx = halfWidth * (outer - inner) + .6;
      const dy = halfHeight * (outer - inner) + .6;
      const alphaX = Math.exp(-halfWidth * (inner - 1) / reach);
      const alphaY = Math.exp(-halfHeight * (inner - 1) / reach);
      strips.push(
        { sx: 0, sy: 0, sw: source.width, sh: edgeY, dx: left, dy: top, dw: target.width * outer, dh: dy, alpha: alphaY },
        { sx: 0, sy: source.height - edgeY, sw: source.width, sh: edgeY, dx: left, dy: cy + halfHeight * inner - .3, dw: target.width * outer, dh: dy, alpha: alphaY },
        { sx: 0, sy: 0, sw: edgeX, sh: source.height, dx: left, dy: cy - halfHeight * inner, dw: dx, dh: target.height * inner + .6, alpha: alphaX },
        { sx: source.width - edgeX, sy: 0, sw: edgeX, sh: source.height, dx: cx + halfWidth * inner - .3, dy: cy - halfHeight * inner, dw: dx, dh: target.height * inner + .6, alpha: alphaX },
      );
    }
    return strips;
  }

  function isDarkColor(color, fallback = true) {
    const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/);
    if (!match || (match[4] !== undefined && Number(match[4]) < 0.1)) return fallback;
    return 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]) < 128;
  }

  const api = Object.freeze({ unionRects, isVisibleRect, overlapFraction, intersectRect, fitImage, contentRect, buildPostMask, buildMediaMask, buildRayProjection, isDarkColor });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.XAmbientCore = api;
})();

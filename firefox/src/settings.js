(() => {
  "use strict";

  const STORAGE_KEY = "xAmbientSettings";
  const DEFAULTS = Object.freeze({
    enabled: true,
    intensity: 65,
    blur: 56,
    spread: 75,
    scope: "page",
    animateVideo: true,
    fitCards: false,
  });

  function numberInRange(value, fallback, min, max) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(max, Math.max(min, value)))
      : fallback;
  }

  function normalize(value) {
    const input = value && typeof value === "object" ? value : {};
    return {
      enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULTS.enabled,
      intensity: numberInRange(input.intensity, DEFAULTS.intensity, 0, 100),
      blur: numberInRange(input.blur, DEFAULTS.blur, 24, 160),
      spread: numberInRange(input.spread, DEFAULTS.spread, 20, 100),
      scope: input.scope === "post" ? "post" : "page",
      animateVideo: typeof input.animateVideo === "boolean" ? input.animateVideo : DEFAULTS.animateVideo,
      fitCards: typeof input.fitCards === "boolean" ? input.fitCards
        : typeof input.doubleCards === "boolean" ? input.doubleCards : DEFAULTS.fitCards,
    };
  }

  const api = Object.freeze({ STORAGE_KEY, DEFAULTS, normalize });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.XAmbientSettings = api;
})();

(() => {
  "use strict";

  function platformForHostname(hostname) {
    const host = String(hostname).toLowerCase();
    if (["twitch.tv", "www.twitch.tv"].includes(host)) return "twitch";
    if (["kick.com", "www.kick.com"].includes(host)) return "kick";
    if (["instagram.com", "www.instagram.com"].includes(host)) return "instagram";
    return "x";
  }

  function pickVideo(candidates) {
    let selected = null;
    let largest = 0;
    for (const candidate of candidates) {
      const { rect, video } = candidate;
      if (!rect || rect.width < 160 || rect.height < 90 || video.ended) continue;
      const area = rect.width * rect.height;
      if (area > largest) {
        largest = area;
        selected = video;
      }
    }
    return selected;
  }

  const api = Object.freeze({ platformForHostname, pickVideo });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.XAmbientStreaming = api;
})();

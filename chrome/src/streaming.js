(() => {
  "use strict";

  function platformForHostname(hostname) {
    const host = String(hostname).toLowerCase();
    if (["twitch.tv", "www.twitch.tv"].includes(host)) return "twitch";
    if (["kick.com", "www.kick.com"].includes(host)) return "kick";
    if (["instagram.com", "www.instagram.com"].includes(host)) return "instagram";
    if (["tiktok.com", "www.tiktok.com"].includes(host)) return "tiktok";
    if (["nicovideo.jp", "www.nicovideo.jp"].includes(host)) return "niconico";
    return "x";
  }

  function findVideos(root, platform, pathname) {
    if (platform === "tiktok") {
      if (!/^\/(?:foryou\/?)?$/.test(pathname)) return [];
      return [...root.querySelectorAll('main [data-e2e="recommend-list-item-container"] video')];
    }
    if (platform === "niconico") {
      if (!/^\/watch\/(?:[a-z]{2})?\d+\/?$/.test(pathname)) return [];
      const videos = [...root.querySelectorAll('video[data-name="video-content"]')];
      if (videos.length) return videos;
      return [...root.querySelectorAll('[data-styling-name="fullscreen-target"] video')]
        .filter(video => !video.closest("#nv_watch_VideoAdContainer"));
    }
    return [...root.querySelectorAll("video")];
  }

  function pickVideo(candidates, { platform, viewport, previous = null } = {}) {
    let selected = null;
    let best = -Infinity;
    for (const candidate of candidates) {
      const { rect, video } = candidate;
      if (!rect || rect.width < 160 || rect.height < 90
        || (video.ended && platform !== "tiktok" && platform !== "niconico")) continue;
      const area = rect.width * rect.height;
      let score = area;
      if (platform === "tiktok") {
        const fullRect = candidate.fullRect || rect;
        const possibleArea = Math.min(fullRect.width, viewport.width) * Math.min(fullRect.height, viewport.height);
        const coverage = Math.min(1, area / possibleArea);
        const distance = Math.abs(rect.top + rect.height / 2 - viewport.height / 2) / viewport.height;
        // Prefer the active, mostly visible feed item. Preloaded neighbors must not steal its light.
        score = coverage - distance + (!video.paused && !video.ended && coverage >= 0.5 ? 2 : 0)
          + (video === previous ? 0.04 : 0);
      }
      if (score > best) {
        best = score;
        selected = video;
      }
    }
    return selected;
  }

  const api = Object.freeze({ platformForHostname, findVideos, pickVideo });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.XAmbientStreaming = api;
})();

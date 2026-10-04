(() => {
  "use strict";

  function findPosts(root, pathname) {
    if (!/^\/(?:$|(?:p|reel|reels|following|favorites)(?:\/|$))/.test(pathname)) return [];
    const posts = [...root.querySelectorAll('main article, [role="main"] article, [role="dialog"] article')];
    if (/^\/reels?(?:\/|$)/.test(pathname)) {
      // Reels has no article wrapper. Its visible video is the active item.
      for (const video of root.querySelectorAll('main video, [role="main"] video, [role="dialog"] video')) {
        if (!video.closest("article")) posts.push(video);
      }
    }
    return posts;
  }

  function isPostImage(image) {
    if (image.getAttribute?.("aria-hidden") === "true") return false;
    const link = image.closest("a[href]");
    if (!link) return true;
    // Profile pictures and suggested accounts link to a profile, rather than a post.
    return /^\/(?:p|reel|reels)\//.test(link.pathname);
  }

  function pickActive(candidates, viewport, previous = null) {
    const visible = candidates.filter(({ rect }) => rect && rect.width >= 160 && rect.height >= 48);
    const dialog = visible.filter(candidate => candidate.dialog);
    let selected = null;
    let best = -Infinity;
    for (const candidate of dialog.length ? dialog : visible) {
      const { rect, fullRect, post, playing } = candidate;
      const area = Math.min(fullRect.width, viewport.width) * Math.min(fullRect.height, viewport.height);
      const coverage = Math.min(1, rect.width * rect.height / area);
      const distance = Math.abs(rect.top + rect.height / 2 - viewport.height / 2) / viewport.height;
      // A playing video only takes priority when most of it is visible.
      const score = coverage - distance + (playing && coverage >= 0.5 ? 2 : 0) + (post === previous ? 0.04 : 0);
      if (score > best) {
        best = score;
        selected = post;
      }
    }
    return selected;
  }

  const api = Object.freeze({ findPosts, isPostImage, pickActive });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.XAmbientInstagram = api;
})();

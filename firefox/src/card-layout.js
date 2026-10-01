(() => {
  "use strict";
  function create() {
    const columns = new Map();
    const marked = new Set();
    let enabled = false;
    let frame = 0;
    const style = document.createElement("style");
    style.id = "x-ambient-card-layout";
    style.textContent = `
      .xa-card-column { width:var(--xa-card-width) !important; max-width:var(--xa-card-width) !important; min-width:0 !important; flex-shrink:0 !important; }
      .xa-card-column :is(article[data-testid="tweet"], article[role="article"]) { width:100% !important; max-width:none !important; box-sizing:border-box !important; }
      .xa-card-column :is(article[data-testid="tweet"], article[role="article"]) :is(article[data-testid="tweet"], article[role="article"]) { width:auto !important; }
      .xa-card-fill { max-width:none !important; }
      .xa-card-row { width:max-content !important; max-width:none !important; min-width:0 !important; }
      .xa-card-main { flex:0 1 auto !important; min-width:0 !important; }
      .xa-card-hidden { display:none !important; }
      .xa-card-sidebar { margin-right:0 !important; }
      .xa-card-grid { grid-template-columns:var(--xa-card-grid-columns) !important; width:max-content !important; max-width:none !important; }
    `;
    document.documentElement.append(style);
    function mark(element, className) {
      if (!element) return;
      element.classList.add(className);
      marked.add(element);
    }
    function clear() {
      for (const element of marked) {
        element.classList.remove("xa-card-column", "xa-card-row", "xa-card-main", "xa-card-hidden", "xa-card-grid", "xa-card-sidebar", "xa-card-fill");
        element.style.removeProperty("--xa-card-width");
        element.style.removeProperty("--xa-card-grid-columns");
      }
      marked.clear();
      columns.clear();
    }
    function refresh() {
      frame = 0;
      if (!enabled) return;
      for (const element of marked) element.classList.remove("xa-card-hidden");
      for (const column of document.querySelectorAll('[data-testid="primaryColumn"]')) {
        if (!column.querySelector('article[data-testid="tweet"], article[role="article"]')) continue;
        let state = columns.get(column);
        if (!state) {
          state = { width: column.getBoundingClientRect().width };
          if (state.width < 100) continue;
          columns.set(column, state);
        }
        const parent = column.parentElement;
        const grid = getComputedStyle(parent).display === "grid";
        let width;
        if (grid) {
          parent.classList.remove("xa-card-grid");
          const tracks = getComputedStyle(parent).gridTemplateColumns.split(" ").map(parseFloat);
          const index = [...parent.children].indexOf(column);
          const reserved = tracks.reduce((sum, value, i) => sum + (i === index ? 0 : value), 0);
          width = Math.max(1, innerWidth - reserved - 20);
          tracks[index] = width;
          parent.style.setProperty("--xa-card-grid-columns", tracks.map(value => `${value}px`).join(" "));
          mark(parent, "xa-card-grid");
        } else {
          const banner = document.querySelector('header[role="banner"]');
          const navigation = banner?.querySelector("nav") || banner;
          const navWidth = Math.min(280, navigation?.getBoundingClientRect().width || 0);
          const available = Math.max(1, innerWidth - navWidth - 20);
          width = available;
          const sidebar = parent.querySelector('[data-testid="sidebarColumn"]');
          if (sidebar) {
            let branch = sidebar;
            while (branch.parentElement !== parent && branch.parentElement) branch = branch.parentElement;
            mark(sidebar, "xa-card-sidebar");
            if (branch !== sidebar) mark(branch, "xa-card-row");
            const css = getComputedStyle(branch);
            const sideWidth = branch.getBoundingClientRect().width + (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0);
            if (available - sideWidth >= Math.min(state.width, 600)) width -= sideWidth;
            else mark(branch, "xa-card-hidden");
          }
          for (let row = parent; row && row.getAttribute("role") !== "main"; row = row.parentElement) {
            if (row === document.body || row === document.documentElement) break;
            mark(row, "xa-card-row");
          }
          mark(column.closest('main[role="main"]'), "xa-card-main");
        }
        column.style.setProperty("--xa-card-width", `${Math.round(width)}px`);
        mark(column, "xa-card-column");
        for (const article of column.querySelectorAll('article[data-testid="tweet"], article[role="article"]')) {
          for (let container = article.parentElement; container && container !== column; container = container.parentElement) {
            if (getComputedStyle(container).maxWidth !== "none") mark(container, "xa-card-fill");
          }
        }
      }
      for (const [column] of columns) if (!column.isConnected) columns.delete(column);
      document.dispatchEvent(new Event("xambient:layout"));
    }
    function schedule() {
      if (enabled && !frame) frame = requestAnimationFrame(refresh);
    }
    const observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE
        && (node.matches('[data-testid="primaryColumn"], article') || node.querySelector('[data-testid="primaryColumn"], article'))))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule, { passive: true });
    return {
      setEnabled(value) {
        if (enabled === value) return;
        enabled = value;
        cancelAnimationFrame(frame);
        frame = 0;
        if (enabled) refresh();
        else { clear(); document.dispatchEvent(new Event("xambient:layout")); }
      },
      dispose() {
        enabled = false;
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("resize", schedule);
        clear();
        style.remove();
      },
    };
  }
  globalThis.XAmbientCardLayout = Object.freeze({ create });
})();

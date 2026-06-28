// ─── Mind-map view ───────────────────────────────────────────────────────────
// Interactive SVG node-graph of one project's features → sub-tasks (driven by
// progress.md), or its inferred structure when there's no tracker. Horizontal
// tree: root on the left, features stacked, sub-tasks further right. Click a
// feature with sub-tasks to expand/collapse; hover highlights; click the root
// (or an inferred node with a path) opens GitHub. Pure SVG, no dependencies.
//
//   window.MindMap.render(containerEl, project)
//
// project = { name, url, default_branch,
//   tracker: { title, features:[{name,note,status,subtasks:[{name,note,status}]}] } | null,
//   inferredOverview: [{label,note,path}] | null }

(function () {
  const NS = "http://www.w3.org/2000/svg";
  const ROOT_X = 90, L1_X = 340, L2_X = 600, ROW = 40, TOP = 34, NODE_H = 30;

  const el = (name, attrs) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const trunc = (s, n = 22) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
  const open = (url) => window.open(url, "_blank", "noopener");

  function render(container, project) {
    if (!container) return;
    container.innerHTML = "";
    const expanded = container.__mmExpanded || (container.__mmExpanded = new Set());

    const tracker = project && project.tracker;
    const usingFeatures = !!(tracker && tracker.features && tracker.features.length);
    const items = usingFeatures
      ? tracker.features.map((f, i) => ({
          label: f.name, status: f.status, key: "f" + i,
          children: (f.subtasks || []).map((s) => ({ label: s.name, status: s.status })),
          link: project.url,
        }))
      : (project.inferredOverview || []).map((a) => ({
          label: a.label, status: "neutral", key: a.label, children: [],
          link: a.path ? `${project.url}/tree/${project.default_branch}/${a.path}` : project.url,
        }));

    const rootLabel = (tracker && tracker.title) || project.name;

    // Quiet empty state.
    if (!items.length) {
      const svg = el("svg", { class: "mm-svg", viewBox: "0 0 600 120", preserveAspectRatio: "xMidYMid meet" });
      svg.appendChild(node(ROOT_X + 120, 60, rootLabel, "root", () => open(project.url)));
      container.appendChild(svg);
      return;
    }

    // ── Layout: assign rows to leaves, parents centre on their children ───────
    let cursor = TOP;
    const layout = items.map((it) => {
      const isOpen = expanded.has(it.key) && it.children.length;
      if (isOpen) {
        const kids = it.children.map((c) => ({ ...c, y: (cursor += ROW) - ROW }));
        const y = kids.reduce((a, k) => a + k.y, 0) / kids.length;
        return { ...it, y, kids, isOpen: true };
      }
      const y = cursor;
      cursor += ROW;
      return { ...it, y, kids: [], isOpen: false };
    });
    const height = cursor + TOP - ROW + NODE_H;
    const rootY = layout.reduce((a, l) => a + l.y, 0) / layout.length;
    const width = layout.some((l) => l.isOpen) ? L2_X + 160 : L1_X + 200;

    const svg = el("svg", { class: "mm-svg", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "xMidYMin meet" });
    const linkLayer = el("g", {});
    const nodeLayer = el("g", {});
    svg.appendChild(linkLayer);
    svg.appendChild(nodeLayer);

    // root
    const rootNode = node(ROOT_X, rootY, rootLabel, "root", () => open(project.url));
    nodeLayer.appendChild(rootNode);

    layout.forEach((it) => {
      const lk = link(ROOT_X, rootY, L1_X, it.y);
      linkLayer.appendChild(lk);
      const n = node(L1_X, it.y, it.label, it.status, () => {
        if (it.children.length) { expanded.has(it.key) ? expanded.delete(it.key) : expanded.add(it.key); render(container, project); }
        else open(it.link);
      }, it.children.length ? it.children.length : null);
      hoverPair(n, lk);
      nodeLayer.appendChild(n);

      if (it.isOpen) {
        it.kids.forEach((k) => {
          const klk = link(L1_X, it.y, L2_X, k.y);
          linkLayer.appendChild(klk);
          const kn = node(L2_X, k.y, k.label, k.status, () => open(it.link));
          hoverPair(kn, klk);
          nodeLayer.appendChild(kn);
        });
      }
    });

    container.appendChild(svg);
  }

  function node(x, y, label, status, onClick, count) {
    const w = Math.min(170, Math.max(70, trunc(label).length * 7.6 + 24));
    const g = el("g", { class: `mm-node ${status}`, transform: `translate(${x},${y})`, tabindex: "0", role: "button" });
    g.appendChild(el("rect", { x: -w / 2, y: -NODE_H / 2, width: w, height: NODE_H, rx: 9 }));
    const t = el("text", { class: "mm-label", x: 0, y: 4, "text-anchor": "middle" });
    t.textContent = trunc(label);
    g.appendChild(t);
    if (count) {
      const cg = el("g", { class: "mm-count", transform: `translate(${w / 2 - 4},${-NODE_H / 2})` });
      cg.appendChild(el("circle", { r: 9 }));
      const ct = el("text", { x: 0, y: 3.5, "text-anchor": "middle" });
      ct.textContent = String(count);
      cg.appendChild(ct);
      g.appendChild(cg);
    }
    g.style.cursor = "pointer";
    g.addEventListener("click", onClick);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") onClick(); });
    return g;
  }

  function link(x1, y1, x2, y2) {
    const dx = (x2 - x1) * 0.5;
    return el("path", { class: "mm-link", d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` });
  }

  function hoverPair(nodeEl, linkEl) {
    nodeEl.addEventListener("mouseenter", () => { nodeEl.classList.add("is-hover"); linkEl.classList.add("is-hover"); });
    nodeEl.addEventListener("mouseleave", () => { nodeEl.classList.remove("is-hover"); linkEl.classList.remove("is-hover"); });
  }

  window.MindMap = { render };
})();

// app.js usage:
//   const mm = APP.querySelector(".mindmap");
//   if (window.MindMap) window.MindMap.render(mm, project);

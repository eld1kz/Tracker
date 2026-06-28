// ─── Project Navigator ───────────────────────────────────────────────────────
// A project-oriented developer tool: open it and instantly understand all your
// repos, then drill in. Auto-discovers every repo from the GitHub API (username
// only). Each repo gets an auto-generated plain-language summary + inferred stack
// (no LLM — heuristics in summarize.js), a feature breakdown from progress.md
// (with sub-tasks), or an inferred structure overview when there's no tracker.
//
// Two data paths, same model:
//   • Baked data.json (server-side via token, incl. private repos) — primary.
//   • Live client fetch (public repos only, ~few calls, cached) — fallback.
// No secrets in the browser. progress.md + README + manifests fetched from
// raw.githubusercontent (not counted against the 60-req/hr API limit).

const CFG = window.TRACKER_CONFIG || {};
const { parseProgress } = window.TrackerParser;
const { summarizeRepo } = window.RepoSummarizer;
const APP = document.getElementById("app");

const ACTIVE_DAYS = CFG.activeDays || 14;
const STALE_DAYS = CFG.staleDays || 60;

const STATUS_LABEL = { active: "Active", recent: "Recent", stale: "Dormant", archived: "Archived" };
const FEAT_LABEL = { done: "Done", "in-progress": "In Progress", planned: "Planned" };

const LANG_COLORS = {
  JavaScript: "#f1c40f", TypeScript: "#2997ff", Python: "#34c759",
  Swift: "#ff9f0a", HTML: "#ff6b5e", CSS: "#a06bff", Go: "#5ac8e8",
  Rust: "#d2855a", Java: "#e07a5f", Shell: "#86868b", Ruby: "#ff453a",
  "C++": "#5ac8e8", C: "#86868b", "C#": "#a06bff", PHP: "#a06bff",
  Kotlin: "#ff9f0a", Dart: "#2997ff", Vue: "#34c759", Dockerfile: "#86868b",
};

// ─── Utilities ───────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
function daysSince(iso) {
  return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : Infinity;
}
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}
function langDot(lang) {
  if (!lang) return "";
  return `<span class="lang-dot" style="background:${LANG_COLORS[lang] || "#86868b"}"></span>`;
}

// ─── localStorage cache (with stale fallback for rate-limit safety) ──────────
function cacheRaw(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function cacheGet(key) {
  const e = cacheRaw(key);
  if (!e) return null;
  const ttl = (CFG.cacheTTLMinutes || 60) * 60000;
  return Date.now() - e.ts > ttl ? null : e.data;
}
function cacheStale(key) { const e = cacheRaw(key); return e ? e.data : null; }
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// ─── Data layer ──────────────────────────────────────────────────────────────
// Server-baked dataset (complete, incl. private repos + true language bytes).
async function fetchBaked() {
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const projects = Array.isArray(data) ? data : data.projects;
    if (!projects || !projects.length) return null;
    return {
      projects,
      languagesAgg: data.languagesAgg || null,
      owner: data.owner || null,
      generatedAt: data.generatedAt || null,
    };
  } catch { return null; }
}

// Live: one unauthenticated call lists every public repo.
async function fetchRepoList() {
  const key = `nav:repos:${CFG.username}`;
  const fresh = cacheGet(key);
  if (fresh) return { repos: fresh, cachedAt: cacheRaw(key).ts };
  try {
    const res = await fetch(
      `https://api.github.com/users/${CFG.username}/repos?per_page=100&sort=pushed`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const slim = (await res.json()).map((r) => ({
      name: r.name, description: r.description || "", language: r.language,
      languages: null, stars: r.stargazers_count, forks: r.forks_count,
      openIssues: r.open_issues_count, url: r.html_url, homepage: r.homepage || "",
      topics: r.topics || [], pushed_at: r.pushed_at, created_at: r.created_at,
      archived: r.archived, fork: r.fork, default_branch: r.default_branch,
      commitCount: null, lastCommit: null,
    }));
    cacheSet(key, slim);
    return { repos: slim, cachedAt: Date.now() };
  } catch (err) {
    const stale = cacheStale(key);
    if (stale) return { repos: stale, cachedAt: cacheRaw(key).ts, stale: true };
    throw err;
  }
}

const raw = (repo, path) =>
  `https://raw.githubusercontent.com/${CFG.username}/${repo.name}/${repo.default_branch}/${path}`;

async function rawText(repo, path) {
  try { const r = await fetch(raw(repo, path)); return r.ok ? await r.text() : null; }
  catch { return null; }
}

// Enrich one repo for the live path: file tree (1 API call) + README/progress/
// manifests (raw, no API cost) → summary, stack, tracker, structure overview.
async function enrichRepo(repo) {
  const key = `nav:enrich:${CFG.username}:${repo.name}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let fileTree = [];
  try {
    const tr = await fetch(
      `https://api.github.com/repos/${CFG.username}/${repo.name}/git/trees/${repo.default_branch}?recursive=1`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (tr.ok) {
      const body = await tr.json();
      const all = (body.tree || []).map((t) => ({ path: t.path, type: t.type === "tree" ? "dir" : "file" }));
      const root = all.filter((e) => !e.path.includes("/"));
      const manifests = all.filter((e) => MANIFEST_NAMES.includes(e.path.split("/").pop().toLowerCase()));
      fileTree = dedupeTree([...root, ...manifests]).slice(0, 40);
    }
  } catch {}

  const has = (n) => fileTree.some((e) => e.path.split("/").pop().toLowerCase() === n);
  const readmeEntry = fileTree.find((e) => /^readme(\.|$)/i.test(e.path));
  const [readme, progress, pkg, req, pyproj] = await Promise.all([
    readmeEntry ? rawText(repo, readmeEntry.path) : rawText(repo, "README.md"),
    has("progress.md") ? rawText(repo, CFG.trackerFile) : Promise.resolve(null),
    has("package.json") ? rawText(repo, "package.json") : Promise.resolve(null),
    has("requirements.txt") ? rawText(repo, "requirements.txt") : Promise.resolve(null),
    has("pyproject.toml") ? rawText(repo, "pyproject.toml") : Promise.resolve(null),
  ]);

  const tracker = progress ? parseProgress(progress) : null;
  const s = summarizeRepo({
    readme, fileTree, manifests: { "package.json": pkg, "requirements.txt": req, "pyproject.toml": pyproj },
    languages: repo.languages, description: repo.description, topics: repo.topics,
    primaryLanguage: repo.language, hasTracker: !!tracker,
  });

  const enriched = {
    summary: s.summary, summarySource: s.summarySource,
    stack: tracker && tracker.stack.length ? tracker.stack : s.stack,
    stackSource: tracker && tracker.stack.length ? "progress.md" : "inferred",
    fileTree, readmeUrl: readmeEntry ? `${repo.url}/blob/${repo.default_branch}/${readmeEntry.path}` : null,
    tracker, inferredOverview: tracker ? null : s.inferredOverview,
  };
  cacheSet(key, enriched);
  return enriched;
}

const MANIFEST_NAMES = ["package.json", "requirements.txt", "pyproject.toml", "cargo.toml", "go.mod", "gemfile", "package.swift", "dockerfile", "composer.json"];
function dedupeTree(list) {
  const seen = new Set(); const out = [];
  for (const e of list) { if (seen.has(e.path)) continue; seen.add(e.path); out.push(e); }
  return out;
}

// ─── Model ───────────────────────────────────────────────────────────────────
function statusOf(repo) {
  if (repo.archived) return "archived";
  const d = daysSince(repo.pushed_at);
  if (d <= ACTIVE_DAYS) return "active";
  if (d <= STALE_DAYS) return "recent";
  return "stale";
}
function decorate(p) {
  const m = { ...p, status: statusOf(p), title: (p.tracker && p.tracker.title) || p.name };
  m.tracker = p.tracker || null;
  m.summary = p.summary || p.description || "";
  m.stack = p.stack || (p.language ? [p.language] : []);
  m.fileTree = p.fileTree || [];
  m.inferredOverview = p.inferredOverview || null;
  return m;
}

// Aggregate language mix — true bytes from baked, else primary-language counts.
function aggregateLanguages() {
  if (STATE.languagesAgg && STATE.languagesAgg.length) return STATE.languagesAgg.slice(0, 6);
  const counts = {};
  for (const p of visibleProjects()) if (p.language) counts[p.language] = (counts[p.language] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return [];
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([name, n]) => ({ name, pct: Math.round((n / total) * 100) })).filter((l) => l.pct > 0);
}
function visibleProjects() { return STATE.projects.filter((p) => CFG.includeForks || !p.fork); }

// ─── Shared bits ─────────────────────────────────────────────────────────────
function statusBadge(s) { return `<span class="status-badge ${s}">${STATUS_LABEL[s]}</span>`; }
function sourceTag(src) {
  const declared = src === "readme" || src === "progress.md";
  const label = src === "progress.md" ? "from progress.md" : src === "readme" ? "from README" : src === "description" ? "from description" : "inferred";
  return `<span class="source-tag ${declared ? "declared" : "inferred"}">${label}</span>`;
}
function langBar(langs) {
  if (!langs || !langs.length) return "";
  const segs = langs.map((l) => `<span class="langbar-seg" style="width:${l.pct}%;background:${LANG_COLORS[l.name] || "#86868b"}" title="${esc(l.name)} ${l.pct}%"></span>`).join("");
  const legend = langs.map((l) => `<span>${langDot(l.name)}${esc(l.name)} ${l.pct}%</span>`).join("");
  return `<div class="langbar">${segs}</div><div class="langbar-legend">${legend}</div>`;
}
function stackChips(stack, source) {
  if (!stack || !stack.length) return "";
  return `<div class="project-stack">${stack.slice(0, 6).map((s) => `<span class="stack-chip">${esc(s)}</span>`).join("")}${source ? sourceTag(source) : ""}</div>`;
}

// ─── State ───────────────────────────────────────────────────────────────────
let STATE = {
  projects: [], languagesAgg: null, owner: null, cachedAt: 0, baked: false, stale: false,
  showDormant: false, query: "", filters: { status: "all", lang: "all" },
  view: {}, openFeatures: {}, // per-project view mode + expanded feature keys
};

// ─── Dashboard ───────────────────────────────────────────────────────────────
function dashHead() {
  const o = STATE.owner;
  const avatar = o && o.avatarUrl
    ? `<img class="dash-avatar" src="${esc(o.avatarUrl)}" alt="" width="64" height="64" loading="lazy" />`
    : "";
  return `<header class="dash-head">
    ${avatar}
    <div class="dash-head-text">
      <h1 class="dash-title">${esc((o && o.name) || CFG.ownerName || CFG.username)}</h1>
      ${CFG.tagline ? `<p class="dash-tagline">${esc(CFG.tagline)}</p>` : ""}
    </div>
  </header>`;
}
function snapshotHTML(projects) {
  const active = projects.filter((p) => p.status === "active").length;
  const langs = new Set(projects.filter((p) => p.language).map((p) => p.language));
  const lastPush = projects.reduce((m, p) => (p.pushed_at > m ? p.pushed_at : m), "");
  const tile = (n, l) => `<div class="snap-tile"><div class="snap-num">${n}</div><div class="snap-label">${l}</div></div>`;
  return `<section class="snapshot">
    ${tile(projects.length, projects.length === 1 ? "Repository" : "Repositories")}
    ${tile(active, `Active · ${ACTIVE_DAYS}d`)}
    ${tile(langs.size, langs.size === 1 ? "Language" : "Languages")}
    ${tile(lastPush ? timeAgo(lastPush) : "—", "Last pushed")}
  </section>`;
}
function toolbarHTML(projects) {
  const langs = [...new Set(projects.filter((p) => p.language).map((p) => p.language))].sort();
  const f = STATE.filters;
  const chip = (k, v, label) => `<button class="filter-chip ${f[k] === v ? "active" : ""}" data-k="${k}" data-v="${esc(v)}">${esc(label)}</button>`;
  return `<div class="toolbar">
    <input class="search-input" type="search" placeholder="Search projects, stacks, languages…" value="${esc(STATE.query)}" />
    <div class="filter-row">
      <div class="filter-group"><span class="filter-label">Status</span>
        ${chip("status", "all", "All")}${chip("status", "active", "Active")}${chip("status", "recent", "Recent")}${chip("status", "stale", "Dormant")}
      </div>
      ${langs.length ? `<div class="filter-group"><span class="filter-label">Language</span>
        ${chip("lang", "all", "All")}${langs.map((l) => chip("lang", l, l)).join("")}
      </div>` : ""}
    </div>
  </div>`;
}
function matchesFilters(p) {
  const f = STATE.filters;
  if (f.status !== "all" && p.status !== f.status) return false;
  if (f.lang !== "all" && p.language !== f.lang) return false;
  const q = STATE.query.trim().toLowerCase();
  if (q) {
    const hay = [p.name, p.title, p.summary, p.language, ...(p.stack || []), ...(p.topics || [])].join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
function projectCard(p) {
  const meta = [
    p.language ? `${langDot(p.language)}${esc(p.language)}` : "",
    p.stars ? `★ ${p.stars}` : "",
    p.openIssues ? `${p.openIssues} issue${p.openIssues === 1 ? "" : "s"}` : "",
    `pushed ${timeAgo(p.pushed_at)}`,
  ].filter(Boolean);
  return `<article class="project-card ${p.status}" data-open="${esc(p.name)}">
    <div class="project-card-head">${langDot(p.language)}<h3 class="project-name">${esc(p.title)}</h3>${statusBadge(p.status)}</div>
    <p class="project-summary">${p.summary ? esc(p.summary) : "<span class='muted'>No description</span>"}</p>
    ${stackChips(p.stack, p.summarySource === "inferred" || p.stackSource === "inferred" ? "inferred" : null)}
    <div class="project-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
    <div class="project-actions">
      <a class="project-link" href="#/project/${encodeURIComponent(p.name)}">Open →</a>
      <a class="project-link ghost" href="${esc(p.url)}" target="_blank" rel="noopener">GitHub ↗</a>
      ${p.homepage ? `<a class="project-link ghost" href="${esc(p.homepage)}" target="_blank" rel="noopener">Live ↗</a>` : ""}
    </div>
  </article>`;
}
function projectsHTML(projects) {
  const filtered = projects.filter(matchesFilters);
  const live = filtered.filter((p) => p.status === "active" || p.status === "recent").sort(byPush);
  const dormant = filtered.filter((p) => p.status === "stale" || p.status === "archived").sort(byPush);
  const dormantBlock = dormant.length
    ? `<button class="dormant-toggle" data-toggle="dormant">${STATE.showDormant ? "Hide" : "Show"} dormant (${dormant.length})</button>
       ${STATE.showDormant ? `<div class="project-grid dormant">${dormant.map(projectCard).join("")}</div>` : ""}`
    : "";
  const head = `<div class="section-head"><h2 class="section-title">All projects</h2><span class="result-count">${filtered.length} of ${projects.length}</span></div>`;
  if (!filtered.length) return `<section class="section projects-section">${head}<p class="empty-note">No projects match your search/filters.</p></section>`;
  return `<section class="section projects-section">${head}
    ${live.length ? `<div class="project-grid">${live.map(projectCard).join("")}</div>` : `<p class="empty-note">No active projects — try the dormant ones below.</p>`}
    ${dormantBlock}
  </section>`;
}
const byPush = (a, b) => new Date(b.pushed_at) - new Date(a.pushed_at);

function renderHome() {
  const projects = visibleProjects();
  if (!projects.length) {
    APP.innerHTML = `<div class="dash fade-in">${dashHead()}<div class="empty-state"><p>No repositories found for <code>@${esc(CFG.username)}</code> yet.</p></div></div>`;
    return;
  }
  APP.innerHTML = `<div class="dash fade-in">
    ${dashHead()}
    ${snapshotHTML(projects)}
    ${toolbarHTML(projects)}
    ${langMixHTML()}
    ${projectsHTML(projects)}
    ${refreshNote()}
  </div>`;

  // wire interactions
  const search = APP.querySelector(".search-input");
  if (search) search.addEventListener("input", (e) => { STATE.query = e.target.value; rerenderProjects(); });
  APP.querySelectorAll(".filter-chip").forEach((b) =>
    b.addEventListener("click", () => { STATE.filters[b.dataset.k] = b.dataset.v; renderHome(); restoreFocus(); }));
  bindCardNav();
  const toggle = APP.querySelector('[data-toggle="dormant"]');
  if (toggle) toggle.addEventListener("click", () => { STATE.showDormant = !STATE.showDormant; renderHome(); });
}
function rerenderProjects() {
  // Re-render only the project section + result count for snappy live search.
  const sec = APP.querySelector(".projects-section");
  if (!sec) return renderHome();
  sec.outerHTML = projectsHTML(visibleProjects());
  bindCardNav();
  const toggle = APP.querySelector('[data-toggle="dormant"]');
  if (toggle) toggle.addEventListener("click", () => { STATE.showDormant = !STATE.showDormant; renderHome(); });
}
function bindCardNav() {
  APP.querySelectorAll(".project-card").forEach((c) =>
    c.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // let explicit links work
      location.hash = `#/project/${encodeURIComponent(c.dataset.open)}`;
    }));
}
function restoreFocus() { const s = APP.querySelector(".search-input"); if (s && STATE.query) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }

function langMixHTML() {
  const langs = aggregateLanguages();
  if (!langs.length) return "";
  return `<section class="section"><div class="section-head"><h2 class="section-title">Languages</h2></div>${langBar(langs)}</section>`;
}
function refreshNote() {
  const when = STATE.cachedAt ? timeAgo(new Date(STATE.cachedAt).toISOString()) : "just now";
  const src = STATE.baked ? "Baked from the GitHub API" : "Live from the GitHub API";
  return `<p class="refresh-note">${src} · ${visibleProjects().length} repos · updated ${when}${STATE.stale ? " · cached (rate limit)" : ""}</p>`;
}

// ─── Project detail ──────────────────────────────────────────────────────────
async function renderProject(name, opts = {}) {
  const p = STATE.projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { location.hash = "#/"; return; }

  // Live path: enrich on open if not done yet.
  if (!STATE.baked && !p._enriched && !p.fork) {
    APP.innerHTML = loadingHTML(`Reading ${esc(p.name)}…`);
    try {
      const e = await enrichRepo(p);
      Object.assign(p, e, { _enriched: true });
      p.title = (p.tracker && p.tracker.title) || p.name;
      p.status = statusOf(p);
    } catch { p._enriched = true; }
  }

  const hasFeatures = p.tracker && p.tracker.features.length;
  // Deep-linked feature forces the List view so the target is visible.
  const focusFeat = opts.feature != null && hasFeatures && opts.feature < p.tracker.features.length ? opts.feature : null;
  const view = focusFeat != null ? "list" : (STATE.view[p.name] || "list");
  const links = detailLinks(p);
  const ph = `#/project/${encodeURIComponent(p.name)}`;
  const crumbs = `<nav class="breadcrumbs">
    <a href="#/">All projects</a><span class="crumb-sep">/</span>
    ${focusFeat != null
      ? `<a href="${ph}">${esc(p.title)}</a><span class="crumb-sep">/</span><span class="crumb-current">${esc(p.tracker.features[focusFeat].name)}</span>`
      : `<span class="crumb-current">${esc(p.title)}</span>`}
  </nav>`;

  APP.innerHTML = `<div class="detail fade-in">
    ${crumbs}
    <div class="detail-head"><h1 class="page-title">${esc(p.title)}</h1>${statusBadge(p.status)}</div>
    <p class="detail-summary">${esc(p.summary || p.description || "No description")} ${p.summarySource ? sourceTag(p.summarySource) : ""}</p>
    <div class="detail-meta">
      ${p.language ? `<span>${langDot(p.language)}${esc(p.language)}</span>` : ""}
      ${p.commitCount != null ? `<span>${p.commitCount.toLocaleString()} commits</span>` : ""}
      ${p.stars ? `<span>★ ${p.stars}</span>` : ""}
      ${p.forks ? `<span>⑂ ${p.forks}</span>` : ""}
      ${p.openIssues ? `<span>${p.openIssues} open issue${p.openIssues === 1 ? "" : "s"}</span>` : ""}
      ${p.created_at ? `<span>Started ${timeAgo(p.created_at)}</span>` : ""}
      ${p.pushed_at ? `<span>Updated ${timeAgo(p.pushed_at)}</span>` : ""}
    </div>
    ${p.stack && p.stack.length ? `<div class="stack">${p.stack.map((s) => `<span class="stack-chip">${esc(s)}</span>`).join("")} ${sourceTag(p.stackSource || "inferred")}</div>` : ""}
    ${links ? `<div class="detail-links">${links}</div>` : ""}
    ${p.languages ? langBar(p.languages) : ""}
    ${p.topics && p.topics.length ? `<div class="topics">${p.topics.map((t) => `<span class="topic-chip">${esc(t)}</span>`).join("")}</div>` : ""}
    ${p.lastCommit ? `<a class="last-commit" href="${esc(p.lastCommit.url)}" target="_blank" rel="noopener"><span class="last-commit-label">Latest commit</span><span class="last-commit-msg">${esc(p.lastCommit.message)}</span>${p.lastCommit.date ? `<span class="last-commit-time">${timeAgo(p.lastCommit.date)}</span>` : ""}</a>` : ""}

    ${hasFeatures ? `
      <div class="view-tabs">
        <button class="view-tab ${view === "list" ? "active" : ""}" data-view="list">List</button>
        <button class="view-tab ${view === "board" ? "active" : ""}" data-view="board">Board</button>
        <button class="view-tab ${view === "map" ? "active" : ""}" data-view="map">Mind-map</button>
      </div>
      <div class="feature-views">${featureView(p, view)}</div>`
      : inferredOrEmpty(p)}
  </div>`;

  bindDetail(p);
  if (focusFeat != null) focusFeature(p, focusFeat);
}
function focusFeature(p, i) {
  STATE.openFeatures[`${p.name}#${i}`] = true;
  const item = APP.querySelector(`.feature-item[data-feat="${i}"]`);
  if (!item) return;
  item.classList.add("open", "flash");
  item.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => item.classList.remove("flash"), 1600);
}
function loadingHTML(msg) { return `<div class="loading"><div class="spinner"></div><p>${msg}</p></div>`; }

function detailLinks(p) {
  const out = [];
  if (p.readmeUrl) out.push(`<a class="detail-link" href="${esc(p.readmeUrl)}" target="_blank" rel="noopener">📄 README</a>`);
  // a couple of "key files" — prefer entry points & source over dotfiles/config
  const key = rankKeyFiles(p.fileTree).slice(0, 3);
  for (const f of key) out.push(`<a class="detail-link" href="${esc(p.url)}/blob/${esc(p.default_branch)}/${esc(f.path)}" target="_blank" rel="noopener">${esc(f.path)}</a>`);
  out.push(`<a class="detail-link" href="${esc(p.url)}/commits" target="_blank" rel="noopener">Commits ↗</a>`);
  out.push(`<a class="detail-link" href="${esc(p.url)}" target="_blank" rel="noopener">Repo ↗</a>`);
  return out.join("");
}

// Rank a repo's files so "key files" surfaces real entry points, not dotfiles.
const ENTRY_FILES = ["main.py", "app.py", "index.js", "index.ts", "app.js", "main.js",
  "main.ts", "server.js", "main.go", "main.rs", "app.tsx", "index.html", "main.swift", "app.swift"];
const SRC_EXT = [".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".swift", ".java", ".rb", ".php", ".c", ".cpp", ".kt"];
function rankKeyFiles(tree) {
  const files = (tree || []).filter((e) => e.type === "file" && !/^readme/i.test(e.path));
  const base = (p) => p.split("/").pop().toLowerCase();
  const score = (e) => {
    const b = base(e.path);
    if (b.startsWith(".")) return -100;                  // dotfiles last
    if (ENTRY_FILES.includes(b)) return 100;             // known entry points first
    let s = 0;
    if (MANIFEST_NAMES.includes(b)) s += 40;             // manifests are meaningful
    if (SRC_EXT.some((x) => b.endsWith(x))) s += 30;
    if (/^(license|licence|changelog)$/i.test(b.replace(/\.[^.]+$/, ""))) s -= 30;
    return s;
  };
  return files.map((e) => ({ e, s: score(e) })).sort((a, b) => b.s - a.s).map((x) => x.e);
}

function featureView(p, view) {
  if (view === "board") return kanbanHTML(p);
  if (view === "map") return `<div class="mindmap"></div>`;
  return featureListHTML(p);
}
function featureListHTML(p) {
  return `<div class="feature-list">${p.tracker.features.map((f, i) => featureItem(p, f, i)).join("")}</div>`;
}
function featureItem(p, f, i) {
  const key = `${p.name}#${i}`;
  const open = !!STATE.openFeatures[key];
  const hasSubs = f.subtasks && f.subtasks.length;
  const mark = f.status === "done" ? "✓" : f.status === "in-progress" ? "•" : "";
  return `<div class="feature-item ${hasSubs ? "expandable" : ""} ${open ? "open" : ""}" data-feat="${i}">
    <div class="feature-head">
      <span class="feature-mark ${f.status}">${mark}</span>
      <span class="feature-name">${esc(f.name)}</span>
      ${hasSubs ? `<span class="feature-subcount">${f.subtasks.length}</span>` : ""}
      <span class="feature-status ${f.status}">${FEAT_LABEL[f.status]}</span>
      ${hasSubs ? `<span class="feature-caret">▸</span>` : ""}
    </div>
    ${f.note ? `<div class="feature-note">${esc(f.note)}</div>` : ""}
    ${hasSubs ? `<div class="subtask-list">${f.subtasks.map((s) => `
      <div class="subtask-item"><span class="subtask-mark ${s.status}"></span><span class="subtask-name">${esc(s.name)}</span>${s.note ? `<span class="subtask-note">${esc(s.note)}</span>` : ""}</div>`).join("")}</div>` : ""}
  </div>`;
}
function kanbanHTML(p) {
  const col = (st, title) => {
    const items = p.tracker.features.filter((f) => f.status === st);
    return `<div class="column"><div class="column-head"><div class="column-title"><span class="dot ${st === "done" ? "done" : st === "in-progress" ? "progress" : "planned"}"></span>${title}</div><span class="column-count">${items.length}</span></div>
      <div class="cards">${items.length ? items.map((f) => `<div class="card"><div class="status-bar ${f.status === "done" ? "done" : f.status === "in-progress" ? "progress" : "planned"}"></div><div class="card-title">${esc(f.name)}</div>${f.note ? `<div class="card-note">${esc(f.note)}</div>` : ""}${f.subtasks && f.subtasks.length ? `<div class="card-foot"><span class="card-proj">${f.subtasks.length} sub-task${f.subtasks.length === 1 ? "" : "s"}</span></div>` : ""}</div>`).join("") : `<div class="empty-col">Nothing here</div>`}</div></div>`;
  };
  return `<div class="kanban">${col("planned", "Planned")}${col("in-progress", "In Progress")}${col("done", "Done")}</div>`;
}
function inferredOrEmpty(p) {
  if (p.inferredOverview && p.inferredOverview.length) {
    return `<div class="inferred-overview">
      <div class="inferred-head"><span class="section-title">Structure</span>${sourceTag("inferred")}</div>
      ${p.inferredOverview.map((a) => `<a class="inferred-item" href="${a.path ? `${esc(p.url)}/tree/${esc(p.default_branch)}/${esc(a.path)}` : esc(p.url)}" target="_blank" rel="noopener"><span class="inferred-label">${esc(a.label)}</span><span class="inferred-note">${esc(a.note)}</span></a>`).join("")}
    </div>
    <div class="no-tracker">No <code>${esc(CFG.trackerFile)}</code> yet — add one to break this project into features and sub-tasks.</div>`;
  }
  return `<div class="no-tracker">No <code>${esc(CFG.trackerFile)}</code> and no readable structure yet.</div>`;
}

function bindDetail(p) {
  APP.querySelectorAll(".view-tab").forEach((t) =>
    t.addEventListener("click", () => { STATE.view[p.name] = t.dataset.view; renderProject(p.name); }));
  APP.querySelectorAll(".feature-item.expandable .feature-head").forEach((h) => {
    h.addEventListener("click", () => {
      const item = h.closest(".feature-item");
      const key = `${p.name}#${item.dataset.feat}`;
      STATE.openFeatures[key] = !STATE.openFeatures[key];
      item.classList.toggle("open");
    });
  });
  const mm = APP.querySelector(".mindmap");
  if (mm && window.MindMap) window.MindMap.render(mm, p);
}

// ─── Command palette (Cmd/Ctrl-K) ────────────────────────────────────────────
// Type-to-jump across every project and feature. Built from current STATE, so it
// reflects whatever's loaded (baked or live-enriched). No deps, no API calls.
let PALETTE = { open: false, query: "", items: [], results: [], active: 0 };

function paletteIndex() {
  const items = [];
  for (const p of visibleProjects()) {
    items.push({ kind: "project", label: p.title, sub: p.summary || p.language || "",
      hash: `#/project/${encodeURIComponent(p.name)}` });
    if (p.tracker && p.tracker.features) {
      p.tracker.features.forEach((f, i) => items.push({ kind: "feature", label: f.name,
        sub: `${p.title} · ${FEAT_LABEL[f.status]}`,
        hash: `#/project/${encodeURIComponent(p.name)}/f/${i}` }));
    }
  }
  return items;
}
function buildPaletteDOM() {
  if (document.getElementById("palette")) return;
  const el = document.createElement("div");
  el.id = "palette";
  el.className = "palette-overlay hidden";
  el.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Quick jump">
    <input class="palette-input" type="text" placeholder="Jump to a project or feature…" aria-label="Search projects and features" />
    <ul class="palette-results"></ul>
    <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
  </div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => { if (e.target === el) closePalette(); });
  const input = el.querySelector(".palette-input");
  input.addEventListener("input", () => { PALETTE.query = input.value; filterPalette(); });
  input.addEventListener("keydown", onPaletteKey);
}
function openPalette() {
  buildPaletteDOM();
  PALETTE.open = true;
  PALETTE.items = paletteIndex();
  PALETTE.query = "";
  const el = document.getElementById("palette");
  el.classList.remove("hidden");
  const input = el.querySelector(".palette-input");
  input.value = "";
  filterPalette();
  input.focus();
}
function closePalette() {
  PALETTE.open = false;
  const el = document.getElementById("palette");
  if (el) el.classList.add("hidden");
}
function filterPalette() {
  const q = PALETTE.query.trim().toLowerCase();
  const src = q ? PALETTE.items.filter((it) => (it.label + " " + it.sub).toLowerCase().includes(q)) : PALETTE.items;
  PALETTE.results = src.slice(0, 50);
  PALETTE.active = 0;
  drawPaletteResults();
}
function drawPaletteResults() {
  const ul = document.querySelector(".palette-results");
  if (!ul) return;
  if (!PALETTE.results.length) { ul.innerHTML = `<li class="palette-empty">No matches</li>`; return; }
  ul.innerHTML = PALETTE.results.map((it, i) => `<li class="palette-item ${i === PALETTE.active ? "active" : ""}" data-i="${i}">
    <span class="palette-kind ${it.kind}">${it.kind === "project" ? "Project" : "Feature"}</span>
    <span class="palette-label">${esc(it.label)}</span>
    ${it.sub ? `<span class="palette-sub">${esc(it.sub)}</span>` : ""}
  </li>`).join("");
  ul.querySelectorAll(".palette-item").forEach((li) => {
    li.addEventListener("mousemove", () => { if (PALETTE.active !== +li.dataset.i) { PALETTE.active = +li.dataset.i; highlightPalette(); } });
    li.addEventListener("click", () => choosePalette(+li.dataset.i));
  });
}
function highlightPalette() {
  document.querySelectorAll(".palette-item").forEach((li, i) => li.classList.toggle("active", i === PALETTE.active));
}
function onPaletteKey(e) {
  if (e.key === "ArrowDown") { e.preventDefault(); PALETTE.active = Math.min(PALETTE.active + 1, PALETTE.results.length - 1); highlightPalette(); scrollPaletteActive(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); PALETTE.active = Math.max(PALETTE.active - 1, 0); highlightPalette(); scrollPaletteActive(); }
  else if (e.key === "Enter") { e.preventDefault(); choosePalette(PALETTE.active); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
}
function scrollPaletteActive() { const el = document.querySelector(".palette-item.active"); if (el) el.scrollIntoView({ block: "nearest" }); }
function choosePalette(i) {
  const it = PALETTE.results[i];
  if (!it) return;
  closePalette();
  if (location.hash === it.hash) route(); // already there → force a re-render
  else location.hash = it.hash;
}

// ─── Router / theme / boot ───────────────────────────────────────────────────
function route() {
  const hash = location.hash || "#/";
  const fm = hash.match(/^#\/project\/([^/]+)\/f\/(\d+)$/);
  if (fm) { renderProject(decodeURIComponent(fm[1]), { feature: parseInt(fm[2], 10) }); return; }
  const m = hash.match(/^#\/project\/(.+)$/);
  if (m) { renderProject(decodeURIComponent(m[1])); return; }
  renderHome();
}
function initTheme() {
  const saved = localStorage.getItem("nav:theme");
  const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  updateThemeIcon(theme);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("nav:theme", next);
    updateThemeIcon(next);
  });
}
function updateThemeIcon(t) { document.querySelector(".theme-icon").textContent = t === "dark" ? "☀" : "☾"; }

async function boot() {
  initTheme();
  document.getElementById("brand-name").textContent = CFG.ownerName || CFG.username || "Navigator";
  document.getElementById("github-link").href = `https://github.com/${CFG.username}`;
  const pbtn = document.getElementById("palette-btn");
  if (pbtn) pbtn.addEventListener("click", openPalette);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      PALETTE.open ? closePalette() : openPalette();
    }
  });
  if (!CFG.username || CFG.username === "your-github-username") {
    APP.innerHTML = `<div class="banner" style="margin-top:48px">Set your GitHub username in <code>config.js</code>.</div>`;
    return;
  }
  try {
    const baked = await fetchBaked();
    if (baked) {
      STATE.projects = baked.projects.map(decorate);
      STATE.languagesAgg = baked.languagesAgg;
      STATE.owner = baked.owner;
      STATE.cachedAt = baked.generatedAt ? new Date(baked.generatedAt).getTime() : Date.now();
      STATE.baked = true;
      window.addEventListener("hashchange", route);
      route();
      return;
    }
    const { repos, cachedAt, stale } = await fetchRepoList();
    STATE.projects = repos.map(decorate);
    STATE.cachedAt = cachedAt; STATE.stale = stale;
    window.addEventListener("hashchange", route);
    route();
    enrichAllLive();
  } catch (err) {
    APP.innerHTML = `<div class="banner" style="margin-top:48px">Couldn't load <code>@${esc(CFG.username)}</code>: ${esc(err.message)}.
      ${String(err.message).includes("403") ? "GitHub's 60/hr unauthenticated limit may be exhausted — try again shortly." : "Check the username in <code>config.js</code>."}</div>`;
  }
}

// Background: enrich each public repo (summary/stack/tracker), refresh the view.
async function enrichAllLive() {
  const targets = visibleProjects().filter((p) => !p.archived);
  for (const p of targets) {
    try {
      const e = await enrichRepo(p);
      Object.assign(p, e, { _enriched: true });
      p.title = (p.tracker && p.tracker.title) || p.name;
    } catch {}
  }
  if (!location.hash.startsWith("#/project/")) renderHome();
}

boot();

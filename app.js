// ─── Coder Dashboard ─────────────────────────────────────────────────────────
// A personal "what am I working on" dashboard. Auto-discovers every public repo
// from the GitHub API using just a username — ONE unauthenticated call, cached
// in localStorage. progress.md (optional, per repo) is fetched lazily from
// raw.githubusercontent.com (a different host, NOT subject to the 60-req/hr API
// limit). Richer/private stats can be baked server-side into an optional
// stats.json; if it's absent, those bits simply don't render. No fake data —
// ever. If a signal isn't real, it's omitted.

const CFG = window.TRACKER_CONFIG || {};
const { parseProgress } = window.TrackerParser;
const APP = document.getElementById("app");

const ACTIVE_DAYS = CFG.activeDays || 14;
const STALE_DAYS = CFG.staleDays || 60;

const STATUS_LABEL = {
  active: "Active",
  recent: "Recent",
  stale: "Dormant",
  archived: "Archived",
};

// Restrained palette for language dots (Apple-ish accents).
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
function cacheStale(key) {
  const e = cacheRaw(key);
  return e ? e.data : null;
}
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// ─── Data layer ──────────────────────────────────────────────────────────────
// ONE API call. Returns every public repo, slimmed to what we render.
async function fetchRepos() {
  const key = `cd:repos:${CFG.username}`;
  const fresh = cacheGet(key);
  if (fresh) return { repos: fresh, cachedAt: cacheRaw(key).ts };

  try {
    const res = await fetch(
      `https://api.github.com/users/${CFG.username}/repos?per_page=100&sort=pushed`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const list = await res.json();
    const slim = list.map((r) => ({
      name: r.name,
      description: r.description || "",
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      openIssues: r.open_issues_count,
      url: r.html_url,
      homepage: r.homepage || "",
      topics: r.topics || [],
      pushed_at: r.pushed_at,
      created_at: r.created_at,
      archived: r.archived,
      fork: r.fork,
      default_branch: r.default_branch,
    }));
    cacheSet(key, slim);
    return { repos: slim, cachedAt: Date.now() };
  } catch (err) {
    // Rate-limited or offline: fall back to a stale cache if we have one.
    const stale = cacheStale(key);
    if (stale) return { repos: stale, cachedAt: cacheRaw(key).ts, stale: true };
    throw err;
  }
}

// Server-baked data.json: the complete dataset (metadata + true language bytes +
// commits + progress.md), including private repos, produced by the Action with a
// token. Primary source when present; the live public fetch below is the
// zero-config fallback. Absent on a vanilla deploy — that's fine.
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
      generatedAt: data.generatedAt || null,
    };
  } catch {
    return null;
  }
}

// progress.md for one repo via raw.githubusercontent (NOT the rate-limited API).
async function fetchTracker(repo) {
  const url = `https://raw.githubusercontent.com/${CFG.username}/${repo.name}/${repo.default_branch}/${CFG.trackerFile}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseProgress(await res.text());
  } catch {
    return null;
  }
}

// Fetch every (non-archived, non-fork) repo's progress.md in parallel and cache
// the result map. Runs AFTER first paint so the dashboard appears instantly.
async function enrichTrackers() {
  const key = `cd:trackers:${CFG.username}`;
  const cached = cacheGet(key);
  if (cached) {
    applyTrackers(cached);
    return;
  }
  const targets = STATE.projects.filter((p) => !p.archived && !p.fork);
  const results = await Promise.all(
    targets.map(async (p) => [p.name, await fetchTracker(p)])
  );
  const map = {};
  for (const [name, tracker] of results) if (tracker) map[name] = tracker;
  cacheSet(key, map);
  applyTrackers(map);
}

function applyTrackers(map) {
  for (const p of STATE.projects) {
    const t = map[p.name];
    if (t) {
      p.tracker = t;
      p.title = t.title || p.name;
      if (t.description) p.description = p.description || t.description;
    }
  }
  STATE.trackersLoaded = true;
}

// ─── Model ───────────────────────────────────────────────────────────────────
function statusOf(repo) {
  if (repo.archived) return "archived";
  const d = daysSince(repo.pushed_at);
  if (d <= ACTIVE_DAYS) return "active";
  if (d <= STALE_DAYS) return "recent";
  return "stale";
}

// Normalizes a repo (baked or live) into the render model. Baked repos arrive
// with tracker/languages/commits already attached; live repos have them null.
function toModel(repo) {
  const m = {
    ...repo,
    title: repo.name,
    status: statusOf(repo),
    tracker: repo.tracker || null,
    languages: repo.languages || null,
    commitCount: repo.commitCount ?? null,
    lastCommit: repo.lastCommit || null,
  };
  if (m.tracker && m.tracker.title) m.title = m.tracker.title;
  if (m.tracker && m.tracker.description && !m.description) m.description = m.tracker.description;
  return m;
}

// Aggregate "languages I use most". Prefers true bytes baked in data.json;
// otherwise approximates from each repo's primary language (no extra API calls).
function aggregateLanguages() {
  if (STATE.languagesAgg && STATE.languagesAgg.length) {
    return STATE.languagesAgg.slice(0, 6);
  }
  const counts = {};
  for (const p of STATE.projects) {
    if (p.fork && !CFG.includeForks) continue;
    if (p.language) counts[p.language] = (counts[p.language] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return [];
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => ({ name, pct: Math.round((n / total) * 100) }))
    .filter((l) => l.pct > 0);
}

// Only repos we count as "mine to build": drops forks unless opted in.
function visibleProjects() {
  return STATE.projects.filter((p) => CFG.includeForks || !p.fork);
}

// ─── Shared bits ─────────────────────────────────────────────────────────────
function statusBadge(status) {
  return `<span class="status-badge ${status}">${STATUS_LABEL[status]}</span>`;
}

function langBar(langs) {
  if (!langs || !langs.length) return "";
  const segs = langs
    .map((l) => `<span class="langbar-seg" style="width:${l.pct}%;background:${LANG_COLORS[l.name] || "#86868b"}" title="${esc(l.name)} ${l.pct}%"></span>`)
    .join("");
  const legend = langs
    .map((l) => `<span>${langDot(l.name)}${esc(l.name)} ${l.pct}%</span>`)
    .join("");
  return `<div class="langbar">${segs}</div><div class="langbar-legend">${legend}</div>`;
}

function featureCounts() {
  const all = visibleProjects().flatMap((p) => (p.tracker ? p.tracker.features : []));
  return {
    total: all.length,
    done: all.filter((f) => f.status === "done").length,
    "in-progress": all.filter((f) => f.status === "in-progress").length,
    planned: all.filter((f) => f.status === "planned").length,
  };
}

// ─── Home ────────────────────────────────────────────────────────────────────
let STATE = { projects: [], languagesAgg: null, cachedAt: 0, showDormant: false, baked: false, stale: false };

function snapshotHTML(projects) {
  const active = projects.filter((p) => p.status === "active").length;
  const langs = new Set(projects.filter((p) => p.language).map((p) => p.language));
  const lastPush = projects.reduce((m, p) => (p.pushed_at > m ? p.pushed_at : m), "");
  const tile = (num, label) => `<div class="snap-tile"><div class="snap-num">${num}</div><div class="snap-label">${label}</div></div>`;
  return `
    <section class="snapshot">
      ${tile(projects.length, projects.length === 1 ? "Repository" : "Repositories")}
      ${tile(active, `Active · ${ACTIVE_DAYS}d`)}
      ${tile(langs.size, langs.size === 1 ? "Language" : "Languages")}
      ${tile(lastPush ? timeAgo(lastPush) : "—", "Last pushed")}
    </section>`;
}

function activityHTML(projects) {
  const recent = projects
    .filter((p) => p.status === "active" || p.status === "recent")
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 6);

  const body = recent.length
    ? `<div class="activity-grid">${recent.map(activityCard).join("")}</div>`
    : `<p class="empty-note">Nothing pushed in the last ${STALE_DAYS} days.</p>`;

  return `<section class="section">
    <div class="section-head"><h2 class="section-title">Currently working on</h2></div>
    ${body}
  </section>`;
}

function activityCard(p) {
  return `<a class="activity-card ${p.status}" href="#/project/${encodeURIComponent(p.name)}">
    <div class="activity-row">
      ${langDot(p.language)}
      <span class="activity-name">${esc(p.title)}</span>
      ${statusBadge(p.status)}
    </div>
    ${p.description ? `<p class="activity-desc">${esc(p.description)}</p>` : ""}
    <div class="activity-meta">
      <span>pushed ${timeAgo(p.pushed_at)}</span>
      ${p.openIssues ? `<span>${p.openIssues} open issue${p.openIssues === 1 ? "" : "s"}</span>` : ""}
    </div>
  </a>`;
}

function langMixHTML() {
  const langs = aggregateLanguages();
  if (!langs.length) return "";
  return `<section class="section">
    <div class="section-head"><h2 class="section-title">Languages</h2></div>
    ${langBar(langs)}
  </section>`;
}

// Progress summary — rendered ONLY when real progress.md files exist.
function progressHTML() {
  const c = featureCounts();
  if (!c.total) return "";
  const card = (num, css, label) => `
    <div class="stat-card">
      <div class="stat-num">${num}</div>
      <div class="stat-label"><span class="dot ${css}"></span>${label}</div>
    </div>`;
  return `<section class="section">
    <div class="section-head"><h2 class="section-title">Progress · from your progress.md files</h2></div>
    <div class="stats">
      ${card(c.done, "done", "Shipped")}
      ${card(c["in-progress"], "progress", "In Progress")}
      ${card(c.planned, "planned", "Planned")}
    </div>
  </section>`;
}

function projectCard(p) {
  const meta = [
    p.language ? `${langDot(p.language)}${esc(p.language)}` : "",
    p.stars ? `★ ${p.stars}` : "",
    p.openIssues ? `${p.openIssues} issue${p.openIssues === 1 ? "" : "s"}` : "",
    `pushed ${timeAgo(p.pushed_at)}`,
  ].filter(Boolean);

  return `<article class="project-card ${p.status}">
    <div class="project-card-head">
      ${langDot(p.language)}
      <h3 class="project-name">${esc(p.title)}</h3>
      ${statusBadge(p.status)}
    </div>
    <p class="project-desc">${p.description ? esc(p.description) : "<span class='muted'>No description</span>"}</p>
    <div class="project-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
    <div class="project-actions">
      <a class="project-link" href="#/project/${encodeURIComponent(p.name)}">Details →</a>
      <a class="project-link ghost" href="${esc(p.url)}" target="_blank" rel="noopener">GitHub ↗</a>
      ${p.homepage ? `<a class="project-link ghost" href="${esc(p.homepage)}" target="_blank" rel="noopener">Live ↗</a>` : ""}
    </div>
  </article>`;
}

function projectsHTML(projects) {
  const live = projects.filter((p) => p.status === "active" || p.status === "recent");
  const dormant = projects.filter((p) => p.status === "stale" || p.status === "archived");
  const byPush = (a, b) => new Date(b.pushed_at) - new Date(a.pushed_at);
  live.sort(byPush);
  dormant.sort(byPush);

  const dormantBlock = dormant.length
    ? `<button class="dormant-toggle" data-toggle="dormant">
         ${STATE.showDormant ? "Hide" : "Show"} dormant (${dormant.length})
       </button>
       ${STATE.showDormant ? `<div class="project-grid dormant">${dormant.map(projectCard).join("")}</div>` : ""}`
    : "";

  return `<section class="section">
    <div class="section-head"><h2 class="section-title">All projects</h2></div>
    ${live.length ? `<div class="project-grid">${live.map(projectCard).join("")}</div>` : `<p class="empty-note">No active projects in the last ${STALE_DAYS} days.</p>`}
    ${dormantBlock}
  </section>`;
}

function renderHome() {
  const projects = visibleProjects();

  if (!projects.length) {
    APP.innerHTML = `<div class="dash fade-in">
      ${dashHead()}
      <div class="empty-state">
        <p>No public repositories found for <code>@${esc(CFG.username)}</code> yet.</p>
        <p class="muted">Create a public repo and it'll appear here automatically.</p>
      </div>
    </div>`;
    return;
  }

  APP.innerHTML = `<div class="dash fade-in">
    ${dashHead()}
    ${snapshotHTML(projects)}
    ${activityHTML(projects)}
    ${langMixHTML()}
    ${progressHTML()}
    ${projectsHTML(projects)}
    ${refreshNote()}
  </div>`;

  const toggle = APP.querySelector('[data-toggle="dormant"]');
  if (toggle) toggle.addEventListener("click", () => { STATE.showDormant = !STATE.showDormant; renderHome(); });
}

function dashHead() {
  return `<header class="dash-head">
    <h1 class="dash-title">${esc(CFG.ownerName || CFG.username)}</h1>
    ${CFG.tagline ? `<p class="dash-tagline">${esc(CFG.tagline)}</p>` : ""}
  </header>`;
}

function refreshNote() {
  const when = STATE.cachedAt ? timeAgo(new Date(STATE.cachedAt).toISOString()) : "just now";
  const src = STATE.baked ? "Baked from the GitHub API" : "Auto-discovered from the GitHub API";
  const stale = STATE.stale ? " · showing cached data (GitHub rate limit)" : "";
  return `<p class="refresh-note">${src} · updated ${when}${stale}</p>`;
}

// ─── Project detail ──────────────────────────────────────────────────────────
async function renderProject(name) {
  const p = STATE.projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { location.hash = "#/"; return; }

  // Lazy-load this repo's progress.md if the background pass hasn't reached it.
  if (!p.tracker && !p.archived && !p.fork) {
    const t = await fetchTracker(p);
    if (t) { p.tracker = t; p.title = t.title || p.name; if (t.description) p.description = p.description || t.description; }
  }

  const tracker = p.tracker;
  const stack = tracker && tracker.stack.length ? tracker.stack : (p.language ? [p.language] : []);
  const total = tracker ? tracker.features.length : 0;
  const done = tracker ? tracker.features.filter((f) => f.status === "done").length : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  APP.innerHTML = `<div class="fade-in">
    <a class="back-link" href="#/">← All projects</a>
    <div class="detail-head">
      <h1 class="page-title">${esc(p.title)}</h1>
      ${statusBadge(p.status)}
    </div>
    ${p.description ? `<p class="page-subtitle">${esc(p.description)}</p>` : ""}
    <div class="detail-meta">
      ${p.language ? `<span>${langDot(p.language)}${esc(p.language)}</span>` : ""}
      ${p.commitCount != null ? `<span>${p.commitCount.toLocaleString()} commits</span>` : ""}
      ${p.stars ? `<span>★ ${p.stars} star${p.stars === 1 ? "" : "s"}</span>` : ""}
      ${p.forks ? `<span>⑂ ${p.forks} fork${p.forks === 1 ? "" : "s"}</span>` : ""}
      ${p.openIssues ? `<span>${p.openIssues} open issue${p.openIssues === 1 ? "" : "s"}</span>` : ""}
      ${p.created_at ? `<span>Started ${timeAgo(p.created_at)}</span>` : ""}
      ${p.pushed_at ? `<span>Updated ${timeAgo(p.pushed_at)}</span>` : ""}
      <span><a style="color:var(--accent)" href="${esc(p.url)}" target="_blank" rel="noopener">View on GitHub ↗</a></span>
      ${p.homepage ? `<span><a style="color:var(--accent)" href="${esc(p.homepage)}" target="_blank" rel="noopener">Live site ↗</a></span>` : ""}
    </div>

    ${p.lastCommit ? `
      <a class="last-commit" href="${esc(p.lastCommit.url)}" target="_blank" rel="noopener">
        <span class="last-commit-label">Latest commit</span>
        <span class="last-commit-msg">${esc(p.lastCommit.message)}</span>
        ${p.lastCommit.date ? `<span class="last-commit-time">${timeAgo(p.lastCommit.date)}</span>` : ""}
      </a>` : ""}

    ${langBar(p.languages)}

    ${p.topics && p.topics.length ? `<div class="topics">${p.topics.map((t) => `<span class="topic-chip">${esc(t)}</span>`).join("")}</div>` : ""}

    ${stack.length ? `<div class="stack">${stack.map((s) => `<span class="stack-chip">${esc(s)}</span>`).join("")}</div>` : ""}

    ${tracker && total ? `
      <div class="progress-wrap">
        <div class="progress-head"><span>${done} of ${total} features shipped</span><span>${pct}%</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="checklist">
        ${tracker.features.map(checkItem).join("")}
      </div>`
    : `<div class="no-tracker">No <code>${esc(CFG.trackerFile)}</code> in this repo, so there's no feature breakdown. Add one to its root to track progress here.</div>`}
  </div>`;
}

function checkItem(f) {
  const css = f.status === "done" ? "done" : f.status === "in-progress" ? "progress" : "planned";
  const label = f.status === "done" ? "Done" : f.status === "in-progress" ? "In Progress" : "Planned";
  const mark = f.status === "done" ? "✓" : f.status === "in-progress" ? "•" : "";
  return `<div class="check-item ${css}">
    <div class="check-mark ${css}">${mark}</div>
    <div class="check-body">
      <div class="check-name">${esc(f.name)}</div>
      ${f.note ? `<div class="check-note">${esc(f.note)}</div>` : ""}
    </div>
    <span class="check-status ${css}">${label}</span>
  </div>`;
}

// ─── Router ──────────────────────────────────────────────────────────────────
function route() {
  const m = (location.hash || "#/").match(/^#\/project\/(.+)$/);
  if (m) renderProject(decodeURIComponent(m[1]));
  else renderHome();
}

// ─── Theme ───────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem("cd:theme");
  const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  updateThemeIcon(theme);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("cd:theme", next);
    updateThemeIcon(next);
  });
}
function updateThemeIcon(theme) {
  document.querySelector(".theme-icon").textContent = theme === "dark" ? "☀" : "☾";
}

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  document.getElementById("brand-name").textContent = CFG.ownerName || CFG.username || "Dashboard";
  document.getElementById("github-link").href = `https://github.com/${CFG.username}`;

  if (!CFG.username || CFG.username === "your-github-username") {
    APP.innerHTML = `<div class="banner" style="margin-top:48px">
      Set your GitHub username in <code>config.js</code> to load the dashboard.
    </div>`;
    return;
  }

  try {
    // Prefer the server-baked dataset (complete, includes private repos).
    const baked = await fetchBaked();
    if (baked) {
      STATE.projects = baked.projects.map(toModel);
      STATE.languagesAgg = baked.languagesAgg;
      STATE.cachedAt = baked.generatedAt ? new Date(baked.generatedAt).getTime() : Date.now();
      STATE.baked = true;
      window.addEventListener("hashchange", route);
      route();
      return;
    }

    // Zero-config fallback: live public repos only (one unauthenticated call).
    const { repos, cachedAt, stale } = await fetchRepos();
    STATE.projects = repos.map(toModel);
    STATE.cachedAt = cachedAt;
    STATE.stale = stale;

    window.addEventListener("hashchange", route);
    route(); // paint immediately from the one API call

    // Progressive enhancement: pull progress.md files, then refresh the view.
    enrichTrackers().then(() => route()).catch(() => {});
  } catch (err) {
    APP.innerHTML = `<div class="banner" style="margin-top:48px">
      Couldn't load repos for <code>@${esc(CFG.username)}</code>: ${esc(err.message)}.
      ${String(err.message).includes("403")
        ? "GitHub's unauthenticated rate limit (60/hr) may be exhausted — try again shortly."
        : "Check the username in <code>config.js</code>."}
    </div>`;
  }
}

boot();

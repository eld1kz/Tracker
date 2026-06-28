#!/usr/bin/env node
// ─── Bake data.json (server-side, token) ─────────────────────────────────────
// Auto-discovers EVERY repo the token can see (no hardcoded list) and bakes a
// complete data.json the site reads as its primary source: metadata, true
// language bytes, commit counts, latest commit, parsed progress.md (with nested
// sub-tasks), a shallow file tree, an auto-generated plain-language summary, an
// inferred tech stack, and a structure overview for repos without progress.md.
//
// The token lives only here (CI secret / local env), never in the browser.
//
// ⚠ BAKE_PRIVATE = true: private repos ARE included (names/descriptions/progress
//   land in data.json, which is committed to this public repo and served by the
//   public page). Set false to keep private repos off a public site.
//
// Usage:  TRACKER_TOKEN=github_pat_xxx node build/fetch.cjs

const fs = require("fs");
const path = require("path");
const CFG = require("../config.js");
const { parseProgress } = require("../parser.js");
const { summarizeRepo } = require("../summarize.js");

const TOKEN = process.env.TRACKER_TOKEN || process.env.GITHUB_TOKEN || "";
const OUT = path.join(__dirname, "..", "data.json");
const BAKE_PRIVATE = true;
const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml"];

if (!TOKEN) {
  console.error("✗ No token. Set TRACKER_TOKEN or GITHUB_TOKEN.");
  process.exit(1);
}

const gh = async (url) =>
  fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "project-navigator",
    },
  });

async function discoverRepos() {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh(`https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner&sort=pushed`);
    if (!res.ok) throw new Error(`repo discovery failed: ${res.status}`);
    const batch = await res.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => {
    if (r.owner && r.owner.login.toLowerCase() !== CFG.username.toLowerCase()) return false;
    if (!BAKE_PRIVATE && r.private) return false;
    if (r.fork && !CFG.includeForks) return false;
    return true;
  });
}

function topLanguages(bytes, n = 4) {
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  if (!total) return null;
  return Object.entries(bytes).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, b]) => ({ name, pct: Math.round((b / total) * 100) })).filter((l) => l.pct > 0);
}
async function languageBytes(name) {
  try { const r = await gh(`https://api.github.com/repos/${CFG.username}/${name}/languages`); return r.ok ? await r.json() : {}; }
  catch { return {}; }
}
async function commitInfo(name, branch) {
  try {
    const res = await gh(`https://api.github.com/repos/${CFG.username}/${name}/commits?per_page=1&sha=${branch}`);
    if (!res.ok) return { lastCommit: null, commitCount: null };
    const list = await res.json();
    const c = Array.isArray(list) && list[0];
    const lastCommit = c ? { message: (c.commit.message || "").split("\n")[0], date: c.commit.author?.date || c.commit.committer?.date || null, url: c.html_url } : null;
    let commitCount = Array.isArray(list) ? list.length : null;
    const link = res.headers.get("link");
    const m = link && link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (m) commitCount = parseInt(m[1], 10);
    return { lastCommit, commitCount };
  } catch { return { lastCommit: null, commitCount: null }; }
}
async function fileContent(name, p) {
  try {
    const r = await gh(`https://api.github.com/repos/${CFG.username}/${name}/contents/${p}`);
    if (!r.ok) return null;
    const body = await r.json();
    return { text: Buffer.from(body.content, body.encoding || "base64").toString("utf8"), url: body.html_url };
  } catch { return null; }
}
async function fetchReadme(name) {
  try {
    const r = await gh(`https://api.github.com/repos/${CFG.username}/${name}/readme`);
    if (!r.ok) return { text: null, url: null };
    const body = await r.json();
    return { text: Buffer.from(body.content, body.encoding || "base64").toString("utf8"), url: body.html_url };
  } catch { return { text: null, url: null }; }
}
async function fetchTree(name, branch) {
  try {
    const r = await gh(`https://api.github.com/repos/${CFG.username}/${name}/git/trees/${branch}?recursive=1`);
    if (!r.ok) return [];
    const body = await r.json();
    const all = (body.tree || []).map((t) => ({ path: t.path, type: t.type === "tree" ? "dir" : "file" }));
    const root = all.filter((e) => !e.path.includes("/"));
    const manifests = all.filter((e) => MANIFESTS.includes(e.path.split("/").pop().toLowerCase()));
    const seen = new Set(); const out = [];
    for (const e of [...root, ...manifests]) { if (!seen.has(e.path)) { seen.add(e.path); out.push(e); } }
    return out.slice(0, 40);
  } catch { return []; }
}

async function fetchRepo(r) {
  const name = r.name;
  const bytes = await languageBytes(name);
  const [{ lastCommit, commitCount }, readme, fileTree] = await Promise.all([
    commitInfo(name, r.default_branch), fetchReadme(name), fetchTree(name, r.default_branch),
  ]);

  // progress.md (optional) + a couple of manifest files for stack detection.
  const has = (n) => fileTree.some((e) => e.path.split("/").pop().toLowerCase() === n);
  const trackerFile = has(CFG.trackerFile.toLowerCase()) ? await fileContent(name, CFG.trackerFile) : null;
  const tracker = trackerFile && trackerFile.text ? parseProgress(trackerFile.text) : null;
  const manifests = {};
  for (const mf of MANIFESTS) if (has(mf)) { const c = await fileContent(name, mf); if (c) manifests[mf] = c.text; }

  const s = summarizeRepo({
    readme: readme.text, fileTree, manifests, languages: topLanguages(bytes),
    description: r.description, topics: r.topics || [], primaryLanguage: r.language, hasTracker: !!tracker,
  });

  return {
    _bytes: bytes,
    name, description: r.description || "", url: r.html_url, homepage: r.homepage || "",
    language: r.language, languages: topLanguages(bytes),
    stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count, topics: r.topics || [],
    pushed_at: r.pushed_at, created_at: r.created_at, archived: r.archived, fork: r.fork, default_branch: r.default_branch,
    commitCount, lastCommit,
    summary: s.summary, summarySource: s.summarySource,
    stack: tracker && tracker.stack.length ? tracker.stack : s.stack,
    stackSource: tracker && tracker.stack.length ? "progress.md" : "inferred",
    readmeUrl: readme.url, fileTree,
    tracker, inferredOverview: tracker ? null : s.inferredOverview,
  };
}

async function fetchOwner() {
  try { const r = await gh(`https://api.github.com/users/${CFG.username}`); if (!r.ok) return null; const u = await r.json(); return { name: u.name || CFG.username, username: u.login, avatarUrl: u.avatar_url || null }; }
  catch { return null; }
}

(async () => {
  console.log(`Baking data.json for ${CFG.username}…`);
  const [repos, owner] = await Promise.all([discoverRepos(), fetchOwner()]);
  console.log(`  discovered ${repos.length} repo(s)`);
  const projects = [];
  const totalBytes = {};
  for (const r of repos) {
    const p = await fetchRepo(r);
    for (const [lang, n] of Object.entries(p._bytes)) totalBytes[lang] = (totalBytes[lang] || 0) + n;
    delete p._bytes;
    projects.push(p);
    console.log(`  ✓ ${r.name}${p.tracker ? ` (${p.tracker.features.length} features)` : ""} — ${p.summarySource}`);
  }
  const out = { generatedAt: new Date().toISOString(), owner, languagesAgg: topLanguages(totalBytes, 6) || [], projects };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${OUT} (${projects.length} projects).`);
})().catch((err) => { console.error("✗ Bake failed:", err.message); process.exit(1); });

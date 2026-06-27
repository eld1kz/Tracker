#!/usr/bin/env node
// ─── Bake data.json (server-side, token) ─────────────────────────────────────
// Auto-discovers EVERY repo the token can see (no hardcoded list) and bakes a
// complete data.json the site reads as its primary source: metadata, true
// language bytes, commit counts, latest commit, and the parsed progress.md.
//
// The token lives only here (CI secret / local env), never in the browser.
//
// ⚠ BAKE_PRIVATE = true: private repos ARE included, so their names,
//   descriptions, and progress land in data.json — which is committed to this
//   (public) repo and served by the public page. That's intentional: it's how
//   private projects show on the dashboard. Set false if you'd rather keep
//   private repos off the public site.
//
// Usage:  TRACKER_TOKEN=github_pat_xxx node build/fetch.cjs
// Token needs read-only Contents + Metadata on every repo you want shown.

const fs = require("fs");
const path = require("path");
const CFG = require("../config.js");
const { parseProgress } = require("../parser.js");

const TOKEN = process.env.TRACKER_TOKEN || process.env.GITHUB_TOKEN || "";
const OUT = path.join(__dirname, "..", "data.json");
const BAKE_PRIVATE = true; // include private repos (publishes them — see header)

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
      "User-Agent": "coder-dashboard",
    },
  });

// Auto-discover the authenticated user's own repos (incl. private), paginated.
async function discoverRepos() {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh(
      `https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner&sort=pushed`
    );
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
  return Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, b]) => ({ name, pct: Math.round((b / total) * 100) }))
    .filter((l) => l.pct > 0);
}

async function languageBytes(name) {
  try {
    const res = await gh(`https://api.github.com/repos/${CFG.username}/${name}/languages`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

// Latest commit + total commit count (via the Link header's last-page number).
async function commitInfo(name, branch) {
  try {
    const res = await gh(
      `https://api.github.com/repos/${CFG.username}/${name}/commits?per_page=1&sha=${branch}`
    );
    if (!res.ok) return { lastCommit: null, commitCount: null };
    const list = await res.json();
    const c = Array.isArray(list) && list[0];
    const lastCommit = c
      ? {
          message: (c.commit.message || "").split("\n")[0],
          date: c.commit.author?.date || c.commit.committer?.date || null,
          url: c.html_url,
        }
      : null;
    let commitCount = Array.isArray(list) ? list.length : null;
    const link = res.headers.get("link");
    const m = link && link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (m) commitCount = parseInt(m[1], 10);
    return { lastCommit, commitCount };
  } catch {
    return { lastCommit: null, commitCount: null };
  }
}

// Optional progress.md via the contents API (base64). 404 = none, that's fine.
async function fetchTracker(name) {
  try {
    const res = await gh(
      `https://api.github.com/repos/${CFG.username}/${name}/contents/${CFG.trackerFile}`
    );
    if (!res.ok) return null;
    const body = await res.json();
    const text = Buffer.from(body.content, body.encoding || "base64").toString("utf8");
    return parseProgress(text);
  } catch {
    return null;
  }
}

(async () => {
  console.log(`Baking data.json for ${CFG.username}…`);
  const repos = await discoverRepos();
  console.log(`  discovered ${repos.length} repo(s)`);

  const projects = [];
  const totalBytes = {};

  for (const r of repos) {
    const bytes = await languageBytes(r.name);
    for (const [lang, b] of Object.entries(bytes)) totalBytes[lang] = (totalBytes[lang] || 0) + b;
    const [{ lastCommit, commitCount }, tracker] = await Promise.all([
      commitInfo(r.name, r.default_branch),
      fetchTracker(r.name),
    ]);
    projects.push({
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
      languages: topLanguages(bytes),
      commitCount,
      lastCommit,
      tracker,
    });
    console.log(`  ✓ ${r.name}${tracker ? ` (${tracker.features.length} features)` : ""}`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    languagesAgg: topLanguages(totalBytes, 6) || [],
    projects,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${OUT} (${projects.length} projects).`);
})().catch((err) => {
  console.error("✗ Bake failed:", err.message);
  process.exit(1);
});

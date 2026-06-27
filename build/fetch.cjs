#!/usr/bin/env node
// ─── Bake stats.json (OPTIONAL server-side enrichment) ───────────────────────
// The dashboard works with ZERO setup — it auto-discovers public repos live from
// the browser. This script is the optional richer layer: using a server-side
// token (CI secret / local env, NEVER shipped to the browser), it bakes a
// stats.json with data the unauthenticated API can't cheaply give the client:
//   • true language BYTE breakdown (per repo + aggregate)
//   • commit counts and the latest commit per repo
// The site reads stats.json if present and merges it in; if it's absent, those
// extras simply don't render. No fake data, ever.
//
// Privacy: only PUBLIC repos are baked, so nothing private leaks into the file
// the public site reads. Flip BAKE_PRIVATE below if you host the site privately.
//
// Usage:  TRACKER_TOKEN=github_pat_xxx node build/fetch.cjs
// Token needs read-only Contents + Metadata on your repos.

const fs = require("fs");
const path = require("path");
const CFG = require("../config.js");

const TOKEN = process.env.TRACKER_TOKEN || process.env.GITHUB_TOKEN || "";
const OUT = path.join(__dirname, "..", "stats.json");
const BAKE_PRIVATE = false; // keep false for public-hosted sites

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

// Auto-discover every repo for the user (paginated). No hardcoded list.
async function discoverRepos() {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh(
      `https://api.github.com/users/${CFG.username}/repos?per_page=100&page=${page}&sort=pushed`
    );
    if (!res.ok) throw new Error(`repo discovery failed: ${res.status}`);
    const batch = await res.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => {
    if (!BAKE_PRIVATE && r.private) return false;
    if (r.fork && !CFG.includeForks) return false;
    return true;
  });
}

// Raw { language: bytes } map for one repo.
async function languageBytes(name) {
  try {
    const res = await gh(`https://api.github.com/repos/${CFG.username}/${name}/languages`);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
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

(async () => {
  console.log(`Baking stats.json for ${CFG.username}…`);
  const repos = await discoverRepos();
  console.log(`  discovered ${repos.length} repo(s)`);

  const out = { generatedAt: new Date().toISOString(), languagesAgg: [], repos: {} };
  const totalBytes = {};

  for (const r of repos) {
    const bytes = await languageBytes(r.name);
    for (const [lang, b] of Object.entries(bytes)) totalBytes[lang] = (totalBytes[lang] || 0) + b;
    const { lastCommit, commitCount } = await commitInfo(r.name, r.default_branch);
    out.repos[r.name] = { languages: topLanguages(bytes), commitCount, lastCommit };
    console.log(`  ✓ ${r.name}`);
  }

  out.languagesAgg = topLanguages(totalBytes, 6) || [];
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${OUT} (${repos.length} repos, ${out.languagesAgg.length} aggregate languages).`);
})().catch((err) => {
  console.error("✗ Bake failed:", err.message);
  process.exit(1);
});

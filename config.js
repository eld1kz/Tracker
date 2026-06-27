// ─── Coder Dashboard configuration ──────────────────────────────────────────
// The ONLY required field is `username`. Everything below has sensible
// defaults. No repo list — every public repo is auto-discovered from the
// GitHub API. No tokens, no secrets ever ship to the browser.

const TRACKER_CONFIG = {
  // ── Required ──────────────────────────────────────────────────────────────
  username: "eld1kz", // ← your GitHub username

  // ── Optional cosmetics ──────────────────────────────────────────────────
  ownerName: "Eldar", // display name in the header (falls back to username)
  tagline: "What I'm building — live from GitHub.",

  // ── Active / stale thresholds (days since last push) ─────────────────────
  activeDays: 14, // pushed within this many days  → "Active"
  staleDays: 60, // older than this many days     → "Dormant" (collapsed)

  // ── Behaviour ────────────────────────────────────────────────────────────
  includeForks: false, // forks pollute the "what I'm building" signal
  trackerFile: "progress.md", // optional per-repo progress file
  cacheTTLMinutes: 60, // localStorage cache lifetime (respects 60 req/hr limit)
};

// Isomorphic export: <script> tag in the browser, require() in the build script.
if (typeof window !== "undefined") window.TRACKER_CONFIG = TRACKER_CONFIG;
if (typeof module !== "undefined" && module.exports) module.exports = TRACKER_CONFIG;

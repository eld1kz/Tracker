# Build Tracker

An at-a-glance dashboard for all my projects — dashboard summary, a Kanban
board (Planned → In Progress → Done), and per-project detail with a feature
checklist. **GitHub is the source of truth:** each tracked repo carries a small
`progress.md` file, and the board is built from those files.

This is a standalone portfolio repo — it tracks *other* repos (e.g. the
`schub_friday` assistant). Each tracked repo just keeps its own `progress.md`;
this repo holds the site + the baking workflow.

Apple-style design — clean, minimal, bold typography, restrained color,
dark mode, fully responsive.

## How data flows

A GitHub Action reads each tracked repo's `progress.md` + metadata and bakes a
static `data.json` into this repo. The page loads `data.json` — **no GitHub
token ever ships to the browser**, so private repos work and stay private. The
only thing that becomes public is whatever you put in each `progress.md`.

```
This repo's GitHub Action (holds the token as a secret)
   ├─ reads tracked repos' progress.md + metadata via API
   ├─ writes data.json  ── committed back to this repo
   └─ runs on push + every 6h + manual
                  │
   Static page loads data.json  ← no token in the browser; repos stay private
```

(If you only ever track **public** repos, you can skip the Action entirely: the
page falls back to live, unauthenticated GitHub API calls when there's no
`data.json`.)

## Setup

1. Edit **`config.js`** — `username`, `ownerName`, and the curated `repos` list
   (the repo names you want to track, e.g. `schub_friday`).
2. Make sure each tracked repo has a **`progress.md`** in its root
   (copy `progress.sample.md`).
3. **Private repos** — create the token + secret (one time):
   - GitHub → Settings → Developer settings → **Fine-grained tokens** → generate
     one with **read-only** access to the repos in `config.js`:
     Repository permissions → **Contents: Read** and **Metadata: Read**.
   - In **this** repo: Settings → Secrets and variables → Actions →
     New repository secret, name **`TRACKER_TOKEN`**, paste the token.
   - The workflow (`.github/workflows/build-tracker.yml`) runs on push / every 6h
     / manual (Actions tab → "Run workflow") and re-bakes `data.json`.

### Generate `data.json` locally (optional)

```bash
TRACKER_TOKEN=your_token node build/fetch.cjs   # writes data.json
python3 -m http.server 8000                     # open http://localhost:8000
```

## The `progress.md` format

```markdown
---
title: My Project
description: One-line description.
stack: Python, FastAPI, Docker
---

- [done] Feature name — optional note
- [in-progress] Another feature
- [planned] Something later
```

- **Status** is the bracket tag: `[done]`, `[in-progress]`, `[planned]`
  (aliases like `wip`, `x`, `shipped` are understood).
- Text after ` — ` becomes the card's note.
- Frontmatter is optional; falls back to the repo's name / description / language.
- Repos without a `progress.md` still show in recent activity — they're just
  left off the board.

## Deploy

**Vercel (recommended for private repos)** — import this repo, root directory
`.`, no build command, output directory `.`. Vercel serves the static files
(including the committed `data.json`) and redeploys whenever the Action commits a
refresh. Works with private repos on the free tier.

**GitHub Pages** — enable Pages on this repo (root). Note: publishing Pages from
a *private* repo requires a paid GitHub plan; otherwise use Vercel.

## Files

| File | Role |
|------|------|
| `index.html` / `styles.css` | Page + Apple-style design system |
| `config.js` | Your username + curated repo list (isomorphic: browser + Node) |
| `parser.js` | Shared `progress.md` parser + project merge (browser + Node) |
| `app.js` | Loads `data.json` (or live API), renders dashboard/kanban/detail |
| `build/fetch.cjs` | Server-side baker → writes `data.json` |
| `data.json` | Baked board data (committed; refreshed by the Action) |
| `progress.sample.md` | Template to copy into a repo |

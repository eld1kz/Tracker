# Project Navigator — rebuild summary

Branch: **`redesign/project-navigator`** (main untouched). Reviewed against your
real GitHub repos on 2026-06-28.

## What this is now

The build-tracker is now a **project-oriented developer tool**, not a stats page.
You open it to understand all your projects at a glance and drill into any one.

- **Auto-discovered**, no hardcoded repo list — username only (`config.js`).
- **Every repo gets a plain-language auto-summary** ("what this is") + an inferred
  tech stack, generated heuristically from the README, file tree, manifests,
  languages and topics — **no LLM, no API key in the site**.
- **Inferred vs declared is always marked** (a small provenance tag: "from
  README" / "from progress.md" = declared, "inferred" = heuristic) so you can
  trust what you're reading.
- **Drill-in:** dashboard card → project → features → sub-tasks → the real files
  and commits on GitHub. Everything clickable.
- **Three per-project views:** List (features expand into sub-tasks), Board
  (Planned / In Progress / Done kanban), and an interactive **Mind-map**
  (features branch into sub-task nodes; click to expand, hover to highlight,
  click the root to open the repo).
- **Repos without a `progress.md` still feel understood** — they show an
  inferred **Structure** overview derived from the folder layout, linking to
  those folders on GitHub.
- **Cross-project search + faceted filters** (text, status, language) with a live
  "N of M" result count, so you can jump anywhere fast.
- Apple-style, dark mode, responsive. Aggressive `localStorage` caching.

## Information architecture

`Overview (all projects)` → `Project detail` → `Feature` → `Sub-task` → `File / Commit (GitHub)`

Two-level disclosure per screen (project→feature is a new screen; feature→sub-task
expands in place), per the research on avoiding "getting lost."

## Data model (`data.json`)

```
{ generatedAt, owner:{name,username,avatarUrl}, languagesAgg:[{name,pct}],
  projects:[ {
    name, description, url, homepage, language, languages:[{name,pct}],
    stars, forks, openIssues, topics, pushed_at, created_at, archived, fork,
    default_branch, commitCount, lastCommit:{message,date,url},
    summary, summarySource:"readme"|"description"|"inferred",
    stack:[…], stackSource:"progress.md"|"inferred",
    readmeUrl, fileTree:[{path,type}],
    tracker:{ title, description, stack, features:[
      { name, note, status, subtasks:[{name,note,status}] } ] } | null,
    inferredOverview:[{label,note,path}] | null
  } ] }
```

## How data flows (two paths, same model, no secrets in the browser)

1. **Baked `data.json` (primary).** `build/fetch.cjs` runs in the GitHub Action
   with `TRACKER_TOKEN` (server-side, never shipped). It auto-discovers every
   repo, pulls metadata + true language bytes + commits + `progress.md` + README
   + file tree + manifests, runs the summarizer, and writes the full `data.json`.
   Includes private repos (`BAKE_PRIVATE = true`, your earlier choice).
2. **Live client fetch (fallback).** With no `data.json`, the site lists public
   repos in one unauthenticated call, then enriches each repo client-side using
   the **same** isomorphic `summarize.js` + `parser.js` — README/`progress.md`/
   manifests come from `raw.githubusercontent` (which is **not** counted against
   the 60-req/hr API limit); only the file tree costs one API call per repo.
   Everything is cached in `localStorage`.

The summarizer (`summarize.js`) and progress parser (`parser.js`) are isomorphic,
so the baker and the browser produce identical results.

## Files

- `app.js` — rewritten: navigator UI (dashboard, search/filter, project detail,
  view switcher, feature list with expandable sub-tasks, inferred overview).
- `summarize.js` — **new**, isomorphic heuristic summarizer + stack/structure
  inference (no LLM).
- `mindmap.js` — **new**, interactive SVG mind-map module (`window.MindMap.render`).
- `parser.js` — extended: nested checklist items → `feature.subtasks[]`.
- `build/fetch.cjs` — extended baker (README, file tree, manifests, summaries,
  owner; new `data.json` shape).
- `styles.css` — new component styles (toolbar, cards, provenance tags, view
  tabs, feature/sub-task list, inferred overview, mind-map), light + dark.
- `index.html` — loads `summarize.js` + `mindmap.js`.
- `config.js` — unchanged (username + thresholds).

## Decisions & assumptions

- **Server-side summarization is primary** (in the baker) because your real
  projects are mostly private and the token reads them without rate limits; the
  browser path mirrors it for public repos so this branch is fully demoable
  without running the Action.
- **Kept** the kanban and dashboard. **Moved** kanban from a single global board
  to a **per-project** view (alongside List and Mind-map) — a project-oriented
  tool wants each project's board in its own space, not one mixed board. The
  global "currently working on" strip was folded into the recency-sorted card
  grid + Active filter.
- **Removed the stale `data.json` from this branch** (it was the previous
  iteration's shape). The Action re-bakes the new shape automatically when this
  branch is merged to `main`. Until then the live path runs.
- **`BAKE_PRIVATE = true`** retained from your earlier decision — private repo
  data is published to the public page. Flip it to `false` in `build/fetch.cjs`
  to keep private repos off a public deploy.
- **Subagent "per-repo analysis"** was not run as separate agents: agents can't
  read your private repos without the token, and the heuristic summarizer already
  does per-repo analysis deterministically in the baker. Noted so you know why.
- **Heads-up on the build:** a session limit interrupted the parallel subagents
  mid-run. The research agent finished; the data-layer agent finished
  `parser.js` + `summarize.js`; I completed `build/fetch.cjs`, `mindmap.js`,
  `app.js`, and all the CSS myself and tested the result.

## Tested

Live against your real repos: `Tracker` (README summary), `schub_friday` /
"Jarvis Assistant" (10 real features from `progress.md`, List + Board + Mind-map),
`schub-2.0` (no `progress.md` → inferred summary + Components/Models/Services
structure overview), `tusup` (dormant, collapsed). Verified: search/filter,
expand/collapse, mind-map expand + links out, light/dark, no console errors
(remaining 404s are expected: absent `data.json`/`progress.md`/manifests).
`node --check` passes on all JS; `parser.js` nesting and `summarize.js` covered
by an inline logic test.

## What needs a token or your input

- **Private repos + true language bytes + commit counts** appear only via the
  baked path. They'll populate automatically when you **merge this branch to
  `main`** (the Action runs with your existing `TRACKER_TOKEN`). On the branch
  itself you'll see the public repos via the live path.
- **Richer token-gated stats (commit-frequency graphs, PR cycle time):** clean
  hook is ready — extend `build/fetch.cjs` to add fields to `data.json` (or have
  your assistant bot write a `stats.json` the site merges). No site change beyond
  rendering. Not built now.
- **"Key files" links** currently pick the first few root files (sometimes
  dotfiles like `.gitignore`). Could be refined to prefer entry points — left as
  a polish item.

## How to deploy

Merge `redesign/project-navigator` → `main`. GitHub Pages redeploys the new UI;
the Action bakes the new-shape `data.json` (incl. private repos) within ~1-2 min.
No build step, no secrets in the page.

## Suggested next steps

1. Command palette (Cmd/Ctrl-K) for type-to-jump across projects/features — the
   research's single highest-leverage navigation add.
2. Breadcrumbs + deep-linkable feature URLs (`#/p/{repo}/f/{n}`).
3. Add nested sub-tasks to more `progress.md` files to exercise the new parser
   (only `schub_friday`'s is currently flat).
4. Owner avatar in the header (already baked into `data.json.owner`).
5. Refine "key files" selection to prefer entry points over dotfiles.

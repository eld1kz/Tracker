// ─── Repo auto-summarizer (README → summary, inferred stack, structure) ───────
// Isomorphic: loaded as a <script> in the browser (exposes window.RepoSummarizer)
// AND require()'d by the Node build script (build/fetch.cjs). Same IIFE pattern
// as parser.js so helpers stay out of the global scope of classic <script> tags.
//
// summarizeRepo({ readme, fileTree, manifests, languages, description, topics,
//                 primaryLanguage, hasTracker })
//   → { summary, summarySource, stack, stackSource, inferredOverview }
// Pure + defensive: any input may be null/empty; it never throws.

(function (root, factory) {
  const api = factory();
  if (typeof window !== "undefined") root.RepoSummarizer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // ── README → one-or-two-sentence plain-language summary ────────────────────
  function stripMarkdownLine(line) {
    let s = line;
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // images
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links → text
    s = s.replace(/<[^>]+>/g, ""); // html tags
    s = s.replace(/[*_`~]+/g, ""); // emphasis / code marks
    s = s.replace(/^#+\s*/, ""); // heading hashes
    s = s.replace(/^>\s*/, ""); // blockquote
    return s.trim();
  }

  // A "badge/shield only" line is link/image markup with no real prose left.
  function isNoise(rawLine) {
    const raw = rawLine.trim();
    if (!raw) return true;
    if (/^[-=#>*_`|]+$/.test(raw)) return true; // rules / divider
    if (/^!\[/.test(raw) || /shields\.io|badge|img\.shields/i.test(raw)) return true;
    if (/^<.*>$/.test(raw) && stripMarkdownLine(raw) === "") return true;
    return false;
  }

  function trimToSentence(text, max = 200) {
    let s = text.replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (lastStop > 40) return cut.slice(0, lastStop + 1).trim();
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + "…";
  }

  function readmeSummary(readme) {
    if (!readme || typeof readme !== "string") return "";
    const lines = readme.split("\n");
    const para = [];
    for (const line of lines) {
      if (isNoise(line)) {
        if (para.length) break; // blank/noise line ends the first real paragraph
        continue;
      }
      const clean = stripMarkdownLine(line);
      if (!clean) {
        if (para.length) break;
        continue;
      }
      // Skip a lone title line (short, no sentence punctuation) at the very top.
      if (!para.length && clean.length < 60 && !/[.!?]/.test(clean)) continue;
      para.push(clean);
    }
    if (!para.length) return "";
    return trimToSentence(para.join(" "));
  }

  // ── fileTree helpers ───────────────────────────────────────────────────────
  function topLevel(fileTree) {
    const entries = Array.isArray(fileTree) ? fileTree : [];
    return entries.filter((e) => e && e.path && !e.path.includes("/"));
  }

  function hasFile(fileTree, name) {
    const entries = Array.isArray(fileTree) ? fileTree : [];
    const lower = name.toLowerCase();
    return entries.some((e) => {
      if (!e || !e.path) return false;
      const base = e.path.split("/").pop().toLowerCase();
      return base === lower;
    });
  }

  // ── Stack inference ────────────────────────────────────────────────────────
  // Manifest file → language/runtime it implies.
  const MANIFEST_TECH = [
    ["package.json", "Node.js"],
    ["requirements.txt", "Python"],
    ["pyproject.toml", "Python"],
    ["setup.py", "Python"],
    ["Pipfile", "Python"],
    ["Cargo.toml", "Rust"],
    ["go.mod", "Go"],
    ["Gemfile", "Ruby"],
    ["pom.xml", "Java"],
    ["build.gradle", "Java"],
    ["Package.swift", "Swift"],
    ["composer.json", "PHP"],
    ["Dockerfile", "Docker"],
    ["docker-compose.yml", "Docker"],
    ["docker-compose.yaml", "Docker"],
  ];

  // package.json dependency name → display label.
  const NODE_DEPS = [
    ["next", "Next.js"],
    ["react", "React"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
    ["express", "Express"],
    ["tailwindcss", "Tailwind"],
    ["vite", "Vite"],
  ];

  // requirements.txt / pyproject token → display label.
  const PY_DEPS = [
    ["fastapi", "FastAPI"],
    ["flask", "Flask"],
    ["django", "Django"],
    ["python-telegram-bot", "python-telegram-bot"],
    ["telebot", "Telebot"],
    ["pytelegrambotapi", "Telebot"],
    ["supabase", "Supabase"],
    ["anthropic", "Anthropic"],
    ["openai", "OpenAI"],
    ["uvicorn", "Uvicorn"],
    ["playwright", "Playwright"],
    ["sqlalchemy", "SQLAlchemy"],
  ];

  function detectNodeDeps(text, out) {
    try {
      const pkg = JSON.parse(text);
      const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
      const keys = Object.keys(deps).map((k) => k.toLowerCase());
      for (const [dep, label] of NODE_DEPS) if (keys.includes(dep)) out.push(label);
    } catch {
      /* not valid JSON — ignore */
    }
  }

  function detectPyDeps(text, out) {
    const lower = text.toLowerCase();
    for (const [dep, label] of PY_DEPS) {
      // match as a token boundary so "flask" doesn't hit "flask-foo" oddly but
      // still catches "flask==2.0"; a simple includes is acceptable here.
      if (lower.includes(dep)) out.push(label);
    }
  }

  function inferStack(input) {
    const { fileTree, manifests, languages, topics } = input;
    const out = [];

    // 1. Top languages first (gives a sensible base ordering).
    (Array.isArray(languages) ? languages : []).forEach((l) => l && l.name && out.push(l.name));

    // 2. Manifest presence in the file tree.
    for (const [file, tech] of MANIFEST_TECH) if (hasFile(fileTree, file)) out.push(tech);

    // 3. Manifest contents (dependency detection).
    const man = manifests && typeof manifests === "object" ? manifests : {};
    if (man["package.json"]) detectNodeDeps(man["package.json"], out);
    if (man["requirements.txt"]) detectPyDeps(man["requirements.txt"], out);
    if (man["pyproject.toml"]) detectPyDeps(man["pyproject.toml"], out);

    // 4. Topics (often name frameworks directly).
    (Array.isArray(topics) ? topics : []).forEach((t) => {
      if (typeof t === "string" && t.length <= 20) out.push(prettyTopic(t));
    });

    // Dedupe (case-insensitive), keep first-seen order, cap at 8.
    const seen = new Set();
    const deduped = [];
    for (const item of out) {
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped.slice(0, 8);
  }

  function prettyTopic(t) {
    const map = {
      nextjs: "Next.js",
      nodejs: "Node.js",
      fastapi: "FastAPI",
      tailwindcss: "Tailwind",
    };
    if (map[t.toLowerCase()]) return map[t.toLowerCase()];
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // ── Structure overview (areas) from the file tree ──────────────────────────
  const DIR_NOTES = {
    src: "source code",
    lib: "library code",
    app: "application code",
    server: "server code",
    api: "API layer",
    backend: "backend",
    frontend: "frontend",
    client: "client",
    public: "static assets",
    static: "static assets",
    assets: "assets",
    components: "UI components",
    pages: "page routes",
    routes: "routes",
    tests: "tests",
    test: "tests",
    docs: "documentation",
    scripts: "scripts",
    build: "build tooling",
    dist: "build output",
    config: "configuration",
    migrations: "DB migrations",
    models: "data models",
    services: "services",
  };

  const FILE_NOTES = [
    ["dockerfile", "containerized"],
    ["docker-compose.yml", "containerized (compose)"],
    ["docker-compose.yaml", "containerized (compose)"],
    ["package.json", "Node manifest"],
    ["requirements.txt", "Python deps"],
    ["pyproject.toml", "Python project"],
    ["cargo.toml", "Rust manifest"],
    ["go.mod", "Go module"],
    ["makefile", "Make tasks"],
    [".github", "CI workflows"],
  ];

  function inferOverview(fileTree) {
    const top = topLevel(fileTree);
    const areas = [];

    // Recognized directories first.
    top
      .filter((e) => e.type === "dir")
      .forEach((e) => {
        const note = DIR_NOTES[e.path.toLowerCase()];
        if (note) areas.push({ label: e.path, note, path: e.path });
      });

    // Then notable manifest / config files.
    top
      .filter((e) => e.type !== "dir")
      .forEach((e) => {
        const base = e.path.toLowerCase();
        const hit = FILE_NOTES.find(([n]) => n === base);
        if (hit) areas.push({ label: e.path, note: hit[1], path: e.path });
      });

    return areas.slice(0, 8);
  }

  // ── Inferred fallback summary (no README, no description) ───────────────────
  function inferredSummary(primaryLanguage, fileTree) {
    const dirs = topLevel(fileTree)
      .filter((e) => e.type === "dir" && DIR_NOTES[e.path.toLowerCase()])
      .map((e) => e.path)
      .slice(0, 2);
    const lang = primaryLanguage || "code";
    const langPart = `A ${lang} project`;
    if (!dirs.length) return `${langPart}.`;
    const layout = dirs.map((d) => `${d}/`).join(" and ");
    return `${langPart} — organized with a ${layout} layout.`;
  }

  // ── Main entry ─────────────────────────────────────────────────────────────
  function summarizeRepo(input) {
    const i = input || {};
    let summary = readmeSummary(i.readme);
    let summarySource = "readme";
    if (!summary) {
      const desc = (i.description || "").trim();
      if (desc) {
        summary = trimToSentence(desc);
        summarySource = "description";
      } else {
        summary = inferredSummary(i.primaryLanguage, i.fileTree);
        summarySource = "inferred";
      }
    }

    const stack = inferStack(i);
    const inferredOverview = inferOverview(i.fileTree);

    return {
      summary,
      summarySource,
      stack,
      stackSource: "inferred",
      inferredOverview,
    };
  }

  return { summarizeRepo, readmeSummary, inferStack, inferOverview };
});

# Agents TTRPG

A HeroKids TTRPG session played by a mixed party — **2 AI ReACT agents + 1 human + an AI Dungeon Master** — built to study multi-agent collaboration with a human teammate.

The engine is deterministic; the LLMs only narrate and choose actions. Same seed + same actions → identical state, every run.

See `docs/superpowers/specs/2026-05-08-agents-rpg-design.md` for the project design and `CLAUDE.md` for the current layer status.

## Install

```bash
npm install
```

Requires Node ≥ 20.

## LLM providers

Two providers are supported for the live LLM agents: **Anthropic (Claude)** and **Google (Gemini)**. The provider is chosen per scenario by its `"model"` field — a `gemini-*` model routes to the Google Gen AI SDK, anything else to the Anthropic SDK. No other config changes needed; just supply the matching credentials below.

- `scenarios/basement-o-rats.json` → `"model": "gemini-3.5-flash"` (Google)
- `scenarios/baseline.json` → `"model": "claude-sonnet-4-6"` (Anthropic)

### Anthropic credentials

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Google credentials

Gemini has **two backends** behind the same SDK; pick one:

**Gemini Developer API** (default — API key, AI Studio billing):

```bash
export GEMINI_API_KEY=...   # GOOGLE_API_KEY also works
```

Get a key at <https://aistudio.google.com/apikey>.

**Vertex AI** (bills a GCP project directly — the path that draws down Cloud credits):

```bash
gcloud auth application-default login   # one-time: Application Default Credentials

export GOOGLE_GENAI_USE_VERTEXAI=true   # GEMINI_VERTEX=1 also works
export GOOGLE_CLOUD_PROJECT=my-project-id
export GOOGLE_CLOUD_LOCATION=global     # optional, default 'global'
```

Auth is ADC: locally via `gcloud auth application-default login`, or a service-account JSON via `GOOGLE_APPLICATION_CREDENTIALS` (what the Render deployment uses). Missing credentials fail with a clear error at session start, not at server boot.

## Start the app

Common args:

- `<scenario.json>` — see `scenarios/` (`basement-o-rats.json`, `baseline.json`). Optional: omitting it plays `scenarios/basement-o-rats.json`.
- `--human-script <path>` — optional JSONL of pre-recorded human inputs; omit to drive the human turn interactively. Layer-C fixtures live in `tests/fixtures/layer-c/`.

### Browser mode (default)

Boots the WS + asset server on `:5175`, builds the Pixi bundle if needed, and opens `http://localhost:5175` in your browser.

```bash
npm run play
```

That's it — `--browser` and `scenarios/basement-o-rats.json` are the defaults. Pass them explicitly to override: `npm run play -- --browser scenarios/baseline.json`.

### CLI mode

Runs the Ink terminal renderer in the same shell — no browser, no WS server. Useful for headless CI smoke runs.

```bash
npm run play -- --cli scenarios/baseline.json
```

### Dev loop on the web bundle (browser mode only)

Use this only when actively editing files in `web/`. You need **two terminals**: `npm run play` boots `:5175`; Vite serves HMR on `:5174` and proxies `/ws` and `/assets` to `:5175`.

```bash
# Terminal 1 — boots the WS + asset server on :5175
npm run play -- --browser scenarios/basement-o-rats.json --human-script tests/fixtures/layer-c/human-bran-script.jsonl

# Terminal 2 — Vite dev server on :5174 with HMR
npm run dev:web
# open http://localhost:5174 — you'll get ECONNREFUSED on /ws unless :5175 is up

npm run build:web  # one-shot production build into dist/web/
```

## Test / lint / build

```bash
npm test           # full vitest suite (663 tests)
npm run test:watch # tdd loop
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # tsc compile to dist/
```

## Layout

- `src/engine/` — pure rules engine (no I/O)
- `src/runtime/` — agent runtime (ReACT, orchestrator, prompt builder), CLI subscriber, WS subscriber
- `src/log/` — event log writer/reader, manifest, replay harness
- `web/` — Vite-built browser bundle (lit-html + Pixi.js)
- `data/` — JSON catalogs (heroes, monsters, items, equipment, boons)
- `adventures/` — adventure JSONs (`basement-o-rats.json`, `stub-layer-b.json`)
- `scenarios/` — runnable scenario configs (party + adventure + step budget)
- `assets/` — sprite PNGs organized by `heroes/`, `monsters/`, `maps/`; declared in `assets/manifest.json`
- `tests/` — vitest unit + integration tests

## Replay invariant

Given a seed plus an action sequence, the engine produces identical state on every run. Enforced by `tests/log/replay.test.ts` and `tests/integration/stub-adventure.test.ts`.

## License

[MIT](LICENSE). Hero Kids is © Justin Halliday — the game rules and adventure PDFs under `herokids/` are not covered by this license.

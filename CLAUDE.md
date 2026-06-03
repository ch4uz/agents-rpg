# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Intent

Mestrado experiment: run a HeroKids TTRPG session with a mixed party — 2 AI ReACT agents + 1 human + an AI Dungeon Master — to study **multi-agent collaboration with a human teammate**.

## Authoritative documents

Read these before doing significant work:

- `docs/superpowers/specs/2026-05-08-agents-rpg-design.md` — full project design with 14 locked decisions.
- `docs/superpowers/plans/2026-05-08-engine-foundation.md` — the plan that produced Layer A.
- `instructions.md` — original brief (very short).
- `herokids/Hero_Kids_-_Fantasy_RPG.pdf` — game rules (52 pp).
- `herokids/Hero_Kids_-_Fantasy_Adventure_-_Basement_O_Rats.pdf` — canonical adventure.

## Run / build / test

```bash
npm install        # one time
npm test           # full vitest suite
npm run test:watch
npx vitest run path/to/file.test.ts
npm run typecheck  # tsc --noEmit
npm run lint
npm run build      # tsc → dist/
npm run build:web  # Vite build of the browser bundle → dist/web/  (REQUIRED after web/ changes — see Gotchas)
npm run dev:web    # Vite dev server (port 5174, proxies /ws + /assets to 5175)

# Live playthrough (requires ANTHROPIC_API_KEY):
npm run play -- --browser scenarios/basement-o-rats.json --human-script tests/fixtures/layer-c/human-bran-script.jsonl
                   # default: browser at http://localhost:5175
npm run play -- --cli scenarios/baseline.json --human-script tests/fixtures/layer-b/human-bran-script.jsonl
                   # legacy Ink CLI path; useful for headless CI smoke
npm run play -- --browser scenarios/basement-o-rats.json --start-scene rat-tunnel
                   # jump straight to a later encounter; unknown id fails fast listing valid ids
```

Env flags (all read by `bin/play.ts` unless noted):

| Var | Default | Meaning |
|---|---|---|
| `PLAY_SEED` | random per launch | pin the dice seed for debugging |
| `PHYSICS_DICE` | `1` | `0` disables browser physics dice (seeded engine dice instead) |
| `MAX_SESSIONS` | `3` | concurrent game cap; excess tabs queue FIFO (`<=0` = unlimited) |
| `SESSION_GRACE_MS` | 5 min | reap a disconnected session after this grace (`<=0` disables all reaping) |
| `QUEUE_GRACE_MS` | 15 s | shorter disconnect grace while anyone is queued (clamped ≤ grace) |
| `IDLE_GRACE_MS` | 2 min | under queue pressure, reap CONNECTED sessions whose human is silent (need-based: only as many as there are waiters) |
| `GCS_BUCKET` | `agents-rpg-surveys-high-torch-494308-r0` | survey/run-archive bucket; `''`/`none` disables uploads |

## Layout

- `src/engine/` — pure deterministic rules engine (no I/O except catalog loaders)
- `src/log/` — event log writer/reader, run manifest, replay harness
- `src/runtime/` — agent runtime (ReACT, orchestrator, prompt builder), CLI subscriber (`cli/`), WS subscriber (`ws/`)
- `web/` — Vite-built browser bundle: lit-html DOM panels + Pixi.js board (`components/Board.ts`, `Layout.ts`)
- `web/components/three/` — Three.js + Rapier 3D dice overlay (`Dice3DOverlay.ts` owns renderer + physics world). Standalone harness at `/dice-test.html` for iterating dice physics without WS/Pixi.
- `bin/` — entry points: `play.ts` (main launcher, `--browser` default), `serve-stub.ts`, `preview-scene.ts` (render one scene statically, no LLM), `inspect-dice-glb.ts`, `gen-thought-cloud.mjs`, `install-pixellab-animations.ts`
- `data/` — JSON catalogs (heroes, monsters, items, equipment, boons)
- `adventures/` — adventure JSONs (`stub-layer-b.json`, `stub-one-scene.json`, `basement-o-rats.json`)
- `scenarios/` — scenario configs (party + adventure + persona bindings): `baseline.json`, `basement-o-rats.json`
- `personas/` — persona markdown; `.pt.md` siblings are pt-BR variants auto-loaded by `loadScenario`
- `assets/` — sprite PNGs by category + `ui/` pixel SVGs; declared in `manifest.json` (validated at WS-server boot)
- `tests/` — vitest unit + integration tests; Layer-C fixtures under `tests/fixtures/layer-c/`

## Hard rules from the spec

Not up for re-debate without explicit user input:

1. **TypeScript everywhere**, custom ReACT (no LangGraph / AutoGen).
2. **Engine owns rule state; LLM DM narrates** — engine owns HP/grid and validates every action. Dice faces may come from the seeded `Dice` OR the browser's 3D physics (physics-as-truth), but the engine always computes hit/damage from the supplied faces.
3. **Public actions and dialogue only** — thoughts are private; same channel for human and AI.
4. **Adventure-as-JSON** — no hardcoded scenes.
5. **Prompt caching from day one** (Anthropic `cache_control: ephemeral`).
6. **Human turn blocks indefinitely** — human has an explicit `skip_turn` button.
7. **v1 archetypes**: warrior, hunter, healer, warlock.
8. **Two-channel rendering** — humans see ASCII (CLI) or Pixi (browser); LLMs always receive structured JSON state.

> **Seeded determinism is no longer a project guarantee.** Live runs use a fresh random seed per launch (`runSeed` in `bin/play.ts`; pin with `PLAY_SEED`), so initiative and seeded-fallback rolls vary. Replay still works — it consumes recorded faces from `events.jsonl`, it does not re-roll. Tests needing reproducibility (`tests/log/replay.test.ts`, `tests/integration/stub-adventure.test.ts`) pass explicit fixed seeds.

## Architecture reference

### Physics-as-truth dice

With a browser tab attached (default; `PHYSICS_DICE=0` opts out), normal attacks, ability tests, object smashes, and `free_ally` checks are rolled by the browser's Rapier simulation; the settled faces are authoritative.

- **Server**: `Orchestrator.applyActionWithRolls` previews pools (`GameEngine.previewNormalAttackPools` / `previewAbilityTest` / `previewAttackObject` / free_ally), sends `roll_request` over WS, awaits `roll_response`, resolves with those faces. `WsAdapter` implements `RollProvider` (`src/runtime/roll-provider.ts`); 30s timeout / disconnect / malformed reply falls back to seeded `Dice`. The resolution event echoes `rollRequestId` (event log proves physics-rolled; browser de-dups legacy 2D dice via `matchQueueItems`).
- **Browser**: `web/main.ts` `handleRollRequest` drives `Dice3DOverlay` (free physics, no snap), reads faces via `readFaceUp`, computes the verdict locally with the SAME rule as the engine (`attackerTop >= defenderTop && attackerTop > 0`; checks: `top >= difficulty`), relays faces back. A request-id → numeric-`t` bridge in `web/ws-client.ts` keeps Board flash/projectile and HP drain on cue.
- **Check rolls** (`rollKind: 'check'` + `difficulty`, 0-die defender placeholder rendered as a "skill check" frame): single pool vs DC, resolved via `opts.providedAbilityRoll`.
- **Multi-target specials** (whirlwind / split-shot / flame-burst / pack-attack): a SEQUENCE of opposed sub-rolls. `previewSpecialAttacks` enumerates `SubAttackSpec[]` via shared helpers (`resolveSpecialSubAttacks`) so pools can't drift; one `roll_request` per sub-attack (`requestSubDuelRoll`), faces fed back through `providedSpecialRolls`; a short/missing entry falls back to seeded dice for that sub-attack only. Single-effect specials (healing-touch) preview to zero sub-attacks and resolve through the seeded engine.
- Initiative is never physics-rolled (engine `Dice` with `runSeed`). No provider (headless/CLI/tests) → seeded dice, unchanged.

### Monster control

`OrchestratorConfig.monsterControl`: `'deterministic'` (default — planner in `src/engine/monster-ai.ts`: nearest reachable enemy, lowest-HP tie-break) or `'dm'` (DM agent puppets each monster). **`bin/play.ts` and the test suite both use `'deterministic'`**; `'dm'` stays wired as a ready Layer-D experiment axis.

In `'dm'` mode: `runDmDrivenMonsterTurn` invokes the DM with a `control_combatant` observation; the DM acts via the `monster_action` tool, validated by `GameEngine.applyDmAction`; attack-like inner actions route through `applyActionWithRolls` (physics dice parity); DM-chosen actions are tagged `interpretedBy: 'dm'`, fallback (deterministic planner / forced `end_turn` when the DM stalls) is not. This mode supersedes the F24 locked decision ("no DM react after monster turns") with explicit user authorization. Replay is log-driven regardless of who decided the action.

### Off-turn reactions (gated by `partyReactions`, on in `bin/play.ts` only)

Any agent's significant combat action opens a reaction round: other AI heroes may `say`/`emote` (`Agent.reactToPartyAction`), and the DM voices 0+ monsters in ONE `Agent.reactAsMonsters` call (`voice_monster` tool → broadcast as the monster's own say/emote; the browser renders monster speech bubbles).

- **Trigger**: `REACTABLE_ACTION_KINDS` = normal_attack / attack_object / special_action / free_ally / use_boon. Move/say/emote/end_turn/skip_turn/ability_test don't trigger (`say` keeps its own message-reaction round, `runPartyReactions`).
- **Significance gate**: `summarizeReactableAction` returns null for routine outcomes; a round only opens on a non-normal status entered, damage ≥ 2, self-harm, obstacle destroyed, successful rescue, or someone left at ≤ 1 HP. (Gotcha: damage `state_change`s ALWAYS carry `status` — usually `'normal'` — so the gate checks for a non-normal VALUE; the rescue is caught via the `free_ally` resolution `success`.)
- **Parallel rounds**: hero reactors + DM voicing (+ the DM outcome react on the resolution path) run under one `Promise.all`; broadcasts after all settle, in stable order (DM → heroes → foes), via `broadcastReactions`. Reactors see the same engine-truth summary, not each other's lines.
- **Properties**: pure banter — no turn consumed, no rule state mutated, cascade-free (say/emote aren't reactable), re-entrancy-guarded, bails if a human interjection queues. Replay-safe (runtime-only broadcasts). `dmReactedThisTurn` dedups the unconditional post-turn DM react.
- **Emote pacing**: `emote` is a playback-queue beat (`QueueItem` kind `'emote'`, spawned on promotion via `LayoutCallbacks.onEmote` → `BoardApi.spawnEmote` — never on raw WS arrival) and a gating beat in `isGatingBeat`, so emote-only reactions pace the loop. Emote beats self-advance after `EMOTE_BEAT_HOLD_MS` (1.5s) and are excluded from `dialogBeat`. Headless/CLI/tests have no beat gate → no-op.
- **Known drops (by design)**: a human interjection mid-round cancels not-yet-emitted reactions; a monster say/emote still queued when `set_scene` removes the monster is skipped.

### Latency, tokens & streaming

A live AI turn used to be up to ~11 serial LLM calls; it's now ~2 calls of wall-clock. The levers (determinism/replay untouched — gates only shape runtime-only calls):

- **Multi-action ReACT replies** (`agent.ts` `takeTurn`, player only): `allowParallelTools` set; every tool call in the reply applies in order, stopping at the first rule violation or a turn-ender; thinking attributed to the first step. The DM keeps one-tool-per-step. The prompt teaches chaining + a look-first escape hatch on messy boards (`player-system.ts` HOW YOU ACT).
- **Chain pacing** (`AgentRunHooks.onChainGap` → `Orchestrator.chainGap`): between chained actions; after a say/emote it awaits the BEAT GATE first (player reads the line before the hero acts), then sleeps `playerActionDelayMs` (default 0; play.ts sets 750ms, mirroring `monsterActionDelayMs`). Also applies to the human's DM-interpreted action sequence. Skipped on interjection; no-op headless.
- **Adaptive turn-thinking budget** (`computeTurnThinkingBudget`): turn calls keep thinking ON with a per-call ceiling from deterministic engine signals — base 1024 (+1024 each for combat opening, ally in danger, outnumbered ≥3 foes, violation retry), clamped to 4096. A ready Layer-D axis. Banter calls use `LIGHT_CALL_THINKING` (`budgetTokens: 0` = off): Anthropic omits the thinking block; Gemini SENDS `thinkingBudget: 0` (omission ≠ off there).
- **Thoughts out of the cacheable history band** (`builder.ts` `assemble`): old `thought` events (measured 85% of history chars live) are filtered from the frozen snapshot prefix; the volatile tail (≤ `snapshotEveryTurns` turns) keeps recent thoughts. events.jsonl still records every thought.
- **Gemini implicit-cache fix** (`gemini.ts`): the client FOLDS the system band into the FIRST `contents` message (no `systemInstruction`) — Gemini's implicit cache matches the contents prefix (4,096-token minimum on flash). Anthropic path untouched. If the hit ratio is still low live, next escalation is explicit `CachedContent` with TTL.
- **Streaming turns** (`LlmClient.completeStream` + `LlmStreamCallbacks`): board updates as each tool call completes; `onToolUse` is AWAITED (backpressure guarantees apply order). Both providers fall back internally to batch + replayed callbacks when no stream transport is wired; `ScriptedLlmClient` doesn't implement it → tests keep batch semantics. Retries only while NOTHING has surfaced (a retry after the first callback would double-apply). Players pre-apply via the stream callback; the DM streams thoughts only (keeps exactly-one-tool batch validation). `thought` events emit per completed block BEFORE the actions they led to. Thinking deltas go runtime-only (never logged) via `AgentRunHooks.emitThinkingDelta` → WS `thinking_delta` → store `thinkingText`.
- **Instrumentation**: manifest `llmLatencyMs: {role: {calls, totalMs, meanMs, maxMs}}` (via `Agent.completeTimed` → `onLlmResponse`); live `[llm]` console lines per call (`OrchestratorConfig.onLlmCall`, play.ts only); `wallMs` epoch stamps on events.jsonl lines (`stampWallClock`, play.ts only, FILE-only — replay/tests unaffected).
- **Remaining lever (not done)**: prefetch the next turn's LLM call during the beat gate.

### In-world thought balloon (wired but DISABLED)

`THOUGHT_BALLOONS_ENABLED = false` in `web/components/Board.ts` (user decision); flip it + `npm run build:web` to re-enable — everything else stays wired. Pixel-art cloud over the thinking hero's head, hover-expands to a reading panel streaming the thought. Component `web/components/ThoughtBalloon.ts` (spawn/setText/dispose; positioning is the caller's job; dispose on `thinking_done`); reconciliation via `reconcileThoughtBalloons` runs synchronously in Board's store subscription (delta-rate updates). Art: `assets/ui/thought-cloud.svg`, `thought-cloud-large.svg` (GENERATED by `bin/gen-thought-cloud.mjs` — regenerate, don't hand-edit), `thought-trail.svg`. Balloon root anchors bottom-LEFT (`translate(-9px, -100%)`, fixed px); `--flip` near the right edge anchors bottom-RIGHT. Keep `THOUGHT_BALLOON_FADE_MS` in sync with the `thought-fade` CSS. Preview page: `/thought-test.html` (`web/thought-test.ts`). Gotcha: CSS `border-image` SMOOTHS pixel SVGs — use fixed-size sprite backgrounds.

### Parallel sessions — one server, N games

One `bin/play.ts --browser` process hosts multiple concurrent sessions (own engine/agents/orchestrator/runDir each), keyed by the browser's `?sid=`.

- **Sid lifecycle**: sticky per TAB (`resolveSessionId` in `web/ws-client.ts`, sessionStorage key `agents-rpg-sid`) — **refresh RESUMES a run; closing the tab abandons it**. A duplicated tab is handled by per-sid newest-wins kick (`activeClients: Map` in `server.ts`; same-sid new socket kicks the old; different sids coexist; no-sid connections share one `NO_SID` bucket with legacy kick behavior; `singleClient:false` spectator mode never kicks).
- **Registry** (`src/runtime/ws/session-registry.ts` `SessionRegistry<S>`): new sid → create; known sid → reattach; reaps disconnected sessions after `graceMs`; sessions drop when `runPromise` settles; `shutdownAll()` on SIGINT/SIGTERM. `runId` carries a uuid suffix to avoid run-dir collisions.
- **Cap + FIFO queue** (`maxSessions` ← `MAX_SESSIONS`): at cap, new sids join `waiting[]`; `onQueued` → `queued` envelope (1-based position) → browser QueueWindow ("The Tavern Is Full"); admission is FIFO on slot free, no queue-jumping; a queued socket closing leaves the line immediately; same-sid reconnect while waiting keeps the position; reattaches to ACTIVE sessions always allowed (cap gates creation only).
- **Pressure reaping**: while anyone waits, disconnected sessions reap on `queueGraceMs` instead of `graceMs` (applied retroactively to running timers); an idle sweep additionally reaps CONNECTED sessions whose human is silent past `idlePressureMs` — need-based, longest-silent first, only as many as there are waiters. "Human activity" = envelopes only a person produces (`human_input`/`structured_action`/`skip_turn`/`hero_select_response`/`opening_ack`/`survey_response` stamp `WsAdapter.lastHumanActivityMs`); automatic traffic (roll_response, auto-acks) deliberately doesn't.
- **Ghost-tab defense**: once a page load has a session, reconnects carry `&reattach=1`; an unknown sid then gets `rejected: 'session_gone'` (not a fresh game) → ws-client stops reconnecting → "The Tale Has Moved On" window with a Reload button. Fresh page loads never carry the flag.
- **Game-START gates hold while detached**: the hero-select and opening gates are NOT resolved by `detach()` and PARK when no socket is attached; `attach()` re-sends the pending request (browser dedups same-requestId re-sends). A tab-less session parks silently at the gate — zero LLM — until reattach or reap. Mid-game gates (reveal/beat/rolls) keep flush-on-detach so a mid-game disconnect still advances to the human's turn.
- **Cost**: N parallel games multiply token spend N-fold.

### Survey + run-artifact persistence to GCS

- **Survey**: floating Survey button → modal (`web/components/SurveyModal.ts`) with the 5 teaming scores + effort/moment free text (instrument: `docs/tester-survey.md`; EN strings byte-identical to it). Submit → `survey_response` over WS (validated; routed side-channel via `WsAdapter.onSurvey`, submittable any time) → `persistSurvey` (`src/runtime/survey-store.ts`) writes `<runDir>/survey.json` AND uploads to the GCS bucket as `surveys/<runId>/<submittedAt>.json` (create-only; re-submits append) → `survey_ack {ok, destination}`. Cloud fails → local-only ok; both fail → modal steers to the clipboard Copy fallback. Auth is ADC (locally `gcloud auth application-default login`; on Render the `vertex-ai-user` SA, needs `roles/storage.objectCreator`). Lazy-imports `@google-cloud/storage` so tests/CI never load it. Stub/preview servers have no handler → `ok:false` by design.
- **Run archive** (`src/runtime/run-archive.ts`): when a session's `runPromise` settles, upload `events.jsonl` + `manifest.json` to `runs/<runId>/…`. Gated on `Orchestrator.gameStarted` (flips after BOTH game-start gates pass un-aborted; gate-less runs — CLI/scripted/AI-only — flip on the first loop iteration), so reaped parked sessions aren't archived. Failures log, never break teardown.

### Game language — EN / PT (per session)

The player picks EN/PT on the hero-select screen; one pick drives both the agents and the UI chrome. Key insight: most player-visible text is LLM-generated, so the agent side is a prompt DIRECTIVE, not a translation project.

- **Plumbing — GENERIC over language codes** (adding a language = extend `GAME_LANGUAGES` + web `UI_LANGUAGES`/`LANGUAGE_LABELS`/message table + content; zero schema/plumbing changes): `src/runtime/language.ts` (`GAME_LANGUAGES`, `NON_EN_LANGUAGES`, `Localized = string | ({en} & Record<lang, string>)`, `resolveLocalized` = plain key lookup with EN fallback) → `ScenarioSchema.language` (default `'en'`) → `PromptBuilder.setLanguage()` / `OrchestratorConfig.onLanguageSelected` (play.ts wires it). Every content schema (`scene.i18n`, `names` records) accepts ANY language key — content can ship a language before the code supports it. Manifest records the effective `language` (a Layer-D axis). Wire: `hero_select_response.language` (applied even if the hero id fails validation); `SurveySubmission.language` records which instrument wording the tester read.
- **Directive, not parallel prompts**: in `'pt'`, the system prompts inject an `IDIOMA — PORTUGUÊS (BRASIL)` block — all player-visible output in pt-BR, English source content translated on the fly, proper nouns + tool ids never translated. EN runs render byte-identical prompts. Cache-safe because the pick lands before the first LLM call (hero-select gate precedes everything).
- **Browser i18n** (`web/i18n.ts`): tiny `t(key, vars)` table, EN fallback, persists in localStorage `agents-rpg-lang`. Deliberately does NOT import server code — its language union mirrors `src/runtime/language.ts`; **keep them in sync**. All UI chrome + the full survey instrument are converted.
- **Scene prose overlay**: a scene may carry `i18n.<lang>` (`intro`/`conclusion`/`opening {before,after}` — `SceneI18nProseSchema` in `adventure.ts`, record keyed by language code); consumers select at render time via `sceneIntro`/`sceneConclusion`/`sceneOpeningText` (EN fallback; cast names must appear verbatim in each language's text for splash highlighting). The snapshot rides every declared variant (`scene.opening.i18n` record) so the browser picks client-side (`openingBefore`/`openingCast`). `basement-o-rats.json` has full pt overlays. `tactics`/ability-test prompts are deliberately untranslatable (LLM input only).
- **Creature display names**: engine/wire keep canonical English; `displayName` (`web/components/names.ts`) translates known creatures at the display boundary ("Giant Rat" → "Rato Gigante"). `monsterSayReadsAsNarration` also recognises pt articles + translated species.
- **Localized HERO names — engine-deep**: in a pt session the heroes ARE **Heitor (Gareth) / Caio (Kael) / Breno (Bran) / Iara (Elara)** — renamed in the ENGINE, not display-mapped, because the LLM narrates from engine names and a display map would desync narration from the board. Scenario blocks carry optional `names: { "<lang>": "…" }` records; play.ts builds `OrchestratorConfig.nameOverrides` (language → characterId → name); right after the hero-select gate (last point the language can change, still before any LLM call) `maybeApplyLocalizedNames` → `GameEngine.setNameOverrides` renames existing characters, remembers the map for later-materialized ones (the bound captive → Iara), and re-publishes per-viewer snapshots. Ids (`p1_warrior`), rules, and replay untouched. Cascade: `HeroChoice.names` (chooser cards), opening-cast `names` records (splash bold+avatar matching), `partyDescription` is `Localized` (one variant per language with overrides), pt prose/personas use the pt names, LANGUAGE directives say to use names exactly as game state shows.
- **Localized personas**: `.<lang>.md` sibling convention (`gareth-warrior.pt.md`; all 8 hand-translated for pt); `loadScenario` tries a sibling per `NON_EN_LANGUAGES` entry; persona fields are `Localized` and the PromptBuilder resolves by session language at build time (agents are constructed before the pick — late binding, same as the scene overlay). `promptHash` stays the hash of the ENGLISH text.
- **Deliberate gaps**: catalog ability/item names, CLI strings, engine-generated summaries (LLM input stays English; models reply in PT regardless).
- Still pending: a PT run against a real key to eyeball narration quality.

### Hero selection gate

Browser runs open with a pixel-art "Choose your hero" screen (Gareth warrior / Kael warlock / Bran hunter); the pick reroutes which `characterId` the orchestrator treats as human (`Orchestrator.humanCharacterId`, `awaitHeroSelectGate` — runs once before the opening splash). The scenario's `human` block takes an optional `persona` (`personas/bran-hunter.md`) so the un-picked default hero is AI-driven; the gate is offered only when that persona is present AND the run isn't `--human-script` automated (scripted/CLI/headless keep the scenario default). Wire: `hero_select_request/response` (`HeroChoice[]` cards); `HeroSelectProvider` implemented by WsAdapter; UI `web/components/HeroSelect.ts` — full-body portraits, Jersey-10 font, stat rows with hand-built `assets/ui/icon-*.svg` (16×16 rect-grid, `crispEdges`), no emoji, no prose.

### Basement O' Rats content

Chain: `tavern-basement → rat-tunnel → END` (the old `underground-choices`/`momentary-detour`/`rat-den` scenes were dropped; their `assets/maps/*` dirs remain unused on disk). Both scenes are shaped to **force teamwork**, not difficulty:

- **tavern-basement** (13×9): central barrel barricade splits the room into two lanes + scattered cover.
- **rat-tunnel** (15×11, the finale — no exit cell; `all-monsters-ko → END`): a carved cave (`map.wallCells` rock mask) split by a SOLID breach wall at x=6 — stalagmite obstacles (`durability: 2`) + a `rubble-pile` weak point (`durability: 1`) at (6,5) — fully separating the heroes (west tunnel mouth, seated via `map.entry`) from the king-rat + 3 giant rats arena (east). Through it: smash an obstacle (`attack_object`) or squeeze past via a DM-narrated ability test (narrative only).

Mechanisms introduced for it (all engine-validated, replay-safe):

- **Terrain**: `map.wallCells` → indestructible `rock` cells (block movement/LoS, NOT smashable — `attack_object` excludes rock); `map.obstacles[]` → destructible `wall` cells with `durability` (engine tracks `obstacleDurability`, reseeded per scene entry; resolutions carry `obstacleDamaged {pos,remaining,max}` / `obstacleDestroyed`; browser paints a crystal-shard durability bar, `MiniBar.ts`). Browser draws the cave outline via marching squares over the tileset's rock tiles (`chooseTileBox` in `TileMap.ts`).
- **Hero coordination**: the player state block renders every teammate's and foe's live HP/position/status/attack (PARTY + FOES, `state-block.ts`); `player-system.ts` has a `COORDINATE WITH YOUR PARTY` doctrine (engagement/Teamwork +1 die, focus-fire, cover, breach division-of-labor, covering the wounded) + a per-passive tip (`coordTipFor`); `map.entry: Square[]` seats heroes on fresh scene entry (`seatHeroesAtEntry`, sorted by id, collision-safe; immobilized heroes exempt).
- **Captive rescue — Elara** (`p3_healer`, healer, a 3rd AI ReACT teammate): starts the finale bound + **immobilized** at (11,8) beyond the breach (`map.captives[]` — `{archetype, characterId, name, startPos}`; `characterId` must match `agents.p3`). `immobilized` is a non-KO health status (targetable, takes damage, preserved by damage/heal; only lethal flips to KO). **`free_ally`** player action: adjacent hero rolls a check (pool vs DC 4) through the same physics dice; frees → status normal. `start_combat` auto-appends on-board immobilized heroes so Elara holds a turn slot from the start; while bound the orchestrator auto-skips her turn (no LLM call); once freed her `p3` agent acts. Bound visual: `assets/heroes/healer-bound/` sprite (manifest `healer-bound`), swapped by `resolveCharacterSprite`, frozen like a corpse; pops back on free.
- **Cheese bait**: `map.chests[]` (rat-tunnel: one at (3,3) containing `cheese`) materialize as chest props (`spriteId: 'chest'` → pixel sprite from `manifest.props`; other props/thrown cheese stay emoji). **`open_chest {chestId}`**: adjacent, roll-less, loots contents to inventory, removes the prop. **`throw_item {itemId, pos}`**: lob to an empty cell within range 4 (from inventory, or relocate a ground prop within 1 cell); thrown cheese becomes a `bait` prop (🧀). Monster AI prefers the nearest bait over heroes — but only if it can make progress this turn — and EATS it when ending a move on its cell (prop removed). AI-heroes-only for now (no human throw/open UI). Doctrine in `player-system.ts` ("BAIT THE RATS").
- **Round-gated monster focus**: `scene.monsterFocus {characterId, fromRound=1}` makes the planner fixate on one character from that combat round (rat-tunnel: Elara from round 2 — rescue pressure). `TurnTracker.roundNumber` (0 out of combat, 1 at start_combat, +1 per cursor wrap) gates it; invalid/KO'd target → normal targeting; an immobilized captive qualifies; **bait still out-prioritizes focus** (a lure can pull the pack off Elara). Note: focus persists after she's freed (literal "from round 2"); scope it to "while bound" in `monster-ai.ts` if that feels wrong.

## Gotchas

- **The live server serves `dist/web`** — web changes need `npm run build:web`. The server `readFileSync`s per request, so a browser refresh suffices; no server restart.
- **Thinking-summarizer leak guard**: the Anthropic API returns a *summary* of extended thinking that occasionally bleeds meta-commentary ("the next thinking chunk") into the `thought` channel. `src/runtime/llm/thinking-sanitizer.ts` truncates at the first marker; `anthropic.ts` drops blocks that sanitize to empty.
- **Gemini ≠ Anthropic thinking semantics**: Gemini thinks by default — disabling requires explicitly sending `thinkingBudget: 0`; Anthropic disables by omitting the block (its API minimum is 1024).
- **CSS `border-image` smooths pixel SVGs** into gradients; use fixed-size sprite backgrounds for pixel-crisp UI.
- Damage `state_change` events ALWAYS carry a `status` field (usually `'normal'`) — check for non-normal VALUES, not field presence.
- The HeroKids PDFs are 12–17MB; read with the `pages` parameter (max 20 pages per call).

## Open work

1. **Live smoke against real Sonnet** — the Layer-C done-signal:

   ```bash
   ANTHROPIC_API_KEY=… npm run play -- --browser scenarios/basement-o-rats.json \
     --human-script tests/fixtures/layer-c/human-bran-script.jsonl
   ```

   Pass: browser shows the art for both scenes; basement rats KO'd, breach opened, king rat + pack KO'd; `manifest.json` `cacheHitRatio > 0.30`; zero `rule_violation` entries in `events.jsonl`. (The deterministic suite + `ws-stub-adventure.test.ts` already pass — the smoke proves wire + Pixi + Sonnet end-to-end.) Also verify the Gemini cache-hit ratio on the next live Gemini run (escalation if low: explicit `CachedContent` + TTL).

2. **PT narration quality** — a `pt` run against a real key has not been eyeballed yet.

3. **Encounter-1 scripted-transcript fixture (Task 25)** — deferred until the live smoke produces a recordable run; unlocks a CI-runnable encounter-1 integration test.

4. **`bin/play.ts` hard-codes hero spawns** at `(0,0), (1,0), (0,1)` (top-left). Moving them to the bottom edge would better frame "descend into the basement" — out of scope for Layer C.

5. **Human-facing throw/open UI** for the cheese-bait actions (currently AI-heroes-only).

## What to do next

Layer D — evaluation. `/superpowers:brainstorming` referencing this CLAUDE.md, the parent spec, the Layer C spec/plan, and the live smoke artifacts. Scope per parent spec §7: metrics (event-log derived), LLM-as-judge for narrative quality, experiment matrix varying personas/models, notebook scaffold for the thesis writeup. Ready experiment axes already built: `monsterControl` deterministic vs `'dm'`, thinking-budget policy, game language, manifest `llmLatencyMs` + `wallMs` stamps.

## Notes for future sessions

- The `.superpowers/brainstorm/` directory holds throwaway brainstorm artifacts; safe to delete or leave.
- The user prefers committing to `main` for this solo academic project.

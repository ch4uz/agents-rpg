# Layer C — Visual Layer Design Spec

**Date:** 2026-05-09
**Status:** Approved (brainstorm)
**Owner:** Arthur Chau (Mestrado)
**Layer:** C — Visual layer (per project layering in `CLAUDE.md` and parent spec §10)
**Parent spec:** `docs/superpowers/specs/2026-05-08-agents-rpg-design.md`
**Predecessor specs:**
- `docs/superpowers/specs/2026-05-08-layer-b-agent-runtime-design.md` (Layer B — completed, 238 tests passing)
- `docs/superpowers/plans/2026-05-08-layer-b-agent-runtime.md`
- `docs/superpowers/plans/2026-05-09-layer-b-audit-fixes.md`

## 1. Goal and scope

Add the visual layer that turns the Layer B Node runtime into a browser-rendered HeroKids session: a Pixi.js board with real art, DOM hero cards, a chat log, and a free-text input — all driven by a WebSocket subscriber that mirrors the existing Layer B `Subscriber` bus. Close the multi-target special-action dispatch gap deferred from Layer B so warrior, hunter, and warlock are mechanically whole. Encode Basement O' Rats encounter 1 so a real adventure plays through the new visual stack against real Sonnet.

**End state.** Running `ANTHROPIC_API_KEY=… npm run play -- --browser scenarios/basement-o-rats.json --human-script tests/fixtures/layer-c/human-bran-script.jsonl` opens a browser, plays Basement O' Rats encounter 1 end-to-end (4 rats, the basement map, all three player heroes vs. real Sonnet DM and AI players), and exits with the manifest showing `cacheHitRatio > 0.3` and zero `rule_violation` log entries from engine misuse. The Ink CLI integration tests from Layer B still pass; both subscribers are first-class and selected by `--cli | --browser` on the `bin/play.ts` entry.

**In scope.**
- Multi-target special-action dispatch in `GameEngine.handleSpecialAction` for `whirlwind-attack`, `flame-burst`, `split-shot`, `pack-attack`. Closes the three `LAYER C TODO` markers in `src/engine/{game-engine,effects}.ts`.
- `params.diceSplit` field on the `special_action` tool schema, validated by the engine.
- `GameEngine.getRedactedSnapshot(viewer)` reusing the Layer B snapshot + visibility filter.
- `WsAdapter` — Subscriber + HumanInputProvider over WebSocket; handles snapshot-on-connect, event tail, lifecycle hooks, and `human_input` / `skip_turn` ingress.
- WS wire protocol (7 envelope kinds described in §5.3).
- Manifest validation at server boot. `assets/manifest.json` written; missing files → fatal startup error.
- Asset extraction (one-time): rename `archer.png` → `heroes/hunter.png`; move existing heroes into `heroes/`; crop `monsters/giant-rat.png`, `monsters/king-rat.png`, and `maps/tavern-basement.png` from the HeroKids PDFs. (Other Basement O' Rats maps are nice-to-have, not gating.)
- Browser bundle: Vite + Pixi.js + `lit-html`, layout v4 (1024 px max-width container; board left, three hero cards stacked right, chat full-width below, input below). WS client. Store mirroring Layer B's `cli-store`. `Board` renders scene background + tokens + roll overlay.
- `bin/play.ts` rewrite: `--cli | --browser` flag (default browser); when `--browser`, the same Node process serves the prebuilt static bundle over HTTP and accepts WS upgrades on the same port; spawns the user's default browser to the URL.
- `adventures/basement-o-rats.json` encoding **encounter 1** (the basement, 4 rats); `scenarios/basement-o-rats.json` referencing it. Encounters 2-5 are explicitly **not** gating.
- New tests: ~13 new test files (engine, ws, web, integration); browser-side store/board/cards tests under `vitest` jsdom env; one new headline WS integration test plus a scripted Basement-O'-Rats encounter-1 integration test.
- Manual live-smoke command (the done signal).

**Out of scope (explicit).**
- Eval metrics / LLM-as-judge / experiment matrix scripts (Layer D).
- Encounters 2-5 of Basement O' Rats (content work, not new code paths). Land as follow-up commits during Layer D prep.
- Multi-browser concurrent viewers. Single browser per run; second connection rejected with `{ kind: 'denied', reason: 'session_in_use' }`.
- Researcher-overlay UI / prompt inspection in browser (parent spec §9 — deferred).
- Adventure authoring tooling (still hand-edit JSON).
- Mid-run hot-reload of agent prompts.
- Resume-from-log after a crashed run.
- Streaming Anthropic tokens to the browser. The "thinking" indicator is binary.
- Pixel-art / 16-bit chrome retrofit. Boring CSS for the thesis; pixel-art is a post-thesis polish pass.
- Sprite licence laundering. HeroKids assets remain personal-use only; the repo stays private.

## 2. Locked decisions from this brainstorm

| # | Decision | Why |
|---|---|---|
| C-1 | **Done signal = browser plays Basement O' Rats encounter 1 end-to-end against real Sonnet, with art for the 4 heroes + 1 monster + 1 map.** | Smaller than encoding the full module; bigger than the Layer B stub. Catches asset / layout / encoding bugs the stub adventure can't, while keeping Layer C scoped to a thesis-fitting time budget. |
| C-2 | **Multi-target dispatch = hybrid.** Agent-driven dice split for `whirlwind-attack` / `split-shot` (`params.diceSplit: { [targetId]: dice }` validated to sum to the actor's relevant pool). Engine auto-enumerates targets for `flame-burst` (all adjacent characters) and `pack-attack` (single target with engaged-condition bonus). | Mirrors the HeroKids manual exactly: "split your dice" abilities give the player the choice; `flame-burst` and `pack-attack` are mechanical given a target. Two code paths but each is short, and the agent only chooses where the rules allow choice. |
| C-3 | **CLI is kept; `bin/play.ts` defaults to `--browser`.** | Layer B's Subscriber bus already supports multiple subscribers. Keeping `CliAdapter` lets CI run a real-orchestrator integration test without spawning a browser, gives a fast debugging path, and offers a fallback if the visual layer regresses during the Layer D matrix runs. |
| C-4 | **Reconnect = snapshot envelope + event tail.** Browser opens WS → server sends one `RedactedSnapshot` (current scene, characters, positions, HP, recent chat) → server then live-tails events. | Constant-time reconnect regardless of run length. The snapshot is a small extension of the Layer B `snapshotEngineState` + visibility filter — no new server-side state machine. |
| C-5 | **Asset extraction = manual crop, one-time, committed PNGs.** `pdftoppm` → Preview → save under `assets/{heroes,monsters,maps,items,equipment}/`. | Cheapest path to working art. Not reproducible from PDF, but the source PDF is frozen — re-extraction is a non-goal. An automated PDF→tile pipeline is a day of work for a one-time output. |
| C-6 | **Layout = v4 (board left, three hero cards stacked right, chat full-width below, input full-width below) inside a single 1024 px max-width centered container.** | Pixi board gets enough width (≈600 px) to look like more than the ASCII grid. Stacked hero cards have room for the full stat line (pools, equip, inventory, boons, special, bonus). Chat and input span the container width for legibility. The 1024 px cap keeps proportions stable on large monitors. |
| C-7 | **Browser stack = Vite + Pixi.js + `lit-html`.** No React, no Tailwind. State store is a single object mirroring Layer B's `cli-store`. | DOM panels are simple enough that React's runtime is unjustified weight. `lit-html` is ~3 kB and gives templating without a framework. Vite handles dev server / HMR / production bundling. |
| C-8 | **Wire protocol = JSON envelopes, one envelope per Subscriber callback. `RedactedEvent` is a direct passthrough.** No separate "render directives." | The redacted event stream is already the right abstraction for rendering — the Ink CLI proves this. One protocol surface to test. |
| C-9 | **`thinking` / `thinking_done` envelopes are UI signals, NOT events in `events.jsonl`.** Fired by the orchestrator around in-flight LLM calls, only over WS. | Keeps the event log clean (replay invariant unchanged). Browser shows "Bran is thinking…" without polluting the source-of-truth log. |
| C-10 | **No fallback rendering for missing assets.** Manifest validation at server boot fails the run if any referenced asset is missing. | Parent spec §8's "colored circle fallback" is dev-only convenience that breeds silent regressions. Boot-time validation makes the failure loud and immediate. |
| C-11 | **No streaming-token UX.** Binary "thinking" indicator only. | Streaming would require Anthropic SDK changes and adds UX complexity for a thesis tool. The 1-3 min combat round is a known property of the experiment. |

## 3. Build order

Each step compiles and tests pass before the next starts. Items 1-2 are pure engine work and unblock everything else.

1. **Multi-target dispatch in `handleSpecialAction`** plus a new `isEngaged(target, attackerTeam)` helper. Real handlers for `whirlwind-attack`, `flame-burst`, `split-shot`, `pack-attack`. Tool schema gains optional `params.diceSplit`. Engine validates split-sum and target adjacency/range. The `isEngaged` helper is wired into `resolveAttack` so the existing `teamwork` bonus-passive (which consumes `params.targetEngaged`) actually triggers when a hero attacks an engaged target. Removes the three `LAYER C TODO` markers. Tests in `tests/engine/special-actions.test.ts`, `special-actions-validation.test.ts`, and `engaged.test.ts`.
2. **`getRedactedSnapshot(viewer)`** on `GameEngine`. Reuses Layer B's `snapshotEngineState` and visibility filter. Pure engine method. Test in `tests/engine/snapshot-redacted.test.ts`.
3. **Asset extraction.** `pdftoppm` to dump pages, manual crop in Preview, save under `assets/{heroes,monsters,maps}/`. Rename `assets/archer.png` → `assets/heroes/hunter.png`. Move existing heroes into `heroes/`. Write `assets/manifest.json`. One commit, named.
4. **Manifest validator.** Tiny utility: read `manifest.json`, check every file exists, throw on missing. Wired into server boot (next step). Unit test with a fixture manifest pointing at synthetic files.
5. **`WsAdapter` (Subscriber + HumanInputProvider) and protocol module.** `src/runtime/ws/{adapter.ts, protocol.ts}`. Wire protocol envelopes, encode/decode helpers, in-process WS pair tests. `WsAdapter.requestInput()` returns a `Promise<string>` resolved by the next `human_input` / `skip_turn` envelope.
6. **WS server boot module.** `src/runtime/ws/server.ts` — HTTP static handler for `dist/web/`, WS upgrade on the same port, manifest validation on boot, single-active-client enforcement. Tested with an in-process WS client connecting to a real server on a random port.
7. **Browser scaffolding.** `web/` directory; Vite config; `web/index.html`; `web/main.ts`; `web/ws-client.ts`; `web/store.ts`. Layout v4 in plain HTML/CSS (no Pixi yet). Hero cards rendered via `lit-html`. WS connect → snapshot apply → event tail. Tests for the store under jsdom.
8. **Pixi `Board`.** Mounts inside the container's board area; renders scene background by manifest id; draws tokens at `(x*64, y*64)`; updates on `position_changed`, `character_revealed`, `damage_taken`. `roundPixels: true` for crisp tokens. Test what would be drawn (token positions per snapshot), not pixel output.
9. **Roll overlay + active-actor highlight.** Pixi animation on `resolution` events (HIT/MISS flash for ~1.5 s). Active hero card border swap (yellow) on `turn_started` matching the actor; restore on `turn_ended`.
10. **`bin/play.ts` rewrite.** `--cli | --browser` (default browser). When `--browser`: spin up the WS server, open the user's default browser. Vite dev mode proxies WS through to the Node server; production serves prebuilt `dist/web/`.
11. **Adventure encoding.** `adventures/basement-o-rats.json` for encounter 1 (4 giant rats, 5×8 basement grid, scene id `tavern-basement`, conclusion text). `scenarios/basement-o-rats.json` referencing the adventure plus the existing personas. Schema fits the Layer A adventure loader unchanged.
12. **Headline integration tests.** `tests/integration/ws-stub-adventure.test.ts` exercises the orchestrator over the WS path with the existing Layer B stub adventure. `tests/integration/basement-o-rats-encounter-1.test.ts` runs encounter 1 against a `ScriptedLlmClient` recorded transcript and asserts combat resolves with rats KO'd.
13. **Manual live smoke** — the done-signal run. Plays encounter 1 against real Sonnet through the browser, asserts the success criteria from §1.

## 4. File layout

```
src/
  engine/
    game-engine.ts                     (modify — Step 1)
    effects.ts                         (modify — Step 1)
    snapshot.ts                        (NEW — Step 2; getRedactedSnapshot lives here, called from GameEngine)
  runtime/
    subscriber.ts                      (existing — unchanged)
    cli/                               (existing — unchanged; tests stay green)
    prompt/
      tools.ts                         (modify — Step 1; special_action.params.diceSplit)
    ws/                                (NEW)
      adapter.ts                       (Step 5; Subscriber + HumanInputProvider)
      protocol.ts                      (Step 5; envelope types + codecs)
      server.ts                        (Step 6; HTTP static + WS upgrade + manifest validation + single-client guard)
      manifest.ts                      (Step 4; validator)

web/                                   (NEW — Vite project root)
  index.html                           (Step 7)
  main.ts                              (Step 7; wires store + ws-client + components)
  store.ts                             (Step 7; mirrors cli-store shape)
  ws-client.ts                         (Step 7)
  components/
    Layout.ts                          (Step 7; lit-html, v4 grid)
    HeroCard.ts                        (Step 7; lit-html)
    ChatLog.ts                         (Step 7; lit-html)
    InputBox.ts                        (Step 7; lit-html)
    Board.ts                           (Step 8; Pixi)
    RollOverlay.ts                     (Step 9; Pixi)
  styles/main.css                      (Step 7)

assets/                                (extended in Step 3)
  manifest.json                        (NEW)
  heroes/
    warrior.png                        (moved from assets/warrior.png)
    hunter.png                         (renamed from assets/archer.png)
    healer.png                         (moved from assets/healer.png)
    warlock.png                        (moved from assets/warlock.png)
  monsters/
    giant-rat.png                      (NEW — extracted from PDF)
    king-rat.png                       (NEW — extracted; for encounter 5, but cropped now)
  maps/
    tavern-basement.png                (NEW — required for done signal)
    rat-tunnel.png                     (NEW — encounter 2; nice-to-have)
    underground-choices.png            (NEW — encounter 3)
    momentary-detour.png               (NEW — encounter 4)
    rat-den.png                        (NEW — encounter 5)
  world.png                            (existing — unchanged)

adventures/
  basement-o-rats.json                 (NEW — Step 11; encounter 1 required, others if time)
  stub-layer-b.json                    (existing)
  stub-one-scene.json                  (existing)

scenarios/
  basement-o-rats.json                 (NEW — Step 11)
  baseline.json                        (existing)

bin/
  play.ts                              (modify — Step 10; --cli | --browser flag)

vite.config.ts                         (NEW — Step 7)
package.json                           (modify — Step 7; add web build scripts, deps: pixi.js, lit-html, vite)

tests/
  engine/
    special-actions.test.ts            (NEW — Step 1; happy-path multi-target dispatch)
    special-actions-validation.test.ts (NEW — Step 1; rule-violation cases)
    engaged.test.ts                    (NEW — Step 1; isEngaged helper + teamwork wiring)
    snapshot-redacted.test.ts          (NEW — Step 2)
  runtime/
    ws/
      protocol.test.ts                 (NEW — Step 5)
      ws-adapter.test.ts               (NEW — Step 5)
      reconnect.test.ts                (NEW — Step 6)
      manifest.test.ts                 (NEW — Step 4)
  web/
    store.test.ts                      (NEW — Step 7; jsdom)
    cards.test.ts                      (NEW — Step 7; jsdom + lit-html)
    board.test.ts                      (NEW — Step 8; data-layer assertions, no pixel output)
  integration/
    ws-stub-adventure.test.ts          (NEW — Step 12)
    basement-o-rats-encounter-1.test.ts (NEW — Step 12)
  fixtures/
    layer-c/
      human-bran-script.jsonl          (NEW — Step 13; live smoke human script)
      basement-o-rats-encounter-1-transcript.jsonl (NEW — Step 12; ScriptedLlmClient input)
```

## 5. Architecture

### 5.1 Multi-target special-action dispatch

`GameEngine.handleSpecialAction` is rewritten to dispatch per `effectId`:

```ts
private handleSpecialAction(actorId, action, opts?) {
  if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
  const actor = this.characters.get(actorId)!;
  const effectId = actor.specialAction.effectId;

  switch (effectId) {
    case 'whirlwind-attack':  return this.dispatchSplitMelee(actor, action);
    case 'split-shot':        return this.dispatchSplitRanged(actor, action);
    case 'flame-burst':       return this.dispatchFlameBurst(actor);
    case 'pack-attack':       return this.dispatchPackAttack(actor, action);
    case 'healing-touch':     return this.dispatchSingleEffect(actor, action);
    /* future single-target effects continue routing through the registry */
    default:                  return this.dispatchSingleEffect(actor, action);
  }
}
```

**`dispatchSplitMelee` (whirlwind-attack).**

Inputs: `action.targetIds: CharacterId[]`, `action.params.diceSplit: { [id]: number }`. Validates:
- Every `targetIds[i]` is alive, adjacent (Chebyshev-1), and on the opposite team.
- `diceSplit` keys exactly match `targetIds`.
- `Σ diceSplit[id] === actor.pools.melee` and each value `≥ 1`.

For each target, run `resolveAttack` with a per-target overridden melee pool of `diceSplit[id]`, then apply each `EffectChange`. Emit one `action` event plus one `resolution` event per target. `turn.markActed()` once at the end.

**`dispatchSplitRanged` (split-shot).** Same as melee but uses `actor.pools.ranged`, `range ≤ 6` (Chebyshev), and line-of-sight (already implemented on the engine via `Map.hasLineOfSight`).

**`dispatchFlameBurst` (warlock).** Engine auto-enumerates all characters adjacent to actor (allies *and* enemies, excluding self and KO'd). One 1-die magic attack per target. `action.targetIds` is ignored if provided; the agent's tool schema for flame-burst will not require it.

**`dispatchPackAttack` (giant-rat).** Single-target (`action.targetIds[0]`). Adjacency check. The "engaged" condition is *new* in Layer C: a small helper `isEngaged(target, attackerTeam): boolean` returns `true` iff the target is adjacent to ≥ 2 characters from the attacker's team (including the attacker itself). When engaged, attack rolls `actor.pools.melee + 1` dice. The same helper closes a latent gap in Layer B's `teamwork` bonus passive (the registry already consumes a `params.targetEngaged` boolean but no caller ever computes it); Layer C wires the helper into `resolveAttack` so `teamwork` actually triggers when a hero attacks an engaged target.

**Tool schema.** `src/runtime/prompt/tools.ts`'s `special_action` tool gets:
- `targetIds`: required for `whirlwind`, `split-shot`, `pack-attack`; ignored/empty for `flame-burst`.
- `params.diceSplit`: required object for `whirlwind` and `split-shot`; absent for `flame-burst` and `pack-attack`. Validation lives in the engine, not the schema, so a malformed split returns a `rule_violation` (Layer B audit-fix F16) the agent can retry.

### 5.2 Redacted snapshot

```ts
interface RedactedSnapshot {
  runId: string;
  viewer: Viewer;
  scene: { id: string; assetId: string; gridW: number; gridH: number } | null;
  characters: Array<{
    id: CharacterId;
    name: string;
    kind: 'hero' | 'monster';
    archetype?: string;
    sprite: string;
    pos: { x: number; y: number } | null;
    health: { total: number; damage: number; status: 'normal'|'prone'|'KO' };
    pools: { melee: number; ranged: number; magic: number; armor: number };
    equipped?: EquipmentId;
    inventory: ItemStack[];
    boons: BoonId[];
    specialAction: { name: string; description: string };
    bonusAbility:  { name: string; description: string };
  }>;
  activeActor: CharacterId | 'dm' | null;
  recentChat: RedactedEvent[];        // last 30 events through the visibility filter
  ended?: { outcome: 'success' | 'failure' | 'aborted' };
}
```

`getRedactedSnapshot(viewer)`:
1. Calls `snapshotEngineState()` (Layer B).
2. Filters `characters` through the same visibility predicate the orchestrator uses for events: monsters are excluded if neither revealed via `reveal_monster` nor in line-of-sight of any of the viewer's allies; KO'd monsters keep their position but redact stats.
3. Pulls the last 30 redacted events from the in-memory ring buffer the orchestrator already maintains (Layer B's chat backfill).
4. Returns a plain JSON-serializable object.

### 5.3 Wire protocol (server → browser)

```ts
type ServerEnvelope =
  | { kind: 'snapshot'; viewer: Viewer; manifest: AssetManifest; state: RedactedSnapshot }
  | { kind: 'event'; event: RedactedEvent }
  | { kind: 'turn_started'; actorId: CharacterId | 'dm' }
  | { kind: 'turn_ended';   actorId: CharacterId | 'dm' }
  | { kind: 'thinking';      actorId: CharacterId | 'dm' }
  | { kind: 'thinking_done'; actorId: CharacterId | 'dm' }
  | { kind: 'end'; outcome: 'success' | 'failure' | 'aborted' }
  | { kind: 'rejected'; reason: 'not_your_turn' | 'session_in_use' | 'invalid_envelope' };
```

`snapshot` is sent once per (re)connect, before any other envelope. It includes the asset manifest so the browser doesn't need a separate fetch. After `snapshot`, the WS server live-tails Subscriber callbacks: each `onEvent` → one `event` envelope, each `onTurnStarted` → one `turn_started`, etc. `thinking` / `thinking_done` are emitted by the orchestrator immediately around each LLM call (existing Layer B seam: `LlmClient.complete` is wrapped to emit on entry/exit).

### 5.4 Wire protocol (browser → server)

```ts
type ClientEnvelope =
  | { kind: 'human_input'; text: string }
  | { kind: 'skip_turn' };
```

The server validates the envelope and routes to `WsAdapter.requestInput()`'s pending promise. If no pending request exists (not the human's turn), the server sends `{ kind: 'rejected', reason: 'not_your_turn' }` and ignores the message. Unknown `kind` → `{ kind: 'rejected', reason: 'invalid_envelope' }`. The InputBox is also disabled in the UI when it is not the human's turn — the server reject is belt-and-braces.

### 5.5 WsAdapter

Implements both `Subscriber` and `HumanInputProvider`:

```ts
class WsAdapter implements Subscriber, HumanInputProvider {
  readonly viewer: Viewer;
  private ws: WebSocket | null = null;
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;

  attach(ws: WebSocket) { … sends snapshot … wires .on('message') … }
  detach() { … }
  send(envelope: ServerEnvelope) { if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(envelope)) }

  /* Subscriber */
  onStart() { /* no-op until first attach */ }
  onEvent(event)     { this.send({ kind: 'event', event }) }
  onTurnStarted(id)  { this.send({ kind: 'turn_started', actorId: id }) }
  onTurnEnded(id)    { this.send({ kind: 'turn_ended', actorId: id }) }
  onEnd(outcome)     { this.send({ kind: 'end', outcome }) }

  /* HumanInputProvider */
  requestInput(): Promise<string> {
    if (this.pending) throw new Error('one pending request at a time');
    return new Promise((resolve, reject) => { this.pending = { resolve, reject } });
  }

  /* internal */
  private onClientMessage(raw: string) {
    const env = parseClientEnvelope(raw);
    if (!env) return this.send({ kind: 'rejected', reason: 'invalid_envelope' });
    if (env.kind === 'human_input' || env.kind === 'skip_turn') {
      if (!this.pending) return this.send({ kind: 'rejected', reason: 'not_your_turn' });
      const text = env.kind === 'skip_turn' ? '/skip' : env.text;
      const p = this.pending; this.pending = null; p.resolve(text);
    }
  }
}
```

The `/skip` text is the existing slash-command shorthand from Layer B's `slash-parser`, so the human-turn path through the orchestrator is identical for CLI and browser. No new code in the orchestrator.

### 5.6 Server packaging

`src/runtime/ws/server.ts`:

1. Validates `assets/manifest.json` (every referenced file resolvable on disk). Fails fast.
2. Boots an `http.Server`. `GET /` and `GET /<asset path>` serve from `dist/web/` and `assets/` respectively (one static handler with two roots).
3. `ws.Server` attached to the same port (HTTP upgrade).
4. On WS connect: if a client is already attached, send `{ kind: 'rejected', reason: 'session_in_use' }` and close. Otherwise call `WsAdapter.attach(socket)`.
5. On WS close: `WsAdapter.detach()`. Orchestrator continues; `WsAdapter.send` no-ops until reattach.

`bin/play.ts`:

```bash
npm run play -- --browser scenarios/basement-o-rats.json    # (default)
npm run play -- --cli scenarios/basement-o-rats.json        # legacy Ink path
npm run play -- --browser scenarios/x.json --human-script tests/fixtures/.../*.jsonl
```

In `--browser` mode, `bin/play.ts` runs `npm run build:web` if `dist/web/` is missing, boots the WS server, and opens the user's default browser via the `open` package. Dev mode (`npm run dev:web`) runs Vite on its own port with `server.proxy` forwarding `/ws` to the Node server.

### 5.7 Browser

`web/main.ts` wires three things:
1. `WsClient` — plain WS wrapper, parses envelopes, dispatches into the store.
2. `Store` — single mutable object mirroring Layer B's `cli-store` shape (scene, characters, activeActor, chat[], inputUnlocked, ended, plus a `thinking: Set<CharacterId | 'dm'>` field new to Layer C). Subscribers are called on every mutation.
3. `Components` — `Layout` wraps everything; `HeroCard`, `ChatLog`, `InputBox` are `lit-html` templates re-rendered on store change; `Board` is a Pixi `Application` mounted into the layout's board slot, subscribing to the store directly for token positions and roll overlays.

**Token positions.** Map `pos.{x,y}` → Pixi pixel coordinates `(x*64, y*64)`. Hero portraits are taller than 64 px; render at native aspect, anchor bottom-center to the cell. Token sprite picks come from `manifest[character.sprite]`.

**Roll overlay.** On `resolution` events, `RollOverlay` flashes "HIT 5 vs 3" (green) or "MISS 2 vs 4" (red) at the resolving character's token center, fades after 1.5 s.

**Active-actor highlight.** `HeroCard` template applies `border: 2px solid #ffd966` and a `.active` class when `store.activeActor === card.id`.

**Thinking indicator.** When the store's `thinking` set contains a hero id, that hero's card shows a "thinking…" badge. When it contains `'dm'`, a small banner above the chat log shows "DM is thinking…". Cleared on `thinking_done`.

### 5.8 Asset manifest

`assets/manifest.json` is a flat JSON object grouping ids by category:

```json
{
  "heroes":    { "warrior": "heroes/warrior.png", "hunter": "heroes/hunter.png", "healer": "heroes/healer.png", "warlock": "heroes/warlock.png" },
  "monsters":  { "giant-rat": "monsters/giant-rat.png", "king-rat": "monsters/king-rat.png" },
  "maps":      { "tavern-basement": "maps/tavern-basement.png", "rat-tunnel": "maps/rat-tunnel.png", "underground-choices": "maps/underground-choices.png", "momentary-detour": "maps/momentary-detour.png", "rat-den": "maps/rat-den.png" },
  "items":     {},
  "equipment": {},
  "boons":     {}
}
```

`items`, `equipment`, `boons` are empty for v1 — items are rendered as text in the hero cards (see layout v4 mockup: "Bag: 🧪×2 🍞×1"). Adding sprites later is a manifest-only change.

The validator runs at server boot. Maps that aren't yet cropped (encounters 2-5) are listed as optional in a `manifestSchema` test fixture; the production manifest only includes paths that resolve. Encoding encounters 2-5 later updates the manifest in lockstep with the cropped PNG.

### 5.9 Adventure encoding (encounter 1)

`adventures/basement-o-rats.json` follows the Layer A adventure schema. Encounter 1 specifically:

- `scenes[0]`: `id = "tavern-basement"`, `background = "tavern-basement"`, grid 5×8, hero spawn cells, 4 `monsterStub` entries with `spec = "giant-rat"` and stand-in cells from the adventure PDF p.13.
- Conclusion text from the PDF.
- The DM persona's `start_combat` at scene entry kicks the engine into combat mode.

Encounters 2-5 are sketched in the same file but flagged `"draft": true`. The adventure loader skips draft scenes. Including the sketch lets a later commit promote them without restructuring.

## 6. Test plan

### 6.1 Unit + integration tests (CI)

| Test | Asserts |
|---|---|
| `tests/engine/special-actions.test.ts` | Whirlwind splits dice across two adjacent rats per `params.diceSplit`; flame-burst hits all adjacent characters incl. one ally; split-shot succeeds at range 6, fails at range 7; pack-attack +1 die when target is engaged. |
| `tests/engine/special-actions-validation.test.ts` | Rule violations: `Σ diceSplit ≠ pool` → `invalid-split-sum`; non-adjacent target for whirlwind → `target-not-adjacent`; ranged target out of range for split-shot → `target-out-of-range`; empty `targetIds` for whirlwind → `targets-required`. |
| `tests/engine/engaged.test.ts` | `isEngaged(target, attackerTeam)` returns true iff ≥ 2 attacker-team characters adjacent (including attacker); teamwork bonus actually applies +1 die when a hero attacks an engaged target; pack-attack +1 die path ties to the same helper. |
| `tests/engine/snapshot-redacted.test.ts` | Unrevealed monster excluded from snapshot; revealed-then-KO'd monster keeps position but redacted stats; recentChat reflects last 30 events through visibility filter for `viewer = humanId`. |
| `tests/runtime/ws/manifest.test.ts` | Validator passes for a synthetic manifest with all files present; throws with the missing path on a single missing file. |
| `tests/runtime/ws/protocol.test.ts` | All 7 server envelopes encode/decode roundtrip; client envelopes parse correctly; malformed input rejected with the right error. |
| `tests/runtime/ws/ws-adapter.test.ts` | `WsAdapter` emits envelopes for every Subscriber callback in order; `requestInput()` resolves on `human_input`; resolves to `/skip` on `skip_turn`; rejects with `not_your_turn` when no pending request. In-process WS pair, no real socket. |
| `tests/runtime/ws/reconnect.test.ts` | Mid-run reconnect: orchestrator paused mid-combat, second client connects, receives a snapshot reflecting current state (active actor, HP, chat tail), then resumes event stream. |
| `tests/web/store.test.ts` | Store applies a snapshot envelope, then a sequence of events; final state matches a known-good fixture. (jsdom env, no Pixi.) |
| `tests/web/cards.test.ts` | `HeroCard` template renders pools, equipment, inventory counts, special-action name, bonus-ability name; toggles `.active` on `turn_started` for that hero's id. (jsdom + lit-html.) |
| `tests/web/board.test.ts` | Given a snapshot, `Board.computeTokenPositions(snapshot)` returns the expected `(x*64, y*64)` map; on `position_changed`, the affected token's position updates. Tests the data layer, not pixels. |
| `tests/integration/ws-stub-adventure.test.ts` | Orchestrator with `WsAdapter` + scripted in-process WS client runs through `adventures/stub-layer-b.json` end-to-end. Same assertions as the Ink integration test, just over the WS path. |
| `tests/integration/basement-o-rats-encounter-1.test.ts` | Encounter 1 against `ScriptedLlmClient` recorded transcript ends with all rats KO'd, no rule violations, all heroes alive (or one KO'd if the recording exercises that path). |

### 6.2 Headline integration test

`tests/integration/ws-stub-adventure.test.ts` is the Layer C analogue of Layer B's headline test. It pins:

1. `WsAdapter.attach(ws)` sends a `snapshot` envelope first, with the manifest, viewer, and current state.
2. The orchestrator's normal turn loop drives `event` / `turn_started` / `turn_ended` envelopes in the same order and shape as the Ink CLI receives them.
3. A scripted `human_input` envelope from the in-process WS client unblocks the human's turn.
4. The run reaches `combat_ended` and emits an `end` envelope with `outcome: 'success'`.

### 6.3 Manual live smoke (the done signal)

```bash
ANTHROPIC_API_KEY=… npm run play -- --browser scenarios/basement-o-rats.json \
  --human-script tests/fixtures/layer-c/human-bran-script.jsonl
```

Pass criteria:
- Browser opens, layout v4 visible with cropped art for all 4 heroes + 1 giant-rat token + tavern-basement background.
- Combat resolves; all rats reach KO; conclusion narration appears in chat.
- Manifest at run end shows `cacheHitRatio > 0.3`.
- `events.jsonl` contains zero `rule_violation` entries (i.e., no engine misuse from the new multi-target schema).
- Run exits cleanly with `outcome: 'success'`.

### 6.4 What's NOT tested in Layer C

- Multi-browser concurrent viewers (single-viewer is the v1 promise).
- Pixi pixel-level rendering correctness (we test what *would* be drawn, not pixel output).
- Encounters 2-5 of Basement O' Rats (content; no new code paths).
- Researcher-overlay UI / prompt inspection in browser (deferred per parent §9).
- Mid-run prompt hot-reload.

## 7. "Done" signal for Layer C

Layer C is complete when all of the following hold:

1. `npm test` is green; net new tests are ~10 files covering the surface in §6.1.
2. `npm run typecheck` is clean.
3. `npm run lint` is clean.
4. The headline integration test (§6.2) passes.
5. **Manual live smoke** (§6.3) succeeds.
6. The three `LAYER C TODO` markers in `src/engine/{game-engine,effects}.ts` are removed.

Item 5 is the only check the suite can't perform automatically. It proves the WS server, browser bundle, asset manifest, Pixi rendering, and the multi-target dispatch all work together against real Sonnet. Run it before declaring Layer C done.

## 8. Risks and tradeoffs worth flagging

- **Pixi-in-vitest is fiddly.** Pixi's WebGL renderer doesn't run cleanly under jsdom. Mitigation: browser tests assert the *data layer* (token-position math, store transitions, lit-html templates), not pixel output. Pixi rendering is exercised only via the manual live smoke. If even canvas-mode breaks, fall back to `Board.computeTokenPositions` as the test surface — what would be drawn rather than what is drawn.
- **HeroKids licence is personal-use only.** Cropped sprites and maps go into `assets/` and into git. This repo must remain private. Any thesis screenshots reproduce HeroKids art and require explicit citation in the writeup. (Saved as a project memory.)
- **`WsAdapter` blocking-input semantics.** `requestInput()` returns a Promise resolved by the next `human_input` / `skip_turn` envelope. Single pending request at a time (single human, single turn). Test this explicitly — a regression here would deadlock the orchestrator.
- **Vite dev vs. production same-port story.** Vite dev server on its own port, proxying WS through `server.proxy`. Production: Node serves the prebuilt static bundle on the same port as WS. Two paths, both well-documented; they don't overlap at runtime.
- **No streaming token UX.** "Bran is thinking…" is binary. If a 1-3 min DM turn feels too quiet during the live smoke, that's a Layer D UX concern, not Layer C scope.
- **Single-browser session.** Second WS connection rejected with `session_in_use`. If the human refreshes the tab mid-run, the old socket dies first (server detects close, frees the slot), so the refreshed tab reconnects cleanly. Race window is small but real; documented for future Layer D widening.
- **Manifest binary commits.** Total weight ~2-5 MB. Commit cropped PNGs in one named commit, not scattered. Encounters 2-5 maps are nice-to-have; if cropping them takes too long, ship Layer C with only `tavern-basement.png` in the manifest.

## 9. Open questions deferred to plan phase

- **Vite dev-server port + proxy config specifics.** Whether the Node server runs on a fixed port (e.g. 5173 production / 5174 dev) or auto-picks. Plan-phase decides.
- **Browser-spawn package.** `open` is the obvious choice but pulls a small dep tree. Plan-phase confirms or rolls a 10-line `child_process.exec` per platform.
- **Whether to render KO'd hero portraits greyscale on the token.** Cosmetic; nice in CLI parity (hearts go to 🤍). Defer to plan unless trivial.
- **Scene transitions in the browser.** Encounter 1 is a single scene. The full module has scene changes. Layer C ships single-scene only; multi-scene transitions in Pixi are a Layer-D-or-later concern even if the engine supports them already.
- **Where the Vite build artefact lives in CI.** `dist/web/` is gitignored; CI builds it on demand. Plan-phase wires this into the `npm test` flow if any test depends on it.

## 10. What to do next

Plan-phase: `/superpowers:writing-plans` referencing this spec, the parent spec, the Layer B plan + audit-fixes plan, and `CLAUDE.md`. Implementation order roughly tracks §3 with 13 tasks; the first 2 close engine debt, the next 2 are asset/manifest grunt work, then 5-9 build the WS + browser stack, 10 swaps `bin/play.ts`, 11 encodes the adventure, and 12-13 are the verification gates.

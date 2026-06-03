# Agents TTRPG — Design Spec

**Date:** 2026-05-08
**Status:** Approved (brainstorm)
**Owner:** Arthur Chau (Mestrado)
**Source of intent:** `instructions.md`
**Game system:** HeroKids (manual + Basement O' Rats adventure in `herokids/`)

## 1. Research focus and locked decisions

**Research question.** Multi-agent collaboration with a human teammate. Specifically: how do two AI players coordinate with each other and adapt to a human teammate when each has distinct mechanical role and persona, and when private reasoning is not shared?

**Locked decisions from brainstorm:**

| # | Decision | Why |
|---|---|---|
| 1 | Run scope = one full HeroKids adventure (Basement O' Rats end-to-end). | Enough surface for coordination patterns to emerge across exploration, social, and combat phases. |
| 2 | Agent variety = distinct HeroKids characters + distinct personas. | Mechanical differentiation drives natural specialization; persona separates the social-coordination question from the role-coordination question. |
| 3 | Visibility = public actions and dialogue only; Thoughts are private. | Same information channel as the human player. Forces real communication; preserves the question being studied. |
| 4 | Rules engine = deterministic code; LLM DM only narrates and adjudicates fuzzy cases. | Reproducible runs are non-negotiable for thesis comparison. LLMs cannot corrupt rule state. |
| 5 | Stack = TypeScript everywhere (Node + browser); custom ReACT (no LangGraph/AutoGen). | Single language, single process, full prompt control for direct ReACT study. |
| 6 | Human input = free-text natural language, mediated by the DM agent. | Authentic TTRPG experience; preserves the asymmetry between humans (free form) and agents (structured tool calls). |
| 7 | Architecture = thin Node orchestrator + Pixi.js browser; append-only event log. | Optimized for observability (the thesis instrument) and demo polish. |
| 8 | LLM = Anthropic Claude (Sonnet default); single `LlmClient` interface allows later swap. | Available, capable, prompt caching keeps cost manageable. |
| 9 | Prompt caching enabled from day one; `cacheHitRatio` tracked in run manifest. | History grows monotonically; without caching, per-turn cost is unsustainable by hour 2. |
| 10 | Human turn behaviour: DM blocks indefinitely; human has explicit `skip_turn` button. | No artificial timeout; the human can always pass. |
| 11 | v1 archetype scope = warrior, hunter, healer, warlock (matches existing sprites in `assets/`). | Adding more archetypes later is a sprite + stat-block drop-in; no engine changes. |
| 12 | All four HeroKids item categories modelled: consumable items, utility items, equipment (one slot), boons (off-turn). | The Basement O' Rats adventure barely uses gear, but later adventures do; the schema supports the whole ruleset upfront. |
| 13 | Sprites & map backgrounds extracted from the HeroKids PDFs (manual pp. 32-44, adventure pp. 13-18) under their personal-use license. | Authentic visual identity; faster than commissioning art. Academic context makes this acceptable. |
| 14 | Two-channel rendering: humans see a rendered view (ASCII grid in CLI / Pixi board in browser), LLMs receive structured JSON state in their prompts. The "view adapter" is the only piece that differs between CLI and browser. | LLMs reason better over structured state than over rendered art. Keeps engine and agents identical across Layer B (CLI) and Layer C (browser). Lets the thesis vary "agents given grid ASCII vs JSON state" as an experimental condition without touching engine code. |

**Out of scope for this design (explicit):**

- Multi-session campaigns with persistent state across sittings.
- Distributed agent processes; everything runs in one Node process.
- Mobile / non-desktop browser support.
- Adventure authoring UI (v1 authors adventures by hand-editing JSON).
- Provider abstraction across non-Claude LLMs in v1 (interface exists, but no second provider is implemented).
- Hero-creation UI; pre-built characters only in v1.
- Overworld / Brecken Vale traversal (the `assets/world.png` is reserved for future scope).

## 2. Architecture overview

A single Node process owns everything authoritative: the deterministic game engine, the agent orchestrator, the event log, and the WebSocket server. The browser is a thin view over Pixi.js plus DOM panels; it subscribes to events and only sends the human's free-text or `skip_turn` back.

```
┌─ BROWSER ────────────────┐                ┌─ NODE SERVER ───────────────────────┐
│ Pixi.js board            │  WebSocket     │ GameEngine     EventLog             │
│ Chat / log               │ ◄──────────►  │ Orchestrator                         │
│ Character panels (×3)    │  events ↓     │ ┌─ Agent: DM ──┐                     │
│ Human input box          │  human text ↑ │ ├─ Agent: P1 ──┤  ← Anthropic API   │
└──────────────────────────┘               │ └─ Agent: P2 ──┘                     │
                                            │ WsServer                             │
                                            └──────────────────────────────────────┘
                                                      │
                                                      ▼
                                            runs/<runId>/events.jsonl
                                            runs/<runId>/manifest.json
                                            runs/<runId>/prompts/*.json
```

Two implications worth stating up front:

1. The "game" is the event log plus the engine state at any tick. The browser can be killed and reopened mid-session; it just re-renders from current state.
2. Because LLMs only narrate and decide, a bad LLM call cannot corrupt rule state. Worst case it produces an Action that the engine rejects (a `rule_violation`), which is returned to the agent as an Observation.

## 3. Components and turn cycle

### Server components (Node, TypeScript)

- **`GameEngine`** — pure, deterministic state machine. Owns `Character[]`, the `Map`, the `TurnTracker`, and `Dice` (seeded RNG). Exposes `applyAction(actorId, action) → ActionResult | RuleViolation`. No LLM, no I/O.
- **`EventLog`** — append-only writer to `runs/<runId>/events.jsonl`. Subscribers (broadcaster, browser) read from the tail.
- **`Orchestrator`** — drives the turn loop. Builds per-agent visibility-filtered history, calls into the right `Agent`, validates returned actions through the engine, emits events.
- **`Agent`** — single class, role-configured. Wraps the ReACT inner loop. One instance per role (DM, P1, P2).
- **`LlmClient`** — thin `Anthropic` SDK wrapper with one method: `complete(messages, system, tools, cacheControls)`. Single seam for provider swaps.
- **`WsServer`** — pushes public events to browser, accepts the human's free-text and `skip_turn` signals.

### Browser components

- **Pixi `Board`** — grid background (per-scene image from the adventure), token sprites for each character, dice-roll overlay animation, hit/miss markers.
- **DOM `Log`** — chat-like scroll of DM narration + agent dialogue; researcher toggle to also reveal Thoughts (off by default).
- **DOM `CharacterPanel` ×3** — HP boxes, abilities, conditions, current scene position. Highlights the active character.
- **DOM `InputBox`** — single text input with a `Skip turn` button. Only enabled when it is the human's turn.

### Turn cycle

1. **DM phase.** The DM agent receives current scene state and history, runs its ReACT loop, emits N narration / dialogue actions, and ends with `request_action(actorId)` to hand off.
2. **Player phase.** Engine routes to the targeted actor:
   - **AI player:** Orchestrator runs that agent's ReACT loop; step budget caps it (default 6).
   - **Human:** Browser unlocks input; human types free text or clicks `Skip turn`. Free text is forwarded to the DM agent for interpretation into engine actions; skip short-circuits to `end_turn` for the human's character.
3. **Engine validates** every action. Invalid → returned to the agent as a private Observation (`rule_violation`); the agent can retry within step budget.
4. **Combat exception.** When the DM emits `start_combat(...)`, the engine takes over turn order via initiative; the DM only narrates outcomes between turns. The DM emits `end_combat()` when one side is fully KO'd.

The visibility filter is the only place that distinguishes "what each agent knows". Get that one function right and the whole private-thoughts/shared-world invariant holds.

## 4. Game domain model (HeroKids grounded)

### Resolution rules (deterministic)

- **Attack:** roll `attacker.pools[kind]` d6; roll `defender.pools.armor` d6 with modifiers (cover +1 armor, prone defender +1 attacker on melee, engaged target +1 attacker, etc.). Hit if `max(attackRoll) >= max(armorRoll)` (ties go to attacker). Damage = 1 unless modified by special action.
- **Ability test:** roll `1 + character.pools[characteristic] + (hasSkill ? 1 : 0) + (hasItem ? 1 : 0)` d6. Success if `max >= difficulty` (Easy 4 / Normal 5 / Hard 6).
- **Movement:** BFS up to 4 squares (5 for Rogue's Nimble), respecting walls (block), allies (block — a hero cannot move through a living teammate), enemies (block), obstacles (cost +1 per square). KO'd characters of either side are walk-through corpses. (Revised 2026-05-30: allies were originally passable in transit; living characters of either side now block both transit and destination.)
- **Initiative:** side-based — 1d6 hero side vs 1d6 monster side, highest goes first (heroes win ties); whole side acts before swap. Within a side, the orchestrator dispatches in any order chosen by the DM.
- **All RNG comes from a per-run seed** so a complete run is reproducible from the seed plus the action sequence.

### Core types

```ts
type CharacterId = string;

interface Character {
  id: CharacterId;
  name: string;
  kind: 'hero' | 'monster';
  archetype?: 'warrior' | 'hunter' | 'healer' | 'warlock'
            | 'rogue' | 'knight' | 'brute' | /* ... */;

  pools: { melee: number; ranged: number; magic: number; armor: number };
  health: { total: number; damage: number; status: 'normal' | 'prone' | 'KO' };
  pos: { x: number; y: number } | null;

  normalAttack:  AttackSpec;
  specialAction: SpecialSpec;
  bonusAbility:  BonusSpec;   // passive trigger

  // Gear
  equipped?:  EquipmentId;        // at most one
  inventory:  ItemStack[];        // consumables + utility, with counts
  boons:      BoonId[];           // each used once, then removed
  skills:     SkillId[];

  // AI-agent only
  persona?: string;
}
```

Heroes and monsters share the `Character` shape; same engine code applies. The Warrior and the Giant Rat differ only in stat values.

### Items, equipment, and boons

HeroKids has four distinct gear categories. All four are first-class types in the engine:

```ts
type ItemId = string; type EquipmentId = string; type BoonId = string;

interface ItemStack { itemId: ItemId; count: number }

interface Item {                     // CONSUMABLE or UTILITY
  id: ItemId;
  name: string;                      // "Potion", "Bomb", "Rope", "Food", "Gold", "Herbs"
  category: 'consumable' | 'utility';
  // consumables: an action; discarded on use
  consumableEffect?: ItemEffect;     // e.g. potion = heal-to-full(self|adjacent)
  // utility: passive — grants +1 die to ability tests where the skill applies
  skillBonus?: SkillId[];            // e.g. Rope helps Athletics/Acrobatics
  iconAsset: string;                 // path under assets/items/
}

interface Equipment {                // worn; only ONE equipped at a time
  id: EquipmentId;
  name: string;                      // "Raider's Battleaxe", etc.
  effect: EquipmentEffect;           // e.g. Reaping Strike: KO an enemy → free melee at adjacent target
  iconAsset: string;
}

interface Boon {                     // one-shot favor, usable on ANY turn (incl. enemy's)
  id: BoonId;
  name: string;
  description: string;
  effect: BoonEffect;
  iconAsset: string;
}
```

**Action interactions:**

- `use_item` with a `consumable` item is a player Action (counts as their action for the turn). Using a `utility` item never costs an action — its skillBonus is automatically applied during ability tests when relevant.
- `use_boon` is special: it can be sent **off-turn**. The orchestrator accepts it during any other actor's turn, queues it after the current step, and the engine applies its effect synchronously. Boon plays are still logged with their own `t`.
- `equip` swaps which equipment is active. Out-of-combat only (per HeroKids rules); the engine rejects with `rule_violation` mid-combat.

**v1 catalog (minimum to play Basement O' Rats):**

| Type | Items |
|---|---|
| Consumable | Potion (heal to full, self or adjacent ally), Bomb (1-die attack on target up to 5sq + adjacent) |
| Utility | Rope (Athletics/Acrobatics +1), Food, Gold, Herbs (replenishes Healer's potion) |
| Equipment | Raider's Battleaxe (Reaping Strike). Heroes start with their archetype's normal weapon as implicit equipment. |
| Boons | None required for Basement O' Rats; type exists for future adventures. |

These all live as data in `data/items.json` / `data/equipment.json` / `data/boons.json`, loaded at engine boot. Adding a new item is a JSON entry plus an icon PNG, no engine code changes.

### Action vocabulary (closed sets)

```ts
type PlayerAction =
  | { kind: 'move'; path: Square[] }
  | { kind: 'normal_attack';  targetId: CharacterId }
  | { kind: 'special_action'; params: SpecialParams }
  | { kind: 'use_item';   itemId: ItemId; targetId?: CharacterId }
  | { kind: 'use_boon';   boonId: BoonId; targetId?: CharacterId } // can be played OFF-turn
  | { kind: 'equip';      equipmentId: EquipmentId }              // out-of-combat only
  | { kind: 'ability_test';
      characteristic: 'melee' | 'ranged' | 'magic';
      skillId?: SkillId; itemId?: ItemId;
      difficulty: 4 | 5 | 6;
      describe: string }
  | { kind: 'say'; text: string }       // always public
  | { kind: 'end_turn' }
  | { kind: 'skip_turn' };              // human-only direct signal

type DmAction =
  | { kind: 'narrate'; text: string }
  | { kind: 'set_scene'; sceneId: SceneId }
  | { kind: 'start_combat'; participants: CharacterId[];
      heroSideRoll: number; monsterSideRoll: number }
  | { kind: 'end_combat' }
  | { kind: 'request_action'; actorId: CharacterId }
  | { kind: 'reveal_monster'; monsterId: CharacterId; pos: { x: number; y: number } }
  | { kind: 'environmental';
      effect: 'push' | 'pull' | 'hazard' | 'cover' | 'difficult';
      params: any }
  | { kind: 'offer_rest' }
  | { kind: 'end_adventure'; outcome: 'success' | 'failure' };
```

Each variant maps to one Claude tool. LLM responses are constrained at the model level, not parsed from free text.

### Adventure as data

`adventures/basement-o-rats.json` carries all 5 scenes:

```json
{
  "id": "basement-o-rats",
  "title": "Basement O' Rats",
  "estimatedDurationMin": 45,
  "scenes": [
    {
      "id": "tavern-basement",
      "intro": "You put down your cutlery, pick up your weapons... [verbatim]",
      "map": {
        "width": 13, "height": 8,
        "background": "tavern-basement",       // manifest ID, resolved at load
        "obstacles": [ /* barrel positions */ ],
        "exits": [ { "to": "rat-tunnel", "at": { "x": 0, "y": 7 } } ]
      },
      "monsters": [
        { "type": "giant-rat", "startPos": { "x": 5, "y": 2 } },
        { "type": "giant-rat", "startPos": { "x": 8, "y": 2 } },
        { "type": "giant-rat", "startPos": { "x": 5, "y": 5 } }
      ],
      "tactics": "Rats won't attack until attacked first. Once attacked, all nearby rats engage.",
      "abilityTests": [
        { "skill": "Perception", "difficulty": 4, "describe": "hear Roger's distant shouts" },
        { "skill": "Knowledge",  "difficulty": 5, "describe": "recall this basement is often rat-infested" }
      ],
      "conclusion": "With a screech, the final rat falls... [verbatim]",
      "transitions": [ { "to": "rat-tunnel", "trigger": "all-monsters-ko" } ]
    }
    // ...4 more scenes; encounter 3 has TWO transitions (south→detour, north→rat-den)
  ]
}
```

Scenes form a directed graph (encounter 3 branches). Read-aloud `intro`/`conclusion` text is data: the DM agent paraphrases faithfully but cannot invent the canonical text. Adding adventures = adding JSON files.

## 5. Agent prompts, ReACT loop, visibility filter

### Visibility filter (the load-bearing primitive)

| Event type | Author | Other AI players | Human | DM | Browser log |
|---|---|---|---|---|---|
| `thought` (private) | full | hidden | hidden | hidden | researcher toggle |
| `say` (dialogue) | yes | yes | yes | yes | chat panel |
| `action` | full args | observed effect | observed effect | full | board animation |
| `resolution` (rolls + outcome) | full (own rolls) | outcome only | outcome only | full | dice anim + result |
| `state_change` (HP, pos, status) | yes | yes | yes | yes | HP bar / token move |
| `narrate` (DM) | yes (DM) | yes | yes | yes | chat panel |
| `rule_violation` | yes (offender only) | hidden | hidden | yes (audit) | researcher toggle |

This table is the only place that distinguishes what each role knows. Implement it as one pure function `filter(event, viewerRole) → boolean | RedactedEvent` and the system-wide invariant holds.

### Player agent — system prompt template

```
You are {{name}}, a {{archetype}} in a HeroKids adventure played around a virtual table.

YOUR CHARACTER SHEET
  Melee {{pools.melee}}d6  Ranged {{pools.ranged}}d6
  Magic {{pools.magic}}d6  Armor  {{pools.armor}}d6
  Health: {{3-damage}}/3 ({{status}})
  Normal attack: {{normalAttack.name}} — {{normalAttack.description}}
  Special action: {{specialAction.name}} — {{specialAction.description}}
  Bonus (passive): {{bonusAbility.name}} — {{bonusAbility.description}}
  Inventory: {{inventory}}
  Skills:    {{skills}}

PERSONA
  {{persona}}

YOUR PARTY
  - {{teammate.name}} ({{teammate.archetype}}, AI)
  - {{human.name}} ({{human.archetype}}, human player)
  - The DM is also an AI; trust their narration.

HOW YOU ACT
  Each turn, you may take SEVERAL reasoning steps. On each step,
  think privately, then call EXACTLY ONE tool from the action
  vocabulary. Your reasoning is PRIVATE — only your tool calls
  and `say()` are seen by others. End your turn with end_turn.
  Step budget: 6 per turn.

WHAT YOU SEE
  - DM narration & scene description
  - Every character's public actions and effects
  - Everything any character says aloud
  You do NOT see anyone else's private thoughts.

GOAL
  Help the party complete the adventure. Behave consistently
  with your persona. Coordinate through dialogue and visible
  action — your teammates literally cannot read your mind.
```

### DM agent — system prompt template

```
You are the Dungeon Master running a HeroKids adventure for two AI
players and one human.

CRITICAL: You DO NOT compute outcomes. The deterministic engine
rolls all dice, tracks HP, validates moves, and resolves attacks.
You narrate, adjudicate fuzzy situations, and pick who acts next
when out of combat.

CURRENT SCENE: {{scene.id}} — "{{scene.title}}"

INTRO (read or paraphrase faithfully on entry):
"""
{{scene.intro}}
"""

MAP: {{w}}×{{h}}, terrain: {{obstacles}}, exits: {{exits}}
MONSTERS PRESENT: {{monsters with stats and start positions}}
TACTICS HINT: {{scene.tactics}}
SUGGESTED ABILITY TESTS: {{scene.abilityTests}}
CONCLUSION (use when scene resolves):
"""
{{scene.conclusion}}
"""

PARTY (with sheets): {{3 characters}}

YOUR TURN STRUCTURE
  Out of combat: narrate → call request_action to hand off.
  Combat: call start_combat once; engine drives turn order;
  you only narrate outcomes between turns. Call end_combat
  when one side is fully KO'd, then offer_rest.

INTERPRETING THE HUMAN
  When the human types free text, parse it into the
  appropriate engine Action(s) on their behalf. Ask for
  clarification (via narrate) if intent is ambiguous.
  Wait indefinitely; the human will type or click Skip.
```

### ReACT inner loop (per agent turn)

```
loop while step < 6 and not turn_ended:
  history  = visibility_filter(eventLog, agentId)
  prompt   = systemPrompt(agent) + history + currentObservation
  response = anthropic.messages.create(
              model = "claude-sonnet-4-6",
              system = prompt.system,         // cache_control: ephemeral
              messages = prompt.messages,     // older prefix also cached
              tools = ACTION_TOOLS,           // ~8 player, ~9 DM
              thinking = { type: "enabled" }) // private Thoughts

  thought = response.thinking_blocks   // logged as Thought event (private)
  action  = parse_tool_use(response)   // exactly one tool call

  result  = engine.applyAction(agentId, action)
  if result.kind == 'rule_violation':
    obs = Observation({ rule_violation, reason })   // private to actor
    continue

  emit_events(result.events)           // public events
  obs = Observation(result.publicResult)

  if action.kind == 'end_turn':
    break
  step += 1

if step == 6 and not turn_ended:
  emit_event(StepBudgetExhausted)
  force_end_turn()
```

Three load-bearing properties:

1. **Extended thinking is the Thought channel.** Reasoning is structurally separate from the Action; logged once, never sent back to other agents. No leakage risk.
2. **Tool use, not free-form JSON.** Anthropic's tool use enforces the action schema at the model level; we get parse-correctness for free.
3. **Rule violations are private to the offender.** Other agents do not see "Player 1 tried something illegal" — only legal Actions enter the public log.

### Prompt caching

The system prompt + adventure data is stable for the whole run; mark it with `cache_control: { type: 'ephemeral' }`. Older history prefixes can also be cached at periodic snapshot points. The manifest's `cacheHitRatio` field exposes whether caching is doing what we expect — surface this in run analysis.

## 6. Event log and replay

### Persistence layout

```
runs/
└── 2026-05-08T14-22-basement-r3/
    ├── manifest.json        # run-level metadata + token + cache stats
    ├── events.jsonl         # source of truth (append-only)
    ├── prompts/
    │   ├── 0005-p1-step1.json   # full prompt sent to LLM at event t=5
    │   └── ...                  # one file per LLM call (optional via flag)
    └── final-state.json     # convenience snapshot at end-of-run
```

### Event shape

One JSON object per line in `events.jsonl`. The `t` field is a logical step counter, monotonically increasing. Examples (sample run):

```jsonl
{"t":1,"type":"scene_enter","sceneId":"tavern-basement"}
{"t":2,"type":"thought","actorId":"dm","text":"Read the intro verbatim, then ask what they do."}
{"t":3,"type":"narrate","actorId":"dm","text":"You put down your cutlery..."}
{"t":4,"type":"request_action","actorId":"dm","targetId":"p1_anwen"}
{"t":5,"type":"thought","actorId":"p1_anwen","text":"Three rats visible. I'll engage so my Teamwork bonus helps Bran."}
{"t":6,"type":"action","actorId":"p1_anwen","action":{"kind":"say","text":"Bran, flank left — I'll take the closest one!"}}
{"t":7,"type":"action","actorId":"p1_anwen","action":{"kind":"move","path":[[1,7],[2,6],[3,5],[4,4]]}}
{"t":8,"type":"resolution","actorId":"p1_anwen","public":{"ok":true,"newPos":[4,4]}}
{"t":9,"type":"action","actorId":"p1_anwen","action":{"kind":"normal_attack","targetId":"giant_rat_1"}}
{"t":10,"type":"resolution","actorId":"p1_anwen","public":{"hit":true,"damage":1},"private":{"attackRoll":[5,3],"armorRoll":[4],"top":5}}
{"t":11,"type":"state_change","changes":[{"id":"giant_rat_1","damage":1,"status":"KO"}]}
{"t":12,"type":"action","actorId":"p1_anwen","action":{"kind":"end_turn"}}
{"t":18,"type":"request_action","actorId":"dm","targetId":"human_bran"}
{"t":19,"type":"human_input","actorId":"human_bran","text":"I rush the wounded one and finish it off"}
{"t":20,"type":"thought","actorId":"dm","text":"Translate to: move + normal_attack."}
{"t":21,"type":"action","actorId":"human_bran","action":{"kind":"move","path":[[8,7],[7,6],[6,5]]},"interpretedBy":"dm"}
{"t":402,"type":"step_budget_exhausted","actorId":"p1_anwen","forced":"end_turn"}
```

### Manifest shape

```json
{
  "runId": "2026-05-08T14-22-basement-r3",
  "startedAt": "2026-05-08T14:22:01Z",
  "endedAt":   "2026-05-08T15:47:33Z",
  "outcome":   "success",
  "adventure": "basement-o-rats@v1",
  "rngSeed":   "0xC0FFEE-2026-05-08",
  "agents": [
    { "role": "dm", "model": "claude-sonnet-4-6", "promptHash": "sha256:..." },
    { "role": "p1", "characterId": "anwen-warrior",
      "persona": "cautious tactician, often calls plays",
      "model": "claude-sonnet-4-6", "promptHash": "sha256:..." },
    { "role": "p2", "characterId": "kael-warlock-fire",
      "persona": "reckless, shouts a lot",
      "model": "claude-sonnet-4-6", "promptHash": "sha256:..." }
  ],
  "human":      { "characterId": "bran-rogue" },
  "stepBudget": 6,
  "totalEvents": 1247,
  "totalLlmCalls":   { "p1": 42, "p2": 38, "dm": 89 },
  "totalTokens":     { "in": 312000, "out": 18400 },
  "cacheHitRatio":   0.78
}
```

`promptHash` pins the system prompt for each agent. Tweaking a prompt and re-running yields a new hash, signalling a new experimental condition.

### Replay invariant

> Given the seed, the adventure version, and the action sequence from `events.jsonl` (without LLM calls), a fresh `GameEngine` produces identical state at every tick.

This buys three thesis-grade affordances:

1. **Deterministic bug repros.** "Agent did X at t=412" is one command to reproduce.
2. **Citation by `{runId, t}`.** Thesis sentences like "in run R3 at step 412, the warrior chose Whirlwind despite only one adjacent target" are independently verifiable by any reader with access to the committed log.
3. **Counterfactual branching.** Replay up to t=180, then swap an agent's persona/model and run forward. Lets you study local interventions without re-running the whole adventure.

What is intentionally **not** replayable: the Thoughts. Claude is non-deterministic per call; the same prompt produces different reasoning. This is a feature — Thoughts are the behaviour under study, not the substrate. Mechanics are deterministic so the *stage* is reproducible; the actors' minds are not.

## 7. Evaluation strategy

The thesis claim has to come from comparing runs across conditions, not a single run. A single playthrough is a demo; the matrix is the evidence.

### Eval dimensions

| Dimension | Question | Method | Source |
|---|---|---|---|
| Coordination | Do agents act in ways that benefit teammates (engage→teammate exploits, focus fire, role specialization)? | Quantitative | events.jsonl |
| Human responsiveness | Do agents react to human moves within 1–2 turns? | Quant + LLM judge | events.jsonl |
| Communication quality | Are utterances task-useful or just flavor? Does dialogue produce visible behaviour change? | LLM judge + manual | events.jsonl |
| Persona adherence | Does each agent behave consistently with its persona? | LLM judge (1–5) | events.jsonl |
| Plan coherence | Within an agent's Thought trace, do later Thoughts follow from earlier ones? | LLM judge | prompts/ + events.jsonl |
| Rule adherence | How often do agents emit illegal Actions? | Quantitative | events.jsonl |
| Outcome | Did the party complete? Final HP? Turns? KOs? | Quantitative | manifest.json + final-state.json |

### Sample experiment matrix (vary personas)

| Condition | P1 persona | P2 persona | N runs |
|---|---|---|---|
| A — baseline | neutral | neutral | 5 |
| B — matched | cautious | cautious | 5 |
| C — mismatched | cautious | reckless | 5 |
| D — both reckless | reckless | reckless | 5 |

20 runs total, ~4–6 hours wall-time, ~$30–60 in API at Sonnet pricing with caching. Same human player across all runs, same adventure, different RNG seeds.

### Concrete metric formulas

```
// Coordination
teamwork_exploit_rate
  = #(attacks where target was 'engaged' by ally) / #(attacks)
focus_fire_rate
  = fraction of rounds where 2+ party members targeted the same monster

// Human responsiveness
human_referenced_in_dialogue
  = #(agent say-events that mention human's action or character)
    / #(agent say-events following a human action within 2 turns)
target_shift_after_human
  = fraction of agent turns immediately after a human attack
    where the agent targets the same monster

// Communication
dialogue_density       = words(say) / actions
dialogue_to_action_lag = mean turns between a "let's flank" suggestion
                         and a teammate enacting it

// Coherence & rules
rule_violation_rate          = #(rule_violations) / #(actions)
step_budget_exhausted_rate   = #(forced end_turn) / #(turns)

// Outcome
completion        = boolean
party_hp_end      = sum of (3 - damage)
turns_to_complete = #(turns)
kos_during_run    = #(state_changes where status:'KO')
```

### Workflow

1. Run experiment matrix (script the loop).
2. `eval/metrics.ts` reads `runs/**/events.jsonl`, writes per-run CSV.
3. `eval/llm_judge.ts` samples K runs, prompts Claude with a rubric, writes scores CSV.
4. `eval/notebook.ipynb` joins CSVs, plots, picks 2–3 illustrative dialogue excerpts.
5. Thesis chapter cites runs by `{runId, t}`; reader verifies against committed `events.jsonl`.

### Known confounds and mitigations

- **The human is the same person (you) across all runs.** Behaviour varies per-run, you learn the system over time. Acknowledge in writeup; the variable being studied is *agent behaviour given a human teammate*, not the human. A future "scripted human" mode (replay a recorded transcript) would remove the confound entirely.
- **N=5 per condition is small.** Statistical significance tests will be weak. Plan descriptive stats + qualitative coding as the primary evidence; significance tests are bonus. If significance matters, plan N=10–15 per cell — the practical limit is API cost.
- **Prompt drift across runs.** `promptHash` in the manifest tells you whether prompts were stable. Lock prompt files for each experimental condition.

### Free-with-architecture bonus

Because the engine is deterministic and Thoughts are non-deterministic, you can run the same seeded scenario multiple times against the same persona to measure variance in agent behaviour — a "consistency under non-determinism" axis that most multi-agent papers cannot easily access.

## 8. Asset pipeline

Pixi.js loads sprites by ID at startup. All assets live under `assets/` and are addressed through a single registry:

```
assets/
├── manifest.json          # id → file path; validated at server boot
├── heroes/
│   ├── warrior.png        # already present
│   ├── hunter.png         # rename existing assets/archer.png (HeroKids term is "Hunter")
│   ├── healer.png         # already present
│   └── warlock.png        # already present
├── monsters/
│   ├── giant-rat.png      # extracted from manual p.41 / adventure stand-ups
│   ├── king-rat.png       # extracted from adventure p.18
│   └── ...                # one PNG per monster type used by any encoded adventure
├── maps/
│   ├── tavern-basement.png    # extracted from adventure p.13 (blank grid version preferred)
│   ├── rat-tunnel.png         # adventure p.14
│   ├── underground-choices.png# adventure p.15
│   ├── momentary-detour.png   # adventure p.16
│   └── rat-den.png            # adventure p.17
├── items/
│   ├── potion.png         # extracted from manual p.13
│   ├── rope.png
│   ├── food.png
│   ├── gold.png
│   ├── herbs.png
│   └── bomb.png           # manual p.14
├── equipment/
│   └── raiders-battleaxe.png  # manual p.14
├── boons/                 # empty in v1
└── world.png              # Brecken Vale overworld; reserved for future scope
```

**Manifest** (`assets/manifest.json`):

```json
{
  "heroes":    { "warrior": "heroes/warrior.png", "hunter": "heroes/hunter.png", "healer": "heroes/healer.png", "warlock": "heroes/warlock.png" },
  "monsters":  { "giant-rat": "monsters/giant-rat.png", "king-rat": "monsters/king-rat.png" },
  "maps":      { "tavern-basement": "maps/tavern-basement.png", /* ... */ },
  "items":     { "potion": "items/potion.png", "rope": "items/rope.png", /* ... */ },
  "equipment": { "raiders-battleaxe": "equipment/raiders-battleaxe.png" },
  "boons":     {}
}
```

**Loading & validation:**

- Server reads `manifest.json` at boot and verifies every referenced file exists. Missing assets → fatal startup error (not a runtime hazard).
- Browser fetches the manifest over WebSocket on connect, then preloads sprites via Pixi's `Assets.load()`.
- Adventure JSONs reference assets by manifest ID (e.g. `"background": "tavern-basement"`), not by raw path. This keeps adventures portable and validates the asset graph at boot.

**Extraction conventions:**

- Hero sprites: 200×400px-ish portraits, transparent background, used as token + character-panel portrait.
- Monster sprites: same shape; cropped from the manual's monster cards.
- Map backgrounds: scaled so 1 grid square == 64px in the source PNG. The adventure JSON declares grid dimensions; Pixi places tokens at `(x*64, y*64)`.
- Items/equipment/boons: 64×64 icons with transparent background.

**Asset prep is its own implementation slice.** Done once per adventure — encoding Basement O' Rats includes cropping its 5 maps and 2 unique monster sprites.

**Fallback:** if a sprite is missing during development, the renderer draws a labelled colored circle so the run still proceeds. Useful for adding a new archetype before its art is ready.

## 9. Open questions deferred to implementation

- **Adventure authoring tooling.** v1 = hand-edit JSON. If many adventures end up needed, build a small generator that ingests the printed adventure structure (intro/map/monsters/conclusion) into JSON. Out of scope for v1.
- **Scripted human mode** (replay a recorded transcript in the human seat). Useful for removing the human-confound; build only if scope allows.
- **Researcher overlay UI** (a viewer that re-renders the run from `events.jsonl` with a step slider, full thought visibility, and side-panel prompts). Nice-to-have; v1 can ship without it because the JSONL is grep-friendly.
- **Mid-run hot reload of agent prompts.** Useful for iterating on system prompts without restarting. Out of scope for v1.
- **Sprite licensing for distribution.** HeroKids PDFs grant personal-use printing. If the project is ever published, sprites must be replaced with original or properly-licensed art.

## 10. Implementation order suggestion (not a plan)

Rough order, smallest natural slices first:

1. `GameEngine` + types (HeroKids rules) with a unit-tested rules surface — no LLM, no UI.
2. `EventLog` + replay harness — confirm the replay invariant against scripted action sequences.
3. Item/Equipment/Boon catalog (JSON data + loader + effect dispatch in the engine).
4. `Agent` + `LlmClient` against a stub adventure (one scene, no UI) — get one ReACT loop working end-to-end.
5. Visibility filter — implement the matrix and test that filtered streams hold the invariants.
6. `Orchestrator` + WebSocket — wire P1, P2, DM together; play through one scene from a CLI client.
7. Asset prep: extract & crop hero / monster / map / item sprites from PDFs; write `manifest.json`; verify load.
8. Browser: DOM panels first (chat, character, input), Pixi board second using the manifest.
9. Adventure data: encode Basement O' Rats, including all 5 scenes and the encounter-3 branch.
10. Eval scripts: `metrics.ts`, `llm_judge.ts`, notebook scaffold.
11. Run the experiment matrix.

The plan-phase will refine this into a real plan with task breakdown.

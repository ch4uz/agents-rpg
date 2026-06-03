import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AgentRecord {
  /** `p3` is an optional 3rd AI hero (e.g. a rescued captive) — see scenario.ts. */
  role: 'dm' | 'p1' | 'p2' | 'p3';
  characterId?: string;
  persona?: string;
  model: string;
  promptHash: string;
}

export interface HumanRecord {
  characterId: string;
}

export interface RunManifest {
  runId: string;
  startedAt: string;       // ISO-8601
  endedAt: string;         // ISO-8601
  outcome: 'success' | 'failure' | 'in-progress';
  adventure: string;       // "<adventureId>@<version>"
  rngSeed: string;
  agents: AgentRecord[];
  human: HumanRecord | null;
  stepBudget: number;
  totalEvents: number;
  totalLlmCalls: Record<string, number>;
  totalTokens: { in: number; out: number };
  cacheHitRatio: number;
  /**
   * Per-role LLM wall-clock latency, keyed like `totalLlmCalls` (dm, p1,
   * dm:react, p2:party-react, …). `meanMs = round(totalMs / calls)`. Filled
   * by the orchestrator from the duration the Agent measures around every
   * `llm.complete` round-trip — the per-call cost that drives how fast the
   * game generates actions. Optional so manifests written before 2026-06-03
   * (and hand-built test fixtures) stay valid.
   */
  llmLatencyMs?: Record<string, { calls: number; totalMs: number; meanMs: number; maxMs: number }>;
  /**
   * Effective game language of the run ('en' | 'pt'): the scenario default,
   * overridden by the player's pick on the hero-select screen. Drives the
   * LANGUAGE directive in every agent's system prompt. Optional so manifests
   * written before 2026-06-03 stay valid (absent = English).
   */
  language?: 'en' | 'pt';
}

export const writeManifest = async (path: string, m: RunManifest): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(m, null, 2) + '\n', 'utf8');
};

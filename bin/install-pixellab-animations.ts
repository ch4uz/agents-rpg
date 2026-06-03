#!/usr/bin/env node
/**
 * Install PixelLab character animations into `assets/<group>/<id>/anim/...`
 * and patch `assets/manifest.json` to include the `animations` section.
 *
 * Per-character source: PixelLab ZIP download at
 *   https://api.pixellab.ai/mcp/characters/<character-id>/download
 *
 * The ZIP format is opaque, so this script is defensive: it walks every PNG
 * inside the ZIP, classifies each file by its path (which animation, which
 * direction, which frame index), and writes them into the canonical layout
 * the game's renderer expects:
 *
 *   assets/<group>/<assetId>/anim/<animName>/<facing>/<frameIdx>.png
 *
 * The PixelLab template name is mapped to a friendly anim name via
 * ANIMATION_NAME_MAP — e.g. `walking-4-frames` → `walk`.
 *
 * Usage:
 *   npm run install:animations
 *
 * Requires `unzip` on PATH (macOS + most Linux distros ship it).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..');
const ASSETS_DIR = join(REPO_ROOT, 'assets');
const MANIFEST_PATH = join(ASSETS_DIR, 'manifest.json');

type AnimKind = 'walk' | 'attack' | 'death' | 'spawn';

/**
 * PixelLab ZIP folders use opaque prefixes — most templates compile down to
 * `animating-<hash>` with no human-readable name, plus a handful of named
 * prefixes like `cross_punch_attack-<hash>` for some attack templates. We
 * map by folder-name prefix first; opaque `animating-*` folders are
 * disambiguated by frame count (see FRAMES_TO_KIND).
 */
const PREFIX_TO_KIND: Array<{ prefix: string; kind: AnimKind }> = [
  { prefix: 'cross_punch',     kind: 'attack' },
  { prefix: 'throw_object',    kind: 'attack' },
  { prefix: 'fireball',        kind: 'attack' },
  { prefix: 'angry',           kind: 'attack' },
  { prefix: 'falling_backward', kind: 'death' },
  { prefix: 'falling_back',    kind: 'death' },
  { prefix: 'getting_up',            kind: 'spawn' },
  { prefix: 'standing_up_from_belly', kind: 'spawn' },
  { prefix: 'idle',                  kind: 'spawn' },
  { prefix: 'walking',         kind: 'walk' },
  { prefix: 'running',         kind: 'walk' },
  { prefix: 'walk',            kind: 'walk' },
  { prefix: 'attack',          kind: 'attack' },
  { prefix: 'death',           kind: 'death' },
  { prefix: 'spawn',           kind: 'spawn' },
];

/**
 * Opaque `animating-*` / `animation-*` folder disambiguation by per-direction
 * frame count. Note: `falling-back-death` produces a `falling_backward-<hash>`
 * prefix (handled in PREFIX_TO_KIND), so 7-frame opaque folders are
 * throw-object (hunter's attack template) — NOT death.
 */
const FRAMES_TO_KIND: Record<number, AnimKind> = {
  4: 'walk',    // walking-4-frames, running-4-frames
  5: 'spawn',   // getting-up
  6: 'attack',  // cross-punch, fireball
  7: 'attack',  // throw-object
  8: 'spawn',   // idle (quadruped — 8-frame loop)
};

/** Default fps per animation kind. */
const DEFAULT_FPS = { walk: 8, attack: 10, death: 8, spawn: 6 } as const;

/**
 * Character roster: PixelLab id → asset placement.
 * group=heroes|monsters, assetId is the manifest key (warrior, giant-rat, ...).
 */
const ROSTER: Array<{
  characterId: string;
  group: 'heroes' | 'monsters';
  assetId: string;
}> = [
  { characterId: '7997c635-7f1c-4306-b5f5-f29b5ec1cf95', group: 'heroes',   assetId: 'warrior'   },
  { characterId: '2b4d1b35-855b-47f8-b1e9-9aef3be1d36d', group: 'heroes',   assetId: 'hunter'    },
  { characterId: '136cffe3-8d90-4468-83a7-44ff2d559d29', group: 'heroes',   assetId: 'healer'    },
  { characterId: '85ab6f67-ec67-4b66-9937-ddf8efe22b9d', group: 'heroes',   assetId: 'warlock'   },
  { characterId: 'eb885ec4-e653-4cff-820f-a05e1493b69e', group: 'monsters', assetId: 'giant-rat' },
  { characterId: 'ed3cd0ed-2624-4a15-9f25-59a28ebf3415', group: 'monsters', assetId: 'king-rat'  },
];

const ZIP_URL = (characterId: string): string =>
  `https://api.pixellab.ai/mcp/characters/${characterId}/download`;

const FACINGS = ['south', 'east', 'north', 'west'] as const;
type Facing = typeof FACINGS[number];

/**
 * Read the per-character metadata.json that PixelLab includes in every ZIP.
 * Returns the parsed `frames.animations` block: folder-id → facing → frame
 * paths (relative to the ZIP root).
 */
interface PixellabMetadata {
  frames: {
    animations: Record<string, Partial<Record<Facing, string[]>>>;
  };
}

const readMetadata = (charDir: string): PixellabMetadata => {
  const raw = readFileSync(join(charDir, 'metadata.json'), 'utf8');
  return JSON.parse(raw) as PixellabMetadata;
};

/**
 * Decide which AnimKind a PixelLab animation folder maps to:
 *  1. Try the folder-name prefix (handles `cross_punch_attack-<hash>` etc.).
 *  2. Fall back to FRAMES_TO_KIND keyed by per-direction frame count.
 * Returns null if neither path resolves — caller should warn and skip.
 */
const classifyFolder = (folderId: string, frameCount: number): AnimKind | null => {
  const low = folderId.toLowerCase();
  for (const { prefix, kind } of PREFIX_TO_KIND) {
    if (low.startsWith(prefix)) return kind;
  }
  return FRAMES_TO_KIND[frameCount] ?? null;
};

const downloadZip = (characterId: string, outPath: string): void => {
  // Capture the HTTP status separately. 423 = animations still pending for
  // this character — surface a clear message so the wakeup loop knows to
  // retry rather than treating it as a hard failure.
  const res = spawnSync('curl', ['-sL', '-w', '%{http_code}', '-o', outPath, ZIP_URL(characterId)]);
  if (res.status !== 0) {
    throw new Error(`curl process failed for ${characterId}: ${res.stderr?.toString() ?? ''}`);
  }
  const httpCode = res.stdout.toString().trim();
  if (httpCode === '423') {
    throw new Error(`HTTP 423 (locked) — ${characterId} has animation jobs still pending`);
  }
  if (httpCode !== '200') {
    throw new Error(`HTTP ${httpCode} downloading ${characterId}`);
  }
  const stat = statSync(outPath);
  if (stat.size < 1024) {
    throw new Error(`ZIP for ${characterId} is only ${stat.size} bytes — likely an error JSON, not the ZIP`);
  }
};

const unzip = (zipPath: string, destDir: string): void => {
  const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir]);
  if (res.status !== 0) {
    throw new Error(`unzip failed: ${res.stderr?.toString() ?? ''}`);
  }
};

const ensureDir = (dir: string): void => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

interface CharacterResult {
  assetId: string;
  group: 'heroes' | 'monsters';
  animations: Record<AnimKind, { path: string; frames: number; fps: number } | undefined>;
}

const installOne = (
  entry: typeof ROSTER[number],
  tempBase: string,
): CharacterResult => {
  const charDir = join(tempBase, entry.characterId);
  ensureDir(charDir);
  const zipPath = join(charDir, 'character.zip');
  console.log(`→ Downloading ${entry.assetId} (${entry.characterId})…`);
  downloadZip(entry.characterId, zipPath);
  console.log(`→ Extracting…`);
  unzip(zipPath, charDir);

  const meta = readMetadata(charDir);
  const result: CharacterResult = {
    assetId: entry.assetId,
    group: entry.group,
    animations: { walk: undefined, attack: undefined, death: undefined, spawn: undefined },
  };

  // Process named-prefix folders before opaque `animating-*` / `animation-*`
  // ones so an ambiguous frame count (e.g. 7) doesn't steal an attack/death
  // slot from its rightful named-prefix folder.
  const isOpaque = (folderId: string): boolean => {
    const low = folderId.toLowerCase();
    return low.startsWith('animating-') || low.startsWith('animation-');
  };
  const entries = Object.entries(meta.frames.animations);
  entries.sort(([a], [b]) => Number(isOpaque(a)) - Number(isOpaque(b)));
  for (const [folderId, byDir] of entries) {
    // Use the south frame count as the canonical count for this animation.
    const southList = byDir.south ?? [];
    const frameCount = southList.length || Math.max(...FACINGS.map((f) => (byDir[f]?.length ?? 0)));
    if (frameCount === 0) continue;

    const kind = classifyFolder(folderId, frameCount);
    if (!kind) {
      console.warn(`  ! unmapped folder ${folderId} (${frameCount} frames) — skipping`);
      continue;
    }
    if (result.animations[kind]) {
      console.warn(`  ! ${kind} already installed for ${entry.assetId}, skipping duplicate from ${folderId}`);
      continue;
    }

    const animBaseRel = `${entry.group}/${entry.assetId}/anim/${kind}`;
    const animBaseAbs = join(ASSETS_DIR, animBaseRel);

    // Write each direction's frames as 0.png, 1.png, ... (frameCount-1).png.
    // Missing directions fall back to south (defensive — shouldn't happen for
    // template animations where all 4 sides are queued together).
    for (const facing of FACINGS) {
      const sourceFrames = byDir[facing] ?? byDir.south;
      if (!sourceFrames || sourceFrames.length === 0) continue;
      const dirAbs = join(animBaseAbs, facing);
      ensureDir(dirAbs);
      for (let i = 0; i < sourceFrames.length; i++) {
        const src = join(charDir, sourceFrames[i]!);
        const dst = join(dirAbs, `${i}.png`);
        writeFileSync(dst, readFileSync(src));
      }
    }

    result.animations[kind] = {
      path: animBaseRel,
      frames: frameCount,
      fps: DEFAULT_FPS[kind],
    };
    console.log(`  ✓ ${kind}: ${frameCount} frames per direction (from ${folderId})`);
  }
  return result;
};

const updateManifest = (results: CharacterResult[]): void => {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const json = JSON.parse(raw) as { animations: Record<string, Record<string, unknown>> };
  json.animations ??= {};
  for (const r of results) {
    const entries: Record<string, unknown> = {};
    for (const [name, strip] of Object.entries(r.animations)) {
      if (strip) entries[name] = strip;
    }
    if (Object.keys(entries).length > 0) {
      json.animations[r.assetId] = entries;
    }
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(json, null, 2) + '\n');
  console.log(`✓ manifest.json updated with animations for ${results.length} character(s)`);
};

const main = (): void => {
  // Sanity: ensure `unzip` exists.
  const unzipCheck = spawnSync('unzip', ['-v']);
  if (unzipCheck.status !== 0) {
    console.error('unzip not found on PATH — please install it or extract manually.');
    process.exit(1);
  }

  const tempBase = mkdtempSync(join(tmpdir(), 'pixellab-install-'));
  console.log(`Temp dir: ${tempBase}`);

  const results: CharacterResult[] = [];
  for (const entry of ROSTER) {
    try {
      results.push(installOne(entry, tempBase));
    } catch (e) {
      console.error(`✗ ${entry.assetId} failed: ${(e as Error).message}`);
    }
  }

  if (results.length > 0) updateManifest(results);

  // Clean up temp dir unless DEBUG=1 is set.
  if (!process.env.DEBUG) {
    rmSync(tempBase, { recursive: true, force: true });
  } else {
    console.log(`(DEBUG=1) preserved: ${tempBase}`);
  }
};

main();

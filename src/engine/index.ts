export * from './ids.js';
export * from './primitives.js';
export * from './character.js';
export * from './action.js';
export { Dice } from './dice.js';
export { Grid } from './grid.js';
export type { GridCell, MoveContext, SightResult } from './grid.js';
export { resolveAttack, resolveAbilityTest } from './resolution.js';
export type {
  AttackContext,
  AttackModifiers,
  AttackResult,
  AbilityTestContext,
  AbilityTestResult,
} from './resolution.js';
export { TurnTracker } from './turn-tracker.js';
export type { TurnPhase, Side, CombatOrder } from './turn-tracker.js';
export {
  EffectRegistry,
  registerCoreEffects,
} from './effects.js';
export type {
  Effect,
  EffectKind,
  EffectChange,
  EffectContext,
  EffectResult,
} from './effects.js';
export { GameEngine } from './game-engine.js';
export type { GameEngineConfig, ActionOk } from './game-engine.js';
export { loadCatalogs } from './load.js';
export type { Catalogs } from './load.js';
export { loadAdventure } from './adventure.js';
export type { Adventure, Scene } from './adventure.js';
export { buildSceneGrid } from './scene-grid.js';
export {
  HeroEntrySchema,
  MonsterEntrySchema,
  ItemEntrySchema,
  EquipmentEntrySchema,
  BoonEntrySchema,
} from './catalogs.js';
export type {
  HeroEntry,
  MonsterEntry,
  ItemEntry,
  EquipmentEntry,
  BoonEntry,
} from './catalogs.js';

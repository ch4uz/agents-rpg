declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type CharacterId = Brand<string, 'CharacterId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type EquipmentId = Brand<string, 'EquipmentId'>;
export type BoonId = Brand<string, 'BoonId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type SceneId = Brand<string, 'SceneId'>;
export type EffectId = Brand<string, 'EffectId'>;
export type AdventureId = Brand<string, 'AdventureId'>;
export type RunId = Brand<string, 'RunId'>;

export const asCharacterId = (s: string): CharacterId => s as CharacterId;
export const asItemId = (s: string): ItemId => s as ItemId;
export const asEquipmentId = (s: string): EquipmentId => s as EquipmentId;
export const asBoonId = (s: string): BoonId => s as BoonId;
export const asSkillId = (s: string): SkillId => s as SkillId;
export const asSceneId = (s: string): SceneId => s as SceneId;
export const asEffectId = (s: string): EffectId => s as EffectId;
export const asAdventureId = (s: string): AdventureId => s as AdventureId;
export const asRunId = (s: string): RunId => s as RunId;

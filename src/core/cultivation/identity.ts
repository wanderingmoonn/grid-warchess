// 各种身份认定
import type { GameState, Unit, UnitTypeDef } from '../types.ts';

/**
 * 本扩展所有兵种的 id。
 *
 * 以前这批字符串有两个副本：`units.ts` 里每个 `id:` 写一遍，这里再用一个 Set
 * 写一遍。改 id 要记得改两处，漏一处就是"这个兵种既存在又不被当成修士"。
 * 现在只有这一份，`units.ts` 的 `id:` / `builds:` 全部引用它。
 */
export const UNIT_IDS = {
  QI_CULTIVATOR: 'qi-cultivator',
  SWORD_CULTIVATOR: 'sword-cultivator',
  BODY_CULTIVATOR: 'body-cultivator',
  BLOOD_CULTIVATOR: 'blood-cultivator',
  SPIRIT: 'cultivator-spirit',
  SERVANT: 'cultivation-servant',
  DEACON: 'cultivation-deacon',
  STEWARD: 'cultivation-steward',
  SPIRIT_FIELD: 'cultivation-spirit-field',
  SPIRIT_MINE: 'cultivation-spirit-mine',
  SPIRIT_TOWER: 'cultivation-spirit-tower',
  SPIRIT_SPRING: 'cultivation-spirit-spring',
  SECT: 'cultivation-sect',
  SCRIPTURE_PAVILION: 'cultivation-scripture-pavilion',
  FORGE_1: 'cultivation-forge-1',
  FORGE_2: 'cultivation-forge-2',
  FORGE_3: 'cultivation-forge-3',
  ARTIFACT_WOOD: 'cultivation-artifact-wood',
  ARTIFACT_STONE: 'cultivation-artifact-stone',
  ARTIFACT_WATER: 'cultivation-artifact-water',
  ARTIFACT_FIRE: 'cultivation-artifact-fire',
  FORMATION_MASTER: 'cultivation-formation-master',
  FORMATION_MASTER_2: 'cultivation-formation-master-2',
  FORMATION_MASTER_3: 'cultivation-formation-master-3',
  KILL_FORMATION: 'cultivation-kill-formation',
  SEAL_FORMATION: 'cultivation-seal-formation',
  TELEPORT_FORMATION: 'cultivation-teleport-formation',
  GUARD_FORMATION: 'cultivation-guard-formation',
} as const;

// 修士身份判定
//
// 这是本扩展里**唯一**"认识具体兵种"的地方。以前每个钩子里都写了一遍
// `type === 'qi-cultivator'`，加一个流派要回来改十几处，漏一次就是
// "这个流派能修炼但不涨攻击"或"所有兵种都能修炼但不涨数值"。
//
// 判据用 id 集合，不用"带某条能力"：能力是机制（剑气、金身各有各的），
// 身份只是"这个兵种吃修炼规则"。两者今天一致，明天就不一定了。
//
// 加新流派 → 在 UNIT_IDS 加一行 id、在 CULTIVATOR_IDS 里也加一行；别的钩子一个字都不用改。
const CULTIVATOR_IDS: ReadonlySet<string> = new Set([
  UNIT_IDS.QI_CULTIVATOR,
  UNIT_IDS.SWORD_CULTIVATOR,
  UNIT_IDS.SPIRIT,
  UNIT_IDS.BODY_CULTIVATOR,
  UNIT_IDS.BLOOD_CULTIVATOR,
]);

/** 从兵种定义查。给"手里只有 def"的场合用。 */
export function isCultivatorDef(def: UnitTypeDef | undefined | null): boolean {
  return !!def && CULTIVATOR_IDS.has(def.id);
}

/** 从单位查。给钩子用——钩子里拿到的几乎都是 Unit。 */
export function isCultivatorUnit(s: GameState, u: Unit): boolean {
  return isCultivatorDef(s.unitTypes[u.type]);
}

/**
 * 是不是剑修，只给 type 字符串的版本。
 *
 * 和 `isCultivatorUnit` 的区别：那个要 state 才能查兵种定义，而
 * `getExpGrowth(u)` / `swordMul(u)` 手里只有 Unit，拿不到 state。
 * 剑修这一支的特殊规则（打坐减半、击杀翻倍、境界加成 ×0.8/×1.2）全走它。
 */
export function isSwordCultivatorType(type: string): boolean {
  return type === UNIT_IDS.SWORD_CULTIVATOR;
}

/**
 * 是不是体修。同上，只认 type 字符串。
 *
 * 体修的境界加成是"偏科"的（攻 ×1.1、真元/移动/射程 ×0.5），这些系数在
 * `stats.ts` 里按流派分支；身份判定留在这里，避免 stats 反过来import 兵种表。
 */
export function isBodyCultivatorType(type: string): boolean {
  return type === UNIT_IDS.BODY_CULTIVATOR;
}

/**
 * 是不是魔修。
 *
 * 魔修不吃"打坐"和"击杀历练"两条常规路（见 progression.ts 的 getExpGrowth
 * 与 hooks.ts 的 onUnitKilled），全部修为来自「血祭」——那条路的经验绕过了
 * 每回合击杀上限，所以它不能同时再吃一份击杀经验，否则节奏直接翻倍。
 */
export function isBloodCultivatorType(type: string): boolean {
  return type === UNIT_IDS.BLOOD_CULTIVATOR;
}

export function isSpirit(u: Unit): boolean {
  return u.type === UNIT_IDS.SPIRIT;
}

/**
 * 「灵体道果」的最低境界：达到它才会"死而不灭"，跌破它就会失去这份道果。
 *
 * 放在 identity.ts 是因为它有四个消费者，而且分属三层：
 *   · unlocks.ts（几级解锁）、abilities/spirit-ascension.ts（几级才能化灵）、
 *     progression.ts 的 cleanupAfterRankDrop（几级以下要收回去）、规则书正文。
 * 以前这四处各写一个 `4`，改一次要回来找四遍——正是文档和代码对不上的典型来源。
 */
export const SPIRIT_ASCENSION_RANK = 4;

/**
 * 「异象」的能力 id。
 *
 * 放在 identity.ts 而不是 abilities/anomaly.ts，是因为 **progression.ts 要用它**：
 * 突破战报公开与否，取决于"身上有没有这个标记"。而 progression 比 abilities
 * 更底层，反过来 import 会成环。这里只放一个字符串 id——progression 只问
 * "有没有"，不知道异象是什么、怎么生效。
 */
export const ANOMALY_ABILITY_ID = 'anomaly';

/** 未来魂修集合：化灵后不吃削弱 */
const SOUL_MASTER_IDS = new Set<string>();

export function isSoulMasterSpirit(u: Unit): boolean {
  if (!isSpirit(u)) return false;
  const origin = u.custom?.originType as string | undefined;
  return !!origin && SOUL_MASTER_IDS.has(origin);
}

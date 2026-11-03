// 各种身份认定
import type { GameState, Unit, UnitTypeDef } from '../types.ts';

// 修士身份判定 
//
// 这是本扩展里**唯一**"认识具体兵种"的地方。以前每个钩子里都写了一遍
// `type === 'qi-cultivator'`，十二处硬编码：加一个流派要回来改十二次，
// 漏一次就是"这个流派能修炼但不涨攻击"或"所有兵种都能修炼但不涨数值"。
//
// 判据用 id 集合，不用"带某条能力"：能力是机制（剑气、金身各有各的），
// 身份只是"这个兵种吃修炼规则"。两者今天一致，明天就不一定了。
//
// 加新流派 → 在 CULTIVATOR_IDS 里加一行 id；**别的钩子一个字都不用改**。
const CULTIVATOR_IDS = new Set([
  'qi-cultivator', 
  'sword-cultivator'
]);

/** 从兵种定义查。给"手里只有 def"的场合用。 */
export function isCultivatorDef(def: UnitTypeDef | undefined | null): boolean {
  return !!def && CULTIVATOR_IDS.has(def.id);
}

/** 从单位查。给钩子用——钩子里拿到的几乎都是 Unit。 */
export function isCultivatorUnit(s: GameState, u: Unit): boolean {
  return isCultivatorDef(s.unitTypes[u.type]);
}

export function isSpirit(u: Unit): boolean {
  return u.type === 'cultivator-spirit';
}
/** 未来魂修集合：化灵后不吃削弱 */
const SOUL_MASTER_IDS = new Set<string>();

export function isSoulMasterSpirit(u: Unit): boolean {
  if (!isSpirit(u)) return false;
  const origin = u.custom?.originType as string | undefined;
  return !!origin && SOUL_MASTER_IDS.has(origin);
}
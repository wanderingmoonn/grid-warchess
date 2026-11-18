/**
 * 簇 E 绝学的两个状态（放在这一层，是因为**骨架**要读它们）。
 *
 * 「虚无生道」的续气发生在付灵力那一步（`paySpellCost`），而骨架不能反过来
 * import 一个 spells 文件（那会成环）。所以状态键与续气逻辑放在这里，
 * `skills/legacy.ts` 只管写状态。
 */
import { registerStatus } from '../statuses.ts';
import type { Unit } from '../types.ts';
import { manaOf, maxManaOf, setMana } from './mana.ts';

/** 沉默：嘴被封住，能走能打，念不出法术 */
export const SILENCE_STATUS = 'spell-silence';
/** 虚无生道：灵力见底时自己续上 */
export const VOID_STATUS = 'spell-void';

registerStatus({ id: SILENCE_STATUS, name: '沉默', summary: '嘴被封住：能走能打，念不出法术' });
registerStatus({ id: VOID_STATUS, name: '虚无生道', summary: '灵力见底时会自己续上' });

/**
 * 灵力见底时"续一口气"：每回合最多一次。
 *
 * 为什么按回合去重：不去重的话，一次施法扣到 0 就补满、再扣再补，
 * 等于无限灵力——那不是"吊着一口气"，那是把灵力池删了。
 */
export function tryVoidRefill(u: Unit, turn: number): boolean {
  if (((u.status?.[VOID_STATUS] ?? 0) as number) <= 0) return false;
  if (manaOf(u) > 0) return false;
  const key = 'voidRefillTurn';
  if (u.custom?.[key] === turn) return false;
  setMana(u, maxManaOf(u));
  u.custom = { ...(u.custom ?? {}), [key]: turn };
  return true;
}

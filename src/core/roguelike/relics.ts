/**
 * 遗物：拿到就生效（2026-11-19）。
 *
 * 在这之前 `run.relics` 只是记了个名字——面板上写"遗物 1"，实际什么都不发生。
 * 这个文件是"遗物 → 具体数值"的唯一解释处。
 *
 * **兵额类遗物已删除**（2026-11-21，用户定）：兵额 = 城格数，是"空间就是名额"
 * 这条规则本身。再加一个"驮马 +2"就等于绕过几何给一个凭空名额，和"城里挤满了
 * 就得选"的设计正面冲突——所以删掉，不留任何改变兵额的入口。
 * 瞭望（视野 +1）、工事（每场免费修城）要等对应系统接上，先不做。
 */

import type { RunState } from './run-state.ts';

export type RelicId = 'ironwall' | 'horn' | 'arsenal' | 'miser';

export interface RelicDef {
  id: RelicId;
  name: string;
  /** 面板与结算里显示的一句话 */
  blurb: string;
}

export const RELICS: readonly RelicDef[] = [
  { id: 'ironwall', name: '铁壁', blurb: '每场开局，你的城防 +2' },
  { id: 'horn', name: '号角', blurb: '第 1 关开局，城里多 2 个民兵' },
  { id: 'arsenal', name: '军械', blurb: '带回来的兵一律满血（不用再花整备修）' },
  { id: 'miser', name: '吝啬鬼', blurb: '三选一「不选拿钱」翻倍（80 → 160）' },
];

export const RELIC_BY_ID: Record<string, RelicDef> = Object.fromEntries(
  RELICS.map((r) => [r.id, r]),
) as Record<string, RelicDef>;

export function hasRelic(run: RunState, id: RelicId): boolean {
  return run.relics.includes(id);
}

/** 城防加成（`createMatch` 之后加到城里） */
export function cityArmorBonus(run: RunState): number {
  return hasRelic(run, 'ironwall') ? 2 : 0;
}

/** 号角：只在第 1 关给一次免费的援军 */
export function hornFreebies(run: RunState): number {
  return hasRelic(run, 'horn') ? 2 : 0;
}

/** 军械：带回来的兵要不要按上限回满 */
export function healsIntake(run: RunState): boolean {
  return hasRelic(run, 'arsenal');
}

/** 吝啬鬼：不选拿钱的金额 */
export function skipMoney(run: RunState): number {
  return hasRelic(run, 'miser') ? 160 : 80;
}

/** 把遗物名字拼成一句（面板/结算用） */
export function relicNames(run: RunState): string[] {
  return run.relics.map((id) => RELIC_BY_ID[id]?.name ?? id);
}

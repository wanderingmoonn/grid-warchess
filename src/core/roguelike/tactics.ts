/**
 * 战术卡：三选一里那 30%（2026-11-19）。
 *
 * 和兵种卡的区别：兵种卡是**永久强化**（进卡池、能造、能升级），
 * 战术卡是**一次性道具**——拿到就进背包，用掉的回合就没了。
 *
 * 为什么先只做三张：每一张都要有一套"效果落在哪"的接线，
 * 宁可三张都真正跑通，也不要摊十张半成品。
 */

import type { RunState } from './run-state.ts';

export type TacticId = 'supply' | 'airdrop' | 'repair';

export interface TacticDef {
  id: TacticId;
  name: string;
  /** 面板上的一句话说明（玩家只看这一行决定拿不拿） */
  blurb: string;
}

export const TACTICS: readonly TacticDef[] = [
  {
    id: 'supply',
    name: '补给令',
    blurb: '立刻到手 120 金（本关结算之外的一笔）',
  },
  {
    id: 'airdrop',
    name: '空投援军',
    blurb: '下一关开局，城里多两个民兵（不占兵额，当"临时工")',
  },
  {
    id: 'repair',
    name: '战地修整',
    blurb: '花名册全员立刻回满血（和整备关的"修整部队"同效，但不占整备次数）',
  },
];

export const TACTIC_BY_ID: Record<string, TacticDef> = Object.fromEntries(
  TACTICS.map((t) => [t.id, t]),
) as Record<string, TacticDef>;

/** 兵种卡与战术卡的抽取比例：每三次三选一，约有一次带一张战术卡 */
export const TACTIC_RATE = 0.3;

/**
 * 立刻生效的那两张（补给 / 修整）。
 *
 * `airdrop` 不在这里——它要等到下一关建局时才落地，所以由 `startRogueStage` 消费。
 * 返回一句给玩家看的回执，面板直接显示。
 */
export function applyTacticNow(id: TacticId, run: RunState, maxHpOf: (type: string) => number): string {
  if (id === 'supply') {
    run.gold += 120;
    return '补给到账：+120 金';
  }
  if (id === 'repair') {
    run.roster = run.roster.map((u) => ({ ...u, hp: maxHpOf(u.type) }));
    return `战地修整：${run.roster.length} 人回满血`;
  }
  // airdrop 留在背包里，下一关建局时消费
  if (!run.tactics.includes(id)) run.tactics.push(id);
  return '空投援军已备好，下一关开局生效';
}

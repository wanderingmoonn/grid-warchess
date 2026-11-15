/**
 * 簇 A · 时间与序列（`effect: 'sequence'`）——**先做不需要新地基的四条**。
 *
 * ── 这一批为什么只做四条 ────────────────────────────────────────
 *
 * 簇 A 八条的共同点是"单位暂时不在场，但状态要保住"。作者 2026-11-14 的说法
 * 点破了两个不能凑合的地方：
 *   · **`hideUnit` 不是"消失"**：藏起来的单位仍然会挡寻路，别人会绕过去。
 *     烂柯棋局要的是"这地方空了"，那是另一种机制；
 *   · **虚空放逐的"阴世界"更像一张双生的新地图**，作者后面还有法术要用它。
 *
 * 所以这一批先把**不依赖那两样**的四条做掉：
 *
 *   一颗金丹     行动经济重置（把已走/已打/已花的额度还回来）
 *   缩地成寸     记一个落点，下一回合开始瞬移过去
 *   天外飞仙     蓄力一回合，下回合移动力拉满
 *   苍蜣登阶     每 5 回合检定一次，过关就长修为
 *
 * 天衍四九（回档）虽然不涉及隐藏单位，但它要"存整个 state 再恢复"，
 * 而且刚定了"回档不进回放"，属于要单独想清楚的一条，留到最后。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { registerStatus } from '../../statuses.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export interface SequenceParams extends Record<string, unknown> {
  mode: 'reset' | 'step' | 'immortal' | 'beetle';
  /** 苍蜣登阶：持续几回合 */
  rounds?: number;
  /** 苍蜣登阶：每次检定得多少修为 */
  expPerCheck?: number;
}

// ── 状态 ──────────────────────────────────────────
export const BEETLE_STATUS = 'spell-beetle';
registerStatus({ id: BEETLE_STATUS, name: '苍蜣登阶', summary: '每 5 回合检定一次，过关长修为' });

/** 缩地成寸记下的落点 */
export interface StepMark {
  x: number;
  y: number;
}

/** 天外飞仙的蓄力标记 */
export const FEI_XIAN_KEY = 'feiXianCharge';

// ── 数据行 ────────────────────────────────────────
export const YI_KE_JIN_DAN_COST = 80;
export const YI_KE_JIN_DAN_MIN_RANK = 5;
const YI_KE_JIN_DAN: SpellRow = {
  id: 'yi-ke-jin-dan',
  name: '一颗金丹',
  summary:
    '把这一回合的行动额度**全部还回来**：已走當作没走、已出手当作没出手、移动力与攻击次数回满；' +
    `每场战斗只能用一次（用掉就没了）；耗 ${YI_KE_JIN_DAN_COST} 灵力。`,
  effect: 'sequence',
  cost: YI_KE_JIN_DAN_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'reset' } satisfies SequenceParams,
};

export const SUO_DI_CHENG_CUN_COST = 60;
export const SUO_DI_CHENG_CUN_MIN_RANK = 3;
const SUO_DI_CHENG_CUN: SpellRow = {
  id: 'suo-di-cheng-cun',
  name: '缩地成寸',
  summary: `射程 6 格：记一个落点，**下一个自己的回合开始时**瞬移过去（不管中间隔着什么）；耗 ${SUO_DI_CHENG_CUN_COST} 灵力。`,
  effect: 'sequence',
  cost: SUO_DI_CHENG_CUN_COST,
  range: 6,
  preview: 'ring',
  custom: { mode: 'step' } satisfies SequenceParams,
};

export const TIAN_WAI_FEI_XIAN_COST = 90;
export const TIAN_WAI_FEI_XIAN_MIN_RANK = 5;
const TIAN_WAI_FEI_XIAN: SpellRow = {
  id: 'tian-wai-fei-xian',
  name: '天外飞仙',
  summary: `蓄力一回合（当回合不能行动），**下一个自己的回合**移动力拉满；耗 ${TIAN_WAI_FEI_XIAN_COST} 灵力。`,
  effect: 'sequence',
  cost: TIAN_WAI_FEI_XIAN_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'immortal' } satisfies SequenceParams,
};

export const CANG_QIANG_DENG_JIE_COST = 70;
export const CANG_QIANG_DENG_JIE_MIN_RANK = 4;
export const CANG_QIANG_DENG_JIE_ROUNDS = 10;
export const CANG_QIANG_DENG_JIE_EXP = 15;
export const CANG_QIANG_DENG_JIE_EVERY = 5;
const CANG_QIANG_DENG_JIE: SpellRow = {
  id: 'cang-qiang-deng-jie',
  name: '苍蜣登阶',
  summary:
    `接下来 ${CANG_QIANG_DENG_JIE_ROUNDS} 回合，每 ${CANG_QIANG_DENG_JIE_EVERY} 回合检定一次：` +
    `还活着就 +${CANG_QIANG_DENG_JIE_EXP} 修为；耗 ${CANG_QIANG_DENG_JIE_COST} 灵力。`,
  effect: 'sequence',
  cost: CANG_QIANG_DENG_JIE_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    mode: 'beetle',
    rounds: CANG_QIANG_DENG_JIE_ROUNDS,
    expPerCheck: CANG_QIANG_DENG_JIE_EXP,
  } satisfies SequenceParams,
};

export const SEQUENCE_ROWS: readonly SpellRow[] = [
  YI_KE_JIN_DAN,
  SUO_DI_CHENG_CUN,
  TIAN_WAI_FEI_XIAN,
  CANG_QIANG_DENG_JIE,
];

export const YI_KE_JIN_DAN_SKILL = defineSpellSkill(YI_KE_JIN_DAN);
export const SUO_DI_CHENG_CUN_SKILL = defineSpellSkill(SUO_DI_CHENG_CUN);
export const TIAN_WAI_FEI_XIAN_SKILL = defineSpellSkill(TIAN_WAI_FEI_XIAN);
export const CANG_QIANG_DENG_JIE_SKILL = defineSpellSkill(CANG_QIANG_DENG_JIE);

registerManaReady(SEQUENCE_ROWS);
registerPreview(SEQUENCE_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('sequence', (c) => {
  const p = spellCustom<SequenceParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  // ① 一颗金丹：一整局只能用一次，所以先查"用没用过"
  if (p.mode === 'reset') {
    if (self.custom?.['jinDanUsed'] === true) {
      c.result.ok = false;
      c.result.reason = '这一颗金丹已经用掉了（整场只能吞一次）';
      return;
    }
    if (!paySpellCost(c, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }
    self.moved = false;
    self.acted = false;
    self.moveSpent = 0;
    self.attacksLeft = c.api.attacksPerTurn(s, self);
    self.custom = { ...(self.custom ?? {}), jinDanUsed: true };
    c.result.log = `${name}吞下一颗金丹：行动额度尽数回还（整场只能用一次）`;
    return;
  }

  // ② 天外飞仙：先蓄力，下一回合给移动力
  if (p.mode === 'immortal') {
    if (!paySpellCost(c, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }
    self.custom = { ...(self.custom ?? {}), [FEI_XIAN_KEY]: 1 };
    c.result.log = `${name}施放${skillName}：蓄力一回合，下一回合可一步千里`;
    return;
  }

  // ③ 苍蜣登阶：挂状态，检定在 hooks.onTurnStart
  if (p.mode === 'beetle') {
    if (!paySpellCost(c, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }
    self.status = { ...(self.status ?? {}), [BEETLE_STATUS]: Number(p.rounds ?? 10) };
    self.custom = { ...(self.custom ?? {}), beetleExp: Number(p.expPerCheck ?? 15) };
    c.result.log = `${name}施放${skillName}：登阶之路开始，每 5 回合检定一次`;
    return;
  }

  // ④ 缩地成寸：记落点，下一回合开始瞬移
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '选一个落点';
    return;
  }
  if (Math.abs(self.x - t.x) + Math.abs(self.y - t.y) > range) {
    c.result.ok = false;
    c.result.reason = `太远了（${skillName}射程 ${range} 格）`;
    return;
  }
  if (!c.api.canStandAt(c.view, t.x, t.y, self.type, { ignoreUnits: true })) {
    c.result.ok = false;
    c.result.reason = '那里站不住';
    return;
  }
  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }
  self.custom = {
    ...(self.custom ?? {}),
    suoDi: { x: t.x, y: t.y } satisfies StepMark,
  };
  c.result.log = `${name}施放${skillName}：落点已定（${t.x},${t.y}），下一回合踏出即到`;
});

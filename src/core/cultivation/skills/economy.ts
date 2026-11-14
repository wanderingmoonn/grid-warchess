/**
 * 族 9 · 资源经济（`effect: 'economy'`）：把场上的一份额度换成修为。
 *
 * ── 这一族只有两条，为什么还单开 ──────────────────────────────────
 *
 * 因为它们共用同一件事：**"某样东西 → 修为"的兑换**。
 * 炼灵抽脚下灵气换修为（和吐纳抢同一口灵气），行万里把本回合走过的路换成修为。
 * 以后再来"香火→修为""灵石→修为"也只是换一个 `mode`。
 *
 * ── 和吐纳术的分界 ────────────────────────────────────────────────
 *
 * 吐纳术是**成长**（慢慢攒），炼灵是**变现**（一次抽干、立刻到账）。
 * 两者抢同一口灵气，所以炼灵抽完，脚下这一格这一回合的吐纳也就没得抽了。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import { addExp } from '../progression.ts';
import { drainQiAt, qiAt } from '../qi-field.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 参数 ──────────────────────────────────────────
export interface EconomyParams extends Record<string, unknown> {
  /** `qi` = 抽灵气换修为；`move` = 把本回合走过的路换修为 */
  mode: 'qi' | 'move';
  /** 抽走脚下灵气的比例（`qi` 用） */
  drainRatio?: number;
  /** 每点灵气换多少修为 */
  expPerQi?: number;
  /** 每走一格换多少修为（`move` 用） */
  expPerMove?: number;
  /** 单次最多换多少修为（防止一格满灵气直接送一级） */
  capExp?: number;
}

// ── 数据行 ────────────────────────────────────────
export const LIAN_LING_COST = 40;
export const LIAN_LING_MIN_RANK = 2;
export const LIAN_LING_DRAIN = 0.5;
export const LIAN_LING_EXP_PER_QI = 2;
export const LIAN_LING_CAP = 40;
const LIAN_LING: SpellRow = {
  id: 'lian-ling',
  name: '炼灵',
  summary:
    `抽走脚下 ${Math.round(LIAN_LING_DRAIN * 100)}% 的灵气，每点换 ${LIAN_LING_EXP_PER_QI} 点修为，` +
    `单次最多 ${LIAN_LING_CAP} 点；耗 ${LIAN_LING_COST} 灵力。`,
  effect: 'economy',
  cost: LIAN_LING_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    mode: 'qi',
    drainRatio: LIAN_LING_DRAIN,
    expPerQi: LIAN_LING_EXP_PER_QI,
    capExp: LIAN_LING_CAP,
  } satisfies EconomyParams,
};

export const XING_WAN_LI_COST = 30;
export const XING_WAN_LI_MIN_RANK = 2;
export const XING_WAN_LI_EXP_PER_MOVE = 3;
export const XING_WAN_LI_CAP = 30;
const XING_WAN_LI: SpellRow = {
  id: 'xing-wan-li',
  name: '行万里',
  summary:
    `把本回合走过的每一格换成 ${XING_WAN_LI_EXP_PER_MOVE} 点修为（单次最多 ${XING_WAN_LI_CAP} 点）；` +
    `耗 ${XING_WAN_LI_COST} 灵力。`,
  effect: 'economy',
  cost: XING_WAN_LI_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    mode: 'move',
    expPerMove: XING_WAN_LI_EXP_PER_MOVE,
    capExp: XING_WAN_LI_CAP,
  } satisfies EconomyParams,
};

export const ECONOMY_ROWS: readonly SpellRow[] = [LIAN_LING, XING_WAN_LI];
export const LIAN_LING_SKILL = defineSpellSkill(LIAN_LING);
export const XING_WAN_LI_SKILL = defineSpellSkill(XING_WAN_LI);

registerManaReady(ECONOMY_ROWS);
registerPreview(ECONOMY_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('economy', (c: SkillCtx) => {
  const p = spellCustom<EconomyParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  /*
   * 先确认"换得到东西"，再扣灵力。
   *
   * 顺序反过来就是"点了一下、灵力没了、什么都没换到"——这种最容易被当成 bug 报上来。
   */
  if (p.mode === 'qi') {
    if (qiAt(s, self.x, self.y) <= 0) {
      c.result.ok = false;
      c.result.reason = '脚下的灵气已经抽不出东西了';
      return;
    }
  } else if ((self.moveSpent ?? 0) <= 0) {
    c.result.ok = false;
    c.result.reason = '这一回合还没走过路';
    return;
  }

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  const cap = p.capExp ?? Infinity;
  let gained = 0;
  let detail = '';

  if (p.mode === 'qi') {
    const taken = drainQiAt(s, self.x, self.y, p.drainRatio ?? 0.5);
    gained = Math.min(cap, Math.floor(taken * (p.expPerQi ?? 1)));
    detail = `抽走 ${taken} 点灵气`;
  } else {
    /*
     * 行万里：把**本回合已走的格数**换成修为，然后把 `moveSpent` 清零。
     * 不清零就能反复点同一段路，等于"原地踏步刷修为"——那是漏洞不是设计。
     */
    const walked = self.moveSpent ?? 0;
    gained = Math.min(cap, walked * (p.expPerMove ?? 1));
    detail = `走过了 ${walked} 格`;
    self.moveSpent = 0;
  }

  addExp(self, s, gained);
  c.result.log = `${name}施放${skillName}：${detail}，修为 +${gained}（耗 ${cost} 灵力）`;
});

/**
 * 族 6 · 自身增益（`effect: 'buff'`）：把"我这一阵子更强"写进状态。
 *
 * ── 这一族的关键决定：数值放哪 ────────────────────────────────────
 *
 * 放 `Unit.custom.spellBuff`，**不放 `StatusDef`**。理由很具体：
 * `StatusDef` 的 `modifyAtk` 引擎根本没接（只有 `modifyMove/Armor/Vision` 会被调用），
 * 把"攻击 ×3"写进状态里，面板会显示加成、实际伤害一点不变——这种"看得见摸不着"
 * 的 bug 最难查。
 *
 * 现在的分工：
 *   · 状态 `spell-buff` 只负责**数回合**（引擎每回合自动 −1）；
 *   · 数值挂在 `custom.spellBuff`，由 `hooks.ts` 的钩子去读；
 *   · 状态一到期，钩子就读不到加成——不需要任何清理代码。
 *
 * ── 四条法术共用这一份实现 ──────────────────────────────────────
 *
 *   灵目术      视野 +2、射程 +1（看得到、够得着）
 *   体术        攻击伤害 ×3
 *   天魔解体大法 移动 +2、攻击次数 +1、溅射 +1，代价是当场掉四分之一血
 *   御风术      攻击伤害额外加「本回合移动格数」
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';

import { applySpellBuffs, type SpellBuffs } from '../spell-statuses.ts';
import {
  defineSpellSkill,
  registerManaReady,
  paySpellCost,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 族的参数 ──────────────────────────────────────
export interface BuffParams extends SpellBuffs, Record<string, unknown> {
  /** 持续几个自己的回合 */
  rounds: number;
  /** 施放代价：按生命上限的这个比例掉血（天魔解体） */
  hpPct?: number;
}

// ── 数据行 ────────────────────────────────────────
export const LING_MU_SHU_COST = 40;
export const LING_MU_SHU_MIN_RANK = 1;
export const LING_MU_SHU_ROUNDS = 2;
export const LING_MU_SHU_VISION = 2;
export const LING_MU_SHU_RANGE = 1;
const LING_MU_SHU: SpellRow = {
  id: 'ling-mu-shu',
  name: '灵目术',
  summary:
    `视野 +${LING_MU_SHU_VISION}、射程 +${LING_MU_SHU_RANGE}，持续 ${LING_MU_SHU_ROUNDS} 回合；耗 ${LING_MU_SHU_COST} 灵力。`,
  effect: 'buff',
  cost: LING_MU_SHU_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    rounds: LING_MU_SHU_ROUNDS,
    vision: LING_MU_SHU_VISION,
    range: LING_MU_SHU_RANGE,
  } satisfies BuffParams,
};

export const TI_SHU_COST = 60;
export const TI_SHU_MIN_RANK = 2;
export const TI_SHU_ROUNDS = 2;
export const TI_SHU_ATK_MUL = 3;
const TI_SHU: SpellRow = {
  id: 'ti-shu',
  name: '体术',
  summary: `攻击伤害 ×${TI_SHU_ATK_MUL}，持续 ${TI_SHU_ROUNDS} 回合；耗 ${TI_SHU_COST} 灵力。`,
  effect: 'buff',
  cost: TI_SHU_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    rounds: TI_SHU_ROUNDS,
    atkMul: TI_SHU_ATK_MUL,
  } satisfies BuffParams,
};

export const TIAN_MO_JIE_TI_COST = 70;
export const TIAN_MO_JIE_TI_MIN_RANK = 3;
export const TIAN_MO_JIE_TI_ROUNDS = 2;
export const TIAN_MO_JIE_TI_HP_PCT = 0.25;
const TIAN_MO_JIE_TI: SpellRow = {
  id: 'tian-mo-jie-ti',
  name: '天魔解体大法',
  summary:
    `当场失去四分之一生命上限，换来移动 +2、攻击次数 +1、溅射半径 +1，持续 ${TIAN_MO_JIE_TI_ROUNDS} 回合；` +
    `耗 ${TIAN_MO_JIE_TI_COST} 灵力。`,
  effect: 'buff',
  cost: TIAN_MO_JIE_TI_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    rounds: TIAN_MO_JIE_TI_ROUNDS,
    move: 2,
    attacks: 1,
    splash: 1,
    hpPct: TIAN_MO_JIE_TI_HP_PCT,
  } satisfies BuffParams,
};

export const YU_FENG_SHU_COST = 50;
export const YU_FENG_SHU_MIN_RANK = 2;
export const YU_FENG_SHU_ROUNDS = 3;
const YU_FENG_SHU: SpellRow = {
  id: 'yu-feng-shu',
  name: '御风术',
  summary:
    `攻击伤害额外加上「本回合移动格数」，持续 ${YU_FENG_SHU_ROUNDS} 回合；耗 ${YU_FENG_SHU_COST} 灵力。`,
  effect: 'buff',
  cost: YU_FENG_SHU_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    rounds: YU_FENG_SHU_ROUNDS,
    wind: true,
  } satisfies BuffParams,
};

export const BUFF_ROWS: readonly SpellRow[] = [LING_MU_SHU, TI_SHU, TIAN_MO_JIE_TI, YU_FENG_SHU];

export const LING_MU_SHU_SKILL = defineSpellSkill(LING_MU_SHU);
export const TI_SHU_SKILL = defineSpellSkill(TI_SHU);
export const TIAN_MO_JIE_TI_SKILL = defineSpellSkill(TIAN_MO_JIE_TI);
export const YU_FENG_SHU_SKILL = defineSpellSkill(YU_FENG_SHU);

registerManaReady(BUFF_ROWS);
registerPreview(BUFF_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('buff', (c: SkillCtx) => {
  const p = spellCustom<BuffParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  /*
   * 血量代价：按**生命上限**的比例扣，且**不会把自己扣死**。
   *
   * 为什么保底 1 点：天魔解体大法是"拼命"，不是"自杀"。让它可以把自己打死，
   * 玩家会以为这是个 bug（点了技能自己没了），而且它和"被反噬"的观感不一样。
   *
   * 走 `api.hurt(..., { attrition: true })` 而不是 `self.hp -=`：
   * 自伤也是扣血，该经过统一出口（那里还管致死清场与战报）；
   * `attrition` 表明它是内生损耗——不该被守御阵接走，也不该触发挨打钩子。
   */
  let paid = 0;
  if (p.hpPct && p.hpPct > 0) {
    const want = Math.round(c.api.maxHpOf(s, self) * p.hpPct);
    const actual = Math.max(0, Math.min(want, self.hp - 1));
    if (actual > 0) {
      c.api.hurt(s, self, actual, {
        attrition: true,
        logText: `${name}以 ${actual} 点生命为代价运转${skillName}`,
      });
      paid = actual;
    }
  }

  // 只把"数"传进去，`rounds` / `hpPct` 是这一族的参数，不属于加成本身
  const buffs: SpellBuffs = {
    atkMul: p.atkMul,
    move: p.move,
    vision: p.vision,
    range: p.range,
    attacks: p.attacks,
    splash: p.splash,
    wind: p.wind,
  };
  applySpellBuffs(self, Number(p.rounds ?? 1), buffs);

  const parts: string[] = [];
  if (buffs.atkMul) parts.push(`攻击 ×${buffs.atkMul}`);
  if (buffs.move) parts.push(`移动 +${buffs.move}`);
  if (buffs.attacks) parts.push(`攻击次数 +${buffs.attacks}`);
  if (buffs.splash) parts.push(`溅射 +${buffs.splash}`);
  if (buffs.vision) parts.push(`视野 +${buffs.vision}`);
  if (buffs.range) parts.push(`射程 +${buffs.range}`);
  if (buffs.wind) parts.push('攻击附带移动格数');
  c.result.log =
    `${name}施放${skillName}：${parts.join('、')}，持续 ${p.rounds} 回合` +
    (paid > 0 ? `，以 ${paid} 点生命为代价` : '') +
    `（耗 ${cost} 灵力）`;
});

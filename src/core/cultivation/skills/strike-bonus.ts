/**
 * 族 7 · 攻击附加（`effect: 'strikeBonus'`）：给**下一次命中**挂一个结算。
 *
 * ── 这一族管的是什么 ──────────────────────────────────────────────
 *
 * 三门法术都不直接造成伤害：它们先在身上挂一个"待结算"，等你下一次
 * 把伤害打进别人身上时才生效，生效一次就没了。
 *
 *   天予不取  按伤害从对方**偷灵石**
 *   炼化      把伤害**换成修为**，顺手回一点血
 *   溯因果    同一类型的**其他单位也挨同样一刀**
 *
 * ── 为什么结算点放在 `onUnitDamaged` ──────────────────────────────
 *
 * 那个钩子是"血真的掉了"之后调用的，能拿到**实际伤害**——偷多少灵石、
 * 换多少修为都该按实际掉血算，按"纸面伤害"算会让高甲单位变成提款机。
 *
 * ── 和草案的一处偏差（写清楚，别当成 bug）────────────────────────
 *
 * 草案写的是"持续到**下次普攻**为止"，实现是"**下一次造成伤害**为止"。
 * 原因：引擎里没有"这一下是普攻还是法术"的标记，法术和普攻走的是同一个
 * `hurtUnit`。要严格区分得再往核心加一个 `viaAttack` 字段，而修士的主要输出
 * 本来就是法术——按"下次造成伤害"算反而更符合这个包的手感。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

/** 待结算的那一下（挂在 `Unit.custom.pendingStrike`，随存档走） */
export interface PendingStrike {
  mode: 'steal' | 'refine' | 'cause';
  /** 偷/换的比例 */
  ratio: number;
}

export interface StrikeBonusParams extends Record<string, unknown> {
  mode: PendingStrike['mode'];
  ratio: number;
}

// ── 数据行 ────────────────────────────────────────
export const TIAN_YU_BU_QU_COST = 45;
export const TIAN_YU_BU_QU_MIN_RANK = 3;
export const TIAN_YU_BU_QU_RATIO = 2;
const TIAN_YU_BU_QU: SpellRow = {
  id: 'tian-yu-bu-qu',
  name: '天予不取',
  summary: `下一次造成伤害时，按伤害的 ${TIAN_YU_BU_QU_RATIO} 倍从对方阵营偷取灵石；耗 ${TIAN_YU_BU_QU_COST} 灵力。`,
  effect: 'strikeBonus',
  cost: TIAN_YU_BU_QU_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'steal', ratio: TIAN_YU_BU_QU_RATIO } satisfies StrikeBonusParams,
};

export const LIAN_HUA_COST = 50;
export const LIAN_HUA_MIN_RANK = 3;
export const LIAN_HUA_RATIO = 2;
export const LIAN_HUA_HEAL = 0.5;
export const LIAN_HUA: SpellRow = {
  id: 'lian-hua',
  name: '炼化',
  summary:
    `下一次造成伤害时，按伤害的 ${LIAN_HUA_RATIO} 倍获得修为，并回复伤害的一半生命；耗 ${LIAN_HUA_COST} 灵力。`,
  effect: 'strikeBonus',
  cost: LIAN_HUA_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'refine', ratio: LIAN_HUA_RATIO } satisfies StrikeBonusParams,
};

export const SU_YIN_GUO_COST = 60;
export const SU_YIN_GUO_MIN_RANK = 4;
const SU_YIN_GUO: SpellRow = {
  id: 'su-yin-guo',
  name: '溯因果',
  summary: `下一次造成伤害时，与该目标同类型的其他单位也受到同样的伤害；耗 ${SU_YIN_GUO_COST} 灵力。`,
  effect: 'strikeBonus',
  cost: SU_YIN_GUO_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'cause', ratio: 1 } satisfies StrikeBonusParams,
};

export const STRIKE_BONUS_ROWS: readonly SpellRow[] = [TIAN_YU_BU_QU, LIAN_HUA, SU_YIN_GUO];
export const TIAN_YU_BU_QU_SKILL = defineSpellSkill(TIAN_YU_BU_QU);
export const LIAN_HUA_SKILL = defineSpellSkill(LIAN_HUA);
export const SU_YIN_GUO_SKILL = defineSpellSkill(SU_YIN_GUO);

registerManaReady(STRIKE_BONUS_ROWS);
registerPreview(STRIKE_BONUS_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('strikeBonus', (c: SkillCtx) => {
  const p = spellCustom<StrikeBonusParams>(c);
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(c.state, self.type).name;

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  // 覆盖而不是叠加：两条待结算同时挂着，命中时该按哪个算？
  // 玩家看到的是"身上只有一层光"，叠着只会产生解释不清的 combo。
  self.custom = {
    ...(self.custom ?? {}),
    pendingStrike: { mode: p.mode, ratio: p.ratio } satisfies PendingStrike,
  };

  c.result.log = `${name}施放${skillName}，下一次造成伤害时生效（耗 ${cost} 灵力）`;
});

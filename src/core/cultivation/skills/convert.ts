/**
 * 族 10 · 转化 / 策反（`effect: 'convert'`）：把敌人的兵变成自己的兵。
 *
 * ── 五条法术是五种"什么时候变" ──────────────────────────────────
 *
 *   胎中之谜    埋下去，数够 N 个回合自己变
 *   心魔种道    他下一次受伤（也就是你打他的时候）立刻变
 *   血脉侵蚀    每回合按血量比例侵蚀，被侵蚀死的那一刻变
 *   酆都鬼蜮    在这片地上倒下的敌人，变成我方鬼卒
 *   道化魔染    站在染区里每回合被染一层，两层倒戈
 *
 * 共用的是"换主"那一下——走核心的 `convertUnit`（`c.api.convert`），
 * 它负责人人都该有的三件事：本回合不能再动、击杀额度清零、双方都写战报。
 * 直接改 `owner` 会漏掉这三条，而且漏了不会报错。
 *
 * ── 保什么 ──────────────────────────────────────────────────────
 *
 * 2026-11-14 作者定的口径：**境界、经验、寿元、学过的法术、随身丹药全保留**。
 * 策反一个高期修士就该是一笔巨大的战利品——这也让"该不该花这一发"变成一个
 * 真问题，而不是"反正只是换个旗子"。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { placeField } from './field.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  resolveCast,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export interface ConvertParams extends Record<string, unknown> {
  /** 什么时候变 */
  mode: 'delayed' | 'onHurt' | 'dot' | 'ghostRealm' | 'tint';
  /** delayed：埋几个回合 */
  turns?: number;
  /** dot：每回合侵蚀掉最大生命的多少 */
  pct?: number;
  /** 地面类（ghostRealm / tint）：留痕种类 id */
  markKind?: string;
}

// ── 数据行 ────────────────────────────────────────
export const TAI_ZHONG_ZHI_MI_COST = 90;
export const TAI_ZHONG_ZHI_MI_MIN_RANK = 4;
export const TAI_ZHONG_ZHI_MI_TURNS = 3;
const TAI_ZHONG_ZHI_MI: SpellRow = {
  id: 'tai-zhong-zhi-mi',
  name: '胎中之谜',
  summary: `射程 6 格：在一名敌人身上埋下谜团，${TAI_ZHONG_ZHI_MI_TURNS} 个回合后他倒戈；耗 ${TAI_ZHONG_ZHI_MI_COST} 灵力。`,
  effect: 'convert',
  cost: TAI_ZHONG_ZHI_MI_COST,
  range: 6,
  preview: 'ring',
  custom: { mode: 'delayed', turns: TAI_ZHONG_ZHI_MI_TURNS } satisfies ConvertParams,
};

export const XIN_MO_ZHONG_DAO_COST = 85;
export const XIN_MO_ZHONG_DAO_MIN_RANK = 3;
const XIN_MO_ZHONG_DAO: SpellRow = {
  id: 'xin-mo-zhong-dao',
  name: '心魔种道',
  summary: `射程 6 格：在一名敌人心里种下魔种，他**下一次受伤**时当场倒戈；耗 ${XIN_MO_ZHONG_DAO_COST} 灵力。`,
  effect: 'convert',
  cost: XIN_MO_ZHONG_DAO_COST,
  range: 6,
  preview: 'ring',
  custom: { mode: 'onHurt' } satisfies ConvertParams,
};

export const XUE_MAI_QIN_SHI_COST = 95;
export const XUE_MAI_QIN_SHI_MIN_RANK = 4;
export const XUE_MAI_QIN_SHI_PCT = 0.25;
const XUE_MAI_QIN_SHI: SpellRow = {
  id: 'xue-mai-qin-shi',
  name: '血脉侵蚀',
  summary:
    `射程 5 格：每回合侵蚀目标 ${Math.round(XUE_MAI_QIN_SHI_PCT * 100)}% 生命上限（不算挨打），` +
    `被侵蚀倒下时当场倒戈；耗 ${XUE_MAI_QIN_SHI_COST} 灵力。`,
  effect: 'convert',
  cost: XUE_MAI_QIN_SHI_COST,
  range: 5,
  preview: 'ring',
  custom: { mode: 'dot', pct: XUE_MAI_QIN_SHI_PCT } satisfies ConvertParams,
};

export const FENG_DU_GUI_YU_COST = 130;
export const FENG_DU_GUI_YU_MIN_RANK = 6;
export const FENG_DU_GUI_YU_RADIUS = 3;
const FENG_DU_GUI_YU: SpellRow = {
  id: 'feng-du-gui-yu',
  name: '酆都鬼蜮',
  summary:
    `射程 6 格、半径 ${FENG_DU_GUI_YU_RADIUS} 格铺成鬼蜮：在这片地上倒下的敌人不会死，` +
    `而是以半血变成我方鬼卒；耗 ${FENG_DU_GUI_YU_COST} 灵力。`,
  effect: 'convert',
  cost: FENG_DU_GUI_YU_COST,
  range: 6,
  preview: 'blast',
  radius: FENG_DU_GUI_YU_RADIUS,
  custom: { mode: 'ghostRealm', markKind: 'spell-ghost' } satisfies ConvertParams,
};

export const DAO_HUA_MO_RAN_COST = 120;
export const DAO_HUA_MO_RAN_MIN_RANK = 6;
export const DAO_HUA_MO_RAN_RADIUS = 2;
export const DAO_HUA_MO_RAN_LAYERS = 2;
const DAO_HUA_MO_RAN: SpellRow = {
  id: 'dao-hua-mo-ran',
  name: '道化魔染',
  summary:
    `射程 6 格、半径 ${DAO_HUA_MO_RAN_RADIUS} 格铺成染区：站在上面的敌人每回合被染一层，` +
    `积满 ${DAO_HUA_MO_RAN_LAYERS} 层就倒戈；耗 ${DAO_HUA_MO_RAN_COST} 灵力。`,
  effect: 'convert',
  cost: DAO_HUA_MO_RAN_COST,
  range: 6,
  preview: 'blast',
  radius: DAO_HUA_MO_RAN_RADIUS,
  custom: {
    mode: 'tint',
    markKind: 'spell-tint',
  } satisfies ConvertParams,
};

export const CONVERT_ROWS: readonly SpellRow[] = [
  TAI_ZHONG_ZHI_MI,
  XIN_MO_ZHONG_DAO,
  XUE_MAI_QIN_SHI,
  FENG_DU_GUI_YU,
  DAO_HUA_MO_RAN,
];

export const TAI_ZHONG_ZHI_MI_SKILL = defineSpellSkill(TAI_ZHONG_ZHI_MI);
export const XIN_MO_ZHONG_DAO_SKILL = defineSpellSkill(XIN_MO_ZHONG_DAO);
export const XUE_MAI_QIN_SHI_SKILL = defineSpellSkill(XUE_MAI_QIN_SHI);
export const FENG_DU_GUI_YU_SKILL = defineSpellSkill(FENG_DU_GUI_YU);
export const DAO_HUA_MO_RAN_SKILL = defineSpellSkill(DAO_HUA_MO_RAN);

registerManaReady(CONVERT_ROWS);
registerPreview(CONVERT_ROWS);

// ── 单位身上挂的那几种标记（hooks 读它们）──────────
export interface ConvertIn {
  turns: number;
  to: string;
}
export interface ConvertOnHurt {
  to: string;
}
export interface Erode {
  pct: number;
  to: string;
}
export interface TintMark {
  to: string;
  layers: number;
}

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('convert', (c) => {
  const p = spellCustom<ConvertParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const radius = Number(p.spellRadius ?? 0);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  // 地面类：直接铺场，不挑人（谁站上去谁挨）
  if (p.mode === 'ghostRealm' || p.mode === 'tint') {
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
    if (!paySpellCost(c, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }
    const placed = placeField(s, c.view, {
      owner: self.owner,
      kind: p.markKind ?? 'spell-tint',
      center: t,
      radius,
      dmg: 0,
    });
    c.api.noteHeat(s, t.x, t.y);
    c.result.log = `${name}施放${skillName}：${placed} 格化为${p.mode === 'ghostRealm' ? '鬼蜮' : '染区'}（耗 ${cost} 灵力）`;
    return;
  }

  // 单体类：必须点到一个敌方单位
  const cast = resolveCast(c, {
    cost,
    range,
    mode: 'single',
    rangeFrom: 'victim',
    noTargetReason: () => '选一个目标',
    noUnitReason: () => '那一格没有单位',
    allyReason: (ctx, victim) => `不能对自己人用${skillName}（${ctx.api.utype(ctx.state, victim.type).name}）`,
    tooFarReason: () => `太远了（${skillName}射程 ${range} 格）`,
  });
  if (!cast.ok) {
    c.result.ok = false;
    c.result.reason = cast.reason;
    return;
  }

  const victim = cast.victims[0]!;
  const custom = { ...(victim.custom ?? {}) };
  if (p.mode === 'delayed') {
    custom['convertIn'] = { turns: Number(p.turns ?? 1), to: self.owner } satisfies ConvertIn;
  } else if (p.mode === 'onHurt') {
    custom['convertOnHurt'] = { to: self.owner } satisfies ConvertOnHurt;
  } else {
    custom['erode'] = { pct: Number(p.pct ?? 0.2), to: self.owner } satisfies Erode;
  }
  victim.custom = custom;

  const vName = c.api.utype(s, victim.type).name;
  const when =
    p.mode === 'delayed'
      ? `${p.turns} 个回合后倒戈`
      : p.mode === 'onHurt'
        ? '下次受伤时倒戈'
        : '每回合被侵蚀，倒下时倒戈';
  c.result.log = `${name}施放${skillName}：${vName} 中了术，${when}（耗 ${cost} 灵力）`;
});

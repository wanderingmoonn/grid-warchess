/**
 * 簇 B · 记录与延迟处决（`effect: 'record'`）+ 呼名落马术。
 *
 * ── 三条都要"玩家先给一个值" ──────────────────────────────────────
 *
 *   钉头七箭书   填一个数字（猜他的年龄）
 *   呼名落马术   填一个名字（兵种名）
 *   斩仙飞刀     不用填，但要先**记录**三回合
 *
 * 前两条就是 G5（输入通道）存在的理由：`SkillDef.input` 声明要填什么，
 * 面板自动多一个输入框，规则层在动手之前拒绝空值（见 `doHeroSkill`）。
 *
 * ── 斩仙飞刀的"记录"是什么 ──────────────────────────────────────
 *
 * 草案写的是"记录 3 回合，9 的倍数回合清空直线"，后半句依赖一个全图回合计数
 * 和"直线"的形状，这两样都没有明确口径。这里的实现只保留前半句：
 * **记下目标当时的位置，三回合后刀落**；目标挪开了就落空。
 * 这样"记录"是真的有意义（跑不跑得掉），而不是一个纯延迟的伤害。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { getRank } from '../progression.ts';
import { rootFor } from '../spell-statuses.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  resolveCast,
  spellCustom,
  strike,
  type SpellRow,
} from '../spell-kernel.ts';

export interface RecordParams extends Record<string, unknown> {
  mode: 'knife' | 'arrow' | 'name';
  /** knife：记几个回合 */
  turns?: number;
  /** 基础伤害 */
  base?: number;
  /** 每层境界加成 */
  perRank?: number;
  /** 定身回合 */
  root?: number;
}

/** 斩仙飞刀记下的那一刀（挂在目标身上，随存档走） */
export interface KnifeMark {
  turns: number;
  by: string;
  x: number;
  y: number;
  /** 落刀时按施法那一刻的境界算好的伤害（施法者中途死了也照砍） */
  dmg: number;
}

export function knifeMarkOf(u: {
  custom?: Record<string, unknown>;
}): KnifeMark | undefined {
  return u.custom?.['feiDao'] as KnifeMark | undefined;
}

// ── 数据行 ────────────────────────────────────────
export const ZHAN_XIAN_FEI_DAO_COST = 95;
export const ZHAN_XIAN_FEI_DAO_MIN_RANK = 5;
export const ZHAN_XIAN_FEI_DAO_TURNS = 3;
export const ZHAN_XIAN_FEI_DAO_BASE = 40;
export const ZHAN_XIAN_FEI_DAO_PER_RANK = 10;
const ZHAN_XIAN_FEI_DAO: SpellRow = {
  id: 'zhan-xian-fei-dao',
  name: '斩仙飞刀',
  summary:
    `射程 6 格：记下目标此刻的位置，${ZHAN_XIAN_FEI_DAO_TURNS} 回合后刀落，` +
    `造成 ${ZHAN_XIAN_FEI_DAO_BASE} + 境界×${ZHAN_XIAN_FEI_DAO_PER_RANK} 点真伤；` +
    `他要是挪开一格以上就落空；耗 ${ZHAN_XIAN_FEI_DAO_COST} 灵力。`,
  effect: 'record',
  cost: ZHAN_XIAN_FEI_DAO_COST,
  range: 6,
  preview: 'ring',
  custom: {
    mode: 'knife',
    turns: ZHAN_XIAN_FEI_DAO_TURNS,
    base: ZHAN_XIAN_FEI_DAO_BASE,
    perRank: ZHAN_XIAN_FEI_DAO_PER_RANK,
  } satisfies RecordParams,
};

export const DING_TOU_QI_JIAN_COST = 90;
export const DING_TOU_QI_JIAN_MIN_RANK = 4;
export const DING_TOU_QI_JIAN_BASE = 50;
export const DING_TOU_QI_JIAN_PER_RANK = 12;
/** 猜错也留一点伤害：不然这一发在信息不足时永远不该点 */
export const DING_TOU_QI_JIAN_MISS_RATIO = 0.2;
const DING_TOU_QI_JIAN: SpellRow = {
  id: 'ding-tou-qi-jian-shu',
  name: '钉头七箭书',
  summary:
    `射程 6 格：**猜目标的年龄**（填数字）。猜中就造成 ${DING_TOU_QI_JIAN_BASE} + 境界×${DING_TOU_QI_JIAN_PER_RANK} 点真伤并定身 2 回合；` +
    `猜错只受两成伤害；耗 ${DING_TOU_QI_JIAN_COST} 灵力。`,
  effect: 'record',
  cost: DING_TOU_QI_JIAN_COST,
  range: 6,
  preview: 'ring',
  input: { kind: 'number', label: '猜他的年龄（岁）', placeholder: '比如 24' },
  custom: {
    mode: 'arrow',
    base: DING_TOU_QI_JIAN_BASE,
    perRank: DING_TOU_QI_JIAN_PER_RANK,
    root: 2,
  } satisfies RecordParams,
};

export const HU_MING_LUO_MA_COST = 80;
export const HU_MING_LUO_MA_MIN_RANK = 4;
export const HU_MING_LUO_MA_BASE = 12;
export const HU_MING_LUO_MA_PER_RANK = 3;
const HU_MING_LUO_MA: SpellRow = {
  id: 'hu-ming-luo-ma-shu',
  name: '呼名落马术',
  summary:
    `**报一个兵种名**（填文字）：全图上所有该兵种的敌人被呼名落马，受 ${HU_MING_LUO_MA_BASE} + 境界×${HU_MING_LUO_MA_PER_RANK} 点伤害并定身 1 回合；` +
    `一个都没叫中就空放（不扣灵力）；耗 ${HU_MING_LUO_MA_COST} 灵力。`,
  effect: 'record',
  cost: HU_MING_LUO_MA_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  input: { kind: 'text', label: '报一个兵种名（如 民兵）', placeholder: '民兵' },
  custom: {
    mode: 'name',
    base: HU_MING_LUO_MA_BASE,
    perRank: HU_MING_LUO_MA_PER_RANK,
    root: 1,
  } satisfies RecordParams,
};

export const RECORD_ROWS: readonly SpellRow[] = [
  ZHAN_XIAN_FEI_DAO,
  DING_TOU_QI_JIAN,
  HU_MING_LUO_MA,
];

export const ZHAN_XIAN_FEI_DAO_SKILL = defineSpellSkill(ZHAN_XIAN_FEI_DAO);
export const DING_TOU_QI_JIAN_SKILL = defineSpellSkill(DING_TOU_QI_JIAN);
export const HU_MING_LUO_MA_SKILL = defineSpellSkill(HU_MING_LUO_MA);

registerManaReady(RECORD_ROWS);
registerPreview(RECORD_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('record', (c) => {
  const p = spellCustom<RecordParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;
  const rank = getRank(self);

  // ① 呼名落马术：按名字找全图的敌人，不需要选点
  if (p.mode === 'name') {
    const want = (c.input ?? '').trim();
    if (!want) {
      c.result.ok = false;
      c.result.reason = '报一个兵种名';
      return;
    }
    const hits = s.units.filter(
      (u) => u.hp > 0 && u.owner !== self.owner && c.api.utype(s, u.type).name.includes(want),
    );
    if (hits.length === 0) {
      c.result.ok = false;
      c.result.reason = `没有叫「${want}」的敌人`;
      return;
    }
    if (!paySpellCost(c, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }
    const dmg = (p.base ?? 0) + (p.perRank ?? 0) * rank;
    let dealt = 0;
    for (const u of hits) {
      const r = strike(c, u, dmg, {
        hurt: (x) => `${c.api.utype(s, x.type).name}被呼名落马，受到 ${dmg} 点伤害`,
        kill: (x) => `${c.api.utype(s, x.type).name}被一声断喝震落`,
      });
      dealt += r.dealt;
      if (p.root) rootFor(u, p.root);
    }
    c.result.log = `${name}施放${skillName}：唤「${want}」，${hits.length} 人落马（共 ${dealt} 点伤害，耗 ${cost} 灵力）`;
    return;
  }

  // ② 另外两条都要点一个目标
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
  const dmg = (p.base ?? 0) + (p.perRank ?? 0) * rank;

  // ② a 钉头七箭书：比年龄
  if (p.mode === 'arrow') {
    const guess = Number(c.input);
    if (!Number.isFinite(guess)) {
      c.result.ok = false;
      c.result.reason = '年龄要填一个数字';
      return;
    }
    const truth = victim.age ?? 0;
    const hit = guess === truth;
    const out = hit ? dmg : Math.max(1, Math.round(dmg * DING_TOU_QI_JIAN_MISS_RATIO));
    const r = strike(c, victim, out, {
      hurt: (x) => `${c.api.utype(s, x.type).name}被七箭钉住，受到 ${out} 点伤害`,
      kill: (x) => `${c.api.utype(s, x.type).name}被七箭钉散`,
    });
    if (hit && p.root) rootFor(victim, p.root);
    c.result.log =
      `${name}施放${skillName}：报「${guess} 岁」——` +
      (hit ? `正中！${c.api.utype(s, victim.type).name} 受到 ${r.dealt} 点伤害并被钉住` : `猜错了，只擦到 ${r.dealt} 点`);
    return;
  }

  // ② b 斩仙飞刀：记下位置，三回合后落刀
  victim.custom = {
    ...(victim.custom ?? {}),
    feiDao: {
      turns: Number(p.turns ?? 3),
      by: self.owner,
      x: victim.x,
      y: victim.y,
      dmg,
    } satisfies KnifeMark,
  };
  c.result.log = `${name}施放${skillName}：记下${c.api.utype(s, victim.type).name}此刻的位置，${p.turns} 回合后刀落（耗 ${cost} 灵力）`;
});

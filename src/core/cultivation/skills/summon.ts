/**
 * 族 8 · 召唤 / 造单位（`effect: 'summon'`）。
 *
 * ── 这一族真正难的地方 ──────────────────────────────────────────
 *
 * 不是"造一个单位"（`api.spawnNear` 是现成的，招魂早就在用），而是**绑定**：
 * 造出来的东西和主人之间是哪种关系。五条法术是五种：
 *
 *   撒豆成兵   造完就撒手（仆役自己去打）
 *   替劫灵身   代主人挨刀（`redirectDamage` 指向它）
 *   化身分神   能打能走、到期消失，杀敌的经验回流给本体
 *   众妙之门   建筑，每回合给半径内的修士添修为
 *   魂灯       建筑，主人倒下时把魂魄接住一次
 *
 * 所以它们共用"造出来"这一半，另一半各写各的——硬凑成一个模式会写出
 * 五个互相干扰的开关。
 *
 * ── 一个容易忘的约定 ────────────────────────────────────────────
 *
 * `makeUnit` 造出来的单位 `moved/acted` 默认都是 true（本回合不能再动）。
 * 这是有意的：召唤如果白送一个回合的行动，节奏上等于每次施法都赚一次。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { UNIT_IDS } from '../identity.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export interface SummonParams extends Record<string, unknown> {
  /** 造哪种：仆役 / 代受伤害的灵身 / 分身 / 光环建筑 / 死亡锚点 */
  mode: 'servant' | 'decoy' | 'clone' | 'gate' | 'lamp';
  /** 造几个（只有 servant 用） */
  count?: number;
  /** 兵种 id */
  unitType?: string;
  /** 分身能活几个自己的回合 */
  rounds?: number;
  /** 光环半径（众妙之门） */
  auraRadius?: number;
  /** 每回合给多少修为（众妙之门） */
  expPerTurn?: number;
}

// ── 参数常量（hooks 和规则书都要读）──────────────────
/** 灵身离主人超过这个距离就不再替他挨打（不然等于全场无敌） */
export const TI_JIE_LING_SHEN_BIND_RADIUS = 3;
export const HUN_DENG_RATIO = 0.5;

// ── 数据行 ────────────────────────────────────────
export const SA_DOU_CHENG_BING_COST = 90;
export const SA_DOU_CHENG_BING_MIN_RANK = 3;
export const SA_DOU_CHENG_BING_COUNT = 3;
const SA_DOU_CHENG_BING: SpellRow = {
  id: 'sa-dou-cheng-bing',
  name: '撒豆成兵',
  summary:
    `在身边撒出 ${SA_DOU_CHENG_BING_COUNT} 个仆役（本回合不能行动）；` +
    `身边放不下就少造几个，一个都放不下则施法失败、不扣灵力；耗 ${SA_DOU_CHENG_BING_COST} 灵力。`,
  effect: 'summon',
  cost: SA_DOU_CHENG_BING_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'servant', count: SA_DOU_CHENG_BING_COUNT, unitType: UNIT_IDS.SERVANT } satisfies SummonParams,
};

export const TI_JIE_LING_SHEN_COST = 75;
export const TI_JIE_LING_SHEN_MIN_RANK = 3;
const TI_JIE_LING_SHEN: SpellRow = {
  id: 'ti-jie-ling-shen',
  name: '替劫灵身',
  summary:
    `在身边造一具灵身：${TI_JIE_LING_SHEN_BIND_RADIUS} 格内的你挨打时，伤害全部由它承受，` +
    `直到它被击毁；耗 ${TI_JIE_LING_SHEN_COST} 灵力。`,
  effect: 'summon',
  cost: TI_JIE_LING_SHEN_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'decoy', unitType: UNIT_IDS.LING_SHEN } satisfies SummonParams,
};

export const HUA_SHEN_FEN_SHEN_COST = 100;
export const HUA_SHEN_FEN_SHEN_MIN_RANK = 4;
export const HUA_SHEN_FEN_SHEN_ROUNDS = 3;
const HUA_SHEN_FEN_SHEN: SpellRow = {
  id: 'hua-shen-fen-shen',
  name: '化身分神',
  summary:
    `造一具能走能打的分身，持续 ${HUA_SHEN_FEN_SHEN_ROUNDS} 个自己的回合；` +
    '它杀敌得到的修为会回流给本体；耗 100 灵力。',
  effect: 'summon',
  cost: HUA_SHEN_FEN_SHEN_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    mode: 'clone',
    unitType: UNIT_IDS.CLONE,
    rounds: HUA_SHEN_FEN_SHEN_ROUNDS,
  } satisfies SummonParams,
};

export const ZHONG_MIAO_ZHI_MEN_COST = 120;
export const ZHONG_MIAO_ZHI_MEN_MIN_RANK = 5;
export const ZHONG_MIAO_ZHI_MEN_RADIUS = 2;
export const ZHONG_MIAO_ZHI_MEN_EXP = 5;
const ZHONG_MIAO_ZHI_MEN: SpellRow = {
  id: 'zhong-miao-zhi-men',
  name: '众妙之门',
  summary:
    `在身边立一座门：每回合开始时，半径 ${ZHONG_MIAO_ZHI_MEN_RADIUS} 格内每个友方修士 +${ZHONG_MIAO_ZHI_MEN_EXP} 修为；` +
    '门本身可以被拆掉；耗 120 灵力。',
  effect: 'summon',
  cost: ZHONG_MIAO_ZHI_MEN_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    mode: 'gate',
    unitType: UNIT_IDS.MIAO_MEN,
    auraRadius: ZHONG_MIAO_ZHI_MEN_RADIUS,
    expPerTurn: ZHONG_MIAO_ZHI_MEN_EXP,
  } satisfies SummonParams,
};

export const HUN_DENG_COST = 65;
export const HUN_DENG_MIN_RANK = 2;
const HUN_DENG: SpellRow = {
  id: 'hun-deng',
  name: '魂灯',
  summary:
    `在身边点一盏灯：你倒下时，灯会把你按 ${Math.round(HUN_DENG_RATIO * 100)}% 生命接回来一次，然后灯灭；` +
    '灯先被拆掉就没有这个效果；耗 65 灵力。',
  effect: 'summon',
  cost: HUN_DENG_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'lamp', unitType: UNIT_IDS.HUN_DENG } satisfies SummonParams,
};

export const SUMMON_ROWS: readonly SpellRow[] = [
  SA_DOU_CHENG_BING,
  TI_JIE_LING_SHEN,
  HUA_SHEN_FEN_SHEN,
  ZHONG_MIAO_ZHI_MEN,
  HUN_DENG,
];

export const SA_DOU_CHENG_BING_SKILL = defineSpellSkill(SA_DOU_CHENG_BING);
export const TI_JIE_LING_SHEN_SKILL = defineSpellSkill(TI_JIE_LING_SHEN);
export const HUA_SHEN_FEN_SHEN_SKILL = defineSpellSkill(HUA_SHEN_FEN_SHEN);
export const ZHONG_MIAO_ZHI_MEN_SKILL = defineSpellSkill(ZHONG_MIAO_ZHI_MEN);
export const HUN_DENG_SKILL = defineSpellSkill(HUN_DENG);

registerManaReady(SUMMON_ROWS);
registerPreview(SUMMON_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('summon', (c) => {
  const p = spellCustom<SummonParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;
  const unitType = p.unitType ?? UNIT_IDS.SERVANT;

  /*
   * 先探"身边还有没有位置"，再扣灵力。
   *
   * 用 `freeNeighbor` 而不是"先 spawn 一个试试"：那样万一灵力不够，
   * 试出来的那个单位已经落在场上了——白白多一个兵，而且没有任何提示。
   */
  if (!c.api.freeNeighbor(c.view, self, unitType)) {
    c.result.ok = false;
    c.result.reason = '身边没有能站的位置';
    return;
  }

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  if (p.mode === 'servant') {
    let spawned = 0;
    for (let i = 0; i < (p.count ?? 1); i++) {
      if (!c.api.spawnNear(s, self.owner, unitType, self)) break;
      spawned += 1;
    }
    c.result.log = `${name}施放${skillName}：${spawned} 个${c.api.utype(s, unitType).name}落地（耗 ${cost} 灵力）`;
    return;
  }

  const spawned = c.api.spawnNear(s, self.owner, unitType, self);
  if (!spawned) {
    c.result.ok = false;
    c.result.reason = '身边没有能站的位置';
    return;
  }

  if (p.mode === 'decoy') {
    // 绑定记在**主人**身上：谁替谁挨打，是主人这边的属性
    self.custom = { ...(self.custom ?? {}), lingShen: spawned.id };
    c.result.log = `${name}施放${skillName}：灵身落地（${TI_JIE_LING_SHEN_BIND_RADIUS} 格内替你挨打）`;
    return;
  }

  if (p.mode === 'clone') {
    // 分身记住本体是谁 + 还能活几个回合；到期由 onTurnEnd 收场
    spawned.custom = {
      ...(spawned.custom ?? {}),
      cloneOf: self.id,
      cloneTurns: Number(p.rounds ?? 1),
    };
    c.result.log = `${name}施放${skillName}：化身落地，还能存在 ${p.rounds} 回合`;
    return;
  }

  if (p.mode === 'gate') {
    spawned.custom = {
      ...(spawned.custom ?? {}),
      gateRadius: Number(p.auraRadius ?? 2),
      gateExp: Number(p.expPerTurn ?? 0),
    };
    c.result.log =
      `${name}施放${skillName}：门立起来了，半径 ${p.auraRadius} 格内每回合 +${p.expPerTurn} 修为`;
    return;
  }

  // lamp：把灯的位置记在主人身上，倒下时按它找回来
  self.custom = {
    ...(self.custom ?? {}),
    hunDeng: { id: spawned.id, x: spawned.x, y: spawned.y },
  };
  c.result.log = `${name}施放${skillName}：魂灯已点（倒下时按半血接回一次）`;
});

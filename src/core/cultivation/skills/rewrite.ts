/**
 * 簇 C · 规则豁免与全局改写（`effect: 'rewrite'`）。
 *
 * ── 为什么这批要单开一个文件 ────────────────────────────────────
 *
 * 它们改的不是数值，是**规则本身**：学法术的门槛、身上挂着的东西、
 * 攻击次数、攻击力怎么算、射程管不管用。所以每一条都贴着一条既有的闸/钩子写，
 * 而不是塞进族里当参数。
 *
 * ── 这一批做了什么（2026-11-14）────────────────────────────────
 *
 *   大道三千   学法术**不受流派限制**（闸改在 `spells.ts` 的 `spellLearnProblem`）
 *   一元复始   把身上的所有状态与加成一次清空
 *   诸邪辟易   一段时间内**免疫减益**（麻痹/定身/熔甲的施加入口直接跳过）
 *   万族之劫   攻击力再加上**麾下兵种种类数**
 *   破碎虚空   攻击次数 ×2 + 射程拉满
 *   穷极       全图射程的一发（走族 1 的实现，只是射程不设限）
 *
 * ── 还没做的四条（不是漏写）────────────────────────────────────
 *
 * 平等图腾（境界动态化）、天下皆白（跨扩展包伤害乘回合）、
 * 绝地天通（封印兵种）、法相天地（改占地面积）——这四条都要先定设计口径：
 * "境界动态化"是取全队最高还是最低？"封印兵种"封的是生产还是在场？
 * "改占地面积"会牵动寻路/占位/命中三处。想清楚再动，别先写一个半成品。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { applySpellBuffs, type SpellBuffs } from '../spell-statuses.ts';
import { registerStatus } from '../../statuses.ts';
import { distToUnit, coversTile } from '../../query.ts';
import type { GameState, Unit } from '../../types.ts';
import { isCultivatorUnit } from '../identity.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 参数 ──────────────────────────────────────────
export interface RewriteParams extends Record<string, unknown> {
  /**
   * 这一批法术各走各的路：
   *   `dao` 流派豁免 / `purge` 清空自身 / `buff` 挂加成
   *   `white` 天下皆白 / `equality` 平等图腾 / `seal` 绝地天通
   */
  mode: 'dao' | 'purge' | 'buff' | 'white' | 'equality' | 'seal' | 'giant';
  /** 持续几个自己的回合 */
  rounds?: number;
  /** 作用半径（平等图腾） */
  radius?: number;
}

/** 一元复始要清掉的 custom 键：全部是"法术挂上去的效果" */
const PURGE_KEYS = [
  'spellBuff',
  'shield',
  'revive',
  'erode',
  'convertIn',
  'convertOnHurt',
  'tint',
  'lingShen',
  'hunDeng',
  'wuxing',
  'pendingStrike',
];

// ── 数据行 ────────────────────────────────────────
export const DAO_SAN_QIAN_COST = 80;
export const DAO_SAN_QIAN_MIN_RANK = 4;
const DAO_SAN_QIAN: SpellRow = {
  id: 'dao-san-qian',
  name: '大道三千',
  summary: `从此**学法术不再受流派限制**（剑修能学体修的法术，反过来也一样）；耗 ${DAO_SAN_QIAN_COST} 灵力。一次施放，永久有效。`,
  effect: 'rewrite',
  cost: DAO_SAN_QIAN_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'dao' } satisfies RewriteParams,
};

export const YI_YUAN_FU_SHI_COST = 60;
export const YI_YUAN_FU_SHI_MIN_RANK = 3;
const YI_YUAN_FU_SHI: SpellRow = {
  id: 'yi-yuan-fu-shi',
  name: '一元复始',
  summary: `把身上所有状态与法术加成一次清空（好的坏的都清），回到干净状态；耗 ${YI_YUAN_FU_SHI_COST} 灵力。`,
  effect: 'rewrite',
  cost: YI_YUAN_FU_SHI_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'purge' } satisfies RewriteParams,
};

export const ZHU_XIE_BI_YI_COST = 70;
export const ZHU_XIE_BI_YI_MIN_RANK = 4;
export const ZHU_XIE_BI_YI_ROUNDS = 3;
const ZHU_XIE_BI_YI: SpellRow = {
  id: 'zhu-xie-bi-yi',
  name: '诸邪辟易',
  summary: `接下来 ${ZHU_XIE_BI_YI_ROUNDS} 回合**免疫减益**（麻痹、定身、熔甲一律挂不上）；耗 ${ZHU_XIE_BI_YI_COST} 灵力。`,
  effect: 'rewrite',
  cost: ZHU_XIE_BI_YI_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'buff', rounds: ZHU_XIE_BI_YI_ROUNDS } satisfies RewriteParams,
};

export const WAN_ZU_ZHI_JIE_COST = 90;
export const WAN_ZU_ZHI_JIE_MIN_RANK = 5;
export const WAN_ZU_ZHI_JIE_ROUNDS = 3;
const WAN_ZU_ZHI_JIE: SpellRow = {
  id: 'wan-zu-zhi-jie',
  name: '万族之劫',
  summary: `接下来 ${WAN_ZU_ZHI_JIE_ROUNDS} 回合，攻击力再加上**麾下兵种种类数**；耗 ${WAN_ZU_ZHI_JIE_COST} 灵力。`,
  effect: 'rewrite',
  cost: WAN_ZU_ZHI_JIE_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'buff', rounds: WAN_ZU_ZHI_JIE_ROUNDS } satisfies RewriteParams,
};

export const PO_SUI_XU_KONG_COST = 110;
export const PO_SUI_XU_KONG_MIN_RANK = 7;
const PO_SUI_XU_KONG: SpellRow = {
  id: 'po-sui-xu-kong',
  name: '破碎虚空',
  summary: `这一回合射程拉满、攻击次数 ×2；耗 ${PO_SUI_XU_KONG_COST} 灵力。`,
  effect: 'rewrite',
  cost: PO_SUI_XU_KONG_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'buff', rounds: 1 } satisfies RewriteParams,
};

export const TIAN_XIA_JIE_BAI_COST = 120;
export const TIAN_XIA_JIE_BAI_MIN_RANK = 6;
export const TIAN_XIA_JIE_BAI_ROUNDS = 3;
/** 削弱系数：倍率 = 当前回合 × 0.1（不设上限，后期会非常凶） */
export const TIAN_XIA_JIE_BAI_COEF = 0.1;
const TIAN_XIA_JIE_BAI: SpellRow = {
  id: 'tian-xia-jie-bai',
  name: '天下皆白',
  summary:
    `接下来 ${TIAN_XIA_JIE_BAI_ROUNDS} 回合，**除你以外**所有单位的攻击伤害 ×（当前回合 × ${TIAN_XIA_JIE_BAI_COEF}，无上限）；` +
    `耗 ${TIAN_XIA_JIE_BAI_COST} 灵力。`,
  effect: 'rewrite',
  cost: TIAN_XIA_JIE_BAI_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'white', rounds: TIAN_XIA_JIE_BAI_ROUNDS } satisfies RewriteParams,
};

export const PING_DENG_TU_TENG_COST = 90;
export const PING_DENG_TU_TENG_MIN_RANK = 5;
export const PING_DENG_TU_TENG_ROUNDS = 3;
export const PING_DENG_TU_TENG_RADIUS = 3;
const PING_DENG_TU_TENG: SpellRow = {
  id: 'ping-deng-tu-teng',
  name: '平等图腾',
  summary:
    `半径 ${PING_DENG_TU_TENG_RADIUS} 格内的友方修士，境界**动态取视野内敌方最高境界**` +
    `（境界涨了视野更大，会再涨——连锁到不再变为止；视野里没有敌人就掉回 0 期）；` +
    `持续 ${PING_DENG_TU_TENG_ROUNDS} 回合；耗 ${PING_DENG_TU_TENG_COST} 灵力。`,
  effect: 'rewrite',
  cost: PING_DENG_TU_TENG_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {
    mode: 'equality',
    rounds: PING_DENG_TU_TENG_ROUNDS,
    radius: PING_DENG_TU_TENG_RADIUS,
  } satisfies RewriteParams,
};

export const JUE_DI_TIAN_TONG_COST = 110;
export const JUE_DI_TIAN_TONG_MIN_RANK = 6;
export const JUE_DI_TIAN_TONG_ROUNDS = 3;
const JUE_DI_TIAN_TONG: SpellRow = {
  id: 'jue-di-tian-tong',
  name: '绝地天通',
  summary: `接下来 ${JUE_DI_TIAN_TONG_ROUNDS} 回合，敌方诸城**无法再生产修士**（已经有的照旧）；耗 ${JUE_DI_TIAN_TONG_COST} 灵力。`,
  effect: 'rewrite',
  cost: JUE_DI_TIAN_TONG_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'seal', rounds: JUE_DI_TIAN_TONG_ROUNDS } satisfies RewriteParams,
};

export const FA_XIANG_TIAN_DI_COST = 95;
export const FA_XIANG_TIAN_DI_MIN_RANK = 6;
const FA_XIANG_TIAN_DI: SpellRow = {
  id: 'fa-xiang-tian-di',
  name: '法相天地',
  summary:
    '身形放大到 **2×2**（一直保持）：所有覆盖判定、阻挡、命中都按四格算；' +
    '放大时如果多出来的格子站不住（**允许卡住**），就一直动不了，直到四格都空出来；' +
    `耗 ${FA_XIANG_TIAN_DI_COST} 灵力。`,
  effect: 'rewrite',
  cost: FA_XIANG_TIAN_DI_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'giant' } satisfies RewriteParams,
};

export const QIONG_JI_COST = 100;
export const QIONG_JI_MIN_RANK = 6;
export const QIONG_JI_BASE = 20;
export const QIONG_JI_PER_RANK = 8;
/**
 * 穷极：全图一发。
 *
 * 直接复用族 1 的实现，只是 `range` 写成一个远到不可能越界的数——
 * "无视射程"在结算上就是"射程够长"，不需要在核心里开一个"跳过校验"的后门。
 */
const QIONG_JI: SpellRow = {
  id: 'qiong-ji',
  name: '穷极',
  summary: `对**全图任意一名敌人**造成 ${QIONG_JI_BASE} + 境界×${QIONG_JI_PER_RANK} 点伤害（无视护甲）；耗 ${QIONG_JI_COST} 灵力。`,
  effect: 'bolt',
  cost: QIONG_JI_COST,
  range: 99,
  preview: 'ring',
  custom: { base: QIONG_JI_BASE, perRank: QIONG_JI_PER_RANK } as Record<string, unknown>,
};

export const REWRITE_ROWS: readonly SpellRow[] = [
  DAO_SAN_QIAN,
  TIAN_XIA_JIE_BAI,
  PING_DENG_TU_TENG,
  JUE_DI_TIAN_TONG,
  FA_XIANG_TIAN_DI,
  YI_YUAN_FU_SHI,
  ZHU_XIE_BI_YI,
  WAN_ZU_ZHI_JIE,
  PO_SUI_XU_KONG,
  QIONG_JI,
];

export const DAO_SAN_QIAN_SKILL = defineSpellSkill(DAO_SAN_QIAN);
export const YI_YUAN_FU_SHI_SKILL = defineSpellSkill(YI_YUAN_FU_SHI);
export const ZHU_XIE_BI_YI_SKILL = defineSpellSkill(ZHU_XIE_BI_YI);
export const WAN_ZU_ZHI_JIE_SKILL = defineSpellSkill(WAN_ZU_ZHI_JIE);
export const PO_SUI_XU_KONG_SKILL = defineSpellSkill(PO_SUI_XU_KONG);
export const QIONG_JI_SKILL = defineSpellSkill(QIONG_JI);
export const TIAN_XIA_JIE_BAI_SKILL = defineSpellSkill(TIAN_XIA_JIE_BAI);
export const PING_DENG_TU_TENG_SKILL = defineSpellSkill(PING_DENG_TU_TENG);
export const JUE_DI_TIAN_TONG_SKILL = defineSpellSkill(JUE_DI_TIAN_TONG);
export const FA_XIANG_TIAN_DI_SKILL = defineSpellSkill(FA_XIANG_TIAN_DI);

registerManaReady(REWRITE_ROWS);
registerPreview(REWRITE_ROWS);

// ── 法相天地：放大与卡住 ──────────────────────────
/** 这个单位现在是不是"大到卡住了" */
export function giantStuckOf(u: Unit): boolean {
  return u.custom?.['giantStuck'] === true;
}

/**
 * 重算"卡住没有"，写进 `custom.giantStuck`。返回是否卡住。
 *
 * 口径（作者 2026-11-14 定）：**允许卡住，卡住时不能移动**。
 * 所以放大那一刻不去找位置、不拒绝施法，只是把"能不能动"标出来；
 * 多出来的格子空出来之后，下一次刷新会自动解开。
 *
 * 判的是 2×2 的**全部四格**（含锚点自己那格）：卡住的本质是"身形撑不下"，
 * 和从哪一格撑不下的无关。
 */
export function refreshGiantStuck(
  state: GameState,
  api: { canStandAt: (s: GameState, x: number, y: number, type: string, opts?: { ignoreUnits?: boolean }) => boolean },
  u: Unit,
): boolean {
  const n = 2;
  let stuck = false;
  for (let dy = 0; dy < n && !stuck; dy++) {
    for (let dx = 0; dx < n && !stuck; dx++) {
      const x = u.x + dx;
      const y = u.y + dy;
      if (!api.canStandAt(state, x, y, u.type, { ignoreUnits: true })) {
        stuck = true;
        break;
      }
      const occupied = state.units.some(
        (o) => o.id !== u.id && o.hp > 0 && coversTile(state, o, x, y),
      );
      if (occupied) stuck = true;
    }
  }
  u.custom = { ...(u.custom ?? {}), giantStuck: stuck };
  return stuck;
}

// ── 三条"全局改写"的状态 ──────────────────────────
/** 天下皆白：挂给施法者，钩子据此放大全场伤害（施法者本人豁免） */
export const WHITE_STATUS = 'spell-white';
/** 平等图腾：挂给受影响的友方修士，`getRank` 会读 `custom.rankOverride` */
export const EQUALITY_STATUS = 'spell-equality';
/** 绝地天通：挂给施法者，敌方产兵时据此挡下修士 */
export const SEAL_STATUS = 'spell-seal';

registerStatus({ id: WHITE_STATUS, name: '天下皆白', summary: '在术中的世界里，除施法者外人人打得都更疼' });
registerStatus({ id: EQUALITY_STATUS, name: '平等图腾', summary: '境界取视野内敌方最高，会自我强化' });
registerStatus({ id: SEAL_STATUS, name: '绝地天通', summary: '敌方无法再生产修士' });

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('rewrite', (c) => {
  const p = spellCustom<RewriteParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;
  const id = (c.skill as { id?: string } | undefined)?.id ?? '';

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  if (p.mode === 'dao') {
    self.custom = { ...(self.custom ?? {}), daoAll: true };
    c.result.log = `${name}参悟${skillName}：从此学法术不再受流派限制`;
    return;
  }

  if (p.mode === 'giant') {
    self.custom = { ...(self.custom ?? {}), footprint: 2 };
    const stuck = refreshGiantStuck(s, c.api, self);
    c.result.log = stuck
      ? `${name}施放${skillName}：法相撑开四格，但身边站不下——**卡住了**，四格空出来之前无法移动`
      : `${name}施放${skillName}：法相撑开四格`;
    return;
  }

  if (p.mode === 'white' || p.mode === 'seal') {
    const key = p.mode === 'white' ? WHITE_STATUS : SEAL_STATUS;
    self.status = { ...(self.status ?? {}), [key]: Number(p.rounds ?? 1) };
    c.result.log =
      p.mode === 'white'
        ? `${name}施放${skillName}：天下皆白，唯你独黑——此后 ${p.rounds} 回合，别人的伤害随回合数暴涨`
        : `${name}施放${skillName}：天地断绝，此后 ${p.rounds} 回合敌方无法再生产修士`;
    return;
  }

  if (p.mode === 'equality') {
    /*
     * 只挂在**友方修士**身上，且**只管标记**。
     *
     * 真正的境界换算放在 `hooks.onTurnStart`：那里能反复迭代到"不再变"为止
     * （境界涨→视野大→看到更强的敌人→再涨），也就是作者要的那个连锁反应。
     * 在施法这一拍就迭代完是不对的——视野会随之后的位置变化而变化。
     */
    const radius = Number(p.radius ?? 3);
    let marked = 0;
    for (const u of s.units) {
      if (u.hp <= 0 || u.owner !== self.owner) continue;
      if (distToUnit(c.view, { x: self.x, y: self.y }, u) > radius) continue;
      // 只有修士有境界；法器、建筑不该被这个图腾影响
      if (!isCultivatorUnit(s, u)) continue;
      u.status = { ...(u.status ?? {}), [EQUALITY_STATUS]: Number(p.rounds ?? 1) };
      marked += 1;
    }
    c.result.log = `${name}施放${skillName}：${marked} 名同伴的境界开始随视野内的强敌浮动`;
    return;
  }

  if (p.mode === 'purge') {
    const before = Object.keys(self.status ?? {}).length;
    self.status = {};
    const custom = { ...(self.custom ?? {}) };
    for (const k of PURGE_KEYS) delete custom[k];
    self.custom = custom;
    c.result.log = `${name}施放${skillName}：身上的状态与加成尽数化去（清掉 ${before} 个状态）`;
    return;
  }

  /*
   * 其余三条都是"挂一段加成"，区别只在挂什么。
   * 数值直接从技能 id 推，而不是再传一份参数：这三条各自的含义写在
   * 数据行的 summary 里，实现和文案指同一个地方，改一处就够。
   */
  const buffs: SpellBuffs =
    id === 'zhu-xie-bi-yi'
      ? { ignoresDebuff: true }
      : id === 'wan-zu-zhi-jie'
        ? { legion: true }
        : { range: 99, attacksMul: 2 };
  applySpellBuffs(self, Number(p.rounds ?? 1), buffs);

  const what =
    id === 'zhu-xie-bi-yi' ? '免疫减益' : id === 'wan-zu-zhi-jie' ? '攻击力按兵种种类加成' : '射程拉满、攻击次数 ×2';
  c.result.log = `${name}施放${skillName}：${what}，持续 ${p.rounds} 回合（耗 ${cost} 灵力）`;
});

/**
 * 族 3 · 场域（`effect: 'field'`）：在地上留一片会自己结算的东西。
 *
 * ── 这一族管的是什么 ──────────────────────────────────────────────
 *
 * 和族 2（范围伤害）的分界：族 2 是"炸一下"，人是当场挨打；族 3 是
 * **"把一片地变成危险区"**，伤害发生在"有人走进去"和"每轮开始"这两个时刻。
 * 所以它不筛敌人、不在这里结算伤害——它只负责把留痕放到格子上，
 * 之后全交给 `marks.ts` 的引擎（可见性、次数、触发时机都在那边）。
 *
 * ── 为什么只有两条法术却单开一个族 ────────────────────────────────
 *
 * 因为"放场"这个动作是共用的：以后加毒瘴、雷池、剑阵，都只是换一个 `kind`。
 * 现在已经能看到这个好处——`blast.ts` 里焱的"余烬"复用的就是这里的放场逻辑
 * （见 `placeField` 的导出）。
 *
 * ⚠️ 留痕只活在地球这张图上（`boardState` 给别的图返回 `marks: []`），
 * 所以月面/空间站上放不出场。这是既有边界。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import type { Mark } from '../../types.ts';
import { addMark, marksAt } from '../../marks.ts';
import { distToUnit } from '../../query.ts';

import { getRank } from '../progression.ts';
import {
  blastCoords,
  defineSpellSkill,
  registerManaReady,
  paySpellCost,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 族的参数 ──────────────────────────────────────
export interface FieldParams extends Record<string, unknown> {
  /** 主场留下的留痕种类 id（`spell-fire` / `spell-blade` / `spell-edict`）。不写 = 只治疗/补灵气 */
  kind?: string;
  /** 基础伤害 */
  dmg?: number;
  /** 每层境界加多少 */
  perRank?: number;
  /** 持续几个自己的回合（刀山不用：它踩一次就没了） */
  rounds?: number;
  /** 按护甲结算（刀山的刀是物理的） */
  physical?: boolean;
  /** 以施法者自己为中心（十方火海），不需要选点 */
  atSelf?: boolean;
  /** 治疗半径内的友军（春风化雨） */
  heal?: { base: number; perRank: number };
  /** 在中心格留一汪灵雨：每轮补 `amount` 点灵气，持续 `rounds` 轮 */
  qiSpring?: { amount: number; rounds: number };
  /** 传给留痕的非数字数据（山河敕令要记住是谁放的、当时站在哪） */
  markCustom?: Record<string, unknown>;
  /** 五行 */
  element?: string;
  /** 魂法 */
  soulBound?: boolean;
}

/** 这一片场每格打多少 */
export function fieldDamage(p: FieldParams, rank: number): number {
  return (p.dmg ?? 0) + (p.perRank ?? 0) * Math.max(0, rank);
}

// ── 数据行 ────────────────────────────────────────
export const SHI_FANG_HUO_HAI_COST = 85;
export const SHI_FANG_HUO_HAI_MIN_RANK = 3;
export const SHI_FANG_HUO_HAI_RADIUS = 3;
const SHI_FANG_HUO_HAI: SpellRow = {
  id: 'shi-fang-huo-hai',
  name: '十方火海',
  summary:
    `自身半径 ${SHI_FANG_HUO_HAI_RADIUS} 格化为火海，持续 3 轮：` +
    '敌方单位踏入被灼烧 12 + 境界×4 点，每轮开始时还在里面的人再烧一次；耗 85 灵力。五行：火。',
  effect: 'field',
  cost: SHI_FANG_HUO_HAI_COST,
  range: SHI_FANG_HUO_HAI_RADIUS,
  // 以自己为中心：亮"我周围这一圈"，而且不需要玩家点地图
  preview: 'ring',
  targeting: 'none',
  radius: SHI_FANG_HUO_HAI_RADIUS,
  custom: {
    kind: 'spell-fire',
    dmg: 12,
    perRank: 4,
    rounds: 3,
    atSelf: true,
    element: 'fire',
  } satisfies FieldParams,
};

export const WAN_REN_DAO_SHAN_COST = 70;
export const WAN_REN_DAO_SHAN_MIN_RANK = 2;
export const WAN_REN_DAO_SHAN_RADIUS = 2;
const WAN_REN_DAO_SHAN: SpellRow = {
  id: 'wan-ren-dao-shan',
  name: '万仞刀山',
  summary:
    `射程 6 格、半径 ${WAN_REN_DAO_SHAN_RADIUS} 格铺满刀丛（双方都看得见），` +
    '踩上去被割 18 + 境界×6 点（按护甲结算），割完即散；耗 70 灵力。五行：金。',
  effect: 'field',
  cost: WAN_REN_DAO_SHAN_COST,
  range: 6,
  preview: 'blast',
  radius: WAN_REN_DAO_SHAN_RADIUS,
  custom: {
    kind: 'spell-blade',
    dmg: 18,
    perRank: 6,
    physical: true,
    element: 'metal',
  } satisfies FieldParams,
};

export const SHAN_HE_CHI_LING_COST = 95;
export const SHAN_HE_CHI_LING_MIN_RANK = 4;
export const SHAN_HE_CHI_LING_RADIUS = 3;
const SHAN_HE_CHI_LING: SpellRow = {
  id: 'shan-he-chi-ling',
  name: '山河敕令',
  summary:
    `射程 6 格、半径 ${SHAN_HE_CHI_LING_RADIUS} 格：敌方建筑每轮受 8 + 境界×2 点真实伤害，` +
    '这片区域也无法兴建；施法者移动或阵亡后失效；耗 95 灵力。',
  effect: 'field',
  cost: SHAN_HE_CHI_LING_COST,
  range: 6,
  preview: 'blast',
  radius: SHAN_HE_CHI_LING_RADIUS,
  custom: {
    kind: 'spell-edict',
    dmg: 8,
    perRank: 2,
    // 施法者身份与站位由实现填进 mark.custom（见 handler）
  } satisfies FieldParams,
};

export const CHUN_FENG_HUA_YU_COST = 70;
export const CHUN_FENG_HUA_YU_MIN_RANK = 2;
export const CHUN_FENG_HUA_YU_RADIUS = 2;
export const CHUN_FENG_HUA_YU_QI = 12;
export const CHUN_FENG_HUA_YU_ROUNDS = 3;
const CHUN_FENG_HUA_YU: SpellRow = {
  id: 'chun-feng-hua-yu',
  name: '春风化雨',
  summary:
    `射程 5 格、半径 ${CHUN_FENG_HUA_YU_RADIUS} 格：治疗友军 10 + 境界×4 点，` +
    `并在中心留下一汪灵雨（每轮补 ${CHUN_FENG_HUA_YU_QI} 点灵气，持续 ${CHUN_FENG_HUA_YU_ROUNDS} 轮）；` +
    '耗 70 灵力。五行：水。',
  effect: 'field',
  cost: CHUN_FENG_HUA_YU_COST,
  range: 5,
  preview: 'blast',
  radius: CHUN_FENG_HUA_YU_RADIUS,
  custom: {
    heal: { base: 10, perRank: 4 },
    qiSpring: { amount: CHUN_FENG_HUA_YU_QI, rounds: CHUN_FENG_HUA_YU_ROUNDS },
    element: 'water',
  } satisfies FieldParams,
};

export const FIELD_ROWS: readonly SpellRow[] = [
  SHI_FANG_HUO_HAI,
  WAN_REN_DAO_SHAN,
  SHAN_HE_CHI_LING,
  CHUN_FENG_HUA_YU,
];

export const SHI_FANG_HUO_HAI_SKILL = defineSpellSkill(SHI_FANG_HUO_HAI);
export const WAN_REN_DAO_SHAN_SKILL = defineSpellSkill(WAN_REN_DAO_SHAN);
export const SHAN_HE_CHI_LING_SKILL = defineSpellSkill(SHAN_HE_CHI_LING);
export const CHUN_FENG_HUA_YU_SKILL = defineSpellSkill(CHUN_FENG_HUA_YU);

registerManaReady(FIELD_ROWS);
registerPreview(FIELD_ROWS);

// ── 放场（族 2 的余烬也用它）────────────────────────
/**
 * 在 `center` 周围 `radius` 格铺一层留痕。
 *
 * 同一格上已经有**同种**留痕时跳过：不跳的话，两发火海叠在一格上会变成
 * 双倍伤害，而玩家看到的还是"一片火"，看不出为什么这一格更疼。
 */
export function placeField(
  s: Parameters<typeof addMark>[0],
  view: Parameters<typeof blastCoords>[0],
  opts: {
    owner: Mark['owner'];
    kind: string;
    center: { x: number; y: number };
    radius: number;
    dmg: number;
    charges?: number;
    physical?: boolean;
    custom?: Record<string, unknown>;
  },
): number {
  let placed = 0;
  for (const { x, y } of blastCoords(view, opts.center, opts.radius)) {
    const dup = marksAt(s, x, y).some((m) => m.kind === opts.kind && m.owner === opts.owner);
    if (dup) continue;
    addMark(s, {
      kind: opts.kind,
      owner: opts.owner,
      x,
      y,
      charges: opts.charges,
      data: { dmg: opts.dmg, physical: opts.physical ? 1 : 0 },
      custom: opts.custom,
    });
    placed += 1;
  }
  return placed;
}

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('field', (c: SkillCtx) => {
  const p = spellCustom<FieldParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const radius = Number(p.spellRadius ?? 0);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  // 以自己为中心的法术不需要选点；其余必须点一个落点
  const center = p.atSelf ? { x: self.x, y: self.y } : c.target;
  if (!center) {
    c.result.ok = false;
    c.result.reason = '选一个落点';
    return;
  }
  if (!p.atSelf) {
    const dist = Math.abs(self.x - center.x) + Math.abs(self.y - center.y);
    if (dist > range) {
      c.result.ok = false;
      c.result.reason = `太远了（${skillName}射程 ${range} 格）`;
      return;
    }
  }

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  const rank = getRank(self);

  // ① 主场（火海 / 刀山 / 敕令）。敕令要记住"谁放的、当时站在哪"，
  //    因为它的失效判据是"施法者移动或阵亡"。
  let placed = 0;
  if (p.kind) {
    placed = placeField(s, c.view, {
      owner: self.owner,
      kind: p.kind,
      center,
      radius,
      dmg: fieldDamage(p, rank),
      // 刀山踩一次就散（charges 1）；火海按轮数活，由 mark 的 onTurnStart 扣；
      // 敕令不靠次数失效（人走即散，见 spell-edict 的注释），给一个大额度即可。
      charges: p.kind === 'spell-blade' ? 1 : p.kind === 'spell-edict' ? 99 : (p.rounds ?? 3),
      physical: p.physical,
      custom: p.kind === 'spell-edict' ? { caster: self.id, cx: self.x, cy: self.y } : undefined,
    });
  }

  // ② 治疗友军（春风化雨）。含施法者自己：它本来就在圈里。
  let healedTotal = 0;
  if (p.heal) {
    const amount = p.heal.base + p.heal.perRank * Math.max(0, rank);
    for (const u of s.units) {
      if (u.hp <= 0 || u.owner !== self.owner) continue;
      if (distToUnit(c.view, center, u) > radius) continue;
      const before = u.hp;
      u.hp = Math.min(c.api.maxHpOf(s, u), u.hp + amount);
      healedTotal += u.hp - before;
    }
  }

  // ③ 灵雨：只在中心留一汪（铺满整片会让灵气一步到顶，失去"临时"的意思）
  let qiPlaced = 0;
  if (p.qiSpring) {
    addMark(s, {
      kind: 'spell-qi-spring',
      owner: self.owner,
      x: center.x,
      y: center.y,
      charges: p.qiSpring.rounds,
      data: { qi: p.qiSpring.amount },
    });
    qiPlaced = p.qiSpring.amount;
  }

  c.api.noteHeat(s, center.x, center.y);
  const bits: string[] = [];
  if (placed > 0) bits.push(`${placed} 格化为场`);
  if (healedTotal > 0) bits.push(`治疗 ${healedTotal} 点`);
  if (qiPlaced > 0) bits.push(`留下一汪灵雨（每轮 +${qiPlaced} 灵气）`);
  c.result.log =
    bits.length > 0
      ? `${name}施放${skillName}，${bits.join('，')}（耗 ${cost} 灵力）`
      : `${name}施放${skillName}，但那一片已经全是同样的场，没有叠加`;
});

/**
 * 族 2 · 范围伤害（`effect: 'blast'`）：在落点附近罩住一片敌人。
 *
 * ── 这一族管的是什么 ──────────────────────────────────────────────
 *
 * 和族 1（直伤）的分界：族 1 回答"打谁"，族 2 回答"罩住哪一片"。
 * 十条法术共用这一份实现，差别全在数据行的 `custom` 里：
 *
 *   base / perRank   伤害 = base + perRank × 境界
 *   trueMul          改用「真元 × 倍率」当伤害（写了就忽略上面两个）
 *   physical         true = 按护甲结算（hurtPhysical），不写 = 无视护甲
 *   downAir          击落：命中后把空中单位的 `layer` 改成地面
 *   root             命中后定身几回合（只能禁移动，攻击照旧）
 *   sunder           命中后熔甲几回合（护甲减半，核心状态）
 *   lifesteal        按实际伤害的这个比例给施法者回血
 *   knockback        击退几格（撞墙/撞人即停）
 *   flatten          把爆发范围内的地形改成平原
 *   element          五行（留给族 5 的免耗判定读）
 *   soulBound        魂法
 *
 * ── 击落的落地碰撞（2026-11-14 作者口径）─────────────────────────
 *
 * 空中单位被打下来时，如果它落的那一格已经站着地面单位，两者撞在一起：
 * **血多者活下来，并扣掉血少者的血量**；血少者当场死。
 * 血量相等按"被挡下"处理（坠落方死）——平局不该让进攻方白赚一个击杀。
 *
 * ── 还没做的（别当成漏写）────────────────────────────────────
 *
 * 这几条的"主效果"都在，但附带的部分要等地基：
 *   · 焱 / 百里毒瘴 的**持续伤害场**：要 `marks`，属于 P2 的 G3；
 *   · 淼 的**减攻**：`StatusDef.modifyAtk` 引擎还没接上（注释里写着"留着未来用"）；
 *   · 摘星拿月的**灵气转伤害**、以及焱垚鑫淼森的**外灵代偿**：
 *     前者要读灵气场，后者是一套跨法术的机制，都还没到。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import type { Unit } from '../../types.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import { coversTile } from '../../query.ts';
import { getRank } from '../progression.ts';
import { trueDamageOf } from '../stats.ts';
import { stunFor, rootFor, timedStatusFor } from '../spell-statuses.ts';
import { placeField } from './field.ts';
import {
  blastCoords,
  defineSpellSkill,
  registerManaReady,
  registerPreview,
  resolveCast,
  spellCustom,
  strikeAll,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 族的参数 ──────────────────────────────────────
export interface BlastParams extends Record<string, unknown> {
  base: number;
  perRank: number;
  /** 改用「真元 × 倍率」；写了就忽略 base/perRank */
  trueMul?: number;
  /** 按护甲结算（不写 = 无视护甲） */
  physical?: boolean;
  /** 击落空中单位 */
  downAir?: boolean;
  /** 定身几回合 */
  root?: number;
  /** 麻痹几回合（比定身更狠：整回合动不了） */
  stun?: number;
  /** 熔甲几回合 */
  sunder?: number;
  /** 生命汲取：按实际伤害的这个比例给施法者回血 */
  lifesteal?: number;
  /** 击退几格 */
  knockback?: number;
  /** 把爆发范围内的地形改成平原 */
  flatten?: boolean;
  /**
   * 打完留一片场（焱的余烬）。
   *
   * `ratio` 是"余场每格伤害 = 本发伤害 × 这个比例"：余烬本来就该比正身轻，
   * 而且它每秒结算一次、能叠好几轮，按原伤害给会直接失控。
   */
  leaveField?: { kind: string; ratio: number; rounds: number };
  /** 五行（族 5 的免耗判定要读） */
  element?: 'metal' | 'wood' | 'water' | 'fire' | 'earth';
  /** 魂法 */
  soulBound?: boolean;
}

/** 这一发打多少。和族 1 同一套口径，免得两族的面板数对不上 */
export function blastDamage(p: BlastParams, self: Unit, rank: number): number {
  if (typeof p.trueMul === 'number') return Math.round(trueDamageOf(self) * p.trueMul);
  return p.base + p.perRank * Math.max(0, rank);
}

// ── 数据行 ────────────────────────────────────────
/** 数值全是占位：等全部法术补齐之后再统一调（和别的扩展一样，先立形状再调平衡） */

// ① 如来神掌：远射程、大范围、高普攻
export const RU_LAI_SHEN_ZHANG_COST = 90;
export const RU_LAI_SHEN_ZHANG_MIN_RANK = 3;
const RU_LAI_SHEN_ZHANG: SpellRow = {
  id: 'ru-lai-shen-zhang',
  name: '如来神掌',
  summary: '射程 7 格、半径 2 格，对范围内所有敌人造成 20 + 境界×8 点伤害（按护甲结算）；耗 90 灵力。',
  effect: 'blast',
  cost: RU_LAI_SHEN_ZHANG_COST,
  range: 7,
  preview: 'blast',
  radius: 2,
  custom: { base: 20, perRank: 8, physical: true } satisfies BlastParams,
};

// ② 厚土镇岳：把天上的人拍下来，再按住他
export const HOU_TU_ZHEN_YUE_COST = 75;
export const HOU_TU_ZHEN_YUE_MIN_RANK = 2;
const HOU_TU_ZHEN_YUE: SpellRow = {
  id: 'hou-tu-zhen-yue',
  name: '厚土镇岳',
  summary:
    '射程 5 格、半径 2 格，对范围内所有敌人造成 12 + 境界×5 点伤害（按护甲结算）；' +
    '空中单位被击落，命中者定身 1 回合；耗 75 灵力。',
  effect: 'blast',
  cost: HOU_TU_ZHEN_YUE_COST,
  range: 5,
  preview: 'blast',
  radius: 2,
  custom: { base: 12, perRank: 5, physical: true, downAir: true, root: 1 } satisfies BlastParams,
};

// ③ 百里毒瘴：范围最大的那一片（毒场还没做，见文件头）
export const BAI_LI_DU_ZHANG_COST = 70;
const BAI_LI_DU_ZHANG: SpellRow = {
  id: 'bai-li-du-zhang',
  name: '百里毒瘴',
  summary: '射程 6 格、半径 3 格，对范围内所有敌人造成 10 + 境界×4 点伤害（按护甲结算）；耗 70 灵力。',
  effect: 'blast',
  cost: BAI_LI_DU_ZHANG_COST,
  range: 6,
  preview: 'blast',
  radius: 3,
  custom: { base: 10, perRank: 4, physical: true, element: 'wood' } satisfies BlastParams,
};

// ④ 移山填海：把地面掀了
export const YI_SHAN_TIAN_HAI_COST = 100;
export const YI_SHAN_TIAN_HAI_MIN_RANK = 4;
const YI_SHAN_TIAN_HAI: SpellRow = {
  id: 'yi-shan-tian-hai',
  name: '移山填海',
  summary:
    '射程 6 格、半径 3 格，对范围内所有敌人造成 18 + 境界×7 点伤害（无视护甲），' +
    '击退 2 格，范围内地形化为平原；耗 100 灵力。',
  effect: 'blast',
  cost: YI_SHAN_TIAN_HAI_COST,
  range: 6,
  preview: 'blast',
  radius: 3,
  custom: { base: 18, perRank: 7, knockback: 2, flatten: true } satisfies BlastParams,
};

// ⑤ 摘星拿月：五合一，最贵的那一发
export const ZHAI_XING_NA_YUE_COST = 120;
export const ZHAI_XING_NA_YUE_MIN_RANK = 6;
const ZHAI_XING_NA_YUE: SpellRow = {
  id: 'zhai-xing-na-yue',
  name: '摘星拿月',
  summary:
    '射程 8 格、半径 3 格，对范围内所有敌人造成 22 + 境界×9 点伤害（无视护甲）；' +
    '击落空中单位、击退 1 格、命中者定身 1 回合，范围内地形化为平原；耗 120 灵力。',
  effect: 'blast',
  cost: ZHAI_XING_NA_YUE_COST,
  range: 8,
  preview: 'blast',
  radius: 3,
  custom: {
    base: 22,
    perRank: 9,
    downAir: true,
    root: 1,
    knockback: 1,
    flatten: true,
  } satisfies BlastParams,
};

// ⑥–⑩ 五行五法：形状一样，各自带一种余韵
export const YAN_COST = 100;
export const YAO_COST = 100;
export const XIN_COST = 100;
export const MIAO_COST = 100;
export const SEN_COST = 100;
export const WU_XING_SPELL_MIN_RANK = 5;

const YAN: SpellRow = {
  id: 'yan',
  name: '焱',
  summary: '射程 7 格、半径 2 格，对范围内所有敌人造成 24 + 境界×9 点真伤；耗 100 灵力。魂法。',
  effect: 'blast',
  cost: YAN_COST,
  range: 7,
  preview: 'blast',
  radius: 2,
  custom: {
    base: 24,
    perRank: 9,
    element: 'fire',
    soulBound: true,
    // 焱烧过的地方留一片余烬：每格是这一发的 40%，再烧 2 轮
    leaveField: { kind: 'spell-fire', ratio: 0.4, rounds: 2 },
  } satisfies BlastParams,
};

const YAO: SpellRow = {
  id: 'yao',
  name: '垚',
  summary:
    '射程 7 格、半径 2 格，对范围内所有敌人造成 20 + 境界×8 点伤害（按护甲结算）；' +
    '空中单位被击落，命中者定身 2 回合；耗 100 灵力。五行：土。魂法。',
  effect: 'blast',
  cost: YAO_COST,
  range: 7,
  preview: 'blast',
  radius: 2,
  custom: {
    base: 20,
    perRank: 8,
    physical: true,
    downAir: true,
    root: 2,
    element: 'earth',
    soulBound: true,
  } satisfies BlastParams,
};

const XIN: SpellRow = {
  id: 'xin',
  name: '鑫',
  summary:
    '射程 7 格、半径 2 格，对范围内所有敌人造成 24 + 境界×9 点真伤，并熔甲 2 回合；' +
    '耗 100 灵力。五行：金。魂法。',
  effect: 'blast',
  cost: XIN_COST,
  range: 7,
  preview: 'blast',
  radius: 2,
  custom: { base: 24, perRank: 9, sunder: 2, element: 'metal', soulBound: true } satisfies BlastParams,
};

const MIAO: SpellRow = {
  id: 'miao',
  name: '淼',
  summary: '射程 7 格、半径 2 格，对范围内所有敌人造成 20 + 境界×8 点伤害（按护甲结算）；耗 100 灵力。五行：水。魂法。',
  effect: 'blast',
  cost: MIAO_COST,
  range: 7,
  preview: 'blast',
  radius: 2,
  custom: { base: 20, perRank: 8, physical: true, element: 'water', soulBound: true } satisfies BlastParams,
};

const SEN: SpellRow = {
  id: 'sen',
  name: '森',
  summary:
    '射程 7 格、半径 2 格，对范围内所有敌人造成 18 + 境界×7 点伤害，' +
    '并按实际伤害的一半为施法者回血；耗 100 灵力。五行：木。魂法。',
  effect: 'blast',
  cost: SEN_COST,
  range: 7,
  preview: 'blast',
  radius: 2,
  custom: { base: 18, perRank: 7, lifesteal: 0.5, element: 'wood', soulBound: true } satisfies BlastParams,
};

/**
 * 罡风：族里的样板法术（面积）。
 *
 * 它要解决的是"修士的普攻是单体多段"：境界再高，一回合也只是把一个目标
 * 敲几下；对面三台机甲压上来时，挨的是三份伤害。缺的从来不是数值，是**面积**。
 *
 * 为什么写"所有敌人"而不是"打主目标 + 溅射"：溅射是 50% 的边际伤害，
 * 半径再大也只是"顺便"。这里要的是一片人同时掉同样多的血，所以不走 splash
 * 那条路，逐个 `hurt`——代价是它不吃任何溅射加成/减免，这是有意的。
 */
export const GANG_WIND_COST = 80;
/** 施法距离 */
export const GANG_WIND_RANGE = 8;
/** 爆发半径（曼哈顿） */
export const GANG_WIND_RADIUS = 2;
/** 基础伤害 */
export const GANG_WIND_BASE = 30;
/** 每层境界加多少伤害 */
export const GANG_WIND_PER_RANK = 9;
/** 学它要求的最低境界：4 期（2 期就拿到会把这门法术变成本代最强 AOE） */
export const GANG_WIND_MIN_RANK = 4;
/** 研发要多少灵石（比默认 60 贵：强度摆在这） */
export const GANG_WIND_RESEARCH_COST = 90;

/** 这一发打多少（面板、按钮、结算共用同一份算式） */
export function gangWindDamage(rank: number): number {
  return GANG_WIND_BASE + GANG_WIND_PER_RANK * Math.max(0, rank);
}

/** 施法距离：修士是 1×1，点到点的曼哈顿距离就够了 */
export function gangWindInRange(self: { x: number; y: number }, target: { x: number; y: number }): boolean {
  return Math.abs(self.x - target.x) + Math.abs(self.y - target.y) <= GANG_WIND_RANGE;
}

const GANG_WIND: SpellRow = {
  id: 'gang-wind',
  name: '罡风',
  summary:
    `射程 ${GANG_WIND_RANGE} 格，对落点半径 ${GANG_WIND_RADIUS} 格内**所有**敌人造成 ` +
    `${GANG_WIND_BASE} + 境界×${GANG_WIND_PER_RANK} 点伤害（无视护甲）；耗 ${GANG_WIND_COST} 灵力。`,
  effect: 'blast',
  cost: GANG_WIND_COST,
  range: GANG_WIND_RANGE,
  // 范围法术亮"这一下会罩住谁"，所以画在落点周围（按曼哈顿，能打到的才画）
  preview: 'blast',
  radius: GANG_WIND_RADIUS,
  multiCast: true,
  custom: { base: GANG_WIND_BASE, perRank: GANG_WIND_PER_RANK } satisfies BlastParams,
};

export const GANG_WIND_SKILL = defineSpellSkill(GANG_WIND);

/** 这一族的全部数据行 */
export const BLAST_ROWS: readonly SpellRow[] = [
  GANG_WIND,
  RU_LAI_SHEN_ZHANG,
  HOU_TU_ZHEN_YUE,
  BAI_LI_DU_ZHANG,
  YI_SHAN_TIAN_HAI,
  ZHAI_XING_NA_YUE,
  YAN,
  YAO,
  XIN,
  MIAO,
  SEN,
];

export const RU_LAI_SHEN_ZHANG_SKILL = defineSpellSkill(RU_LAI_SHEN_ZHANG);
export const HOU_TU_ZHEN_YUE_SKILL = defineSpellSkill(HOU_TU_ZHEN_YUE);
export const BAI_LI_DU_ZHANG_SKILL = defineSpellSkill(BAI_LI_DU_ZHANG);
export const YI_SHAN_TIAN_HAI_SKILL = defineSpellSkill(YI_SHAN_TIAN_HAI);
export const ZHAI_XING_NA_YUE_SKILL = defineSpellSkill(ZHAI_XING_NA_YUE);
export const YAN_SKILL = defineSpellSkill(YAN);
export const YAO_SKILL = defineSpellSkill(YAO);
export const XIN_SKILL = defineSpellSkill(XIN);
export const MIAO_SKILL = defineSpellSkill(MIAO);
export const SEN_SKILL = defineSpellSkill(SEN);

registerManaReady(BLAST_ROWS);
registerPreview(BLAST_ROWS);

// ── 结算零件 ──────────────────────────────────────
/**
 * 击退：从爆心朝外推 `cells` 格，撞墙或撞人就停。
 *
 * 一格一格试，不用"一次算到底然后回退"——中间有一格站不住就该停在上一格，
 * 那样玩家看到的落点和实际位置才一致。
 */
function knockback(c: SkillCtx, victim: Unit, point: { x: number; y: number }, cells: number): boolean {
  const dx = Math.sign(victim.x - point.x);
  const dy = Math.sign(victim.y - point.y);
  if (dx === 0 && dy === 0) return false; // 站在爆心上，没有"外"可退
  let moved = false;
  for (let i = 0; i < cells; i++) {
    const nx = victim.x + dx;
    const ny = victim.y + dy;
    if (!c.api.canStandAt(c.view, nx, ny, victim.type, { ignoreUnits: true })) break;
    // 地形站得住还不够：那一格不能已经有人（空中/地面各一个的规则交给 isAirborne）
    const occupied = c.view.units.some(
      (o) => o !== victim && o.hp > 0 && coversTile(c.view, o, nx, ny),
    );
    if (occupied) break;
    victim.x = nx;
    victim.y = ny;
    moved = true;
  }
  return moved;
}

/**
 * 击落：把空中单位按回地面。
 *
 * 落点上原本站着地面单位时按血量对撞——**血多者活，活的那个扣掉对方的血量**。
 * 相等的血量算"被挡下"（坠落方死）：平局不该让进攻方白赚一个击杀。
 */
function knockDown(c: SkillCtx, victim: Unit, notes: string[]): void {
  if (!c.api.isAirborne(c.state, victim)) return;
  const s = c.state;
  const vName = c.api.utype(s, victim.type).name;
  victim.layer = 'ground';

  const ground = s.units.find(
    (o) =>
      o !== victim &&
      o.hp > 0 &&
      !c.api.isAirborne(s, o) &&
      coversTile(s, o, victim.x, victim.y),
  );
  if (!ground) {
    notes.push(`${vName}被击落`);
    return;
  }

  const gName = c.api.utype(s, ground.type).name;
  if (victim.hp > ground.hp) {
    const toll = ground.hp;
    c.api.killUnit(s, ground, victim, `${gName}被坠落的${vName}当场砸死`);
    c.api.hurt(s, victim, toll, {
      source: c.self,
      logText: `${vName}砸穿${gName}，自己也掉了 ${toll} 点血`,
    });
    notes.push(`${vName}坠落砸死${gName}`);
    return;
  }
  c.api.killUnit(s, victim, ground, `${vName}坠落时被${gName}挡下，当场殒命`);
  notes.push(`${vName}坠落被${gName}挡死`);
}

/** 把一片区域的地形改成平原（保留城池归属与格子上的扩展数据） */
function flattenArea(c: SkillCtx, point: { x: number; y: number }, radius: number): boolean {
  const view = c.view;
  let changed = false;
  for (const { x, y } of blastCoords(view, point, radius)) {
    const i = y * view.w + x;
    const tile = view.tiles[i];
    if (!tile || tile.terrain === 'plain') continue;
    // 只换地形，`cityId` / `custom`（灵气浓度等）原样保留
    view.tiles[i] = { ...tile, terrain: 'plain' };
    changed = true;
  }
  return changed;
}

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('blast', (c) => {
  const p = spellCustom<BlastParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const radius = Number(p.spellRadius ?? 0);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  const cast = resolveCast(c, {
    cost,
    range,
    mode: 'area',
    radius,
    noTargetReason: () => '选一个落点',
    emptyReason: () => '那里没有敌人',
    tooFarReason: () => `太远了（${skillName}射程 ${range} 格）`,
  });
  if (!cast.ok) {
    c.result.ok = false;
    c.result.reason = cast.reason;
    return;
  }

  const dmg = blastDamage(p, self, getRank(self));
  const { total, killed } = strikeAll(
    c,
    cast.victims,
    dmg,
    {
      hurt: (v) =>
        `${name}的${skillName}扫过，${c.api.utype(s, v.type).name} 受到 ${dmg} 点伤害`,
      kill: (v) => `${c.api.utype(s, v.type).name}在${skillName}中化为飞灰`,
    },
    { physical: p.physical },
  );

  // 状态只挂给活人：给尸体挂定身解释不通，也会让战报读起来莫名其妙
  const notes: string[] = [];
  for (const v of cast.victims) {
    if (v.hp <= 0) continue;
    if (p.stun) stunFor(v, p.stun);
    if (p.root) rootFor(v, p.root);
    if (p.sunder) timedStatusFor((u, k, n) => c.api.putStatus(u, k, n), v, 'sunder', p.sunder);
    // 先击退再击落：落点按最终位置算，撞到的人才是真的被压到的那个
    if (p.knockback) knockback(c, v, cast.point, p.knockback);
    if (p.downAir) knockDown(c, v, notes);
  }

  const flattened = p.flatten ? flattenArea(c, cast.point, radius) : false;

  // 余场：焱烧过的地方会继续着火（复用族 3 的放场逻辑，不另写一套）
  let leftField = 0;
  if (p.leaveField) {
    leftField = placeField(s, c.view, {
      owner: self.owner,
      kind: p.leaveField.kind,
      center: cast.point,
      radius,
      dmg: Math.max(1, Math.round(dmg * p.leaveField.ratio)),
      charges: p.leaveField.rounds,
      physical: p.physical,
    });
  }

  // 生命汲取按**实际造成的伤害**算：打在护甲上被削掉的部分不该变成奶
  let healed = 0;
  if (p.lifesteal && total > 0) {
    const before = self.hp;
    self.hp = Math.min(c.api.maxHpOf(s, self), self.hp + Math.round(total * p.lifesteal));
    healed = self.hp - before;
  }
  c.api.noteHeat(s, cast.point.x, cast.point.y);

  const bits: string[] = [`命中 ${cast.victims.length} 名敌人，共造成 ${total} 点伤害`];
  if (killed > 0) bits.push(`${killed} 名当场殒命`);
  if (healed > 0) bits.push(`回复 ${healed} 点生命`);
  if (flattened) bits.push('地形化为平原');
  if (leftField > 0) bits.push(`留下 ${leftField} 格余烬`);
  if (notes.length > 0) bits.push(...notes);
  c.result.log = `${name}施放${skillName}，${bits.join('，')}（耗 ${cost} 灵力）`;
});

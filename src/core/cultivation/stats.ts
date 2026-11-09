// 境界加成属性修正，返回的是增量

import type { Unit } from '../types.ts';
import { getRank, getAgingYears } from './progression.ts';
import { isSpirit, isSoulMasterSpirit, isSwordCultivatorType, isBodyCultivatorType } from './identity.ts';

// ── 境界基础加成：公式的单一真相 ──────────────────────────
//
// 这一组回答的是"修到第 r 层，本身给了多少"，所以：
//   · **不乘**流派系数（灵体 ×0.1、剑修 ×0.8 是各自的设计，不是境界的功劳）；
//   · **不扣**衰老（超龄的惩罚在「油尽灯枯」里单独列，扣两遍玩家就对不上账）。
//
// 面板那句「境界加成」印的就是 `realm*Base`；战斗结算走下面那些 `*Modifier`，
// 它们在同一个 `*Raw` 上再乘系数、再扣衰老。改公式只改 `*Raw` 一处。

/** 攻击的原始值（未取整、未乘流派系数、未扣衰老） */
function atkRaw(rank: number): number {
  // 由于攻击次数和溅射太强，这里的基础数值略为削弱
  return (5 * rank + 2 ** (rank - 0.5)) / ((rank + 1) ** 0.2);
}
/** 护甲的原始值（未取整、未乘灵体倍率、未扣衰老） */
function armorRaw(rank: number): number {
  return -1 + rank * rank + 1.5 ** rank;
}
/** 射程的原始值（未取整、未乘灵体倍率） */
function rangeRaw(rank: number): number {
  return rank / 2;
}

/** 境界带来的攻击加成（面板用） */
export function realmAtkBase(rank: number): number {
  return Math.ceil(atkRaw(rank));
}
/** 境界带来的护甲加成（面板用） */
export function realmArmorBase(rank: number): number {
  return Math.ceil(armorRaw(rank));
}
/** 境界带来的射程加成（面板用） */
export function realmRangeBase(rank: number): number {
  return Math.floor(rangeRaw(rank));
}
/** 境界带来的神识加成（面板用）。一级一格，本来就是整数，不用取整 */
export function realmVisionBase(rank: number): number {
  return rank;
}

// 下面四个同理：规则书要按境界列表格，所以都提供"只吃境界"的版本，
// 单位版（带流派系数/衰老）只是它的薄包装。

/** 境界带来的真元（真实伤害） */
export function trueDamageForRank(rank: number): number {
  return Math.floor(rank * rank / 4 + rank * (1.2 ** rank));
}
/** 境界带来的额外攻击次数（总次数 = 1 + 它） */
export function extraAttacksForRank(rank: number): number {
  return Math.max(0, Math.floor((rank - 1) / 2));
}
/** 境界带来的溅射半径 */
export function splashForRank(rank: number): number {
  return Math.floor(rank / 4);
}
/** 境界带来的移动力 */
export function moveForRank(rank: number): number {
  return Math.floor(rank / 3);
}

// ── 灵体系数 ──────────────────────────────────────────
// 和剑修那组倍率一样抽成常量：三条 *Modifier 共用一份，改倍率只改这里。
// 注意：灵体目前**不渲染**修士面板（getCultivationPanelLines 的闸门只放
// 修士 id），所以下面这些倍率暂时没有对应的文案行，别为它写死数字。
export const SPIRIT_ATK_MUL = 0.1;
export const SPIRIT_ARMOR_MUL = 10;
export const SPIRIT_RANGE_MUL = 0.5;
export const SPIRIT_MOVE_MUL = 1.2;

/** 灵体的境界射程加成（打对折后向上取整） */
export function spiritRangeForRank(rank: number): number {
  return Math.ceil((rank / 2) * SPIRIT_RANGE_MUL);
}

// ── 体体系数 ──────────────────────────────────────────
// 体修是"用拳头吃饭"的一支：境界加成偏攻击，其余几项折半。
// 抽成常量而不是散在 if 里，是因为面板（panel.ts）要按同一份数字写说明，
// 改倍率时不能只改一处。
//
// 为什么不动护甲和攻击次数：那两项是"能扛多久/能打几下"，体修的定位是
// 站得住的近战，砍了这两项就真成沙包了。
export const BODY_ATK_MUL = 1.1;
export const BODY_TRUE_DAMAGE_MUL = 0.5;
export const BODY_MOVE_MUL = 0.5;
export const BODY_RANGE_MUL = 0.5;

/** 体修的境界射程加成（境界射程折半，向下取整） */
export function bodyRangeForRank(rank: number): number {
  return Math.floor((rank / 2) * BODY_RANGE_MUL);
}

/** 要不要按"被削弱过的灵体"折算（未来的魂修不吃这一套） */
function isWeakenedSpirit(u: Unit): boolean {
  return isSpirit(u) && !isSoulMasterSpirit(u);
}

/** 攻击力修正：境界，衰老 −2/岁 */
export function atkModifier(u: Unit): number {
  return realmAtkFor(u) - getAgingYears(u) * 2;
}

/**
 * 面板用：这一境界按流派折算后，实际加多少攻击（**不扣衰老**）。
 *
 * 和 `realmAtkBase` 的区别是它认流派系数：剑修 ×0.8、体修 ×1.1。
 * 界面上那行「境界加成」印的是纯境界值（那是有意为之，见 panel.ts），
 * 所以体修要额外说明"折算后实际是多少"时用这个，别自己再乘一遍。
 */
export function realmAtkFor(u: Unit): number {
  const mul = isWeakenedSpirit(u)
    ? SPIRIT_ATK_MUL
    : isBodyCultivatorType(u.type)
      ? BODY_ATK_MUL
      : 1;
  return Math.ceil(atkRaw(getRank(u)) * mul);
}

/**
 * 真元：**只看境界与流派**的裸值。
 *
 * 这是"这个修士修炼到什么程度"，不含任何外面给的加成。
 * 要算"这一下实际打多少真元"，用 `effectiveTrueDamage(s, u)`。
 */
export function trueDamageOf(u: Unit): number {
  const base = trueDamageForRank(getRank(u));
  return isBodyCultivatorType(u.type)
    ? Math.floor(base * BODY_TRUE_DAMAGE_MUL)
    : base;
}

/**
 * 真元：把**裸值**和**外部加成**合成"这一下实际打多少"。
 *
 * 单独抽出来而不是改 `trueDamageOf` 的签名：后者是几十条测试和面板在用的
 * "境界给了我多少"，把它和"今天实际有多少"混成一件事之后，面板就没法
 * 分开说了。两件事，两个函数。
 *
 * `pct` 是"加成多少比例"（0.1 = +10%），由调用方去查——**这一层不能自己查**：
 * `stats.ts` 在初始化链的最上游（packs → units → stats），往这里 import
 * `auras.ts` 会把 ability-registry 提前拉起来，而它顶层要遍历 EXPANSIONS，
 * 当场炸 "Cannot access 'EXPANSIONS' before initialization"。
 *
 * 给 **+1 保底**：低境界修士真元只有 1~2 点，10% 取整是 0，
 * 不给保底这条光环在前期等于不存在。
 */
export function trueDamageWithMods(base: number, pct: number | null | undefined): number {
  if (base <= 0) return 0;
  if (!pct || pct <= 0) return base;
  return base + Math.max(1, Math.round(base * pct));
}

/** 攻击次数修正 */
// x=0~2 -> 1次，x=3~4 -> 2次，x=5~6 -> 3次，x=7~8 -> 4次，x=9 -> 5次。
export function attTimesModifier(u: Unit): number {
  return extraAttacksForRank(getRank(u));
}

/** 生命修正 */
export function HpModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (rank - 1) / 2;
  return Math.max(0, Math.floor(realmsModifier));
}

/** 护甲修正：境界，衰老 −1/岁 */
export function armorModifier(u: Unit): number {
  const rank = getRank(u);
  const scaled = armorRaw(rank) * (isWeakenedSpirit(u) ? SPIRIT_ARMOR_MUL : 1);
  return Math.ceil(scaled) - getAgingYears(u);
}

/** 移动修正 */
export function moveModifier(u: Unit): number {
  if (isWeakenedSpirit(u)) return Math.ceil((getRank(u) / 3) * SPIRIT_MOVE_MUL);
  const base = moveForRank(getRank(u));
  // 体修身法笨重：境界带来的移动也折半（基础移动力不折，那是兵种的事）
  return isBodyCultivatorType(u.type) ? Math.floor(base * BODY_MOVE_MUL) : base;
}

/** 溅射范围修正 */
export function SplashModifier(u: Unit): number {
  return splashForRank(getRank(u));
}

/** 射程修正 */
export function RangeModifier(u: Unit): number {
  const rank = getRank(u);
  if (isWeakenedSpirit(u)) return spiritRangeForRank(rank);
  if (isBodyCultivatorType(u.type)) return bodyRangeForRank(rank);
  return realmRangeBase(rank);
}

/** 视野修正 */
export function VisionModifier(u: Unit): number {
  const rank = getRank(u);
  const aging = getAgingYears(u);
  const realmsModifier = rank;
  return Math.floor(realmsModifier-aging);
}

// ── 剑修伤害倍率 ──────────────────────────────────
// 普攻 ×0.8，剑气纵横期间 ×1.2；非剑修 ×1.0。
// 抽在这里是为了让 hooks.ts（伤害/攻城/面板修正）和 panel.ts（文案）
// 共用同一份规则，改倍率只改这里。
export const SWORD_BASE_MUL = 0.8;
export const SWORD_SWEEP_MUL = 1.2;
export function swordMul(u: Unit): number {
  if (!isSwordCultivatorType(u.type)) return 1.0;
  return u.custom?.swordSweepActive === true ? SWORD_SWEEP_MUL : SWORD_BASE_MUL;
}

// ── 战斗历练（击杀经验）──────────────────────────
// 规则单一真相：击杀经验只在这里算，hooks.ts 只负责读写额度。
//
// 设计目标：外出历练是**一条极其艰难的路**——给到 7 级是奖励，不是常规路线。
// 实现上有三重闸：
//   1. 目标要"值得一战"：基础攻击力必须高于当前境界的门槛，清杂兵没有收益；
//   2. 收益随境界衰减：越往上，同一个人头越不值钱（rank 7+ 直接归零）；
//   3. 每回合封顶：防止 AOE 清屏一夜暴富。
//
// 不看造价是有意的：召唤物没有造价，有些还很难打。
//
// 为什么数字长这样（2026-11-06 推演，W=1.65 的墙 + 这套系数）：
//   · 炼气士就算每回合满编 9 杀 + 4 块灵田，6 级也差 49 点，老死在 6 级；
//   · 剑修每回合 6 杀 + 4 田，能在 66 岁前后摸到 7 级（寿元 73）；
//   · 纯挂机仍然是 4 级坐化。
// 这三条的数值被 cultivation.test.ts 的"历练"用例钉住了，改系数会红。

/** 单次击杀的名义历练基数（未乘境界系数、未乘流派倍率） */
export const KILL_EXP_BASE = 3;

/** 下标 = 击杀者境界，值 = 名义历练系数。rank 7+ 为 0：战斗摸不到更高境界。 */
export const KILL_EXP_RANK_FACTOR = [1.8, 1.8, 1.5, 1.2, 0.8, 0.5, 0.15, 0, 0, 0];

/**
 * 下标 = 击杀者境界，值 = 目标 atk 必须严格大于它才给历练。
 * rank 0-1 只要 atk > 0 就给；越高境界门槛越高，高境界清杂兵自动无收益。
 * rank 8-9 的 99 是"基本过滤一切"，和 factor 的 0 是双重保险。
 */
export const KILL_EXP_MIN_ATK_BY_RANK = [0, 0, 1, 2, 3, 5, 8, 12, 99, 99];

/** 剑修实战历练倍率。配合 getExpGrowth 对剑修减半的人设：打坐慢，杀人快。 */
export const SWORD_KILL_EXP_MUL = 2;

/**
 * 每回合击杀经验上限 = KILL_EXP_CAP_BASE + KILL_EXP_CAP_PER_RANK × 境界。
 *
 * 为什么跟着境界长：封顶的目的是挡"低境界一波 AOE 刷穿前五级"，而不是挡
 * 高境界正常打架。定值的话两头约束力差好几倍——rank 0 时两个头就顶格，
 * rank 6 却要杀满十个。
 *
 * 早期上限必须给够（rank 0 = 6，是打坐的 3 倍），否则剑修的"以杀证道"
 * 在前期就被上限抹平：他和炼气士拿一样多的封顶，却只有一半打坐收入。
 * 这条是推演出来的，不是拍的——上限压到 rank+2 时，剑修反而比炼气士晚到 6 级。
 */
export const KILL_EXP_CAP_BASE = 6;
export const KILL_EXP_CAP_PER_RANK = 3;

/** 从按 rank 索引的表里取值，越界钳到两端，防止未来加 rank 时 undefined。 */
function rankIndex(table: readonly number[], rank: number): number {
  const i = Math.min(Math.max(rank, 0), table.length - 1);
  return table[i] ?? 0;
}

/** 该境界每回合最多拿到多少击杀经验 */
export function killExpCapOfRank(rank: number): number {
  return KILL_EXP_CAP_BASE + KILL_EXP_CAP_PER_RANK * Math.max(0, rank);
}

/** 该目标是否"值得一战"：基础攻击力必须超过当前境界的门槛。 */
export function isWorthFighting(killerRank: number, victimAtk: number): boolean {
  return victimAtk > rankIndex(KILL_EXP_MIN_ATK_BY_RANK, killerRank);
}

/**
 * 按境界查单次击杀的历练（纯函数，不碰 Unit）。
 * 规则书那张"各境界历练表"直接用它，免得手打一份会过期的数字。
 */
export function killExpForRank(rank: number, victimAtk: number, sword: boolean): number {
  if (!isWorthFighting(rank, victimAtk)) return 0;
  const factor = rankIndex(KILL_EXP_RANK_FACTOR, rank);
  return Math.round(KILL_EXP_BASE * factor * (sword ? SWORD_KILL_EXP_MUL : 1));
}

/**
 * 单次击杀的"名义历练"，不含单回合封顶。不通过门槛（低攻靶子）返回 0。
 * `victimAtk` 由调用方从 `state.unitTypes[victim.type].atk` 取（基础值）。
 *
 * 取整放在**最后一步**：先 round(基数 × 境界系数) 再乘剑修倍率会把小数吃掉——
 * rank 6 的 0.45 先取整成 0，剑修就永远是 0 了。
 */
export function killExpPerKill(killer: Unit, victimAtk: number): number {
  return killExpForRank(getRank(killer), victimAtk, isSwordCultivatorType(killer.type));
}

/**
 * 实际入账的击杀经验：名义值再受本回合剩余额度限制。
 * `usedThisTurn` 由调用方从 `custom.killExpThisTurn` 读出。
 */
export function calcKillExp(killer: Unit, usedThisTurn: number, victimAtk: number): number {
  const nominal = killExpPerKill(killer, victimAtk);
  const left = Math.max(0, killExpCapOfRank(getRank(killer)) - usedThisTurn);
  return Math.min(nominal, left);
}
/**
 * 宗门大殿：一座靠"相邻的修士"驱动的大建筑。
 *
 * ── 设计（2026-11-08 敲定）────────────────────────────────
 *
 * 它自己没有战斗力、不产资源，两个功能都挂在**贴着它站的那些修士**身上：
 *
 *   1. **招募弟子**：相邻有哪位修士（且境界 ≥ 2 期）就能用灵石招哪位修士。
 *      师父是门槛也是名单——想让宗门出剑修，就得把剑修师父搬过来站着。
 *   2. **传承**：贴着宗门打坐的低阶修士，效率 × (相邻最高境界 − 自己 − 1)，
 *      最低 ×1。所以"差 3 期"才开始有加成（差 2 期算下来还是 1）。
 *
 * 两条共用同一个"相邻"口径（2×2 的四邻环，8 格），于是宗门该修在哪儿
 * 变成一道很具体的题：**修在修士堆里**。师父走开，宗门立刻停产；
 * 弟子走开，立刻吃不到传承。
 *
 * ── 为什么不相邻就什么都干不了 ──────────────────────────────
 *
 * 宗门不是"兵营 + 大学"的合体，它是**一个师徒关系的容器**。把功能做成
 * 建筑自带的，就变成了"盖好就自动出修士、自动加速"，师父这个角色就白设计了。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（原因见 skills/sky-step.ts 顶部）。
 * 需要宗门 id 时由 `identity.ts` 提供。README 的依赖图里它和 `artifacts.ts` 同层。
 */
import type { GameState, Unit } from '../types.ts';
import { distBetweenUnits, underConstruction } from '../query.ts';
import { UNIT_IDS, isCultivatorUnit } from './identity.ts';
import { getRank } from './progression.ts';

/** 宗门大殿的兵种 id（`units.ts` 与钩子都从这里取，别各写一份字面量） */
export const SECT_ID = UNIT_IDS.SECT;

/**
 * 「相邻」= 矩形距离 1。
 *
 * 宗门占 2×2，所以这是一圈 8 格（上下各 2、左右各 1×2）；
 * `distBetweenUnits` 按两个矩形的最近距离算，n = 1 的修士自然落在里面。
 */
export const SECT_ADJACENT = 1;

/**
 * 能当师父的最低境界。
 *
 * 2 期（筑基）是"教得动徒弟"的门槛：0 期修士连自己都还在打坐，
 * 让他开坛收徒等于把宗门变成免费的修士工厂。
 */
export const SECT_MASTER_MIN_RANK = 2;

/** 招募弟子：多少金币的价，折成 1 块灵石 */
export const SECT_GOLD_PER_STONE = 10;

/**
 * 宗门里招一个弟子要多少灵石。
 *
 * 直接按兵种表上的金币价折算，而不是另写一张价目表：
 * 兵种调价时招募价自动跟着走，不会出现"剑修涨到 300 金、宗门还按 27 灵石卖"。
 */
export function sectRecruitStone(baseGold: number): number {
  return Math.max(1, Math.round(baseGold / SECT_GOLD_PER_STONE));
}

/**
 * 贴着这座宗门站的己方修士（活着的、站着的，没在施工）。
 *
 * 只认**己方**：敌方修士站在你宗门口不该替你出徒弟，也不该给你当师父。
 * 「能不能被治疗」那条不适用——修士都是肉长的，没有机械修士。
 */
export function adjacentOwnCultivators(s: GameState, sect: Unit): Unit[] {
  const out: Unit[] = [];
  for (const u of s.units) {
    if (u.id === sect.id || u.owner !== sect.owner) continue;
    if (u.hp <= 0) continue;
    if (underConstruction(u)) continue;
    if (!isCultivatorUnit(s, u)) continue;
    if (distBetweenUnits(s, u, sect) > SECT_ADJACENT) continue;
    out.push(u);
  }
  return out;
}

/**
 * 这座宗门此刻能招哪些**流派**：相邻师父里境界够的那几种。
 *
 * 返回的是兵种 id 集合，不是"一个师父"——同一种流派站两个师父不会翻倍，
 * 招募是"有没有这个流派"的问题，不是"几个师父"的问题。
 */
export function sectRecruitableTypes(s: GameState, sect: Unit): Set<string> {
  const out = new Set<string>();
  for (const u of adjacentOwnCultivators(s, sect)) {
    if (getRank(u) < SECT_MASTER_MIN_RANK) continue;
    out.add(u.type);
  }
  return out;
}

/**
 * 这座宗门里、境界最高的那位相邻修士（当师父的那位）。没有就 null。
 *
 * 同境界按**血量多者优先、再看 id** 取一个，和守阵修士同一条兜底：
 * 联机两边各自遍历 `s.units`，顺序不同会让同一帧算出不同的师父。
 *
 * `exclude` 用来把"正在受益的那个弟子"排除掉——自己不能当自己的师父。
 */
export function sectMasterOf(s: GameState, sect: Unit, exclude?: Unit): Unit | null {
  let best: Unit | null = null;
  for (const u of adjacentOwnCultivators(s, sect)) {
    if (exclude && u.id === exclude.id) continue;
    if (!best) {
      best = u;
      continue;
    }
    const a = getRank(u);
    const b = getRank(best);
    if (a > b || (a === b && (u.hp > best.hp || (u.hp === best.hp && u.id < best.id)))) best = u;
  }
  return best;
}

/**
 * 传承的加成倍率：`max(1, 师父境界 − 自己境界 − 1)`。
 *
 * 为什么减 1：不減的话"师父 2 期、徒弟 0 期"就是 ×2，两个回合差一级的说法
 * 太廉价。减完之后 2 期师父带 0 期徒弟仍然是 ×1（白搭），3 期才 ×2 ——
 * 也就是**差 3 期起跳**。这条是有意设计，规则书里必须写清楚，否则玩家会算错。
 *
 * 多个宗门不叠乘，取最强的一条（和所有光环同口径）。
 * 不吃这条加成的只有"不在宗门边上"的人——距离本身就是门槛。
 */
export function sectLegacyMul(s: GameState, u: Unit): number {
  const rank = getRank(u);
  let best = 1;
  for (const sect of s.units) {
    if (sect.type !== SECT_ID || sect.owner !== u.owner) continue;
    if (sect.hp <= 0) continue;
    if (distBetweenUnits(s, u, sect) > SECT_ADJACENT) continue;
    const master = sectMasterOf(s, sect, u);
    if (!master) continue;
    best = Math.max(best, getRank(master) - rank - 1);
  }
  return Math.max(1, best);
}

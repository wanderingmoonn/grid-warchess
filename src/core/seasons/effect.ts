/**
 * 天气效果：**由驱动算，不由标签算**。
 *
 * ── 为什么改 ──────────────────────────────────────────────
 *
 * 以前是"先判一个标签，再查一张 16 行的效果表"。那是表格时代的形状：
 * 一个字对应一组固定的加成，所以"大风"必须只在那一个标签里成立，
 * "湿热"必须独占 2.5 倍产出。
 *
 * 但这些量本来就是连续的：温度、湿度、风、降水、抬升。现在改成
 *   · 每个驱动**各自**算一档（气温 5°C 一档、湿度三段、风一条线）；
 *   · 效果由这些档**叠加**得出；
 *   · 标签只用来画图标和染色，不再决定任何数字。
 *
 * 于是"风够大就飞不动"不再需要先判成「大风」，
 * "又潮又暖就多打粮"也不再需要先判成「湿热」。
 *
 * ── 两条合并规则 ──────────────────────────────────────────
 *
 *   1. **产出用加法，不用乘法**。以前「湿热」是 ×2.5，再叠「温暖」的 ×1.25
 *      就是 3.1 倍——乘数一多必然失控。现在所有加成都是百分点相加
 *      （+15% + 20% = +35%），再整体夹在 [−60%, +90%] 里。
 *   2. **同类取最严**。移动预算、护甲、视野、射程各自只取一条：严冬的
 *      ×0.5 和暴雨的"每格 +1"是两个维度可以叠加，但两个都减预算的不会叠。
 *
 * ── 维护费改成固定值 ──────────────────────────────────────
 *
 * 原来是"造价的百分之几"。问题是这样算：低时代的经济单位（45 金、每回合 +7）
 * 和高时代（260 金、每回合 +48）按同一个比例交，高时代那笔钱相对产出微不足道，
 * 低时代却是实打实的负担——但比例制反而让**贵的单位交得更多**，方向反了。
 *
 * 改成每单位固定几金：廉价单位交起来心疼，高级单位几乎无感。
 * 这正是"高时代经济更能扛天气"该有的样子。
 */
import {
  distToLandOf,
  isWaterTerrain,
  precipAt,
  satEffAt,
  tempAt,
  TUNING,
  upliftAt,
  wetAt,
  windSpeedAt,
  type Precip,
} from './field.ts';
import type { ClimateEffect } from './climate.ts';
import type { GameState } from '../types.ts';

/** 算效果要的五个驱动（都是每格现成的量） */
export interface WeatherDrivers {
  /** 气温（0.1°C）。水面就是水温 */
  temp: number;
  /** 相对湿度（%） */
  rh: number;
  /** 降水强度 */
  precip: Precip;
  /** 风速（百分之一格/步） */
  wind: number;
  /** 辐合抬升量（正 = 空气在往上走） */
  lift: number;
  /** 这一格是不是水面（水温的判据和气温是两套） */
  water: boolean;
  /** 离岸格数；陆地传 0 */
  distToLand: number;
}

/**
 * 气温 → 产出加成（百分数）。**每 5°C 一档**，10~20°C 是舒适带。
 *
 * `below` 是这一档的上界（0.1°C）：温度低于它才落进这一档。
 * 冷的方向掉得比热的方向涨得快——冻死庄稼比热死容易。
 */
const TEMP_INCOME: Array<{ below: number; bonus: number }> = [
  { below: -100, bonus: -0.5 }, // 严冬
  { below: -50, bonus: -0.35 },
  { below: 0, bonus: -0.25 },
  { below: 50, bonus: -0.15 },
  { below: 100, bonus: -0.05 }, // 5~10°C
  { below: 200, bonus: 0 }, // 10~20°C 舒适带
  { below: 250, bonus: 0.05 },
  { below: 300, bonus: 0.1 },
  { below: 320, bonus: 0.15 },
  { below: Infinity, bonus: 0.2 }, // 32°C 以上
];

/** 相对湿度 → 产出加成（%）。中间那段是"正常"，两头才是天气 */
const WET_INCOME: Array<{ below: number; bonus: number }> = [
  { below: 45, bonus: -0.1 }, // 旱
  { below: 80, bonus: 0 },
  { below: 95, bonus: 0.2 }, // 潮
  { below: Infinity, bonus: 0.25 }, // 快饱和
];

/** 产出加成的总闸：再极端的组合也不许超出这个区间 */
const INCOME_MIN = -0.6;
const INCOME_MAX = 0.9;

/** 湿度到这条线就开始收维护费（固定金额见 TUNING.weatherUpkeep） */
const HUMID_AT = 80;

/** 浓雾把视野和射程压到多少（两者同一个数：看不清就打不准） */
const FOG_CAP = 2;
/** 浓雾只按得住视野不超过这个数的部队；更高的照常看 */
const FOG_VISION_LINE = 5;

function tierBonus(tiers: Array<{ below: number; bonus: number }>, v: number): number {
  for (const t of tiers) if (v < t.below) return t.bonus;
  return 0;
}

/**
 * 这一格的天气效果。
 *
 * 顺序无所谓（除了"同类取最严"那几处），因为每一档只往各自维度的槽里写。
 */
export function weatherEffect(d: WeatherDrivers): ClimateEffect {
  const e: ClimateEffect = {};

  /* ── 气温：产出 / 移动 / 护甲 ───────────────────────── */
  const tempBonus = tierBonus(TEMP_INCOME, d.temp);
  if (d.temp < -100) {
    // 严冬：地冻三尺，走不动也长不出东西
    e.moveMul = 0.5;
    e.armorPenalty = 3;
    e.armorPenaltyOnlyField = true;
  } else if (d.temp >= 320) {
    // 32°C 以上：热到走不动
    e.moveMul = 0.5;
    e.armorPenalty = 2;
  } else if (d.temp >= 270) {
    e.armorPenalty = 1;
  } else if (d.temp >= 50 && d.temp < 100) {
    // 5~10°C：行军最舒服的一段
    e.moveAdd = 1;
  }

  /* ── 湿度：产出 + 维护费 ────────────────────────────── */
  let income = tempBonus + tierBonus(WET_INCOME, d.rh);
  if (d.rh >= HUMID_AT) {
    // 潮湿天要额外养兵/养工：**固定金额**，不看造价
    e.upkeepGold = TUNING.weatherUpkeep;
    e.upkeepHpRatio = 0.1;
  }

  /* ── 降水：射程 / 每格消耗 / 产出 ───────────────────── */
  if (d.precip === 'light') {
    e.rangeAdd = -1;
    income += 0.15; // 阴雨养地
  } else if (d.precip === 'heavy') {
    e.rangeAdd = -2;
    e.moveCostAdd = 1; // 路烂了
    income += 0.05;
  }

  /* ── 风：只打空军，**不看温度** ─────────────────────── */
  if (d.wind >= TUNING.galeAt) e.airUpwindCostAdd = 1;

  /* ── 浓雾：视野与射程各封一道 ───────────────────────── */
  //
  // 只在**偏凉**的时候起雾、并且不能在下雨：雾是夜里地面辐射冷却的产物，
  // 28°C 加 85% 湿度是闷热，不是雾。少了这道温度闸，整个夏天都会是雾天。
  //
  // 只管"本来就看不太远"的部队（视野 ≤ `FOG_VISION_LINE`）：高时代那些
  // 视野 6 以上的侦察/指挥单位在雾里仍然看得见，只是没了优势——
  // 一律压到 2 等于把"看得远"这个卖点从它们身上没收掉。
  if (d.temp < TUNING.warmAt && d.precip === 'none' && d.rh >= TUNING.fogLine * 100) {
    e.visionMax = FOG_CAP;
    e.rangeMax = FOG_CAP;
    e.fogVisionLine = FOG_VISION_LINE;
    e.combo = 'fog';
  }

  /* ── 灾害：冰面 / 雷暴 / 风暴 ───────────────────────── */
  if (d.water) {
    if (d.temp <= 0) {
      e.navyMoveZero = true;
      e.landOnIce = true;
      e.combo = 'freeze';
    } else if (d.temp <= 45) {
      e.navyMoveMul = 0.75;
      e.combo = 'ice';
    } else if (d.precip === 'heavy') {
      if (d.temp >= TUNING.hotAt) {
        // 暖水上的暴雨：雷暴
        e.endDamage = { hits: 1, amount: 50, splash: 0.5, radius: 1 };
        e.combo = 'thunder';
      } else if (d.temp >= stormFloorOf(d.distToLand) && d.wind >= TUNING.stormWind) {
        // 风暴 = 雨大 + 风大 + 水暖 + 离岸够远，四个都满足才刮
        e.endDamage = { hits: 10, amount: 5 };
        e.combo = 'storm';
      }
    }
  } else if (d.precip === 'heavy' && d.temp >= TUNING.hotAt) {
    // 陆地上的雷雨：热 + 大雨。
    //
    // 不再额外要求"空气在上升"——抬升已经通过饱和线决定了**哪里下大雨**，
    // 再加一道闸会让"徽标写着雷暴、却不掉血"（判类不看抬升，效果看），
    // 玩家只会觉得天气坏了。
    e.endDamage = { hits: 1, amount: 50, splash: 0.5, radius: 1 };
    e.combo = 'thunder';
  }

  e.incomeBonus = Math.max(INCOME_MIN, Math.min(INCOME_MAX, income));
  return e;
}

/** 这一格的五个驱动（面板、判效、调参都用它） */
export function driversAt(s: GameState, x: number, y: number): WeatherDrivers {
  const tile = s.tiles[y * s.w + x];
  const water = isWaterTerrain(tile?.terrain);
  const sat = satEffAt(s, x, y);
  const wet = wetAt(s, x, y);
  return {
    temp: tempAt(s, x, y),
    // 相对湿度按**有效**饱和线算（含辐合抬升）：和降水判据同一个口径。
    // 夹在 100 以内：暴雨时过饱和量能到 110%，但面板上印"相对湿度 111%"
    // 只会让人怀疑是不是坏了——100% 就是"满"，多出来的部分已经变成雨。
    rh: sat > 0 ? Math.min(100, Math.round((wet / sat) * 100)) : 0,
    precip: precipAt(s, x, y),
    wind: windSpeedAt(s, x, y),
    lift: upliftAt(s, x, y),
    water,
    distToLand: water ? distToLandOf(s, x, y) : 0,
  };
}

/** 这一格的效果 */
export function effectAt(s: GameState, x: number, y: number): ClimateEffect {
  return weatherEffect(driversAt(s, x, y));
}

/** 单位脚下这一格的效果 */
export function effectOfUnit(s: GameState, u: { x: number; y: number }): ClimateEffect {
  return effectAt(s, u.x, u.y);
}

/** 离岸越远，起风暴要的水温越低（贴岸是玩家发育的地方，不该常年被堵着） */
function stormFloorOf(distToLand: number): number {
  if (distToLand <= 1) return TUNING.stormTemp.coast;
  if (distToLand <= 3) return TUNING.stormTemp.near;
  return TUNING.stormTemp.open;
}

/**
 * 效果翻成人话，**从字段派生**，不另写一份文案。
 *
 * 表格改了、说明跟着改——不会出现"界面上写着 −25%、实际已经调成 −50%"。
 * `signedPct` 只处理百分比，别的单位各自写。
 *
 * 组合效果（浓雾 / 雷暴 / 风暴 / 封冻 / 浮冰）**单独一行、带名字**，
 * 而且排在前面：这些不是"温度多少就减多少"能读出来的，是几个驱动凑到
 * 一起才成立的。玩家看着 18°C、湿度 78% 是估不出会不会起雾的，
 * 所以必须直接写"浓雾：……"，否则他只会看到"视野不超过 2"而不知道
 * 为什么，也不知道自己能不能躲开。
 */
export function effectLines(e: ClimateEffect): string[] {
  const out: string[] = [];
  const pct = (v: number) => `${v > 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%`;

  // ── 组合效果：先说"这是什么天气现象" ──
  switch (e.combo) {
    case 'fog':
      out.push(
        `浓雾：视野和射程都压到 ${e.visionMax ?? FOG_CAP}（只对视野 ≤${e.fogVisionLine ?? FOG_VISION_LINE} 的部队）`,
      );
      break;
    case 'thunder':
      out.push(`雷暴：回合末受 ${e.endDamage?.amount ?? 0} 点伤害，周围 1 格再吃一半`);
      break;
    case 'storm':
      out.push(
        `风暴：回合末受 ${e.endDamage?.hits ?? 0} 次 ${e.endDamage?.amount ?? 0} 点伤害（吃护甲）`,
      );
      break;
    case 'freeze':
      out.push('封冻：海军动不了，陆军可以踩着冰面走');
      break;
    case 'ice':
      out.push('浮冰：海军移动力 −25%');
      break;
    default:
      break;
  }

  if (e.incomeBonus !== undefined && Math.round(e.incomeBonus * 100) !== 0) {
    out.push(`经济产出 ${pct(e.incomeBonus)}`);
  }
  if (e.moveMul !== undefined && e.moveMul !== 1) out.push(`移动力 ${pct(e.moveMul - 1)}`);
  if (e.moveAdd) out.push(`移动力 ${e.moveAdd > 0 ? '+' : '−'}${Math.abs(e.moveAdd)}`);
  if (e.moveCostAdd) out.push(`每格移动消耗 +${e.moveCostAdd}`);
  if (e.airUpwindCostAdd) out.push(`空军逆风每格 +${e.airUpwindCostAdd}`);
  if (e.armorPenalty) {
    out.push(
      e.armorPenaltyOnlyField
        ? `不在城里的军队护甲 −${e.armorPenalty}`
        : `全军护甲 −${e.armorPenalty}`,
    );
  }
  if (e.rangeAdd) out.push(`攻击范围 ${e.rangeAdd > 0 ? '+' : '−'}${Math.abs(e.rangeAdd)}`);
  // 浓雾那两条已经被组合行讲过了，不再重复一遍
  if (e.combo !== 'fog') {
    if (e.rangeMax) out.push(`攻击范围不超过 ${e.rangeMax}`);
    if (e.visionMax) out.push(`视野不超过 ${e.visionMax}`);
  }
  if (e.endDamage && e.combo !== 'thunder' && e.combo !== 'storm') {
    const d = e.endDamage;
    const splash = d.splash ? `，溅射 ${d.radius ?? 1} 格 · 50%` : '';
    out.push(
      d.hits > 1
        ? `回合末受 ${d.hits} 次 ${d.amount} 点物理伤害`
        : `回合末受 ${d.amount} 点伤害${splash}`,
    );
  }
  if (e.upkeepGold) out.push(`每回合交 ${e.upkeepGold} 金维护费`);
  if (e.upkeepHpRatio) out.push(`维护费不足则掉 ${Math.round(e.upkeepHpRatio * 100)}% 生命上限`);
  if (e.navyMoveZero) out.push('海军移动力归零');
  if (e.navyMoveMul !== undefined && e.navyMoveMul !== 1) {
    out.push(`海军移动力 ${pct(e.navyMoveMul - 1)}`);
  }
  if (e.landOnIce) out.push('陆军可以在冰面上行走');
  return out;
}

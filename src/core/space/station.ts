/**
 * 空间站：核心舱飞上轨道，展开成一张小棋盘。
 *
 * ── 三条设计上的取舍 ────────────────────────────────────
 *
 * 1. **不运输、不施工队**。站上的东西全靠"花资源"直接长出来：
 *    铺一格甲板、造一座生产舱。玩家不用先派工兵，也不用等施工回合。
 *    太空战争的节奏已经够慢（发射 1 回合、航程 1 回合），再叠一层运输
 *    就只剩等待了。
 *
 * 2. **棋盘大小由核心舱型号决定**。5×5 / 7×7 / 9×9——同一套规则，
 *    不同的"地皮"。站一开始只有正中间一格，其余全是 `void`，
 *    所以"这个站能长多大"在发射那一刻就定了。
 *
 * 3. **建设费用吃"太空建设折扣"**，而折扣来自地球上火箭井的数量：
 *    井越多越便宜，但边际递减、软上限 +50%（见 `buildRate`）。
 *    于是"多盖井"和"多建站"是同一条投资曲线上的两段，而不是两个独立系统。
 */

import type {
  Board,
  GameState,
  PlayerId,
  SkillDef,
  StarLane,
  StarNodeId,
  StarStation,
  Transit,
  Unit,
  UnitTypeDef,
} from '../types.ts';
import { boardIdOf, boardOf, boardName, boardStateOf, EARTH, tileOn } from '../board.ts';
import { footprintOf, tilesOfUnit } from '../query.ts';
import { passable } from '../config.ts';
import { registerSkillEffect, registerSkillReadyCheck, registerSkillTargetCells, type SkillCtx } from '../skill-hooks.ts';
import { lanesFrom, laneDistance, nodeById, nodeName, nodeOf, peekStarmap, starmapOf } from './starmap.ts';
import { cellName, registerOrbitArrival } from './transit.ts';
import { SILO_ID } from './silo.ts';
import { SPACE_HAZARD } from './space-hazard.ts';
import { ASTRONAUT_ID } from './astronaut.ts';
import { registerHazardExempt } from '../hazard.ts';
import { setRecon } from '../recon.ts';
import type { UnitActionOption } from '../expansions.ts';

export const STATION_CORE_ID = 'station-core';
export const STATION_PRODUCER_ID = 'station-producer';
export const STATION_SOLAR_ID = 'station-solar';
export const STATION_LIFE_ID = 'station-life-support';
export const STATION_REMOTE_ID = 'station-remote';
export const STATION_LAB_GRAVITY_ID = 'station-lab-gravity';
export const STATION_LAB_MATERIAL_ID = 'station-lab-material';
export const STATION_COMM_ID = 'station-comm';
export const STATION_THRUSTER_ID = 'station-thruster';
/* ── 战斗舱段（2026-11-12）─────────────────────────────────────────
 * 前四个是"让站能打仗"，后三个是"把人送进别人家"。
 * 拆成四个 id 而不是一个"武器舱"，是因为它们的造价、耗电、位置约束
 * 各不相同，玩家在面板上也要一眼分清。
 */
export const STATION_CANNON_ID = 'station-cannon';
export const STATION_ARMOR_ID = 'station-armor';
export const STATION_LAUNCH_ID = 'station-launch';
export const STATION_DOCK_ID = 'station-dock';

/**
 * 上线测试期的**采用率折扣**：太空建设的额定价整体打七折。
 *
 * 为什么现在要动价格：这一包的门槛是"先花一大笔钱建井、再花一大笔钱发核心舱"，
 * 玩家在没体验过轨道玩法之前，看到的只有一串"很贵"，于是根本不会去用——
 * **用不上的东西测不出问题**。先把基础费用压下来换采用率，等有人用了再按实测
 * 调回去（数值平衡本来也留到内容冻结之后）。
 *
 * 只乘在**额定价**上，和"太空建设折扣"（发射井数量那条曲线）相乘，
 * 所以 0 座井仍然是最贵的一档（×1.5）。想调回去只改这一个数。
 */
export const PRICE_CUT = 0.7;

/** 额定价（会乘折扣，也会被 PRICE_CUT 打折） */
export const EXPAND_BASE_COST = 80;
/** 一座生产舱的额定价（会乘折扣） */
export const PRODUCER_BASE_COST = 320;
/** 一块太阳能舱的额定价（会乘折扣） */
export const SOLAR_BASE_COST = 240;
/** 一台推进器舱的额定价（会乘折扣） */
export const THRUSTER_BASE_COST = 420;
/** 一座维生仓的额定价（会乘折扣） */
export const LIFE_BASE_COST = 360;
export const REMOTE_BASE_COST = 380;
export const GRAVITY_BASE_COST = 450;
export const MATERIAL_BASE_COST = 450;
export const COMM_BASE_COST = 340;
export const CANNON_BASE_COST = 620;
export const ARMOR_BASE_COST = 300;
export const LAUNCH_BASE_COST = 380;
export const DOCK_BASE_COST = 320;

/**
 * 功能舱段（遥感 / 两个研究室 / 通讯）**必须相邻一名航天员**才工作。
 *
 * "相邻"按 4 邻域算，和移动、扩建、装卸同一套口径——玩家已经在用那套判断
 * "贴不贴得上"。8 邻域会让人以为斜角也算，而移动不能斜走。
 */
export const CREW_REACH = 1;
/** 生产舱每回合产多少金币 */
export const PRODUCER_INCOME = 6;

/* ── 能量：每座空间站自己的一条账 ──────────────────────────────
 *
 * 和「装甲与装配」里的电力同一条口径：**能量是派生指标，不是库存**。
 * 每次现算 `供 - 耗`，不攒、不存。
 *
 * 但两者的**范围**不同：装甲那边是"一方所有单位共用一条电网"，
 * 这里必须**每座站各算各的**——两座站隔着几万公里，不可能互相供电。
 * 所以 `stationPower` 收的是"哪张站棋盘"，不是"哪个玩家"。
 *
 * 数值取整是有意的：玩家在面板上要能心算"再来一块太阳能够不够"。
 */
/** 核心舱自带的一点电：让新站至少能带一座生产舱，不至于开局就断电 */
export const CORE_POWER = 10;
/** 一块太阳能舱发多少电 */
export const SOLAR_POWER = 12;
/** 一座生产舱吃多少电 */
export const PRODUCER_DRAW = 4;
/** 一台推进器吃多少电 */
export const THRUSTER_DRAW = 15;
/**
 * 一座维生仓吃多少电。
 *
 * 定成 8 而不是 12：核心舱自带 10 电，玩家造下第一座维生仓时不该立刻过载——
 * 那就变成"必须先造太阳能才能维持生命"，一步都走不动。
 * 8 让第一座刚好够，第二座就得先扩电，这才是"能量约束搭配"该有的节奏。
 */
export const LIFE_DRAW = 8;

/** 功能舱段的耗电（都要相邻航天员才工作，见 `isStaffed`） */
export const REMOTE_DRAW = 10;
export const GRAVITY_DRAW = 12;
export const MATERIAL_DRAW = 12;
export const COMM_DRAW = 8;
export const CANNON_DRAW = 14;
/**
 * 太空装甲**不耗电**。
 *
 * 它是一块焊在甲板上的板子，没有任何"要通电才工作"的东西。这不是随手给的
 * 优惠：如果它也吃电，"保护地板"就变成"先为了防御再造一块太阳能"，
 * 而防的那一格可能只要 80 金就能重铺——玩家不会去造第二块太阳能来救一格甲板。
 */
export const ARMOR_DRAW = 0;
export const LAUNCH_DRAW = 8;
export const DOCK_DRAW = 6;

/**
 * 轨道炮一发打多少（再照常扣护甲、扣地形掩护、过环境）。
 *
 * 30 这个数是"两发打不掉一块新装甲板"的量级：装甲舱 180 血、站内护甲被
 * 环境折过之后基本是 2~3，一发约 27~28。于是"守着破口"至少要挨七八发——
 * 防守方有整整两个回合去补人，而不是被一发穿透。
 */
export const CANNON_ATK = 30;
/** 入舱口能缓存几个单位（满了拒绝进入） */
export const DOCK_CAPACITY = 3;

/**
 * 废墟能撑几个"原主的回合"。
 *
 * 3 = 攻方至少要守住三个回合才能吃干抹净，守方也还有一次反打的机会。
 * 再长就变成"打林战"，再短就没人来得及接管。
 */
export const RUIN_TURNS = 3;
/**
 * 接管一座废墟的维护费：底价 + 每格规模。
 *
 * 按**规模**而不是按"里面剩几座舱段"算，是因为舱段对敌人不可见
 * （`hideUnit`）——按数量定价等于把情报标了价。5×5 的站 500 金、9×9 的 740。
 */
export const SALVAGE_BASE_COST = 200;
export const SALVAGE_PER_SIZE = 60;

/** 接驳站：太空部队降落的落点由它决定 */
export const LANDING_PAD_ID = 'landing-pad';
/**
 * 每颗星球每方一座。
 *
 * 它不走 `buildCost`（那是站内建设的账，乘的是太空建设折扣），而是一座
 * **地表建筑**，价格走通用的 `recruitResCost`——所以 `PRICE_CUT` 在这里
 * 手工乘一次，别让同一包里两套定价口径。
 */
export const LANDING_PAD_COST = Math.round(320 * PRICE_CUT);

/** 微重力研究室：每座 +5%，软上限 +20% */
export const GRAVITY_PER = 0.05;
export const GRAVITY_CAP = 0.2;
/** 材料研究室：每座全方护甲 +1，软上限 +5 */
export const MATERIAL_PER = 1;
export const MATERIAL_CAP = 5;
/** 通讯模块：每座全方视野 +1，软上限 +3 */
export const COMM_PER = 1;
export const COMM_CAP = 3;

/**
 * 维生仓的覆盖半径（曼哈顿距离，含自己那一格）。
 *
 * 为什么是半径而不是"全站"：全站豁免让维生仓变成一次性开关——站再大、
 * 人再多，一座就够，它就只是一笔必交的税。半径逼玩家把舱段围着它布置，
 * 站要长大就得再添一座，于是"站越大越贵"这条曲线自然长出来。
 */
export const LIFE_RADIUS = 3;

/** 每台推进器给航道加多少速度（速度 1 + n） */
export const THRUSTER_SPEED = 1;

/** 一种核心舱：定的是**站的棋盘边长**，核心舱本身是同一个兵种 */
export interface CoreDef {
  id: string;
  name: string;
  /** 站棋盘边长 */
  size: number;
  /** 额定价（会乘折扣） */
  cost: number;
  blurb: string;
}

export const CORE_DEFS: CoreDef[] = [
  { id: 'core-outpost', name: '哨站核心舱', size: 5, cost: 600, blurb: '5×5：小，但便宜，够放几座舱段' },
  { id: 'core-station', name: '空间站核心舱', size: 7, cost: 900, blurb: '7×7：标准尺寸，能铺出像样的站' },
  { id: 'core-hub', name: '枢纽核心舱', size: 9, cost: 1400, blurb: '9×9：大，贵，够放一整排舱段' },
];

export function coreDef(id: string): CoreDef | undefined {
  return CORE_DEFS.find((c) => c.id === id);
}

// ── 太空建设折扣 ─────────────────────────────────────────────────────

/**
 * 火箭井的**等效数量**。
 *
 * 现在只有一种发射井，所以就是"建好的井有几座"。
 * 以后分型号时，这里改成"按型号加权求和"——重型井算 1.5 座、轻型算 0.5 座，
 * 下面那条曲线一个字都不用改。
 *
 * 为什么要判 `underConstruction`：一座还没盖完的井不该开始打折，
 * 否则"先拍三座地基"就成了刷折扣的手法。
 */
export function siloWeight(s: GameState, player: PlayerId): number {
  if (!s.unitTypes[SILO_ID]) return 0;
  return s.units.filter(
    (u) => u.owner === player && u.type === SILO_ID && (u.buildNeed ?? 0) <= (u.buildDone ?? 0),
  ).length;
}

/**
 * 折扣率：正数 = 减免，负数 = 加价。
 *
 * `rate(n) = 0.5 − 0.8^n`
 *
 *   0 座井 → −50%（贵一半）
 *   1 座   → −30%
 *   2 座   → −14%
 *   3 座   → −1.2%（差不多平价）
 *   4 座   → +9%
 *   6 座   → +24%
 *   10 座  → +39%
 *   20 座  → +48.8%
 *
 * 为什么不是线性：线性要么需要封顶（到顶之后"再盖一座井"完全没意义），
 * 要么会算出 100% 以上的免单。这条曲线**永远不到 +50%**，所以每多一座井
 * 都还有一点点回报，只是越来越小——正是想要的激励形状。
 */
export function buildRate(s: GameState, player: PlayerId): number {
  return 0.5 - Math.pow(0.8, siloWeight(s, player));
}

/** 按折扣算出来的实际价格（至少 1 金，免得算成免费） */
export function buildCost(s: GameState, player: PlayerId, base: number): number {
  return Math.max(1, Math.round(base * PRICE_CUT * (1 - buildRate(s, player))));
}

// ── 棋盘 ─────────────────────────────────────────────────────────────

/**
 * 造一张空间站棋盘：正中间一格甲板，其余全是虚空。
 *
 * 核心舱本身站在那一格甲板上，所以"中心"既是地板也是它的位置——
 * 不用为它单开一个地形。
 */
export function createStationBoard(id: string, size: number, name: string): Board {
  const n = Math.max(3, Math.round(size));
  const mid = (n - 1) / 2;
  const tiles = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      tiles.push({
        terrain: x === mid && y === mid ? ('deck' as const) : ('void' as const),
        cityId: null,
      });
    }
  }
  return { id, kind: 'station', name, w: n, h: n, tiles, hazard: SPACE_HAZARD };
}

/** 这座站是不是空间站（按图判断，别拿 id 前缀猜） */
export function isStationBoard(s: GameState, board: string): boolean {
  return s.boards?.[board]?.kind === 'station';
}

/* ===========================================================================
 * 能量：每座站自己的一条账
 * ======================================================================== */

export interface StationPower {
  supply: number;
  demand: number;
  headroom: number;
  cores: number;
  solars: number;
  thrusters: number;
  producers: number;
  lives: number;
  /**
   * 供电不足。所有耗能舱段一起停机：推进器不提速、生产舱不产金。
   *
   * 为什么是"整站停"而不是"按顺序挑几个停"：玩家在面板上看到的是
   * 一条红条 + 一个负数，最直觉的解释就是"这站电不够，停摆了"。
   * 挑着停需要另一套优先级规则，而玩家没有理由猜到那个优先级。
   */
  brownout: boolean;
}

/**
 * 这张棋盘对应的站记录（不是站就 undefined）。
 *
 * 和 `stationOf(unit)` 分开：很多地方手上只有 board id（能量、废墟倒计时、
 * 列表角标），没有单位可传。
 */
export function stationRecordOf(s: GameState, board: string): StarStation | undefined {
  return peekStarmap(s)?.stations.find((st) => st.board === board);
}

/**
 * 这座站是不是废墟（核心舱已经没了，只剩抢修窗口）。
 *
 * 判据只有 `StarStation.ruin` 一个：**别去数"核心舱还在不在"**——
 * 核心舱被自拆、被打掉、被遣散是三条路径，漏一条就出现"没有核心舱却还
 * 在产金"的站。ruin 是显式状态，写一次管到底。
 */
export function isRuined(s: GameState, board: string): boolean {
  return !!stationRecordOf(s, board)?.ruin;
}

/**
 * 一座站的能量账。
 *
 * 收的是**哪张站棋盘**，不是"哪个玩家"——两座站隔着几万公里，
 * 不可能互相供电。这也是它和 `armor.energyReport`（一方共用一股电）的区别。
 */
export function stationPower(s: GameState, board: string): StationPower {
  /*
   * 废墟：整站断电。
   *
   * 为什么不"照常算出来、再让各处自己判"：这座站已经没有核心舱了，
   * 太阳能板没人接线、生产舱没人维护——**物理上就是没电**。
   * 在这里返回 brownout 之后，所有"断电就停摆"的既有判据（产能、航速、
   * 维生仓、功能舱加成）一次全部失效，不用再逐处补 `isRuined`。
   */
  if (isRuined(s, board)) {
    return {
      supply: 0,
      demand: 0,
      headroom: 0,
      cores: 0,
      solars: 0,
      thrusters: 0,
      producers: 0,
      lives: 0,
      brownout: true,
    };
  }
  let supply = 0;
  let demand = 0;
  let cores = 0;
  let solars = 0;
  let thrusters = 0;
  let producers = 0;
  let lives = 0;
  // `?? []`：界面测试会拿一个只带 starmap 的假 state 来算航程，
  // 这里不该因为"没有 units 字段"就炸
  for (const u of s.units ?? []) {
    if (u.hp <= 0 || boardIdOf(u) !== board) continue;
    switch (u.type) {
      case STATION_CORE_ID:
        cores += 1;
        supply += CORE_POWER;
        break;
      case STATION_SOLAR_ID:
        solars += 1;
        supply += SOLAR_POWER;
        break;
      case STATION_PRODUCER_ID:
        producers += 1;
        demand += PRODUCER_DRAW;
        break;
      case STATION_THRUSTER_ID:
        thrusters += 1;
        demand += THRUSTER_DRAW;
        break;
      case STATION_LIFE_ID:
        lives += 1;
        demand += LIFE_DRAW;
        break;
      case STATION_REMOTE_ID:
        demand += REMOTE_DRAW;
        break;
      case STATION_LAB_GRAVITY_ID:
        demand += GRAVITY_DRAW;
        break;
      case STATION_LAB_MATERIAL_ID:
        demand += MATERIAL_DRAW;
        break;
      case STATION_COMM_ID:
        demand += COMM_DRAW;
        break;
      case STATION_CANNON_ID:
        demand += CANNON_DRAW;
        break;
      case STATION_LAUNCH_ID:
        demand += LAUNCH_DRAW;
        break;
      case STATION_DOCK_ID:
        demand += DOCK_DRAW;
        break;
      /* 太空装甲 ARMOR_DRAW = 0：不挂 case 就是不吃电，见那个常量的注释 */
      default:
        break;
    }
  }
  return {
    supply,
    demand,
    headroom: supply - demand,
    cores,
    solars,
    thrusters,
    producers,
    lives,
    brownout: demand > supply,
  };
}

/** 这支兵所在站的能量账（不在站上返回 null） */
export function stationPowerOf(s: GameState, u: Unit): StationPower | null {
  const board = boardIdOf(u);
  if (!isStationBoard(s, board)) return null;
  return stationPower(s, board);
}

/**
 * 维生仓的豁免：站上有在役的维生仓、且这个单位在它的覆盖半径内，
 * 就不吃「恶劣外空环境」。
 *
 * **读时算，不写回 `board.hazard`**：写回去的话，维生仓被打掉、站被拆、
 * 存档读入这几条路径只要漏一条，那座站就会永久免疫——而这种"永久"没人查得出来。
 *
 * 维生仓**自己也豁免**（`some` 里不排除自己）：它是一个密封的生命维持模块，
 * 本来就该比普通舱段结实一点，也顺带成为攻打一座站时"先拆哪个"的答案。
 */
registerHazardExempt((s, unit, h) => {
  if (h.id !== SPACE_HAZARD.id) return false;
  const board = boardIdOf(unit);
  if (!isStationBoard(s, board)) return false;
  // 断电 = 生命维持停摆。和"断电的生产舱不产金、推进器不提速"同一条口径
  if (stationPower(s, board).brownout) return false;
  return s.units.some(
    (v) =>
      v.type === STATION_LIFE_ID &&
      v.hp > 0 &&
      v.owner === unit.owner &&
      boardIdOf(v) === board &&
      Math.abs(v.x - unit.x) + Math.abs(v.y - unit.y) <= LIFE_RADIUS,
  );
});

/* ===========================================================================
 * 航行：装了推进器，空间站就是飞船
 * ======================================================================== */

/** 这支兵所在的站记录（不在站上返回 undefined） */
export function stationOf(s: GameState, u: Unit): StarStation | undefined {
  const board = boardIdOf(u);
  return starmapOf(s)?.stations.find((st) => st.board === board);
}

/**
 * 这座站在役的推进器数。
 *
 * 断电的站算 0——"装了但没通电"不该推得动一座站。玩家在面板上能看见过载，
 * 也该在航速上看见后果。
 */
export function stationThrusters(s: GameState, station: StarStation): number {
  const p = stationPower(s, station.board);
  return p.brownout ? 0 : p.thrusters;
}

/** 这座站的航速：标准 1 + 在役推进器数 */
export function stationSpeed(s: GameState, station: StarStation): number {
  return 1 + stationThrusters(s, station) * THRUSTER_SPEED;
}

/**
 * 空间站开过一段航道要几回合：**距离 ÷ 速度**。
 *
 * 这才是"距离 ÷ 速度"该待的地方。火箭的航程是固定的（见 `transit.laneTurnsFor`）——
 * 火箭是一次性投送，弹道写死；站是自己开过去的，推力越大越快。
 */
export function stationSailTurns(s: GameState, station: StarStation, lane: StarLane): number {
  return Math.max(1, Math.ceil(laneDistance(lane) / stationSpeed(s, station)));
}

/** 启航前的检查。和面板共用一句话，免得"按钮写着能飞、点下去说不能" */
export function stationSailProblem(s: GameState, station: StarStation): string | null {
  if (station.ruin) return '这座站已经成了废墟，飞不了';
  if (station.travel) {
    return `正在驶向${nodeName(s, station.travel.to)}（还有 ${Math.max(0, station.travel.left)} 回合）`;
  }
  if (!starmapOf(s)) return '这一局没有星图';
  if (lanesFrom(s, station.at).length === 0) return '这里没有可去的航道';
  if (stationThrusters(s, station) === 0) return '至少要一台推进器舱才能启航';
  return null;
}

/** 从这座站出发能去哪些节点（含各自航程） */
export function stationDestinations(
  s: GameState,
  station: StarStation,
): Array<{ to: StarNodeId; lane: StarLane; turns: number }> {
  return lanesFrom(s, station.at).map(({ lane, to }) => ({
    to,
    lane,
    turns: stationSailTurns(s, station, lane),
  }));
}

/**
 * 给空间站改名。
 *
 * 为什么要能改：一个轨道上停两座站时，默认名只差一个编号，
 * 「前往 红方的空间站 1 / 2」这种按钮玩家要数着点。让自己起名是最省事的解法。
 *
 * 名字存在 `boards[id].name`——它就是面板、星图、名单共用那一份，
 * 所以改完处处都变，不需要再同步别的地方。
 */
export function renameStation(s: GameState, board: string, name: string): string | null {
  const b = s.boards?.[board];
  if (!b || b.kind !== 'station') return '这不是一座空间站';
  const next = name.trim().replace(/\s+/g, ' ');
  if (!next) return '名字不能是空的';
  if (next.length > 14) return '名字最多 14 个字';
  b.name = next;
  return null;
}

/**
 * 启航：**只改一个字段**。站内坐标、单位、甲板全都不动，
 * 到港时把 `at` 改成目的地。这就是"不用真挪坐标"的实现。
 */
export function beginStationSail(s: GameState, station: StarStation, to: StarNodeId): string | null {
  const problem = stationSailProblem(s, station);
  if (problem) return problem;
  const dest = stationDestinations(s, station).find((d) => d.to === to);
  if (!dest) return '这两个节点之间没有航道';

  station.travel = { lane: dest.lane.id, from: station.at, to, left: dest.turns, total: dest.turns };
  const name = s.boards?.[station.board]?.name ?? '空间站';
  log(
    s,
    station.owner,
    `${name}启航，驶向${nodeName(s, to)}（航程 ${dest.turns} 回合）`,
    true,
  );
  return null;
}

/** 回合开始：推进自己那些在航行的站 */
export function tickStationTravel(s: GameState, player: PlayerId): void {
  const map = starmapOf(s);
  if (!map) return;
  for (const st of map.stations) {
    if (st.owner !== player || !st.travel) continue;
    st.travel.left -= 1;
    if (st.travel.left > 0) continue;
    const to = st.travel.to;
    st.at = to;
    st.travel = undefined;
    const name = s.boards?.[st.board]?.name ?? '空间站';
    log(s, player, `${name}抵达${nodeName(s, to)}轨道`, true);
  }
}



/**
 * 站的能量条（HTML）。
 *
 * 样式复用装甲时代那套 `.power-line` / `.power-bar` / `.power-nums`——
 * 玩家在装配坞已经学过"一条横条 + 供/用/余量"，这边不需要再教一遍。
 * 只在颜色上区分（`.power-bar.station`），免得和地面电网混起来。
 */
export function stationPowerHtml(s: GameState, u: Unit): string | null {
  /*
   * 废墟：不画能量条，画一行"这是什么、还剩几回合"。
   *
   * 一条 0/0 的红条只会让玩家以为"电力算错了"。废墟要表达的是
   * "这站已经完了，还能抢"，所以直接把倒计时写在这儿——它也是这座站
   * 现在唯一重要的数字。
   */
  const rec = stationOf(s, u);
  if (rec?.ruin) {
    const left = Math.max(0, rec.ruin.left);
    return `<div class="hint"><b>废墟</b>：核心舱已被摧毁，所有舱段停摆。`
      + `${left} 个回合后整座站会被彻底抹掉；站上任意单位可付维护费接管。</div>`;
  }
  const p = stationPowerOf(s, u);
  if (!p) return null;
  const over = p.brownout;
  const pct = p.supply > 0 ? Math.min(100, Math.round((p.demand / p.supply) * 100)) : p.demand > 0 ? 100 : 0;
  const gen =
    p.solars > 0
      ? `核心 ${p.cores * CORE_POWER} + 太阳能 ${p.solars * SOLAR_POWER}`
      : `核心 ${p.cores * CORE_POWER}`;
  const parts = [
    p.solars > 0 ? `${p.solars} 块太阳能` : '',
    p.lives > 0 ? `${p.lives} 座维生仓` : '',
    p.thrusters > 0 ? `${p.thrusters} 台推进器` : '',
    p.producers > 0 ? `${p.producers} 座生产舱` : '',
  ].filter(Boolean);
  const st = stationOf(s, u);
  const speed = st ? stationSpeed(s, st) : 0;
  return `<div class="power-line">
    <div class="power-bar station"><i class="${over ? 'over' : ''}" style="width:${pct}%"></i></div>
    <div class="power-nums">
      <span>供电 <b>${p.supply}</b> <em>${gen}</em></span>
      <span>已用 <b>${p.demand}</b></span>
      <span class="${over ? 'over' : ''}">${over ? `过载 <b>${-p.headroom}</b>` : `余量 <b>${p.headroom}</b>`}</span>
    </div>
  </div>
  <div class="hint">${parts.length > 0 ? parts.join(' · ') : '只有核心舱'} · 航速 ${speed}${
    over ? '（<b>断电：推进器与生产舱停摆</b>）' : ''
  }</div>`;
}

/**
 * 在某个节点的轨道上展开一座空间站。返回新棋盘的 id（失败返回 null）。
 *
 * 拆出来是给两条路共用的：
 *   · 发射井点火 → 直接入轨（现在唯一的走法）；
 *   · 从别的星球/站飞过来 → `transit` 的 orbit 到达（以后用得上）。
 */
export function deployStationAt(
  s: GameState,
  owner: PlayerId,
  coreId: string,
  nodeId: string,
): string | null {
  const map = starmapOf(s);
  if (!map) return null;
  const node = map.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const core = coreDef(coreId);
  if (!core) return null;

  const seq = (map.seq ?? 0) + 1;
  map.seq = seq;
  const boardId = `station-${seq}`;
  /*
   * 默认名带编号：同一个轨道上停两座站时，「前往 红方的空间站」两个按钮
   * 一模一样，玩家根本分不清该点哪个。编号至少让它有区别，
   * 想更好认就自己改名（`renameStation`）。
   */
  const base = `${s.players[owner]?.name ?? owner}的空间站`;
  const taken = new Set(map.stations.map((st) => s.boards?.[st.board]?.name));
  let n = map.stations.filter((st) => st.owner === owner).length + 1;
  while (taken.has(`${base} ${n}`)) n += 1;
  const name = `${base} ${n}`;

  s.boards ??= {};
  s.boards[boardId] = createStationBoard(boardId, core.size, name);
  map.stations.push({ board: boardId, at: node.id, owner, core: core.id });

  const mid = (core.size - 1) / 2;
  s.units.push({
    id: `u${s.nextUnitSeq++}`,
    type: STATION_CORE_ID,
    owner,
    x: mid,
    y: mid,
    hp: s.unitTypes[STATION_CORE_ID]?.maxHp ?? 120,
    kills: 0,
    // 刚入轨这一回合不能动手：和"新招的兵当回合不能动"同一条
    moved: true,
    acted: true,
    board: boardId,
    custom: { coreId: core.id },
  });

  log(
    s,
    owner,
    `核心舱在${nodeName(s, node.id)}轨道展开：「${name}」（${core.size}×${core.size}）`,
    true,
  );
  return boardId;
}

/**
 * 到达轨道（`transit` 的 orbit 分支）。
 *
 * 现在没有走这条路的发射（核心舱直接从地面入轨），但地基留着：
 * 以后从月球、从别的空间站发射时，走的还是这一段。
 */
export function deployStation(s: GameState, t: Transit): boolean {
  const coreId = String(t.cargo[0]?.custom?.coreId ?? '');
  return deployStationAt(s, t.owner, coreId, t.to) !== null;
}

// 注册一次：transit 那边不认识"空间站"，由这里告诉它在轨道上该干什么
registerOrbitArrival(deployStation);

/**
 * 从发射井直接把核心舱送上轨道。
 *
 * **不加注、不装载、不飞一回合**：地面上点火就能入轨，加注那套是给
 * "送人上月球"准备的。这里只花资源，价格吃太空建设折扣。
 *
 * 为什么走"就地入轨"而不是 `transit`：地月航道连的是月球，
 * 而核心舱要去的是**自己脚下这颗星球的轨道**——两点之间没有航道，
 * 也不需要："从地面到近地轨道"本来就不是一段星际航程。
 */
export function launchCore(s: GameState, silo: Unit, coreId: string): string | null {
  const core = coreDef(coreId);
  if (!core) return '没有这种核心舱';
  const here = nodeOf(s, silo);
  if (!here) return '这里不在星图上';
  const cost = buildCost(s, silo.owner, core.cost);
  if (s.players[silo.owner].gold < cost) return `金币不够（要 ${cost}）`;

  const boardId = deployStationAt(s, silo.owner, coreId, here.id);
  if (!boardId) return '轨道上放不下';
  s.players[silo.owner].gold -= cost;
  log(s, silo.owner, `发射${core.name}，花费 ${cost} 金`, false);
  return null;
}

// ── 单位 ─────────────────────────────────────────────────────────────

const STATION_OBSERVE: SkillDef = {
  id: 'station-observe',
  name: '星球表面观测',
  summary:
    '对脚下这颗星球的表面做一次观测：选一格，点亮它和上下左右共 5 格。' +
    '情报永久有效（同一座模块再观测会替换上一次）。每回合 1 次。',
  effect: 'station-observe',
  cooldown: 0,
  // 1 发、每回合回 1：正好是"每回合最多一次"，而且跨回合不会攒
  charges: 1,
  regen: 1,
  targeting: 'point',
};

const STATION_EXPAND: SkillDef = {
  id: 'station-expand',
  name: '扩建甲板',
  summary: '把一格虚空铺成甲板（也能把<b>破损舱段</b>修回甲板）。一次一格，可以连着铺；价格按太空建设折扣算。',
  effect: 'station-expand',
  cooldown: 0,
  // 一回合可以铺好几格：空间站是"花钱长大"的，不该被回合数卡住
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD: SkillDef = {
  id: 'station-build',
  name: '建造生产舱',
  summary:
    `在空的甲板上造一座生产舱，每回合产 ${PRODUCER_INCOME} 金（耗电 ${PRODUCER_DRAW}）。` +
    '价格按太空建设折扣算。',
  effect: 'station-build',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_SOLAR: SkillDef = {
  id: 'station-build-solar',
  name: '建造太阳能舱',
  summary: `在空的甲板上造一块太阳能舱，发电 ${SOLAR_POWER}。它自己不用电，所以电力再紧也能造。`,
  effect: 'station-build-solar',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_LIFE: SkillDef = {
  id: 'station-build-life',
  name: '建造维生仓',
  summary:
    `在空的甲板上造一座维生仓（耗电 ${LIFE_DRAW}），让周围 ${LIFE_RADIUS} 格内的单位` +
    '不再吃「恶劣外空环境」：护甲不再 ÷5、移动不再减半。',
  effect: 'station-build-life',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_THRUSTER: SkillDef = {
  id: 'station-build-thruster',
  name: '建造推进器舱',
  summary:
    `在核心舱<b>下半区</b>的空甲板上造一台推进器，耗电 ${THRUSTER_DRAW}。` +
    `每台让本方航道速度 +${THRUSTER_SPEED}（航程 = 距离 ÷ 速度）。`,
  effect: 'station-build-thruster',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_REMOTE: SkillDef = {
  id: 'station-build-remote',
  name: '建造遥感模块',
  summary: `在空的甲板上造一座遥感模块（耗电 ${REMOTE_DRAW}）。它有「星球表面观测」技能：从轨道上点亮地表一小片。需要航天员相邻才工作。`,
  effect: 'station-build-remote',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_GRAVITY: SkillDef = {
  id: 'station-build-gravity',
  name: '建造微重力研究室',
  summary: `在空的甲板上造一座微重力研究室（耗电 ${GRAVITY_DRAW}）：每座让本方<b>总金币收入 +${Math.round(GRAVITY_PER * 100)}%</b>，多座叠加、上限 +${Math.round(GRAVITY_CAP * 100)}%。需要航天员相邻才工作。`,
  effect: 'station-build-gravity',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_MATERIAL: SkillDef = {
  id: 'station-build-material',
  name: '建造材料研究室',
  summary: `在空的甲板上造一座材料研究室（耗电 ${MATERIAL_DRAW}）：每座让本方<b>所有单位护甲 +${MATERIAL_PER}</b>，上限 +${MATERIAL_CAP}。需要航天员相邻才工作。`,
  effect: 'station-build-material',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_COMM: SkillDef = {
  id: 'station-build-comm',
  name: '建造通讯模块',
  summary: `在空的甲板上造一座通讯模块（耗电 ${COMM_DRAW}）：每座让本方<b>所有单位视野 +${COMM_PER}</b>，上限 +${COMM_CAP}。需要航天员相邻才工作。`,
  effect: 'station-build-comm',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

/* ── 战斗舱段的四个建造技能 ────────────────────────────────────── */

const STATION_BUILD_CANNON: SkillDef = {
  id: 'station-build-cannon',
  name: '建造轨道炮舱',
  summary: `在空的甲板上造一座轨道炮舱（耗电 ${CANNON_DRAW}）：技能「轨道轰击」，对同一轨道的敌方空间站点火。需要航天员相邻才工作。`,
  effect: 'station-build-cannon',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_ARMOR: SkillDef = {
  id: 'station-build-armor',
  name: '建造太空装甲',
  summary: `在空的甲板上焊一块太空装甲：不吃电，血厚甲硬。敌方轨道轰击会打在它身上，` +
    '脚下的甲板就不会被打穿。',
  effect: 'station-build-armor',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_LAUNCH: SkillDef = {
  id: 'station-build-launch',
  name: '建造出舱口',
  summary: `在空的甲板上造一座出舱口（耗电 ${LAUNCH_DRAW}）：把一个相邻单位发射到` +
    '同一轨道上我方空间站的入舱口，或敌方空间站的破损舱段。每回合 1 次。',
  effect: 'station-build-launch',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

const STATION_BUILD_DOCK: SkillDef = {
  id: 'station-build-dock',
  name: '建造入舱口',
  summary: `在空的甲板上造一座入舱口（耗电 ${DOCK_DRAW}）：接收同轨道我方出舱口送来的人，` +
    `最多缓存 ${DOCK_CAPACITY} 个，满了拒绝进入；要人下船得再点「卸下」。`,
  effect: 'station-build-dock',
  cooldown: 0,
  multiCast: true,
  targeting: 'point',
};

/**
 * 轨道轰击：这一包唯一的**跨图攻击**。
 *
 * 为什么不做成"普通攻击"：站与站之间隔着同一轨道上的真空，坐标距离毫无意义，
 * 而普通攻击的射程/视线全靠几何（同图判定见 `doAttack`）。做成技能之后，
 * "打得到"由"同一轨道"决定，选哪一格由玩家点，两件事各自清楚。
 */
const STATION_BOMBARD: SkillDef = {
  id: 'station-bombard',
  name: '轨道轰击',
  summary:
    '对同一轨道上的一座敌方空间站打一发：选一格。<b>看不出那一格有没有舱段</b>——' +
    '空的甲板会被打穿成破损舱段，打中舱段则照常结算伤害。核心舱打不穿。每回合 1 次。',
  effect: 'station-bombard',
  cooldown: 0,
  // 和遥感一样：每回合 1 发，跨回合不攒
  charges: 1,
  regen: 1,
  targeting: 'point',
};

export const STATION_CORE: UnitTypeDef = {
  id: STATION_CORE_ID,
  name: '空间站核心舱',
  short: '核',
  era: 5,
  category: 'building',
  // 不卖、不产：只能由发射井送上去
  cost: 0,
  move: 0,
  atk: 0,
  armor: 8,
  maxHp: 120,
  range: 0,
  vision: 4,
  footprint: 1,
  summonedOnly: true,
  skills: [
    STATION_EXPAND,
    STATION_BUILD,
    STATION_BUILD_SOLAR,
    STATION_BUILD_LIFE,
    STATION_BUILD_THRUSTER,
    STATION_BUILD_REMOTE,
    STATION_BUILD_GRAVITY,
    STATION_BUILD_MATERIAL,
    STATION_BUILD_COMM,
    STATION_BUILD_CANNON,
    STATION_BUILD_ARMOR,
    STATION_BUILD_LAUNCH,
    STATION_BUILD_DOCK,
  ],
};

export const STATION_PRODUCER: UnitTypeDef = {
  id: STATION_PRODUCER_ID,
  name: '生产舱',
  short: '产',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 60,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

export const STATION_SOLAR: UnitTypeDef = {
  id: STATION_SOLAR_ID,
  name: '太阳能舱',
  short: '阳',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 50,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

/**
 * 推进器舱：给**全方**的航道提速。
 *
 * 位置有硬约束（见 `inThrusterZone`）：必须在核心舱的**下半区**。
 * 这不是"正下方"——整条下缘都算，因为推进器是"朝后喷"的一组，
 * 只要求装在核心舱后方，不要求对准某一条轴线。
 */
export const STATION_LIFE: UnitTypeDef = {
  id: STATION_LIFE_ID,
  name: '维生仓',
  short: '生',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 60,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

/**
 * 遥感模块：从轨道上拍一张地表照片。
 *
 * 它自己不能建在地表（站只在轨道上），技能选点会切到**脚下那颗星球**的棋盘。
 * 这张情报是永久的：卫星拍下来的就是那几格。
 */
export const STATION_REMOTE: UnitTypeDef = {
  id: STATION_REMOTE_ID,
  name: '遥感模块',
  short: '遥',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 50,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
  skills: [STATION_OBSERVE],
};

export const STATION_LAB_GRAVITY: UnitTypeDef = {
  id: STATION_LAB_GRAVITY_ID,
  name: '微重力研究室',
  short: '微',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 50,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

export const STATION_LAB_MATERIAL: UnitTypeDef = {
  id: STATION_LAB_MATERIAL_ID,
  name: '材料研究室',
  short: '材',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 50,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

export const STATION_COMM: UnitTypeDef = {
  id: STATION_COMM_ID,
  name: '通讯模块',
  short: '讯',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 50,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

export const STATION_THRUSTER: UnitTypeDef = {
  id: STATION_THRUSTER_ID,
  name: '推进器舱',
  short: '推',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 60,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

/**
 * 轨道炮舱：这一包唯一的跨图武器。
 *
 * `atk` 就写炮击值（`CANNON_ATK`）——伤害结算走的是通用的
 * `computeDamage`，它读的就是这个字段。炮本身不参加普通攻击（站与站之间
 * 没有几何，`doAttack` 的同图闸门会先把它挡住），所以这个数值只在
 * 「轨道轰击」里被用到。
 */
export const STATION_CANNON: UnitTypeDef = {
  id: STATION_CANNON_ID,
  name: '轨道炮舱',
  short: '炮',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: CANNON_ATK,
  armor: 6,
  maxHp: 80,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
  skills: [STATION_BOMBARD],
};

/**
 * 太空装甲：一块焊在甲板上的板子。
 *
 * 它的作用方式很朴素——**它站在那儿**。轨道轰击选中的格子上只要有东西，
 * 就打那个东西；所以把装甲铺在要保住的甲板上，炮就只能打在它身上。
 * 不给光环、不给减伤：一层"替甲板挨打的血条"就够了，规则越少越好解释。
 */
export const STATION_ARMOR: UnitTypeDef = {
  id: STATION_ARMOR_ID,
  name: '太空装甲',
  short: '甲',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 14,
  maxHp: 180,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

/** 出舱口：把相邻的人打出去（送到同轨道的我方入舱口，或敌方破口） */
export const STATION_LAUNCH: UnitTypeDef = {
  id: STATION_LAUNCH_ID,
  name: '出舱口',
  short: '出',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 60,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

/** 入舱口：接收送过来的人，缓存到有人来卸为止 */
export const STATION_DOCK: UnitTypeDef = {
  id: STATION_DOCK_ID,
  name: '入舱口',
  short: '入',
  era: 5,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 60,
  range: 0,
  vision: 1,
  footprint: 1,
  summonedOnly: true,
};

/**
 * 接驳站：给"从轨道上跳下来"的部队一个落脚点。
 *
 * 它不发电、不产金、不加成——唯一的作用是把降落点从"全图正中"换成
 * "它旁边那一圈"。这件事在战术上很实在：正中往往压着城或山，
 * 而"跳在自家接驳站旁边"等于把空降变成一次可控的侧翼机动。
 *
 * 每颗星球每方一座（`buildProblem` 兜这道闸），2×2：它是场地，不是箱子。
 */
export const LANDING_PAD: UnitTypeDef = {
  id: LANDING_PAD_ID,
  name: '接驳站',
  short: '驳',
  era: 5,
  category: 'building',
  cost: LANDING_PAD_COST,
  buildCost: 48,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 100,
  range: 0,
  vision: 3,
  footprint: 2,
  /*
   * 白名单而不是"随便什么能站的地"：不给白名单时判据是 `passable`，
   * 而 `passable` 放行 `void`/`deck`——工程队万一被送上站，就能在甲板上
   * 修一座接驳站，这件事没有意义。
   */
  buildOn: ['plain', 'forest', 'hill', 'plateau', 'valley', 'marsh', 'dune', 'regolith', 'crater', 'city'],
};

// ── 技能：扩建 / 建造 ────────────────────────────────────────────────

function log(s: GameState, p: PlayerId, text: string, open = false): void {
  s.log.push({ turn: s.turn, player: p, text, open });
}

/**
 * 4 邻域里有没有"还连着结构"的格——甲板，或者被打穿的破损舱段。
 *
 * 破损舱段也算：它的地板没了，但舱体骨架还在，扩建就是顺着骨架往外铺。
 * 不认它的话，"打穿一格"会把它外面那一整片甲板变成再也铺不到的孤岛，
 * 而玩家看到的明明是"这块还连着"。
 */
function touchesDeck(s: GameState, board: string, x: number, y: number): boolean {
  const solid = (xx: number, yy: number): boolean => {
    const t = tileOn(s, board, xx, yy)?.terrain;
    return t === 'deck' || t === 'wreck';
  };
  return solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1);
}

/**
 * 站内可以动土的两类格：没铺过的虚空，和被打穿的破损舱段。
 *
 * 二者的处理完全一样（花钱铺成甲板），差别只在战报那句话——
 * 玩家把一格破口重新铺好时，看到"铺下一格甲板"会以为点错了。
 */
registerSkillTargetCells('station-expand', ({ state, self }) => {
  const board = boardIdOf(self);
  const b = boardOf(state, board);
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const t = tileOn(state, board, x, y)?.terrain;
      if (t !== 'void' && t !== 'wreck') continue;
      if (!touchesDeck(state, board, x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
});

registerSkillEffect('station-expand', (c) => {
  const self = c.self;
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '要选一格虚空';
    return;
  }
  const board = boardIdOf(self);
  const tile = tileOn(c.state, board, t.x, t.y);
  if (!tile || (tile.terrain !== 'void' && tile.terrain !== 'wreck')) {
    c.result.ok = false;
    c.result.reason = '只能铺虚空或破损舱段';
    return;
  }
  if (!touchesDeck(c.state, board, t.x, t.y)) {
    c.result.ok = false;
    c.result.reason = '要挨着已有的甲板铺';
    return;
  }
  // 修复和铺新板同价：破损舱段不是"废墟"，它是一格还要再付一次钱的地板
  const cost = buildCost(c.state, self.owner, EXPAND_BASE_COST);
  if (c.state.players[self.owner].gold < cost) {
    c.result.ok = false;
    c.result.reason = `金币不够（要 ${cost}）`;
    return;
  }
  const repair = tile.terrain === 'wreck';
  c.state.players[self.owner].gold -= cost;
  tile.terrain = 'deck';
  c.result.log = repair ? `修复一格破损舱段（${cost} 金）` : `铺下一格甲板（${cost} 金）`;
});

/**
 * 这一格有没有单位站着。
 *
 * 不用 `rules.unitAt`：那会把 station → rules → expansions → space-age → station
 * 绕成一个环。站内都是 1×1 的东西，按占地遍历一下就够了。
 */
function occupiedAt(s: GameState, self: Unit, x: number, y: number): boolean {
  const view = boardStateOf(s, self);
  return view.units.some((u) => tilesOfUnit(view, u).some((t) => t.x === x && t.y === y));
}

/**
 * 这座功能舱有没有**人在值班**：4 邻域里有本方的航天员。
 *
 * 为什么是 4 邻域：移动、扩建、装卸用的都是同一套，玩家已经会判断"贴不贴得上"。
 * 8 邻域会让人以为斜角也算，但兵不能斜走，于是"看起来挨着却不工作"。
 *
 * 无人值守的舱段**完全不工作**：不产金币、不加甲、不加视野、技能也不能放。
 * 这不是"效率降低"——一个没人看的仪器就是一个箱子。
 */
export function isStaffed(s: GameState, u: Unit): boolean {
  const board = boardIdOf(u);
  return (s.units ?? []).some(
    (v) =>
      v.owner === u.owner &&
      v.type === ASTRONAUT_ID &&
      v.hp > 0 &&
      boardIdOf(v) === board &&
      Math.abs(v.x - u.x) + Math.abs(v.y - u.y) <= CREW_REACH,
  );
}

/**
 * 这一方现在有**几座**某类功能舱在正常工作（有人值守 + 站没断电）。
 *
 * 材料研究室、通讯模块、微重力研究室都靠它算加成；数值给的是"每座多少"，
 * 上限在各自调用点用 `Math.min` 夹住。
 */
export function activeModuleCount(s: GameState, owner: PlayerId, typeId: string): number {
  // 每张站的断电状态只算一次：这个函数会被护甲/视野的钩子频繁调用
  const dark = new Map<string, boolean>();
  let n = 0;
  for (const u of s.units ?? []) {
    if (u.owner !== owner || u.type !== typeId || u.hp <= 0) continue;
    const board = boardIdOf(u);
    if (!isStationBoard(s, board)) continue;
    // 废墟里的舱段只是残骸：不产金、不加甲、不加视野（见 stationPower 的注释）
    if (isRuined(s, board)) continue;
    if (!dark.has(board)) dark.set(board, stationPower(s, board).brownout);
    if (dark.get(board)) continue;
    if (!isStaffed(s, u)) continue;
    n += 1;
  }
  return n;
}

/** 站内所有空的甲板（没有单位占着） */
function emptyDeckCells(s: GameState, self: Unit): Array<{ x: number; y: number }> {
  const board = boardIdOf(self);
  const b = boardOf(s, board);
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (tileOn(s, board, x, y)?.terrain !== 'deck') continue;
      if (occupiedAt(s, self, x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/** 这座站的核心舱（推进器的"下半区"以它为基准） */
function coreOf(s: GameState, board: string): Unit | undefined {
  return s.units.find((u) => u.type === STATION_CORE_ID && u.hp > 0 && boardIdOf(u) === board);
}

/**
 * 这一格算不算推进器舱的合法位置：核心舱的**下半区**。
 *
 * 为什么是"下半区"而不是"正下方"：推进器是一组朝后喷的引擎，
 * 只要求装在核心舱后方，不要求对准某一条轴线。玩家想摆成一排、
 * 想贴左缘、想贴右缘都行——这样"下半区"才是一个能规划的形状，
 * 而不是一条必须精确命中的直线。
 */
export function inThrusterZone(s: GameState, self: Unit, x: number, y: number): boolean {
  const core = coreOf(s, boardIdOf(self));
  if (!core) return false;
  return y > core.y && x >= 0 && y >= 0 && x < boardOf(s, boardIdOf(self)).w;
}

/**
 * 造一座舱段的公共流程：验格 → 验位置 → 验电 → 验钱 → 落成。
 *
 * 三个建造技能只差参数，所以合成一条。最容易写漏的是**耗电检查**：
 * 以前没有能量这回事，造完就生效；现在"电力不够"必须是建造前的一道闸，
 * 而不是造出来之后发现它不转。
 */
function buildModule(
  c: SkillCtx,
  opts: { typeId: string; baseCost: number; draw: number; needThrusterZone?: boolean; what: string },
): void {
  const { state, self } = c;
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '要选一格空甲板';
    return;
  }
  const board = boardIdOf(self);
  if (tileOn(state, board, t.x, t.y)?.terrain !== 'deck') {
    c.result.ok = false;
    c.result.reason = '只能建在甲板上';
    return;
  }
  if (occupiedAt(state, self, t.x, t.y)) {
    c.result.ok = false;
    c.result.reason = '那一格已经有东西了';
    return;
  }
  if (opts.needThrusterZone && !inThrusterZone(state, self, t.x, t.y)) {
    c.result.ok = false;
    c.result.reason = '推进器必须装在核心舱的下半区';
    return;
  }
  if (opts.draw > 0) {
    const p = stationPower(state, board);
    if (p.headroom < opts.draw) {
      c.result.ok = false;
      c.result.reason = `电力不足 ${p.headroom}/${opts.draw}`;
      return;
    }
  }
  const cost = buildCost(state, self.owner, opts.baseCost);
  if (state.players[self.owner].gold < cost) {
    c.result.ok = false;
    c.result.reason = `金币不够（要 ${cost}）`;
    return;
  }

  state.players[self.owner].gold -= cost;
  c.api.spawn(state, self.owner, opts.typeId, t.x, t.y, board);
  // 刚造出来这一回合不干活：和"新招的兵当回合不能动"同一条
  const born = state.units[state.units.length - 1];
  if (born) born.acted = true;
  const name = state.unitTypes[opts.typeId]?.name ?? opts.what;
  c.result.log = `建成一座${name}（${cost} 金）`;
}

registerSkillTargetCells('station-build', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-solar', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-life', ({ state, self }) => emptyDeckCells(state, self));

registerSkillTargetCells('station-build-thruster', ({ state, self }) => {
  // 只给下半区：点不亮的格子，玩家一眼就知道推进器该往哪装
  const board = boardIdOf(self);
  const b = boardOf(state, board);
  const core = coreOf(state, board);
  if (!core) return [];
  return emptyDeckCells(state, self).filter((p) => inThrusterZone(state, self, p.x, p.y) && p.y < b.h);
});

registerSkillEffect('station-build', (c) => {
  buildModule(c, {
    typeId: STATION_PRODUCER_ID,
    baseCost: PRODUCER_BASE_COST,
    draw: PRODUCER_DRAW,
    what: '生产舱',
  });
});

registerSkillEffect('station-build-solar', (c) => {
  buildModule(c, {
    typeId: STATION_SOLAR_ID,
    baseCost: SOLAR_BASE_COST,
    draw: 0,
    what: '太阳能舱',
  });
});

registerSkillTargetCells('station-build-remote', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-gravity', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-material', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-comm', ({ state, self }) => emptyDeckCells(state, self));

registerSkillEffect('station-build-remote', (c) => {
  buildModule(c, { typeId: STATION_REMOTE_ID, baseCost: REMOTE_BASE_COST, draw: REMOTE_DRAW, what: '遥感模块' });
});
registerSkillEffect('station-build-gravity', (c) => {
  buildModule(c, { typeId: STATION_LAB_GRAVITY_ID, baseCost: GRAVITY_BASE_COST, draw: GRAVITY_DRAW, what: '微重力研究室' });
});
registerSkillEffect('station-build-material', (c) => {
  buildModule(c, { typeId: STATION_LAB_MATERIAL_ID, baseCost: MATERIAL_BASE_COST, draw: MATERIAL_DRAW, what: '材料研究室' });
});
registerSkillEffect('station-build-comm', (c) => {
  buildModule(c, { typeId: STATION_COMM_ID, baseCost: COMM_BASE_COST, draw: COMM_DRAW, what: '通讯模块' });
});

/* ── 战斗舱段：四个建造技能 ─────────────────────────────────────── */

registerSkillTargetCells('station-build-cannon', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-armor', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-launch', ({ state, self }) => emptyDeckCells(state, self));
registerSkillTargetCells('station-build-dock', ({ state, self }) => emptyDeckCells(state, self));

registerSkillEffect('station-build-cannon', (c) => {
  buildModule(c, { typeId: STATION_CANNON_ID, baseCost: CANNON_BASE_COST, draw: CANNON_DRAW, what: '轨道炮舱' });
});
registerSkillEffect('station-build-armor', (c) => {
  buildModule(c, { typeId: STATION_ARMOR_ID, baseCost: ARMOR_BASE_COST, draw: ARMOR_DRAW, what: '太空装甲' });
});
registerSkillEffect('station-build-launch', (c) => {
  buildModule(c, { typeId: STATION_LAUNCH_ID, baseCost: LAUNCH_BASE_COST, draw: LAUNCH_DRAW, what: '出舱口' });
});
registerSkillEffect('station-build-dock', (c) => {
  buildModule(c, { typeId: STATION_DOCK_ID, baseCost: DOCK_BASE_COST, draw: DOCK_DRAW, what: '入舱口' });
});

registerSkillEffect('station-build-life', (c) => {
  buildModule(c, {
    typeId: STATION_LIFE_ID,
    baseCost: LIFE_BASE_COST,
    draw: LIFE_DRAW,
    what: '维生仓',
  });
});

registerSkillEffect('station-build-thruster', (c) => {
  buildModule(c, {
    typeId: STATION_THRUSTER_ID,
    baseCost: THRUSTER_BASE_COST,
    draw: THRUSTER_DRAW,
    needThrusterZone: true,
    what: '推进器舱',
  });
});

registerSkillReadyCheck('station-expand', (s, u) => {
  const cost = buildCost(s, u.owner, EXPAND_BASE_COST);
  if (s.players[u.owner].gold < cost) return `金币不足 ${s.players[u.owner].gold}/${cost}`;
  return true;
});

registerSkillReadyCheck('station-build', (s, u) => {
  const p = stationPowerOf(s, u);
  if (p && p.headroom < PRODUCER_DRAW) {
    return `电力不足 ${p.headroom}/${PRODUCER_DRAW}`;
  }
  const cost = buildCost(s, u.owner, PRODUCER_BASE_COST);
  if (s.players[u.owner].gold < cost) return `金币不足 ${s.players[u.owner].gold}/${cost}`;
  return true;
});

registerSkillReadyCheck('station-build-solar', (s, u) => {
  const cost = buildCost(s, u.owner, SOLAR_BASE_COST);
  if (s.players[u.owner].gold < cost) return `金币不足 ${s.players[u.owner].gold}/${cost}`;
  return true;
});

for (const [id, draw, cost] of [
  ['station-build-remote', REMOTE_DRAW, REMOTE_BASE_COST],
  ['station-build-gravity', GRAVITY_DRAW, GRAVITY_BASE_COST],
  ['station-build-material', MATERIAL_DRAW, MATERIAL_BASE_COST],
  ['station-build-comm', COMM_DRAW, COMM_BASE_COST],
  ['station-build-cannon', CANNON_DRAW, CANNON_BASE_COST],
  // 装甲不耗电（draw 0），但金币门槛照走同一条
  ['station-build-armor', ARMOR_DRAW, ARMOR_BASE_COST],
  ['station-build-launch', LAUNCH_DRAW, LAUNCH_BASE_COST],
  ['station-build-dock', DOCK_DRAW, DOCK_BASE_COST],
] as Array<[string, number, number]>) {
  registerSkillReadyCheck(id, (s, u) => {
    const p = stationPowerOf(s, u);
    if (p && p.headroom < draw) return `电力不足 ${p.headroom}/${draw}`;
    const price = buildCost(s, u.owner, cost);
    if (s.players[u.owner].gold < price) return `金币不足 ${s.players[u.owner].gold}/${price}`;
    return true;
  });
}

/* ── 遥感模块的技能 ───────────────────────────────────────────── */

/**
 * 可点格：**脚下那颗星球的整张图**（格子列表留空）。
 *
 * 为什么不返回具体格子：返回整张图会让 `aimTiles` 把每一格都铺成红色斜纹，
 * 一片红海什么都看不清（传送阵那条注释里踩过同一个坑）。
 * 界面拿到 `board` 会先切图，玩家点哪就用哪——合法性由 effect 判。
 */
registerSkillTargetCells('station-observe', ({ state, self }) => {
  const rec = stationOf(state, self);
  const node = rec ? nodeById(state, rec.at) : undefined;
  const board = node?.board;
  if (!board) return { cells: [] };
  return { board, cells: [] };
});

registerSkillEffect('station-observe', (c) => {
  const self = c.self;
  const t = c.target;
  const fail = (reason: string): void => {
    c.result.ok = false;
    c.result.reason = reason;
  };
  if (!isStaffed(c.state, self)) return fail('没有航天员在旁边，仪器没人看');
  const rec = stationOf(c.state, self);
  const node = rec ? nodeById(c.state, rec.at) : undefined;
  const board = node?.board;
  if (!board) return fail('这座站不在任何星球的轨道上');
  if (!t) return fail('要选一格');

  const b = boardOf(c.state, board);
  if (t.x < 0 || t.y < 0 || t.x >= b.w || t.y >= b.h) return fail('那一格在这张图外面');

  /*
   * 目标格 + 上下左右，共 5 格（出界的不算）。
   * 用"四邻"而不是 3×3：和移动、扩建、值守同一套邻接口径，
   * 玩家看到的就是"这一格和它四面"。
   */
  const cells: number[] = [];
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= b.w || y >= b.h) return;
    cells.push(y * b.w + x);
  };
  push(t.x, t.y);
  push(t.x - 1, t.y);
  push(t.x + 1, t.y);
  push(t.x, t.y - 1);
  push(t.x, t.y + 1);

  setRecon(c.state, self.owner, board, self.id, cells);
  c.result.log = `遥感观测：${nodeName(c.state, rec!.at)} ${cellName(t.x, t.y)} 及四邻已标亮`;
});

registerSkillReadyCheck('station-observe', (s, u) => (isStaffed(s, u) ? true : '无航天员'));

registerSkillReadyCheck('station-build-life', (s, u) => {
  const p = stationPowerOf(s, u);
  if (p && p.headroom < LIFE_DRAW) {
    return `电力不足 ${p.headroom}/${LIFE_DRAW}`;
  }
  const cost = buildCost(s, u.owner, LIFE_BASE_COST);
  if (s.players[u.owner].gold < cost) return `金币不足 ${s.players[u.owner].gold}/${cost}`;
  return true;
});

registerSkillReadyCheck('station-build-thruster', (s, u) => {
  const p = stationPowerOf(s, u);
  if (p && p.headroom < THRUSTER_DRAW) {
    return `电力不足 ${p.headroom}/${THRUSTER_DRAW}`;
  }
  const cost = buildCost(s, u.owner, THRUSTER_BASE_COST);
  if (s.players[u.owner].gold < cost) return `金币不足 ${s.players[u.owner].gold}/${cost}`;
  return true;
});

/** 回合开始：每座**通电的**生产舱给自己主人产金币 */
export function tickProducers(s: GameState, player: PlayerId): void {
  if (!s.unitTypes[STATION_PRODUCER_ID]) return;
  let n = 0;
  for (const u of s.units) {
    if (u.owner !== player || u.type !== STATION_PRODUCER_ID) continue;
    const board = boardIdOf(u);
    if (!isStationBoard(s, board)) continue;
    // 断电的站整站停摆：这条和推进器不提速是同一个判据（见 stationPower）
    if (stationPower(s, board).brownout) continue;
    n += 1;
  }
  if (n === 0) return;
  const gain = n * PRODUCER_INCOME;
  s.players[player].gold += gain;
  log(s, player, `${n} 座生产舱产出 ${gain} 金`, false);
}

/* ===========================================================================
 * 战斗：轨道轰击与登船
 *
 * ── 这一段的两个前提 ─────────────────────────────────────────
 *
 * 1. **敌人站里的舱段看不见**。甲板铺到哪是公开的（`playerView` 里空间站
 *    所有格都可见），但装了什么、装在哪，只能靠一格一格打出来
 *    （`hideUnit` 钩子，见 space-war）。所以这里的选点**不做任何"那里有东西"
 *    的判断**——有东西就打东西，没东西就打穿甲板。
 *
 * 2. **站与站之间没有几何**。同一轨道上的两座站隔着一段真空，坐标距离
 *    毫无意义，所以轨道轰击不是普通攻击，是技能：能不能打由"同一轨道"决定。
 * ======================================================================== */

/** 这一格站着谁（站内全是 1×1，按格坐标查就够了；空格 = undefined） */
function unitOnCell(s: GameState, board: string, x: number, y: number): Unit | undefined {
  return (s.units ?? []).find((u) => u.hp > 0 && boardIdOf(u) === board && u.x === x && u.y === y);
}

/**
 * 这个单位这件"跨站的活儿"能碰到哪些站：**同一轨道上的所有站**。
 *
 * "同一轨道"是这一包唯一的距离概念（见 `StarStation.at`）。站内坐标再近也
 * 不算——两座站哪怕在星图上贴着，只要不共轨就隔着航道。
 */
function stationsOnOrbit(s: GameState, self: Unit): StarStation[] {
  const rec = stationOf(s, self);
  const map = starmapOf(s);
  if (!rec || !map) return [];
  return map.stations.filter((st) => st.at === rec.at && !!s.boards?.[st.board]);
}

/** 同一轨道上别人家的站（能打的） */
export function rivalStationsOnOrbit(s: GameState, self: Unit): StarStation[] {
  return stationsOnOrbit(s, self).filter((st) => st.owner !== self.owner);
}

/**
 * 这一炮现在瞄着哪座站。
 *
 * 自动瞄的条件是"只有一个目标"：玩家没有必要为了唯一的选择多点一次按钮。
 * 两个以上就必须自己选——不然"打错了站"没有任何提示，而一发一回合。
 */
export function cannonAimBoard(s: GameState, self: Unit): string | null {
  const rivals = rivalStationsOnOrbit(s, self);
  const aim = self.custom?.aim;
  if (typeof aim === 'string' && rivals.some((st) => st.board === aim)) return aim;
  return rivals.length === 1 ? rivals[0]!.board : null;
}

/** 炮口转向：面板上每个敌方站一个按钮（只有一个目标时不显示，自动瞄上） */
export function cannonActions(s: GameState, cannon: Unit): UnitActionOption[] {
  if (isRuined(s, boardIdOf(cannon))) return [];
  const rivals = rivalStationsOnOrbit(s, cannon);
  if (rivals.length <= 1) return [];
  const aim = cannonAimBoard(s, cannon);
  return rivals.map((st) => ({
    id: `station:aim:${st.board}`,
    group: '目标',
    label: `瞄准「${boardName(s, st.board)}」`,
    detail: '把轨道炮对准这座站，再用技能「轨道轰击」选一格',
    note: st.board === aim ? '已瞄准' : '未瞄准',
  }));
}

/**
 * 可轰击的格：目标站的所有甲板，**除了核心舱脚下那一格**。
 *
 * 核心舱不是"护甲高"，是根本打不进去（用户定的规矩）。所以它连可点格都不给——
 * "点得亮、点下去说不行"是这套界面最忌讳的一种毛病。
 */
registerSkillTargetCells('station-bombard', ({ state, self }) => {
  const board = cannonAimBoard(state, self);
  if (!board) return { cells: [] };
  const b = boardOf(state, board);
  const core = (state.units ?? []).find(
    (u) => u.type === STATION_CORE_ID && u.hp > 0 && boardIdOf(u) === board,
  );
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (tileOn(state, board, x, y)?.terrain !== 'deck') continue;
      if (core && core.x === x && core.y === y) continue;
      cells.push({ x, y });
    }
  }
  return { board, cells };
});

registerSkillEffect('station-bombard', (c) => {
  const { state, self } = c;
  const fail = (reason: string): void => {
    c.result.ok = false;
    c.result.reason = reason;
  };
  if (!isStaffed(state, self)) return fail('没有航天员在旁边，炮位没人操作');
  if (stationPower(state, boardIdOf(self)).brownout) return fail('这座站断电了，炮打不出去');

  const board = cannonAimBoard(state, self);
  if (!board) return fail('先选一个目标空间站');
  const t = c.target;
  if (!t) return fail('要选一格');

  const tile = tileOn(state, board, t.x, t.y);
  if (!tile || tile.terrain !== 'deck') return fail('那一格不是甲板');
  const victim = unitOnCell(state, board, t.x, t.y);
  if (victim?.type === STATION_CORE_ID) return fail('核心舱有整座站的外壳护着，打不穿');

  const name = boardName(state, board);
  const where = cellName(t.x, t.y);

  if (victim) {
    /*
     * 打中舱段：走 `api.computeDamage` + `api.hurt`，不自己造一套伤害公式。
     * 护甲、地形掩护、恶劣外空 ÷5、材料研究室、守御阵这类"替人挨打"的规则
     * 全都还认这一发，和其它所有伤害同一条出口。
     *
     * 唯一的将就差在**距离**：`computeDamage` 会算一次两格之间的坐标距离，
     * 而两座站之间没有距离这回事。它只影响"隔格减伤"那几条（`rangeMul`），
     * 炮本身没有那些加成，所以这里不会偏。
     */
    const dmg = c.api.computeDamage(state, self, victim, false);
    c.api.hurt(state, victim, dmg, { source: self });
    const what = state.unitTypes[victim.type]?.name ?? '舱段';
    const down = victim.hp <= 0 ? '，舱段被摧毁' : '';
    c.result.log = `轨道轰击命中「${name}」的${what}：${dmg} 伤害${down}`;
    // 两边都要有一条：挨打的人不该只看到自己血少了
    log(state, self.owner, `轨道轰击命中「${name}」的${what}，造成 ${dmg} 伤害${down}`, true);
    log(state, victim.owner, `「${name}」的${what}被轨道轰击命中，承受 ${dmg} 伤害${down}`, true);
    return;
  }

  /*
   * 打空：把这一格甲板打穿。
   *
   * 没有伤害数字、没有豁免——一发一格，这是"盲打"的全部回报。
   * 打穿之后它是 `wreck`：还能走人（登船就是从破口进来的）、还能从旁边铺，
   * 但站不住舱段；修复要走核心舱的「扩建甲板」。
   */
  tile.terrain = 'wreck';
  c.result.log = `轨道轰击打穿了「${name}」${where}的甲板`;
  log(state, self.owner, `轨道轰击打穿了「${name}」${where}的甲板`, true);
  log(state, victimOwnerOfBoard(state, board), `「${name}」${where}的甲板被轨道轰击打穿`, true);
});

registerSkillReadyCheck('station-bombard', (s, u) => {
  if (!isStaffed(s, u)) return '无航天员';
  if (stationPower(s, boardIdOf(u)).brownout) return '断电';
  if (!cannonAimBoard(s, u)) return '先选目标';
  return true;
});

/** 这座站是谁的（打空甲板时也要给对方写一条战报） */
function victimOwnerOfBoard(s: GameState, board: string): PlayerId {
  return starmapOf(s)?.stations.find((st) => st.board === board)?.owner ?? s.current;
}

/* ── 出舱口 / 入舱口：把人送过去 ─────────────────────────────────── */

/**
 * 入舱口里缓存的人。
 *
 * 他们**不在 `s.units` 里**，也不在任何格子上——舱里没有地板，他们挂在架子上。
 * 所以：看不见、打不到、也不吃外空环境；想让他们干活必须先「卸下」。
 *
 * 存在 `custom.cargo` 里而不是新开一个全局表：缓存跟着那座舱门走，
 * 舱门被打掉（单位消失）时里面的人也一起没了，不需要另一条清理路径。
 */
export interface DockCargo {
  unit: Unit;
  /** 进舱那一回合：**当回合不能卸**，得在里面待一轮 */
  arrivedTurn: number;
}

export function dockCargo(port: Unit): DockCargo[] {
  const raw = port.custom?.cargo;
  return Array.isArray(raw) ? (raw as DockCargo[]) : [];
}

/** 这个单位能不能被装进出舱口：建筑不行（舱段没法自己走进舱门） */
function launchable(s: GameState, u: Unit): boolean {
  if (u.hp <= 0) return false;
  return (s.unitTypes[u.type]?.category ?? '') !== 'building';
}

/** 入舱口旁边能放下一个人的空甲板（4 邻域，按"上右下左"找第一格） */
function freeDeckBeside(s: GameState, port: Unit): { x: number; y: number } | null {
  const board = boardIdOf(port);
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const x = port.x + dx;
    const y = port.y + dy;
    if (tileOn(s, board, x, y)?.terrain !== 'deck') continue;
    if (unitOnCell(s, board, x, y)) continue;
    return { x, y };
  }
  return null;
}

/**
 * 出舱口这个可以点"发射"的人 × 目的地组合。
 *
 * 为什么是按钮而不是"先点这个再点那个"：目的地在**另一张图**上（另一座站），
 * 而技能选点只认一张图（`SKILL_TARGET_CELLS` 只能返回一个 board）。
 * 按钮列表是这套引擎里唯一能跨图选目标的现成交互（发射井选目的地就是它）。
 *
 * 每回合 1 次：一个舱门一口气把半支队伍甩过去，等于给了"传送"。
 */
export function launchActions(s: GameState, port: Unit): UnitActionOption[] {
  const out: UnitActionOption[] = [];
  if (port.custom?.launchedTurn === s.turn) return out;
  if (!stationOf(s, port)) return out;
  if (isRuined(s, boardIdOf(port))) return out;
  // 断电：舱门是电动的。与其列一串点不动的按钮，不如直接把理由写在面板行里
  if (stationPower(s, boardIdOf(port)).brownout) return out;

  const board = boardIdOf(port);
  const cargos = (s.units ?? []).filter(
    (u) =>
      u.owner === port.owner &&
      boardIdOf(u) === board &&
      u.id !== port.id &&
      launchable(s, u) &&
      Math.abs(u.x - port.x) + Math.abs(u.y - port.y) === 1,
  );
  if (cargos.length === 0) return out;

  // 我方入舱口：**满了也列出来**，只是点不动——"为什么我的入舱口不在列表里"
  // 是比"它写着满了"更差的一种体验
  const docks: Array<{ board: string; dock: Unit; space: number }> = [];
  for (const st of stationsOnOrbit(s, port)) {
    if (st.owner !== port.owner || st.board === board) continue;
    const dock = (s.units ?? []).find(
      (u) => u.type === STATION_DOCK_ID && u.hp > 0 && boardIdOf(u) === st.board,
    );
    if (!dock) continue;
    docks.push({ board: st.board, dock, space: DOCK_CAPACITY - dockCargo(dock).length });
  }

  // 敌方站上的破口（能直接登船的地方）
  const wrecks: Array<{ board: string; x: number; y: number }> = [];
  for (const st of rivalStationsOnOrbit(s, port)) {
    // 废墟没有"破口"可登——要上去只能等它变成废墟之后从轨道降落（见下）
    if (st.ruin) continue;
    const b = boardOf(s, st.board);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        if (tileOn(s, st.board, x, y)?.terrain !== 'wreck') continue;
        if (unitOnCell(s, st.board, x, y)) continue;
        wrecks.push({ board: st.board, x, y });
      }
    }
  }

  /*
   * 降落：这个轨道对应的那颗星球（第三类目的地）。
   *
   * 落点由 `landingCell` 决定（自家接驳站旁边，否则全图正中）——
   * 界面上只给"降落到月球"这一句，玩家不需要知道坐标，也不想算。
   */
  const rec = stationOf(s, port);
  const planet = rec ? nodeById(s, rec.at)?.board : undefined;
  const landSpot = planet ? landingCell(s, planet, port.owner) : null;

  for (const cargo of cargos) {
    const name = s.unitTypes[cargo.type]?.name ?? '单位';
    for (const d of docks) {
      out.push({
        id: `station:launch:${cargo.id}:dock:${d.dock.id}`,
        group: `出舱口 · ${name}`,
        label: `送 ${name} →「${boardName(s, d.board)}」入舱口`,
        detail: `进去之后要等一回合才能卸下（还能再进 ${Math.max(0, d.space)} 个）`,
        note: d.space > 0 ? '同轨道' : `满了 ${DOCK_CAPACITY}/${DOCK_CAPACITY}`,
        disabled: d.space <= 0,
      });
    }
    for (const w of wrecks) {
      out.push({
        id: `station:launch:${cargo.id}:wreck:${w.board}:${w.x}:${w.y}`,
        group: `出舱口 · ${name}`,
        label: `送 ${name} →「${boardName(s, w.board)}」${cellName(w.x, w.y)}`,
        detail: '从破口直接登船（落点有敌人就打不了）',
        note: '登船',
      });
    }
    if (planet && landSpot) {
      const pad = (s.units ?? []).some(
        (u) => u.type === LANDING_PAD_ID && u.owner === port.owner && u.hp > 0 && boardIdOf(u) === planet,
      );
      out.push({
        id: `station:launch:${cargo.id}:land`,
        group: `出舱口 · ${name}`,
        label: `送 ${name} → 降落「${boardName(s, planet)}」`,
        detail: pad
          ? `落在接驳站旁边的空地上（${cellName(landSpot.x, landSpot.y)}）`
          : `落在图中央（${cellName(landSpot.x, landSpot.y)}）；盖一座接驳站可以改落点`,
        note: '降落',
      });
    }
  }
  return out;
}

/** 入舱口的按钮：舱里有几个能卸的人就有几个按钮 */
export function dockActions(s: GameState, port: Unit): UnitActionOption[] {
  const out: UnitActionOption[] = [];
  if (isRuined(s, boardIdOf(port))) return out;
  const cargo = dockCargo(port);
  for (let i = 0; i < cargo.length; i += 1) {
    const item = cargo[i]!;
    const name = s.unitTypes[item.unit.type]?.name ?? '单位';
    const stuck = item.arrivedTurn >= s.turn;
    const spot = freeDeckBeside(s, port);
    out.push({
      id: `station:unload:${i}`,
      group: '入舱口',
      label: `卸下 ${name}`,
      detail: stuck ? '刚进舱，还在固定（下一回合才能出来）' : '放到隔壁的空甲板上，下来就能动',
      note: stuck ? '等一回合' : spot ? cellName(spot.x, spot.y) : '旁边没空位',
      disabled: stuck || !spot,
    });
  }
  return out;
}

/**
 * 处理出舱口/入舱口的动作。返回字符串 = 拒绝（给玩家看的理由），null = 成功。
 *
 * 三件事都集中在这一个函数里，是因为它们共用同一批前置检查
 * （是不是你的、断电没有、那个单位还在不在）。
 */
export function combatUnitAction(s: GameState, unit: Unit, actionId: string): string | null {
  if (actionId === 'station:salvage') return salvageStation(s, unit);
  if (actionId === 'station:scuttle') return scuttleStation(s, unit);

  if (actionId.startsWith('station:aim:')) {
    const board = actionId.slice('station:aim:'.length);
    if (!rivalStationsOnOrbit(s, unit).some((st) => st.board === board)) {
      return '那不是一个能打的目标';
    }
    unit.custom = { ...(unit.custom ?? {}), aim: board };
    log(s, unit.owner, `轨道炮转向「${boardName(s, board)}」`, false);
    return null;
  }

  if (actionId.startsWith('station:unload:')) {
    if (unit.type !== STATION_DOCK_ID) return '这支部队不是入舱口';
    const idx = Number(actionId.slice('station:unload:'.length));
    const cargo = dockCargo(unit);
    const item = cargo[idx];
    if (!item) return '舱里没有这个人';
    if (item.arrivedTurn >= s.turn) return '刚进舱，这一回合还在固定';
    const spot = freeDeckBeside(s, unit);
    if (!spot) return '旁边没有空的甲板，卸不下来';

    const board = boardIdOf(unit);
    const body = item.unit;
    body.board = board;
    body.x = spot.x;
    body.y = spot.y;
    // 在舱里待了一轮，落地就是满状态（不然"下船即残废"）
    body.moved = false;
    body.acted = false;
    s.units.push(body);
    cargo.splice(idx, 1);
    unit.custom = { ...(unit.custom ?? {}), cargo };
    log(s, unit.owner, `${s.unitTypes[body.type]?.name ?? '单位'} 从入舱口卸下（${cellName(spot.x, spot.y)}）`, false);
    return null;
  }

  if (!actionId.startsWith('station:launch:')) return null;

  if (unit.type !== STATION_LAUNCH_ID) return '这支部队不是出舱口';
  if (unit.custom?.launchedTurn === s.turn) return '这个出舱口本回合已经发射过了';
  if (stationPower(s, boardIdOf(unit)).brownout) return '这座站断电了，舱门打不开';

  const rest = actionId.slice('station:launch:'.length).split(':');
  const cargoId = rest[0] ?? '';
  const kind = rest[1] ?? '';
  const body = (s.units ?? []).find((u) => u.id === cargoId);
  if (!body) return '这个人已经不在了';
  if (body.owner !== unit.owner) return '不能把别人的兵发射出去';
  if (!launchable(s, body)) return '舱段没法自己走进舱门';
  if (boardIdOf(body) !== boardIdOf(unit)) return '这个人不在这座站上';
  if (Math.abs(body.x - unit.x) + Math.abs(body.y - unit.y) !== 1) return '要贴着一个单位才能装它';

  if (kind === 'dock') {
    const dock = (s.units ?? []).find((u) => u.id === rest[2]);
    if (!dock || dock.type !== STATION_DOCK_ID) return '那个入舱口不见了';
    if (dock.owner !== unit.owner) return '不能往别人的入舱口里送人';
    const orbit = stationsOnOrbit(s, unit).find((st) => st.board === boardIdOf(dock));
    if (!orbit) return '那个入舱口不在同一轨道上';
    const cargo = dockCargo(dock);
    if (cargo.length >= DOCK_CAPACITY) return `那个入舱口满了（${DOCK_CAPACITY}/${DOCK_CAPACITY}）`;

    // 从棋盘上摘下来，装进舱里
    s.units = s.units.filter((u) => u.id !== body.id);
    body.moved = true;
    body.acted = true;
    cargo.push({ unit: body, arrivedTurn: s.turn });
    dock.custom = { ...(dock.custom ?? {}), cargo };
    unit.custom = { ...(unit.custom ?? {}), launchedTurn: s.turn };
    log(
      s,
      unit.owner,
      `${s.unitTypes[body.type]?.name ?? '单位'} 从出舱口发射，进入「${boardName(s, boardIdOf(dock))}」的入舱口`,
      false,
    );
    return null;
  }

  if (kind === 'land') {
    const rec = stationOf(s, unit);
    const planet = rec ? nodeById(s, rec.at)?.board : undefined;
    if (!planet) return '这个轨道上没有可以降落的星球';
    const cell = landingCell(s, planet, unit.owner);
    if (!cell) return '那颗星球上没有能落脚的地方';

    s.units = s.units.filter((u) => u.id !== body.id);
    body.board = planet === EARTH ? undefined : planet;
    body.x = cell.x;
    body.y = cell.y;
    body.moved = true;
    body.acted = true;
    s.units.push(body);
    unit.custom = { ...(unit.custom ?? {}), launchedTurn: s.turn };
    log(
      s,
      unit.owner,
      `${s.unitTypes[body.type]?.name ?? '单位'} 从出舱口跳下，降落在「${boardName(s, planet)}」${cellName(cell.x, cell.y)}`,
      true,
    );
    return null;
  }

  if (kind === 'wreck') {
    const board = rest[2] ?? '';
    const x = Number(rest[3]);
    const y = Number(rest[4]);
    const orbit = rivalStationsOnOrbit(s, unit).find((st) => st.board === board);
    if (!orbit) return '那个破口不在同一轨道上';
    if (tileOn(s, board, x, y)?.terrain !== 'wreck') return '那已经不是一个破口了';
    if (unitOnCell(s, board, x, y)) return '破口那儿已经有人了';

    s.units = s.units.filter((u) => u.id !== body.id);
    body.board = board;
    body.x = x;
    body.y = y;
    body.moved = true;
    body.acted = true;
    s.units.push(body);
    unit.custom = { ...(unit.custom ?? {}), launchedTurn: s.turn };
    log(
      s,
      unit.owner,
      `${s.unitTypes[body.type]?.name ?? '单位'} 从破口登上「${boardName(s, board)}」${cellName(x, y)}`,
      true,
    );
    log(s, orbit.owner, `有敌人从 ${cellName(x, y)} 的破口登上了「${boardName(s, board)}」`, true);
    return null;
  }

  return `认不出这个发射方式：${kind}`;
}

/** 战斗舱段的面板说明（核心舱之外的那几个） */
export function combatLines(s: GameState, u: Unit): string[] {
  /*
   * 废墟优先：这时候"这座舱段能干什么"已经不重要了，重要的是
   * "这站还剩几个回合、谁能接手"。所有舱段共用同一段话。
   */
  const rec = stationOf(s, u);
  if (rec?.ruin) {
    const price = salvageCost(s, rec);
    const mine = rec.owner === u.owner;
    return [
      `废墟：核心舱已被摧毁，全站停摆`,
      `${Math.max(0, rec.ruin.left)} 个回合后整座站会被彻底抹掉（连同上的人和舱段）`,
      mine ? '你是这座站的原主：站在这里付维护费可以把它修回来' : '站上任意单位可以付维护费接管这座站',
      `维护费 ${price} 金，接管后所有舱段归你`,
    ];
  }
  switch (u.type) {
    case STATION_CANNON_ID: {
      const aim = cannonAimBoard(s, u);
      const rivals = rivalStationsOnOrbit(s, u);
      const out = [
        `每回合 1 发，伤害 ${CANNON_ATK}（照常扣护甲），需要航天员相邻、站不能断电`,
        '打不到核心舱；空的甲板会被打穿成破损舱段，站上去的舱段照常结算伤害',
      ];
      if (rivals.length === 0) out.unshift('同一轨道上没有敌方空间站，这门炮暂时没目标');
      else if (!aim) out.unshift(`同一轨道上有 ${rivals.length} 座敌方空间站：先在下面选一个目标`);
      else out.unshift(`当前瞄准「${boardName(s, aim)}」`);
      return out;
    }
    case STATION_ARMOR_ID: {
      const def = s.unitTypes[STATION_ARMOR_ID];
      return [
        `生命 ${u.hp}/${def?.maxHp ?? 0} · 不吃电`,
        '它在的时候，轨道轰击只能打在它身上——脚下这格甲板不会被打穿',
        '站被打成破口之后，往往就是靠它顶着，让对面没法接着往下打',
      ];
    }
    case STATION_LAUNCH_ID: {
      const used = u.custom?.launchedTurn === s.turn;
      const dark = stationPower(s, boardIdOf(u)).brownout;
      return [
        dark ? '这座站断电了，舱门打不开' : used ? '这个出舱口本回合已经发射过了' : '本回合可以发射一次',
        '把相邻的一个单位送到同一轨道上：我方入舱口的空位，或敌方站上的破口',
        '送进破口的人当回合不能动；送进入舱口的人要等一回合才能卸下来',
      ];
    }
    case STATION_DOCK_ID: {
      const n = dockCargo(u).length;
      const out = [`舱内缓存 ${n}/${DOCK_CAPACITY}${n >= DOCK_CAPACITY ? '（满了，拒绝进入）' : ''}`];
      if (n > 0) out.push('点下面的「卸下」把里面的人放到隔壁空甲板');
      else out.push('同轨道我方出舱口送来的人会先存在这里');
      return out;
    }
    default:
      return [];
  }
}

/**
 * 面板上的几行字（核心舱）。
 *
 * **只留"现在是什么状态"，不留"每一座舱段多少钱、干什么"**。
 * 后者每一句都已经写在对应技能的说明里了，在这里再列一遍只是把侧栏拉长：
 * 规则书可以啰嗦，面板不行——玩家在面板上要看的是"这站现在怎么样"。
 * 具体价格在建造按钮上：买不起时右边会写"金币不足 120/450"，那才是需要它的时刻。
 */
export function stationLines(s: GameState, u: Unit): string[] {
  if (u.type !== STATION_CORE_ID) return [];
  const board = boardIdOf(u);
  const b = boardOf(s, board);
  const pct = Math.round(buildRate(s, u.owner) * 100);
  const p = stationPower(s, board);
  const rec = stationOf(s, u);
  const out = [
    `规模 ${b.w}×${b.h} · 建设${pct >= 0 ? `便宜 ${pct}%` : `贵 ${-pct}%`}（${siloWeight(s, u.owner)} 座发射井）`,
    `舱段 ${p.solars} 太阳能 · ${p.lives} 维生仓 · ${p.thrusters} 推进器 · ${p.producers} 生产舱 · 航速 ${rec ? stationSpeed(s, rec) : 1}`,
  ];
  // 在航是一个**状态**，不是说明——它得在这儿，因为启航按钮只列目的地
  if (rec?.travel) out.push(`正在驶向${nodeName(s, rec.travel.to)}：还有 ${Math.max(0, rec.travel.left)} 回合`);
  return out;
}

/* ===========================================================================
 * 废墟与接管
 *
 * ── 生命周期 ────────────────────────────────────────────
 *
 *   核心舱被打掉 / 被自拆
 *        ↓   （`ruinStation`：写 StarStation.ruin，站立刻全停摆）
 *   废墟：3 个原主回合内，站上任意单位可付维护费接管
 *        ↓   （没人接 → `tickStationRuins` 倒计时归零）
 *   整张棋盘连同上面的舱段和人一起删掉（`removeStationBoard`）
 *
 * 为什么是"先变废墟、过 3 回合再删"而不是当场删：打掉核心的战争目标
 * 通常是**抢船**，不是清屏；给一个窗口，攻守双方才有得抢。自己点「拆除」
 * 走的是同一条流程（`by` 写自己），所以不需要第二套实现。
 * ======================================================================== */

/** 拆掉一座站要付的维护费。按**规模**算，不按里面剩下多少舱段——
 *  舱段对敌人是不可见的（`hideUnit`），按数量定价等于把情报标了价。 */
export function salvageCost(s: GameState, station: StarStation): number {
  const b = s.boards?.[station.board];
  const size = b ? Math.max(b.w, b.h) : 5;
  return SALVAGE_BASE_COST + SALVAGE_PER_SIZE * size;
}

/**
 * 让一座站进入废墟。
 *
 * 三条路都走这里：核心舱被打掉（`onUnitKilled`）、玩家点「拆除」、
 * 以及以后可能出现的"弃站"。**幂等**：已经是废墟就直接返回——
 * 死亡钩子在某些路径上会跑两次（先 fireKilled 再 sweepDead），
 * 不幂等的话倒计时会被重置成满格。
 */
export function ruinStation(
  s: GameState,
  board: string,
  x: number,
  y: number,
  by: PlayerId,
  reason: string,
): void {
  const rec = stationRecordOf(s, board);
  if (!rec || rec.ruin) return;
  rec.ruin = { left: RUIN_TURNS, by, x, y };
  // 一座被打烂的站不会再自己飞：半路被毁的站也得当场停在原地
  delete rec.travel;
  // 站里的舱段不再是"这座站的"，但也不销毁：它们是接管时的战利品
  const name = boardName(s, board);
  log(s, by, `${name} 变成废墟（${reason}）：${RUIN_TURNS} 个回合内可以花钱接管`, true);
}

/**
 * 回合开始：给**原主**的那些废墟倒计时。
 *
 * 按原主的回合数算，和火箭/站航行同一套口径（"3 回合"= 这个人自己的三次回合）。
 * 用全局回合会让先手方平白少等一轮，玩家算不出来。
 */
export function tickStationRuins(s: GameState, player: PlayerId): void {
  const map = starmapOf(s);
  if (!map) return;
  for (const st of [...map.stations]) {
    if (!st.ruin || st.ruin.by !== player) continue;
    st.ruin.left -= 1;
    if (st.ruin.left > 0) continue;
    removeStationBoard(s, st.board);
  }
}

/**
 * 把一张站棋盘整块删掉：棋盘、星图记录、上面的一切。
 *
 * 三件容易漏的事，都在这里收口：
 *   · **上面的人**：销毁时他们跟着没（战报要点名，否则玩家只看到自己的兵
 *     从名单里消失了）；
 *   · **飞向它的火箭**：目的地没了再让它到港，会在 `s.boards[board]` 上读到
 *     undefined；
 *   · **记忆里的幽灵**：`memory.known` 里留着已删除棋盘的记录，
 *     名单/星图偶尔还会算到它们。
 */
export function removeStationBoard(s: GameState, board: string): void {
  const map = starmapOf(s);
  if (!map) return;
  const rec = map.stations.find((st) => st.board === board);
  if (!rec) return;
  const name = boardName(s, board);

  const lost = (s.units ?? []).filter((u) => boardIdOf(u) === board);
  if (lost.length > 0) {
    // 站上的人按**各自的主人**分别写一条：一句话里混着两边的兵，谁也读不懂
    const byOwner = new Map<PlayerId, string[]>();
    for (const u of lost) {
      const list = byOwner.get(u.owner) ?? [];
      list.push(s.unitTypes[u.type]?.name ?? u.type);
      byOwner.set(u.owner, list);
    }
    for (const [owner, names] of byOwner) {
      log(s, owner, `${name} 彻底解体，${names.length} 个单位随之消失：${names.join('、')}`, true);
    }
  }
  s.units = (s.units ?? []).filter((u) => boardIdOf(u) !== board);

  // 在途的火箭：目的地没了。就地取消，并把货还到起点那颗星球的轨道上？——
  // 不还：火箭已经飞出去一半，凭空变回一群人比"失联"更难解释。
  const transit = s.transit ?? [];
  const doomed = transit.filter((t) => t.board === board);
  if (doomed.length > 0) {
    for (const t of doomed) {
      log(s, t.owner, `${name} 已经不存在，飞向它的火箭失联（${t.cargo.length} 个单位）`, true);
    }
    s.transit = transit.filter((t) => t.board !== board);
  }

  // 记忆：每方各删一份
  for (const mem of Object.values(s.memory ?? {})) {
    if (!mem?.known) continue;
    mem.known = mem.known.filter((k) => k.board !== board);
  }
  // 侦察情报同样按图存
  if (s.recon) s.recon = s.recon.filter((r) => r.board !== board);

  map.stations = map.stations.filter((st) => st.board !== board);
  delete s.boards?.[board];
  // 一条公开战报就够：名字消失这件事两方都该看到（`open` 只写一次）
  log(s, rec.owner, `${name} 已经从星图上消失`, true);
}

/**
 * 站在废墟上的单位能看到「接管」按钮。
 *
 * 换成**动作**而不是"走过去自动接管"（城市废墟是后者）：站内的"走上去"
 * 稀松平常，一次误点就掏掉几百金；而且废墟本身要连续几回合被人站着，
 * 做成按钮才说得清"我打算接手这艘船"。
 */
export function ruinActions(s: GameState, unit: Unit): UnitActionOption[] {
  const rec = stationOf(s, unit);
  if (!rec?.ruin) return [];
  const price = salvageCost(s, rec);
  const afford = s.players[unit.owner].gold >= price;
  return [
    {
      id: 'station:salvage',
      group: '废墟',
      label: rec.owner === unit.owner ? '抢修这座空间站' : '接管这座空间站',
      detail: `付维护费把它连同所有舱段修好，归你所有（核心舱重新出现在原位）`,
      note: afford ? `${price} 金` : `金币不足 ${s.players[unit.owner].gold}/${price}`,
      disabled: !afford,
    },
  ];
}

/**
 * 接管废墟：付钱 → 换主 → 核心舱在原位重生 → 舱段一起改姓。
 *
 * 站上的**其他人**（原主的守军）不会因此消失，也不会自动变节：他们还在
 * 这座站里，于是立刻变成"在敌站里的一小队人"——这正是抢船该有的样子。
 */
export function salvageStation(s: GameState, unit: Unit): string | null {
  const rec = stationOf(s, unit);
  if (!rec?.ruin) return '这里没有可以接管的废墟';
  const board = rec.board;
  const price = salvageCost(s, rec);
  if (s.players[unit.owner].gold < price) return `维护费不够（要 ${price} 金）`;

  const { x, y } = rec.ruin;
  const prevOwner = rec.owner;
  s.players[unit.owner].gold -= price;

  rec.owner = unit.owner;
  delete rec.ruin;
  // 名字跟着换主：只改"默认名"（原主的名字 + 编号），玩家自己起过的名字不动
  const b = s.boards?.[board];
  const prevName = s.players[prevOwner]?.name ?? prevOwner;
  const myName = s.players[unit.owner]?.name ?? unit.owner;
  const prefix = `${prevName}的空间站`;
  if (b?.name?.startsWith(prefix)) b.name = `${myName}的空间站${b.name.slice(prefix.length)}`;
  // 舱段跟着换主：只是"重新接上电"，不是重新造一遍。
  // 原主自己抢修时这些舱段本来就是他的，只数不改。
  let modules = 0;
  for (const u of s.units ?? []) {
    if (boardIdOf(u) !== board || u.type === STATION_CORE_ID) continue;
    u.owner = unit.owner;
    u.acted = true;
    modules += 1;
  }

  // 核心舱在原位重生：满血、当回合不能动（它是"刚修好"，不是"一直在"）。
  // 原位被站着（接管的人自己就可能站在那儿）就退到旁边最近的一格空甲板——
  // 两个单位叠在一格上，后面每一条占位判定都会错。
  let spot = { x, y };
  if (coveredOn(s, board, x, y)) {
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (tileOn(s, board, nx, ny)?.terrain !== 'deck') continue;
      if (coveredOn(s, board, nx, ny)) continue;
      spot = { x: nx, y: ny };
      break;
    }
  }
  const coreDef = s.unitTypes[STATION_CORE_ID];
  const core: Unit = {
    id: `u${s.nextUnitSeq++}`,
    type: STATION_CORE_ID,
    owner: unit.owner,
    x: spot.x,
    y: spot.y,
    hp: coreDef?.maxHp ?? 120,
    kills: 0,
    moved: true,
    acted: true,
    board,
  };
  s.units.push(core);

  const name = boardName(s, board);
  log(s, unit.owner, `支付 ${price} 金接管「${name}」，${modules} 座舱段归你`, true);
  if (prevOwner !== unit.owner) log(s, prevOwner, `「${name}」被对手接管了`, true);
  return null;
}

/**
 * 拆除自己的站：**不是当场消失**，而是立刻进入废墟，走完 3 回合的毁灭流程。
 *
 * 为什么要留这段：拆站的目的通常是"不留给对面"。当场删掉等于替对手
 * 省了判断；走废墟流程，对面还有 3 个回合可以抢修——拆的一方要么守住，
 * 要么接受它可能被接手。这也是为什么这个按钮要二次确认。
 */
export function scuttleStation(s: GameState, unit: Unit): string | null {
  const rec = stationOf(s, unit);
  if (!rec) return '这支部队不在任何空间站上';
  if (unit.type !== STATION_CORE_ID) return '只有核心舱能拆掉一座站';
  if (rec.ruin) return '这座站已经是废墟了';

  ruinStation(s, rec.board, unit.x, unit.y, unit.owner, '被自己人拆除');
  // 核心舱当场没了：站立刻停摆，剩下的舱段留作接管时的战利品
  s.units = (s.units ?? []).filter((u) => u.id !== unit.id);
  return null;
}

/* ── 降落：出舱口的第三个目的地 ─────────────────────────────────── */

/**
 * 太空部队落到某颗星球时的落点。
 *
 * 两种规则，按"有没有接驳站"分：
 *   · 有：落在接驳站**身边**（近处那一圈空地上），这就是接驳站的全部作用；
 *   · 没有：落在全图正中央，再往外螺旋找第一块能站的地。
 *
 * 从中心往外找而不是"中心不行就失败"：正中央常常压着城或山，
 * 那种情况下还回一句"落不下去"，等于让这个目的地随机不可用。
 */
export function landingCell(s: GameState, board: string, owner: PlayerId): { x: number; y: number } | null {
  const b = boardOf(s, board);
  const free = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= b.w || y >= b.h) return false;
    const tile = tileOn(s, board, x, y);
    if (!tile) return false;
    const t = tile.terrain;
    // 城格不算落点：空降进城等于绕过城墙，而"入城"在这套规则里是走进去的事
    if (t === 'city' || tile.cityId) return false;
    if (!passable(t) || t === 'void' || t === 'wreck') return false;
    return !coveredOn(s, board, x, y);
  };

  const pad = (s.units ?? []).find(
    (u) => u.type === LANDING_PAD_ID && u.owner === owner && u.hp > 0 && boardIdOf(u) === board,
  );
  if (pad) {
    // 接驳站是 2×2：从它外沿那一圈开始，一圈一圈往外找
    const n = footprintOf(s, pad);
    const ringOf = (x: number, y: number, ring: number): boolean =>
      x === pad.x - ring ||
      x === pad.x + n - 1 + ring ||
      y === pad.y - ring ||
      y === pad.y + n - 1 + ring;
    for (let ring = 1; ring <= Math.max(b.w, b.h); ring += 1) {
      for (let y = pad.y - ring; y <= pad.y + n - 1 + ring; y += 1) {
        for (let x = pad.x - ring; x <= pad.x + n - 1 + ring; x += 1) {
          if (!ringOf(x, y, ring)) continue;
          if (free(x, y)) return { x, y };
        }
      }
    }
    return null;
  }

  const cx = Math.floor((b.w - 1) / 2);
  const cy = Math.floor((b.h - 1) / 2);
  for (let ring = 0; ring < Math.max(b.w, b.h); ring += 1) {
    for (let y = cy - ring; y <= cy + ring; y += 1) {
      for (let x = cx - ring; x <= cx + ring; x += 1) {
        // 只走"这一圈"的格，否则越近的格子会被反复检查
        if (Math.abs(x - cx) + Math.abs(y - cy) !== ring) continue;
        if (free(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/** 这一格是不是被某个单位（按占地）压着 */
function coveredOn(s: GameState, board: string, x: number, y: number): boolean {
  return (s.units ?? []).some((u) => {
    if (u.hp <= 0 || boardIdOf(u) !== board) return false;
    const n = footprintOf(s, u);
    return x >= u.x && x < u.x + n && y >= u.y && y < u.y + n;
  });
}

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
import { boardIdOf, boardOf, boardStateOf, tileOn } from '../board.ts';
import { tilesOfUnit } from '../query.ts';
import { registerSkillEffect, registerSkillReadyCheck, registerSkillTargetCells, type SkillCtx } from '../skill-hooks.ts';
import { lanesFrom, laneDistance, nodeName, nodeOf, starmapOf } from './starmap.ts';
import { registerOrbitArrival } from './transit.ts';
import { SILO_ID } from './silo.ts';

export const STATION_CORE_ID = 'station-core';
export const STATION_PRODUCER_ID = 'station-producer';
export const STATION_SOLAR_ID = 'station-solar';
export const STATION_THRUSTER_ID = 'station-thruster';

/** 铺一格甲板的额定价（会乘折扣） */
export const EXPAND_BASE_COST = 80;
/** 一座生产舱的额定价（会乘折扣） */
export const PRODUCER_BASE_COST = 320;
/** 一块太阳能舱的额定价（会乘折扣） */
export const SOLAR_BASE_COST = 240;
/** 一台推进器舱的额定价（会乘折扣） */
export const THRUSTER_BASE_COST = 420;
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
  return Math.max(1, Math.round(base * (1 - buildRate(s, player))));
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
  return { id, kind: 'station', name, w: n, h: n, tiles };
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
 * 一座站的能量账。
 *
 * 收的是**哪张站棋盘**，不是"哪个玩家"——两座站隔着几万公里，
 * 不可能互相供电。这也是它和 `armor.energyReport`（一方共用一股电）的区别。
 */
export function stationPower(s: GameState, board: string): StationPower {
  let supply = 0;
  let demand = 0;
  let cores = 0;
  let solars = 0;
  let thrusters = 0;
  let producers = 0;
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
    brownout: demand > supply,
  };
}

/** 这支兵所在站的能量账（不在站上返回 null） */
export function stationPowerOf(s: GameState, u: Unit): StationPower | null {
  const board = boardIdOf(u);
  if (!isStationBoard(s, board)) return null;
  return stationPower(s, board);
}

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
 * 启航：**只改一个字段**。站内坐标、单位、甲板全都不动，
 * 到港时把 `at` 改成目的地。这就是"不用真挪坐标"的实现。
 */
export function beginStationSail(s: GameState, station: StarStation, to: StarNodeId): string | null {
  const problem = stationSailProblem(s, station);
  if (problem) return problem;
  const dest = stationDestinations(s, station).find((d) => d.to === to);
  if (!dest) return '这两个节点之间没有航道';

  station.travel = { lane: dest.lane.id, from: station.at, to, left: dest.turns };
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
  const name = `${s.players[owner]?.name ?? owner}的空间站`;

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

const STATION_EXPAND: SkillDef = {
  id: 'station-expand',
  name: '扩建甲板',
  summary: '把一格虚空铺成甲板。一次一格，可以连着铺；价格按太空建设折扣算。',
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
  skills: [STATION_EXPAND, STATION_BUILD, STATION_BUILD_SOLAR, STATION_BUILD_THRUSTER],
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

// ── 技能：扩建 / 建造 ────────────────────────────────────────────────

function log(s: GameState, p: PlayerId, text: string, open = false): void {
  s.log.push({ turn: s.turn, player: p, text, open });
}

/** 4 邻域里有没有已经铺好的甲板（核心舱本身站在甲板上，所以它也覆盖到了） */
function touchesDeck(s: GameState, board: string, x: number, y: number): boolean {
  return (
    tileOn(s, board, x - 1, y)?.terrain === 'deck' ||
    tileOn(s, board, x + 1, y)?.terrain === 'deck' ||
    tileOn(s, board, x, y - 1)?.terrain === 'deck' ||
    tileOn(s, board, x, y + 1)?.terrain === 'deck'
  );
}

/** 站内所有"挨着已有甲板"的虚空 */
registerSkillTargetCells('station-expand', ({ state, self }) => {
  const board = boardIdOf(self);
  const b = boardOf(state, board);
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (tileOn(state, board, x, y)?.terrain !== 'void') continue;
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
  if (!tile || tile.terrain !== 'void') {
    c.result.ok = false;
    c.result.reason = '只能铺虚空';
    return;
  }
  if (!touchesDeck(c.state, board, t.x, t.y)) {
    c.result.ok = false;
    c.result.reason = '要挨着已有的甲板铺';
    return;
  }
  const cost = buildCost(c.state, self.owner, EXPAND_BASE_COST);
  if (c.state.players[self.owner].gold < cost) {
    c.result.ok = false;
    c.result.reason = `金币不够（要 ${cost}）`;
    return;
  }
  c.state.players[self.owner].gold -= cost;
  tile.terrain = 'deck';
  c.result.log = `铺下一格甲板（${cost} 金）`;
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
      c.result.reason = `电力不够：要 ${opts.draw}，还余 ${p.headroom}`;
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
  if (s.players[u.owner].gold < buildCost(s, u.owner, EXPAND_BASE_COST)) {
    return '金币不够';
  }
  return true;
});

registerSkillReadyCheck('station-build', (s, u) => {
  const p = stationPowerOf(s, u);
  if (p && p.headroom < PRODUCER_DRAW) {
    return `电力不够（要 ${PRODUCER_DRAW}，还余 ${p.headroom}）：先造太阳能舱`;
  }
  if (s.players[u.owner].gold < buildCost(s, u.owner, PRODUCER_BASE_COST)) {
    return '金币不够';
  }
  return true;
});

registerSkillReadyCheck('station-build-solar', (s, u) => {
  if (s.players[u.owner].gold < buildCost(s, u.owner, SOLAR_BASE_COST)) {
    return '金币不够';
  }
  return true;
});

registerSkillReadyCheck('station-build-thruster', (s, u) => {
  const p = stationPowerOf(s, u);
  if (p && p.headroom < THRUSTER_DRAW) {
    return `电力不够（要 ${THRUSTER_DRAW}，还余 ${p.headroom}）：先造太阳能舱`;
  }
  if (s.players[u.owner].gold < buildCost(s, u.owner, THRUSTER_BASE_COST)) {
    return '金币不够';
  }
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

/** 面板上的几行字 */
export function stationLines(s: GameState, u: Unit): string[] {
  if (u.type !== STATION_CORE_ID) return [];
  const board = boardIdOf(u);
  const b = boardOf(s, board);
  const rate = buildRate(s, u.owner);
  const pct = Math.round(rate * 100);
  const out = [
    `站的规模：${b.w}×${b.h}`,
    `太空建设折扣：${pct >= 0 ? `便宜 ${pct}%` : `贵 ${-pct}%`}（${siloWeight(s, u.owner)} 座发射井）`,
  ];
  const expand = buildCost(s, u.owner, EXPAND_BASE_COST);
  const maker = buildCost(s, u.owner, PRODUCER_BASE_COST);
  const solar = buildCost(s, u.owner, SOLAR_BASE_COST);
  const thruster = buildCost(s, u.owner, THRUSTER_BASE_COST);
  const p = stationPower(s, board);
  out.push(
    `能量：供电 ${p.supply} / 已用 ${p.demand} / ${p.brownout ? `过载 ${-p.headroom}（全站停摆）` : `余量 ${p.headroom}`}`,
  );
  const rec = stationOf(s, u);
  const speed = rec ? stationSpeed(s, rec) : 1;
  out.push(
    `舱段：${p.solars} 太阳能 · ${p.thrusters} 推进器 · ${p.producers} 生产舱` +
      `（航速 ${speed}）`,
  );
  if (rec?.travel) {
    out.push(`正在驶向${nodeName(s, rec.travel.to)}：还有 ${Math.max(0, rec.travel.left)} 回合`);
  } else if (rec) {
    const dests = stationDestinations(s, rec);
    if (dests.length > 0) {
      const list = dests.map((d) => `${nodeName(s, d.to)} ${d.turns} 回合`).join(' · ');
      out.push(`可航行：${list}`);
    }
  }
  out.push(`扩建一格甲板：${expand} 金`);
  out.push(`一座生产舱：${maker} 金（每回合 +${PRODUCER_INCOME} 金，耗电 ${PRODUCER_DRAW}）`);
  out.push(`一块太阳能舱：${solar} 金（发电 ${SOLAR_POWER}）`);
  out.push(`一台推进器舱：${thruster} 金（耗电 ${THRUSTER_DRAW}，航速 +${THRUSTER_SPEED}）`);
  return out;
}

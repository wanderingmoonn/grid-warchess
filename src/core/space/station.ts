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

import type { Board, GameState, PlayerId, SkillDef, Transit, Unit, UnitTypeDef } from '../types.ts';
import { boardIdOf, boardOf, boardStateOf, tileOn } from '../board.ts';
import { tilesOfUnit } from '../query.ts';
import { registerSkillEffect, registerSkillReadyCheck, registerSkillTargetCells } from '../skill-hooks.ts';
import { nodeName, nodeOf, starmapOf } from './starmap.ts';
import { registerOrbitArrival } from './transit.ts';
import { SILO_ID } from './silo.ts';

export const STATION_CORE_ID = 'station-core';
export const STATION_PRODUCER_ID = 'station-producer';

/** 铺一格甲板的额定价（会乘折扣） */
export const EXPAND_BASE_COST = 80;
/** 一座生产舱的额定价（会乘折扣） */
export const PRODUCER_BASE_COST = 320;
/** 生产舱每回合产多少金币 */
export const PRODUCER_INCOME = 6;

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
  summary: `在空的甲板上造一座生产舱，每回合产 ${PRODUCER_INCOME} 金。价格按太空建设折扣算。`,
  effect: 'station-build',
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
  skills: [STATION_EXPAND, STATION_BUILD],
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
registerSkillTargetCells('station-build', ({ state, self }) => {
  const board = boardIdOf(self);
  const b = boardOf(state, board);
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (tileOn(state, board, x, y)?.terrain !== 'deck') continue;
      if (occupiedAt(state, self, x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
});

registerSkillEffect('station-build', (c) => {
  const self = c.self;
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '要选一格空甲板';
    return;
  }
  const board = boardIdOf(self);
  if (tileOn(c.state, board, t.x, t.y)?.terrain !== 'deck') {
    c.result.ok = false;
    c.result.reason = '只能建在甲板上';
    return;
  }
  if (occupiedAt(c.state, self, t.x, t.y)) {
    c.result.ok = false;
    c.result.reason = '那一格已经有东西了';
    return;
  }
  const cost = buildCost(c.state, self.owner, PRODUCER_BASE_COST);
  if (c.state.players[self.owner].gold < cost) {
    c.result.ok = false;
    c.result.reason = `金币不够（要 ${cost}）`;
    return;
  }

  c.state.players[self.owner].gold -= cost;
  const def = c.state.unitTypes[STATION_PRODUCER_ID];
  c.api.spawn(c.state, self.owner, STATION_PRODUCER_ID, t.x, t.y, board);
  // 刚造出来这一回合不干活：和"新招的兵当回合不能动"同一条
  const born = c.state.units[c.state.units.length - 1];
  if (born) born.acted = true;
  c.result.log = `建成一座${def?.name ?? '生产舱'}（${cost} 金）`;
});

registerSkillReadyCheck('station-expand', (s, u) => {
  if (s.players[u.owner].gold < buildCost(s, u.owner, EXPAND_BASE_COST)) {
    return '金币不够';
  }
  return true;
});

registerSkillReadyCheck('station-build', (s, u) => {
  if (s.players[u.owner].gold < buildCost(s, u.owner, PRODUCER_BASE_COST)) {
    return '金币不够';
  }
  return true;
});

/** 回合开始：每座生产舱给自己主人产金币 */
export function tickProducers(s: GameState, player: PlayerId): void {
  if (!s.unitTypes[STATION_PRODUCER_ID]) return;
  let n = 0;
  for (const u of s.units) {
    if (u.owner !== player || u.type !== STATION_PRODUCER_ID) continue;
    if (!isStationBoard(s, boardIdOf(u))) continue;
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
  out.push(`扩建一格甲板：${expand} 金`);
  out.push(`一座生产舱：${maker} 金（每回合 +${PRODUCER_INCOME} 金）`);
  return out;
}

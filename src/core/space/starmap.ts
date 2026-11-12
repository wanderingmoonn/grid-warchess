/**
 * 星图——把"一堆并列的图"变成"有距离、有路、有位置"的东西。
 *
 * 基础包（太空时代）里，地球和月球只是两张碰巧存在的图：发射井自己知道
 * 月球在哪，落点写在 `moonLandingTile` 里，`MOON_BOARD` 是硬编码的常量。
 * 那样做不出三件事：
 *
 *   · **选择**——只有一条路，没有"走哪条"；
 *   · **在途**——点火即到达，中间没有可以被看见、被等待的那一段；
 *   · **空间站**——没有"站点"这个概念，站只能是一个建筑。
 *
 * 所以这一层只做一件很小的事：给节点和航道一张表。
 * 它不懂战斗、不懂发射，只回答"从 A 到 B 有路吗、要几回合"。
 *
 * ── 数据放哪 ────────────────────────────────────────────
 *
 * `state.starmap`，和 `pendingEgg` 一样是**扩展专用、核心不知道**的可选字段。
 * 好处是存档、回放、联机快照全都天然带上——它们在克隆整个 state，不需要兼容层。
 */

import type { BoardId, GameState, StarLane, StarNode, StarNodeId, Starmap } from '../types.ts';
import { boardIdOf, boardName, EARTH } from '../board.ts';
import { MOON_BOARD } from './moon.ts';

/** 地球的节点 id。和 `EARTH` 同值，但语义是"星图上的点"，别混着用 */
export const EARTH_NODE: StarNodeId = EARTH;

/** 月球的节点 id */
export const MOON_NODE: StarNodeId = MOON_BOARD;

/** 地月航道上**火箭**要飞几个回合。推进器不影响它——火箭弹道是固定的 */
export const MOON_LANE_TURNS = 1;

/**
 * 地月航道的**太空距离**：空间站自己开过去时按 `距离 ÷ 速度` 算。
 *
 * 为什么和上面的回合数分开：这两件事的速度来源不同。
 *   · 火箭是一次性投送，弹道写死，谁发都是 1 回合；
 *   · 空间站是**飞船**，推力越大开得越快，速度 = 1 + 在役推进器数。
 *
 * 如果共用一个字段，就只能二选一：要么火箭慢到能体现推进器（玩家嫌流程长），
 * 要么推进器在火箭上永远看不出效果。
 */
export const MOON_LANE_DISTANCE = 6;

/** 地月航道的 id（存档里认这个字符串，别改） */
export const MOON_LANE = 'earth-moon';

/**
 * 造一张默认星图。
 *
 * 只有"有棋盘的节点"进 `nodes`：没开太空包的对局根本没有月球，
 * 也就没有星图（`starmap` 保持 undefined）——那种局里发射井也不存在。
 */
export function createStarmap(opts: { moon?: boolean } = {}): Starmap {
  const nodes: StarNode[] = [{ id: EARTH_NODE, kind: 'planet', board: EARTH, name: '地球' }];
  const lanes: StarLane[] = [];
  if (opts.moon) {
    nodes.push({ id: MOON_NODE, kind: 'moon', board: MOON_BOARD, name: '月球' });
    lanes.push({
      id: MOON_LANE,
      a: EARTH_NODE,
      b: MOON_NODE,
      turns: MOON_LANE_TURNS,
      distance: MOON_LANE_DISTANCE,
    });
  }
  return { nodes, lanes, stations: [], seq: 0 };
}

/** 火箭的航程（回合）。老存档只有 `turns`，正好也是这个意思 */
export function laneCruise(l: StarLane): number {
  return Math.max(1, l.turns ?? 1);
}

/**
 * 航道的太空距离（空间站航行用）。
 *
 * 老存档没有这个字段：按"火箭 1 回合 = 距离 6"的比例补一个，
 * 让升级上来的存档也能航行，而不是算成 0 回合瞬移。
 */
export function laneDistance(l: StarLane): number {
  return Math.max(1, l.distance ?? laneCruise(l) * 6);
}

/**
 * 拿到这一局的星图，没有就按现有棋盘补一张。
 *
 * 为什么要补：11-12 之前的存档只有月球图、没有星图。读进来之后如果直接
 * `s.starmap.nodes` 就是崩，所以入口统一走这里，老存档自动追上。
 * 返回 undefined = 这一局既没有星图也没有月球，太空那套完全不参与。
 */
export function starmapOf(s: GameState): Starmap | undefined {
  if (s.starmap) return s.starmap;
  const moon = !!s.boards?.[MOON_BOARD];
  if (!moon) return undefined;
  s.starmap = createStarmap({ moon });
  return s.starmap;
}

/** 只读版本：不改 state（给 UI、面板这类"看一眼"的地方用） */
export function peekStarmap(s: GameState): Starmap | undefined {
  if (s.starmap) return s.starmap;
  return s.boards?.[MOON_BOARD] ? createStarmap({ moon: true }) : undefined;
}

export function nodeById(s: GameState, id: StarNodeId): StarNode | undefined {
  return peekStarmap(s)?.nodes.find((n) => n.id === id);
}

/** 这张棋盘对应星图上的哪个节点（地球、月球、生成出来的空间站） */
export function nodeOfBoard(s: GameState, board: BoardId): StarNode | undefined {
  return peekStarmap(s)?.nodes.find((n) => n.board === board);
}

/** 这个单位/城市所在的节点（缺省地球） */
export function nodeOf(s: GameState, o: { board?: BoardId }): StarNode | undefined {
  return nodeOfBoard(s, boardIdOf(o));
}

export function laneById(s: GameState, id: string): StarLane | undefined {
  return peekStarmap(s)?.lanes.find((l) => l.id === id);
}

/** 两个节点之间有没有直达航道（无向：A→B 和 B→A 是同一条） */
export function laneBetween(s: GameState, a: StarNodeId, b: StarNodeId): StarLane | undefined {
  return peekStarmap(s)?.lanes.find(
    (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a),
  );
}

/**
 * 从某个节点出发能去哪儿：一条边两个方向都算出口。
 *
 * 没有"封锁"这一档（见 `StarLane` 的注释）：连着的就是连着的，
 * 这里只回答"有哪些邻居、各要几回合"。
 */
export function lanesFrom(
  s: GameState,
  from: StarNodeId,
): Array<{ lane: StarLane; to: StarNodeId }> {
  const out: Array<{ lane: StarLane; to: StarNodeId }> = [];
  for (const l of peekStarmap(s)?.lanes ?? []) {
    if (l.a === from) out.push({ lane: l, to: l.b });
    else if (l.b === from) out.push({ lane: l, to: l.a });
  }
  return out;
}

/** 节点的显示名，拿不到就用棋盘名兜底 */
export function nodeName(s: GameState, id: StarNodeId): string {
  const n = nodeById(s, id);
  if (n) return n.name;
  return boardName(s, id);
}

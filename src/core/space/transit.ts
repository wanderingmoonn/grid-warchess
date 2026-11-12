/**
 * 航道投送——"一个单位从图 A 到图 B"的唯一一条路。
 *
 * ── 为什么要有这一层 ────────────────────────────────────
 *
 * 在它之前，跨图转移**只有一条硬编码路径**：发射井装货 → 加注 → `launchToMoon`
 * 直接把单位放到 `moonLandingTile`。写死在 `silo.ts` 里，连"月球"这个词都是常量。
 *
 * 太空战争要的每一件事——登月、送核心舱、进空间站、空间站换位——本质都是同一句：
 * *把东西从一张图送到另一张图*。所以先长出这条链，再谈内容：
 *
 *   ```
 *   enterLane()  → 单位移出 units，挂在 transit 上
 *   tickTransit() → 每个自己的回合 left -1
 *   left 归零     → arrive() 按**目的图**算落点，放回 units
 *   ```
 *
 * ── 三个刻意的选择 ──────────────────────────────────────
 *
 *   1. **在途单位不在 `s.units` 里**。留下的话会被回合重置（`moved`/`acted` 被清）、
 *      被迷雾裁、被战斗误伤，还会在两张图上"同时存在"。货舱那套语义正好能复用。
 *   2. **落点按目的图算**。`landingSpotOn(s, board)` 是通用的"离中心最近的空地"，
 *      不再知道月球是什么。
 *   3. **全程公开**。发射与到达都写公开战报，`left` 双方可见——火箭在天上飞，
 *      对手得看得见，才谈得上在落点等它。这是基础包里"加注进度公开"的延续。
 */

import type { BoardId, GameState, PlayerId, StarNodeId, Transit, Unit } from '../types.ts';
import { boardIdOf, boardOf, tileOn } from '../board.ts';
import { tilesOfUnit } from '../query.ts';
import { passable } from '../config.ts';
import { starmapOf, nodeName } from './starmap.ts';

/** 面板上的一格坐标写法（A1） */
export function cellName(x: number, y: number): string {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
}

function log(s: GameState, p: PlayerId, text: string, open = false): void {
  s.log.push({ turn: s.turn, player: p, text, open });
}

/** 这一格能不能落人：地形过得去、也没人占着 */
function freeSpotOn(s: GameState, board: BoardId, x: number, y: number): boolean {
  // 按图取格：`tileOn` 认"地球的格在 s 上、别的图在 boards 里"这条约定
  const tile = tileOn(s, board, x, y);
  if (!tile || !passable(tile.terrain)) return false;
  for (const u of s.units) {
    if (boardIdOf(u) !== board) continue;
    for (const t of tilesOfUnit(s, u)) {
      if (t.x === x && t.y === y) return false;
    }
  }
  return true;
}

/**
 * 这张图的落点：**离中心最近的空地**。
 *
 * 取中心而不是随机，是因为"落在哪"必须能预判——玩家要绕着它排兵、
 * 要堵对面的着陆点。随机落点会让每一次投送都变成开盲盒。
 *
 * 被占的格让开，于是第二艘会自己往外挪一圈；环形山也能落（它只是贵一步）。
 */
export function landingSpotOn(s: GameState, board: BoardId): { x: number; y: number } | null {
  const b = boardOf(s, board);
  const cx = (b.w - 1) / 2;
  const cy = (b.h - 1) / 2;
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (!freeSpotOn(s, board, x, y)) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * 让一批单位上路。
 *
 * 返回 null = 这条路走不了（没有星图、没有这条航道、航道被封锁、
 * 目的地还没有棋盘）。P0 只有"有棋盘的节点"能当目的地；
 * P2 的核心舱会带来"发往一个空槽位"的情况，到那时在这一层开个口子，
 * 而不是在发射井里写特例。
 */
export function enterLane(
  s: GameState,
  opts: { owner: PlayerId; laneId: string; to: StarNodeId; cargo: Unit[]; from?: StarNodeId },
): Transit | null {
  const map = starmapOf(s);
  const lane = map?.lanes.find((l) => l.id === opts.laneId);
  if (!map || !lane) return null;
  // 方向由"去哪"决定：一条航道两个方向都走
  const from = lane.a === opts.to ? lane.b : lane.a;
  if (lane.a !== opts.to && lane.b !== opts.to) return null;
  const dest = map.nodes.find((n) => n.id === opts.to);
  if (!dest?.board) return null;
  if (opts.cargo.length === 0) return null;

  const mine = (s.transit ?? []).filter((t) => t.owner === opts.owner).length;
  const t: Transit = {
    // 同一回合同一家可能发两枚，序号 + 回合 + 方 足以唯一
    id: `tr-${opts.owner}-${s.turn}-${mine + 1}`,
    owner: opts.owner,
    lane: lane.id,
    from: opts.from ?? from,
    to: opts.to,
    left: lane.turns,
    cargo: opts.cargo.map((u) => ({ ...u })),
  };
  s.transit = [...(s.transit ?? []), t];
  return t;
}

/**
 * 到达：把货按**目的图**的落点放回棋盘。
 *
 * 返回 false = 落不下（目的地被堵满 / 目的节点还没有棋盘），
 * 这时**单位留在天上**、下一回合再试——不能丢，也不该凭空塞进别人身上。
 */
export function arrive(s: GameState, t: Transit): boolean {
  const map = starmapOf(s);
  const board = map?.nodes.find((n) => n.id === t.to)?.board;
  if (!board) return false;

  const landed: Unit[] = [];
  for (const pax of t.cargo) {
    const spot = landingSpotOn(s, board);
    if (!spot) break;
    const u: Unit = {
      ...pax,
      board,
      x: spot.x,
      y: spot.y,
      // 落地当回合不能动：否则"发射 + 立刻行动"等于白送一个回合
      moved: true,
      acted: true,
    };
    s.units.push(u);
    landed.push(u);
    log(
      s,
      t.owner,
      `${s.unitTypes[u.type]?.name ?? u.type} 抵达${nodeName(s, t.to)}（${cellName(spot.x, spot.y)}）`,
      true,
    );
  }

  if (landed.length === 0) return false;
  // 只送走了一部分：剩下的继续等（P0 货舱只有 1 格，这条只是不丢东西的保险）
  if (landed.length < t.cargo.length) t.cargo = t.cargo.slice(landed.length);
  return landed.length === t.cargo.length;
}

/**
 * 回合开始：推进**这一方自己**的航程。
 *
 * 只推自己的：路上的东西归主人管，对手的回合不该替他飞一格。
 */
export function tickTransit(s: GameState, player: PlayerId): void {
  const list = s.transit;
  if (!list || list.length === 0) return;
  const keep: Transit[] = [];
  for (const t of list) {
    if (t.owner !== player) {
      keep.push(t);
      continue;
    }
    if (t.left > 0) t.left -= 1;
    if (t.left > 0) {
      keep.push(t);
      continue;
    }
    if (!arrive(s, t)) {
      keep.push(t);
      log(
        s,
        t.owner,
        `${nodeName(s, t.to)}没有落脚的地方，火箭暂缓降落（下一回合再试）`,
        true,
      );
    }
  }
  s.transit = keep;
}

/** 这一方还有几个东西在天上（顶栏、面板用） */
export function transitCountOf(s: GameState, player: PlayerId): number {
  return (s.transit ?? []).filter((t) => t.owner === player).length;
}

/**
 * 面板上的几行字：现在飞到哪、还有几回合。
 *
 * 公开：位置与剩余回合是**双方都能读**的信息（和加注进度同一条口径）。
 * 载的是谁由调用方决定要不要说——发射井自己的面板会说，对手不显示。
 */
export function transitLines(s: GameState, player: PlayerId, opts: { revealCargo?: boolean } = {}): string[] {
  const mine = (s.transit ?? []).filter((t) => t.owner === player);
  if (mine.length === 0) return [];
  return mine.map((t) => {
    const to = nodeName(s, t.to);
    const who = opts.revealCargo
      ? t.cargo.map((u) => s.unitTypes[u.type]?.name ?? u.type).join('、')
      : '货物';
    return `在途：${who} → ${to}，还有 ${Math.max(0, t.left)} 回合`;
  });
}

/**
 * 星图的**布局**：哪些节点画在哪个格、哪条线连谁。
 *
 * ── 为什么坐标是算出来的，不是存下来的 ──────────────────
 *
 * 如果节点位置进存档，加一张图（或以后加空间站）就得写存档迁移，
 * 而且同一局在不同屏幕上可能算出不同布局。所以这里只做一件事：
 * **按节点在 `starmap.nodes` 里的次序**，把地球放中间、其余节点沿外圈均分。
 *
 * 同一组节点永远算出同一个布局；加节点也只是外圈多一个点，老节点不会跳位。
 *
 * 这个文件不碰 DOM、不碰 Canvas，纯数据 → 可被测试直接调。
 */

import type { GameState, PlayerId, StarNodeId } from '../core/types.ts';
import { peekStarmap, EARTH_NODE } from '../core/space/starmap.ts';
import { laneTurnsFor } from '../core/space/transit.ts';

export interface StarStationCell {
  board: string;
  owner: PlayerId;
  ownerName: string;
  name: string;
  /** 正在驶向哪个节点（没在航行就没有这个字段） */
  travelTo?: string;
}

export interface StarNodeCell {
  id: StarNodeId;
  name: string;
  kind: 'planet' | 'moon' | 'orbit';
  /** 这个节点对应的棋盘（轨道槽位在核心舱展开之前没有） */
  board?: string;
  x: number;
  y: number;
  /** 停在这个节点轨道上的空间站 */
  stations: StarStationCell[];
}

export interface StarLaneCell {
  id: string;
  a: StarNodeCell;
  b: StarNodeCell;
  turns: number;
}

export interface StarLayout {
  /** 网格边长（正方形） */
  size: number;
  nodes: StarNodeCell[];
  lanes: StarLaneCell[];
}

/**
 * 外圈能放几个节点，决定网格多大。
 *
 * 5×5 的外圈是 16 格，足够 1 个地球 + 15 个节点；
 * 再多就换 7×7（外圈 24 格）。格子本身不值钱，画不下才是问题。
 */
function sizeFor(count: number): number {
  if (count <= 15) return 5;
  if (count <= 23) return 7;
  return 9;
}

/**
 * 布局。
 *
 * 没有星图（没开太空那类扩展、或这一局只有地球）时返回 null——
 * 调用方据此不画星图、也不给入口。
 */
/**
 * 布局。航程那一列是**火箭的**（固定回合），和谁在看无关——
 * 空间站自己航行的回合数是另一回事，显示在站的卡片上。
 */
export function starLayout(s: GameState): StarLayout | null {
  const map = peekStarmap(s);
  if (!map || map.nodes.length <= 1) return null;

  const others = map.nodes.filter((n) => n.id !== EARTH_NODE);
  const size = sizeFor(others.length);
  const mid = (size - 1) / 2;

  // 外圈格子，按"从右边开始顺时针"排序（角度 0 = 右，y 轴向下 = 顺时针）
  const ring: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === mid && y === mid) continue;
      if (x !== 0 && y !== 0 && x !== size - 1 && y !== size - 1) continue;
      ring.push({ x, y });
    }
  }
  // 归一到 [0, 2π)：否则 -π 排在最前，第一个节点会跑到左上角去
  const angle = (p: { x: number; y: number }): number => {
    const a = Math.atan2(p.y - mid, p.x - mid);
    return a < 0 ? a + Math.PI * 2 : a;
  };
  ring.sort((p, q) => angle(p) - angle(q));

  const cells: StarNodeCell[] = [];
  const earth = map.nodes.find((n) => n.id === EARTH_NODE);
  const stationCells = (id: StarNodeId): StarStationCell[] =>
    map.stations
      .filter((st) => st.at === id)
      .map((st) => ({
        board: st.board,
        owner: st.owner,
        ownerName: s.players[st.owner]?.name ?? st.owner,
        name: s.boards?.[st.board]?.name ?? st.board,
        ...(st.travel ? { travelTo: st.travel.to } : {}),
      }));

  if (earth) {
    cells.push({
      id: earth.id,
      name: earth.name,
      kind: earth.kind,
      ...(earth.board ? { board: earth.board } : {}),
      x: mid,
      y: mid,
      stations: stationCells(earth.id),
    });
  }

  /*
   * 外圈均分：第 i 个节点落在 `round(i * 环长 / n)` 上。
   *
   * 取整会撞格（n 接近环长时），所以撞了就顺延到下一个空格——
   * 宁可稍微不均，也不要两个星球叠在一格里。
   */
  const used = new Set<string>();
  others.forEach((node, i) => {
    const n = others.length;
    let at = n <= 1 ? 0 : Math.round((i * ring.length) / n) % ring.length;
    for (let k = 0; k < ring.length; k++) {
      const spot = ring[(at + k) % ring.length]!;
      const key = `${spot.x},${spot.y}`;
      if (used.has(key)) continue;
      used.add(key);
      cells.push({
        id: node.id,
        name: node.name,
        kind: node.kind,
        ...(node.board ? { board: node.board } : {}),
        x: spot.x,
        y: spot.y,
        stations: stationCells(node.id),
      });
      return;
    }
    // 环上真的没有空位了（节点数超过环长）：不画，比叠在一起好
  });

  const byId = new Map(cells.map((c) => [c.id, c]));
  const lanes: StarLaneCell[] = [];
  for (const l of map.lanes) {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (!a || !b) continue;
    lanes.push({ id: l.id, a, b, turns: laneTurnsFor(l) });
  }

  return { size, nodes: cells, lanes };
}

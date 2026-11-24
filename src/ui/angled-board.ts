import { cityTiles, isAirborne } from '../core/rules.ts';
import type { PlayerView } from '../core/fog.ts';
import type { City, GameState, Terrain, Unit } from '../core/types.ts';
import type { BoardUi } from './board.ts';

type Point = readonly [number, number];
interface Cell { x: number; y: number }
interface Face { cell: Cell; points: readonly Point[] }

const halfWidth = 19;
const halfHeight = 11.3;
const topPadding = 53;

export function angledBoardSize(cols: number, rows: number): { w: number; h: number } {
  return {
    w: Math.ceil((cols + rows) * halfWidth + 52),
    h: Math.ceil((cols + rows) * halfHeight + 94),
  };
}

function contains(points: readonly Point[], x: number, y: number): boolean {
  let above = false;
  let below = false;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    above ||= cross > 0.001;
    below ||= cross < -0.001;
    if (above && below) return false;
  }
  return true;
}

export function createAngledBoard(canvas: HTMLCanvasElement, assetBase: string) {
  if (typeof canvas.ownerDocument.defaultView?.CanvasRenderingContext2D !== 'function') return null;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const ctx = context;
  let scene = angledBoardSize(1, 1);
  let originX = 26 + halfWidth;
  let paintedState: GameState | null = null;
  let latest: { view: PlayerView; ui?: BoardUi } | undefined;
  let faces: Face[] = [];
  const project = (x: number, y: number, lift = 0): Point =>
    [originX + (x - y) * halfWidth, topPadding + (x + y) * halfHeight - lift];

  const boardFloor = -13;
  /*
   * 水面是**一个高度**（2026-11-23 用户指出）。
   *
   * 之前浅流 -4 / 水域 -9 / 深水 -10 —— 等于让水自己长成了台阶，河里凭空多出
   * 两道堤。真实的水只有一张水面，深浅差在**河床**上。所以：
   *   · 三种水面统一取 `WATER_SURFACE`，谁跟谁都齐平；
   *   · 深浅改由 `bedDepth` 表达——岸边那堵墙往下扎多深、水色多暗。
   * 这样水面上不会再有互相遮掩的立面，读数只看颜色和岸壁厚度。
   */
  /*
   * 2026-11-23 第二次调：水面**抬回来**。
   *
   * 第一次把三种水都压到 -9（原来是浅 -4 / 水 -9 / 深 -10），河是平了，
   * 但水岸对平原的落差从 4 格变成 9 格，看着像一条深沟。取 -3.5——
   * 比原来的浅流略低半格（避免"水比岸高"），和深水之间不再有台阶。
   */
  const WATER_SURFACE = -3.5;
  /** 深度分档：决定水体底床可视度、边缘剖面水层厚度与深浅过渡坡 */
  const bedDepth: Partial<Record<Terrain, number>> = { shallow: 1, water: 4, deep: 9 };
  const isWaterTerrain = (t: Terrain | undefined): boolean => t === 'water' || t === 'shallow' || t === 'deep';
  const heights: Partial<Record<Terrain, number>> = {
    deep: WATER_SURFACE, water: WATER_SURFACE, shallow: WATER_SURFACE,
    valley: -3, bridge: 2, hill: 8, plateau: 15, mountain: 25,
  };
  const colors: Partial<Record<Terrain, string>> = {
    plain: '#dce4c7', forest: '#a8bd86', hill: '#d6c08f', mountain: '#8694a3',
    water: '#8cb9d0', shallow: '#abd3c8', deep: '#4f7fa1', bridge: '#ba9a6d', city: '#c5cbb1',
    plateau: '#e2dfc1', valley: '#c3cfa6', marsh: '#a9b795', dune: '#e8d9a8',
    shadow: '#2b2140',
    void: '#262824', regolith: '#d8d4ca', crater: '#b6b1a7', deck: '#7c8592', wreck: '#4b413a',
  };

  type WaterBodyKind = 'river' | 'lake' | 'sea';
  interface WaterCellMeta {
    kind: WaterBodyKind;
    /** 流动/扩散/涌浪主方向（棋盘坐标系单位向量） */
    flowX: number;
    flowY: number;
    /** 到最近陆地的平滑距离（格） */
    distToLand: number;
    /** 湖泊距湖心的距离 / 河流沿程相位 / 海域波程辅助值 */
    phaseCoord: number;
    /** 邻接陆地掩码：bit0=N(y-1), bit1=E(x+1), bit2=S(y+1), bit3=W(x-1) */
    shoreMask: number;
  }
  interface WaterField {
    key: string;
    meta: Array<WaterCellMeta | null>;
  }
  interface AnimatedWaterCell {
    x: number;
    y: number;
    terrain: Terrain;
    dark: boolean;
    eastEdge: boolean;
    southEdge: boolean;
    meta: WaterCellMeta;
  }
  let cachedWaterField: WaterField | null = null;

  /**
   * 水体拓扑分析：将连通水面自动识别为「河 (river) / 湖 (lake) / 海 (sea)」，
   * 并为每格预计算平滑流向矢量（河流拉普拉斯势场梯度、湖泊中心径向、海域向岸涌浪法向）。
   */
  function analyzeWater(state: GameState): WaterField {
    const w = state.w;
    const h = state.h;
    const total = w * h;
    let sig = `${w}x${h}:`;
    const isWater = new Uint8Array(total);
    const isConn = new Uint8Array(total);
    const isLand = new Uint8Array(total);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = at(state, x, y);
        if (isWaterTerrain(t)) {
          isWater[i] = 1;
          isConn[i] = 1;
          sig += t === 'shallow' ? 's' : t === 'deep' ? 'D' : 'w';
        } else if (t === 'bridge') {
          isConn[i] = 1;
          sig += '=';
        } else {
          if (t && t !== 'void') isLand[i] = 1;
          sig += '.';
        }
      }
    }
    if (cachedWaterField && cachedWaterField.key === sig) return cachedWaterField;

    const meta: Array<WaterCellMeta | null> = new Array(total).fill(null);

    // 1. 多源 BFS 计算每格水体到最近陆地的距离
    const distLand = new Float32Array(total).fill(99);
    const queue = new Int32Array(total);
    let qHead = 0;
    let qTail = 0;
    for (let i = 0; i < total; i++) {
      if (isLand[i]) {
        distLand[i] = 0;
        queue[qTail++] = i;
      }
    }
    const dirs: ReadonlyArray<readonly [number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    while (qHead < qTail) {
      const cur = queue[qHead++]!;
      const cx = cur % w;
      const cy = (cur - cx) / w;
      const nextDist = distLand[cur]! + 1;
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (distLand[ni]! > nextDist) {
          distLand[ni] = nextDist;
          queue[qTail++] = ni;
        }
      }
    }

    // 2. 连通分量拆解（桥面桥接河道连通性，防止一座桥把整条河切成两个湖）
    const visited = new Uint8Array(total);
    const compId = new Int32Array(total).fill(-1);
    let nextComp = 0;
    for (let i = 0; i < total; i++) {
      if (!isConn[i] || visited[i]) continue;
      const cid = nextComp++;
      const nodes: number[] = [];
      let head = 0;
      visited[i] = 1;
      compId[i] = cid;
      nodes.push(i);
      let waterCount = 0;
      let deepCount = 0;
      let edgeSides = 0;
      let edgeCount = 0;
      let maxDist = 0;
      let sumDist = 0;
      let minX = w;
      let maxX = 0;
      let minY = h;
      let maxY = 0;
      const borderNodes: number[] = [];

      while (head < nodes.length) {
        const cur = nodes[head++]!;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const onEdge = cx === 0 || cx === w - 1 || cy === 0 || cy === h - 1;
        if (onEdge) {
          borderNodes.push(cur);
          edgeCount++;
          if (cy === 0) edgeSides |= 1;
          if (cx === w - 1) edgeSides |= 2;
          if (cy === h - 1) edgeSides |= 4;
          if (cx === 0) edgeSides |= 8;
        }
        if (isWater[cur]) {
          waterCount++;
          if (at(state, cx, cy) === 'deep') deepCount++;
          const d = distLand[cur]!;
          if (d > maxDist) maxDist = d;
          sumDist += d;
        }
        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (isConn[ni] && !visited[ni]) {
            visited[ni] = 1;
            compId[ni] = cid;
            nodes.push(ni);
          }
        }
      }
      if (waterCount === 0) continue;

      const avgDist = sumDist / waterCount;
      const spanX = maxX - minX + 1;
      const spanY = maxY - minY + 1;
      const majorSpan = Math.max(spanX, spanY);
      const minorSpan = Math.min(spanX, spanY);
      const edgeSideCount =
        ((edgeSides & 1) ? 1 : 0) +
        ((edgeSides & 2) ? 1 : 0) +
        ((edgeSides & 4) ? 1 : 0) +
        ((edgeSides & 8) ? 1 : 0);

      // 3. 判定水体类型：湖 / 河 / 海
      let kind: WaterBodyKind;
      if (edgeCount === 0) {
        // 完全被陆地环抱的内陆水体：除非是极大深水内海，否则归为湖泊
        kind = deepCount >= 22 && maxDist >= 4 && waterCount >= 80 ? 'sea' : 'lake';
      } else {
        // 接触地图边界的水体：区分「狭长水道（河）」与「开阔海域（海）」
        const estWidth = Math.max(1, avgDist * 2);
        const elongation = majorSpan / estWidth;
        const isNarrowChannel =
          (maxDist <= 2 && avgDist <= 1.65 && deepCount <= waterCount * 0.25) ||
          (maxDist <= 3 && avgDist <= 1.95 && elongation >= 2.55 && edgeCount <= Math.max(10, majorSpan * 0.65));
        const looksLikeStraitRiver =
          edgeSideCount >= 2 && maxDist <= 3 && avgDist <= 1.9 && minorSpan <= Math.max(8, majorSpan * 0.55);
        kind = (isNarrowChannel || looksLikeStraitRiver) ? 'river' : 'sea';
      }

      // 4. 按水体类型构建逐格平滑场
      if (kind === 'river') {
        // 把边界格聚成独立出入口段，选最靠近西北/上方的一段作为上游源头
        const bVis = new Set<number>();
        const segments: number[][] = [];
        const bSet = new Set(borderNodes);
        for (const bn of borderNodes) {
          if (bVis.has(bn)) continue;
          const seg: number[] = [];
          const st = [bn];
          bVis.add(bn);
          while (st.length) {
            const u = st.pop()!;
            seg.push(u);
            const ux = u % w;
            const uy = (u - ux) / w;
            for (const [dx, dy] of dirs) {
              const ni = (uy + dy) * w + (ux + dx);
              if (ux + dx >= 0 && ux + dx < w && uy + dy >= 0 && uy + dy < h && bSet.has(ni) && !bVis.has(ni)) {
                bVis.add(ni);
                st.push(ni);
              }
            }
          }
          segments.push(seg);
        }

        const avgIso = (seg: number[]): number => {
          let sum = 0;
          for (const idx of seg) sum += (idx % w) + ((idx - (idx % w)) / w);
          return sum / seg.length;
        };
        segments.sort((a, b) => avgIso(a) - avgIso(b));

        const bfsDist = (seeds: number[]): Float32Array => {
          const d = new Float32Array(total).fill(-1);
          const q: number[] = [];
          for (const s of seeds) {
            d[s] = 0;
            q.push(s);
          }
          let qh = 0;
          while (qh < q.length) {
            const cur = q[qh++]!;
            const cx = cur % w;
            const cy = (cur - cx) / w;
            const nd = d[cur]! + 1;
            for (const [dx, dy] of dirs) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              const ni = ny * w + nx;
              if (compId[ni] === cid && d[ni]! < 0) {
                d[ni] = nd;
                q.push(ni);
              }
            }
          }
          return d;
        };

        let sourceSeeds: number[];
        let sinkSeeds: number[];
        if (segments.length >= 2) {
          sourceSeeds = segments[0]!;
          sinkSeeds = segments[segments.length - 1]!;
        } else if (segments.length === 1) {
          const dEdge = bfsDist(segments[0]!);
          let farDist = -1;
          for (const idx of nodes) if (dEdge[idx]! > farDist) farDist = dEdge[idx]!;
          const farNodes = nodes.filter((idx) => dEdge[idx]! >= farDist - 1);
          if (avgIso(farNodes) < avgIso(segments[0]!)) {
            sourceSeeds = farNodes;
            sinkSeeds = segments[0]!;
          } else {
            sourceSeeds = segments[0]!;
            sinkSeeds = farNodes;
          }
        } else {
          let bestMin = Infinity;
          let bestMax = -Infinity;
          let src = nodes[0]!;
          let snk = nodes[0]!;
          for (const idx of nodes) {
            const v = (idx % w) + ((idx - (idx % w)) / w);
            if (v < bestMin) { bestMin = v; src = idx; }
            if (v > bestMax) { bestMax = v; snk = idx; }
          }
          sourceSeeds = [src];
          sinkSeeds = [snk];
        }

        const dSrc = bfsDist(sourceSeeds);
        const dSnk = bfsDist(sinkSeeds);
        const phi = new Float32Array(total);
        const fixed = new Uint8Array(total);
        for (const s of sourceSeeds) fixed[s] = 1;
        for (const s of sinkSeeds) fixed[s] = 2;
        for (const idx of nodes) {
          const a = Math.max(0, dSrc[idx]!);
          const b = Math.max(0, dSnk[idx]!);
          phi[idx] = a + b > 0 ? (a / (a + b)) * majorSpan : 0;
        }
        // 拉普拉斯松弛 6 轮，使河道弯道、分汊与桥洞处的流速势场完全顺滑
        const tmpPhi = new Float32Array(total);
        for (let iter = 0; iter < 6; iter++) {
          for (const idx of nodes) {
            if (fixed[idx]) {
              tmpPhi[idx] = phi[idx]!;
              continue;
            }
            const cx = idx % w;
            const cy = (idx - cx) / w;
            let sum = phi[idx]! * 0.5;
            let cnt = 0.5;
            for (const [dx, dy] of dirs) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              const ni = ny * w + nx;
              if (compId[ni] === cid) {
                sum += phi[ni]!;
                cnt += 1;
              }
            }
            tmpPhi[idx] = sum / cnt;
          }
          for (const idx of nodes) phi[idx] = tmpPhi[idx]!;
        }

        for (const idx of nodes) {
          if (!isWater[idx]) continue;
          const cx = idx % w;
          const cy = (idx - cx) / w;
          const pHere = phi[idx]!;
          const pE = cx + 1 < w && compId[idx + 1] === cid ? phi[idx + 1]! : pHere;
          const pW = cx - 1 >= 0 && compId[idx - 1] === cid ? phi[idx - 1]! : pHere;
          const pS = cy + 1 < h && compId[idx + w] === cid ? phi[idx + w]! : pHere;
          const pN = cy - 1 >= 0 && compId[idx - w] === cid ? phi[idx - w]! : pHere;
          let gx = pE - pW;
          let gy = pS - pN;
          const len = Math.hypot(gx, gy);
          if (len > 0.001) {
            gx /= len;
            gy /= len;
          } else {
            gx = 0;
            gy = 1;
          }
          let shoreMask = 0;
          if (cy > 0 && isLand[idx - w]) shoreMask |= 1;
          if (cx + 1 < w && isLand[idx + 1]) shoreMask |= 2;
          if (cy + 1 < h && isLand[idx + w]) shoreMask |= 4;
          if (cx > 0 && isLand[idx - 1]) shoreMask |= 8;
          meta[idx] = {
            kind: 'river',
            flowX: gx,
            flowY: gy,
            distToLand: distLand[idx]!,
            phaseCoord: pHere,
            shoreMask,
          };
        }
      } else if (kind === 'lake') {
        // 计算湖泊深水加权中心，用于安静的同心涟漪扩散
        let wSum = 0;
        let centerX = 0;
        let centerY = 0;
        for (const idx of nodes) {
          if (!isWater[idx]) continue;
          const cx = idx % w;
          const cy = (idx - cx) / w;
          const t = at(state, cx, cy);
          const weight = distLand[idx]! * (t === 'deep' ? 2.6 : t === 'water' ? 1.4 : 0.6);
          centerX += (cx + 0.5) * weight;
          centerY += (cy + 0.5) * weight;
          wSum += weight;
        }
        if (wSum > 0) {
          centerX /= wSum;
          centerY /= wSum;
        }
        for (const idx of nodes) {
          if (!isWater[idx]) continue;
          const cx = idx % w;
          const cy = (idx - cx) / w;
          const rx = cx + 0.5 - centerX;
          const ry = cy + 0.5 - centerY;
          const r = Math.hypot(rx, ry);
          let shoreMask = 0;
          if (cy > 0 && isLand[idx - w]) shoreMask |= 1;
          if (cx + 1 < w && isLand[idx + 1]) shoreMask |= 2;
          if (cy + 1 < h && isLand[idx + w]) shoreMask |= 4;
          if (cx > 0 && isLand[idx - 1]) shoreMask |= 8;
          meta[idx] = {
            kind: 'lake',
            flowX: r > 0.05 ? rx / r : 0.707,
            flowY: r > 0.05 ? ry / r : 0.707,
            distToLand: distLand[idx]!,
            phaseCoord: r,
            shoreMask,
          };
        }
      } else {
        // 海域：计算平滑的向岸涌浪方向（近岸顺海岸折向拍岸，外海保持统一斜向涌浪）
        const smDist = new Float32Array(total);
        for (const idx of nodes) smDist[idx] = distLand[idx]!;
        const tmpD = new Float32Array(total);
        for (let iter = 0; iter < 4; iter++) {
          for (const idx of nodes) {
            const cx = idx % w;
            const cy = (idx - cx) / w;
            let sum = smDist[idx]!;
            let cnt = 1;
            for (const [dx, dy] of dirs) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              const ni = ny * w + nx;
              if (compId[ni] === cid) {
                sum += smDist[ni]!;
                cnt += 1;
              } else if (isLand[ni]) {
                cnt += 1; // 陆地距离为 0
              }
            }
            tmpD[idx] = sum / cnt;
          }
          for (const idx of nodes) smDist[idx] = tmpD[idx]!;
        }

        // 外海主涌浪基准方向（自东南外海向西北近岸推进，顺应斜俯视光影）
        const baseSwellX = -0.76;
        const baseSwellY = -0.65;
        for (const idx of nodes) {
          if (!isWater[idx]) continue;
          const cx = idx % w;
          const cy = (idx - cx) / w;
          const dHere = smDist[idx]!;
          const dE = cx + 1 < w ? (compId[idx + 1] === cid ? smDist[idx + 1]! : isLand[idx + 1] ? 0 : dHere) : dHere;
          const dW = cx - 1 >= 0 ? (compId[idx - 1] === cid ? smDist[idx - 1]! : isLand[idx - 1] ? 0 : dHere) : dHere;
          const dS = cy + 1 < h ? (compId[idx + w] === cid ? smDist[idx + w]! : isLand[idx + w] ? 0 : dHere) : dHere;
          const dN = cy - 1 >= 0 ? (compId[idx - w] === cid ? smDist[idx - w]! : isLand[idx - w] ? 0 : dHere) : dHere;
          // 负梯度指向陆地方向（涌浪拍向海岸）
          const nx = dW - dE;
          const ny = dN - dS;
          const nLen = Math.hypot(nx, ny);
          const shoreWeight = Math.max(0, Math.min(0.68, 1.1 - dHere * 0.22));
          let fx = baseSwellX * (1 - shoreWeight) + (nLen > 0.01 ? (nx / nLen) * shoreWeight : baseSwellX * shoreWeight);
          let fy = baseSwellY * (1 - shoreWeight) + (nLen > 0.01 ? (ny / nLen) * shoreWeight : baseSwellY * shoreWeight);
          const fLen = Math.hypot(fx, fy) || 1;
          fx /= fLen;
          fy /= fLen;
          let shoreMask = 0;
          if (cy > 0 && isLand[idx - w]) shoreMask |= 1;
          if (cx + 1 < w && isLand[idx + 1]) shoreMask |= 2;
          if (cy + 1 < h && isLand[idx + w]) shoreMask |= 4;
          if (cx > 0 && isLand[idx - 1]) shoreMask |= 8;
          meta[idx] = {
            kind: 'sea',
            flowX: fx,
            flowY: fy,
            distToLand: dHere,
            phaseCoord: cx * baseSwellX + cy * baseSwellY,
            shoreMask,
          };
        }
      }
    }

    cachedWaterField = { key: sig, meta };
    return cachedWaterField;
  }

  function tileHash(x: number, y: number, salt = 0): number {
    let h = Math.imul(x + 37, 0x9e3779b1) ^ Math.imul(y + 73, 0x85ebca6b) ^ Math.imul(salt + 19, 0xc2b2ae35);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return h >>> 0;
  }

  function polygon(ctx: CanvasRenderingContext2D, points: readonly Point[], fill: string, edge?: string, lineWidth = 0.85): void {
    ctx.beginPath();
    ctx.moveTo(...points[0]!);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  function strokeLine(ctx: CanvasRenderingContext2D, a: Point, b: Point, color: string, width = 1): void {
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function rhombus(x: number, y: number, width: number, lift: number): Point[] {
    return [project(x, y, lift), project(x + width, y, lift), project(x + width, y + width, lift), project(x, y + width, lift)];
  }

  function at(state: GameState, x: number, y: number): Terrain | undefined {
    if (x >= 0 && x < state.w && y >= 0 && y < state.h) return state.tiles[y * state.w + x]?.terrain;
  }

  function heightAt(state: GameState, x: number, y: number): number {
    const terrain = at(state, x, y);
    if (!terrain) return boardFloor;
    return heights[terrain] ?? 0;
  }

  function faceColors(terrain: Terrain, neighbor: Terrain | undefined): readonly [string, string, string] {
    if (!neighbor) return ['#695c4d', '#81745e', '#534638'];
    if (terrain === 'mountain') return ['#586675', '#6e7d8d', '#3e4854'];
    if (terrain === 'hill') return ['#9e8052', '#b69968', '#6f5735'];
    if (terrain === 'shallow' && neighbor === 'water') return ['#749cab', '#86abb4', '#658999'];
    if ((terrain === 'plain' || terrain === 'forest') && isWaterTerrain(neighbor)) {
      return ['#768264', '#919d7b', '#636f54'];
    }
    return ['#a28357', '#b49a69', '#7b643d'];
  }

  /**
   * 侧面岩层与土层剖面：参照《陷阵之志》沙盘块的层理结构，
   * 让平原草皮、丘陵砂岩、高山断崖在立面上各自有清晰的地质层次。
   */
  function paintCliffFace(
    ctx: CanvasRenderingContext2D,
    terrain: Terrain,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    topZ: number,
    botZ: number,
    side: 'east' | 'south',
    neighbor: Terrain | undefined,
    dark: boolean,
  ): Point[] {
    const [eastFill, southFill, edge] = faceColors(terrain, neighbor);
    const baseFill = side === 'east' ? eastFill : southFill;
    const points: Point[] = [
      project(x0, y0, topZ),
      project(x1, y1, topZ),
      project(x1, y1, botZ),
      project(x0, y0, botZ),
    ];
    polygon(ctx, points, baseFill, edge);

    const drop = topZ - botZ;
    if (drop <= 1.5) {
      if (dark) polygon(ctx, points, '#17232b47');
      return points;
    }

    if (terrain === 'plain' || terrain === 'forest') {
      // 草甸/林地剖面：上层草皮覆顶 + 下层沃土
      const turfZ = Math.max(botZ, topZ - Math.min(2.2, drop * 0.36));
      const turfColor = terrain === 'forest'
        ? (side === 'east' ? '#637a4b' : '#78915d')
        : (side === 'east' ? '#7b8d5f' : '#92a573');
      polygon(ctx, [
        project(x0, y0, topZ),
        project(x1, y1, topZ),
        project(x1, y1, turfZ),
        project(x0, y0, turfZ),
      ], turfColor);
    } else if (terrain === 'hill') {
      // 丘陵层岩剖面：上层暖砂岩 + 中层黄土 + 底部压暗基座
      const upperZ = botZ + drop * 0.62;
      const footZ = botZ + drop * 0.24;
      polygon(ctx, [
        project(x0, y0, topZ),
        project(x1, y1, topZ),
        project(x1, y1, upperZ),
        project(x0, y0, upperZ),
      ], side === 'east' ? '#ad8f5f' : '#c5a977');
      polygon(ctx, [
        project(x0, y0, footZ),
        project(x1, y1, footZ),
        project(x1, y1, botZ),
        project(x0, y0, botZ),
      ], side === 'east' ? '#7e643d' : '#93774c');
      strokeLine(ctx, project(x0, y0, upperZ), project(x1, y1, upperZ), '#6e563455', 0.75);
    } else if (terrain === 'mountain') {
      // 高山断崖剖面：三层页岩/花岗岩色带 + 纵向节理裂隙
      const upperZ = botZ + drop * 0.68;
      const lowerZ = botZ + drop * 0.26;
      polygon(ctx, [
        project(x0, y0, topZ),
        project(x1, y1, topZ),
        project(x1, y1, upperZ),
        project(x0, y0, upperZ),
      ], side === 'east' ? '#697888' : '#8090a0');
      polygon(ctx, [
        project(x0, y0, lowerZ),
        project(x1, y1, lowerZ),
        project(x1, y1, botZ),
        project(x0, y0, botZ),
      ], side === 'east' ? '#45515e' : '#556271');
      strokeLine(ctx, project(x0, y0, upperZ), project(x1, y1, upperZ), '#39434f66', 0.8);
      const mx0 = x0 + (x1 - x0) * 0.36;
      const my0 = y0 + (y1 - y0) * 0.36;
      const mx1 = x0 + (x1 - x0) * 0.52;
      const my1 = y0 + (y1 - y0) * 0.52;
      strokeLine(ctx, project(mx0, my0, topZ - 1), project(mx1, my1, botZ + 2), '#37414c77', 0.85);
    } else if (terrain === 'bridge') {
      // 木桥侧面：上层木梁 + 下方双木桩桥墩与桥下暗影
      const beamZ = Math.max(botZ, topZ - 1.7);
      polygon(ctx, [
        project(x0, y0, topZ),
        project(x1, y1, topZ),
        project(x1, y1, beamZ),
        project(x0, y0, beamZ),
      ], side === 'east' ? '#8c693e' : '#a78251');
      polygon(ctx, [
        project(x0, y0, beamZ),
        project(x1, y1, beamZ),
        project(x1, y1, botZ),
        project(x0, y0, botZ),
      ], isWaterTerrain(neighbor) ? '#3c5e74aa' : '#5b452a');
      // 两根木桩桥墩
      for (const f of [0.22, 0.78]) {
        const px0 = x0 + (x1 - x0) * (f - 0.08);
        const py0 = y0 + (y1 - y0) * (f - 0.08);
        const px1 = x0 + (x1 - x0) * (f + 0.08);
        const py1 = y0 + (y1 - y0) * (f + 0.08);
        polygon(ctx, [
          project(px0, py0, beamZ),
          project(px1, py1, beamZ),
          project(px1, py1, botZ),
          project(px0, py0, botZ),
        ], side === 'east' ? '#6d502e' : '#85643c');
      }
    }

    // 重描外框确保折线干脆
    ctx.beginPath();
    ctx.moveTo(...points[0]!);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.closePath();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.85;
    ctx.stroke();

    if (dark) polygon(ctx, points, '#17232b47');
    return points;
  }

  /**
   * 平原建模（《陷阵之志》微缩沙盘风格 · 多样化草甸细节）：
   * 干净透气的主色调草甸底板 + 柔和浅草/三叶草斑块 + 6 种不同形态的低矮草甸图案
   * （高低伴生双草簇、微风斜拂长草、野花草簇、趴地苔草丛、青苔卧石伴生草、双叶幼芽）。
   * 严格控制草簇高度（2.8~4.6px），在丰富视觉细节的同时绝不遮挡棋子。
   */
  function paintPlainArt(ctx: CanvasRenderingContext2D, x: number, y: number, elevation: number, state: GameState): void {
    const h = tileHash(x, y, 11);
    const pt = (u: number, v: number, dz = 0): Point => project(x + u, y + v, elevation + dz);
    const tonePalette = ['#dce4c7', '#d9e2c3', '#dfe7cb'] as const;
    const baseTone = tonePalette[(x * 3 + y * 5 + (h & 1)) % 3]!;
    polygon(ctx, rhombus(x, y, 1, elevation), baseTone, '#34422a22');

    // 临水或临低谷的西北/东北岸缘亮边
    if (heightAt(state, x - 1, y) < elevation) {
      strokeLine(ctx, pt(0, 1, 0), pt(0, 0, 0), '#ebf2d8', 1.1);
    }
    if (heightAt(state, x, y - 1) < elevation) {
      strokeLine(ctx, pt(0, 0, 0), pt(1, 0, 0), '#e7efd3', 1.0);
    }

    // 约 55% 的地块带贴地草皮微斑块（单菱斑或双叶草斑），增加草甸地表的肌理层次
    if ((h % 9) < 5) {
      const cu = 0.32 + ((h >>> 4) % 32) * 0.01;
      const cv = 0.32 + ((h >>> 9) % 32) * 0.01;
      const r = 0.16 + ((h >>> 14) % 8) * 0.01;
      polygon(ctx, [
        pt(cu - r, cv, 0),
        pt(cu, cv - r, 0),
        pt(cu + r, cv, 0),
        pt(cu, cv + r, 0),
      ], (h & 4) ? '#d1dcb8' : '#e4ebd0');
      if ((h % 9) === 1 || (h % 9) === 3) {
        const cu2 = Math.min(0.76, cu + 0.16);
        const cv2 = Math.min(0.76, cv + 0.12);
        const r2 = r * 0.65;
        polygon(ctx, [
          pt(cu2 - r2, cv2, 0),
          pt(cu2, cv2 - r2, 0),
          pt(cu2 + r2, cv2, 0),
          pt(cu2, cv2 + r2, 0),
        ], '#c9d6ae');
      }
    }

    // 6 种不同形态的草甸地表图案（约占 2/3 地块，其余 1/3 留白保持战术棋盘透气感）
    const tuftMod = h % 12;
    const u = 0.28 + ((h >>> 6) % 40) * 0.01;
    const v = 0.30 + ((h >>> 11) % 38) * 0.01;
    const [cx, cy] = pt(u, v, 0);

    if (tuftMod === 0 || tuftMod === 1) {
      // 图案 A：高低双簇伴生草（主三叶草簇 + 侧旁小幼簇）
      polygon(ctx, [
        [cx - 3.8, cy + 0.6],
        [cx + 0.4, cy - 0.8],
        [cx + 5.8, cy + 1.2],
        [cx + 1.2, cy + 2.2],
      ], '#a6b78a88');
      // 主簇
      polygon(ctx, [[cx - 1.3, cy + 0.8], [cx - 0.4, cy - 4.5], [cx + 0.5, cy + 0.9]], '#90a86c');
      polygon(ctx, [[cx - 0.4, cy - 4.5], [cx + 0.9, cy + 0.8], [cx + 0.1, cy + 0.9]], '#6d844e');
      polygon(ctx, [[cx - 3.4, cy + 0.7], [cx - 2.4, cy - 3.0], [cx - 1.0, cy + 0.8]], '#a1b87c');
      polygon(ctx, [[cx + 0.5, cy + 0.8], [cx + 2.6, cy - 3.3], [cx + 3.3, cy + 0.7]], '#677e49');
      // 伴生副簇
      const sx = cx + 4.2;
      const sy = cy + 1.3;
      polygon(ctx, [[sx - 1.4, sy + 0.4], [sx - 0.6, sy - 2.6], [sx + 0.3, sy + 0.5]], '#9cb477');
      polygon(ctx, [[sx + 0.1, sy + 0.5], [sx + 1.5, sy - 2.2], [sx + 2.1, sy + 0.4]], '#728952');
    } else if (tuftMod === 2 || tuftMod === 3) {
      // 图案 B：微风斜拂长草簇（四叶顺风斜倾，富有动态韵律）
      polygon(ctx, [
        [cx - 3.6, cy + 0.7],
        [cx + 1.0, cy - 0.7],
        [cx + 5.2, cy + 0.8],
        [cx + 0.6, cy + 1.9],
      ], '#a4b58888');
      polygon(ctx, [[cx - 3.2, cy + 0.7], [cx - 1.1, cy - 3.2], [cx - 1.4, cy + 0.8]], '#a3ba7e');
      polygon(ctx, [[cx - 1.5, cy + 0.8], [cx + 1.1, cy - 4.4], [cx + 0.2, cy + 0.9]], '#8fa76b');
      polygon(ctx, [[cx + 1.1, cy - 4.4], [cx + 1.6, cy - 3.8], [cx + 0.5, cy + 0.9]], '#6d844e');
      polygon(ctx, [[cx + 0.3, cy + 0.8], [cx + 3.1, cy - 3.6], [cx + 2.1, cy + 0.8]], '#7b9358');
      polygon(ctx, [[cx + 1.9, cy + 0.7], [cx + 4.6, cy - 2.5], [cx + 3.8, cy + 0.7]], '#647b46');
    } else if (tuftMod === 4) {
      // 图案 C：草甸野花簇（阔叶草座 + 两三朵奶油黄小雏菊点缀）
      polygon(ctx, [
        [cx - 3.8, cy + 0.6],
        [cx + 0.2, cy - 0.9],
        [cx + 4.2, cy + 0.7],
        [cx + 0.2, cy + 1.9],
      ], '#a3b48788');
      polygon(ctx, [[cx - 3.4, cy + 0.7], [cx - 2.3, cy - 2.8], [cx - 0.8, cy + 0.8]], '#96ae72');
      polygon(ctx, [[cx - 1.1, cy + 0.8], [cx - 0.1, cy - 4.0], [cx + 1.0, cy + 0.8]], '#829a5e');
      polygon(ctx, [[cx + 0.7, cy + 0.8], [cx + 2.8, cy - 2.9], [cx + 3.5, cy + 0.7]], '#677e49');
      // 野花花蕾（柔和暖白与鹅黄，不刺眼）
      polygon(ctx, [[cx - 2.2, cy - 2.9], [cx - 1.4, cy - 3.7], [cx - 0.6, cy - 2.9], [cx - 1.4, cy - 2.1]], '#f6eed5');
      polygon(ctx, [[cx + 1.4, cy - 2.4], [cx + 2.1, cy - 3.1], [cx + 2.8, cy - 2.4], [cx + 2.1, cy - 1.7]], '#ebd48e');
    } else if (tuftMod === 5) {
      // 图案 D：低矮趴地苔草团（饱满的多面体小草垫 + 侧叶）
      polygon(ctx, [
        [cx - 4.2, cy + 0.7],
        [cx + 0.2, cy - 1.0],
        [cx + 4.6, cy + 0.8],
        [cx + 0.3, cy + 2.0],
      ], '#a1b28588');
      // 左侧迎光草团面
      polygon(ctx, [
        [cx - 3.6, cy + 0.6],
        [cx - 2.2, cy - 2.3],
        [cx + 0.2, cy - 2.9],
        [cx + 0.3, cy + 1.1],
      ], '#9bb277');
      // 右侧背光草团面
      polygon(ctx, [
        [cx + 0.2, cy - 2.9],
        [cx + 2.6, cy - 2.0],
        [cx + 3.8, cy + 0.6],
        [cx + 0.3, cy + 1.1],
      ], '#6c834d');
      // 顶部抽出的细草尖
      polygon(ctx, [[cx - 0.8, cy - 2.2], [cx - 0.1, cy - 4.3], [cx + 0.6, cy - 2.1]], '#88a064');
    } else if (tuftMod === 6) {
      // 图案 E：青苔卧石伴生草（三面立体田间石 + 石畔新芽）
      const [sx, sy] = pt(u, v, 0);
      polygon(ctx, [[sx - 3.2, sy + 0.5], [sx - 1.2, sy - 1.8], [sx + 0.8, sy - 1.4], [sx + 0.2, sy + 1.0]], '#cfd5bd');
      polygon(ctx, [[sx + 0.8, sy - 1.4], [sx + 2.8, sy + 0.2], [sx + 0.2, sy + 1.0]], '#9aa387');
      // 石旁伴生双叶草
      polygon(ctx, [[sx + 1.2, sy + 0.8], [sx + 2.2, sy - 2.8], [sx + 2.9, sy + 0.8]], '#94ac70');
      polygon(ctx, [[sx + 2.5, sy + 0.8], [sx + 4.1, sy - 2.1], [sx + 4.5, sy + 0.7]], '#6c834d');
    } else if (tuftMod === 7) {
      // 图案 F：疏朗对生双幼芽（相隔少许的两株V字嫩草，丰富轻盈层次）
      polygon(ctx, [[cx - 2.8, cy + 0.5], [cx - 3.6, cy - 2.2], [cx - 1.8, cy + 0.6]], '#9cb378');
      polygon(ctx, [[cx - 2.0, cy + 0.6], [cx - 0.8, cy - 2.5], [cx - 1.1, cy + 0.6]], '#728952');
      const bx = cx + 3.4;
      const by = cy - 1.1;
      polygon(ctx, [[bx - 1.2, by + 0.5], [bx - 1.8, by - 2.0], [bx - 0.3, by + 0.6]], '#9eb57a');
      polygon(ctx, [[bx - 0.5, by + 0.6], [bx + 0.7, by - 2.1], [bx + 0.3, by + 0.6]], '#738a53');
    }
  }

  /**
   * 丘陵高地灌木丛模型（《陷阵之志》式低多边形双球冠灌木）：
   * 采用与暖金丘陵协调的橄榄绿/苔绿三色阶块面，包含落地暖影、主灌木冠与伴生副灌木球，
   * 高度介于平原小草与森林乔木之间（约 5~6.5px），一眼可辨是丘陵矮灌木而非森林松树。
   */
  function drawHighlandShrub(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale = 1, variant = 0): void {
    const s = scale;
    // 1. 贴地暖褐投影
    ctx.fillStyle = '#7a5f3644';
    ctx.beginPath();
    ctx.ellipse(cx + 1.0 * s, cy + 0.8 * s, 5.2 * s, 2.3 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. 后侧或侧翼伴生小灌木球（先画后层）
    const sideDir = (variant & 1) === 0 ? 1 : -1;
    const sx = cx + sideDir * 3.1 * s;
    const sy = cy + 0.4 * s;
    polygon(ctx, [
      [sx - 2.6 * s, sy + 0.4 * s],
      [sx - 1.7 * s, sy - 2.6 * s],
      [sx + 0.2 * s, sy - 3.3 * s],
      [sx + 0.3 * s, sy + 0.9 * s],
    ], '#8ea560');
    polygon(ctx, [
      [sx + 0.2 * s, sy - 3.3 * s],
      [sx + 2.1 * s, sy - 2.3 * s],
      [sx + 2.8 * s, sy + 0.4 * s],
      [sx + 0.3 * s, sy + 0.9 * s],
    ], '#5b7039');

    // 3. 主灌木冠（五面体块面：西北亮冠 + 顶面亮オリーブ + 西南中调面 + 东南暗部 + 根部小枝干）
    polygon(ctx, [
      [cx - 0.7 * s, cy + 1.1 * s],
      [cx - 0.4 * s, cy - 0.8 * s],
      [cx + 0.6 * s, cy - 0.8 * s],
      [cx + 0.7 * s, cy + 1.1 * s],
    ], '#6e5233');
    // 迎光左上冠面
    polygon(ctx, [
      [cx - 3.8 * s, cy + 0.3 * s],
      [cx - 2.7 * s, cy - 3.5 * s],
      [cx - 0.2 * s, cy - 4.9 * s],
      [cx - 0.4 * s, cy - 1.2 * s],
    ], '#9cb36c');
    // 正前左中调受光面
    polygon(ctx, [
      [cx - 3.8 * s, cy + 0.3 * s],
      [cx - 0.4 * s, cy - 1.2 * s],
      [cx + 0.2 * s, cy + 1.0 * s],
      [cx - 2.1 * s, cy + 0.9 * s],
    ], '#7f9653');
    // 顶部与右前过渡冠面
    polygon(ctx, [
      [cx - 0.2 * s, cy - 4.9 * s],
      [cx + 2.2 * s, cy - 3.8 * s],
      [cx + 1.1 * s, cy - 1.0 * s],
      [cx - 0.4 * s, cy - 1.2 * s],
    ], '#879f5a');
    // 东南背光暗面
    polygon(ctx, [
      [cx + 2.2 * s, cy - 3.8 * s],
      [cx + 3.7 * s, cy + 0.2 * s],
      [cx + 2.1 * s, cy + 0.9 * s],
      [cx + 0.2 * s, cy + 1.0 * s],
      [cx + 1.1 * s, cy - 1.0 * s],
    ], '#576b36');

    // 冠顶微亮折棱
    strokeLine(ctx, [cx - 2.7 * s, cy - 3.5 * s], [cx - 0.2 * s, cy - 4.9 * s], '#b3c98399', 0.75);
  }

  /**
   * 丘陵建模（《陷阵之志》连绵高地台原、缓坡山脊与高地灌木点缀）：
   * 顶面保持开阔连贯的暖金砂岩台原 + 迎光外沿亮脊线，
   * 内腹自然交织布置低反差缓坡山脊、立体高地矮灌木丛与旱地草石，富有生机且不挡棋子。
   */
  function paintHillArt(ctx: CanvasRenderingContext2D, x: number, y: number, elevation: number, state: GameState): void {
    const h = tileHash(x, y, 23);
    const pt = (u: number, v: number, dz = 0): Point => project(x + u, y + v, elevation + dz);

    // 1. 连贯的高地台面底色（极柔和的跨格暖色过渡 + 淡雅战术格线）
    const wave = Math.sin(x * 0.7 + y * 0.5) + Math.cos(x * 0.4 - y * 0.6);
    const baseFill = wave > 0.55 ? '#dac494' : wave < -0.55 ? '#d3bd8c' : '#d6c08f';
    polygon(ctx, rhombus(x, y, 1, elevation), baseFill, '#6d56321c');

    // 2. 高地外缘迎光亮脊线（仅在西北/东北临低地的外沿提亮 1px 棱线，绝不切割台面内部）
    if (heightAt(state, x - 1, y) < elevation) {
      strokeLine(ctx, pt(0, 1, 0), pt(0, 0, 0), '#eee1bf', 1.25);
    }
    if (heightAt(state, x, y - 1) < elevation) {
      strokeLine(ctx, pt(0, 0, 0), pt(1, 0, 0), '#e9dab5', 1.15);
    }

    // 若该格是城市地基，则保持台面平整
    if (state.cities.some((c) => x >= c.x && x < c.x + c.size && y >= c.y && y < c.y + c.size)) {
      return;
    }

    // 3. 丘陵台面内腹：缓坡山脊、高地灌木丛、坡脚伴生灌木与旱草簇有机组合
    const mode = h % 7;
    if (mode === 0 || mode === 1) {
      // 舒展的低反差缓坡山脊
      const shiftU = mode === 0 ? -0.03 : 0.04;
      const shiftV = mode === 0 ? 0.02 : -0.03;
      const w = pt(0.14 + shiftU, 0.58 + shiftV, 0);
      const nw = pt(0.28 + shiftU, 0.24 + shiftV, 0);
      const n = pt(0.64 + shiftU, 0.16 + shiftV, 0);
      const e = pt(0.86 + shiftU, 0.44 + shiftV, 0);
      const s = pt(0.52 + shiftU, 0.82 + shiftV, 0);
      const c1 = pt(0.38 + shiftU, 0.50 + shiftV, 2.4);
      const c2 = pt(0.58 + shiftU, 0.36 + shiftV, 2.6);
      polygon(ctx, [w, nw, c2, c1], '#e6d5ab');
      polygon(ctx, [nw, n, c2], '#e0cda1');
      polygon(ctx, [w, c1, s], '#cfb786');
      polygon(ctx, [c1, c2, e, s], '#c2a775');
      polygon(ctx, [n, e, c2], '#bc9f6e');
      strokeLine(ctx, c1, c2, '#efe2bf', 0.9);

      // 约一半的山脊坡脚点缀一丛伴生矮灌木
      if (mode === 1) {
        const [bx, by] = pt(0.68, 0.64, 0.4);
        drawHighlandShrub(ctx, bx, by, 0.84, h >>> 4);
      }
    } else if (mode === 2 || mode === 3) {
      // 丘陵高地灌木丛（或双灌木错落组合）
      const su = 0.34 + ((h >>> 4) % 30) * 0.01;
      const sv = 0.36 + ((h >>> 9) % 28) * 0.01;
      const [bx, by] = pt(su, sv, 0);
      drawHighlandShrub(ctx, bx, by, mode === 2 ? 0.98 : 0.90, h >>> 3);
      if (mode === 3 && (h & 8)) {
        // 灌木旁伴生一小块砂岩或旱草芽
        const rx = bx - 5.2;
        const ry = by + 1.8;
        polygon(ctx, [[rx - 2.2, ry + 0.4], [rx - 0.6, ry - 1.4], [rx + 0.6, ry + 0.7]], '#e5d4aa');
        polygon(ctx, [[rx - 0.6, ry - 1.4], [rx + 2.0, ry - 0.1], [rx + 0.6, ry + 0.7]], '#b29664');
      }
    } else if (mode === 4) {
      // 稀疏的高地旱草簇与小砂石
      const [gx, gy] = pt(0.34 + (h % 29) * 0.01, 0.38 + ((h >>> 5) % 27) * 0.01, 0);
      polygon(ctx, [[gx - 2.5, gy + 0.5], [gx - 1.2, gy - 2.8], [gx + 0.1, gy + 0.6]], '#9aa36c');
      polygon(ctx, [[gx - 0.1, gy + 0.6], [gx + 1.5, gy - 2.4], [gx + 2.3, gy + 0.5]], '#7b8552');
    }
  }

  /**
   * 单棵 3D 层叠针叶松树模型：
   * 含椭圆落地阴影、双面树干、三层带锯齿裙边的立体圆锥树冠（迎光面/中调面/背光面 + 层间底影），
   * 与正俯视模式的松树（docs/art-reference/forest.png）及《陷阵之志》森林风格完全统一。
   */
  function drawPineTree(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale = 1, tint = 0): void {
    const s = scale;
    // 1. 树冠落地柔和投影（向东南微偏）
    ctx.fillStyle = '#2d402245';
    ctx.beginPath();
    ctx.ellipse(cx + 1.6 * s, cy + 0.9 * s, 6.2 * s, 3.1 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. 双色立体树干（左亮右暗）
    const tw = 1.65 * s;
    const th = 3.8 * s;
    polygon(ctx, [
      [cx - tw, cy + 0.6 * s],
      [cx - tw * 0.85, cy - th],
      [cx + 0.1 * s, cy - th],
      [cx + 0.1 * s, cy + 1.0 * s],
    ], '#8b6443');
    polygon(ctx, [
      [cx + 0.1 * s, cy + 1.0 * s],
      [cx + 0.1 * s, cy - th],
      [cx + tw * 0.95, cy - th],
      [cx + tw, cy + 0.6 * s],
    ], '#5e4129');

    // 色相微调（让林间不同树木有微妙的冷暖明度层次）
    const litPalette = tint === 0
      ? ['#789a5a', '#86a866', '#96b874'] as const
      : tint === 1
        ? ['#719355', '#7fa160', '#8fb16e'] as const
        : ['#7f9f5e', '#8dae6a', '#9dbe78'] as const;
    const midPalette = ['#64854a', '#709254', '#7ea060'] as const;
    const shadePalette = tint === 0
      ? ['#4b683c', '#547343', '#5e7f4b'] as const
      : tint === 1
        ? ['#466238', '#4f6d3f', '#587847'] as const
        : ['#506c3f', '#597847', '#638450'] as const;

    // 3. 三层叠冠（从下往上：底裙层 → 中腰层 → 顶冠层）
    const tiers: ReadonlyArray<readonly [number, number, number, number]> = [
      // [baseY, apexY, halfWidth, skirtDrop]
      [-2.4 * s, -10.8 * s, 6.6 * s, 2.0 * s],
      [-6.8 * s, -14.8 * s, 5.4 * s, 1.7 * s],
      [-11.0 * s, -18.6 * s, 4.1 * s, 1.4 * s],
    ];

    for (let i = 0; i < tiers.length; i++) {
      const [baseY, apexY, hw, drop] = tiers[i]!;
      const top: Point = [cx, cy + apexY];
      const farL: Point = [cx - hw, cy + baseY];
      const midL: Point = [cx - hw * 0.42, cy + baseY + drop * 0.72];
      const centerBot: Point = [cx + 0.15 * s, cy + baseY + drop];
      const midR: Point = [cx + hw * 0.48, cy + baseY + drop * 0.68];
      const farR: Point = [cx + hw, cy + baseY];

      // 下层枝叶受上层遮挡的暗部底缘
      if (i < 2) {
        polygon(ctx, [
          farL,
          midL,
          centerBot,
          midR,
          farR,
          [cx, cy + baseY - 0.8 * s],
        ], '#39502d');
      }

      // 迎光西北侧翼（最亮）
      polygon(ctx, [top, farL, midL], litPalette[i]!);
      // 正前偏左过渡面（中调）
      polygon(ctx, [top, midL, centerBot], midPalette[i]!);
      // 背光东南侧翼（深林绿暗部）
      polygon(ctx, [top, centerBot, midR, farR], shadePalette[i]!);

      // 树冠外廓极细暗边，强化《陷阵之志》式清晰剪影
      strokeLine(ctx, top, farL, '#435c3455', 0.65);
      strokeLine(ctx, top, farR, '#2e422466', 0.7);
    }
  }

  /** 林缘低矮灌木丛（双面受光立体小灌木） */
  function drawWoodlandShrub(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale = 1): void {
    const s = scale;
    ctx.fillStyle = '#2d402238';
    ctx.beginPath();
    ctx.ellipse(cx + 0.8 * s, cy + 0.6 * s, 4.2 * s, 2.0 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // 左侧迎光球冠
    polygon(ctx, [
      [cx - 4.0 * s, cy + 0.3 * s],
      [cx - 2.6 * s, cy - 3.6 * s],
      [cx + 0.3 * s, cy - 4.5 * s],
      [cx + 0.4 * s, cy + 1.0 * s],
    ], '#85a765');
    // 右侧背光球冠
    polygon(ctx, [
      [cx + 0.3 * s, cy - 4.5 * s],
      [cx + 3.1 * s, cy - 3.2 * s],
      [cx + 4.1 * s, cy + 0.4 * s],
      [cx + 0.4 * s, cy + 1.0 * s],
    ], '#567545');
  }

  /**
   * 森林建模：
   * 深苔林地底板 + 林下暗苔斑块 + 按邻格聚类的 2~3 棵立体三层松林与灌木，
   * 严格按 (u + v) 由远及近排序绘制，形成自然错落、辨识度极高的林海。
   */
  function paintForestArt(ctx: CanvasRenderingContext2D, x: number, y: number, elevation: number, state: GameState): void {
    const h = tileHash(x, y, 37);
    const pt = (u: number, v: number, dz = 0): Point => project(x + u, y + v, elevation + dz);

    // 1. 森林苔原底色（比平原更深沉浓郁的林地绿）
    const floorTones = ['#a8bd86', '#a4ba82', '#acc18a'] as const;
    polygon(ctx, rhombus(x, y, 1, elevation), floorTones[(x + y * 2) % 3]!, '#2b3b2028');

    // 2. 林下苔藓暗斑（将树群底部凝聚成一片林地）
    polygon(ctx, [
      pt(0.16, 0.48, 0),
      pt(0.48, 0.16, 0),
      pt(0.84, 0.50, 0),
      pt(0.52, 0.84, 0),
    ], '#95ab73');

    // 统计 8 邻域森林格数，内部密林用 3 棵主树，林缘用 2 棵主树 + 灌木
    let forestNeighbors = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx !== 0 || dy !== 0) && at(state, x + dx, y + dy) === 'forest') forestNeighbors++;
      }
    }

    const jx = (((h >>> 3) % 9) - 4) * 0.008;
    const jy = (((h >>> 8) % 9) - 4) * 0.008;
    const dense = forestNeighbors >= 3 || (h % 3) === 0;

    interface GroveItem {
      u: number;
      v: number;
      scale: number;
      kind: 'pine' | 'shrub';
      tint: number;
    }

    const layouts: ReadonlyArray<ReadonlyArray<GroveItem>> = [
      // 布局 0：经典三角密林（后高松 + 左前中松 + 右前松）
      [
        { u: 0.30 + jx, v: 0.28 + jy, scale: 1.02, kind: 'pine', tint: 0 },
        { u: 0.26 - jy, v: 0.66 + jx, scale: 0.90, kind: 'pine', tint: 1 },
        { u: 0.68 + jx, v: 0.46 - jy, scale: 0.94, kind: 'pine', tint: 2 },
      ],
      // 布局 1：错落三松林（左后高松 + 右后中松 + 前方主松）
      [
        { u: 0.24 + jx, v: 0.36 + jy, scale: 0.94, kind: 'pine', tint: 1 },
        { u: 0.56 - jx, v: 0.24 + jy, scale: 0.88, kind: 'pine', tint: 2 },
        { u: 0.58 + jy, v: 0.64 + jx, scale: 1.04, kind: 'pine', tint: 0 },
      ],
      // 布局 2：林缘双松 + 灌木丛
      [
        { u: 0.30 + jx, v: 0.32 + jy, scale: 1.04, kind: 'pine', tint: 0 },
        { u: 0.64 - jx, v: 0.58 + jy, scale: 0.92, kind: 'pine', tint: 1 },
        { u: 0.30 + jy, v: 0.72 - jx, scale: 0.95, kind: 'shrub', tint: 2 },
      ],
    ];

    const chosen = dense ? layouts[h % 2]! : layouts[2]!;
    const sorted = [...chosen].sort((a, b) => (a.u + a.v) - (b.u + b.v));
    for (const item of sorted) {
      const [px, py] = pt(item.u, item.v, 0);
      if (item.kind === 'pine') drawPineTree(ctx, px, py, item.scale, item.tint);
      else drawWoodlandShrub(ctx, px, py, item.scale);
    }
  }

  /**
   * 块面感低多边形山体（《陷阵之志》Into the Breach 厚重折面岩块风格）：
   * 放弃细碎针状尖刺，改用宽底、厚肩、带平缓刀脊线的多面体花岗岩巨岩，
   * 大块面明暗对比干净利落，在 16×16 与 32×32 下都具备极佳的块面雕塑感。
   */
  function drawAlpineMassif(
    ctx: CanvasRenderingContext2D,
    pt: (u: number, v: number, dz?: number) => Point,
    cu: number,
    cv: number,
    ru: number,
    rv: number,
    peakH: number,
    snowCap: boolean,
    skew = 0,
  ): void {
    // 宽厚六边形岩基（稳稳咬合山盘底座）
    const bN = pt(cu - ru * 0.12, cv - rv, 0);
    const bNE = pt(cu + ru * 0.82, cv - rv * 0.50, 0);
    const bE = pt(cu + ru, cv + rv * 0.22, 0);
    const bS = pt(cu + ru * 0.10, cv + rv, 0);
    const bSW = pt(cu - ru * 0.80, cv + rv * 0.52, 0);
    const bW = pt(cu - ru, cv - rv * 0.20, 0);

    // 宽脊双峰顶（形成有厚度的山脊顶棱，而不是一根针尖）
    const crestNW = pt(cu - ru * (0.22 - skew), cv - rv * 0.18, peakH);
    const crestSE = pt(cu + ru * (0.16 + skew), cv + rv * 0.14, peakH * 0.90);
    // 两侧山肩折点（塑造《陷阵之志》式的阶梯岩肩）
    const ledgeW = pt(cu - ru * 0.56, cv + rv * 0.18, peakH * 0.52);
    const ledgeE = pt(cu + ru * 0.54, cv - rv * 0.16, peakH * 0.48);

    // 1. 西北迎光主岩面（大面积亮灰花岗岩）
    polygon(ctx, [bW, bN, crestNW, ledgeW], '#c2cdd8');
    // 2. 东北侧坡过渡面
    polygon(ctx, [bN, bNE, ledgeE, crestNW], '#96a4b3');
    // 3. 西南受光前坡与山肩面（中亮板岩）
    polygon(ctx, [bW, ledgeW, crestSE, bS, bSW], '#9ca9b7');
    polygon(ctx, [ledgeW, crestNW, crestSE], '#b0bcc9');
    // 4. 东南与正东背光陡壁（深冷岩石暗面）
    polygon(ctx, [crestNW, ledgeE, bE, bS, crestSE], '#627181');
    polygon(ctx, [ledgeE, bNE, bE], '#515f6e');

    // 5. 山脊浅雪/亮石英岩冠（大块几何折面，干净醒目）
    if (snowCap && peakH >= 12) {
      const sW = pt(cu - ru * 0.44, cv - rv * 0.04, peakH * 0.62);
      const sN = pt(cu - ru * 0.10, cv - rv * 0.44, peakH * 0.64);
      const sS = pt(cu + ru * 0.04, cv + rv * 0.34, peakH * 0.60);
      const sE = pt(cu + ru * 0.38, cv + rv * 0.00, peakH * 0.58);
      polygon(ctx, [sW, sN, crestNW, crestSE, sS], '#edf2f7');
      polygon(ctx, [sN, sE, crestSE, crestNW], '#c5d0dc');
    }

    // 6. 干净利落的岩棱高光线
    strokeLine(ctx, bN, crestNW, '#f2f6fa90', 0.9);
    strokeLine(ctx, crestNW, crestSE, '#f5f8fb', 1.1);
    strokeLine(ctx, crestSE, bS, '#414d5966', 0.85);
  }

  /**
   * 高山建模（《陷阵之志》厚重块面岩山风格）：
   * 每格以一座饱满厚重的低多边形主山体为核心，辅以一块侧翼岩肩，
   * 块面舒展、山脊硬朗，既有高山不可通行的威压感，又与整体微缩沙盘风格高度协调。
   */
  function paintMountainArt(ctx: CanvasRenderingContext2D, x: number, y: number, elevation: number, state: GameState): void {
    const h = tileHash(x, y, 53);
    const pt = (u: number, v: number, dz = 0): Point => project(x + u, y + v, elevation + dz);

    // 1. 高山岩盘基座与外缘亮坎
    polygon(ctx, rhombus(x, y, 1, elevation), '#7f8c9a', '#3f4a5633');
    if (heightAt(state, x - 1, y) < elevation) {
      strokeLine(ctx, pt(0, 1, 0), pt(0, 0, 0), '#c4cfd9', 1.25);
    }
    if (heightAt(state, x, y - 1) < elevation) {
      strokeLine(ctx, pt(0, 0, 0), pt(1, 0, 0), '#b4c0cc', 1.15);
    }

    // 统计四邻高山，处于山脉腹地的山体略微抬高主脊，形成自然的山脉主峰层次
    const mtnNeighbors =
      Number(at(state, x, y - 1) === 'mountain') +
      Number(at(state, x - 1, y) === 'mountain') +
      Number(at(state, x + 1, y) === 'mountain') +
      Number(at(state, x, y + 1) === 'mountain');
    const boost = mtnNeighbors >= 2 ? 2.2 : mtnNeighbors === 1 ? 1.0 : 0;

    // 2. 每格塑造一座完整、宽底、带阶梯岩肩的低多边形块面主山体（避免一格多峰造成的细碎感）
    const variant = h % 3;
    if (variant === 0) {
      drawAlpineMassif(ctx, pt, 0.48, 0.50, 0.46, 0.44, 14.5 + boost, true, -0.04);
    } else if (variant === 1) {
      drawAlpineMassif(ctx, pt, 0.51, 0.47, 0.45, 0.44, 15.2 + boost, true, 0.04);
    } else {
      drawAlpineMassif(ctx, pt, 0.49, 0.51, 0.46, 0.45, 14.8 + boost, true, 0.0);
    }
  }

  /**
   * 沙盘外边缘水体纵剖面（《陷阵之志》微缩沙盘水层切面）：
   * 水体到达地图边缘时，立面展示半透明水体纵切层 + 下方湿润河床/海床基岩，
   * 水层厚度随浅流/水域/深水逐档加深，并带柔和的水下折射高光线。
   */
  function paintWaterCutawayFace(
    ctx: CanvasRenderingContext2D,
    terrain: Terrain,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    side: 'east' | 'south',
    dark: boolean,
    timeSec: number,
  ): Point[] {
    const topZ = WATER_SURFACE;
    const botZ = boardFloor;
    const drop = topZ - botZ;
    const points: Point[] = [
      project(x0, y0, topZ),
      project(x1, y1, topZ),
      project(x1, y1, botZ),
      project(x0, y0, botZ),
    ];

    // 1. 下方基岩/底泥地层
    const rockFill = side === 'east' ? '#635648' : '#7b6e59';
    polygon(ctx, points, rockFill);

    // 2. 上方水体纵剖层（浅流薄而清、水域适中、深水厚重湛蓝）
    const waterThick = terrain === 'shallow' ? 2.6 : terrain === 'deep' ? 7.6 : 5.1;
    const waterBotZ = Math.max(botZ + 1.2, topZ - Math.min(drop - 1.2, waterThick));
    const waterFill = terrain === 'shallow'
      ? (side === 'east' ? '#79b5ae' : '#90cbc3')
      : terrain === 'deep'
        ? (side === 'east' ? '#325d7d' : '#407094')
        : (side === 'east' ? '#5890ae' : '#6ca5c3');
    const waterDeepFill = terrain === 'shallow'
      ? (side === 'east' ? '#659e98' : '#78b3ac')
      : terrain === 'deep'
        ? (side === 'east' ? '#254863' : '#305978')
        : (side === 'east' ? '#457894' : '#568ca8');

    const midZ = (topZ + waterBotZ) * 0.5;
    polygon(ctx, [
      project(x0, y0, topZ),
      project(x1, y1, topZ),
      project(x1, y1, midZ),
      project(x0, y0, midZ),
    ], waterFill);
    polygon(ctx, [
      project(x0, y0, midZ),
      project(x1, y1, midZ),
      project(x1, y1, waterBotZ),
      project(x0, y0, waterBotZ),
    ], waterDeepFill);

    // 湿润河床/海床交界带
    const siltZ = Math.max(botZ, waterBotZ - 1.3);
    const siltColor = terrain === 'shallow'
      ? (side === 'east' ? '#98906f' : '#aea683')
      : terrain === 'deep'
        ? (side === 'east' ? '#464a49' : '#575c5a')
        : (side === 'east' ? '#686b5c' : '#7e816f');
    polygon(ctx, [
      project(x0, y0, waterBotZ),
      project(x1, y1, waterBotZ),
      project(x1, y1, siltZ),
      project(x0, y0, siltZ),
    ], siltColor);

    // 水下微弱折射光带（缓慢斜移）
    const glint = 0.25 + 0.5 * (((x0 + y0) * 0.37 + timeSec * 0.14) % 1);
    const gx0 = x0 + (x1 - x0) * Math.max(0.12, glint - 0.12);
    const gy0 = y0 + (y1 - y0) * Math.max(0.12, glint - 0.12);
    const gx1 = x0 + (x1 - x0) * Math.min(0.88, glint + 0.08);
    const gy1 = y0 + (y1 - y0) * Math.min(0.88, glint + 0.08);
    strokeLine(ctx, project(gx0, gy0, topZ - 0.4), project(gx1, gy1, waterBotZ + 0.4), '#d9f2fa38', 1.1);

    // 顶部水面弯月面微高光 + 干脆描边
    strokeLine(ctx, project(x0, y0, topZ), project(x1, y1, topZ), '#d9f3f877', 0.9);
    ctx.beginPath();
    ctx.moveTo(...points[0]!);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.closePath();
    ctx.strokeStyle = '#3d505b99';
    ctx.lineWidth = 0.85;
    ctx.stroke();

    if (dark) polygon(ctx, points, '#17232b47');
    return points;
  }

  /**
   * 桥梁顶面建模（与正俯视木桥协调）：
   * 自动判断桥梁通行方向（东西或南北），绘制木板横缝、迎光木纹高光与双侧护栏。
   */
  function paintBridgeArt(ctx: CanvasRenderingContext2D, x: number, y: number, elevation: number, state: GameState): void {
    const pt = (u: number, v: number, dz = 0): Point => project(x + u, y + v, elevation + dz);
    polygon(ctx, rhombus(x, y, 1, elevation), '#c4a272', '#6e523055');

    // 判断桥面延伸方向：若东西方向接陆地/桥，则东西通行（木板沿南北铺设）
    const ewConn = !isWaterTerrain(at(state, x - 1, y)) && at(state, x - 1, y) !== undefined
      || !isWaterTerrain(at(state, x + 1, y)) && at(state, x + 1, y) !== undefined;
    const nsConn = !isWaterTerrain(at(state, x, y - 1)) && at(state, x, y - 1) !== undefined
      || !isWaterTerrain(at(state, x, y + 1)) && at(state, x, y + 1) !== undefined;
    const spanAlongX = ewConn || !nsConn;

    if (spanAlongX) {
      // 东西向桥：桥板横缝沿 v 方向
      for (let i = 1; i <= 5; i++) {
        const u = i / 6;
        strokeLine(ctx, pt(u, 0.08, 0), pt(u, 0.92, 0), '#7c5d365a', 0.85);
        strokeLine(ctx, pt(u - 0.03, 0.12, 0), pt(u - 0.03, 0.88, 0), '#e2c99e44', 0.65);
      }
      // 北侧与南侧木护栏
      polygon(ctx, [pt(0, 0.02, 0), pt(1, 0.02, 0), pt(1, 0.13, 0), pt(0, 0.13, 0)], '#9b7849');
      strokeLine(ctx, pt(0, 0.04, 0.7), pt(1, 0.04, 0.7), '#e5cca0', 1.15);
      polygon(ctx, [pt(0, 0.87, 0), pt(1, 0.87, 0), pt(1, 0.98, 0), pt(0, 0.98, 0)], '#87663b');
      strokeLine(ctx, pt(0, 0.90, 0.7), pt(1, 0.90, 0.7), '#d5b787', 1.05);
    } else {
      // 南北向桥：桥板横缝沿 u 方向
      for (let i = 1; i <= 5; i++) {
        const v = i / 6;
        strokeLine(ctx, pt(0.08, v, 0), pt(0.92, v, 0), '#7c5d365a', 0.85);
        strokeLine(ctx, pt(0.12, v - 0.03, 0), pt(0.88, v - 0.03, 0), '#e2c99e44', 0.65);
      }
      // 西侧与东侧木护栏
      polygon(ctx, [pt(0.02, 0, 0), pt(0.13, 0, 0), pt(0.13, 1, 0), pt(0.02, 1, 0)], '#9b7849');
      strokeLine(ctx, pt(0.04, 0, 0.7), pt(0.04, 1, 0.7), '#e5cca0', 1.15);
      polygon(ctx, [pt(0.87, 0, 0), pt(0.98, 0, 0), pt(0.98, 1, 0), pt(0.87, 1, 0)], '#87663b');
      strokeLine(ctx, pt(0.90, 0, 0.7), pt(0.90, 1, 0.7), '#d5b787', 1.05);
    }
  }

  /**
   * 斜俯视三档水体建模与分型动态水纹（《陷阵之志》式清透微缩沙盘风格）：
   * - 浅流（shallow）：青碧透底、水下沙洲/鹅卵石隐约可见、清亮碎波；
   * - 水域（water）：明净天青蓝、柔和通透的水面高光与流带；
   * - 深水（deep）：沉稳海靛蓝、宏阔水色层次与清晰浪峰。
   * 动画依据自动识别的水体形态自动适配：
   * - 河（river）：沿平滑拉普拉斯流场跨格顺流滑动的清透水流丝带与碎光；
   * - 湖（lake）：自湖心轻缓外扩的宁静同心涟漪与呼吸感微光；
   * - 海（sea）：跨海域协同推进的斜向涌浪明暗带、卷涌白沫浪峰与拍岸浪花。
   */
  function paintWaterArt(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    terrain: Terrain,
    state: GameState,
    meta: WaterCellMeta,
    timeSec: number,
  ): void {
    const h = tileHash(x, y, 71);
    const elevation = WATER_SURFACE;
    const pt = (u: number, v: number, dz = 0): Point => project(x + u, y + v, elevation + dz);
    const top = rhombus(x, y, 1, elevation);

    // 1. 三档水体柔和跨格底色（微弱空间明度波纹，消除死板棋盘格感）
    const wWave = Math.sin(x * 0.65 + y * 0.55) + Math.cos(x * 0.4 - y * 0.6);
    const baseFill = terrain === 'shallow'
      ? (wWave > 0.5 ? '#afd7cc' : wWave < -0.5 ? '#a5cfc4' : '#abd3c8')
      : terrain === 'deep'
        ? (wWave > 0.5 ? '#5484a6' : wWave < -0.5 ? '#4a7a9c' : '#4f7fa1')
        : (wWave > 0.5 ? '#91bed4' : wWave < -0.5 ? '#87b4cc' : '#8cb9d0');
    polygon(ctx, top, baseFill);

    // 裁切在当前水格内绘制所有水下过渡、流带与岸浪，确保跨格连续且绝不溢界
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(...top[0]!);
    ctx.lineTo(...top[1]!);
    ctx.lineTo(...top[2]!);
    ctx.lineTo(...top[3]!);
    ctx.closePath();
    ctx.clip();

    // 2. 深浅水体之间的柔和水下坡带（浅流 ↔ 水域 ↔ 深水）
    const myDepth = bedDepth[terrain] ?? 4;
    const slopeRgb = (t: Terrain): string =>
      t === 'shallow' ? '171,211,200' : t === 'deep' ? '79,127,161' : '140,185,208';
    const paintDepthSlope = (side: 'n' | 'e' | 's' | 'w', neighbor: Terrain | undefined): void => {
      if (!isWaterTerrain(neighbor) || (bedDepth[neighbor!] ?? 4) === myDepth) return;
      const rgb = slopeRgb(neighbor!);
      const band = (w1: number, alpha: number): void => {
        const quad: Point[] = side === 'n'
          ? [pt(0, 0), pt(1, 0), pt(1, w1), pt(0, w1)]
          : side === 'e'
            ? [pt(1 - w1, 0), pt(1, 0), pt(1, 1), pt(1 - w1, 1)]
            : side === 's'
              ? [pt(0, 1 - w1), pt(1, 1 - w1), pt(1, 1), pt(0, 1)]
              : [pt(0, 0), pt(w1, 0), pt(w1, 1), pt(0, 1)];
        polygon(ctx, quad, `rgba(${rgb},${alpha})`);
      };
      band(0.24, 0.24);
      band(0.11, 0.34);
    };
    paintDepthSlope('n', at(state, x, y - 1));
    paintDepthSlope('e', at(state, x + 1, y));
    paintDepthSlope('s', at(state, x, y + 1));
    paintDepthSlope('w', at(state, x - 1, y));

    // 3. 水下河床/海床层次肌理
    if (terrain === 'shallow') {
      // 浅流：温暖隐约的水下浅沙洲斑块 + 圆润鹅卵石，一眼辨识可涉水
      if ((h % 7) < 4) {
        const su = 0.28 + ((h >>> 3) % 34) * 0.01;
        const sv = 0.28 + ((h >>> 8) % 34) * 0.01;
        const sr = 0.19 + ((h >>> 13) % 9) * 0.01;
        polygon(ctx, [
          pt(su - sr, sv),
          pt(su, sv - sr * 0.85),
          pt(su + sr, sv),
          pt(su, sv + sr * 0.85),
        ], '#d2e2c848');
      }
      if ((h % 5) < 2) {
        const pu = 0.26 + ((h >>> 5) % 44) * 0.01;
        const pv = 0.28 + ((h >>> 10) % 42) * 0.01;
        const [px, py] = pt(pu, pv);
        polygon(ctx, [[px - 2.6, py + 0.4], [px - 0.6, py - 1.1], [px + 1.8, py - 0.5], [px + 0.8, py + 1.2]], '#7da79d66');
        polygon(ctx, [[px - 1.8, py - 0.2], [px - 0.4, py - 1.0], [px + 0.8, py - 0.4], [px - 0.2, py + 0.3]], '#cde3d95e');
      }
    } else if (terrain === 'deep') {
      // 深水：缓慢游移的深海暗槽光影层
      const drift = Math.sin(x * 0.55 + y * 0.45 - timeSec * 0.65);
      if (drift < 0.15) {
        const a = Math.max(0.04, (0.15 - drift) * 0.16);
        polygon(ctx, [pt(0.08, 0.25), pt(0.55, 0.04), pt(0.92, 0.72), pt(0.42, 0.94)], `rgba(38,71,99,${a.toFixed(3)})`);
      }
    }

    // 4. 西北/东北岸壁落在水面上的柔和投影（增强水体嵌入地形的立体凹陷感）
    if (meta.shoreMask & 8) {
      polygon(ctx, [pt(0, 0), pt(0.19, 0), pt(0.19, 1), pt(0, 1)], '#26495f2c');
    }
    if (meta.shoreMask & 1) {
      polygon(ctx, [pt(0, 0), pt(1, 0), pt(1, 0.19), pt(0, 0.19)], '#26495f26');
    }

    // 5. 分型水体流动动画（河 / 湖 / 海 各具鲜明且克制优雅的动态韵律）
    const fx = meta.flowX;
    const fy = meta.flowY;
    const px = -fy;
    const py = fx;
    const frac = (n: number): number => n - Math.floor(n);

    if (meta.kind === 'river') {
      // —— 河（River）：顺沿拉普拉斯流场跨格流动的清透丝带与细碎水光 ——
      const speed = terrain === 'shallow' ? 0.56 : terrain === 'deep' ? 0.26 : 0.40;
      const laneOffsets = terrain === 'shallow' ? [-0.26, 0.04, 0.30] : [-0.22, 0.22];
      const baseAlong = x * fx + y * fy;
      const baseAcross = x * px + y * py;

      for (let li = 0; li < laneOffsets.length; li++) {
        const laneAcross = laneOffsets[li]!;
        const laneSeed = Math.sin((Math.round(baseAcross * 2 + li * 3.1)) * 12.9898) * 43758.5453;
        const laneJitter = (frac(laneSeed) - 0.5) * 0.12;
        const travel = timeSec * speed + frac(laneSeed * 1.7);
        const phase = frac(baseAlong * 0.72 - travel);
        // 采样错落两档，确保跨格顺滑无缝且保持清透透气感
        for (const shift of [-0.36, 0.42]) {
          const sCenter = phase + shift - 0.42;
          if (sCenter < -0.58 || sCenter > 0.62) continue;
          const halfLen = terrain === 'shallow' ? 0.20 : terrain === 'deep' ? 0.29 : 0.25;
          const bend = Math.sin((baseAlong + sCenter) * 3.4 + timeSec * 1.8 + li) * 0.036;
          const cu = 0.5 + fx * sCenter + px * (laneAcross + laneJitter);
          const cv = 0.5 + fy * sCenter + py * (laneAcross + laneJitter);
          const a = pt(cu - fx * halfLen, cv - fy * halfLen);
          const mid = pt(cu + px * bend, cv + py * bend);
          const b = pt(cu + fx * halfLen, cv + fy * halfLen);

          // 柔和流带暗底（增加水纹厚度）
          ctx.beginPath();
          ctx.moveTo(a[0], a[1] + 0.8);
          ctx.quadraticCurveTo(mid[0], mid[1] + 0.8, b[0], b[1] + 0.8);
          ctx.strokeStyle = terrain === 'deep' ? 'rgba(37,69,96,0.24)' : 'rgba(84,132,158,0.18)';
          ctx.lineWidth = terrain === 'deep' ? 1.45 : 1.1;
          ctx.lineCap = 'round';
          ctx.stroke();

          // 迎光主水纹高光线
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.quadraticCurveTo(mid[0], mid[1], b[0], b[1]);
          ctx.strokeStyle = terrain === 'shallow'
            ? 'rgba(245,253,250,0.58)'
            : terrain === 'deep'
              ? 'rgba(176,216,238,0.38)'
              : 'rgba(235,249,254,0.48)';
          ctx.lineWidth = terrain === 'shallow' ? 1.1 : terrain === 'deep' ? 1.3 : 1.15;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }

      // 浅流专属：灵动碎浪小波尖（凸显水流浅急清澈）
      if (terrain === 'shallow' && (h % 3) !== 0) {
        const spark = 0.35 + 0.65 * Math.sin(timeSec * 3.1 + (h % 19) * 0.7) ** 2;
        const tSlide = frac((h % 13) * 0.17 + timeSec * 0.42) - 0.5;
        const su = 0.5 + fx * tSlide * 0.55 + px * (((h >>> 4) % 5) - 2) * 0.1;
        const sv = 0.5 + fy * tSlide * 0.55 + py * (((h >>> 4) % 5) - 2) * 0.1;
        const [gx, gy] = pt(su, sv);
        ctx.fillStyle = `rgba(250,255,253,${(0.45 * spark).toFixed(3)})`;
        ctx.fillRect(gx - 1.4, gy - 0.5, 2.8, 1.0);
      }
    } else if (meta.kind === 'lake') {
      // —— 湖（Lake）：宁静同心微涟漪 + 柔和镜面微光呼吸 ——
      const rSpeed = terrain === 'shallow' ? 0.24 : terrain === 'deep' ? 0.15 : 0.19;
      for (let ring = 0; ring < 2; ring++) {
        const life = frac(meta.phaseCoord * 0.52 - timeSec * rSpeed + ring * 0.5);
        const fade = Math.sin(life * Math.PI);
        if (fade < 0.08) continue;
        const radialShift = (life - 0.5) * 0.52;
        const cu = 0.5 + fx * radialShift;
        const cv = 0.5 + fy * radialShift;
        const arcSpan = terrain === 'deep' ? 0.32 : 0.26;
        const arcCurve = 0.07;
        const a = pt(cu - px * arcSpan - fx * arcCurve, cv - py * arcSpan - fy * arcCurve);
        const mid = pt(cu + fx * arcCurve * 0.6, cv + fy * arcCurve * 0.6);
        const b = pt(cu + px * arcSpan - fx * arcCurve, cv + py * arcSpan - fy * arcCurve);

        const alpha = (terrain === 'shallow' ? 0.56 : terrain === 'deep' ? 0.34 : 0.46) * fade;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.quadraticCurveTo(mid[0], mid[1], b[0], b[1]);
        ctx.strokeStyle = terrain === 'deep'
          ? `rgba(182,219,239,${alpha.toFixed(3)})`
          : `rgba(241,252,253,${alpha.toFixed(3)})`;
        ctx.lineWidth = terrain === 'deep' ? 1.25 : 1.05;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // 镜面天光微漾（在水平斜俯视方向柔和明灭，营造静湖诗意）
      const shimmer = 0.5 + 0.5 * Math.sin(timeSec * 1.35 + (h % 31) * 0.45 + x * 0.7 - y * 0.5);
      if (shimmer > 0.32) {
        const sAlpha = (shimmer - 0.32) * (terrain === 'shallow' ? 0.52 : terrain === 'deep' ? 0.32 : 0.42);
        const gu = 0.32 + ((h >>> 4) % 36) * 0.01;
        const gv = 0.34 + ((h >>> 9) % 34) * 0.01;
        const [gx, gy] = pt(gu, gv);
        const len = 3.2 + shimmer * 3.0;
        strokeLine(ctx, [gx - len, gy], [gx + len, gy], `rgba(246,253,255,${sAlpha.toFixed(3)})`, 1.0);
      }
    } else {
      // —— 海（Sea）：宏阔斜向涌浪明暗带 + 雕塑感起伏白沫浪峰 + 近岸潮汐碎浪 ——
      const swellSpeed = terrain === 'deep' ? 1.22 : terrain === 'water' ? 1.42 : 1.65;
      const worldProj = (x + 0.5) * fx + (y + 0.5) * fy;
      const swellArg = worldProj * 1.15 - timeSec * swellSpeed;
      const swellVal = Math.sin(swellArg);

      // 5a. 宏阔涌浪受光面与波谷暗带（用平滑斜向波带替代整格平涂，消除格间块感）
      if (swellVal > 0.05) {
        const a = swellVal * (terrain === 'deep' ? 0.21 : terrain === 'water' ? 0.19 : 0.22);
        const bandShift = Math.cos(swellArg) * 0.16;
        const cu = 0.5 + fx * bandShift;
        const cv = 0.5 + fy * bandShift;
        polygon(ctx, [
          pt(cu - px * 0.8 - fx * 0.25, cv - py * 0.8 - fy * 0.25),
          pt(cu + px * 0.8 - fx * 0.25, cv + py * 0.8 - fy * 0.25),
          pt(cu + px * 0.8 + fx * 0.25, cv + py * 0.8 + fy * 0.25),
          pt(cu - px * 0.8 + fx * 0.25, cv - py * 0.8 + fy * 0.25),
        ], terrain === 'deep'
          ? `rgba(148,202,232,${a.toFixed(3)})`
          : `rgba(232,248,253,${a.toFixed(3)})`);
      } else if (swellVal < -0.08) {
        const a = -swellVal * (terrain === 'deep' ? 0.19 : 0.12);
        const bandShift = -Math.cos(swellArg) * 0.16;
        const cu = 0.5 + fx * bandShift;
        const cv = 0.5 + fy * bandShift;
        polygon(ctx, [
          pt(cu - px * 0.8 - fx * 0.26, cv - py * 0.8 - fy * 0.26),
          pt(cu + px * 0.8 - fx * 0.26, cv + py * 0.8 - fy * 0.26),
          pt(cu + px * 0.8 + fx * 0.26, cv + py * 0.8 + fy * 0.26),
          pt(cu - px * 0.8 + fx * 0.26, cv - py * 0.8 + fy * 0.26),
        ], `rgba(34,67,94,${a.toFixed(3)})`);
      }

      // 5b. 雕塑感海浪白沫波峰（沿涌浪法线推进、自然疏密错落）
      const waveCycle = frac(worldProj * 0.58 - timeSec * (swellSpeed / (Math.PI * 2)) + ((h % 7) * 0.04));
      const crestVis = Math.sin(waveCycle * Math.PI);
      if (crestVis > 0.22 && (h % 5) !== 0) {
        const slide = (waveCycle - 0.5) * 0.62;
        const lateral = (((h >>> 3) % 7) - 3) * 0.05;
        const cu = 0.5 + fx * slide + px * lateral;
        const cv = 0.5 + fy * slide + py * lateral;
        const span = terrain === 'deep' ? 0.37 : terrain === 'water' ? 0.31 : 0.25;
        const arch = 0.085;
        const wL = pt(cu - px * span, cv - py * span);
        const wM1 = pt(cu - px * (span * 0.35) + fx * arch, cv - py * (span * 0.35) + fy * arch);
        const wC = pt(cu + fx * (arch * 0.35), cv + fy * (arch * 0.35));
        const wM2 = pt(cu + px * (span * 0.35) + fx * arch, cv + py * (span * 0.35) + fy * arch);
        const wR = pt(cu + px * span, cv + py * span);

        // 浪背微阴影
        ctx.beginPath();
        ctx.moveTo(wL[0], wL[1] + 1.0);
        ctx.quadraticCurveTo(wM1[0], wM1[1] + 1.0, wC[0], wC[1] + 1.0);
        ctx.quadraticCurveTo(wM2[0], wM2[1] + 1.0, wR[0], wR[1] + 1.0);
        ctx.strokeStyle = terrain === 'deep'
          ? `rgba(32,63,89,${(0.42 * crestVis).toFixed(3)})`
          : `rgba(69,115,143,${(0.28 * crestVis).toFixed(3)})`;
        ctx.lineWidth = terrain === 'deep' ? 1.75 : 1.35;
        ctx.lineCap = 'round';
        ctx.stroke();

        // 迎光白沫浪脊
        ctx.beginPath();
        ctx.moveTo(wL[0], wL[1]);
        ctx.quadraticCurveTo(wM1[0], wM1[1], wC[0], wC[1]);
        ctx.quadraticCurveTo(wM2[0], wM2[1], wR[0], wR[1]);
        ctx.strokeStyle = terrain === 'deep'
          ? `rgba(229,245,252,${(0.72 * crestVis).toFixed(3)})`
          : `rgba(247,253,255,${(0.66 * crestVis).toFixed(3)})`;
        ctx.lineWidth = terrain === 'deep' ? 1.4 : 1.15;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // 5c. 近海浅滩第二道细碎拍岸涌纹
      if (meta.distToLand <= 1.85 && terrain !== 'deep') {
        const surf = 0.5 + 0.5 * Math.sin(meta.distToLand * 3.1 - timeSec * 2.15 + (h % 5) * 0.3);
        if (surf > 0.35) {
          const sa = (surf - 0.35) * 0.55;
          const a = pt(0.5 - px * 0.28 + fx * 0.14, 0.5 - py * 0.28 + fy * 0.14);
          const b = pt(0.5 + px * 0.28 + fx * 0.14, 0.5 + py * 0.28 + fy * 0.14);
          strokeLine(ctx, a, b, `rgba(248,254,255,${sa.toFixed(3)})`, 1.05);
        }
      }
    }

    // 6. 动态岸边水花/浪边（所有邻接陆地的边沿均带对应水体节奏的柔白浪线）
    if (meta.shoreMask) {
      const paintShoreFoam = (bit: number, a0: [number, number], b0: [number, number], inU: number, inV: number): void => {
        if (!(meta.shoreMask & bit)) return;
        const shorePhase = (x * 0.9 + y * 1.1) + bit * 0.4;
        const wave = meta.kind === 'sea'
          ? 0.5 + 0.5 * Math.sin(timeSec * 2.15 - shorePhase * 0.6)
          : meta.kind === 'river'
            ? 0.5 + 0.5 * Math.sin(timeSec * 2.6 + meta.phaseCoord * 2.4)
            : 0.5 + 0.5 * Math.sin(timeSec * 1.3 + shorePhase * 0.5);
        const offset = meta.kind === 'sea'
          ? 0.04 + wave * 0.075
          : meta.kind === 'river'
            ? 0.042 + wave * 0.022
            : 0.04 + wave * 0.032;
        const p1 = pt(a0[0] + inU * offset, a0[1] + inV * offset);
        const p2 = pt(b0[0] + inU * offset, b0[1] + inV * offset);
        const foamAlpha = meta.kind === 'sea'
          ? 0.48 + wave * 0.36
          : meta.kind === 'river'
            ? 0.42 + wave * 0.22
            : 0.34 + wave * 0.20;
        strokeLine(ctx, p1, p2, `rgba(246,253,253,${foamAlpha.toFixed(3)})`, meta.kind === 'sea' ? 1.55 : 1.15);

        // 海域独有：双层退潮白沫余韵
        if (meta.kind === 'sea') {
          const offset2 = offset + 0.075;
          const q1 = pt(a0[0] + inU * offset2, a0[1] + inV * offset2);
          const q2 = pt(b0[0] + inU * offset2, b0[1] + inV * offset2);
          strokeLine(ctx, q1, q2, `rgba(229,246,252,${(0.32 * (1 - wave * 0.4)).toFixed(3)})`, 0.95);
        }
      };
      paintShoreFoam(1, [0.05, 0], [0.95, 0], 0, 1);
      paintShoreFoam(2, [1, 0.05], [1, 0.95], -1, 0);
      paintShoreFoam(4, [0.05, 1], [0.95, 1], 0, -1);
      paintShoreFoam(8, [0, 0.05], [0, 0.95], 1, 0);
    }

    ctx.restore();

    // 7. 极淡战术格线 + 深浅水体等深分界线（保持战棋可读性）
    ctx.beginPath();
    ctx.moveTo(...top[0]!);
    ctx.lineTo(...top[1]!);
    ctx.lineTo(...top[2]!);
    ctx.lineTo(...top[3]!);
    ctx.closePath();
    ctx.strokeStyle = terrain === 'deep' ? '#d8eef81c' : '#f2fafb22';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    const contour = (a: Point, b: Point, other: Terrain): void => {
      const deepBoundary = terrain === 'deep' || other === 'deep';
      strokeLine(ctx, a, b, deepBoundary ? '#2f597848' : '#588d9242', 0.95);
    };
    const eastNeighbor = at(state, x + 1, y);
    if (isWaterTerrain(eastNeighbor) && (bedDepth[eastNeighbor!] ?? 0) !== myDepth) {
      contour(project(x + 1, y, elevation), project(x + 1, y + 1, elevation), eastNeighbor!);
    }
    const southNeighbor = at(state, x, y + 1);
    if (isWaterTerrain(southNeighbor) && (bedDepth[southNeighbor!] ?? 0) !== myDepth) {
      contour(project(x, y + 1, elevation), project(x + 1, y + 1, elevation), southNeighbor!);
    }
  }

  function paintTerrain(ctx: CanvasRenderingContext2D, x: number, y: number, state: GameState, dark: boolean): void {
    const terrain = at(state, x, y) ?? 'plain';
    const elevation = heightAt(state, x, y);
    /*
     * 岸壁只到**水面**，不扎到河床（2026-11-23 撤回上一版）。
     *
     * 上一版让岸壁扎到河床，深水的岸一下变成十几格高的陡墙——那是把
     * "河床有高差"错误地画成了"河岸有高差"。水面齐平之后，深浅只由
     * 水色和分界线表达，岸就是水岸。
     */
    const south = heightAt(state, x, y + 1);
    const east = heightAt(state, x + 1, y);
    if (elevation > east) {
      const points = paintCliffFace(ctx, terrain, x + 1, y, x + 1, y + 1, elevation, east, 'east', at(state, x + 1, y), dark);
      faces.push({ cell: { x, y }, points });
    }
    if (elevation > south) {
      const points = paintCliffFace(ctx, terrain, x, y + 1, x + 1, y + 1, elevation, south, 'south', at(state, x, y + 1), dark);
      faces.push({ cell: { x, y }, points });
    }

    if (terrain === 'plain') {
      paintPlainArt(ctx, x, y, elevation, state);
    } else if (terrain === 'hill') {
      paintHillArt(ctx, x, y, elevation, state);
    } else if (terrain === 'forest') {
      paintForestArt(ctx, x, y, elevation, state);
    } else if (terrain === 'mountain') {
      paintMountainArt(ctx, x, y, elevation, state);
    } else if (terrain === 'bridge') {
      paintBridgeArt(ctx, x, y, elevation, state);
    } else {
      polygon(ctx, rhombus(x, y, 1, elevation), colors[terrain] ?? colors.plain!, '#34422a27');
    }
    if (dark) polygon(ctx, rhombus(x, y, 1, elevation), '#17232b47');
  }

  const teams = { A: '#a64b40', B: '#356689', C: '#53714c', D: '#99722d' };

  function paintCity(
    ctx: CanvasRenderingContext2D, city: City, texture: HTMLImageElement, target: boolean, selected: boolean, dark: boolean,
  ): void {
    const x = city.x + 0.12;
    const y = city.y + 0.12;
    const width = city.size - 0.24;
    const base = rhombus(x, y, width, 0);
    const roof = rhombus(x, y, width, city.ruined ? 4 : 13);
    const team = teams[city.owner];
    polygon(ctx, [roof[1]!, roof[2]!, base[2]!, base[1]!], '#625844', '#473e31');
    polygon(ctx, [roof[3]!, roof[2]!, base[2]!, base[3]!], '#94856a', '#473e31');
    const outline = selected ? '#174d76' : target ? '#aa3b31' : team;
    polygon(ctx, roof, '#d6c49a', outline);

    if (texture.complete && texture.naturalWidth) {
      ctx.save();
      ctx.clip();
      ctx.transform(halfWidth, halfHeight, -halfWidth, halfHeight, ...roof[0]!);
      ctx.drawImage(texture, 0, 0, width, width);
      ctx.restore();
    }
    if (dark) polygon(ctx, roof, '#17232b47');
    ctx.lineWidth = target || selected ? 3.4 : 2.4;
    ctx.strokeStyle = outline;
    ctx.stroke();
    faces.push({ cell: { x: city.x, y: city.y }, points: roof });
  }

  function paintUnit(ctx: CanvasRenderingContext2D, unit: Unit, state: GameState, selected: boolean, target: boolean): void {
    const def = state.unitTypes[unit.type]!;
    const center = (def.footprint ?? 1) / 2;
    const [x, y] = project(unit.x + center, unit.y + center,
      heightAt(state, unit.x, unit.y) + (isAirborne(state, unit) ? 9 : 0));
    ctx.fillStyle = '#352e2460';
    ctx.beginPath();
    ctx.ellipse(x, y + 1, 11, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x - 13, y - 28, 26, 25, 4);
    ctx.fillStyle = selected ? '#dceff6' : target ? '#fae8df' : '#f9f3df';
    ctx.fill();
    ctx.strokeStyle = selected ? '#23678d' : target ? '#b93831' : teams[unit.owner];
    ctx.lineWidth = selected || target ? 3 : 2.1;
    ctx.stroke();
    ctx.fillStyle = teams[unit.owner];
    ctx.fillRect(x - 8, y - 26, 16, 2);
    ctx.fillStyle = '#262a22';
    ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.short, x, y - 14);
    ctx.fillStyle = '#ddd1b5';
    ctx.fillRect(x - 9, y - 7, 18, 2);
    ctx.fillStyle = unit.hp * 2 > def.maxHp ? '#55906a' : '#ba623f';
    ctx.fillRect(x - 9, y - 7, 18 * Math.max(0, Math.min(1, unit.hp / def.maxHp)), 2);
    faces.push({ cell: { x: unit.x, y: unit.y }, points: [[x - 13, y - 28], [x + 13, y - 28], [x + 13, y - 3], [x - 13, y - 3]] });
  }

  const roofs = ['bronze', 'iron', 'gunpowder', 'steam', 'mechanized', 'info', 'armor', 'fusion'];
  const textures = new Map<string, HTMLImageElement>();
  function cityTexture(era: number): HTMLImageElement {
    const name = roofs[era - 1] ?? 'iron';
    const existing = textures.get(name);
    if (existing) return existing;
    const texture = canvas.ownerDocument.createElement('img');
    textures.set(name, texture);
    texture.addEventListener('load', () => {
      if (latest && !canvas.hidden) draw(latest.view, latest.ui);
    }, { once: true });
    texture.src = new URL('art/terrain/city-' + name + '.webp', assetBase).href;
    return texture;
  }

  // 离屏静态前景层（陆地/山林/桥梁/城池/单位/迷雾/高亮）：状态变化时仅重绘一次，
  // 动画帧只重绘水体格 + 一次 drawImage 合成，大地图也能保持 30fps 丝滑低耗。
  const staticCanvas = canvas.ownerDocument.createElement('canvas');
  const staticCtx = staticCanvas.getContext('2d');
  let waterCells: AnimatedWaterCell[] = [];
  let cachedBottom: Point[] = [];
  let rafId = 0;
  let lastFrameAt = 0;
  const animOrigin = typeof performance !== 'undefined' ? performance.now() : 0;

  function stopAnimation(): void {
    const win = canvas.ownerDocument.defaultView;
    if (rafId && win && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(rafId);
    }
    rafId = 0;
  }

  function canAnimateWater(state: GameState): boolean {
    if (waterCells.length === 0) return false;
    if (state.w * state.h > 1024) return false;
    const win = canvas.ownerDocument.defaultView;
    if (!win || typeof win.requestAnimationFrame !== 'function') return false;
    if (typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return false;
    }
    return true;
  }

  function renderWaterFrame(timeSec: number): void {
    if (!paintedState || !staticCtx) return;
    const scaleX = canvas.width / scene.w;
    const scaleY = canvas.height / scene.h;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.clearRect(0, 0, scene.w, scene.h);

    // 1. 棋盘底影与底座
    polygon(ctx, cachedBottom.map(([bx, by]) => [bx + 4, by + 9]), '#62564424');
    polygon(ctx, cachedBottom, '#736953');

    // 2. 动态水体与外沿水柱剖面
    for (const cell of waterCells) {
      if (cell.eastEdge) {
        paintWaterCutawayFace(ctx, cell.terrain, cell.x + 1, cell.y, cell.x + 1, cell.y + 1, 'east', cell.dark, timeSec);
      }
      if (cell.southEdge) {
        paintWaterCutawayFace(ctx, cell.terrain, cell.x, cell.y + 1, cell.x + 1, cell.y + 1, 'south', cell.dark, timeSec);
      }
      paintWaterArt(ctx, cell.x, cell.y, cell.terrain, paintedState, cell.meta, timeSec);
    }

    // 3. 一次性合成静态陆地、树冠、山峰、桥梁、城池、单位、迷雾与战术高亮
    ctx.drawImage(staticCanvas, 0, 0, scene.w, scene.h);
  }

  function scheduleWaterTick(): void {
    const win = canvas.ownerDocument.defaultView;
    if (!win || typeof win.requestAnimationFrame !== 'function' || rafId) return;
    const tick = (now: number): void => {
      rafId = 0;
      if (!paintedState || !canvas.isConnected || canvas.hidden || !canAnimateWater(paintedState)) return;
      if (!canvas.ownerDocument.hidden && now - lastFrameAt >= 32) {
        lastFrameAt = now;
        renderWaterFrame((now - animOrigin) / 1000);
      }
      rafId = win.requestAnimationFrame(tick);
    };
    rafId = win.requestAnimationFrame(tick);
  }

  function draw(view: PlayerView, ui?: BoardUi): void {
    latest = { view, ui };
    const state = view.state;
    originX = state.h * halfWidth + 26;
    scene = angledBoardSize(state.w, state.h);
    const resolution = Math.min(2, Math.sqrt(8_000_000 / (scene.w * scene.h)));
    const width = Math.ceil(scene.w * resolution);
    const height = Math.ceil(scene.h * resolution);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const useLayerCache = Boolean(staticCtx);
    const targetCtx = useLayerCache ? staticCtx! : ctx;
    if (useLayerCache) {
      if (staticCanvas.width !== width) staticCanvas.width = width;
      if (staticCanvas.height !== height) staticCanvas.height = height;
    }
    targetCtx.setTransform(width / scene.w, 0, 0, height / scene.h, 0, 0);
    targetCtx.clearRect(0, 0, scene.w, scene.h);
    faces = [];
    waterCells = [];

    const visible = new Set(view.visible);
    const terrain = view.terrainHidden
      ? {
          ...state,
          tiles: state.tiles.map((tile, index) => visible.has(index)
            ? tile : { ...tile, terrain: view.rememberedTiles.get(index) ?? 'void' as const }),
        }
      : state;
    paintedState = terrain;
    const waterField = analyzeWater(terrain);

    const moves = new Set(ui?.reach);
    const places = new Set(ui?.placeable);
    const aims = new Set(ui?.aimTiles);
    const attacks = new Set(ui?.targets);
    const sieges = new Set(ui?.siegeTargets);
    const cities = new Map<number, City>();
    for (const city of state.cities) {
      const known = !view.terrainHidden || cityTiles(city).some(({ x, y }) => visible.has(y * state.w + x));
      const memory = known ? undefined : view.rememberedCities.get(city.id);
      if (!known && !memory) continue;
      const rendered = memory ? { ...city, owner: memory.owner, era: memory.era, ruined: memory.ruined } : city;
      cities.set((city.y + city.size - 1) * state.w + city.x + city.size - 1, rendered);
    }
    const units = new Map<number, Unit[]>();
    for (const unit of state.units) {
      if (!state.unitTypes[unit.type]) continue;
      const key = unit.y * state.w + unit.x;
      const group = units.get(key);
      if (group) group.push(unit);
      else units.set(key, [unit]);
    }

    cachedBottom = [project(0, 0, boardFloor), project(state.w, 0, boardFloor),
      project(state.w, state.h, boardFloor), project(0, state.h, boardFloor)];
    if (!useLayerCache) {
      polygon(targetCtx, cachedBottom.map(([bx, by]) => [bx + 4, by + 9]), '#62564424');
      polygon(targetCtx, cachedBottom, '#736953');
    }

    const nowSec = typeof performance !== 'undefined' ? (performance.now() - animOrigin) / 1000 : 0;

    for (let diagonal = 0; diagonal < state.w + state.h - 1; diagonal++) {
      for (let y = Math.max(0, diagonal - state.w + 1); y <= Math.min(state.h - 1, diagonal); y++) {
        const x = diagonal - y;
        const index = y * state.w + x;
        const dark = state.fog && !visible.has(index);
        const cellTerrain = at(terrain, x, y) ?? 'plain';
        const elevation = heightAt(terrain, x, y);
        const top = rhombus(x, y, 1, elevation);

        if (isWaterTerrain(cellTerrain)) {
          const meta = waterField.meta[index] ?? {
            kind: 'lake' as const,
            flowX: 0.707,
            flowY: 0.707,
            distToLand: 1,
            phaseCoord: 0,
            shoreMask: 0,
          };
          const eastEdge = x === state.w - 1;
          const southEdge = y === state.h - 1;
          if (eastEdge) {
            faces.push({
              cell: { x, y },
              points: [
                project(x + 1, y, elevation),
                project(x + 1, y + 1, elevation),
                project(x + 1, y + 1, boardFloor),
                project(x + 1, y, boardFloor),
              ],
            });
          }
          if (southEdge) {
            faces.push({
              cell: { x, y },
              points: [
                project(x, y + 1, elevation),
                project(x + 1, y + 1, elevation),
                project(x + 1, y + 1, boardFloor),
                project(x, y + 1, boardFloor),
              ],
            });
          }
          if (useLayerCache) {
            waterCells.push({ x, y, terrain: cellTerrain, dark, eastEdge, southEdge, meta });
            if (dark) polygon(targetCtx, top, '#17232b47');
          } else {
            if (eastEdge) paintWaterCutawayFace(targetCtx, cellTerrain, x + 1, y, x + 1, y + 1, 'east', dark, nowSec);
            if (southEdge) paintWaterCutawayFace(targetCtx, cellTerrain, x, y + 1, x + 1, y + 1, 'south', dark, nowSec);
            paintWaterArt(targetCtx, x, y, cellTerrain, terrain, meta, nowSec);
            if (dark) polygon(targetCtx, top, '#17232b47');
          }
        } else {
          paintTerrain(targetCtx, x, y, terrain, dark);
        }

        faces.push({ cell: { x, y }, points: top });
        if (moves.has(index)) polygon(targetCtx, top, '#3d8ecb62', '#2873a5');
        if (places.has(index) || aims.has(index)) polygon(targetCtx, top, '#e7a34c66', '#ba7830');

        const city = cities.get(index);
        if (city) paintCity(targetCtx, city, cityTexture(city.era), sieges.has(city.id), ui?.selectedCityId === city.id, dark);
        const group = units.get(index);
        if (group) {
          group.sort((a, b) => Number(isAirborne(state, a)) - Number(isAirborne(state, b)));
          for (const unit of group) paintUnit(targetCtx, unit, terrain, ui?.selectedId === unit.id, attacks.has(unit.id));
        }
      }
    }

    if (useLayerCache) {
      const renderTime = canAnimateWater(terrain) ? nowSec : 0;
      renderWaterFrame(renderTime);
      if (canAnimateWater(terrain) && !canvas.hidden) {
        lastFrameAt = typeof performance !== 'undefined' ? performance.now() : 0;
        scheduleWaterTick();
      } else {
        stopAnimation();
      }
    }
  }

  return {
    draw,
    pick(clientX: number, clientY: number): Cell | null {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = (clientX - rect.left) * scene.w / rect.width;
      const y = (clientY - rect.top) * scene.h / rect.height;
      for (let i = faces.length - 1; i >= 0; i--) {
        const face = faces[i]!;
        if (contains(face.points, x, y)) return face.cell;
      }
      return null;
    },
    marker(x: number, y: number, span = 1, lift = 0): Point {
      const level = paintedState ? heightAt(paintedState, Math.floor(x), Math.floor(y)) : 0;
      const [left, top] = project(x + span / 2, y + span / 2, level + lift);
      return [left / scene.w, top / scene.h];
    },
  };
}

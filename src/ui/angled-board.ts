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
  interface WaterBodyInfo {
    kind: WaterBodyKind;
    cells: Array<{ x: number; y: number; terrain: Terrain; meta: WaterCellMeta }>;
    /** 河流：预先沿拉普拉斯流场追踪的跨格连续流线（棋盘浮点坐标） */
    streamlines: Point[][];
    /** 湖泊：加权深水湖心与半径 */
    centerX: number;
    centerY: number;
    maxRadius: number;
    /** 海域：整体涌浪推进方向与投影范围 */
    swellX: number;
    swellY: number;
    minProj: number;
    maxProj: number;
    minPerp: number;
    maxPerp: number;
  }
  interface WaterField {
    key: string;
    meta: Array<WaterCellMeta | null>;
    bodies: WaterBodyInfo[];
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
  let activeWaterBodies: WaterBodyInfo[] = [];

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
    const bodies: WaterBodyInfo[] = [];

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

        const riverFlowX = new Float32Array(total);
        const riverFlowY = new Float32Array(total);
        const bodyCells: WaterBodyInfo['cells'] = [];
        for (const idx of nodes) {
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
          riverFlowX[idx] = gx;
          riverFlowY[idx] = gy;
          if (!isWater[idx]) continue;
          let shoreMask = 0;
          if (cy > 0 && isLand[idx - w]) shoreMask |= 1;
          if (cx + 1 < w && isLand[idx + 1]) shoreMask |= 2;
          if (cy + 1 < h && isLand[idx + w]) shoreMask |= 4;
          if (cx > 0 && isLand[idx - 1]) shoreMask |= 8;
          const cellMeta: WaterCellMeta = {
            kind: 'river',
            flowX: gx,
            flowY: gy,
            distToLand: distLand[idx]!,
            phaseCoord: pHere,
            shoreMask,
          };
          meta[idx] = cellMeta;
          bodyCells.push({ x: cx, y: cy, terrain: at(state, cx, cy) ?? 'water', meta: cellMeta });
        }

        // 沿河道拉普拉斯流场追踪跨格连续流线（RK2 中点积分 + 最小间距排布）
        const sampleFlow = (px: number, py: number): readonly [number, number] | null => {
          const ix = Math.floor(px);
          const iy = Math.floor(py);
          if (ix < 0 || ix >= w || iy < 0 || iy >= h) return null;
          const i0 = iy * w + ix;
          if (compId[i0] !== cid) return null;
          let sx = 0;
          let sy = 0;
          let sw = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const nx = ix + ox;
              const ny = iy + oy;
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              const ni = ny * w + nx;
              if (compId[ni] !== cid) continue;
              const dx = px - (nx + 0.5);
              const dy = py - (ny + 0.5);
              const wt = 1 / (0.18 + dx * dx + dy * dy);
              sx += riverFlowX[ni]! * wt;
              sy += riverFlowY[ni]! * wt;
              sw += wt;
            }
          }
          const l = Math.hypot(sx, sy);
          return l > 0.001 ? [sx / l, sy / l] : null;
        };

        const occW = w * 2;
        const occH = h * 2;
        const occupied = new Uint8Array(occW * occH);
        const isFree = (px: number, py: number): boolean => {
          const ox = Math.floor(px * 2);
          const oy = Math.floor(py * 2);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = ox + dx;
              const ny = oy + dy;
              if (nx >= 0 && nx < occW && ny >= 0 && ny < occH && occupied[ny * occW + nx]) return false;
            }
          }
          return true;
        };
        const markOcc = (px: number, py: number): void => {
          const ox = Math.floor(px * 2);
          const oy = Math.floor(py * 2);
          if (ox >= 0 && ox < occW && oy >= 0 && oy < occH) occupied[oy * occW + ox] = 1;
        };

        // 优先从上游开始播种流线，其次按沿程顺序补全宽河面或分汊
        const sortedNodes = [...nodes].sort((a, b) => phi[a]! - phi[b]!);
        const streamlines: Point[][] = [];
        const maxSteps = Math.max(24, (w + h) * 3);
        for (const seedIdx of sortedNodes) {
          if (!isWater[seedIdx]) continue;
          const sx = (seedIdx % w) + 0.5;
          const sy = ((seedIdx - (seedIdx % w)) / w) + 0.5;
          if (!isFree(sx, sy)) continue;
          const line: Point[] = [[sx, sy]];
          let cx = sx;
          let cy = sy;
          for (let step = 0; step < maxSteps; step++) {
            const v1 = sampleFlow(cx, cy);
            if (!v1) break;
            const mx = cx + v1[0] * 0.22;
            const my = cy + v1[1] * 0.22;
            const v2 = sampleFlow(mx, my) ?? v1;
            const nx = cx + v2[0] * 0.42;
            const ny = cy + v2[1] * 0.42;
            const nix = Math.floor(nx);
            const niy = Math.floor(ny);
            if (nix < 0 || nix >= w || niy < 0 || niy >= h || compId[niy * w + nix] !== cid) break;
            if (step > 2 && Math.hypot(nx - line[line.length - 1]![0], ny - line[line.length - 1]![1]) < 0.08) break;
            line.push([nx, ny]);
            cx = nx;
            cy = ny;
          }
          if (line.length >= 4) {
            for (const [lx, ly] of line) markOcc(lx, ly);
            streamlines.push(line);
          }
        }

        bodies.push({
          kind: 'river',
          cells: bodyCells,
          streamlines,
          centerX: (minX + maxX + 1) * 0.5,
          centerY: (minY + maxY + 1) * 0.5,
          maxRadius: majorSpan * 0.5,
          swellX: 0,
          swellY: 1,
          minProj: 0,
          maxProj: 1,
          minPerp: 0,
          maxPerp: 1,
        });
      } else if (kind === 'lake') {
        // 计算湖泊深水加权中心，用于安静的完整同心涟漪与镜面柔光
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
        const bodyCells: WaterBodyInfo['cells'] = [];
        let maxR = 1;
        for (const idx of nodes) {
          if (!isWater[idx]) continue;
          const cx = idx % w;
          const cy = (idx - cx) / w;
          const rx = cx + 0.5 - centerX;
          const ry = cy + 0.5 - centerY;
          const r = Math.hypot(rx, ry);
          if (r > maxR) maxR = r;
          let shoreMask = 0;
          if (cy > 0 && isLand[idx - w]) shoreMask |= 1;
          if (cx + 1 < w && isLand[idx + 1]) shoreMask |= 2;
          if (cy + 1 < h && isLand[idx + w]) shoreMask |= 4;
          if (cx > 0 && isLand[idx - 1]) shoreMask |= 8;
          const cellMeta: WaterCellMeta = {
            kind: 'lake',
            flowX: r > 0.05 ? rx / r : 0.707,
            flowY: r > 0.05 ? ry / r : 0.707,
            distToLand: distLand[idx]!,
            phaseCoord: r,
            shoreMask,
          };
          meta[idx] = cellMeta;
          bodyCells.push({ x: cx, y: cy, terrain: at(state, cx, cy) ?? 'water', meta: cellMeta });
        }
        bodies.push({
          kind: 'lake',
          cells: bodyCells,
          streamlines: [],
          centerX,
          centerY,
          maxRadius: maxR,
          swellX: 0.707,
          swellY: 0.707,
          minProj: 0,
          maxProj: 1,
          minPerp: 0,
          maxPerp: 1,
        });
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
        const bodyCells: WaterBodyInfo['cells'] = [];
        let sumSx = 0;
        let sumSy = 0;
        for (const idx of nodes) {
          if (!isWater[idx]) continue;
          const cx = idx % w;
          const cy = (idx - cx) / w;
          const dHere = smDist[idx]!;
          const dE = cx + 1 < w ? (compId[idx + 1] === cid ? smDist[idx + 1]! : isLand[idx + 1] ? 0 : dHere) : dHere;
          const dW = cx - 1 >= 0 ? (compId[idx - 1] === cid ? smDist[idx - 1]! : isLand[idx - 1] ? 0 : dHere) : dHere;
          const dS = cy + 1 < h ? (compId[idx + w] === cid ? smDist[idx + w]! : isLand[idx + w] ? 0 : dHere) : dHere;
          const dN = cy - 1 >= 0 ? (compId[idx - w] === cid ? smDist[idx - w]! : isLand[idx - w] ? 0 : dHere) : dHere;
          const nx = dW - dE;
          const ny = dN - dS;
          const nLen = Math.hypot(nx, ny);
          const shoreWeight = Math.max(0, Math.min(0.65, 1.05 - dHere * 0.22));
          let fx = baseSwellX * (1 - shoreWeight) + (nLen > 0.01 ? (nx / nLen) * shoreWeight : baseSwellX * shoreWeight);
          let fy = baseSwellY * (1 - shoreWeight) + (nLen > 0.01 ? (ny / nLen) * shoreWeight : baseSwellY * shoreWeight);
          const fLen = Math.hypot(fx, fy) || 1;
          fx /= fLen;
          fy /= fLen;
          sumSx += fx;
          sumSy += fy;
          let shoreMask = 0;
          if (cy > 0 && isLand[idx - w]) shoreMask |= 1;
          if (cx + 1 < w && isLand[idx + 1]) shoreMask |= 2;
          if (cy + 1 < h && isLand[idx + w]) shoreMask |= 4;
          if (cx > 0 && isLand[idx - 1]) shoreMask |= 8;
          const cellMeta: WaterCellMeta = {
            kind: 'sea',
            flowX: fx,
            flowY: fy,
            distToLand: dHere,
            phaseCoord: cx * baseSwellX + cy * baseSwellY,
            shoreMask,
          };
          meta[idx] = cellMeta;
          bodyCells.push({ x: cx, y: cy, terrain: at(state, cx, cy) ?? 'water', meta: cellMeta });
        }
        const sLen = Math.hypot(sumSx, sumSy);
        const swellX = sLen > 0.01 ? sumSx / sLen : baseSwellX;
        const swellY = sLen > 0.01 ? sumSy / sLen : baseSwellY;
        const perpX = -swellY;
        const perpY = swellX;
        let minProj = Infinity;
        let maxProj = -Infinity;
        let minPerp = Infinity;
        let maxPerp = -Infinity;
        for (const c of bodyCells) {
          const p = (c.x + 0.5) * swellX + (c.y + 0.5) * swellY;
          const q = (c.x + 0.5) * perpX + (c.y + 0.5) * perpY;
          if (p < minProj) minProj = p;
          if (p > maxProj) maxProj = p;
          if (q < minPerp) minPerp = q;
          if (q > maxPerp) maxPerp = q;
        }
        bodies.push({
          kind: 'sea',
          cells: bodyCells,
          streamlines: [],
          centerX: (minX + maxX + 1) * 0.5,
          centerY: (minY + maxY + 1) * 0.5,
          maxRadius: majorSpan * 0.5,
          swellX,
          swellY,
          minProj,
          maxProj,
          minPerp,
          maxPerp,
        });
      }
    }

    cachedWaterField = { key: sig, meta, bodies };
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
  /**
   * 水体底层（每格独立）：三档清透水色、柔和水下等深坡带、浅流水下沙洲/鹅卵石与岸壁柔和落影。
   * 刻意不在单格内画零碎短白线，表面光影与流动交由 `paintWaterBodyFlow` 在整片水体上连续绘制。
   */
  function paintWaterBaseTile(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    terrain: Terrain,
    state: GameState,
    meta: WaterCellMeta,
  ): void {
    const h = tileHash(x, y, 71);
    const elevation = WATER_SURFACE;
    const pt = (u: number, v: number, dz = 0): Point => project(x + u, y + v, elevation + dz);
    const top = rhombus(x, y, 1, elevation);

    // 1. 三档水体柔和跨格底色
    const wWave = Math.sin(x * 0.55 + y * 0.48) + Math.cos(x * 0.36 - y * 0.52);
    const baseFill = terrain === 'shallow'
      ? (wWave > 0.55 ? '#afd6cb' : wWave < -0.55 ? '#a6cfc4' : '#abd3c8')
      : terrain === 'deep'
        ? (wWave > 0.55 ? '#5383a5' : wWave < -0.55 ? '#4b7b9d' : '#4f7fa1')
        : (wWave > 0.55 ? '#90bdd3' : wWave < -0.55 ? '#88b5cd' : '#8cb9d0');
    polygon(ctx, top, baseFill);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(...top[0]!);
    ctx.lineTo(...top[1]!);
    ctx.lineTo(...top[2]!);
    ctx.lineTo(...top[3]!);
    ctx.closePath();
    ctx.clip();

    // 2. 深浅水体之间的三层羽化过渡坡带（浅流 ↔ 水域 ↔ 深水）
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
      band(0.30, 0.14);
      band(0.17, 0.21);
      band(0.08, 0.26);
    };
    paintDepthSlope('n', at(state, x, y - 1));
    paintDepthSlope('e', at(state, x + 1, y));
    paintDepthSlope('s', at(state, x, y + 1));
    paintDepthSlope('w', at(state, x - 1, y));

    // 3. 浅流专属水下沙洲与隐约鹅卵石（柔和低反差，自然传达可涉水浅滩）
    if (terrain === 'shallow') {
      if ((h % 7) < 4) {
        const su = 0.28 + ((h >>> 3) % 34) * 0.01;
        const sv = 0.28 + ((h >>> 8) % 34) * 0.01;
        const sr = 0.20 + ((h >>> 13) % 9) * 0.01;
        polygon(ctx, [
          pt(su - sr, sv),
          pt(su, sv - sr * 0.85),
          pt(su + sr, sv),
          pt(su, sv + sr * 0.85),
        ], '#d4e4ca38');
      }
      if ((h % 6) < 2) {
        const pu = 0.28 + ((h >>> 5) % 42) * 0.01;
        const pv = 0.28 + ((h >>> 10) % 40) * 0.01;
        const [px, py] = pt(pu, pv);
        polygon(ctx, [[px - 2.4, py + 0.4], [px - 0.5, py - 1.0], [px + 1.6, py - 0.4], [px + 0.7, py + 1.1]], '#7da79d4e');
        polygon(ctx, [[px - 1.6, py - 0.2], [px - 0.4, py - 0.9], [px + 0.7, py - 0.3], [px - 0.2, py + 0.2]], '#cde3d944');
      }
    }

    // 4. 西北/东北岸壁柔和双层羽化落影（增强水体嵌入陆地的立体自然感）
    if (meta.shoreMask & 8) {
      polygon(ctx, [pt(0, 0), pt(0.24, 0), pt(0.24, 1), pt(0, 1)], 'rgba(35,69,91,0.10)');
      polygon(ctx, [pt(0, 0), pt(0.11, 0), pt(0.11, 1), pt(0, 1)], 'rgba(35,69,91,0.14)');
    }
    if (meta.shoreMask & 1) {
      polygon(ctx, [pt(0, 0), pt(1, 0), pt(1, 0.24), pt(0, 0.24)], 'rgba(35,69,91,0.09)');
      polygon(ctx, [pt(0, 0), pt(1, 0), pt(1, 0.11), pt(0, 0.11)], 'rgba(35,69,91,0.12)');
    }

    ctx.restore();
  }

  /**
   * 整片水体连续光影与流动动画（参照《陷阵之志》《筑梦颂》《三角战略》等主流作品处理方式）：
   * 将连通水体合为单一裁切轮廓，统一绘制跨格连续的柔和光晕、顺滑流带与克制高光，
   * 彻底告别“每格一条硬白线”的碎裂感：
   * - 河（river）：沿平滑连续流线缓缓流淌的柔光水带 + 稀疏细柔丝光；
   * - 湖（lake）：大面积镜面天光柔晕 + 轻盈舒缓的完整同心椭圆微涟漪；
   * - 海（sea）：跨整片海域连续起伏的柔和涌浪明暗带 + 疏朗柔美浪脊 + 羽化拍岸潮汐。
   */
  function paintWaterBodyFlow(ctx: CanvasRenderingContext2D, body: WaterBodyInfo, timeSec: number): void {
    if (body.cells.length === 0) return;
    const elevation = WATER_SURFACE;

    ctx.save();
    // 构建整片连通水体的统一裁切轮廓（零格间截断）
    ctx.beginPath();
    for (const c of body.cells) {
      const top = rhombus(c.x, c.y, 1, elevation);
      ctx.moveTo(...top[0]!);
      ctx.lineTo(...top[1]!);
      ctx.lineTo(...top[2]!);
      ctx.lineTo(...top[3]!);
      ctx.closePath();
    }
    ctx.clip();

    const traceSmoothPolyline = (pts: readonly Point[]): void => {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(...pts[0]!);
      for (let i = 1; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i]!;
        const [x2, y2] = pts[i + 1]!;
        ctx.quadraticCurveTo(x1, y1, (x1 + x2) * 0.5, (y1 + y2) * 0.5);
      }
      ctx.lineTo(...pts[pts.length - 1]!);
    };

    if (body.kind === 'river') {
      // —— 河（River）：连续丝滑水流柔光带 + 稀疏细柔顺流高光 ——
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let si = 0; si < body.streamlines.length; si++) {
        const raw = body.streamlines[si]!;
        const screenPts: Point[] = raw.map(([gx, gy], k) => {
          // 轻微的慢速横向水波摆动，让流线像活水一样柔顺呼吸
          const sway = Math.sin(k * 0.55 - timeSec * 1.1 + si * 1.7) * 0.045;
          return project(gx + sway, gy - sway * 0.6, elevation);
        });

        // 1. 宽柔水下流道光晕（极低不透明度，柔和勾勒主流走势）
        traceSmoothPolyline(screenPts);
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(222,247,250,0.085)';
        ctx.lineWidth = 5.2;
        ctx.stroke();

        // 2. 中宽顺流柔光丝带（长段、长间距、柔透明度，流畅跨格滑行）
        traceSmoothPolyline(screenPts);
        ctx.setLineDash([26, 44]);
        ctx.lineDashOffset = -(timeSec * 14.5 + si * 23);
        ctx.strokeStyle = 'rgba(234,250,253,0.165)';
        ctx.lineWidth = 2.4;
        ctx.stroke();

        // 3. 稀疏纤细日光丝纹（克制点缀，不密集不刺眼）
        traceSmoothPolyline(screenPts);
        ctx.setLineDash([11, 76]);
        ctx.lineDashOffset = -(timeSec * 18.5 + si * 39 + 17);
        ctx.strokeStyle = 'rgba(248,254,255,0.26)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 浅滩处极柔和的水底焦散微光斑（仅少量格、极软径向渐变）
      for (const c of body.cells) {
        if (c.terrain !== 'shallow') continue;
        const h = tileHash(c.x, c.y, 97);
        if ((h % 4) !== 0) continue;
        const pulse = 0.5 + 0.5 * Math.sin(timeSec * 1.6 + (h % 29) * 0.5);
        const [gx, gy] = project(
          c.x + 0.5 + c.meta.flowX * Math.sin(timeSec * 0.9 + h) * 0.14,
          c.y + 0.5 + c.meta.flowY * Math.sin(timeSec * 0.9 + h) * 0.14,
          elevation,
        );
        const r = 8.5 + pulse * 3.0;
        const grad = ctx.createRadialGradient(gx, gy, 0.5, gx, gy, r);
        grad.addColorStop(0, `rgba(242,253,251,${(0.11 + pulse * 0.08).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(242,253,251,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(gx, gy, r, r * 0.58, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (body.kind === 'lake') {
      // —— 湖（Lake）：镜面天光柔晕 + 舒缓完整的同心椭圆微涟漪 ——
      const [scx, scy] = project(body.centerX, body.centerY, elevation);
      const maxR = Math.max(1.8, body.maxRadius);

      // 1. 湖面大尺度天光镜面柔晕（3 处缓慢呼吸的羽化椭圆光池）
      for (let pi = 0; pi < 3; pi++) {
        const ang = pi * 2.1 + timeSec * 0.12;
        const dist = maxR * (pi === 0 ? 0.12 : 0.34);
        const [px, py] = project(
          body.centerX + Math.cos(ang) * dist,
          body.centerY + Math.sin(ang) * dist,
          elevation,
        );
        const breath = 0.5 + 0.5 * Math.sin(timeSec * 0.75 + pi * 2.2);
        const rad = Math.max(24, maxR * halfWidth * (pi === 0 ? 0.62 : 0.44));
        const grad = ctx.createRadialGradient(px, py, 2, px, py, rad);
        grad.addColorStop(0, `rgba(238,250,253,${(0.09 + breath * 0.06).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(225,245,250,${(0.04 + breath * 0.03).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(225,245,250,0)');
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(1, halfHeight / halfWidth);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 2. 完整舒缓的同心椭圆微涟漪（由湖心极慢外扩，渐现渐隐、自然断续）
      const ringCount = 3;
      for (let ri = 0; ri < ringCount; ri++) {
        const rawP = (timeSec * 0.13 + ri / ringCount) % 1;
        const fade = Math.sin(rawP * Math.PI);
        if (fade < 0.06) continue;
        const tileR = 0.45 + rawP * (maxR + 0.8);
        const rx = tileR * halfWidth * 1.15;
        const ry = tileR * halfHeight * 1.15;

        // 外围极柔光晕环
        ctx.beginPath();
        ctx.ellipse(scx, scy, rx, ry, 0, 0, Math.PI * 2);
        ctx.setLineDash([]);
        ctx.strokeStyle = `rgba(232,249,253,${(0.07 * fade).toFixed(3)})`;
        ctx.lineWidth = 3.0;
        ctx.stroke();

        // 轻盈断续的微风涟漪细弧（打破死板几何靶心感）
        ctx.beginPath();
        ctx.ellipse(scx, scy, rx, ry, 0, 0, Math.PI * 2);
        ctx.setLineDash([18, 30]);
        ctx.lineDashOffset = ri * 17 + timeSec * 2.2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(246,253,255,${(0.19 * fade).toFixed(3)})`;
        ctx.lineWidth = 0.85;
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 3. 零星几道极淡的静湖镜面浮光（远低于单格密度，静谧自然）
      const glintCount = Math.min(6, Math.max(2, Math.round(body.cells.length / 12)));
      for (let gi = 0; gi < glintCount; gi++) {
        const cell = body.cells[(gi * 11 + 3) % body.cells.length]!;
        const pulse = 0.5 + 0.5 * Math.sin(timeSec * 1.15 + gi * 1.9);
        if (pulse < 0.25) continue;
        const [gx, gy] = project(cell.x + 0.5, cell.y + 0.5, elevation);
        const len = 4.5 + pulse * 4.5;
        const alpha = (pulse - 0.25) * 0.28;
        strokeLine(ctx, [gx - len, gy], [gx + len, gy], `rgba(248,254,255,${alpha.toFixed(3)})`, 0.9);
      }
    } else {
      // —— 海（Sea）：整海连续舒缓涌浪波带 + 疏朗柔美浪脊 ——
      const sx = body.swellX;
      const sy = body.swellY;
      const px = -sy;
      const py = sx;
      const wavelength = 2.9;
      const travel = (timeSec * 0.34) % wavelength;
      const startProj = body.minProj - wavelength + travel;
      const endProj = body.maxProj + wavelength;
      const perpStart = body.minPerp - 1.2;
      const perpEnd = body.maxPerp + 1.2;
      const perpStep = 0.7;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      let waveIdx = 0;
      for (let proj = startProj; proj <= endProj; proj += wavelength, waveIdx++) {
        const crestPts: Point[] = [];
        const troughPts: Point[] = [];
        for (let q = perpStart; q <= perpEnd; q += perpStep) {
          const undulate = Math.sin(q * 0.62 + timeSec * 0.58 + waveIdx * 0.8) * 0.28;
          const pCur = proj + undulate;
          const gx = sx * pCur + px * q;
          const gy = sy * pCur + py * q;
          crestPts.push(project(gx, gy, elevation));
          const pTr = pCur - wavelength * 0.46;
          troughPts.push(project(sx * pTr + px * q, sy * pTr + py * q, elevation));
        }

        // 1. 宽幅柔和波谷暗带（无格间断层）
        traceSmoothPolyline(troughPts);
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(24,58,84,0.08)';
        ctx.lineWidth = 12;
        ctx.stroke();

        // 2. 宽幅柔和迎光涌浪面（自然羽化的斜向海浪体积感）
        traceSmoothPolyline(crestPts);
        ctx.strokeStyle = 'rgba(222,245,253,0.085)';
        ctx.lineWidth = 13.5;
        ctx.stroke();

        // 3. 涌浪顶部疏朗柔美的起伏白沫浪脊（非满屏白线，随波自然聚散）
        const crestGap = 2.9;
        const lateralShift = ((waveIdx * 1.37) % crestGap);
        for (let q = perpStart + lateralShift; q <= perpEnd; q += crestGap) {
          const bloom = Math.sin(q * 0.9 + timeSec * 0.85 + waveIdx * 1.6) ** 2;
          if (bloom < 0.24) continue;
          const vis = (bloom - 0.24) / 0.76;
          const undulate = Math.sin(q * 0.62 + timeSec * 0.58 + waveIdx * 0.8) * 0.28;
          const pCur = proj + undulate;
          const halfSpan = 0.55 + vis * 0.35;
          const pL = project(sx * (pCur - 0.08) + px * (q - halfSpan), sy * (pCur - 0.08) + py * (q - halfSpan), elevation);
          const pM = project(sx * (pCur + 0.10) + px * q, sy * (pCur + 0.10) + py * q, elevation);
          const pR = project(sx * (pCur - 0.08) + px * (q + halfSpan), sy * (pCur - 0.08) + py * (q + halfSpan), elevation);

          // 柔光羽化底
          ctx.beginPath();
          ctx.moveTo(...pL);
          ctx.quadraticCurveTo(...pM, ...pR);
          ctx.strokeStyle = `rgba(228,246,253,${(0.13 * vis).toFixed(3)})`;
          ctx.lineWidth = 3.0;
          ctx.stroke();

          // 轻盈浪脊亮丝
          ctx.beginPath();
          ctx.moveTo(...pL);
          ctx.quadraticCurveTo(...pM, ...pR);
          ctx.strokeStyle = `rgba(247,253,255,${(0.29 * vis).toFixed(3)})`;
          ctx.lineWidth = 1.05;
          ctx.stroke();
        }
      }
    }

    // 统一柔和岸边浪晕（在整片水体裁切内绘制，避免硬白条框死每格）
    ctx.lineCap = 'round';
    for (const c of body.cells) {
      if (!c.meta.shoreMask) continue;
      const pt = (u: number, v: number): Point => project(c.x + u, c.y + v, elevation);
      const paintShore = (bit: number, a0: [number, number], b0: [number, number], inU: number, inV: number): void => {
        if (!(c.meta.shoreMask & bit)) return;
        const shorePhase = c.x * 0.75 + c.y * 0.95 + bit * 0.35;
        const wave = body.kind === 'sea'
          ? 0.5 + 0.5 * Math.sin(timeSec * 1.75 - shorePhase * 0.55)
          : body.kind === 'river'
            ? 0.5 + 0.5 * Math.sin(timeSec * 1.9 + c.meta.phaseCoord * 2.0)
            : 0.5 + 0.5 * Math.sin(timeSec * 1.05 + shorePhase * 0.45);
        const offset = body.kind === 'sea'
          ? 0.045 + wave * 0.07
          : body.kind === 'river'
            ? 0.045 + wave * 0.018
            : 0.042 + wave * 0.025;
        const p1 = pt(a0[0] + inU * offset, a0[1] + inV * offset);
        const p2 = pt(b0[0] + inU * offset, b0[1] + inV * offset);

        // 外层柔和浅水浪晕（自然晕开，消除锐利贴纸边）
        const washAlpha = body.kind === 'sea' ? 0.11 + wave * 0.08 : 0.09 + wave * 0.04;
        strokeLine(ctx, p1, p2, `rgba(235,250,252,${washAlpha.toFixed(3)})`, body.kind === 'sea' ? 3.4 : 2.6);

        // 内层克制柔白水缘线
        const rimAlpha = body.kind === 'sea'
          ? 0.20 + wave * 0.18
          : body.kind === 'river'
            ? 0.15 + wave * 0.10
            : 0.13 + wave * 0.09;
        strokeLine(ctx, p1, p2, `rgba(247,253,254,${rimAlpha.toFixed(3)})`, body.kind === 'sea' ? 1.05 : 0.85);

        // 海域独有：淡淡的退潮第二层水晕
        if (body.kind === 'sea') {
          const offset2 = offset + 0.09;
          const q1 = pt(a0[0] + inU * offset2, a0[1] + inV * offset2);
          const q2 = pt(b0[0] + inU * offset2, b0[1] + inV * offset2);
          strokeLine(ctx, q1, q2, `rgba(230,247,252,${(0.14 * (1 - wave * 0.45)).toFixed(3)})`, 1.4);
        }
      };
      paintShore(1, [0.02, 0], [0.98, 0], 0, 1);
      paintShore(2, [1, 0.02], [1, 0.98], -1, 0);
      paintShore(4, [0.02, 1], [0.98, 1], 0, -1);
      paintShore(8, [0, 0.02], [0, 0.98], 1, 0);
    }

    ctx.restore();
  }

  /** 水体表面极淡战术格线与柔和等深分界线 */
  function paintWaterGridAndContours(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    terrain: Terrain,
    state: GameState,
  ): void {
    const elevation = WATER_SURFACE;
    const top = rhombus(x, y, 1, elevation);
    ctx.beginPath();
    ctx.moveTo(...top[0]!);
    ctx.lineTo(...top[1]!);
    ctx.lineTo(...top[2]!);
    ctx.lineTo(...top[3]!);
    ctx.closePath();
    ctx.strokeStyle = terrain === 'deep' ? '#d8eef811' : '#f2fafb16';
    ctx.lineWidth = 0.7;
    ctx.stroke();

    const myDepth = bedDepth[terrain] ?? 4;
    const contour = (a: Point, b: Point, other: Terrain): void => {
      const deepBoundary = terrain === 'deep' || other === 'deep';
      strokeLine(ctx, a, b, deepBoundary ? '#2f597828' : '#588d9224', 0.85);
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
  const teamTints = { A: '#c46357', B: '#4e84ab', C: '#6c8f64', D: '#b88f42' };

  type CityPt = (u: number, v: number, dz?: number) => Point;

  /** 斜俯视 3D 方体建筑块（严格西北受光、东南背光） */
  function isoBox(
    ctx: CanvasRenderingContext2D,
    pt: CityPt,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    z0: number,
    z1: number,
    topCol: string,
    eastCol: string,
    southCol: string,
    edgeCol?: string,
  ): void {
    const bNE = pt(u1, v0, z0);
    const bSE = pt(u1, v1, z0);
    const bSW = pt(u0, v1, z0);
    const tNW = pt(u0, v0, z1);
    const tNE = pt(u1, v0, z1);
    const tSE = pt(u1, v1, z1);
    const tSW = pt(u0, v1, z1);
    polygon(ctx, [tNE, tSE, bSE, bNE], eastCol, edgeCol, 0.7);
    polygon(ctx, [tSW, tSE, bSE, bSW], southCol, edgeCol, 0.7);
    polygon(ctx, [tNW, tNE, tSE, tSW], topCol, edgeCol, 0.7);
  }

  /** 斜俯视 3D 双坡顶房屋（带山墙面与受光/背光双坡屋面） */
  function isoGable(
    ctx: CanvasRenderingContext2D,
    pt: CityPt,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    z0: number,
    wallH: number,
    roofH: number,
    ridgeAlongU: boolean,
    wallE: string,
    wallS: string,
    roofLit: string,
    roofShade: string,
    edgeCol = '#3b342848',
  ): void {
    const zW = z0 + wallH;
    const zR = zW + roofH;
    const bNE = pt(u1, v0, z0);
    const bSE = pt(u1, v1, z0);
    const bSW = pt(u0, v1, z0);
    const tNW = pt(u0, v0, zW);
    const tNE = pt(u1, v0, zW);
    const tSE = pt(u1, v1, zW);
    const tSW = pt(u0, v1, zW);

    // 墙体立面
    polygon(ctx, [tNE, tSE, bSE, bNE], wallE, edgeCol, 0.65);
    polygon(ctx, [tSW, tSE, bSE, bSW], wallS, edgeCol, 0.65);

    if (ridgeAlongU) {
      const vm = (v0 + v1) * 0.5;
      const rW = pt(u0, vm, zR);
      const rE = pt(u1, vm, zR);
      // 东侧山墙三角
      polygon(ctx, [tNE, tSE, rE], wallE, edgeCol, 0.6);
      // 西北受光坡面 + 东南背光坡面
      polygon(ctx, [tNW, tNE, rE, rW], roofLit, edgeCol, 0.65);
      polygon(ctx, [rW, rE, tSE, tSW], roofShade, edgeCol, 0.65);
      strokeLine(ctx, rW, rE, '#ffffff55', 0.85);
    } else {
      const um = (u0 + u1) * 0.5;
      const rN = pt(um, v0, zR);
      const rS = pt(um, v1, zR);
      // 南侧山墙三角
      polygon(ctx, [tSW, tSE, rS], wallS, edgeCol, 0.6);
      // 东北背光坡面 + 西南受光坡面
      polygon(ctx, [rN, tNE, tSE, rS], roofShade, edgeCol, 0.65);
      polygon(ctx, [tNW, rN, rS, tSW], roofLit, edgeCol, 0.65);
      strokeLine(ctx, rN, rS, '#ffffff55', 0.85);
    }
  }

  /** 斜俯视 3D 圆柱/锥台（烟囱、圆塔、水塔、储罐） */
  function isoCylinder(
    ctx: CanvasRenderingContext2D,
    pt: CityPt,
    cu: number,
    cv: number,
    rBot: number,
    rTop: number,
    z0: number,
    z1: number,
    litCol: string,
    midCol: string,
    shadeCol: string,
    topCol: string,
    edgeCol = '#3b342844',
  ): void {
    const segs = 6;
    const bot: Point[] = [];
    const top: Point[] = [];
    for (let i = 0; i < segs; i++) {
      const ang = (i / segs) * Math.PI * 2 + Math.PI / 6;
      bot.push(pt(cu + Math.cos(ang) * rBot, cv + Math.sin(ang) * rBot, z0));
      top.push(pt(cu + Math.cos(ang) * rTop, cv + Math.sin(ang) * rTop, z1));
    }
    // 仅绘朝前的三个可见柱面（按斜俯视投影朝南/东）
    const faceOrder: ReadonlyArray<readonly [number, string]> = [
      [1, litCol],
      [0, midCol],
      [5, shadeCol],
      [2, midCol],
    ];
    for (const [idx, col] of faceOrder) {
      const next = (idx + 1) % segs;
      polygon(ctx, [top[idx]!, top[next]!, bot[next]!, bot[idx]!], col, edgeCol, 0.55);
    }
    polygon(ctx, top, topCol, edgeCol, 0.65);
  }

  /** 斜俯视 3D 圆锥茅草屋/尖顶圆塔 */
  function isoConicalHut(
    ctx: CanvasRenderingContext2D,
    pt: CityPt,
    cu: number,
    cv: number,
    r: number,
    z0: number,
    wallH: number,
    roofH: number,
    wallLit: string,
    wallShade: string,
    roofLit: string,
    roofMid: string,
    roofShade: string,
  ): void {
    const zW = z0 + wallH;
    const apex = pt(cu, cv, zW + roofH);
    const eaveR = r * 1.18;
    const segs = 8;
    const bPts: Point[] = [];
    const wPts: Point[] = [];
    const rPts: Point[] = [];
    for (let i = 0; i < segs; i++) {
      const ang = (i / segs) * Math.PI * 2;
      bPts.push(pt(cu + Math.cos(ang) * r, cv + Math.sin(ang) * r, z0));
      wPts.push(pt(cu + Math.cos(ang) * r, cv + Math.sin(ang) * r, zW));
      rPts.push(pt(cu + Math.cos(ang) * eaveR, cv + Math.sin(ang) * eaveR, zW - 0.3));
    }
    // 矮圆墙（朝前 4 面）
    for (const i of [0, 1, 2, 3]) {
      const n = (i + 1) % segs;
      polygon(ctx, [wPts[i]!, wPts[n]!, bPts[n]!, bPts[i]!], i >= 2 ? wallLit : wallShade, '#4d3b2433', 0.5);
    }
    // 锥形屋顶（由背向前）
    const order = [5, 6, 4, 7, 3, 0, 2, 1];
    for (const i of order) {
      const n = (i + 1) % segs;
      const col = i === 3 || i === 4 || i === 5 ? roofLit : i === 2 || i === 6 ? roofMid : roofShade;
      polygon(ctx, [apex, rPts[i]!, rPts[n]!], col, '#4a3b2226', 0.45);
    }
  }

  /** 阵营旗帜（清晰标识归属而不破坏建筑写实质感） */
  function isoBanner(
    ctx: CanvasRenderingContext2D,
    pt: CityPt,
    u: number,
    v: number,
    z0: number,
    poleH: number,
    teamCol: string,
    lightCol: string,
    rect = false,
  ): void {
    const base = pt(u, v, z0);
    const tip = pt(u, v, z0 + poleH);
    strokeLine(ctx, base, tip, '#4e4232', 1.15);
    if (rect) {
      polygon(ctx, [
        tip,
        [tip[0] + 6.8, tip[1] + 1.0],
        [tip[0] + 5.6, tip[1] + 4.4],
        [tip[0], tip[1] + 4.2],
      ], teamCol, '#2e251c44', 0.55);
      strokeLine(ctx, [tip[0] + 0.6, tip[1] + 1.1], [tip[0] + 5.8, tip[1] + 1.8], lightCol, 0.8);
    } else {
      polygon(ctx, [
        tip,
        [tip[0] + 7.2, tip[1] + 2.0],
        [tip[0], tip[1] + 4.0],
      ], teamCol, '#2e251c44', 0.55);
    }
  }

  /** 废墟城池（所有时代通用残垣断壁） */
  function paintCityRuined(ctx: CanvasRenderingContext2D, pt: CityPt, outline: string): void {
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 2.5, '#aba18e', '#766d5d', '#8e8473', '#49413588');
    polygon(ctx, [pt(0.12, 0.12, 2.55), pt(0.88, 0.12, 2.55), pt(0.88, 0.88, 2.55), pt(0.12, 0.88, 2.55)], '#7b7468');
    // 残破焦土与三处断墙
    polygon(ctx, [pt(0.28, 0.34, 2.6), pt(0.64, 0.24, 2.6), pt(0.74, 0.66, 2.6), pt(0.32, 0.72, 2.6)], '#534d44');
    isoBox(ctx, pt, 0.12, 0.14, 0.44, 0.26, 2.5, 6.4, '#c0b5a1', '#7d7362', '#9c917e', '#49413577');
    isoBox(ctx, pt, 0.62, 0.18, 0.84, 0.42, 2.5, 5.2, '#b5aa96', '#726959', '#8f8472', '#49413577');
    isoBox(ctx, pt, 0.18, 0.62, 0.46, 0.82, 2.5, 4.8, '#b8ad98', '#756c5c', '#938876', '#49413577');
    // 碎石块
    isoBox(ctx, pt, 0.54, 0.56, 0.68, 0.70, 2.5, 3.8, '#c5bba8', '#837967', '#a09582');
    const baseOutline = [pt(0, 0, 2.6), pt(1, 0, 2.6), pt(1, 1, 2.6), pt(0, 1, 2.6)];
    ctx.beginPath();
    ctx.moveTo(...baseOutline[0]!);
    for (const p of baseOutline.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 2.0;
    ctx.stroke();
  }

  /**
   * 时代 1 · 青铜时代（Bronze Age）：
   * 暖土夯土矮台基 + 尖头原木木栅栏围墙 + 夯土茅草大屋 + 三座圆锥顶草庐 + 青铜绿祭坛火鼎，
   * 轮廓低矮质朴，暖黄草色与原木色调极具古拙部落感。
   */
  function paintCityBronze(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 低矮夯土台基与黄土村道
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 3.2, '#d5c08f', '#9a8052', '#b59967', '#66513177');
    polygon(ctx, [pt(0.06, 0.06, 3.25), pt(0.94, 0.06, 3.25), pt(0.94, 0.94, 3.25), pt(0.06, 0.94, 3.25)], '#cbb482');
    // 村内泥土小径
    polygon(ctx, [pt(0.42, 0.12, 3.3), pt(0.56, 0.12, 3.3), pt(0.60, 0.94, 3.3), pt(0.44, 0.94, 3.3)], '#dfd0a5');
    polygon(ctx, [pt(0.10, 0.48, 3.3), pt(0.90, 0.44, 3.3), pt(0.90, 0.58, 3.3), pt(0.10, 0.60, 3.3)], '#dfd0a5');

    // 2. 后排尖头木栅栏（西北与东北两面）
    const drawPalisadeRow = (u0: number, v0: number, u1: number, v1: number, count: number, gapMid = false): void => {
      for (let i = 0; i < count; i++) {
        const f = (i + 0.5) / count;
        if (gapMid && f > 0.36 && f < 0.64) continue;
        const u = u0 + (u1 - u0) * f;
        const v = v0 + (v1 - v0) * f;
        const h = 4.2 + ((i * 7) % 3) * 0.45;
        isoBox(ctx, pt, u - 0.032, v - 0.032, u + 0.032, v + 0.032, 3.2, 3.2 + h, '#a78355', '#684c2d', '#82613b', '#49351e55');
      }
    };
    drawPalisadeRow(0.04, 0.04, 0.96, 0.04, 11);
    drawPalisadeRow(0.04, 0.06, 0.04, 0.94, 10);

    // 3. 部落建筑群（严格按 u+v 由后向前）
    // 3a. 酋长夯土茅草大屋（西北主位）
    isoGable(ctx, pt, 0.14, 0.14, 0.52, 0.42, 3.2, 4.4, 5.2, true, '#a68757', '#bf9f6c', '#e6d39a', '#bfa56b', '#5d472766');
    // 3b. 东北圆锥顶茅草庐
    isoConicalHut(ctx, pt, 0.74, 0.28, 0.13, 3.2, 3.2, 5.2, '#c5a874', '#9a7e4f', '#e7d59c', '#d5be82', '#b39a62');
    // 3c. 西南圆锥顶茅草庐
    isoConicalHut(ctx, pt, 0.26, 0.68, 0.135, 3.2, 3.3, 5.4, '#c7aa76', '#9c8051', '#e5d298', '#d2bb7f', '#b09760');
    // 3d. 中央青铜祭坛与铜鼎火盆（青铜绿特征点睛）
    isoBox(ctx, pt, 0.46, 0.46, 0.62, 0.62, 3.2, 4.4, '#c7b286', '#8d7851', '#a89267', '#5d4b2f55');
    isoCylinder(ctx, pt, 0.54, 0.54, 0.055, 0.065, 4.4, 6.4, '#73b3a4', '#559486', '#3d7367', '#4b8276', '#2a4f4766');
    const [fx, fy] = pt(0.54, 0.54, 6.8);
    polygon(ctx, [[fx - 1.8, fy + 0.5], [fx, fy - 2.4], [fx + 1.8, fy + 0.5]], '#ea8e3d');
    polygon(ctx, [[fx - 0.9, fy + 0.2], [fx, fy - 1.4], [fx + 0.9, fy + 0.2]], '#f7d678');
    // 3e. 东南小茅草屋与木栅栏小院
    isoConicalHut(ctx, pt, 0.76, 0.72, 0.115, 3.2, 2.8, 4.5, '#c1a36f', '#957a4c', '#e2ce94', '#cfb87c', '#ac945c');

    // 4. 前排木栅栏（东南与西南两面，正南留寨门与双门柱）
    drawPalisadeRow(0.96, 0.06, 0.96, 0.94, 10, false);
    drawPalisadeRow(0.06, 0.96, 0.94, 0.96, 11, true);
    // 寨门双原木高柱 + 横梁
    isoBox(ctx, pt, 0.36, 0.92, 0.43, 0.99, 3.2, 9.2, '#9c774a', '#634729', '#7d5b36', '#422e1966');
    isoBox(ctx, pt, 0.57, 0.92, 0.64, 0.99, 3.2, 9.2, '#9c774a', '#634729', '#7d5b36', '#422e1966');
    isoBox(ctx, pt, 0.35, 0.93, 0.65, 0.98, 8.2, 9.5, '#ae8858', '#6b4d2e', '#88653e', '#422e1966');

    // 5. 阵营三角木杆旗
    isoBanner(ctx, pt, 0.34, 0.28, 12.6, 5.8, teamCol, lightCol, false);
  }

  /**
   * 时代 2 · 铁器时代（Iron Age）：
   * 规整黄砂岩垛口城墙 + 四角方形角楼 + 暖赤陶瓦重檐中军主殿 + 规整院落民居，
   * 暖陶橙瓦顶与黄石城郭一眼可与青铜草庐和火器青灰石堡拉开巨大差距。
   */
  function paintCityIron(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 夯石城基与石板十字街
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 4.2, '#ccb993', '#8f7c59', '#ab9670', '#584a3177');
    polygon(ctx, [pt(0.08, 0.08, 4.25), pt(0.92, 0.08, 4.25), pt(0.92, 0.92, 4.25), pt(0.08, 0.92, 4.25)], '#d4c4a2');
    polygon(ctx, [pt(0.43, 0.10, 4.3), pt(0.57, 0.10, 4.3), pt(0.57, 0.92, 4.3), pt(0.43, 0.92, 4.3)], '#e2d6bc');
    polygon(ctx, [pt(0.10, 0.45, 4.3), pt(0.92, 0.45, 4.3), pt(0.92, 0.57, 4.3), pt(0.10, 0.57, 4.3)], '#e2d6bc');

    // 2. 后侧城墙与北角楼（NW / NE）
    isoBox(ctx, pt, 0.02, 0.02, 0.98, 0.11, 4.2, 8.2, '#d8c7a3', '#998562', '#b5a07a', '#5c4d3466');
    isoBox(ctx, pt, 0.02, 0.02, 0.11, 0.98, 4.2, 8.2, '#d8c7a3', '#998562', '#b5a07a', '#5c4d3466');
    // 北角方形箭楼
    isoBox(ctx, pt, 0.00, 0.00, 0.17, 0.17, 4.2, 10.6, '#dfd0ae', '#94805d', '#b39e78', '#52432c77');
    isoGable(ctx, pt, -0.01, -0.01, 0.18, 0.18, 10.6, 0.6, 3.6, true, '#94805d', '#b39e78', '#d48a4d', '#9e5e2e', '#52341c55');
    // 东角箭楼
    isoBox(ctx, pt, 0.83, 0.00, 1.00, 0.17, 4.2, 10.4, '#dfd0ae', '#94805d', '#b39e78', '#52432c77');
    isoGable(ctx, pt, 0.82, -0.01, 1.01, 0.18, 10.4, 0.6, 3.5, false, '#94805d', '#b39e78', '#d48a4d', '#9e5e2e', '#52341c55');

    // 3. 城内赤陶瓦建筑群（由后向前）
    // 3a. 高台主殿/城主府（城心偏北，醒目暖赤陶瓦顶）
    isoBox(ctx, pt, 0.24, 0.19, 0.66, 0.50, 4.2, 6.6, '#d9cab0', '#9b8868', '#b8a380', '#5b4b3255');
    isoGable(ctx, pt, 0.27, 0.22, 0.63, 0.47, 6.6, 5.2, 5.4, true, '#a99470', '#c4af89', '#d68c4f', '#9f5d2c', '#57371e66');
    // 主殿屋脊饰带（微带阵营色琉璃脊）
    strokeLine(ctx, pt(0.27, 0.345, 17.2), pt(0.63, 0.345, 17.2), lightCol, 1.35);

    // 3b. 东北侧陶瓦厢房
    isoGable(ctx, pt, 0.68, 0.22, 0.87, 0.46, 4.2, 4.0, 3.6, false, '#a5906d', '#c0ab86', '#cf854a', '#99592b', '#57371e55');
    // 3c. 西南侧陶瓦民居院落
    isoGable(ctx, pt, 0.18, 0.60, 0.42, 0.83, 4.2, 4.0, 3.8, true, '#a5906d', '#c0ab86', '#d1884c', '#9b5a2b', '#57371e55');
    // 3d. 东南侧陶瓦坊屋
    isoGable(ctx, pt, 0.62, 0.62, 0.84, 0.84, 4.2, 3.8, 3.5, true, '#a38e6b', '#bea883', '#cc8348', '#965629', '#57371e55');

    // 4. 前侧城墙（东南与西南）+ 垛口 + 城门楼 + 另两座角楼
    isoBox(ctx, pt, 0.89, 0.15, 0.98, 0.85, 4.2, 8.2, '#d8c7a3', '#998562', '#b5a07a', '#5c4d3466');
    isoBox(ctx, pt, 0.15, 0.89, 0.40, 0.98, 4.2, 8.2, '#d8c7a3', '#998562', '#b5a07a', '#5c4d3466');
    isoBox(ctx, pt, 0.60, 0.89, 0.85, 0.98, 4.2, 8.2, '#d8c7a3', '#998562', '#b5a07a', '#5c4d3466');
    // 正南城门楼与暗门洞
    isoBox(ctx, pt, 0.39, 0.86, 0.61, 1.00, 4.2, 9.8, '#dfd0ae', '#94805d', '#b39e78', '#52432c77');
    polygon(ctx, [pt(0.45, 1.005, 4.2), pt(0.55, 1.005, 4.2), pt(0.55, 1.005, 7.6), pt(0.45, 1.005, 7.6)], '#403425');
    isoGable(ctx, pt, 0.38, 0.85, 0.62, 1.01, 9.8, 0.5, 3.2, true, '#94805d', '#b39e78', '#d48a4d', '#9e5e2e', '#52341c55');
    // 西角楼与南角楼
    isoBox(ctx, pt, 0.00, 0.83, 0.17, 1.00, 4.2, 10.4, '#dfd0ae', '#94805d', '#b39e78', '#52432c77');
    isoGable(ctx, pt, -0.01, 0.82, 0.18, 1.01, 10.4, 0.5, 3.4, true, '#94805d', '#b39e78', '#d48a4d', '#9e5e2e', '#52341c55');
    isoBox(ctx, pt, 0.83, 0.83, 1.00, 1.00, 4.2, 10.6, '#dfd0ae', '#94805d', '#b39e78', '#52432c77');
    isoGable(ctx, pt, 0.82, 0.82, 1.01, 1.01, 10.6, 0.5, 3.5, true, '#94805d', '#b39e78', '#d48a4d', '#9e5e2e', '#52341c55');

    // 5. 阵营方旗
    isoBanner(ctx, pt, 0.45, 0.34, 17.2, 5.6, teamCol, lightCol, true);
  }

  /**
   * 时代 3 · 火器时代（Gunpowder Age）：
   * 冷灰厚重花岗岩石城 + 东南角八角形棱堡炮台（配黑铁加农炮）+ 高耸青灰瓦主堡钟楼 + 密集青瓦街区，
   * 整体冷青灰石质色调，与铁器暖陶瓦和蒸汽红砖形成极其鲜明的时代分水岭。
   */
  function paintCityGunpowder(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 厚重青灰条石堡垒台基
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 5.4, '#aeb7bf', '#707b86', '#8d98a3', '#444d5688');
    polygon(ctx, [pt(0.07, 0.07, 5.45), pt(0.93, 0.07, 5.45), pt(0.93, 0.93, 5.45), pt(0.07, 0.93, 5.45)], '#c5ccd2');
    // 广场石板拼接纹理
    strokeLine(ctx, pt(0.50, 0.10, 5.5), pt(0.50, 0.90, 5.5), '#959fa888', 0.85);
    strokeLine(ctx, pt(0.10, 0.50, 5.5), pt(0.90, 0.50, 5.5), '#959fa888', 0.85);

    // 2. 后侧厚石护墙（西北与东北）
    isoBox(ctx, pt, 0.01, 0.01, 0.99, 0.10, 5.4, 9.6, '#c2cad1', '#77838e', '#97a3ae', '#454e5777');
    isoBox(ctx, pt, 0.01, 0.01, 0.10, 0.99, 5.4, 9.6, '#c2cad1', '#77838e', '#97a3ae', '#454e5777');

    // 3. 城内青瓦高堡与街区（由后向前）
    // 3a. 西北高耸主堡/要塞指挥塔（冷灰巨石 + 深蓝灰陡坡瓦顶）
    isoBox(ctx, pt, 0.16, 0.16, 0.48, 0.46, 5.4, 15.6, '#ccd3d9', '#7d8995', '#9da9b5', '#424b5488');
    // 塔身枪眼与石腰线
    strokeLine(ctx, pt(0.16, 0.46, 11.2), pt(0.48, 0.46, 11.2), '#5b667088', 0.9);
    strokeLine(ctx, pt(0.48, 0.16, 11.2), pt(0.48, 0.46, 11.2), '#4e586188', 0.9);
    for (const u of [0.25, 0.39]) {
      const [wx, wy] = pt(u, 0.462, 13.0);
      ctx.fillStyle = '#38414a';
      ctx.fillRect(wx - 1.1, wy - 1.4, 2.2, 3.0);
    }
    isoGable(ctx, pt, 0.14, 0.14, 0.50, 0.48, 15.6, 0.8, 5.8, true, '#7d8995', '#9da9b5', '#788e9f', '#526575', '#36434e77');

    // 3b. 东北青瓦联排楼宇
    isoGable(ctx, pt, 0.54, 0.16, 0.86, 0.44, 5.4, 5.2, 4.2, true, '#85919c', '#a3aeb8', '#7d92a3', '#566979', '#3b485266');
    // 3c. 西南青瓦联排楼宇
    isoGable(ctx, pt, 0.16, 0.54, 0.48, 0.84, 5.4, 5.0, 4.2, false, '#85919c', '#a3aeb8', '#798ea0', '#546676', '#3b485266');

    // 4. 前侧厚石堡垒墙 + 东南角标志性「八角石砌棱堡炮台」（还原 city-gunpowder.webp 灵魂地标）
    isoBox(ctx, pt, 0.90, 0.10, 0.99, 0.62, 5.4, 9.6, '#c2cad1', '#77838e', '#97a3ae', '#454e5777');
    isoBox(ctx, pt, 0.10, 0.90, 0.62, 0.99, 5.4, 9.6, '#c2cad1', '#77838e', '#97a3ae', '#454e5777');
    // 八角棱堡炮台（宽厚突出于东南角）
    isoCylinder(ctx, pt, 0.78, 0.78, 0.24, 0.22, 0, 11.4, '#b5bfc8', '#96a2ad', '#6e7a86', '#cfd6dc', '#3f485288');
    // 炮台内凹胸墙与黑铁火炮
    isoCylinder(ctx, pt, 0.78, 0.78, 0.15, 0.15, 11.4, 12.1, '#8b96a1', '#79848f', '#66717c', '#9da8b2', '#47515c66');
    // 两门朝东南伸出的黑铁加农炮管
    strokeLine(ctx, pt(0.79, 0.77, 12.6), pt(0.98, 0.84, 13.0), '#31373d', 2.2);
    strokeLine(ctx, pt(0.75, 0.80, 12.6), pt(0.84, 0.99, 13.0), '#31373d', 2.2);
    // 阵营旗插于主堡尖顶与棱堡边
    isoBanner(ctx, pt, 0.32, 0.31, 22.2, 6.0, teamCol, lightCol, true);
  }

  /**
   * 时代 4 · 蒸汽时代（Steam Age）：
   * 标志性红砖双跨工业厂房 + 两根高耸锥形红砖大烟囱（飘出柔和蒸汽团）+ 蒸汽铁轨与煤堆 + 暖黄工业拱窗，
   * 红砖热工业配色与高耸烟囱剪影具备极高辨识度。
   */
  function paintCitySteam(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 工业灰石地基 + 蒸汽铁轨与煤炭堆场
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 4.6, '#9e9990', '#6d6962', '#858077', '#4a464088');
    polygon(ctx, [pt(0.05, 0.05, 4.65), pt(0.95, 0.05, 4.65), pt(0.95, 0.95, 4.65), pt(0.05, 0.95, 4.65)], '#aba59a');

    // 穿过西南前院的双轨铁道（枕木 + 双钢轨）
    for (let i = 0; i <= 7; i++) {
      const f = 0.06 + (i / 7) * 0.88;
      strokeLine(ctx, pt(f - 0.02, 0.77, 4.75), pt(f + 0.02, 0.91, 4.75), '#5e4c3c88', 1.2);
    }
    strokeLine(ctx, pt(0.05, 0.80, 4.85), pt(0.95, 0.80, 4.85), '#4a5056', 1.1);
    strokeLine(ctx, pt(0.05, 0.88, 4.85), pt(0.95, 0.88, 4.85), '#4a5056', 1.1);

    // 2. 高耸锥形红砖大烟囱 × 2（蒸汽时代灵魂剪影，位于厂房西北后侧）
    isoCylinder(ctx, pt, 0.24, 0.20, 0.085, 0.055, 4.6, 26.5, '#cf7055', '#b45840', '#873d2b', '#443f3c', '#4f241977');
    // 烟囱顶部铁箍
    isoCylinder(ctx, pt, 0.24, 0.20, 0.062, 0.062, 24.4, 25.8, '#53585e', '#43484d', '#33373b', '#404449');
    isoCylinder(ctx, pt, 0.41, 0.16, 0.070, 0.048, 4.6, 21.5, '#ca6b51', '#ae543c', '#823a29', '#443f3c', '#4f241977');

    // 柔和飘散的暖白蒸汽团
    const drawSteamPuff = (u: number, v: number, z: number, rx: number, ry: number, alpha: number): void => {
      const [sx, sy] = pt(u, v, z);
      ctx.fillStyle = `rgba(241,238,231,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(sx, sy, rx, ry, -0.2, 0, Math.PI * 2);
      ctx.fill();
    };
    drawSteamPuff(0.28, 0.14, 29.0, 4.2, 2.6, 0.65);
    drawSteamPuff(0.36, 0.07, 32.0, 5.4, 3.1, 0.45);
    drawSteamPuff(0.46, 0.01, 34.4, 4.4, 2.5, 0.28);
    drawSteamPuff(0.45, 0.11, 24.0, 3.2, 2.0, 0.52);

    // 3. 主红砖双跨工业大厂房（中北偏西，锯齿双坡屋顶 + 暖黄亮窗）
    isoGable(ctx, pt, 0.14, 0.24, 0.72, 0.46, 4.6, 7.2, 4.8, true, '#9e4b36', '#be6047', '#d17357', '#9c4833', '#54261a66');
    isoGable(ctx, pt, 0.20, 0.46, 0.74, 0.68, 4.6, 6.6, 4.4, true, '#9a4733', '#ba5c43', '#cd6e53', '#964430', '#54261a66');
    // 厂房南墙暖黄工业拱窗阵列
    for (const u of [0.28, 0.41, 0.54, 0.66]) {
      const [wx, wy] = pt(u, 0.684, 7.8);
      ctx.fillStyle = '#efd28a';
      ctx.fillRect(wx - 1.4, wy - 1.8, 2.8, 3.4);
      ctx.strokeStyle = '#5a2d2066';
      ctx.lineWidth = 0.55;
      ctx.strokeRect(wx - 1.4, wy - 1.8, 2.8, 3.4);
    }

    // 4. 东侧红砖小工坊 / 锅炉房 + 阵营红砖矮围墙
    isoGable(ctx, pt, 0.75, 0.22, 0.93, 0.54, 4.6, 4.6, 3.4, false, '#984632', '#b55a41', '#c96b50', '#92422e', '#54261a55');

    // 5. 庭院煤堆（黑灰锥体，凸显煤炭蒸汽时代特征）
    const [cx, cy] = pt(0.82, 0.69, 4.7);
    polygon(ctx, [[cx - 5.2, cy + 1.0], [cx - 0.6, cy - 4.0], [cx + 0.8, cy + 1.8]], '#525457');
    polygon(ctx, [[cx - 0.6, cy - 4.0], [cx + 5.0, cy + 0.8], [cx + 0.8, cy + 1.8]], '#343639');

    // 6. 厂房顶阵营旗
    isoBanner(ctx, pt, 0.62, 0.35, 16.5, 5.5, teamCol, lightCol, true);
  }

  /**
   * 时代 5 · 机械化时代（Mechanized Age）：
   * 灰白现代钢筋水泥高楼群 + 蓝灰玻璃幕墙窗带 + 深灰柏油十字路与白斑马线 + 屋顶雷达天线、圆柱储罐与停机坪，
   * 最高耸干练的现代摩天剪影与冷白水泥配色，与蒸汽红砖一秒区隔。
   */
  function paintCityMechanized(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 现代钢筋水泥街区底座 + 深灰柏油十字大道与白色斑马线
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 4.4, '#c7cfd5', '#7d8892', '#9da8b2', '#4a555f88');
    // 柏油主路（十字交叉）
    polygon(ctx, [pt(0.41, 0.02, 4.45), pt(0.59, 0.02, 4.45), pt(0.59, 0.98, 4.45), pt(0.41, 0.98, 4.45)], '#555e66');
    polygon(ctx, [pt(0.02, 0.43, 4.45), pt(0.98, 0.43, 4.45), pt(0.98, 0.59, 4.45), pt(0.02, 0.59, 4.45)], '#555e66');
    // 道路虚线与斑马线
    strokeLine(ctx, pt(0.50, 0.06, 4.5), pt(0.50, 0.38, 4.5), '#e8edf088', 0.85);
    strokeLine(ctx, pt(0.50, 0.64, 4.5), pt(0.50, 0.94, 4.5), '#e8edf088', 0.85);
    strokeLine(ctx, pt(0.06, 0.51, 4.5), pt(0.36, 0.51, 4.5), '#e8edf088', 0.85);
    strokeLine(ctx, pt(0.64, 0.51, 4.5), pt(0.94, 0.51, 4.5), '#e8edf088', 0.85);
    // 街角现代绿化带
    polygon(ctx, [pt(0.06, 0.36, 4.5), pt(0.38, 0.36, 4.5), pt(0.38, 0.41, 4.5), pt(0.06, 0.41, 4.5)], '#7b9f62');
    polygon(ctx, [pt(0.62, 0.61, 4.5), pt(0.94, 0.61, 4.5), pt(0.94, 0.66, 4.5), pt(0.62, 0.66, 4.5)], '#7b9f62');

    const drawGlassBands = (u0: number, v0: number, u1: number, v1: number, zs: readonly number[]): void => {
      for (const z of zs) {
        // 南立面蓝灰玻璃窗带
        polygon(ctx, [pt(u0 + 0.03, v1 + 0.004, z), pt(u1 - 0.03, v1 + 0.004, z), pt(u1 - 0.03, v1 + 0.004, z + 1.6), pt(u0 + 0.03, v1 + 0.004, z + 1.6)], '#668ca8');
        // 东立面深蓝灰玻璃窗带
        polygon(ctx, [pt(u1 + 0.004, v0 + 0.03, z), pt(u1 + 0.004, v1 - 0.03, z), pt(u1 + 0.004, v1 - 0.03, z + 1.6), pt(u1 + 0.004, v0 + 0.03, z + 1.6)], '#4a6b84');
      }
    };

    // 2. 西北角阶梯式现代主大厦（最高地标 + 蓝灰玻璃幕墙 + 屋顶通讯雷达塔）
    isoBox(ctx, pt, 0.06, 0.05, 0.38, 0.35, 4.4, 24.5, '#e7ecef', '#98a6b2', '#bec9d2', '#52606c77');
    drawGlassBands(0.06, 0.05, 0.38, 0.35, [8.2, 12.2, 16.2, 20.2]);
    // 顶部退台机房层 + 阵营色屋顶饰条
    isoBox(ctx, pt, 0.12, 0.10, 0.32, 0.29, 24.5, 28.4, '#eef2f5', '#9ba9b5', '#c5cfd8', '#52606c77');
    strokeLine(ctx, pt(0.06, 0.35, 24.1), pt(0.38, 0.35, 24.1), teamCol, 1.5);
    strokeLine(ctx, pt(0.38, 0.05, 24.1), pt(0.38, 0.35, 24.1), teamCol, 1.3);
    // 屋顶通讯天线与雷达圆盘
    const mastBot = pt(0.22, 0.19, 28.4);
    const mastTop = pt(0.22, 0.19, 36.2);
    strokeLine(ctx, mastBot, mastTop, '#5e6b78', 1.25);
    strokeLine(ctx, [mastTop[0] - 2.6, mastTop[1] + 2.6], [mastTop[0] + 2.6, mastTop[1] + 2.6], '#7a8a98', 0.9);
    ctx.fillStyle = teamCol;
    ctx.beginPath();
    ctx.arc(mastTop[0], mastTop[1], 1.3, 0, Math.PI * 2);
    ctx.fill();

    // 3. 东北角现代混凝土综合楼 + 屋顶 H 型停机坪
    isoBox(ctx, pt, 0.62, 0.07, 0.94, 0.39, 4.4, 15.8, '#e3e8ec', '#95a3af', '#bac5ce', '#52606c77');
    drawGlassBands(0.62, 0.07, 0.94, 0.39, [7.6, 11.4]);
    // 停机坪深灰圆垫 + 白色 H 标志
    const [hx, hy] = pt(0.78, 0.23, 15.95);
    ctx.fillStyle = '#6b7680';
    ctx.beginPath();
    ctx.ellipse(hx, hy, 5.4, 3.1, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeLine(ctx, [hx - 1.8, hy - 1.2], [hx - 1.8, hy + 1.2], '#f2f6f8', 0.95);
    strokeLine(ctx, [hx + 1.8, hy - 1.2], [hx + 1.8, hy + 1.2], '#f2f6f8', 0.95);
    strokeLine(ctx, [hx - 1.8, hy], [hx + 1.8, hy], '#f2f6f8', 0.85);

    // 4. 西南角中层办公楼 + 屋顶冷却空调机组
    isoBox(ctx, pt, 0.07, 0.62, 0.38, 0.93, 4.4, 17.8, '#e5eaee', '#97a5b1', '#bcc7d0', '#52606c77');
    drawGlassBands(0.07, 0.62, 0.38, 0.93, [8.0, 12.0, 15.4]);
    isoBox(ctx, pt, 0.14, 0.70, 0.28, 0.84, 17.8, 19.6, '#d5dde3', '#8b98a4', '#aeb9c2', '#52606c55');

    // 5. 东南角现代工业厂区 + 标志性圆柱储罐
    isoBox(ctx, pt, 0.62, 0.67, 0.93, 0.93, 4.4, 12.0, '#dfe5ea', '#919fab', '#b6c1ca', '#52606c77');
    drawGlassBands(0.62, 0.67, 0.93, 0.93, [7.8]);
    isoCylinder(ctx, pt, 0.77, 0.80, 0.09, 0.09, 12.0, 15.2, '#dde4e9', '#b8c3cc', '#8b99a5', '#edf2f5', '#52606c66');

    // 6. 屋顶干练阵营旗
    isoBanner(ctx, pt, 0.28, 0.14, 28.4, 5.2, teamCol, lightCol, true);
  }

  /** 斜俯视 3D 流线未来穹顶（珠光圆顶/椭圆穹顶，用于时代八聚变城） */
  function isoDome(
    ctx: CanvasRenderingContext2D,
    pt: CityPt,
    cu: number,
    cv: number,
    ru: number,
    rv: number,
    z0: number,
    domeH: number,
    litCol: string,
    midCol: string,
    shadeCol: string,
    highlightCol: string,
    edgeCol = '#7c96a855',
  ): void {
    // 分 3 层渐收椭圆环构建圆润流畅的立体穹顶
    const layers: ReadonlyArray<readonly [number, number, number, number]> = [
      [1.0, 0.88, 0, domeH * 0.38],
      [0.88, 0.62, domeH * 0.38, domeH * 0.78],
      [0.62, 0.24, domeH * 0.78, domeH],
    ];
    const segs = 10;
    for (let li = 0; li < layers.length; li++) {
      const [rA, rB, zA, zB] = layers[li]!;
      const pA: Point[] = [];
      const pB: Point[] = [];
      for (let i = 0; i < segs; i++) {
        const ang = (i / segs) * Math.PI * 2;
        pA.push(pt(cu + Math.cos(ang) * ru * rA, cv + Math.sin(ang) * rv * rA, z0 + zA));
        pB.push(pt(cu + Math.cos(ang) * ru * rB, cv + Math.sin(ang) * rv * rB, z0 + zB));
      }
      // 由背向前的可见面顺序
      const order = [6, 7, 5, 8, 4, 9, 3, 0, 2, 1];
      for (const i of order) {
        const n = (i + 1) % segs;
        const col = i === 4 || i === 5 || i === 6 ? litCol : i === 3 || i === 7 || i === 2 ? midCol : shadeCol;
        polygon(ctx, [pB[i]!, pB[n]!, pA[n]!, pA[i]!], col, li === 0 ? edgeCol : undefined, 0.45);
      }
      if (li === layers.length - 1) {
        polygon(ctx, pB, highlightCol);
      }
    }
    // 穹顶西北迎光柔和镜面高光斑
    const [hx, hy] = pt(cu - ru * 0.22, cv - rv * 0.22, z0 + domeH * 0.82);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(hx, hy, Math.max(2.2, ru * 18), Math.max(1.3, rv * 10), -0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 时代 6 · 信息化时代（Information Age）：
   * 洁白流线框架 + 透亮晶蓝全玻璃幕墙大厦 + 空中玻璃连廊 + 屋顶深蓝太阳能光伏阵列 + 抛物面卫星锅 + 生态绿树，
   * 清透高科技的蓝白晶莹质感与时代五哑光灰白水泥形成鲜明代差。
   */
  function paintCityInfo(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 洁白生态科技园区广场底座
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 4.2, '#e4ecef', '#8fa2ae', '#b4c4ce', '#566c7a77');
    polygon(ctx, [pt(0.05, 0.05, 4.25), pt(0.95, 0.05, 4.25), pt(0.95, 0.95, 4.25), pt(0.05, 0.95, 4.25)], '#edf3f6');
    // 园区科技灰蓝主干道与绿化带
    polygon(ctx, [pt(0.42, 0.04, 4.3), pt(0.56, 0.04, 4.3), pt(0.56, 0.96, 4.3), pt(0.42, 0.96, 4.3)], '#768c99');
    polygon(ctx, [pt(0.04, 0.46, 4.3), pt(0.96, 0.46, 4.3), pt(0.96, 0.58, 4.3), pt(0.04, 0.58, 4.3)], '#768c99');
    // 园区生态绿化圆树（还原 city-info.webp 绿植簇拥的生态科技感）
    const drawParkTree = (u: number, v: number, r = 3.1): void => {
      const [tx, ty] = pt(u, v, 4.6);
      ctx.fillStyle = '#3d633644';
      ctx.beginPath();
      ctx.ellipse(tx + 0.8, ty + 1.0, r * 1.05, r * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#538249';
      ctx.beginPath();
      ctx.arc(tx, ty - r * 0.45, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7bb268';
      ctx.beginPath();
      ctx.arc(tx - r * 0.25, ty - r * 0.65, r * 0.72, 0, Math.PI * 2);
      ctx.fill();
    };
    drawParkTree(0.49, 0.14, 2.8);
    drawParkTree(0.12, 0.52, 2.7);

    // 2. 西北角斜顶晶蓝玻璃信息中心主大厦（标志性全玻璃斜切顶 + 抛物面卫星锅）
    const drawGlassTower = (u0: number, v0: number, u1: number, v1: number, z0: number, z1: number, slant = 0): void => {
      const bNE = pt(u1, v0, z0);
      const bSE = pt(u1, v1, z0);
      const bSW = pt(u0, v1, z0);
      const tNW = pt(u0, v0, z1 + slant);
      const tNE = pt(u1, v0, z1 + slant * 0.5);
      const tSE = pt(u1, v1, z1);
      const tSW = pt(u0, v1, z1 + slant * 0.5);
      // 透亮青蓝玻璃幕墙立面
      polygon(ctx, [tNE, tSE, bSE, bNE], '#4c99b2', '#e8f4f8cc', 0.8);
      polygon(ctx, [tSW, tSE, bSE, bSW], '#72c2d8', '#eef8facc', 0.8);
      // 玻璃对角高光反射带
      polygon(ctx, [
        pt(u0 + (u1 - u0) * 0.12, v1, z0 + (z1 - z0) * 0.78),
        pt(u0 + (u1 - u0) * 0.48, v1, z0 + (z1 - z0) * 0.92),
        pt(u0 + (u1 - u0) * 0.78, v1, z0 + (z1 - z0) * 0.26),
        pt(u0 + (u1 - u0) * 0.42, v1, z0 + (z1 - z0) * 0.14),
      ], 'rgba(226,251,255,0.34)');
      // 横向白色结构层间框线
      const floors = Math.max(2, Math.floor((z1 - z0) / 5.5));
      for (let f = 1; f < floors; f++) {
        const zf = z0 + ((z1 - z0) * f) / floors;
        strokeLine(ctx, pt(u0, v1, zf), pt(u1, v1, zf), '#eaf5f8aa', 0.75);
        strokeLine(ctx, pt(u1, v0, zf), pt(u1, v1, zf), '#cfe7f099', 0.7);
      }
      // 晶蓝玻璃斜天窗屋顶 + 洁白外框
      polygon(ctx, [tNW, tNE, tSE, tSW], '#a4e6f2', '#f4f9fb', 1.0);
      strokeLine(ctx, tNW, tSE, 'rgba(255,255,255,0.55)', 0.8);
    };

    drawGlassTower(0.06, 0.05, 0.39, 0.39, 4.2, 23.5, 4.8);
    // 屋顶洁白抛物面卫星通讯锅 + 信号尖塔
    const [dx, dy] = pt(0.22, 0.19, 28.4);
    strokeLine(ctx, pt(0.22, 0.19, 25.8), [dx, dy], '#7e93a1', 1.3);
    ctx.fillStyle = '#eff6f9';
    ctx.strokeStyle = '#5f7e91';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.ellipse(dx, dy - 1.2, 4.6, 2.7, -0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    strokeLine(ctx, [dx, dy - 1.2], [dx + 2.4, dy - 4.4], '#537387', 0.9);
    ctx.fillStyle = '#4ad7f5';
    ctx.beginPath();
    ctx.arc(dx + 2.5, dy - 4.5, 1.3, 0, Math.PI * 2);
    ctx.fill();

    // 3. 东北侧玻璃采光科技展馆 + 屋顶深蓝太阳能光伏板阵列
    isoBox(ctx, pt, 0.59, 0.06, 0.94, 0.42, 4.2, 13.8, '#e8f1f5', '#6aaec4', '#8fd2e4', '#eff7fa99');
    // 斜坡晶蓝采光天窗
    polygon(ctx, [pt(0.62, 0.09, 13.9), pt(0.91, 0.09, 13.9), pt(0.91, 0.25, 16.0), pt(0.62, 0.25, 16.0)], '#a6e8f4', '#ffffffaa', 0.7);
    polygon(ctx, [pt(0.62, 0.25, 16.0), pt(0.91, 0.25, 16.0), pt(0.91, 0.39, 13.9), pt(0.62, 0.39, 13.9)], '#6bbcd3', '#ffffff88', 0.7);
    // 深蓝光伏太阳能板阵列（还原 city-info.webp 特征）
    for (const pu of [0.64, 0.78]) {
      polygon(ctx, [
        pt(pu, 0.27, 15.2),
        pt(pu + 0.11, 0.27, 15.2),
        pt(pu + 0.11, 0.37, 14.3),
        pt(pu, 0.37, 14.3),
      ], '#2d4e78', '#a8d3f0aa', 0.65);
    }

    // 4. 空中玻璃连廊（连接主大厦与西南数据副楼，凸显数字互联感）
    isoBox(ctx, pt, 0.20, 0.39, 0.31, 0.62, 10.6, 13.2, '#b4edf7', '#53a2bb', '#79cbe0', '#eff9fbaa');

    // 5. 西南数据副楼（阶梯晶蓝玻璃幕墙 + 屋顶太阳能板）
    drawGlassTower(0.08, 0.61, 0.40, 0.92, 4.2, 16.4, 2.2);
    polygon(ctx, [pt(0.14, 0.68, 17.6), pt(0.32, 0.68, 17.6), pt(0.32, 0.84, 17.0), pt(0.14, 0.84, 17.0)], '#2c4c76', '#a8d3f0aa', 0.65);

    // 6. 东南生态创新中心 + 街角绿树
    isoBox(ctx, pt, 0.60, 0.62, 0.92, 0.92, 4.2, 11.4, '#eef5f8', '#5fa4ba', '#84c9dd', '#f2fafcaa');
    polygon(ctx, [pt(0.64, 0.66, 11.5), pt(0.88, 0.66, 11.5), pt(0.88, 0.88, 11.5), pt(0.64, 0.88, 11.5)], '#9ce3f0', '#ffffffaa', 0.7);
    drawParkTree(0.50, 0.86, 2.9);

    // 7. 阵营全息光带与旗帜
    strokeLine(ctx, pt(0.06, 0.39, 23.0), pt(0.39, 0.39, 23.0), teamCol, 1.5);
    isoBanner(ctx, pt, 0.14, 0.10, 27.6, 5.4, teamCol, lightCol, true);
  }

  /**
   * 时代 7 · 装甲时代（Armor Age）：
   * 军绿钛灰六边形复合装甲甲板 + 重型斜壁八角防爆主堡（顶置双联炮塔）+ 标志性钢铁机甲龙门吊架 + 警示标线地堡，
   * 厚重硬核的军工堡垒剪影，与时代六晶莹玻璃和时代八纯白聚变穹顶彻底拉开视觉跨度。
   */
  function paintCityArmor(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 厚重六边形复合装甲底座甲板（还原 city-armor.webp 标志性六边形装甲板）
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 5.8, '#9aa89c', '#57645b', '#768579', '#323c3699');
    polygon(ctx, [pt(0.05, 0.05, 5.85), pt(0.95, 0.05, 5.85), pt(0.95, 0.95, 5.85), pt(0.05, 0.95, 5.85)], '#8e9d91');
    // 刻画六边形复合装甲板块拼接沟槽
    const drawHexPlate = (cu: number, cv: number, r: number): void => {
      const hex: Point[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        hex.push(pt(cu + Math.cos(a) * r, cv + Math.sin(a) * r, 5.9));
      }
      polygon(ctx, hex, '#a7b5a8', '#46544b88', 0.85);
    };
    drawHexPlate(0.28, 0.28, 0.21);
    drawHexPlate(0.73, 0.28, 0.21);
    drawHexPlate(0.28, 0.73, 0.21);
    drawHexPlate(0.73, 0.73, 0.21);

    // 2. 西北重型八角复合装甲指挥主堡 + 顶置双联装防御炮塔
    isoCylinder(ctx, pt, 0.28, 0.27, 0.24, 0.20, 5.8, 17.6, '#b0beb1', '#88978b', '#5b6960', '#bdcabd', '#343e3899');
    // 装甲腰带与重型防爆观察缝
    isoCylinder(ctx, pt, 0.28, 0.27, 0.16, 0.13, 17.6, 21.0, '#9eada0', '#79887c', '#505e55', '#b1bfb2', '#343e3888');
    // 顶部双联装自动防御炮塔（深钛铁炮座 + 双炮管）
    isoBox(ctx, pt, 0.22, 0.21, 0.34, 0.33, 21.0, 23.8, '#7a8780', '#444e4a', '#5d6963', '#272f2c99');
    strokeLine(ctx, pt(0.31, 0.25, 22.8), pt(0.49, 0.32, 24.0), '#2d3533', 1.8);
    strokeLine(ctx, pt(0.29, 0.29, 22.8), pt(0.47, 0.36, 24.0), '#2d3533', 1.8);
    // 堡身警示橙灯与阵营涂装带
    const [lx, ly] = pt(0.32, 0.45, 13.5);
    ctx.fillStyle = '#e5a944';
    ctx.fillRect(lx - 1.4, ly - 0.9, 2.8, 1.8);

    // 3. 东北重型钢铁机甲装配龙门吊架与起降甲板（还原 city-armor.webp 灵魂构筑物）
    // 起降平台与战术黄黑警示标线
    polygon(ctx, [pt(0.56, 0.12, 6.0), pt(0.90, 0.12, 6.0), pt(0.90, 0.44, 6.0), pt(0.56, 0.44, 6.0)], '#58645d', '#353e3a88', 0.75);
    strokeLine(ctx, pt(0.60, 0.16, 6.1), pt(0.86, 0.16, 6.1), '#dfad4d', 1.2);
    strokeLine(ctx, pt(0.60, 0.40, 6.1), pt(0.86, 0.40, 6.1), '#dfad4d', 1.2);
    // 龙门吊后柱与前柱 + 顶部钢铁桁架横梁
    isoBox(ctx, pt, 0.60, 0.13, 0.67, 0.20, 6.0, 17.8, '#8a9790', '#4b5651', '#68756e', '#2d363288');
    isoBox(ctx, pt, 0.80, 0.34, 0.87, 0.41, 6.0, 17.8, '#8a9790', '#4b5651', '#68756e', '#2d363288');
    // 龙门架斜跨主钢梁与吊车小车
    polygon(ctx, [
      pt(0.59, 0.14, 17.6),
      pt(0.66, 0.14, 17.6),
      pt(0.87, 0.39, 17.6),
      pt(0.80, 0.39, 17.6),
    ], '#a4b2a8', '#333d3888', 0.8);
    polygon(ctx, [
      pt(0.59, 0.14, 17.6),
      pt(0.80, 0.39, 17.6),
      pt(0.80, 0.39, 15.6),
      pt(0.59, 0.14, 15.6),
    ], '#5c6962', '#2f383488', 0.75);
    // 吊臂警示黄涂装块
    isoBox(ctx, pt, 0.70, 0.24, 0.76, 0.30, 14.5, 16.2, '#e2b254', '#a67d30', '#c79940', '#47361577');

    // 4. 西南重型斜壁防爆地堡（带发射井盖与通风百叶）
    isoBox(ctx, pt, 0.10, 0.58, 0.44, 0.88, 5.8, 12.6, '#aebbae', '#5d6b62', '#7e8d82', '#323c3688');
    isoBox(ctx, pt, 0.15, 0.63, 0.39, 0.83, 12.6, 14.2, '#8b998d', '#505d55', '#6c7a70', '#323c3688');
    // 重型装甲阵营条纹
    polygon(ctx, [pt(0.14, 0.885, 8.2), pt(0.40, 0.885, 8.2), pt(0.40, 0.885, 10.2), pt(0.14, 0.885, 10.2)], teamCol);

    // 5. 东南加固装甲哨堡与斜坡护裙
    isoCylinder(ctx, pt, 0.74, 0.74, 0.19, 0.16, 5.8, 13.6, '#a9b7aa', '#819084', '#55635a', '#b6c4b7', '#323c3688');
    // 哨堡顶部军用雷达圆罩
    isoCylinder(ctx, pt, 0.74, 0.74, 0.08, 0.06, 13.6, 15.6, '#c8d3ca', '#97a59a', '#6d7b71', '#d9e3db');

    // 6. 战术铁杆阵营军旗
    isoBanner(ctx, pt, 0.18, 0.18, 21.0, 5.8, teamCol, lightCol, true);
  }

  /**
   * 时代 8 · 聚变时代（Fusion Age）：
   * 珠光纯白未来底座 + 纵横发光青蓝聚变能量导流沟槽 + 巨型光滑椭圆形珠光穹顶 + 中央托卡马克聚变光环与悬浮能量尖塔，
   * 极具未来科幻乌托邦史诗感，与时代七冷硬军绿装甲形成终极文明跃迁对比。
   */
  function paintCityFusion(ctx: CanvasRenderingContext2D, pt: CityPt, teamCol: string, lightCol: string): void {
    // 1. 珠光洁白未来底座
    isoBox(ctx, pt, 0, 0, 1, 1, 0, 5.0, '#eef4f8', '#9eb2c0', '#c4d4df', '#657f9188');
    polygon(ctx, [pt(0.05, 0.05, 5.05), pt(0.95, 0.05, 5.05), pt(0.95, 0.95, 5.05), pt(0.05, 0.95, 5.05)], '#f4f8fb');

    // 2. 纵横交错的发光青蓝聚变能量导流光脉（还原 city-fusion.webp 灵魂视觉符号）
    const drawConduit = (u0: number, v0: number, u1: number, v1: number): void => {
      const a = pt(u0, v0, 5.15);
      const b = pt(u1, v1, 5.15);
      strokeLine(ctx, a, b, 'rgba(72,218,246,0.34)', 4.2);
      strokeLine(ctx, a, b, '#6be7fc', 1.7);
      strokeLine(ctx, a, b, '#dafaff', 0.75);
    };
    drawConduit(0.06, 0.50, 0.94, 0.50);
    drawConduit(0.50, 0.06, 0.50, 0.94);
    // 外环发光能量光圈
    const ringPts: Point[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      ringPts.push(pt(0.5 + Math.cos(a) * 0.42, 0.5 + Math.sin(a) * 0.42, 5.15));
    }
    ctx.beginPath();
    ctx.moveTo(...ringPts[0]!);
    for (const p of ringPts.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(84,225,250,0.42)';
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.strokeStyle = '#9cf2ff';
    ctx.lineWidth = 1.0;
    ctx.stroke();

    // 3. 西北巨型光滑珠光纯白椭圆生态穹顶（还原 city-fusion.webp 椭圆大穹顶）
    // 穹顶基座青蓝发光护环
    const [d1x, d1y] = pt(0.28, 0.26, 5.2);
    ctx.strokeStyle = 'rgba(88,228,252,0.55)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.ellipse(d1x, d1y, 13.5, 8.0, 0, 0, Math.PI * 2);
    ctx.stroke();
    isoDome(ctx, pt, 0.28, 0.26, 0.24, 0.19, 5.1, 13.2, '#f8fbfd', '#dce7ef', '#aebfce', '#ffffff', '#7e9bb055');

    // 4. 东北与西南对称流线能量副穹顶
    isoDome(ctx, pt, 0.78, 0.24, 0.14, 0.14, 5.1, 9.2, '#f7fafc', '#dae5ee', '#acc0cf', '#ffffff', '#7e9bb055');
    isoDome(ctx, pt, 0.24, 0.76, 0.15, 0.15, 5.1, 9.6, '#f7fafc', '#dae5ee', '#acc0cf', '#ffffff', '#7e9bb055');

    // 5. 中央偏东南：标志性「托卡马克聚变反应堆 + 发光等离子环 + 悬浮聚变核心尖塔」
    isoCylinder(ctx, pt, 0.62, 0.62, 0.25, 0.21, 5.0, 10.6, '#f4f8fb', '#d6e2eb', '#a6b9c8', '#eef5f9', '#6e8ba066');
    // 发光聚变等离子约束光环（托卡马克核心）
    const [tx, ty] = pt(0.62, 0.62, 11.4);
    ctx.strokeStyle = 'rgba(72,222,250,0.36)';
    ctx.lineWidth = 5.4;
    ctx.beginPath();
    ctx.ellipse(tx, ty, 10.8, 6.2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#6ce9fd';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(tx, ty, 10.8, 6.2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#e5fdff';
    ctx.lineWidth = 0.95;
    ctx.beginPath();
    ctx.ellipse(tx, ty, 10.8, 6.2, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 反应堆内核心柱与四根弧形洁白磁约束拱臂
    isoCylinder(ctx, pt, 0.62, 0.62, 0.10, 0.06, 10.6, 26.8, '#f8fbfd', '#dce7ef', '#aec1d0', '#ffffff', '#6d8ca155');
    for (const [du, dv] of [[-0.17, 0], [0.17, 0], [0, -0.17], [0, 0.17]] as const) {
      strokeLine(ctx, pt(0.62 + du, 0.62 + dv, 11.2), pt(0.62 + du * 0.35, 0.62 + dv * 0.35, 25.0), '#edf4f8', 1.6);
      strokeLine(ctx, pt(0.62 + du, 0.62 + dv, 11.2), pt(0.62 + du * 0.35, 0.62 + dv * 0.35, 25.0), '#7a98ad66', 0.6);
    }

    // 尖塔顶部悬浮璀璨聚变光核
    const [ox, oy] = pt(0.62, 0.62, 31.6);
    const orbGrad = ctx.createRadialGradient(ox, oy, 0.8, ox, oy, 8.2);
    orbGrad.addColorStop(0, 'rgba(235,254,255,0.95)');
    orbGrad.addColorStop(0.38, 'rgba(92,230,252,0.72)');
    orbGrad.addColorStop(1, 'rgba(92,230,252,0)');
    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.arc(ox, oy, 8.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2feff';
    ctx.beginPath();
    ctx.arc(ox, oy, 2.3, 0, Math.PI * 2);
    ctx.fill();

    // 极简科技阵营光带与细流线旗
    const [fx, fy] = pt(0.62, 0.62, 10.7);
    ctx.strokeStyle = teamCol;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(fx, fy, 13.8, 7.9, 0, 0.15, Math.PI - 0.15);
    ctx.stroke();
    isoBanner(ctx, pt, 0.28, 0.26, 18.0, 5.2, teamCol, lightCol, true);
  }

  function paintCity(
    ctx: CanvasRenderingContext2D, city: City, texture: HTMLImageElement, target: boolean, selected: boolean, dark: boolean,
  ): void {
    const pad = 0.08;
    const x = city.x + pad;
    const y = city.y + pad;
    const width = city.size - pad * 2;
    const hScale = Math.min(1.25, Math.max(0.65, city.size / 2));
    const team = teams[city.owner];
    const lightTeam = teamTints[city.owner];
    const outline = selected ? '#174d76' : target ? '#aa3b31' : team;
    const pt: CityPt = (u, v, dz = 0) => project(x + u * width, y + v * width, dz * hScale);

    // 城市底盘阵营色外描边与柔和落地影（先绘在最底层）
    const basePoly = rhombus(x, y, width, 0);
    polygon(ctx, basePoly.map(([bx, by]) => [bx + 2.2, by + 2.4]), '#2d271e26');

    if (city.ruined) {
      paintCityRuined(ctx, pt, outline);
      if (dark) polygon(ctx, basePoly, '#17232b47');
      faces.push({ cell: { x: city.x, y: city.y }, points: basePoly });
      return;
    }

    if (city.era >= 1 && city.era <= 8) {
      const ringZ = city.era === 1 ? 0.3 : 0.4;
      const ring = rhombus(x - 0.02, y - 0.02, width + 0.04, ringZ);
      // 先在底层绘制完整阵营框（让西北/东北后缘自然贴于城基后方，不穿插建筑）
      ctx.beginPath();
      ctx.moveTo(...ring[0]!);
      for (const p of ring.slice(1)) ctx.lineTo(...p);
      ctx.closePath();
      ctx.strokeStyle = outline;
      ctx.lineWidth = target || selected ? 3.2 : 2.1;
      ctx.stroke();

      if (city.era === 1) paintCityBronze(ctx, pt, team, lightTeam);
      else if (city.era === 2) paintCityIron(ctx, pt, team, lightTeam);
      else if (city.era === 3) paintCityGunpowder(ctx, pt, team, lightTeam);
      else if (city.era === 4) paintCitySteam(ctx, pt, team, lightTeam);
      else if (city.era === 5) paintCityMechanized(ctx, pt, team, lightTeam);
      else if (city.era === 6) paintCityInfo(ctx, pt, team, lightTeam);
      else if (city.era === 7) paintCityArmor(ctx, pt, team, lightTeam);
      else paintCityFusion(ctx, pt, team, lightTeam);

      // 仅重描东南/西南前缘两段阵营框，干脆利落且绝不压住 3D 屋顶与高塔
      ctx.beginPath();
      ctx.moveTo(...ring[1]!);
      ctx.lineTo(...ring[2]!);
      ctx.lineTo(...ring[3]!);
      ctx.strokeStyle = outline;
      ctx.lineWidth = target || selected ? 3.2 : 2.1;
      ctx.stroke();

      if (dark) {
        const fogTop = rhombus(x, y, width, Math.min(26, city.era * 3 + 6));
        polygon(ctx, [fogTop[0]!, fogTop[1]!, basePoly[1]!, basePoly[2]!, basePoly[3]!, fogTop[3]!], '#17232b38');
      }
      // 扩大命中面覆盖 3D 建筑轮廓，点击建筑顶部也能直接选中城市
      const pickTop = rhombus(x, y, width, 16 * hScale);
      faces.push({
        cell: { x: city.x, y: city.y },
        points: [pickTop[0]!, pickTop[1]!, basePoly[1]!, basePoly[2]!, basePoly[3]!, pickTop[3]!],
      });
      return;
    }

    // 兜底（超纲时代号仍保留原有贴图方案）
    const base = rhombus(x, y, width, 0);
    const roof = rhombus(x, y, width, 13);
    polygon(ctx, [roof[1]!, roof[2]!, base[2]!, base[1]!], '#625844', '#473e31');
    polygon(ctx, [roof[3]!, roof[2]!, base[2]!, base[3]!], '#94856a', '#473e31');
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

    // 2a. 外沿水柱剖面 + 水体底色、等深过渡坡、浅滩河床与岸壁落影
    for (const cell of waterCells) {
      if (cell.eastEdge) {
        paintWaterCutawayFace(ctx, cell.terrain, cell.x + 1, cell.y, cell.x + 1, cell.y + 1, 'east', cell.dark, timeSec);
      }
      if (cell.southEdge) {
        paintWaterCutawayFace(ctx, cell.terrain, cell.x, cell.y + 1, cell.x + 1, cell.y + 1, 'south', cell.dark, timeSec);
      }
      paintWaterBaseTile(ctx, cell.x, cell.y, cell.terrain, paintedState, cell.meta);
    }

    // 2b. 整片水体连续世界空间光影与流动动画（河/湖/海各自统一裁切、零碎裂感）
    for (const body of activeWaterBodies) {
      paintWaterBodyFlow(ctx, body, timeSec);
    }

    // 2c. 极淡战术格线与柔和等深分界
    for (const cell of waterCells) {
      paintWaterGridAndContours(ctx, cell.x, cell.y, cell.terrain, paintedState);
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
    activeWaterBodies = waterField.bodies;

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
            paintWaterBaseTile(targetCtx, x, y, cellTerrain, terrain, meta);
            paintWaterGridAndContours(targetCtx, x, y, cellTerrain, terrain);
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

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
  /** 深度分档：现在只用来决定「深浅分界线」画在哪，不再参与几何高度 */
  const bedDepth: Partial<Record<Terrain, number>> = { shallow: 1, water: 4, deep: 9 };
  const isWaterTerrain = (t: Terrain | undefined): boolean => t === 'water' || t === 'shallow' || t === 'deep';
  const heights: Partial<Record<Terrain, number>> = {
    deep: WATER_SURFACE, water: WATER_SURFACE, shallow: WATER_SURFACE,
    valley: -3, bridge: 2, hill: 8, plateau: 15, mountain: 25,
  };
  const colors: Partial<Record<Terrain, string>> = {
    plain: '#dce4c7', forest: '#a8bd86', hill: '#d6c08f', mountain: '#8694a3',
    water: '#9ebfd2', shallow: '#a9cfc5', deep: '#5b8fae', bridge: '#ba9a6d', city: '#c5cbb1',
    plateau: '#e2dfc1', valley: '#c3cfa6', marsh: '#a9b795', dune: '#e8d9a8',
    shadow: '#2b2140',
    void: '#262824', regolith: '#d8d4ca', crater: '#b6b1a7', deck: '#7c8592', wreck: '#4b413a',
  };

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

    const water = terrain === 'water' || terrain === 'shallow' || terrain === 'deep';
    if (terrain === 'plain') {
      paintPlainArt(ctx, x, y, elevation, state);
    } else if (terrain === 'hill') {
      paintHillArt(ctx, x, y, elevation, state);
    } else if (terrain === 'forest') {
      paintForestArt(ctx, x, y, elevation, state);
    } else if (terrain === 'mountain') {
      paintMountainArt(ctx, x, y, elevation, state);
    } else {
      const grid = water ? '#f7faf726' : '#34422a27';
      polygon(ctx, rhombus(x, y, 1, elevation), colors[terrain] ?? colors.plain!, grid);
      if (water && (x + y * 3) % 4 === 0) {
        const [left, top] = project(x + 0.43, y + 0.49, elevation);
        ctx.fillStyle = '#eff5ec66';
        ctx.fillRect(left - 5, top, 10, 1);
      }
    }
    /*
     * 深浅分界：水面既然齐平，就只剩颜色和这条线能读出河床的台阶。
     * 只在两侧深度不同时画，不画在"水和浅水只是相邻"的普通格子上。
     */
    if (isWaterTerrain(terrain)) {
      const myDepth = bedDepth[terrain] ?? 0;
      const contour = (a: Point, b: Point): void => {
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.strokeStyle = '#3f6a8455';
        ctx.lineWidth = 1;
        ctx.stroke();
      };
      const eastNeighbor = at(state, x + 1, y);
      if (isWaterTerrain(eastNeighbor) && (bedDepth[eastNeighbor!] ?? 0) !== myDepth) {
        contour(project(x + 1, y, elevation), project(x + 1, y + 1, elevation));
      }
      const southNeighbor = at(state, x, y + 1);
      if (isWaterTerrain(southNeighbor) && (bedDepth[southNeighbor!] ?? 0) !== myDepth) {
        contour(project(x, y + 1, elevation), project(x + 1, y + 1, elevation));
      }
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
    ctx.setTransform(width / scene.w, 0, 0, height / scene.h, 0, 0);
    ctx.clearRect(0, 0, scene.w, scene.h);
    faces = [];

    const visible = new Set(view.visible);
    const terrain = view.terrainHidden
      ? {
          ...state,
          tiles: state.tiles.map((tile, index) => visible.has(index)
            ? tile : { ...tile, terrain: view.rememberedTiles.get(index) ?? 'void' as const }),
        }
      : state;
    paintedState = terrain;
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

    const bottom = [project(0, 0, boardFloor), project(state.w, 0, boardFloor),
      project(state.w, state.h, boardFloor), project(0, state.h, boardFloor)];
    polygon(ctx, bottom.map(([x, y]) => [x + 4, y + 9]), '#62564424');
    polygon(ctx, bottom, '#736953');
    for (let diagonal = 0; diagonal < state.w + state.h - 1; diagonal++) {
      for (let y = Math.max(0, diagonal - state.w + 1); y <= Math.min(state.h - 1, diagonal); y++) {
        const x = diagonal - y;
        const index = y * state.w + x;
        const dark = state.fog && !visible.has(index);
        const elevation = heightAt(terrain, x, y);
        const top = rhombus(x, y, 1, elevation);
        paintTerrain(ctx, x, y, terrain, dark);
        faces.push({ cell: { x, y }, points: top });
        if (moves.has(index)) polygon(ctx, top, '#3d8ecb62', '#2873a5');
        if (places.has(index) || aims.has(index)) polygon(ctx, top, '#e7a34c66', '#ba7830');

        const city = cities.get(index);
        if (city) paintCity(ctx, city, cityTexture(city.era), sieges.has(city.id), ui?.selectedCityId === city.id, dark);
        const group = units.get(index);
        if (group) {
          group.sort((a, b) => Number(isAirborne(state, a)) - Number(isAirborne(state, b)));
          for (const unit of group) paintUnit(ctx, unit, terrain, ui?.selectedId === unit.id, attacks.has(unit.id));
        }
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

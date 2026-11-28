/**
 * 民兵（青铜时代 25 金征召乡勇）四套侧俯视美术风格原型绘制器。
 *
 * 仅由原型对比页 `prototypes/militia-styles/` 注册，不影响主游戏已有单位渲染：
 * - proto_militia_a：方案 A · 陷阵像素微缩（34×28 硬像素精灵 + nearest-neighbor 渲染）
 * - proto_militia_b：方案 B · 几何微缩兵阵（无黑描边纯受光切面 3 人小队 + 实木薄底座）
 * - proto_militia_c：方案 C · 旗帜冷峻厚涂（高反差深褐剪影 + 暖亮受光棱 + 克制阵营围布）
 * - proto_militia_d：方案 D · 兵偶+纹章台座（2 人写实乡勇 + 斜切战术台座 + 前缘矛尖徽章）
 */

import {
  getAngledUnitTeamPalette,
  registerAngledUnitArt,
  type AngledUnitHitQuad,
  type AngledUnitPaintOpts,
  type TeamClothPalette,
} from '../ui/angled-units.ts';

export const MILITIA_STYLE_IDS = {
  A: 'proto_militia_a',
  B: 'proto_militia_b',
  C: 'proto_militia_c',
  D: 'proto_militia_d',
} as const;

export type MilitiaStyleKey = keyof typeof MILITIA_STYLE_IDS;

function poly(
  ctx: CanvasRenderingContext2D,
  pts: ReadonlyArray<readonly [number, number]>,
  fill: string,
  stroke?: string,
  lw = 0.65,
): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function makeHitQuad(x: number, y: number, scale: number, extraBottom = 0): AngledUnitHitQuad {
  const hw = 13 * scale;
  const hTop = 27 * scale;
  const hBot = (7 + extraBottom) * scale;
  return [
    [x - hw, y - hTop],
    [x + hw, y - hTop],
    [x + hw, y + hBot],
    [x - hw, y + hBot],
  ];
}

function drawTargetCorners(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = '#c4322b';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  const corner = (cx: number, cy: number, sx: number, sy: number) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + sy * 4.6);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + sx * 4.6, cy);
    ctx.stroke();
  };
  corner(-13.0, -26.0, 1, 1);
  corner(13.0, -26.0, -1, 1);
  corner(-13.0, 3.4, 1, -1);
  corner(13.0, 3.4, -1, -1);
}

function drawTacticalHud(
  ctx: CanvasRenderingContext2D,
  opts: AngledUnitPaintOpts,
  barY = 4.6,
): void {
  const { hp, maxHp, extraHp, isMine, spent, moved } = opts;
  const barW = 19;
  const barH = 2.5;
  const barX = -barW / 2;

  ctx.fillStyle = 'rgba(26, 23, 19, 0.88)';
  ctx.beginPath();
  ctx.roundRect(barX - 0.8, barY - 0.8, barW + 1.6, barH + 1.6, 1.2);
  ctx.fill();

  const ratio = Math.max(0, Math.min(1, maxHp > 0 ? hp / maxHp : 1));
  ctx.fillStyle = '#524b42';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = ratio > 0.5 ? '#58a86b' : ratio > 0.25 ? '#d99838' : '#cf4c42';
  ctx.fillRect(barX, barY, barW * ratio, barH);

  if (extraHp && extraHp > 0) {
    ctx.fillStyle = '#47b4e6';
    ctx.fillRect(barX, barY - 2.0, Math.min(barW, barW * (extraHp / Math.max(1, maxHp))), 1.4);
  }

  if (isMine && !spent) {
    ctx.beginPath();
    ctx.arc(barX - 3.2, barY + barH / 2, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = moved ? '#de922c' : '#46a85d';
    ctx.fill();
    ctx.strokeStyle = '#fdfaf2';
    ctx.lineWidth = 0.85;
    ctx.stroke();
  }
}

/* =========================================================================
   方案 A：陷阵像素微缩（34×28 硬像素精灵 + nearest-neighbor 缓存绘制）
   ========================================================================= */
const PIXEL_GRID: readonly string[] = [
  '..............................t.',
  '.............................tT.',
  '............................wT..',
  '...........................w....',
  '........oo................w.....',
  '.......oHHo..............w......',
  '.......oCCo.............w.......',
  '.......oSSo............w........',
  '........oo....oo......w.........',
  '......oLMMo..oHHo....w....t.....',
  '.....oLLCMMo.oCCo...w....tT.....',
  '.....oLMCCMo.oSSo..w....wT......',
  '.....oLMMcMo..oo..w....w........',
  '......oWWWo..oLMMw....w.........',
  '......oDDDo.oLLCMMo..w..........',
  '......oRRo..oLMCCMo.w...........',
  '.....oP.oP..oLMMcMow............',
  '.....oW.oW...oWWWo..............',
  '.....oK.oK...oDDDo..............',
  '.....oo.oo...oRRRo..............',
  '............oP..oP..............',
  '............oW..oW..............',
  '............oK..oK..............',
  '............oo..oo..............',
];

const pixelSpriteCache = new Map<string, HTMLCanvasElement>();

function getPixelSprite(owner: AngledUnitPaintOpts['owner'], dim: boolean, pal: TeamClothPalette): HTMLCanvasElement {
  const key = `${owner}:${dim ? 1 : 0}`;
  const cached = pixelSpriteCache.get(key);
  if (cached) return cached;

  const off = document.createElement('canvas');
  off.width = 34;
  off.height = 28;
  const octx = off.getContext('2d')!;
  const cmap: Record<string, string> = {
    o: dim ? '#2b2926' : '#241f19',
    H: dim ? '#56524c' : '#403125',
    C: pal.lit,
    c: pal.shade,
    S: dim ? '#c7beb2' : '#e6be96',
    L: dim ? '#ccc7bc' : '#e2d7be',
    M: dim ? '#a8a296' : '#bfb195',
    D: dim ? '#827c71' : '#8d7f66',
    W: dim ? '#6b645a' : '#63472b',
    R: dim ? '#78736a' : '#796a53',
    P: dim ? '#635f57' : '#5e4f3c',
    K: dim ? '#4f4c46' : '#4d3621',
    w: dim ? '#877f73' : '#8f673d',
    t: dim ? '#c7c0b2' : '#e0c684',
    T: dim ? '#878072' : '#94783c',
  };

  for (let y = 0; y < PIXEL_GRID.length; y++) {
    const row = PIXEL_GRID[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === '.') continue;
      octx.fillStyle = cmap[ch] ?? '#000';
      octx.fillRect(x, y + 2, 1, 1);
    }
  }

  const drawPxSpear = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const px = Math.round(x0 + ((x1 - x0) * i) / steps);
      const py = Math.round(y0 + ((y1 - y0) * i) / steps);
      octx.fillStyle = i >= steps - 2 ? (i === steps ? cmap.t! : cmap.T!) : cmap.w!;
      octx.fillRect(px, py, 1, 1);
      if (i < steps - 2) {
        octx.fillStyle = 'rgba(28, 22, 16, 0.45)';
        octx.fillRect(px, py + 1, 1, 1);
      }
    }
  };
  drawPxSpear(3, 16, 17, 3);
  drawPxSpear(10, 20, 27, 9);

  // 脚底接地硬像素阴影
  octx.fillStyle = 'rgba(24, 20, 15, 0.34)';
  octx.fillRect(4, 22, 7, 2);
  octx.fillRect(11, 26, 8, 2);

  pixelSpriteCache.set(key, off);
  return off;
}

function paintStyleA(ctx: CanvasRenderingContext2D, opts: AngledUnitPaintOpts): AngledUnitHitQuad {
  const { x, y, scale, owner, dim, selected, target, facing } = opts;
  const pal = getAngledUnitTeamPalette(owner, dim);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // 细阵营脚环
  ctx.beginPath();
  ctx.ellipse(0, 0.5, selected || target ? 11.2 : 9.8, selected || target ? 4.8 : 4.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.58)' : target ? 'rgba(248, 224, 214, 0.58)' : pal.ringFill;
  ctx.fill();
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : pal.ring;
  ctx.lineWidth = selected || target ? 1.75 : 1.0;
  ctx.stroke();

  const sprite = getPixelSprite(owner, dim, pal);
  ctx.save();
  if (dim) ctx.globalAlpha = 0.78;
  ctx.scale(facing, 1);
  ctx.imageSmoothingEnabled = false;
  const dw = 34 * 0.88;
  const dh = 28 * 0.88;
  ctx.drawImage(sprite, -dw * 0.45, -dh + 3.0, dw, dh);
  ctx.restore();

  if (target) drawTargetCorners(ctx);
  drawTacticalHud(ctx, opts, 4.8);
  ctx.restore();
  return makeHitQuad(x, y, scale);
}

/* =========================================================================
   方案 B：几何微缩兵阵（无黑描边纯切面 3 人小队 + 实木战棋薄底座）
   ========================================================================= */
function drawFacetLevy(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  s: number,
  pal: TeamClothPalette,
  dim: boolean,
): void {
  const hLit = dim ? '#cfc9be' : '#e6dcc5';
  const hMid = dim ? '#b0aa9e' : '#c6b99d';
  const hShd = dim ? '#847e73' : '#8f8166';
  const skinL = dim ? '#cec5b8' : '#ebc49c';
  const skinS = dim ? '#a39a8e' : '#bd9168';
  const hair = dim ? '#504c46' : '#3d2f22';
  const wood = dim ? '#7c7468' : '#855f39';
  const tip = dim ? '#c4bca9' : '#dec37e';

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  // 东南投射长影
  poly(ctx, [[0, 0], [5.4, 1.4], [3.4, 2.5], [-2.0, 0.8]], 'rgba(30, 24, 18, 0.28)');
  // 几何腿部（无描边，纯受光/背光双切面）
  poly(ctx, [[-2.0, -6.2], [-0.4, -6.2], [-1.2, 0.0], [-2.6, -0.2]], hShd);
  poly(ctx, [[0.3, -6.2], [1.9, -6.2], [2.4, 0.4], [0.8, 0.4]], hMid);
  // 几何棱柱躯干（粗麻短褐）
  poly(ctx, [[-2.4, -13.2], [0.2, -13.5], [0.0, -5.8], [-2.6, -6.0]], hLit);
  poly(ctx, [[0.2, -13.5], [2.4, -13.0], [2.4, -5.8], [0.0, -5.8]], hShd);
  // 阵营肩带切面
  poly(ctx, [[-2.3, -13.2], [-0.4, -13.4], [2.3, -7.8], [0.6, -7.6]], pal.mid);
  poly(ctx, [[-2.3, -13.2], [-1.0, -13.3], [0.8, -9.8], [-0.2, -9.8]], pal.lit);
  // 极简雕塑头 + 束发 + 阵营额带
  poly(ctx, [[-1.5, -17.4], [0.2, -17.6], [0.1, -13.8], [-1.5, -14.0]], skinL);
  poly(ctx, [[0.2, -17.6], [1.6, -17.3], [1.4, -13.9], [0.1, -13.8]], skinS);
  poly(ctx, [[-1.8, -17.2], [0.0, -18.8], [1.7, -17.4], [1.5, -16.4], [-1.7, -16.4]], hair);
  poly(ctx, [[-1.7, -16.8], [1.7, -16.8], [1.7, -15.8], [-1.7, -15.8]], pal.mid);
  poly(ctx, [[-1.7, -16.8], [0.2, -16.8], [0.2, -15.8], [-1.7, -15.8]], pal.lit);
  // 斜举长木矛（细挺几何杆 + 菱形原始小铜尖）
  ctx.strokeStyle = wood;
  ctx.lineWidth = 1.15;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-4.8, -6.6);
  ctx.lineTo(7.4, -20.2);
  ctx.stroke();
  poly(ctx, [[6.8, -19.6], [10.4, -23.4], [8.5, -19.2], [7.2, -18.8]], tip);
  ctx.restore();
}

function paintStyleB(ctx: CanvasRenderingContext2D, opts: AngledUnitPaintOpts): AngledUnitHitQuad {
  const { x, y, scale, owner, dim, selected, target, facing } = opts;
  const pal = getAngledUnitTeamPalette(owner, dim);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  if (selected || target) {
    ctx.beginPath();
    ctx.ellipse(0, 1.0, 12.2, 5.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.55)' : 'rgba(248, 224, 214, 0.55)';
    ctx.fill();
    ctx.strokeStyle = selected ? '#1f6c96' : '#c4322b';
    ctx.lineWidth = 1.65;
    ctx.stroke();
  }

  ctx.save();
  if (dim) ctx.globalAlpha = 0.72;
  // 实木微缩战棋薄底座 + 阵营边圈
  ctx.beginPath();
  ctx.ellipse(0, 1.4, 10.6, 4.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#4f463a';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 0.3, 10.4, 4.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#756856';
  ctx.fill();
  ctx.strokeStyle = pal.mid;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // 3 人紧密几何微缩方阵
  ctx.scale(facing, 1);
  drawFacetLevy(ctx, -4.4, -1.8, 0.84, pal, dim);
  drawFacetLevy(ctx, 2.8, -2.5, 0.80, pal, dim);
  drawFacetLevy(ctx, 0.4, 1.5, 0.90, pal, dim);
  ctx.restore();

  if (target) drawTargetCorners(ctx);
  drawTacticalHud(ctx, opts, 5.2);
  ctx.restore();
  return makeHitQuad(x, y, scale);
}

/* =========================================================================
   方案 C：旗帜冷峻厚涂（高反差深褐剪影 + 暖亮受光棱 + 克制阵营围布）
   ========================================================================= */
function drawEditorialLevy(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  s: number,
  pal: TeamClothPalette,
  dim: boolean,
  hasClub: boolean,
): void {
  const shadow = dim ? '#34322e' : '#26211c';
  const midCloth = dim ? '#7f7a71' : '#96876d';
  const rimLit = dim ? '#d6d0c4' : '#efe3c6';
  const skin = dim ? '#b5aca0' : '#d6ab82';
  const wood = dim ? '#6b6358' : '#734f2c';

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  // 浓郁落地影
  ctx.fillStyle = 'rgba(20, 17, 14, 0.44)';
  ctx.beginPath();
  ctx.ellipse(1.6, 0.6, 4.8, 2.0, 0.1, 0, Math.PI * 2);
  ctx.fill();

  // 整块深褐暗影剪影打底
  poly(ctx, [
    [-1.5, -18.8], [1.4, -19.0], [2.4, -14.8], [3.1, -7.2],
    [3.6, 0.4], [1.2, 0.4], [0.2, -5.8], [-1.4, 0.0],
    [-3.4, -0.2], [-2.5, -7.8], [-3.0, -14.6],
  ], shadow);

  // 左侧强西北受光面（粗麻短褐受光折面 + 腿部亮棱）
  poly(ctx, [[-2.6, -14.4], [0.4, -14.6], [0.0, -7.4], [-2.4, -7.6]], midCloth);
  poly(ctx, [[-2.6, -14.4], [-1.0, -14.5], [-1.3, -8.2], [-2.5, -8.3]], rimLit);
  poly(ctx, [[-2.4, -6.8], [-1.3, -6.8], [-2.0, -0.5], [-3.1, -0.5]], midCloth);
  poly(ctx, [[0.5, -6.6], [1.8, -6.6], [2.4, 0.0], [1.2, 0.0]], midCloth);

  // 颈间/肩头克制阵营围布 + 飘带
  poly(ctx, [[-2.7, -14.8], [1.9, -14.5], [2.4, -11.4], [-2.5, -12.0]], pal.shade);
  poly(ctx, [[-2.7, -14.8], [0.5, -14.6], [0.1, -12.2], [-2.5, -12.4]], pal.mid);
  poly(ctx, [[-2.7, -14.8], [-1.1, -14.7], [-1.3, -12.8], [-2.5, -12.9]], pal.lit);
  poly(ctx, [[-2.6, -14.2], [-6.2, -11.4], [-5.2, -10.2], [-2.3, -12.6]], pal.mid);

  // 写实侧脸高光切面 + 深发剪影 + 额带
  poly(ctx, [[-1.3, -18.2], [1.2, -18.1], [1.0, -15.4], [-1.0, -15.5]], skin);
  poly(ctx, [[0.1, -18.1], [1.3, -18.1], [1.1, -15.4], [0.1, -15.4]], shadow);
  poly(ctx, [[-1.9, -18.4], [-0.4, -20.2], [1.6, -19.2], [1.5, -17.8], [-1.7, -17.6]], shadow);
  poly(ctx, [[-1.7, -18.1], [1.5, -18.0], [1.5, -17.3], [-1.7, -17.4]], pal.lit);

  // 前排削尖木矛 / 后排粗木棍（农夫临时征召质感）
  ctx.lineCap = 'round';
  if (hasClub) {
    ctx.strokeStyle = shadow;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(-4.0, -9.2);
    ctx.lineTo(6.8, -19.8);
    ctx.stroke();
    ctx.strokeStyle = wood;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-4.0, -9.2);
    ctx.lineTo(6.4, -19.4);
    ctx.stroke();
    poly(ctx, [[4.6, -18.2], [7.6, -21.0], [8.4, -19.6], [5.4, -17.0]], rimLit);
  } else {
    ctx.strokeStyle = shadow;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-6.8, -8.4);
    ctx.lineTo(10.8, -20.6);
    ctx.stroke();
    ctx.strokeStyle = wood;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-6.8, -8.4);
    ctx.lineTo(10.4, -20.3);
    ctx.stroke();
    poly(ctx, [[9.6, -19.8], [14.2, -23.0], [11.6, -19.0], [10.0, -19.1]], rimLit, shadow, 0.5);
  }
  ctx.restore();
}

function paintStyleC(ctx: CanvasRenderingContext2D, opts: AngledUnitPaintOpts): AngledUnitHitQuad {
  const { x, y, scale, owner, dim, selected, target, facing } = opts;
  const pal = getAngledUnitTeamPalette(owner, dim);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // 极轻地面定位弧线
  ctx.beginPath();
  ctx.ellipse(0, 0.8, selected || target ? 11.4 : 10.0, selected || target ? 4.9 : 4.2, 0, 0, Math.PI * 2);
  if (selected || target) {
    ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.55)' : 'rgba(248, 224, 214, 0.55)';
    ctx.fill();
  }
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : pal.ring;
  ctx.lineWidth = selected || target ? 1.75 : 1.05;
  ctx.stroke();

  ctx.save();
  if (dim) ctx.globalAlpha = 0.72;
  ctx.scale(facing, 1);
  drawEditorialLevy(ctx, -3.7, -2.3, 0.92, pal, dim, true);
  drawEditorialLevy(ctx, 3.1, 1.4, 1.0, pal, dim, false);
  ctx.restore();

  if (target) drawTargetCorners(ctx);
  drawTacticalHud(ctx, opts, 4.8);
  ctx.restore();
  return makeHitQuad(x, y, scale);
}

/* =========================================================================
   方案 D：立体兵偶 + 纹章台座（双人乡勇立于斜切石质战术底座 + 前缘矛尖徽章）
   ========================================================================= */
function paintStyleD(ctx: CanvasRenderingContext2D, opts: AngledUnitPaintOpts): AngledUnitHitQuad {
  const { x, y, scale, owner, dim, selected, target, facing } = opts;
  const pal = getAngledUnitTeamPalette(owner, dim);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  if (selected || target) {
    ctx.beginPath();
    ctx.ellipse(0, 1.8, 12.8, 6.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.56)' : 'rgba(248, 224, 214, 0.56)';
    ctx.fill();
    ctx.strokeStyle = selected ? '#1f6c96' : '#c4322b';
    ctx.lineWidth = 1.75;
    ctx.stroke();
  }

  ctx.save();
  if (dim) ctx.globalAlpha = 0.76;

  // 1. 斜切六边立体微缩战棋台座（外缘青铜石质 + 阵营立面）
  const plinth: ReadonlyArray<readonly [number, number]> = [
    [-10.6, 0], [-5.8, -4.4], [5.8, -4.4], [10.6, 0], [5.8, 4.6], [-5.8, 4.6],
  ];
  const plinthBot: ReadonlyArray<readonly [number, number]> = plinth.map(([px, py]) => [px, py + 2.8]);

  // 底座落地投影
  poly(ctx, plinthBot.map(([px, py]) => [px + 1.4, py + 1.5]), 'rgba(22, 18, 14, 0.34)');
  // 底座前侧三块立面
  poly(ctx, [plinth[5]!, plinth[4]!, plinthBot[4]!, plinthBot[5]!], pal.shade, '#26211b', 0.6);
  poly(ctx, [plinth[0]!, plinth[5]!, plinthBot[5]!, plinthBot[0]!], pal.mid, '#26211b', 0.6);
  poly(ctx, [plinth[4]!, plinth[3]!, plinthBot[3]!, plinthBot[4]!], '#3d372f', '#26211b', 0.6);
  // 底座顶面（暖石盘面）
  poly(ctx, plinth, dim ? '#8c867c' : '#cfc5ad', '#4d463c', 0.65);
  poly(
    ctx,
    [[-8.5, 0], [-4.6, -3.2], [4.6, -3.2], [8.5, 0], [4.6, 3.3], [-4.6, 3.3]],
    dim ? '#7c766c' : '#b8ae96',
  );

  // 2. 底座上的双人微缩写实民兵
  ctx.save();
  ctx.scale(facing, 1);
  drawFacetLevy(ctx, -3.3, -1.5, 0.86, pal, dim);
  drawFacetLevy(ctx, 2.7, 0.8, 0.92, pal, dim);
  ctx.restore();

  // 3. 前缘嵌章：阵营徽记 + 白色矛尖剪影（始终正立，远景秒辨兵种）
  ctx.fillStyle = pal.mid;
  ctx.strokeStyle = '#f5eedc';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.roundRect(-4.0, 2.0, 8.0, 5.4, 1.5);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#faf5e8';
  ctx.lineWidth = 1.05;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-1.9, 6.0);
  ctx.lineTo(1.7, 3.2);
  ctx.stroke();
  poly(ctx, [[0.9, 3.0], [2.5, 2.7], [1.9, 4.2]], '#faf5e8');

  ctx.restore();

  if (target) drawTargetCorners(ctx);
  drawTacticalHud(ctx, opts, 8.4);
  ctx.restore();
  return makeHitQuad(x, y, scale, 3.6);
}

let registered = false;

export function registerMilitiaStylePrototypes(): void {
  if (registered) return;
  registered = true;
  registerAngledUnitArt(MILITIA_STYLE_IDS.A, paintStyleA);
  registerAngledUnitArt(MILITIA_STYLE_IDS.B, paintStyleB);
  registerAngledUnitArt(MILITIA_STYLE_IDS.C, paintStyleC);
  registerAngledUnitArt(MILITIA_STYLE_IDS.D, paintStyleD);
}

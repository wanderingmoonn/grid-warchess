/**
 * 时代 4（蒸汽时代 / 工业革命与早期现代热工业）原版全 9 个兵种与建筑的斜俯视 3D 微缩沙盘绘制模块。
 *
 * 与前序时代及时代 5 保持统一 4.8 头身写实微缩战棋风格与西北受光体系，全面呼应 E4 蒸汽城池语言：
 * - 红砖工业墙（#b55e46 / #984a35 / #723525）、工业灰石（#aba59a / #858077 / #6d6962）、
 *   铆接黑铁与熟钢（#2e3338 / #555d66 / #8f99a3）、黄铜水冷套与暖黄工业拱窗；
 * - 精准承接时代 3（火枪/风帆/花岗岩）与时代 5（二战钢盔/履带坦克/混凝土），涵盖：
 *   步枪兵、双轮水冷机枪队、四轮铆接装甲车、蒸汽农用拖拉机（农业公司）、测量工程师、
 *   双烟囱撞角铁甲舰、红砖铁顶要塞、双红砖烟囱兵工厂与铁轨红砖兵站。
 */

import type { AngledUnitPaintOpts, TeamClothPalette } from './angled-units.ts';
import type { Era1UnitSpec } from './angled-units-era1.ts';

interface Era4Mat {
  edge: string;
  brickLit: string;
  brickMid: string;
  brickShade: string;
  stoneTop: string;
  stoneLit: string;
  stoneShade: string;
  ironDark: string;
  ironMid: string;
  steelLit: string;
  steelMid: string;
  steelShade: string;
  brassLit: string;
  brassMid: string;
  khakiLit: string;
  khakiMid: string;
  khakiShade: string;
  clothLit: string;
  skinLit: string;
  skinShade: string;
  woodLit: string;
  woodMid: string;
  woodDark: string;
}

function getMat(dim: boolean): Era4Mat {
  return {
    edge: dim ? 'rgba(38, 36, 35, 0.64)' : 'rgba(28, 28, 30, 0.76)',
    brickLit: dim ? '#9e8881' : '#b86148',
    brickMid: dim ? '#82716b' : '#964934',
    brickShade: dim ? '#615450' : '#6c3121',
    stoneTop: dim ? '#a6a39e' : '#aba59a',
    stoneLit: dim ? '#8c8984' : '#8a857b',
    stoneShade: dim ? '#696662' : '#67635c',
    ironDark: dim ? '#3a3d40' : '#2c3136',
    ironMid: dim ? '#565a5f' : '#4e565f',
    steelLit: dim ? '#bcc2c7' : '#d8e0e6',
    steelMid: dim ? '#8f969c' : '#99a4ae',
    steelShade: dim ? '#646a70' : '#636d78',
    brassLit: dim ? '#c7c0ab' : '#e8c96c',
    brassMid: dim ? '#9e9785' : '#bd9b42',
    khakiLit: dim ? '#b5b1a4' : '#c6ba98',
    khakiMid: dim ? '#969288' : '#a19677',
    khakiShade: dim ? '#706e66' : '#736a52',
    clothLit: dim ? '#d2cfc7' : '#ede7d9',
    skinLit: dim ? '#c9bfb2' : '#e6be96',
    skinShade: dim ? '#a3998d' : '#bc8f66',
    woodLit: dim ? '#989084' : '#a3794b',
    woodMid: dim ? '#787065' : '#7a5733',
    woodDark: dim ? '#524d45' : '#4c341d',
  };
}

function poly(
  ctx: CanvasRenderingContext2D,
  pts: ReadonlyArray<readonly [number, number]>,
  fill: string,
  stroke?: string,
  lw = 0.62,
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

function strokeSeg(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  width: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawShadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.fillStyle = 'rgba(24, 22, 20, 0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0.14, 0, Math.PI * 2);
  ctx.fill();
}

function drawLegs(ctx: CanvasRenderingContext2D, m: Era4Mat, colFront: string, colBack: string, stride = 0.88, kneel = false): void {
  if (kneel) {
    poly(ctx, [[-2.1, -5.6], [-0.4, -5.6], [-2.0, -1.8], [-3.7, -2.0]], colBack, m.edge, 0.5);
    poly(ctx, [[-3.7, -2.0], [-2.0, -1.8], [-1.3, 0.4], [-3.1, 0.3]], m.ironDark);
    poly(ctx, [[0.1, -5.4], [2.1, -5.2], [2.9, -1.8], [1.1, -2.0]], colFront, m.edge, 0.5);
    poly(ctx, [[1.1, -2.0], [2.9, -1.8], [3.4, 0.7], [1.3, 0.7]], m.ironDark);
    return;
  }
  poly(ctx, [[-1.9, -7.6], [-0.4, -7.6], [-1.2 * stride - 1.0, -2.4], [-2.5 * stride - 0.8, -2.6]], colBack, m.edge, 0.5);
  poly(ctx, [[-2.5 * stride - 0.8, -2.7], [-1.2 * stride - 1.0, -2.5], [-1.4 * stride - 1.0, 0.3], [-2.8 * stride - 0.9, 0.2]], m.ironDark);
  poly(ctx, [[0.0, -7.4], [1.8, -7.4], [2.0 * stride + 0.5, -2.2], [0.5 * stride + 0.4, -2.4]], colFront, m.edge, 0.5);
  poly(ctx, [[0.5 * stride + 0.4, -2.4], [2.0 * stride + 0.5, -2.2], [2.4 * stride + 0.5, 0.7], [0.6 * stride + 0.4, 0.7]], m.ironDark);
}

function drawFace(ctx: CanvasRenderingContext2D, m: Era4Mat, hx: number, hy: number): void {
  poly(ctx, [[hx - 0.7, hy + 1.9], [hx + 0.8, hy + 1.9], [hx + 0.8, hy + 2.9], [hx - 0.7, hy + 2.9]], m.skinShade);
  poly(ctx, [
    [hx - 1.5, hy - 1.2], [hx + 1.4, hy - 1.2], [hx + 1.6, hy + 0.5],
    [hx + 0.8, hy + 2.0], [hx - 1.0, hy + 2.0], [hx - 1.6, hy + 0.5],
  ], m.skinLit, m.edge, 0.55);
  poly(ctx, [[hx + 0.2, hy - 1.0], [hx + 1.3, hy - 1.0], [hx + 1.4, hy + 0.5], [hx + 0.7, hy + 1.8], [hx + 0.1, hy + 1.8]], m.skinShade);
}

function drawKepiCap(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era4Mat, hx: number, hy: number): void {
  // 经典 19 世纪末/一战硬挺平顶鸭舌军帽（Kepi），鲜明区隔于时代 3 三角帽与时代 5 圆钢盔！
  poly(ctx, [[hx - 2.1, hy - 1.0], [hx - 1.8, hy - 3.3], [hx + 1.6, hy - 3.1], [hx + 2.0, hy - 1.0]], pal.mid, m.edge, 0.58);
  poly(ctx, [[hx - 1.9, hy - 1.2], [hx - 1.6, hy - 3.1], [hx + 0.3, hy - 3.0], [hx + 0.1, hy - 1.2]], pal.lit);
  // 黑漆帽檐 + 细金帽带
  poly(ctx, [[hx + 0.4, hy - 1.2], [hx + 3.4, hy - 0.6], [hx + 2.8, hy + 0.0], [hx - 1.9, hy - 0.8]], m.ironDark);
  strokeSeg(ctx, hx - 1.9, hy - 1.4, hx + 1.9, hy - 1.3, m.brassLit, 0.55);
}

function drawWaterWake(ctx: CanvasRenderingContext2D, rx: number, ry: number, pal: TeamClothPalette, selected: boolean, target: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 2.0, rx + 2.6, ry + 1.2, 0, 0, Math.PI * 2);
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : 'rgba(242, 250, 255, 0.62)';
  ctx.lineWidth = selected || target ? 1.85 : 1.05;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(0, 1.7, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.48)' : target ? 'rgba(248, 224, 214, 0.48)' : 'rgba(18, 38, 52, 0.38)';
  ctx.fill();
  ctx.strokeStyle = pal.ring;
  ctx.lineWidth = 0.95;
  ctx.stroke();
  ctx.restore();
}

/* =========================================================================
   1. 步枪兵（rifleman · 200 金 · 破甲 · 射程 4）：
   双人蒸汽/一战线列步枪兵——硬挺鸭舌军帽（Kepi）+ 卡其灰呢军大衣配阵营领肩 + 亮钢刺刀栓动步枪
   ========================================================================= */
function drawRiflemanSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era4Mat, variant: 0 | 1): void {
  drawShadow(ctx, 1.8, 0.6, 4.6, 1.9);
  drawLegs(ctx, m, m.khakiMid, m.khakiShade, variant === 0 ? 0.92 : 0.76, variant === 0);

  const yDrop = variant === 0 ? 1.8 : 0;
  const lean = variant === 0 ? 0.9 : 0.38;
  ctx.save();
  ctx.translate(0, yDrop);

  // 卡其灰呢长军大衣 + 皮革武装斜带 + 醒目阵营领肩与袖口
  poly(ctx, [[-2.7, -9.8], [2.5, -9.8], [3.1, -5.8], [-3.0, -6.0]], m.khakiMid, m.edge, 0.6);
  poly(ctx, [[-2.5, -9.6], [0.2, -9.6], [0.0, -6.0], [-2.8, -6.1]], m.khakiLit);
  poly(ctx, [[-2.7 + lean, -15.2], [2.4 + lean, -15.0], [2.5, -9.6], [-2.5, -9.6]], m.khakiMid, m.edge, 0.65);
  poly(ctx, [[-2.5 + lean, -15.0], [0.3 + lean, -14.9], [0.1, -9.8], [-2.3, -9.8]], m.khakiLit);
  // 阵营高领肩垫 + 皮革子弹斜带
  poly(ctx, [[-2.7 + lean, -15.3], [2.4 + lean, -15.1], [2.2 + lean, -13.0], [-2.5 + lean, -13.2]], pal.mid, m.edge, 0.45);
  poly(ctx, [[-2.5 + lean, -15.2], [0.3 + lean, -15.1], [0.1 + lean, -13.2], [-2.4 + lean, -13.3]], pal.lit);
  strokeSeg(ctx, -2.1 + lean, -15.0, 2.2, -9.8, m.woodDark, 1.25);
  poly(ctx, [[-2.6, -10.3], [2.5, -10.1], [2.5, -9.2], [-2.6, -9.4]], m.woodDark);

  const hx = lean * 1.1;
  const hy = -17.8;
  drawFace(ctx, m, hx, hy);
  drawKepiCap(ctx, pal, m, hx, hy);

  // 标志性「栓动长步枪 + 枪口长亮钢刺刀」（一战步枪兵独有银亮刺刀锋芒！）
  const rx0 = -1.0 + lean;
  const ry0 = -12.6;
  const rx1 = 10.8;
  const ry1 = -14.0;
  strokeSeg(ctx, rx0, ry0, rx0 + 7.2, ry0 - 0.8, m.edge, 2.5);
  strokeSeg(ctx, rx0, ry0, rx0 + 7.2, ry0 - 0.8, m.woodMid, 1.5);
  strokeSeg(ctx, rx0 + 4.8, ry0 - 0.7, rx1, ry1, m.edge, 2.0);
  strokeSeg(ctx, rx0 + 4.8, ry0 - 0.7, rx1, ry1, m.ironMid, 1.1);
  // 枪口下挂细长亮钢刺刀（1× 与 2× 一眼区别于火绳枪与冲锋枪！）
  poly(ctx, [[rx1 - 1.0, ry1 + 0.2], [rx1 + 4.6, ry1 - 0.8], [rx1 - 0.8, ry1 + 1.2]], m.steelLit, m.edge, 0.45);
  // 端枪前臂
  poly(ctx, [[1.0 + lean, -13.9], [2.4 + lean, -13.3], [5.6, -12.6], [4.6, -11.5]], m.khakiLit, m.edge, 0.48);

  ctx.restore();
}

function paintRifleman(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.6, -2.7);
  ctx.scale(0.95, 0.95);
  drawRiflemanSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.0, 1.5);
  ctx.scale(1.0, 1.0);
  drawRiflemanSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   2. 机枪队（mg · 175 金 · 射程 4）：
   经典马克沁「双轮炮架 + 黄铜水冷粗套筒 + 阵营弯弧炮盾」机枪组（彻底区别于时代 5 沙袋三脚架重机枪！）
   ========================================================================= */
function paintMg(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后左站立/微俯身副射手
  ctx.save();
  ctx.translate(-5.6, -2.4);
  ctx.scale(0.90, 0.90);
  drawShadow(ctx, 1.4, 0.5, 4.0, 1.7);
  drawLegs(ctx, m, m.khakiMid, m.khakiShade, 0.8);
  poly(ctx, [[-2.5, -14.8], [2.4, -14.6], [2.6, -6.6], [-2.5, -6.8]], m.khakiMid, m.edge, 0.58);
  poly(ctx, [[-2.4, -14.7], [2.3, -14.5], [2.2, -12.6], [-2.3, -12.8]], pal.mid);
  drawFace(ctx, m, 0.3, -17.4);
  drawKepiCap(ctx, pal, m, 0.3, -17.4);
  ctx.restore();

  // 主射手（蹲踞马克沁机枪后握把）
  ctx.save();
  ctx.translate(-1.8, 1.0);
  ctx.scale(0.94, 0.94);
  drawShadow(ctx, 1.4, 0.5, 4.0, 1.7);
  drawLegs(ctx, m, m.khakiMid, m.khakiShade, 0.85, true);
  poly(ctx, [[-2.4, -12.8], [2.4, -12.3], [2.5, -7.6], [-2.4, -7.8]], m.khakiMid, m.edge, 0.6);
  poly(ctx, [[-2.3, -12.7], [2.3, -12.2], [2.1, -10.6], [-2.2, -10.8]], pal.lit);
  drawFace(ctx, m, 0.8, -15.2);
  drawKepiCap(ctx, pal, m, 0.8, -15.2);
  ctx.restore();

  drawShadow(ctx, 4.8, 1.6, 8.2, 3.0);

  // 远侧辐条小轮 + 向后撑地单大架
  strokeSeg(ctx, 5.2, -2.0, -3.0, 1.8, m.ironDark, 1.7);
  ctx.beginPath();
  ctx.arc(4.2, -3.4, 3.3, 0, Math.PI * 2);
  ctx.fillStyle = m.woodDark;
  ctx.fill();
  ctx.strokeStyle = m.ironDark;
  ctx.lineWidth = 0.95;
  ctx.stroke();

  // 标志性「马克沁黄铜水冷粗套筒机枪」
  poly(ctx, [[1.8, -9.8], [6.6, -10.0], [6.6, -6.8], [1.8, -6.8]], m.ironMid, m.edge, 0.58);
  // 闪亮黄铜粗圆水冷套筒（蒸汽时代机械美学核心！）
  poly(ctx, [[6.4, -9.8], [13.8, -10.4], [13.8, -7.8], [6.4, -7.4]], m.brassMid, m.edge, 0.6);
  poly(ctx, [[6.6, -9.7], [13.6, -10.2], [13.6, -9.0], [6.6, -8.5]], m.brassLit);
  strokeSeg(ctx, 13.6, -9.1, 15.8, -9.3, m.ironDark, 1.4);

  // 倾斜矩形防弹钢盾（配阵营涂装）
  poly(ctx, [[4.8, -12.6], [8.8, -12.2], [9.6, -4.4], [5.4, -4.8]], m.steelMid, m.edge, 0.65);
  poly(ctx, [[5.0, -12.4], [7.0, -12.2], [7.6, -4.6], [5.6, -4.8]], m.steelLit);
  poly(ctx, [[5.2, -10.2], [8.9, -9.9], [9.2, -7.8], [5.3, -8.1]], pal.mid);

  // 近侧辐条炮轮（清晰铁箍木辐轮）
  ctx.beginPath();
  ctx.arc(6.6, -0.8, 3.8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(42, 34, 24, 0.25)';
  ctx.fill();
  ctx.strokeStyle = m.ironDark;
  ctx.lineWidth = 1.45;
  ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    strokeSeg(ctx, 6.6 - Math.cos(a) * 3.4, -0.8 - Math.sin(a) * 3.4, 6.6 + Math.cos(a) * 3.4, -0.8 + Math.sin(a) * 3.4, m.woodLit, 0.8);
  }
  ctx.beginPath();
  ctx.arc(6.6, -0.8, 1.0, 0, Math.PI * 2);
  ctx.fillStyle = m.brassLit;
  ctx.fill();

  ctx.restore();
}

/* =========================================================================
   3. 装甲车（armoredcar · 250 金 · 移 4 · 攻 22 · 甲 5 · 射程 3）：
   经典一战四轮铆接钢板装甲车——四枚大钢辐轮胎（无履带！）+ 铆接方正钢甲车身 + 顶部小圆机枪炮塔
   ========================================================================= */
function paintArmoredCar(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 0.8, 1.8, 13.0, 4.6);

  // 远侧前后轮胎轮廓
  for (const [wx, wy] of [[-7.6, -3.4], [5.8, -5.2]] as const) {
    ctx.beginPath();
    ctx.arc(wx, wy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = m.ironDark;
    ctx.fill();
  }

  // 方正铆接冷灰钢甲车身 + 前置长引擎盖与黄铜大车灯（经典劳斯莱斯/奥斯汀一战装甲车！）
  poly(ctx, [
    [-11.8, -3.4], [-11.0, -10.8], [2.4, -11.4], [4.4, -8.8],
    [12.2, -7.8], [13.2, -3.2], [10.4, -0.8], [-10.2, 1.2],
  ], m.steelShade, m.edge, 0.72);
  // 车身受光顶面与引擎盖顶
  poly(ctx, [[-10.8, -10.6], [-3.8, -13.2], [5.4, -12.6], [2.4, -11.2]], m.steelLit, m.edge, 0.58);
  poly(ctx, [[3.4, -8.8], [8.8, -10.6], [12.8, -8.0], [11.6, -7.0]], m.steelLit, m.edge, 0.55);
  // 车身侧面亮钢甲板 + 醒目阵营涂装横条 + 驾驶瞭望缝
  poly(ctx, [[-11.4, -3.4], [-10.6, -10.4], [2.4, -11.0], [4.2, -8.6], [11.8, -7.6], [12.4, -3.4], [-10.0, 0.6]], m.steelMid, m.edge, 0.58);
  poly(ctx, [[-10.8, -7.2], [3.6, -8.0], [3.8, -5.8], [-10.6, -5.0]], pal.mid);
  poly(ctx, [[-10.6, -7.1], [-3.0, -7.5], [-3.0, -5.5], [-10.5, -5.1]], pal.lit);
  // 驾驶观察狭缝 + 散热器百叶 + 闪亮黄铜车灯
  poly(ctx, [[1.8, -10.0], [4.2, -9.8], [4.2, -8.6], [1.8, -8.8]], m.ironDark);
  strokeSeg(ctx, 11.4, -6.6, 12.0, -3.8, m.ironDark, 1.4);
  ctx.beginPath();
  ctx.arc(12.2, -7.4, 1.15, 0, Math.PI * 2);
  ctx.fillStyle = m.brassLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.45;
  ctx.stroke();

  // 近侧标志性「双大钢轮橡胶胎」（明确无履带，一眼区别于时代 5 坦克！）
  const drawWheel = (wx: number, wy: number) => {
    ctx.beginPath();
    ctx.arc(wx, wy, 3.8, 0, Math.PI * 2);
    ctx.fillStyle = m.ironDark;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(wx, wy, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = m.steelMid;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(wx, wy, 0.85, 0, Math.PI * 2);
    ctx.fillStyle = m.brassLit;
    ctx.fill();
  };
  drawWheel(-6.6, 0.8);
  drawWheel(7.4, -1.0);

  // 顶部标志性「高耸圆筒形小机枪炮塔」（明显窄高小巧于坦克大炮塔）
  poly(ctx, [[-5.0, -11.0], [-4.8, -16.8], [2.4, -16.8], [2.6, -11.0]], m.steelMid, m.edge, 0.68);
  poly(ctx, [[-4.8, -11.2], [-4.6, -16.6], [-1.0, -16.6], [-1.0, -11.2]], m.steelLit);
  poly(ctx, [[-4.8, -14.8], [2.4, -14.8], [2.4, -13.2], [-4.8, -13.2]], pal.mid);
  ctx.beginPath();
  ctx.ellipse(-1.2, -16.8, 3.6, 1.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = m.steelLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // 炮塔伸出的细长机枪/速射炮管
  strokeSeg(ctx, 2.2, -14.2, 11.4, -15.4, m.edge, 2.4);
  strokeSeg(ctx, 2.2, -14.2, 11.4, -15.4, m.ironDark, 1.35);

  ctx.restore();
}

/* =========================================================================
   4. 农业公司（agribusiness · 260 金 · 移 2 · 经济）：
   经典蒸汽农用拖拉机（超大后铁轮 + 黑铁卧式黄铜箍锅炉 + 高耸细烟囱飘白汽 + 装满金谷的阵营货斗）
   ========================================================================= */
function paintAgribusiness(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 0.6, 1.8, 12.6, 4.6);

  // 标志性「黑铁卧式蒸汽锅炉车身 + 黄铜蒸汽包 + 高耸前烟囱与白汽」
  // 高细蒸汽烟囱
  poly(ctx, [[5.4, -11.4], [5.8, -21.8], [8.0, -21.8], [8.4, -11.4]], m.ironDark, m.edge, 0.6);
  poly(ctx, [[5.4, -21.8], [8.4, -21.8], [8.6, -20.6], [5.2, -20.6]], m.brassLit, m.edge, 0.45);
  // 袅袅白蒸汽
  ctx.fillStyle = 'rgba(244, 248, 250, 0.76)';
  ctx.beginPath();
  ctx.arc(6.6, -23.4, 1.8, 0, Math.PI * 2);
  ctx.arc(4.2, -25.0, 2.2, 0, Math.PI * 2);
  ctx.arc(1.8, -25.8, 1.5, 0, Math.PI * 2);
  ctx.fill();

  // 后置阵营色谷物货厢（堆满金黄谷袋）
  poly(ctx, [[-11.8, -2.4], [-11.8, -9.6], [-2.2, -10.8], [-2.2, -3.4]], pal.mid, m.edge, 0.65);
  poly(ctx, [[-11.6, -9.4], [-6.8, -11.6], [-2.0, -10.8], [-6.8, -8.8]], m.brassLit, m.edge, 0.55);
  poly(ctx, [[-11.6, -9.2], [-6.8, -8.8], [-6.8, -3.0], [-11.6, -3.6]], pal.lit);
  // 谷袋顶凸起
  ctx.fillStyle = m.khakiLit;
  ctx.beginPath();
  ctx.arc(-8.4, -10.6, 1.9, 0, Math.PI * 2);
  ctx.arc(-5.4, -10.8, 2.0, 0, Math.PI * 2);
  ctx.fill();

  // 卧式圆筒黑铁锅炉（带两道黄铜箍）
  poly(ctx, [[-2.4, -12.0], [9.4, -12.8], [10.4, -6.4], [-2.0, -5.4]], m.ironMid, m.edge, 0.68);
  poly(ctx, [[-2.2, -11.8], [9.2, -12.6], [9.6, -9.6], [-2.1, -8.8]], m.steelMid);
  poly(ctx, [[0.8, -12.2], [2.2, -12.3], [2.4, -5.8], [1.0, -5.7]], m.brassLit);
  poly(ctx, [[5.4, -12.5], [6.8, -12.6], [7.0, -6.2], [5.6, -6.1]], m.brassLit);
  // 驾驶位戴便帽司机与遮阳棚
  strokeSeg(ctx, -3.6, -10.4, -3.6, -18.2, m.ironDark, 1.0);
  strokeSeg(ctx, 2.0, -11.4, 2.0, -18.6, m.ironDark, 1.0);
  poly(ctx, [[-4.8, -18.0], [3.2, -18.6], [3.2, -17.4], [-4.8, -16.8]], pal.mid, m.edge, 0.55);
  ctx.beginPath();
  ctx.arc(-0.8, -14.6, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = m.skinLit;
  ctx.fill();

  // 标志性「超大红色/阵营铁辐后驱动轮 + 较小前转向轮」（蒸汽拖拉机灵魂轮廓！）
  const drawBigWheel = (wx: number, wy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(wx, wy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34, 28, 22, 0.25)';
    ctx.fill();
    ctx.strokeStyle = m.ironDark;
    ctx.lineWidth = 2.0;
    ctx.stroke();
    ctx.strokeStyle = pal.lit;
    ctx.lineWidth = 1.0;
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 4;
      strokeSeg(ctx, wx - Math.cos(a) * (r - 0.6), wy - Math.sin(a) * (r - 0.6), wx + Math.cos(a) * (r - 0.6), wy + Math.sin(a) * (r - 0.6), pal.mid, 0.9);
    }
    ctx.beginPath();
    ctx.arc(wx, wy, r * 0.26, 0, Math.PI * 2);
    ctx.fillStyle = m.brassLit;
    ctx.fill();
  };
  drawBigWheel(-4.4, -0.8, 5.2);
  drawBigWheel(7.6, -1.6, 3.2);

  ctx.restore();
}

/* =========================================================================
   5. 工程师（foreman · 190 金 · 建造者）：
   维多利亚/蒸汽工业总工团队——圆顶工长帽工程师架黄铜经纬仪三脚架 + 机械师扛大钢扳手与铁梁工具箱
   ========================================================================= */
function paintForeman(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后左扛大号钢扳手的蒸汽机械师
  ctx.save();
  ctx.translate(-4.6, -2.6);
  ctx.scale(0.94, 0.94);
  drawShadow(ctx, 1.5, 0.6, 4.2, 1.8);
  drawLegs(ctx, m, m.ironMid, m.ironDark, 0.82);
  poly(ctx, [[-2.5, -15.0], [2.4, -14.8], [2.6, -6.6], [-2.6, -6.8]], m.clothLit, m.edge, 0.6);
  poly(ctx, [[-2.4, -14.9], [2.3, -14.7], [2.4, -9.8], [-2.4, -9.8]], pal.mid, m.edge, 0.5);
  drawFace(ctx, m, 0.2, -17.6);
  poly(ctx, [[-2.2, -18.6], [-1.8, -20.4], [2.2, -20.4], [3.0, -18.6]], m.ironDark, m.edge, 0.52);
  // 肩扛标志性大号亮钢开口扳手（机械工程师直觉符号！）
  strokeSeg(ctx, -3.2, -10.8, 5.6, -20.4, m.edge, 2.5);
  strokeSeg(ctx, -3.2, -10.8, 5.6, -20.4, m.steelLit, 1.45);
  poly(ctx, [[3.8, -21.8], [6.6, -23.0], [7.8, -21.2], [5.8, -19.2], [5.2, -20.8]], m.steelLit, m.edge, 0.5);
  ctx.restore();

  // 前中穿风衣戴圆顶礼帽的蒸汽工程师
  ctx.save();
  ctx.translate(0.4, 1.4);
  drawShadow(ctx, 1.6, 0.6, 4.4, 1.9);
  drawLegs(ctx, m, m.ironMid, m.ironDark, 0.74);
  poly(ctx, [[-2.7, -15.4], [2.5, -15.2], [2.9, -6.0], [-2.8, -6.2]], m.ironMid, m.edge, 0.62);
  poly(ctx, [[-1.0, -15.2], [1.6, -15.1], [1.6, -9.8], [-1.0, -9.8]], pal.lit);
  drawFace(ctx, m, 0.3, -18.0);
  // 经典维多利亚圆顶硬礼帽（Bowler Hat）+ 阵营帽带
  poly(ctx, [[-3.4, -18.8], [3.6, -18.8], [3.2, -18.0], [-3.0, -18.0]], m.ironDark);
  ctx.beginPath();
  ctx.arc(0.2, -19.0, 2.3, Math.PI, 0, false);
  ctx.fillStyle = m.ironDark;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.55;
  ctx.stroke();
  strokeSeg(ctx, -2.0, -19.0, 2.4, -19.0, pal.lit, 0.9);
  ctx.restore();

  // 右前标志性「黄铜经纬仪测量三脚架」（一眼识别蒸汽时代工程师！）
  strokeSeg(ctx, 6.8, -13.6, 4.0, 1.8, m.woodMid, 1.25);
  strokeSeg(ctx, 6.8, -13.6, 9.8, 1.4, m.woodDark, 1.25);
  strokeSeg(ctx, 6.8, -13.6, 7.4, -0.4, m.woodLit, 1.1);
  // 顶部闪亮黄铜经纬仪望远筒
  poly(ctx, [[4.6, -15.4], [9.6, -16.0], [9.6, -13.6], [4.6, -13.2]], m.brassMid, m.edge, 0.55);
  poly(ctx, [[4.8, -15.3], [9.4, -15.8], [9.4, -14.6], [4.8, -14.2]], m.brassLit);

  ctx.restore();
}

/* =========================================================================
   6. 铁甲舰（ironclad · 300 金 · 移 4 · 攻 40 · 甲 10 · 血 82 · 破甲 · 射程 4）：
   低干舷铆接黑铁甲战舰 + 锐利撞角舰艏 + 中央双联重炮装甲圆炮塔 + 双高烟囱白烟 + 尾旗
   ========================================================================= */
function paintIronclad(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterWake(ctx, 14.4, 5.4, pal, opts.selected, opts.target);

  ctx.save();
  ctx.scale(opts.facing, 1);

  // 低干舷深铁灰铆接装甲船身 + 标志性前突钢铁撞角（Ram Bow）
  poly(ctx, [
    [-14.6, -3.4], [-9.4, -5.8], [9.4, -5.4], [15.4, -2.4],
    [16.8, 0.6], [11.2, 2.2], [-8.4, 2.4], [-13.4, 0.4],
  ], m.ironMid, m.edge, 0.78);
  // 受光装甲甲板
  poly(ctx, [[-13.8, -3.4], [-9.2, -5.6], [9.2, -5.2], [14.4, -2.6], [10.8, -1.2], [-9.6, -1.4]], m.steelMid);
  // 船舷阵营装甲水线带
  poly(ctx, [[-13.4, -1.2], [-8.6, 0.2], [10.4, 0.2], [15.6, -0.8], [15.0, 0.6], [10.4, 1.4], [-8.4, 1.4], [-13.0, 0.0]], pal.mid);
  // 吃水暗铁底
  poly(ctx, [[-13.0, 0.2], [-8.4, 1.6], [10.8, 1.6], [16.2, 0.4], [11.2, 2.4], [-8.4, 2.6], [-13.2, 0.8]], m.ironDark);

  // 双根高耸黑铁黄铜箍蒸汽大烟囱 + 飘向舰尾的浓白蒸汽（无风帆，纯粹工业铁甲舰！）
  const drawFunnel = (fx: number, h: number) => {
    poly(ctx, [[fx - 1.8, -4.6], [fx - 1.6, -4.6 - h], [fx + 1.6, -4.6 - h], [fx + 1.8, -4.6]], m.ironDark, m.edge, 0.6);
    poly(ctx, [[fx - 1.6, -4.6 - h], [fx + 0.2, -4.6 - h], [fx + 0.2, -4.6], [fx - 1.6, -4.6]], m.ironMid);
    poly(ctx, [[fx - 1.7, -4.6 - h + 2.2], [fx + 1.7, -4.6 - h + 2.2], [fx + 1.7, -4.6 - h + 4.4], [fx - 1.7, -4.6 - h + 4.4]], pal.lit);
  };
  drawFunnel(-5.4, 13.8);
  drawFunnel(-0.6, 15.2);
  // 滚滚蒸汽尾迹
  ctx.fillStyle = 'rgba(236, 242, 246, 0.72)';
  ctx.beginPath();
  ctx.arc(-2.6, -21.2, 2.1, 0, Math.PI * 2);
  ctx.arc(-6.4, -22.2, 2.5, 0, Math.PI * 2);
  ctx.arc(-10.4, -23.0, 2.0, 0, Math.PI * 2);
  ctx.arc(-13.8, -22.4, 1.5, 0, Math.PI * 2);
  ctx.fill();

  // 中前部标志性「圆形重装甲钢炮塔 + 双联重型舰炮」（铁甲舰火力核心！）
  poly(ctx, [[1.8, -4.2], [2.0, -10.8], [9.4, -10.8], [9.6, -4.2]], m.steelShade, m.edge, 0.68);
  poly(ctx, [[2.0, -4.4], [2.2, -10.6], [5.8, -10.6], [5.6, -4.4]], m.steelLit);
  ctx.beginPath();
  ctx.ellipse(5.7, -10.8, 3.7, 1.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = m.steelLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // 双联长管重型铁甲舰炮
  strokeSeg(ctx, 8.6, -8.8, 17.8, -10.8, m.edge, 2.8);
  strokeSeg(ctx, 8.6, -8.8, 17.8, -10.8, m.ironDark, 1.7);
  strokeSeg(ctx, 8.8, -6.8, 17.4, -8.6, m.edge, 2.8);
  strokeSeg(ctx, 8.8, -6.8, 17.4, -8.6, m.ironDark, 1.7);

  // 舰尾信号桅杆与海军旗
  strokeSeg(ctx, -11.4, -4.2, -12.6, -15.6, m.steelLit, 1.0);
  poly(ctx, [[-12.5, -15.4], [-18.2, -14.2], [-17.8, -10.8], [-12.1, -12.0]], pal.mid, m.edge, 0.48);

  strokeSeg(ctx, -10.6, 2.6, 12.6, 2.4, 'rgba(246, 252, 255, 0.8)', 0.95);
  ctx.restore();
}

/* =========================================================================
   7. 要塞（fortress · 230 金 · 甲 11 · 血 66 · 射程 4）：
   E4 同源红砖厚壁包灰石角星形要塞 + 顶置拱形铆接黑铁旋转重炮塔（锁定西北受光）
   ========================================================================= */
function paintFortress(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.6, 1.2], [5.8, -4.6], [16.0, 1.0], [1.6, 6.6]], 'rgba(24, 20, 18, 0.36)');

  // 工业灰石地基台座
  poly(ctx, [[-12.8, 0.2], [-7.4, -4.6], [7.4, -4.6], [12.8, 0.2], [7.4, 5.0], [-7.4, 5.0]], m.stoneShade, m.edge, 0.7);
  // 厚实红砖要塞立面（红砖与时代 3 冷灰炮台、时代 5 混凝土碉堡一眼划清时代界限！）
  poly(ctx, [[-12.2, -0.2], [-10.8, -11.4], [-6.2, -7.2], [-7.2, 4.6]], m.brickLit, m.edge, 0.7);
  poly(ctx, [[-7.2, 4.6], [-6.2, -7.2], [6.2, -7.2], [7.2, 4.6]], m.brickMid, m.edge, 0.7);
  poly(ctx, [[7.2, 4.6], [6.2, -7.2], [10.8, -11.4], [12.2, -0.2]], m.brickShade, m.edge, 0.7);
  // 灰石包角与要塞顶石坪
  strokeSeg(ctx, -6.7, 4.4, -6.2, -7.2, m.stoneTop, 1.5);
  strokeSeg(ctx, 6.7, 4.4, 6.2, -7.2, m.stoneLit, 1.5);
  poly(ctx, [[-10.8, -11.4], [-6.2, -15.4], [6.2, -15.4], [10.8, -11.4], [6.2, -7.2], [-6.2, -7.2]], m.stoneTop, m.edge, 0.7);

  // 红砖立面拱形炮眼与阵营徽旗
  poly(ctx, [[-4.2, -3.6], [-2.0, -3.6], [-2.0, -0.8], [-4.2, -0.8]], m.ironDark);
  poly(ctx, [[2.0, -3.6], [4.2, -3.6], [4.2, -0.8], [2.0, -0.8]], m.ironDark);
  poly(ctx, [[-2.2, -6.8], [2.2, -6.8], [2.2, 1.6], [0.0, 3.2], [-2.2, 1.6]], pal.mid, m.edge, 0.48);

  // 标志性「拱顶铆接黑铁旋转炮塔」（一战/蒸汽装甲要塞的经典灵魂！）
  poly(ctx, [[-5.6, -11.4], [-5.2, -17.2], [5.2, -17.2], [5.6, -11.4]], m.ironMid, m.edge, 0.68);
  poly(ctx, [[-5.4, -11.6], [-5.0, -17.0], [0.4, -17.0], [0.2, -11.6]], m.steelMid);
  ctx.beginPath();
  ctx.ellipse(0, -17.2, 5.2, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = m.steelLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.65;
  ctx.stroke();
  // 重型铁甲长炮管
  strokeSeg(ctx, 3.8, -14.6, 14.4, -16.8, m.edge, 3.8);
  strokeSeg(ctx, 3.8, -14.6, 14.4, -16.8, m.ironDark, 2.6);
  strokeSeg(ctx, 4.2, -15.1, 13.8, -17.2, m.steelLit, 0.75);

  // 要塞高旗
  strokeSeg(ctx, -7.2, -11.8, -7.2, -26.4, m.steelLit, 0.95);
  poly(ctx, [[-7.0, -26.2], [0.2, -24.8], [-7.0, -22.8]], pal.mid, m.edge, 0.48);
  poly(ctx, [[-7.0, -26.0], [-2.4, -25.1], [-7.0, -24.2]], pal.lit);
}

/* =========================================================================
   8. 兵工厂（arsenal · 260 金 · 经济建筑 · 甲 7）：
   E4 城池标志性「双锥形红砖大烟囱 + 红砖锯齿厂房 + 暖黄工业拱窗 + 蒸汽云」（锁定西北受光）
   ========================================================================= */
function paintArsenal(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.6, 1.4], [5.2, -5.0], [15.8, 1.2], [1.4, 6.6]], 'rgba(24, 20, 18, 0.35)');

  // 工业灰石地基
  poly(ctx, [[-12.8, 0.0], [0.0, -6.2], [12.8, 0.0], [0.0, 5.8]], m.stoneShade, m.edge, 0.68);
  poly(ctx, [[-12.0, 0.0], [0.0, -5.6], [12.0, 0.0], [0.0, 5.0]], m.stoneTop);

  // 标志性「一高一低双根红砖大烟囱 + 蒸汽云」（E4 蒸汽时代最鲜明图腾！）
  const drawChimney = (cx: number, cy: number, h: number) => {
    poly(ctx, [[cx - 2.0, cy], [cx - 1.3, cy - h], [cx + 1.3, cy - h], [cx + 2.0, cy]], m.brickMid, m.edge, 0.6);
    poly(ctx, [[cx - 1.8, cy], [cx - 1.2, cy - h], [cx + 0.1, cy - h], [cx + 0.1, cy]], m.brickLit);
    poly(ctx, [[cx - 1.5, cy - h + 0.6], [cx + 1.5, cy - h + 0.6], [cx + 1.5, cy - h - 1.0], [cx - 1.5, cy - h - 1.0]], m.ironDark);
    ctx.fillStyle = 'rgba(242, 245, 247, 0.74)';
    ctx.beginPath();
    ctx.arc(cx + 1.2, cy - h - 2.6, 1.8, 0, Math.PI * 2);
    ctx.arc(cx + 3.8, cy - h - 4.4, 2.2, 0, Math.PI * 2);
    ctx.fill();
  };
  drawChimney(2.4, -10.8, 21.0);
  drawChimney(7.6, -8.2, 16.4);

  // 红砖锯齿双跨工业厂房
  poly(ctx, [[-11.2, -0.4], [-11.2, -11.4], [0.4, -5.8], [0.4, 4.6]], m.brickLit, m.edge, 0.72);
  poly(ctx, [[0.4, 4.6], [0.4, -5.8], [9.8, -10.4], [9.8, -0.2]], m.brickShade, m.edge, 0.72);
  // 深黑铁皮锯齿大屋顶
  poly(ctx, [[-12.2, -11.0], [-6.6, -18.2], [4.6, -12.8], [0.2, -5.2]], m.ironMid, m.edge, 0.7);
  poly(ctx, [[-6.6, -18.2], [2.4, -22.2], [11.2, -17.4], [4.6, -12.8]], m.ironDark, m.edge, 0.65);
  poly(ctx, [[0.2, -5.2], [4.6, -12.8], [10.6, -10.0]], m.ironDark, m.edge, 0.65);

  // 标志性「暖黄工业大拱窗」+ 阵营工厂招牌带
  poly(ctx, [[-8.2, 0.8], [-8.2, -4.4], [-5.2, -3.0], [-5.2, 2.2]], m.ironDark, m.edge, 0.55);
  for (const [wx, wy] of [[2.6, -1.6], [6.0, -3.2]] as const) {
    poly(ctx, [[wx, wy], [wx + 2.0, wy - 1.0], [wx + 2.0, wy - 4.4], [wx, wy - 3.4]], m.brassLit, m.edge, 0.45);
  }
  poly(ctx, [[-11.0, -9.8], [0.2, -4.4], [0.2, -3.0], [-11.0, -8.4]], pal.mid);
  poly(ctx, [[-11.0, -9.8], [-5.4, -7.1], [-5.4, -5.8], [-11.0, -8.4]], pal.lit);
}

/* =========================================================================
   9. 兵站（camp4 · 240 金 · 甲 7 · 血 64 · 产兵 + 自动攻击）：
   穿过前院的双轨钢铁道 + 红砖尖顶兵站主楼 + 铁架补给水塔 + 站前军需箱与战旗（锁定西北受光）
   ========================================================================= */
function paintCamp4(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-13.0, 1.2], [2.4, -6.4], [15.4, 0.8], [0.8, 7.0]], 'rgba(24, 20, 18, 0.35)');

  // 工业灰石站台基坪
  poly(ctx, [[-13.0, -0.2], [0.0, -6.6], [13.0, -0.2], [0.0, 5.8]], m.stoneShade, m.edge, 0.7);
  poly(ctx, [[-12.2, -0.2], [0.0, -6.0], [12.2, -0.2], [0.0, 5.2]], m.stoneTop);

  // 标志性「斜穿前院的蒸汽铁轨」（直接呼应 E4 蒸汽城池铁道语言！）
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const x = -7.6 + t * 14.8;
    const y = 1.6 - t * 2.6;
    strokeSeg(ctx, x - 0.8, y - 1.2, x + 1.0, y + 1.2, m.woodDark, 1.0);
  }
  strokeSeg(ctx, -8.4, 0.8, 7.8, -2.0, m.ironDark, 1.0);
  strokeSeg(ctx, -7.2, 2.4, 9.0, -0.4, m.ironDark, 1.0);

  // 红砖尖顶兵站司令部主屋（左后）
  poly(ctx, [[-9.8, -1.0], [-9.8, -9.2], [-1.8, -5.4], [-1.8, 2.4]], m.brickLit, m.edge, 0.68);
  poly(ctx, [[-1.8, 2.4], [-1.8, -5.4], [4.4, -8.4], [4.4, -0.8]], m.brickShade, m.edge, 0.68);
  poly(ctx, [[-11.2, -9.0], [-4.4, -16.8], [5.8, -8.4], [-1.8, -4.6]], m.ironMid, m.edge, 0.7);
  poly(ctx, [[-10.8, -9.0], [-4.4, -16.4], [-1.8, -4.9]], m.steelShade);
  // 站台暖黄窗与阵营横幅
  poly(ctx, [[-7.4, -4.6], [-5.4, -3.6], [-5.4, -1.2], [-7.4, -2.2]], m.brassLit, m.edge, 0.45);
  poly(ctx, [[-9.6, -8.0], [-2.0, -4.4], [-2.0, -3.2], [-9.6, -6.8]], pal.mid);

  // 右侧标志性「蒸汽铁架高脚补给水塔」（一眼识别蒸汽铁路兵站！）
  const tx = 7.4;
  const ty = -2.2;
  strokeSeg(ctx, tx - 2.6, ty, tx - 1.8, ty - 11.4, m.ironDark, 1.25);
  strokeSeg(ctx, tx + 2.6, ty, tx + 1.8, ty - 11.4, m.ironDark, 1.25);
  strokeSeg(ctx, tx - 2.2, ty - 4.8, tx + 2.2, ty - 8.2, m.ironMid, 0.8);
  strokeSeg(ctx, tx + 2.2, ty - 4.8, tx - 2.2, ty - 8.2, m.ironMid, 0.8);
  // 圆木铁箍大水箱 + 锥顶
  poly(ctx, [[tx - 3.4, ty - 11.2], [tx - 3.4, ty - 16.8], [tx + 3.4, ty - 16.8], [tx + 3.4, ty - 11.2]], m.woodMid, m.edge, 0.6);
  poly(ctx, [[tx - 3.2, ty - 11.4], [tx - 3.2, ty - 16.6], [tx + 0.2, ty - 16.6], [tx + 0.2, ty - 11.4]], m.woodLit);
  strokeSeg(ctx, tx - 3.4, ty - 13.0, tx + 3.4, ty - 13.0, m.ironDark, 0.85);
  strokeSeg(ctx, tx - 3.4, ty - 15.2, tx + 3.4, ty - 15.2, m.ironDark, 0.85);
  poly(ctx, [[tx - 4.0, ty - 16.6], [tx, ty - 20.4], [tx + 4.0, ty - 16.6]], m.ironMid, m.edge, 0.58);

  // 站前高耸军旗
  strokeSeg(ctx, -9.8, 0.6, -9.8, -22.2, m.steelLit, 1.0);
  poly(ctx, [[-9.6, -22.0], [-1.0, -20.4], [-2.2, -18.0], [-0.8, -15.6], [-9.6, -16.6]], pal.mid, m.edge, 0.52);
  poly(ctx, [[-9.6, -21.8], [-4.2, -20.8], [-4.6, -17.0], [-9.6, -17.4]], pal.lit);
}

export const ERA4_UNIT_SPECS: Readonly<Record<string, Era1UnitSpec>> = {
  rifleman: { paint: paintRifleman, hitTop: 26 },
  mg: { paint: paintMg, ringRx: 11.4, ringRy: 4.9, barY: 5.4, hitTop: 23 },
  armoredcar: { paint: paintArmoredCar, ringRx: 13.0, ringRy: 5.5, barY: 5.8, hitTop: 22 },
  agribusiness: { paint: paintAgribusiness, ringRx: 12.8, ringRy: 5.4, barY: 5.8, hitTop: 28 },
  foreman: { paint: paintForeman, ringRx: 11.4, ringRy: 4.9, hitTop: 26 },
  ironclad: { paint: paintIronclad, waterUnit: true, barY: 6.4, hitTop: 26 },
  fortress: { paint: paintFortress, ringRx: 13.0, ringRy: 5.6, barY: 6.2, hitTop: 28 },
  arsenal: { paint: paintArsenal, ringRx: 13.2, ringRy: 5.8, barY: 6.4, hitTop: 35 },
  camp4: { paint: paintCamp4, ringRx: 13.2, ringRy: 5.8, barY: 6.6, hitTop: 28 },
};

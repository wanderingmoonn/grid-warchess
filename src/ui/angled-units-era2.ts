/**
 * 时代 2（铁器时代）原版全 10 个兵种与建筑的斜俯视 3D 微缩沙盘绘制模块。
 *
 * 与时代 1（青铜）保持统一 4.8 头身写实微缩战棋风格与西北受光体系，同时拉开鲜明时代阶梯：
 * - 金属由青铜暖黄升级为冷铁锻钢（铁盔、铁甲、大盾、钢弩、长骑枪、双刃铁斧）；
 * - 建筑由青铜木栅茅草升级为与 E2 铁器城池同源的黄砂岩石砌 + 暖赤陶瓦顶（石堡 / 水车 / 寨垒）；
 * - 水军由单舟舢板升级为重檐双层战楼与多桨划水的重型楼船。
 */

import type { AngledUnitPaintOpts, TeamClothPalette } from './angled-units.ts';
import type { Era1UnitSpec } from './angled-units-era1.ts';

interface Era2Mat {
  edge: string;
  steelLit: string;
  steelMid: string;
  steelShade: string;
  ironDark: string;
  clothLit: string;
  clothMid: string;
  clothShade: string;
  leatherLit: string;
  leatherMid: string;
  leatherDark: string;
  skinLit: string;
  skinShade: string;
  hairDark: string;
  woodLit: string;
  woodMid: string;
  woodDark: string;
  sandTop: string;
  sandLit: string;
  sandMid: string;
  sandShade: string;
  tileLit: string;
  tileMid: string;
  tileShade: string;
  horseLit: string;
  horseMid: string;
  horseShade: string;
  waterLit: string;
  waterMid: string;
}

function getMat(dim: boolean): Era2Mat {
  return {
    edge: dim ? 'rgba(40, 38, 35, 0.64)' : 'rgba(34, 30, 25, 0.74)',
    steelLit: dim ? '#bfc4c8' : '#dde4e9',
    steelMid: dim ? '#969ca1' : '#a4b0ba',
    steelShade: dim ? '#696e73' : '#66737e',
    ironDark: dim ? '#484c50' : '#3d454e',
    clothLit: dim ? '#c7c2b7' : '#dfd6c2',
    clothMid: dim ? '#a8a296' : '#bfb39a',
    clothShade: dim ? '#807b72' : '#8d816b',
    leatherLit: dim ? '#8c867c' : '#8a623d',
    leatherMid: dim ? '#6e685f' : '#654529',
    leatherDark: dim ? '#4c4842' : '#402a18',
    skinLit: dim ? '#c9bfb2' : '#e6be96',
    skinShade: dim ? '#a3998d' : '#bc8f66',
    hairDark: dim ? '#4b4843' : '#35291f',
    woodLit: dim ? '#9c9487' : '#ad8250',
    woodMid: dim ? '#7d7569' : '#855f38',
    woodDark: dim ? '#585249' : '#553a20',
    sandTop: dim ? '#c2bcaf' : '#d6c6a4',
    sandLit: dim ? '#afa99d' : '#bea982',
    sandMid: dim ? '#969085' : '#a4906a',
    sandShade: dim ? '#767168' : '#806e4f',
    tileLit: dim ? '#a69689' : '#c77c44',
    tileMid: dim ? '#8d7f73' : '#a56030',
    tileShade: dim ? '#6b6058' : '#7b441e',
    horseLit: dim ? '#9c948b' : '#8f5e39',
    horseMid: dim ? '#7d766e' : '#6e4426',
    horseShade: dim ? '#59544e' : '#482b16',
    waterLit: dim ? '#9bb0b8' : '#88bfd6',
    waterMid: dim ? '#758c96' : '#5592b0',
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
  ctx.fillStyle = 'rgba(26, 22, 16, 0.34)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0.14, 0, Math.PI * 2);
  ctx.fill();
}

function drawLegs(ctx: CanvasRenderingContext2D, m: Era2Mat, armored: boolean, stride = 0.9, kneel = false): void {
  const colFront = armored ? m.steelMid : m.leatherMid;
  const colBack = armored ? m.steelShade : m.leatherDark;
  const boot = armored ? m.ironDark : m.woodDark;
  if (kneel) {
    poly(ctx, [[-2.2, -5.8], [-0.4, -5.8], [-2.0, -1.8], [-3.8, -2.0]], colBack, m.edge, 0.52);
    poly(ctx, [[-3.8, -2.0], [-2.0, -1.8], [-1.3, 0.4], [-3.2, 0.3]], boot);
    poly(ctx, [[0.1, -5.6], [2.1, -5.4], [3.0, -1.8], [1.1, -2.0]], colFront, m.edge, 0.52);
    poly(ctx, [[1.1, -2.0], [3.0, -1.8], [3.5, 0.7], [1.3, 0.7]], boot);
    return;
  }
  poly(ctx, [[-2.0, -7.8], [-0.4, -7.8], [-1.2 * stride - 1.0, -2.4], [-2.6 * stride - 0.8, -2.6]], colBack, m.edge, 0.52);
  poly(ctx, [[-2.6 * stride - 0.8, -2.7], [-1.2 * stride - 1.0, -2.5], [-1.4 * stride - 1.1, 0.3], [-2.9 * stride - 1.0, 0.2]], boot);
  poly(ctx, [[0.0, -7.6], [1.9, -7.6], [2.1 * stride + 0.5, -2.2], [0.5 * stride + 0.4, -2.4]], colFront, m.edge, 0.52);
  poly(ctx, [[0.5 * stride + 0.4, -2.4], [2.1 * stride + 0.5, -2.2], [2.5 * stride + 0.5, 0.7], [0.6 * stride + 0.4, 0.7]], boot);
}

function drawFace(ctx: CanvasRenderingContext2D, m: Era2Mat, hx: number, hy: number): void {
  poly(ctx, [[hx - 0.8, hy + 2.0], [hx + 0.9, hy + 2.0], [hx + 0.9, hy + 3.0], [hx - 0.8, hy + 3.0]], m.skinShade);
  poly(ctx, [
    [hx - 1.6, hy - 1.3], [hx + 1.5, hy - 1.3], [hx + 1.7, hy + 0.5],
    [hx + 0.9, hy + 2.1], [hx - 1.1, hy + 2.1], [hx - 1.7, hy + 0.6],
  ], m.skinLit, m.edge, 0.58);
  poly(ctx, [[hx + 0.2, hy - 1.1], [hx + 1.4, hy - 1.1], [hx + 1.5, hy + 0.5], [hx + 0.8, hy + 1.9], [hx + 0.1, hy + 1.9]], m.skinShade);
}

/* =========================================================================
   1. 长枪兵（spearman · 65 金 · 盾墙）：冷钢圆锥铁盔 + 铁札甲 + 醒目大阵营盾 + 超长钢矛
   ========================================================================= */
function drawSpearmanSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era2Mat, variant: 0 | 1): void {
  drawShadow(ctx, 2.0, 0.6, 4.9, 2.0);
  drawLegs(ctx, m, true, variant === 0 ? 0.95 : 0.75);

  const lean = variant === 0 ? 0.45 : 0.15;
  // 铁甲下裙 + 阵营战袍边
  poly(ctx, [[-2.7, -9.8], [2.5, -9.8], [3.0, -6.2], [-3.0, -6.4]], pal.mid, m.edge, 0.6);
  poly(ctx, [[-2.6, -9.6], [0.2, -9.6], [0.0, -6.4], [-2.8, -6.5]], pal.lit);
  // 锻铁札甲胸甲（清晰冷钢金属反光，一眼压过青铜时代）
  poly(ctx, [[-2.8 + lean, -15.5], [2.5 + lean, -15.3], [2.6, -9.6], [-2.6, -9.6]], m.steelMid, m.edge, 0.68);
  poly(ctx, [[-2.6 + lean, -15.3], [0.4 + lean, -15.2], [0.2, -9.8], [-2.4, -9.8]], m.steelLit);
  poly(ctx, [[1.0 + lean, -15.1], [2.3 + lean, -15.1], [2.4, -9.8], [1.1, -9.8]], m.steelShade);
  strokeSeg(ctx, -2.4 + lean, -13.2, 2.2 + lean, -13.0, m.ironDark, 0.55);
  strokeSeg(ctx, -2.5, -11.3, 2.3, -11.1, m.ironDark, 0.55);
  poly(ctx, [[-2.6, -10.2], [2.5, -10.0], [2.5, -9.2], [-2.6, -9.4]], m.leatherDark);

  // 头部 + 亮钢护鼻尖顶盔
  const hx = lean * 1.1;
  const hy = -18.0;
  drawFace(ctx, m, hx, hy);
  poly(ctx, [
    [hx - 2.3, hy - 0.5], [hx - 2.2, hy - 2.4], [hx, hy - 4.3],
    [hx + 2.2, hy - 2.3], [hx + 2.1, hy - 0.5],
  ], m.steelMid, m.edge, 0.65);
  poly(ctx, [[hx - 2.1, hy - 2.3], [hx, hy - 4.1], [hx + 0.3, hy - 0.8], [hx - 2.1, hy - 0.8]], m.steelLit);
  poly(ctx, [[hx + 0.5, hy - 3.6], [hx + 2.0, hy - 2.2], [hx + 1.9, hy - 0.7], [hx + 0.6, hy - 0.7]], m.steelShade);
  // 护鼻铁条
  strokeSeg(ctx, hx + 0.4, hy - 1.2, hx + 0.5, hy + 0.9, m.steelLit, 0.85);

  // 超长钢矛（比民兵木矛更长、更直、配冷钢菱形长枪头）
  const sx0 = variant === 0 ? -5.8 : -4.4;
  const sy0 = variant === 0 ? -7.2 : -6.2;
  const sx1 = variant === 0 ? 11.2 : 8.6;
  const sy1 = variant === 0 ? -22.2 : -27.2;
  strokeSeg(ctx, sx0, sy0, sx1, sy1, m.edge, 2.1);
  strokeSeg(ctx, sx0, sy0, sx1, sy1, m.woodDark, 1.2);
  strokeSeg(ctx, sx0 + 0.25, sy0 - 0.25, sx1 - 0.3, sy1 - 0.25, m.woodLit, 0.45);
  const dx = sx1 - sx0;
  const dy = sy1 - sy0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  poly(ctx, [
    [sx1 - ux * 0.4, sy1 - uy * 0.4],
    [sx1 + ux * 1.2 + px * 1.3, sy1 + uy * 1.2 + py * 1.3],
    [sx1 + ux * 5.2, sy1 + uy * 5.2],
    [sx1 + ux * 1.2 - px * 1.3, sy1 + uy * 1.2 - py * 1.3],
  ], m.steelShade, m.edge, 0.55);
  poly(ctx, [
    [sx1 - ux * 0.4, sy1 - uy * 0.4],
    [sx1 + ux * 1.2 + px * 1.3, sy1 + uy * 1.2 + py * 1.3],
    [sx1 + ux * 5.2, sy1 + uy * 5.2],
  ], m.steelLit);

  // 标志性「盾墙」大鸢形铁缘战盾（护在身前，1× 一眼认出长枪兵！）
  const shx = 2.6 + lean * 0.6;
  const shy = -10.6;
  poly(ctx, [
    [shx - 2.6, shy - 4.2], [shx + 2.8, shy - 3.8],
    [shx + 2.6, shy + 1.4], [shx + 0.2, shy + 5.0],
    [shx - 2.4, shy + 1.6],
  ], pal.mid, m.steelLit, 1.15);
  poly(ctx, [
    [shx - 2.3, shy - 3.9], [shx + 0.2, shy - 3.7],
    [shx + 0.1, shy + 4.4], [shx - 2.1, shy + 1.4],
  ], pal.lit);
  // 盾心钢铆凸饰 + 描细暗边
  poly(ctx, [
    [shx - 2.8, shy - 4.4], [shx + 3.0, shy - 4.0],
    [shx + 2.8, shy + 1.5], [shx + 0.2, shy + 5.2],
    [shx - 2.6, shy + 1.7],
  ], 'transparent', m.edge, 0.55);
  ctx.beginPath();
  ctx.arc(shx + 0.2, shy - 0.6, 1.25, 0, Math.PI * 2);
  ctx.fillStyle = m.steelLit;
  ctx.fill();
  ctx.strokeStyle = m.ironDark;
  ctx.lineWidth = 0.45;
  ctx.stroke();
}

function paintSpearman(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.6, -2.7);
  ctx.scale(0.95, 0.95);
  drawSpearmanSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.3, 1.5);
  ctx.scale(1.02, 1.02);
  drawSpearmanSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   2. 弩兵（crossbow · 82 金 · 破甲 · 射程 3）：宽檐铁笠盔 + 横置 T 形钢臂强弩
   ========================================================================= */
function drawCrossbowSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era2Mat, variant: 0 | 1): void {
  drawShadow(ctx, 1.8, 0.6, 4.6, 1.9);
  drawLegs(ctx, m, false, variant === 0 ? 0.9 : 0.72, variant === 0);

  const yDrop = variant === 0 ? 1.8 : 0;
  const lean = variant === 0 ? 1.0 : 0.45;
  ctx.save();
  ctx.translate(0, yDrop);

  // 厚实绗缝棉甲 + 阵营罩袍
  poly(ctx, [[-2.6, -9.8], [2.4, -9.8], [2.8, -6.5], [-2.8, -6.7]], m.leatherMid, m.edge, 0.58);
  poly(ctx, [[-2.7 + lean, -15.2], [2.4 + lean, -15.0], [2.5, -9.6], [-2.5, -9.6]], pal.mid, m.edge, 0.65);
  poly(ctx, [[-2.5 + lean, -15.0], [0.3 + lean, -14.9], [0.1, -9.8], [-2.3, -9.8]], pal.lit);
  poly(ctx, [[0.9 + lean, -14.9], [2.2 + lean, -14.9], [2.3, -9.8], [1.0, -9.8]], pal.shade);
  // 金属胸扣带
  poly(ctx, [[-2.5, -10.3], [2.4, -10.1], [2.4, -9.2], [-2.5, -9.4]], m.leatherDark);

  // 头部 + 标志性宽檐冷钢铁笠盔（Kettle Hat，与长枪尖盔和弓手布巾一眼区分）
  const hx = lean * 1.1;
  const hy = -17.8;
  drawFace(ctx, m, hx, hy);
  ctx.beginPath();
  ctx.ellipse(hx, hy - 1.2, 4.4, 1.25, 0, 0, Math.PI * 2);
  ctx.fillStyle = m.steelShade;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.6;
  ctx.stroke();
  poly(ctx, [
    [hx - 4.3, hy - 1.3], [hx - 2.0, hy - 3.5], [hx + 1.8, hy - 3.5],
    [hx + 4.3, hy - 1.3], [hx, hy - 0.5],
  ], m.steelMid, m.edge, 0.62);
  poly(ctx, [[hx - 4.0, hy - 1.3], [hx - 1.8, hy - 3.3], [hx + 0.3, hy - 3.3], [hx + 0.1, hy - 0.7]], m.steelLit);

  // 标志性「横置机械强弩」（木托水平前指 + 宽弧冷钢横弩臂 + 上膛铁镞短矢）
  const cx0 = -0.4 + lean;
  const cy0 = -12.6;
  const cx1 = 10.6;
  const cy1 = -13.2;
  // 横钢弩臂（从远景看呈鲜明斜十字 T 形）
  ctx.beginPath();
  ctx.moveTo(6.2, -16.8);
  ctx.quadraticCurveTo(9.8, -14.8, 9.6, -13.0);
  ctx.quadraticCurveTo(9.4, -11.2, 5.4, -9.6);
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = m.steelLit;
  ctx.lineWidth = 1.45;
  ctx.stroke();
  // 拉紧弩弦
  ctx.beginPath();
  ctx.moveTo(6.2, -16.8);
  ctx.lineTo(3.4, -12.9);
  ctx.lineTo(5.4, -9.6);
  ctx.strokeStyle = 'rgba(245, 240, 226, 0.85)';
  ctx.lineWidth = 0.65;
  ctx.stroke();
  // 粗实木弩身 + 钢弩矢尖
  strokeSeg(ctx, cx0, cy0, cx1, cy1, m.edge, 2.8);
  strokeSeg(ctx, cx0, cy0, cx1, cy1, m.woodMid, 1.75);
  strokeSeg(ctx, cx0 + 0.4, cy0 - 0.35, cx1 - 0.5, cy1 - 0.35, m.woodLit, 0.55);
  poly(ctx, [[cx1 - 0.6, cy1 - 1.0], [cx1 + 2.8, cy1 - 0.1], [cx1 - 0.6, cy1 + 0.9]], m.steelLit, m.edge, 0.45);
  // 双手稳托弩托
  poly(ctx, [[1.2 + lean, -13.8], [2.4 + lean, -13.2], [5.4, -12.2], [4.4, -11.2]], m.skinLit, m.edge, 0.48);

  ctx.restore();
}

function paintCrossbow(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.6, -2.7);
  ctx.scale(0.95, 0.95);
  drawCrossbowSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.1, 1.5);
  ctx.scale(1.0, 1.0);
  drawCrossbowSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   3. 长弓手（longbow · 90 金 · 射程 4）：铁额帽 + 阵营长战袍 + 高过头顶紫杉巨长弓 + 拒马木桩
   ========================================================================= */
function drawLongbowSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era2Mat, variant: 0 | 1): void {
  drawShadow(ctx, 1.8, 0.6, 4.5, 1.9);
  drawLegs(ctx, m, false, variant === 0 ? 0.9 : 0.72);

  const lean = variant === 0 ? 0.45 : 0.2;
  // 锁甲底衫 + 长摆阵营纹章战袍（比时代 1 弓手明显更精锐正规）
  poly(ctx, [[-2.6, -9.8], [2.4, -9.8], [2.9, -5.8], [-2.9, -6.0]], pal.mid, m.edge, 0.6);
  poly(ctx, [[-2.5, -9.6], [0.2, -9.6], [0.0, -6.0], [-2.7, -6.1]], pal.lit);
  poly(ctx, [[-2.6 + lean, -15.3], [2.3 + lean, -15.1], [2.4, -9.6], [-2.4, -9.6]], pal.mid, m.edge, 0.65);
  poly(ctx, [[-2.4 + lean, -15.1], [0.3 + lean, -15.0], [0.1, -9.8], [-2.2, -9.8]], pal.lit);
  // 胸前锁甲钢链斜饰 + 腰箭袋
  poly(ctx, [[-2.4 + lean, -15.1], [-0.9 + lean, -15.1], [2.2, -10.0], [1.0, -9.9]], m.steelMid);
  poly(ctx, [[-4.4, -11.4], [-2.4, -11.8], [-1.8, -6.2], [-3.8, -6.0]], m.leatherDark, m.edge, 0.5);
  strokeSeg(ctx, -4.1, -11.8, -5.0, -14.2, m.clothLit, 0.95);
  strokeSeg(ctx, -3.3, -12.0, -3.9, -14.5, m.clothLit, 0.95);

  // 头部 + 贴头钢帽 + 阵营兜领
  const hx = lean * 1.1;
  const hy = -18.0;
  drawFace(ctx, m, hx, hy);
  poly(ctx, [
    [hx - 2.1, hy - 0.6], [hx - 2.0, hy - 2.6], [hx + 0.2, hy - 3.3],
    [hx + 2.0, hy - 2.3], [hx + 1.8, hy - 0.8],
  ], m.steelMid, m.edge, 0.6);
  poly(ctx, [[hx - 1.9, hy - 2.4], [hx + 0.1, hy - 3.1], [hx + 0.2, hy - 1.0], [hx - 1.9, hy - 0.9]], m.steelLit);

  // 高过头顶的超长紫杉长弓（全高约 22px，从膝下直贯头顶上方，射程 4 辨识度无敌！）
  const aimUp = variant === 1 ? -1.4 : -0.4;
  const handX = 5.6;
  const handY = -13.6 + aimUp;
  const bowTopX = 4.4;
  const bowTopY = -26.8 + aimUp;
  const bowBotX = 4.0;
  const bowBotY = -3.4 + aimUp;
  const drawX = 1.6;
  const drawY = -13.6 + aimUp * 0.4;

  // 臂
  poly(ctx, [[1.3 + lean, -14.2], [2.4 + lean, -13.6], [handX, handY + 0.6], [handX - 0.4, handY - 0.6]], m.steelMid, m.edge, 0.48);

  // 绷紧长弦
  ctx.beginPath();
  ctx.moveTo(bowTopX, bowTopY);
  ctx.lineTo(drawX, drawY);
  ctx.lineTo(bowBotX, bowBotY);
  ctx.strokeStyle = 'rgba(246, 240, 224, 0.88)';
  ctx.lineWidth = 0.68;
  ctx.stroke();

  // 超长紫杉木弓身（深红棕紫杉木 + 上下牛角弓弭高光）
  ctx.beginPath();
  ctx.moveTo(bowTopX, bowTopY);
  ctx.quadraticCurveTo(8.8, -19.8 + aimUp, handX + 1.1, handY);
  ctx.quadraticCurveTo(8.4, -7.8 + aimUp, bowBotX, bowBotY);
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = m.tileMid;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bowTopX, bowTopY);
  ctx.quadraticCurveTo(8.4, -19.8 + aimUp, handX + 0.9, handY);
  ctx.strokeStyle = m.woodLit;
  ctx.lineWidth = 0.55;
  ctx.stroke();

  // 长羽箭（钢穿甲箭簇）
  const ax1 = 12.2;
  const ay1 = -15.4 + aimUp * 1.4;
  strokeSeg(ctx, drawX, drawY, ax1, ay1, m.woodDark, 1.0);
  poly(ctx, [[ax1 - 1.3, ay1 - 0.8], [ax1 + 1.8, ay1 - 0.2], [ax1 - 1.1, ay1 + 0.9]], m.steelLit, m.edge, 0.4);
  strokeSeg(ctx, drawX - 0.6, drawY - 0.7, drawX + 0.9, drawY - 0.1, pal.lit, 0.9);
  strokeSeg(ctx, drawX - 0.6, drawY + 0.7, drawX + 0.9, drawY + 0.1, pal.lit, 0.9);
}

function paintLongbow(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.7, -2.7);
  ctx.scale(0.95, 0.95);
  drawLongbowSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(2.8, 1.5);
  ctx.scale(1.0, 1.0);
  drawLongbowSoldier(ctx, pal, m, 0);
  ctx.restore();

  // 前阵两根斜插地面的尖削拒马木桩（长弓阵地标志细节）
  strokeSeg(ctx, 6.2, 2.8, 10.6, -2.8, m.edge, 1.8);
  strokeSeg(ctx, 6.2, 2.8, 10.6, -2.8, m.woodLit, 1.0);
  strokeSeg(ctx, 3.8, 3.6, 8.2, -1.6, m.edge, 1.7);
  strokeSeg(ctx, 3.8, 3.6, 8.2, -1.6, m.woodMid, 0.95);

  ctx.restore();
}

/* =========================================================================
   4. 骑士（knight · 95 金 · 移 3 · 攻 17 · 甲 4）：
   克制定位为时代 2 早期铁甲骑兵（裸背战马+简洁鞍垫、露脸尖顶铁盔、短罩衣、小骑盾、直骑矛），
   刻意不堆叠全覆板甲、马衣、马面甲、大披风、大羽缨与大枪旗，为后续骠骑兵/重装骑兵/板甲骑留足变体空间。
   ========================================================================= */
function paintKnight(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 战马落地投影
  drawShadow(ctx, 1.2, 1.0, 10.8, 3.8);

  // 自然栗色马尾
  poly(ctx, [[-9.2, -11.4], [-13.2, -9.2], [-13.6, -5.8], [-11.5, -6.6], [-9.8, -9.4]], m.hairDark, m.edge, 0.55);

  // 后侧双腿（暗影）
  poly(ctx, [[-8.2, -6.6], [-6.2, -6.6], [-7.8, -1.2], [-9.3, -1.4]], m.horseShade, m.edge, 0.55);
  poly(ctx, [[-9.3, -1.4], [-7.8, -1.2], [-7.6, 0.4], [-9.4, 0.4]], m.hairDark);
  poly(ctx, [[3.6, -6.6], [5.8, -6.6], [8.6, -2.6], [7.0, -1.8]], m.horseShade, m.edge, 0.55);

  // 裸背自然战马躯干（无重马衣，完整露出健康栗棕马身受光/暗影块面）
  poly(ctx, [
    [-9.6, -12.6], [-3.0, -13.4], [5.4, -13.0], [8.4, -10.6],
    [7.4, -6.4], [-7.8, -6.2], [-10.0, -9.0],
  ], m.horseMid, m.edge, 0.68);
  poly(ctx, [
    [-9.2, -12.4], [-2.8, -13.2], [5.0, -12.8], [7.2, -10.8],
    [5.8, -8.8], [-8.6, -9.2],
  ], m.horseLit);
  poly(ctx, [[-7.6, -7.4], [6.8, -7.6], [7.2, -6.4], [-7.6, -6.2]], m.horseShade);

  // 简洁阵营方形鞍垫 + 皮马鞍（克制识色，不盖满马身）
  poly(ctx, [[-4.8, -13.4], [3.6, -13.2], [3.4, -8.4], [-4.6, -8.6]], pal.mid, m.edge, 0.55);
  poly(ctx, [[-4.6, -13.2], [-0.4, -13.2], [-0.6, -8.7], [-4.4, -8.8]], pal.lit);
  poly(ctx, [[-3.4, -13.6], [2.4, -13.4], [2.0, -11.4], [-3.2, -11.6]], m.leatherDark, m.edge, 0.5);
  // 肚带
  strokeSeg(ctx, 0.4, -11.2, 0.2, -6.4, m.leatherDark, 0.9);

  // 前侧双腿（奔跑抬蹄 + 稳踏后蹄）
  poly(ctx, [[-6.4, -6.2], [-4.2, -6.2], [-4.6, 0.8], [-6.6, 0.8]], m.horseLit, m.edge, 0.58);
  poly(ctx, [[-6.7, 0.4], [-4.5, 0.4], [-4.4, 1.6], [-6.7, 1.6]], m.hairDark);
  poly(ctx, [[4.6, -6.4], [6.8, -6.6], [9.6, -3.6], [8.0, -2.2], [6.4, 0.6], [4.9, 0.4], [6.2, -3.0]], m.horseLit, m.edge, 0.58);

  // 自然马颈与马头（无钢马面甲，仅系简洁皮缰绳）
  poly(ctx, [[4.0, -12.6], [7.4, -19.0], [11.0, -18.2], [9.4, -11.4]], m.horseLit, m.edge, 0.65);
  poly(ctx, [[4.0, -12.6], [7.2, -18.8], [8.6, -18.4], [6.4, -12.2]], m.hairDark);
  poly(ctx, [[7.4, -19.0], [10.8, -18.6], [13.0, -15.2], [11.4, -14.2], [8.4, -15.8]], m.horseMid, m.edge, 0.62);
  poly(ctx, [[8.2, -18.8], [10.7, -18.5], [12.3, -15.8], [10.4, -16.0]], m.horseLit);
  poly(ctx, [[8.2, -18.8], [8.8, -21.0], [9.8, -18.8]], m.horseLit, m.edge, 0.45);
  // 皮笼头与缰绳
  strokeSeg(ctx, 9.6, -15.2, 12.2, -16.2, m.leatherDark, 0.75);
  strokeSeg(ctx, 10.8, -15.4, 2.2, -15.2, m.leatherDark, 0.7);

  // 骑手（链甲+简洁阵营短罩衣+露脸尖顶铁盔，无披风、无大羽缨、无全覆板甲）
  poly(ctx, [[-1.6, -12.8], [1.4, -12.8], [2.0, -7.2], [-0.4, -7.2]], m.leatherMid, m.edge, 0.55);
  poly(ctx, [[-0.4, -7.6], [2.0, -7.6], [2.2, -5.8], [-0.2, -5.8]], m.leatherDark);
  // 链甲躯干 + 简洁阵营短罩衣
  poly(ctx, [[-2.8, -19.6], [2.4, -19.2], [2.2, -12.6], [-2.6, -12.6]], pal.mid, m.edge, 0.65);
  poly(ctx, [[-2.6, -19.4], [0.4, -19.3], [0.2, -12.8], [-2.4, -12.8]], pal.lit);
  // 肩部与下摆露出的铁链甲边
  poly(ctx, [[-3.0, -19.6], [2.4, -19.2], [2.3, -18.0], [-2.9, -18.3]], m.steelMid, m.edge, 0.45);
  poly(ctx, [[-2.6, -13.4], [2.2, -13.4], [2.4, -12.2], [-2.7, -12.2]], m.steelShade);
  poly(ctx, [[-2.7, -14.2], [2.3, -14.0], [2.3, -13.2], [-2.7, -13.4]], m.leatherDark);

  // 露脸写实骑手头颅 + 简洁冷钢尖顶盔（与长枪兵同科技档，保留全盔给高级铁骑）
  drawFace(ctx, m, 0.3, -21.8);
  poly(ctx, [
    [-2.0, -22.2], [-1.9, -24.1], [0.2, -25.8], [2.2, -24.0], [2.1, -22.2],
  ], m.steelMid, m.edge, 0.62);
  poly(ctx, [[-1.8, -24.0], [0.2, -25.6], [0.4, -22.4], [-1.8, -22.4]], m.steelLit);
  strokeSeg(ctx, 0.7, -22.8, 0.8, -21.0, m.steelLit, 0.75);

  // 简洁铁头直骑矛（无夸张大圆锥护手与大燕尾旗，干练轻快）
  const lx0 = -6.2;
  const ly0 = -14.2;
  const lx1 = 13.0;
  const ly1 = -23.6;
  strokeSeg(ctx, lx0, ly0, lx1, ly1, m.edge, 2.0);
  strokeSeg(ctx, lx0, ly0, lx1, ly1, m.woodLit, 1.15);
  poly(ctx, [[lx1 - 0.5, ly1 - 0.4], [lx1 + 3.6, ly1 - 1.9], [lx1 + 0.5, ly1 + 0.8]], m.steelLit, m.edge, 0.48);

  // 骑手身侧简洁小圆骑盾
  ctx.beginPath();
  ctx.ellipse(1.2, -14.6, 2.6, 3.1, 0.12, 0, Math.PI * 2);
  ctx.fillStyle = pal.mid;
  ctx.fill();
  ctx.strokeStyle = m.steelLit;
  ctx.lineWidth = 0.95;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(1.2, -14.6, 0.95, 0, Math.PI * 2);
  ctx.fillStyle = m.steelLit;
  ctx.fill();

  ctx.restore();
}

/* =========================================================================
   5. 伐木工（lumberjack · 70 金 · 林间经济）：厚皮坎肩 + 宽刃亮钢伐木斧 + 树桩与叠放原木堆
   ========================================================================= */
function drawLumberjackPerson(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era2Mat, swinging: boolean): void {
  drawShadow(ctx, 1.8, 0.6, 4.5, 1.9);
  drawLegs(ctx, m, false, swinging ? 0.95 : 0.78);

  const lean = swinging ? 0.65 : 0.3;
  // 粗布衬衫 + 耐磨深褐皮坎肩 + 阵营腰带与头巾
  poly(ctx, [[-2.6, -9.8], [2.4, -9.8], [2.8, -6.6], [-2.7, -6.8]], m.clothShade, m.edge, 0.58);
  poly(ctx, [[-2.6 + lean, -15.3], [2.4 + lean, -15.1], [2.5, -9.6], [-2.5, -9.6]], m.leatherMid, m.edge, 0.65);
  poly(ctx, [[-2.4 + lean, -15.1], [0.4 + lean, -15.0], [0.2, -9.8], [-2.3, -9.8]], m.leatherLit);
  // 鲜明阵营方巾围领与束腰
  poly(ctx, [[-2.6 + lean, -15.4], [2.3 + lean, -15.2], [1.8 + lean, -13.2], [-2.2 + lean, -13.4]], pal.mid, m.edge, 0.45);
  poly(ctx, [[-2.5 + lean, -15.3], [0.3 + lean, -15.2], [0.1 + lean, -13.4], [-2.1 + lean, -13.5]], pal.lit);
  poly(ctx, [[-2.6, -10.4], [2.5, -10.2], [2.5, -9.2], [-2.6, -9.4]], pal.mid);

  // 头部 + 伐木软帽（带阵营边）
  const hx = lean * 1.1;
  const hy = -17.9;
  drawFace(ctx, m, hx, hy);
  poly(ctx, [
    [hx - 2.3, hy - 0.9], [hx - 2.0, hy - 3.1], [hx + 1.0, hy - 3.2], [hx + 2.2, hy - 1.4], [hx + 1.8, hy - 0.8],
  ], pal.mid, m.edge, 0.58);
  poly(ctx, [[hx - 2.1, hy - 1.1], [hx - 1.8, hy - 2.9], [hx + 0.4, hy - 3.0], [hx + 0.1, hy - 1.1]], pal.lit);

  // 标志性「经典伐木大斧」：偏竖粗木柄（顶端微穿出斧眼）+ 后侧方平斧踵 + 前侧上下对称外展月牙弧形亮钢斧刃
  const ax0 = swinging ? 1.8 : 1.0;
  const ay0 = swinging ? -8.4 : -9.0;
  const ax1 = swinging ? 5.6 : 3.8;
  const ay1 = swinging ? -22.4 : -23.0;
  const adx = ax1 - ax0;
  const ady = ay1 - ay0;
  const alen = Math.hypot(adx, ady) || 1;
  const ux = adx / alen;
  const uy = ady / alen;
  // 指向斧柄右侧前方的垂直法向量
  const nx = -uy;
  const ny = ux;
  const pt = (u: number, n: number): readonly [number, number] => [
    ax1 + ux * u + nx * n,
    ay1 + uy * u + ny * n,
  ];

  // 粗实木斧柄（顶端穿出斧眼 1.3px）
  const [topX, topY] = pt(1.3, 0);
  strokeSeg(ctx, ax0, ay0, topX, topY, m.edge, 2.35);
  strokeSeg(ctx, ax0, ay0, topX, topY, m.woodMid, 1.4);
  strokeSeg(ctx, ax0 + 0.25, ay0, topX - 0.1, topY, m.woodLit, 0.5);

  // 扇形外展宽刃伐木斧头：窄方斧踵（左侧 -n）→ 沿 +n 上下对称张开的宽月牙弯刃（右侧 +n）
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(...pt(1.2, -1.5)); // 斧踵上角
  ctx.lineTo(...pt(1.1, 1.1)); // 斧眼上沿
  ctx.quadraticCurveTo(...pt(2.4, 3.0), ...pt(3.6, 5.2)); // 上刃耳向上大幅外展
  ctx.quadraticCurveTo(...pt(0.0, 6.7), ...pt(-3.9, 5.1)); // 饱满凸弧月牙主刃口
  ctx.quadraticCurveTo(...pt(-2.5, 2.8), ...pt(-1.5, 1.1)); // 下刃耳向内收束成斧颈
  ctx.lineTo(...pt(-1.5, -1.5)); // 斧踵下角
  ctx.closePath();
  ctx.fillStyle = m.steelMid;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.65;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 斧踵暗铁阴面（强化厚重铁块感）
  poly(ctx, [pt(1.1, -1.4), pt(1.0, 0.4), pt(-1.4, 0.4), pt(-1.4, -1.4)], m.ironDark);

  // 弧形外缘银亮开锋刃带（1× 与 2× 一眼就能看出是锋利大斧头！）
  ctx.beginPath();
  ctx.moveTo(...pt(3.3, 4.9));
  ctx.quadraticCurveTo(...pt(0.0, 6.4), ...pt(-3.6, 4.8));
  ctx.strokeStyle = m.steelLit;
  ctx.lineWidth = 1.45;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  // 双手稳握木斧柄
  const gripX = ax0 + adx * 0.42;
  const gripY = ay0 + ady * 0.42;
  poly(ctx, [[1.0 + lean, -14.0], [2.4 + lean, -13.5], [gripX + 0.7, gripY + 0.6], [gripX - 0.8, gripY - 0.5]], m.clothLit, m.edge, 0.48);
}

function paintLumberjack(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后排持斧伐木工
  ctx.save();
  ctx.translate(-3.6, -2.5);
  ctx.scale(0.94, 0.94);
  drawLumberjackPerson(ctx, pal, m, false);
  ctx.restore();

  // 脚边一叠刚锯好的三根圆木堆（带亮色横切年轮，强森林采集辨识度！）
  const drawLogEnd = (lx: number, ly: number) => {
    poly(ctx, [[lx - 4.4, ly - 1.6], [lx, ly], [lx, ly + 2.4], [lx - 4.4, ly + 0.8]], m.woodMid, m.edge, 0.5);
    ctx.beginPath();
    ctx.ellipse(lx, ly + 1.2, 1.3, 1.35, 0, 0, Math.PI * 2);
    ctx.fillStyle = m.clothLit;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.55;
    ctx.stroke();
  };
  drawLogEnd(-2.4, 0.4);
  drawLogEnd(-0.2, 1.2);
  drawLogEnd(-1.4, -1.4);

  // 前排挥斧伐木工
  ctx.save();
  ctx.translate(3.4, 1.5);
  ctx.scale(1.0, 1.0);
  drawLumberjackPerson(ctx, pal, m, true);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   6. 民夫（miller · 85 金 · 建造者 buildPower 12）：穿工装围裙石匠 + 满载黄砂岩的独轮木推车
   ========================================================================= */
function paintMiller(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后排穿工装持铁镐的石匠民夫（区别于时代 1 赤膊奴隶）
  ctx.save();
  ctx.translate(-4.4, -2.6);
  ctx.scale(0.95, 0.95);
  drawShadow(ctx, 1.6, 0.6, 4.4, 1.8);
  drawLegs(ctx, m, false, 0.82);
  poly(ctx, [[-2.6, -15.2], [2.4, -15.0], [2.7, -6.5], [-2.7, -6.7]], m.clothMid, m.edge, 0.62);
  poly(ctx, [[-2.4, -15.0], [0.3, -14.9], [0.1, -6.7], [-2.5, -6.8]], m.clothLit);
  // 皮革工匠围裙 + 阵营肩巾
  poly(ctx, [[-1.6, -13.2], [2.0, -13.0], [2.2, -6.6], [-1.8, -6.8]], m.leatherMid, m.edge, 0.5);
  poly(ctx, [[-2.6, -15.3], [2.3, -15.1], [2.1, -13.4], [-2.5, -13.6]], pal.mid);
  drawFace(ctx, m, 0.2, -17.8);
  poly(ctx, [[-2.0, -18.8], [-1.6, -20.8], [1.6, -20.8], [2.0, -18.8]], m.hairDark, m.edge, 0.52);
  poly(ctx, [[-2.1, -19.2], [2.1, -19.2], [2.1, -18.3], [-2.1, -18.3]], pal.lit);
  // 肩扛铁镐
  strokeSeg(ctx, -3.6, -11.4, 5.2, -20.8, m.edge, 1.9);
  strokeSeg(ctx, -3.6, -11.4, 5.2, -20.8, m.woodMid, 1.1);
  ctx.beginPath();
  ctx.moveTo(1.8, -22.2);
  ctx.quadraticCurveTo(5.6, -21.2, 8.2, -18.4);
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.strokeStyle = m.steelLit;
  ctx.lineWidth = 1.35;
  ctx.stroke();
  ctx.restore();

  // 前排推独轮石料车的民夫
  ctx.save();
  ctx.translate(-1.0, 1.4);
  drawShadow(ctx, 1.6, 0.6, 4.2, 1.8);
  drawLegs(ctx, m, false, 0.95);
  poly(ctx, [[-2.0, -14.8], [2.8, -14.2], [2.5, -6.6], [-2.5, -6.8]], m.clothMid, m.edge, 0.62);
  poly(ctx, [[-1.8, -14.6], [0.6, -14.4], [0.3, -6.8], [-2.3, -6.9]], m.clothLit);
  poly(ctx, [[-2.2, -10.6], [2.6, -10.2], [2.6, -9.0], [-2.3, -9.4]], pal.mid);
  poly(ctx, [[-2.0, -15.0], [2.6, -14.4], [2.2, -13.0], [-2.0, -13.4]], pal.lit);
  drawFace(ctx, m, 1.0, -17.4);
  poly(ctx, [[-1.2, -18.4], [-0.8, -20.4], [2.4, -20.4], [2.8, -18.4]], pal.mid, m.edge, 0.55);
  // 前伸推车双臂
  poly(ctx, [[1.6, -13.2], [2.8, -12.6], [5.4, -9.6], [4.2, -8.8]], m.skinLit, m.edge, 0.48);
  ctx.restore();

  // 标志性「满载黄砂岩砌块的独轮木推车」（一眼区分时代 2 民夫与时代 1 奴隶！）
  drawShadow(ctx, 7.0, 1.8, 5.4, 2.0);
  // 木车轮
  ctx.beginPath();
  ctx.arc(9.8, -0.6, 2.8, 0, Math.PI * 2);
  ctx.fillStyle = m.woodDark;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(9.8, -0.6, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = m.woodLit;
  ctx.fill();
  // 车把与车斗
  strokeSeg(ctx, 2.0, -7.8, 10.2, -1.8, m.edge, 2.0);
  strokeSeg(ctx, 2.0, -7.8, 10.2, -1.8, m.woodLit, 1.15);
  poly(ctx, [[3.2, -6.8], [9.8, -5.8], [9.2, -1.8], [4.0, -2.6]], m.woodMid, m.edge, 0.62);
  // 车斗里堆叠的切方黄砂岩石块（呼应 E2 石堡与城墙！）
  poly(ctx, [[3.4, -8.4], [6.6, -9.2], [8.8, -8.0], [5.6, -7.2]], m.sandTop, m.edge, 0.52);
  poly(ctx, [[3.4, -8.4], [5.6, -7.2], [5.6, -5.4], [3.4, -6.6]], m.sandLit, m.edge, 0.52);
  poly(ctx, [[5.6, -7.2], [8.8, -8.0], [8.8, -6.2], [5.6, -5.4]], m.sandShade, m.edge, 0.52);
  // 车斗侧挂小阵营布条
  poly(ctx, [[5.2, -5.4], [7.6, -5.0], [7.4, -2.4], [5.2, -2.8]], pal.mid);

  ctx.restore();
}

/* =========================================================================
   7. 楼船（tower_ship · 130 金 · 血 85 · 射程 2）：重型多桨木战舰 + 双层赤陶飞檐木战楼 + 大帅旗
   ========================================================================= */
function drawWaterWake(ctx: CanvasRenderingContext2D, rx: number, ry: number, pal: TeamClothPalette, selected: boolean, target: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 2.2, rx + 2.6, ry + 1.3, 0, 0, Math.PI * 2);
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : 'rgba(242, 250, 255, 0.62)';
  ctx.lineWidth = selected || target ? 1.85 : 1.05;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(0, 1.8, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.48)' : target ? 'rgba(248, 224, 214, 0.48)' : 'rgba(18, 38, 52, 0.38)';
  ctx.fill();
  ctx.strokeStyle = pal.ring;
  ctx.lineWidth = 0.95;
  ctx.stroke();
  ctx.restore();
}

function paintTowerShip(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterWake(ctx, 14.0, 5.4, pal, opts.selected, opts.target);

  ctx.save();
  ctx.scale(opts.facing, 1);

  // 厚重高干舷双头楼船大船壳
  poly(ctx, [
    [-14.6, -5.4], [-9.6, -7.2], [9.4, -7.0], [15.4, -5.6],
    [12.2, 1.4], [6.4, 3.0], [-7.2, 3.0], [-12.0, 1.2],
  ], m.woodMid, m.edge, 0.75);
  poly(ctx, [
    [-14.0, -5.2], [-9.4, -6.8], [9.2, -6.6], [14.8, -5.4],
    [13.2, -2.0], [6.8, -0.6], [-7.6, -0.6], [-12.8, -2.2],
  ], m.woodLit);
  // 船腹阵营战漆条 + 吃水暗部
  poly(ctx, [[-12.6, -2.8], [-7.4, -1.4], [6.8, -1.4], [13.2, -2.6], [12.6, -1.0], [6.6, 0.2], [-7.4, 0.2], [-12.2, -1.2]], pal.mid);
  poly(ctx, [[-11.8, 0.8], [-7.2, 2.6], [6.4, 2.6], [11.8, 1.0], [11.0, 2.2], [6.2, 3.3], [-7.2, 3.3], [-11.2, 1.8]], m.woodDark);

  // 一排四支斜入水面的重型战桨
  for (const ox of [-7.4, -3.2, 1.0, 5.2]) {
    strokeSeg(ctx, ox, -0.6, ox - 2.6, 3.8, m.edge, 1.6);
    strokeSeg(ctx, ox, -0.6, ox - 2.6, 3.8, m.woodLit, 0.85);
  }

  // 第一层宽阔木战楼（带射箭箭孔与阵营垂幡）
  poly(ctx, [[-8.6, -6.4], [-8.6, -13.6], [8.2, -13.6], [8.2, -6.4]], m.woodMid, m.edge, 0.68);
  poly(ctx, [[-8.4, -6.6], [-8.4, -13.4], [1.0, -13.4], [1.0, -6.6]], m.woodLit);
  poly(ctx, [[1.0, -6.6], [1.0, -13.4], [8.0, -13.4], [8.0, -6.6]], m.woodDark);
  for (const ax of [-6.0, -2.6, 1.2, 4.8]) {
    poly(ctx, [[ax - 0.6, -11.4], [ax + 0.6, -11.4], [ax + 0.6, -9.2], [ax - 0.6, -9.2]], m.ironDark);
  }
  // 一层暖赤陶瓦飞檐
  poly(ctx, [[-10.4, -12.6], [-8.2, -15.4], [8.4, -15.4], [10.4, -12.6]], m.tileMid, m.edge, 0.65);
  poly(ctx, [[-10.0, -12.8], [-8.0, -15.2], [0.8, -15.2], [0.4, -12.8]], m.tileLit);

  // 第二层高耸望楼 + 阵营护墙布
  poly(ctx, [[-5.6, -15.2], [-5.6, -21.2], [5.4, -21.2], [5.4, -15.2]], m.woodMid, m.edge, 0.65);
  poly(ctx, [[-5.4, -15.4], [-5.4, -21.0], [0.6, -21.0], [0.6, -15.4]], m.woodLit);
  poly(ctx, [[-5.4, -18.2], [5.2, -18.2], [5.2, -15.6], [-5.4, -15.6]], pal.mid);
  poly(ctx, [[-5.2, -18.0], [0.4, -18.0], [0.4, -15.8], [-5.2, -15.8]], pal.lit);
  // 二层重檐赤陶瓦屋顶
  poly(ctx, [[-7.6, -20.6], [-4.4, -24.2], [4.6, -24.2], [7.6, -20.6]], m.tileMid, m.edge, 0.68);
  poly(ctx, [[-7.2, -20.8], [-4.2, -24.0], [0.4, -24.0], [0.2, -20.8]], m.tileLit);
  poly(ctx, [[0.4, -24.0], [4.4, -24.0], [7.2, -20.8], [0.2, -20.8]], m.tileShade);

  // 中军高耸帅旗（远景极有大舰气势）
  strokeSeg(ctx, -0.4, -24.0, -0.4, -32.2, m.edge, 1.6);
  strokeSeg(ctx, -0.4, -24.0, -0.4, -32.2, m.woodLit, 0.9);
  poly(ctx, [[-0.2, -32.0], [-9.2, -30.2], [-7.8, -28.0], [-9.4, -25.8], [-0.2, -26.8]], pal.mid, m.edge, 0.52);
  poly(ctx, [[-0.2, -31.8], [-6.0, -30.6], [-5.4, -27.4], [-0.2, -27.8]], pal.lit);

  // 前舷浪花高光
  strokeSeg(ctx, -10.8, 3.0, 10.6, 3.0, 'rgba(246, 252, 255, 0.78)', 0.95);
  ctx.restore();
}

/* =========================================================================
   8. 石堡（keep · 100 金 · 甲 7 · 射程 3 · 自动攻击）：
   E2 同源黄砂岩厚重方石堡 + 城垛口 + 铁门 + 暖赤陶瓦角亭 + 战旗（锁定西北受光）
   ========================================================================= */
function paintKeep(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-8.6, 0.8], [7.2, -2.6], [15.8, 1.8], [2.4, 5.8]], 'rgba(26, 21, 15, 0.36)');

  // 厚重外斜黄砂岩石座
  poly(ctx, [[-10.4, 0.4], [0.0, -4.4], [10.4, 0.4], [0.0, 5.2]], m.sandShade, m.edge, 0.68);
  poly(ctx, [[-9.8, 0.2], [0.0, -4.0], [0.0, 4.8]], m.sandLit);

  // 主体方形石堡高墙（左 NW 亮砂岩，右 SE 暗砂岩）
  poly(ctx, [[-8.8, -0.2], [-8.4, -18.2], [0.0, -14.4], [0.0, 3.8]], m.sandLit, m.edge, 0.72);
  poly(ctx, [[0.0, 3.8], [0.0, -14.4], [8.4, -18.2], [8.8, -0.2]], m.sandShade, m.edge, 0.72);
  // 堡顶石坪
  poly(ctx, [[-8.4, -18.2], [0.0, -22.0], [8.4, -18.2], [0.0, -14.4]], m.sandTop, m.edge, 0.65);

  // 石砌横缝与细长暗箭孔
  strokeSeg(ctx, -8.6, -6.2, 0.0, -2.4, m.sandShade, 0.55);
  strokeSeg(ctx, -8.5, -12.0, 0.0, -8.2, m.sandShade, 0.55);
  strokeSeg(ctx, 0.0, -2.4, 8.6, -6.2, 'rgba(54, 43, 28, 0.45)', 0.55);
  strokeSeg(ctx, 0.0, -8.2, 8.5, -12.0, 'rgba(54, 43, 28, 0.45)', 0.55);
  // 箭孔
  poly(ctx, [[-5.6, -12.6], [-4.4, -12.0], [-4.4, -8.8], [-5.6, -9.4]], m.ironDark);
  poly(ctx, [[4.4, -12.0], [5.6, -12.6], [5.6, -9.4], [4.4, -8.8]], m.ironDark);
  // 拱形包铁木门（左下墙面）
  poly(ctx, [[-6.2, 1.0], [-6.2, -4.2], [-4.2, -4.6], [-2.4, -2.6], [-2.4, 2.6]], m.woodDark, m.edge, 0.6);
  strokeSeg(ctx, -5.8, -2.2, -2.6, -0.8, m.ironDark, 0.7);
  strokeSeg(ctx, -5.8, -0.4, -2.6, 1.0, m.ironDark, 0.7);

  // 墙面悬挂阵营长战旗
  poly(ctx, [[1.6, -12.8], [3.8, -13.8], [3.8, -6.2], [2.7, -7.2], [1.6, -5.2]], pal.shade, m.edge, 0.48);
  poly(ctx, [[-3.4, -14.8], [-1.2, -13.8], [-1.2, -6.2], [-2.3, -7.8], [-3.4, -7.2]], pal.lit, m.edge, 0.48);

  // 堡顶一圈立体石垛口（Crenellations，一眼定义石堡！）
  const merlon = (x0: number, y0: number, x1: number, y1: number, col: string) => {
    poly(ctx, [[x0, y0], [x1, y1], [x1, y1 - 2.6], [x0, y0 - 2.6]], col, m.edge, 0.52);
  };
  merlon(-8.4, -18.2, -5.6, -16.9, m.sandLit);
  merlon(-4.0, -16.2, -1.2, -14.9, m.sandLit);
  merlon(1.2, -14.9, 4.0, -16.2, m.sandShade);
  merlon(5.6, -16.9, 8.4, -18.2, m.sandShade);

  // 堡顶偏后方暖赤陶瓦小望楼（呼应 E2 城池主殿色相）
  poly(ctx, [[-3.8, -19.2], [-3.8, -24.2], [0.0, -22.6], [0.0, -17.6]], m.sandLit, m.edge, 0.58);
  poly(ctx, [[0.0, -17.6], [0.0, -22.6], [3.8, -24.2], [3.8, -19.2]], m.sandShade, m.edge, 0.58);
  poly(ctx, [[0.0, -28.6], [-5.2, -24.0], [0.0, -22.0]], m.tileLit, m.edge, 0.62);
  poly(ctx, [[0.0, -28.6], [0.0, -22.0], [5.2, -24.0]], m.tileShade, m.edge, 0.62);

  // 堡顶高旗
  strokeSeg(ctx, 0.0, -28.4, 0.0, -34.2, m.edge, 1.4);
  strokeSeg(ctx, 0.0, -28.4, 0.0, -34.2, m.steelLit, 0.8);
  poly(ctx, [[0.2, -34.0], [6.6, -32.4], [0.2, -30.6]], pal.mid, m.edge, 0.48);
  poly(ctx, [[0.2, -33.8], [4.2, -32.8], [0.2, -32.0]], pal.lit);
}

/* =========================================================================
   9. 水车（watermill · 110 金 · 经济）：黄砂岩工坊 + 暖赤陶双坡瓦顶 + 清澈蓝水渠 + 巨型木叶水轮
   ========================================================================= */
function paintWatermill(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-10.4, 1.0], [5.2, -3.4], [14.8, 1.4], [1.8, 5.8]], 'rgba(26, 21, 15, 0.34)');

  // 右前侧清澈石砌引水渠（一抹蓝水+白浪，瞬间与时代 1 陆地磨坊拉开巨大视觉差异！）
  poly(ctx, [[-1.6, 2.4], [9.8, -3.0], [13.2, -1.2], [1.8, 4.2]], m.sandShade, m.edge, 0.62);
  poly(ctx, [[-0.6, 2.2], [9.8, -2.6], [12.0, -1.4], [1.6, 3.4]], m.waterMid);
  poly(ctx, [[0.4, 1.9], [9.6, -2.3], [11.0, -1.6], [1.8, 2.6]], m.waterLit);
  strokeSeg(ctx, 2.6, 1.8, 7.6, -0.6, 'rgba(248, 253, 255, 0.85)', 0.95);

  // 黄砂岩石砌长方水车工坊主体（左 NW 受光、右 SE 阴影）
  poly(ctx, [[-10.2, -0.4], [-10.2, -11.4], [-1.2, -7.2], [-1.2, 3.4]], m.sandLit, m.edge, 0.7);
  poly(ctx, [[-1.2, 3.4], [-1.2, -7.2], [6.6, -11.2], [6.6, -0.6]], m.sandShade, m.edge, 0.7);
  // 门窗与木架
  poly(ctx, [[-7.2, 0.8], [-7.2, -4.4], [-4.0, -3.0], [-4.0, 2.2]], m.woodDark, m.edge, 0.55);
  strokeSeg(ctx, -10.2, -6.2, -1.2, -2.0, m.woodMid, 1.0);
  // 门楣阵营饰带
  poly(ctx, [[-7.4, -5.2], [-3.8, -3.6], [-3.8, -2.5], [-7.4, -4.1]], pal.mid);

  // 暖赤陶瓦双坡硬山屋顶（与 E2 铁器城池完全同源！）
  poly(ctx, [[-11.8, -11.2], [-4.6, -20.8], [4.2, -16.8], [-1.6, -6.4]], m.tileLit, m.edge, 0.72);
  poly(ctx, [[-4.6, -20.8], [3.6, -24.2], [11.4, -19.8], [4.2, -16.8]], m.tileMid, m.edge, 0.65);
  poly(ctx, [[-1.6, -6.4], [4.2, -16.8], [8.2, -11.4]], m.tileShade, m.edge, 0.68);
  // 瓦垄细线
  strokeSeg(ctx, -8.8, -10.0, -2.4, -19.4, m.tileShade, 0.5);
  strokeSeg(ctx, -5.4, -8.4, 0.8, -18.0, m.tileShade, 0.5);

  // 屋脊小阵营风向旗
  strokeSeg(ctx, -4.4, -20.8, -4.4, -26.4, m.woodDark, 1.1);
  poly(ctx, [[-4.2, -26.2], [1.4, -24.8], [-4.2, -23.2]], pal.mid, m.edge, 0.45);
  poly(ctx, [[-4.2, -26.0], [-0.8, -25.1], [-4.2, -24.4]], pal.lit);

  // 标志性「巨型木叶水车轮」（高大醒目，浸在蓝水渠中激起白浪！）
  ctx.save();
  ctx.translate(5.8, -4.6);
  ctx.beginPath();
  ctx.ellipse(0, 0, 5.2, 7.6, 0.14, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34, 25, 15, 0.24)';
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.8;
  ctx.stroke();
  ctx.strokeStyle = m.woodLit;
  ctx.lineWidth = 1.65;
  ctx.stroke();
  // 八片外探水叶板与木辐条
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const ix = Math.cos(a) * 4.6;
    const iy = Math.sin(a) * 6.8;
    const ox = Math.cos(a) * 6.2;
    const oy = Math.sin(a) * 8.6;
    strokeSeg(ctx, 0, 0, ix, iy, m.woodMid, 1.0);
    strokeSeg(ctx, ix, iy, ox, oy, m.woodDark, 1.65);
  }
  // 轴心铁毂
  ctx.beginPath();
  ctx.arc(0, 0, 1.7, 0, Math.PI * 2);
  ctx.fillStyle = m.steelLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.55;
  ctx.stroke();
  // 轮底溅起的白色水花
  strokeSeg(ctx, -2.6, 7.0, 2.8, 6.2, 'rgba(250, 254, 255, 0.9)', 1.35);
  ctx.restore();
}

/* =========================================================================
   10. 寨垒（camp2 · 130 金 · 血 42 · 甲 5 · 产兵/自动攻击）：
   黄砂岩石基木栅寨墙 + 暖赤陶瓦门楼 + 营内瓦顶兵舍 + 高耸铁顶帅旗
   ========================================================================= */
function paintCamp2(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.6, 1.0], [2.4, -6.2], [14.8, 0.6], [0.8, 6.8]], 'rgba(26, 21, 15, 0.34)');

  // 规整石砌夯土寨基
  poly(ctx, [[-12.8, -0.4], [0.0, -6.6], [12.8, -0.4], [0.0, 5.6]], m.sandShade, m.edge, 0.7);
  poly(ctx, [[-12.0, -0.4], [0.0, -6.2], [12.0, -0.4], [0.0, 5.0]], m.sandTop);

  // 后侧双段黄砂岩低围墙 + 顶上尖木女墙（明确体现「寨垒」石木复合防御感）
  poly(ctx, [[-12.4, -0.4], [-12.4, -5.2], [0.0, -11.0], [0.0, -6.2]], m.sandLit, m.edge, 0.65);
  poly(ctx, [[0.0, -6.2], [0.0, -11.0], [12.4, -5.2], [12.4, -0.4]], m.sandShade, m.edge, 0.65);
  // 石墙顶缘木栅齿
  for (let i = 0; i < 5; i++) {
    const t = (i + 0.5) / 5;
    const lx = -12.0 + t * 11.4;
    const ly = -5.2 - t * 5.4;
    poly(ctx, [[lx - 0.9, ly], [lx, ly - 3.0], [lx + 0.9, ly]], m.woodLit, m.edge, 0.45);
    const rx = 0.6 + t * 11.4;
    const ry = -10.6 + t * 5.4;
    poly(ctx, [[rx - 0.9, ry], [rx, ry - 3.0], [rx + 0.9, ry]], m.woodDark, m.edge, 0.45);
  }

  // 营心规整暖赤陶瓦顶兵舍主屋（取代时代 1 帐篷，直观体现时代 2 军事进阶！）
  poly(ctx, [[-6.8, -0.8], [-6.8, -8.0], [0.0, -4.8], [0.0, 2.2]], m.sandLit, m.edge, 0.65);
  poly(ctx, [[0.0, 2.2], [0.0, -4.8], [6.8, -8.0], [6.8, -0.8]], m.sandShade, m.edge, 0.65);
  poly(ctx, [[-8.2, -7.8], [0.0, -15.6], [8.2, -7.8], [0.0, -4.0]], m.tileMid, m.edge, 0.68);
  poly(ctx, [[-7.8, -7.8], [0.0, -15.2], [0.0, -4.3]], m.tileLit);
  poly(ctx, [[0.0, -15.2], [7.8, -7.8], [0.0, -4.3]], m.tileShade);
  // 兵舍门楣阵营长幡
  poly(ctx, [[-4.4, -5.4], [-2.0, -4.3], [-2.0, 0.6], [-4.4, -0.5]], pal.mid, m.edge, 0.45);

  // 寨前两座小方石门墩 + 暖陶小顶（前侧开口迎敌）
  const drawGatePillar = (gx: number, gy: number, lit: boolean) => {
    poly(ctx, [[gx - 2.4, gy], [gx - 2.4, gy - 6.6], [gx, gy - 5.4], [gx, gy + 1.2]], lit ? m.sandLit : m.sandMid, m.edge, 0.58);
    poly(ctx, [[gx, gy + 1.2], [gx, gy - 5.4], [gx + 2.4, gy - 6.6], [gx + 2.4, gy]], m.sandShade, m.edge, 0.58);
    poly(ctx, [[gx - 3.0, gy - 6.4], [gx, gy - 9.2], [gx + 3.0, gy - 6.4], [gx, gy - 5.0]], lit ? m.tileLit : m.tileMid, m.edge, 0.55);
  };
  drawGatePillar(-8.2, 2.6, true);
  drawGatePillar(8.2, 2.4, false);

  // 高耸铁枪头军旗（寨垒最高视觉焦点）
  strokeSeg(ctx, -8.2, -8.8, -8.2, -24.4, m.edge, 1.8);
  strokeSeg(ctx, -8.2, -8.8, -8.2, -24.4, m.steelLit, 0.95);
  poly(ctx, [[-8.0, -24.2], [2.4, -22.6], [0.8, -20.0], [2.6, -17.4], [-8.0, -18.4]], pal.mid, m.edge, 0.55);
  poly(ctx, [[-8.0, -24.0], [-1.6, -23.0], [-2.2, -18.8], [-8.0, -19.2]], pal.lit);
  poly(ctx, [[-8.8, -24.4], [-8.2, -26.8], [-7.6, -24.4]], m.steelLit, m.edge, 0.45);
}

export const ERA2_UNIT_SPECS: Readonly<Record<string, Era1UnitSpec>> = {
  spearman: { paint: paintSpearman, hitTop: 29 },
  crossbow: { paint: paintCrossbow, hitTop: 26 },
  longbow: { paint: paintLongbow, hitTop: 29 },
  knight: { paint: paintKnight, ringRx: 12.2, ringRy: 5.2, barY: 5.2, hitTop: 29 },
  lumberjack: { paint: paintLumberjack, hitTop: 27 },
  miller: { paint: paintMiller, ringRx: 11.4, ringRy: 4.9, hitTop: 26 },
  tower_ship: { paint: paintTowerShip, waterUnit: true, barY: 6.4, hitTop: 34 },
  keep: { paint: paintKeep, ringRx: 12.0, ringRy: 5.3, barY: 6.0, hitTop: 35 },
  watermill: { paint: paintWatermill, ringRx: 12.4, ringRy: 5.5, barY: 6.0, hitTop: 28 },
  camp2: { paint: paintCamp2, ringRx: 13.0, ringRy: 5.8, barY: 6.4, hitTop: 28 },
};

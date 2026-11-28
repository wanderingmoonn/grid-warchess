/**
 * 时代 5（机械化时代 / 二战至 20 世纪中叶）原版全 9 个兵种与建筑的斜俯视 3D 微缩沙盘绘制模块。
 *
 * 与前序时代保持统一 4.8 头身写实微缩战棋风格与西北受光体系，同时全面呼应 E5 机械化城池材质语言：
 * - 军绿装甲钢（#818e78 / #606d59 / #424d3d）、粗粝暖灰混凝土（#c5beb0 / #979080 / #777164）、
 *   深灰柏油与重枪钢（#2c3034 / #4c5258 / #7b848c）、卡其沙袋与工程黄；
 * - 涵盖步兵班、重机枪组、坦克、火炮、推土机建筑队、钢筋混凝土碉堡、波纹钢工业园、前进基地与立体钢铁桁架钢桥。
 */

import type { AngledUnitPaintOpts, TeamClothPalette } from './angled-units.ts';
import type { Era1UnitSpec } from './angled-units-era1.ts';

interface Era5Mat {
  edge: string;
  oliveLit: string;
  oliveMid: string;
  oliveShade: string;
  concTop: string;
  concLit: string;
  concMid: string;
  concShade: string;
  steelLit: string;
  steelMid: string;
  steelShade: string;
  gunDark: string;
  gunMid: string;
  khakiLit: string;
  khakiMid: string;
  khakiShade: string;
  dozerLit: string;
  dozerMid: string;
  dozerShade: string;
  brassLit: string;
  skinLit: string;
  skinShade: string;
  woodMid: string;
  woodDark: string;
}

function getMat(dim: boolean): Era5Mat {
  return {
    edge: dim ? 'rgba(36, 36, 34, 0.64)' : 'rgba(28, 30, 28, 0.76)',
    oliveLit: dim ? '#8c9088' : '#839179',
    oliveMid: dim ? '#6f736c' : '#616f59',
    oliveShade: dim ? '#4f534d' : '#414d3b',
    concTop: dim ? '#b5b2aa' : '#c6bfb0',
    concLit: dim ? '#a09d96' : '#ada696',
    concMid: dim ? '#888680' : '#938c7d',
    concShade: dim ? '#6c6a65' : '#736d60',
    steelLit: dim ? '#bcc1c5' : '#d5dde3',
    steelMid: dim ? '#90969c' : '#9aa5ae',
    steelShade: dim ? '#666b70' : '#636e78',
    gunDark: dim ? '#3a3d40' : '#2a2e33',
    gunMid: dim ? '#565a5e' : '#4a5159',
    khakiLit: dim ? '#bdb9ae' : '#d6c89d',
    khakiMid: dim ? '#9e9a90' : '#b5a67b',
    khakiShade: dim ? '#7a776f' : '#867956',
    dozerLit: dim ? '#bfb89e' : '#e0ba56',
    dozerMid: dim ? '#9d9781' : '#be9636',
    dozerShade: dim ? '#757161' : '#86671e',
    brassLit: dim ? '#c7c0ac' : '#e8cb72',
    skinLit: dim ? '#c9bfb2' : '#e6be96',
    skinShade: dim ? '#a3998d' : '#bc8f66',
    woodMid: dim ? '#787166' : '#7d5b37',
    woodDark: dim ? '#524d46' : '#4e3720',
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
  ctx.fillStyle = 'rgba(22, 23, 20, 0.36)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0.14, 0, Math.PI * 2);
  ctx.fill();
}

function drawSoldierLegs(ctx: CanvasRenderingContext2D, m: Era5Mat, stride = 0.88, kneel = false): void {
  if (kneel) {
    poly(ctx, [[-2.1, -5.6], [-0.4, -5.6], [-2.0, -1.8], [-3.7, -2.0]], m.oliveShade, m.edge, 0.5);
    poly(ctx, [[-3.7, -2.0], [-2.0, -1.8], [-1.3, 0.4], [-3.1, 0.3]], m.gunDark);
    poly(ctx, [[0.1, -5.4], [2.1, -5.2], [2.9, -1.8], [1.1, -2.0]], m.oliveMid, m.edge, 0.5);
    poly(ctx, [[1.1, -2.0], [2.9, -1.8], [3.4, 0.7], [1.3, 0.7]], m.gunDark);
    return;
  }
  poly(ctx, [[-1.9, -7.6], [-0.4, -7.6], [-1.2 * stride - 1.0, -2.4], [-2.5 * stride - 0.8, -2.6]], m.oliveShade, m.edge, 0.5);
  poly(ctx, [[-2.5 * stride - 0.8, -2.7], [-1.2 * stride - 1.0, -2.5], [-1.4 * stride - 1.0, 0.3], [-2.8 * stride - 0.9, 0.2]], m.gunDark);
  poly(ctx, [[0.0, -7.4], [1.8, -7.4], [2.0 * stride + 0.5, -2.2], [0.5 * stride + 0.4, -2.4]], m.oliveMid, m.edge, 0.5);
  poly(ctx, [[0.5 * stride + 0.4, -2.4], [2.0 * stride + 0.5, -2.2], [2.4 * stride + 0.5, 0.7], [0.6 * stride + 0.4, 0.7]], m.gunDark);
}

/** 通用二战钢盔士兵头部（M1/圆锅钢盔 + 阵营盔带） */
function drawWw2Head(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era5Mat, hx: number, hy: number): void {
  poly(ctx, [[hx - 0.7, hy + 1.9], [hx + 0.8, hy + 1.9], [hx + 0.8, hy + 2.9], [hx - 0.7, hy + 2.9]], m.skinShade);
  poly(ctx, [
    [hx - 1.5, hy - 1.2], [hx + 1.4, hy - 1.2], [hx + 1.6, hy + 0.5],
    [hx + 0.8, hy + 2.0], [hx - 1.0, hy + 2.0], [hx - 1.6, hy + 0.5],
  ], m.skinLit, m.edge, 0.55);
  poly(ctx, [[hx + 0.2, hy - 1.0], [hx + 1.3, hy - 1.0], [hx + 1.4, hy + 0.5], [hx + 0.7, hy + 1.8], [hx + 0.1, hy + 1.8]], m.skinShade);
  // 标志性二战深军绿/深灰圆锅钢盔（沿低护后脑 + 一道阵营识别带）
  poly(ctx, [
    [hx - 2.6, hy - 0.5], [hx - 2.3, hy - 2.6], [hx - 0.4, hy - 3.6],
    [hx + 1.6, hy - 3.0], [hx + 2.5, hy - 1.2], [hx + 2.2, hy - 0.4], [hx - 1.4, hy - 0.3],
  ], m.oliveMid, m.edge, 0.62);
  poly(ctx, [[hx - 2.2, hy - 2.4], [hx - 0.4, hy - 3.4], [hx + 0.6, hy - 3.1], [hx + 0.2, hy - 0.8], [hx - 2.1, hy - 0.7]], m.oliveLit);
  // 盔箍阵营色带
  poly(ctx, [[hx - 2.3, hy - 1.3], [hx + 2.2, hy - 1.3], [hx + 2.3, hy - 0.6], [hx - 2.4, hy - 0.6]], pal.mid);
}

function drawWaterWake(ctx: CanvasRenderingContext2D, rx: number, ry: number, pal: TeamClothPalette, selected: boolean, target: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 2.0, rx + 2.5, ry + 1.2, 0, 0, Math.PI * 2);
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : 'rgba(242, 250, 255, 0.62)';
  ctx.lineWidth = selected || target ? 1.85 : 1.05;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(0, 1.7, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.48)' : target ? 'rgba(248, 224, 214, 0.48)' : 'rgba(18, 38, 52, 0.36)';
  ctx.fill();
  ctx.strokeStyle = pal.ring;
  ctx.lineWidth = 0.95;
  ctx.stroke();
  ctx.restore();
}

/* =========================================================================
   1. 步兵班（squad · 300 金 · 攻 47 · 射程 4）：
   三人战术火力小组（M1 圆钢盔 + 军绿/卡其野战服与阵营肩章背囊 + 冲锋枪/半自动步枪交替推进）
   ========================================================================= */
function drawSquadSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era5Mat, pose: 0 | 1 | 2): void {
  drawShadow(ctx, 1.6, 0.6, 4.2, 1.8);
  const kneel = pose === 0;
  drawSoldierLegs(ctx, m, pose === 2 ? 0.95 : 0.78, kneel);

  const yDrop = kneel ? 1.8 : 0;
  const lean = kneel ? 1.0 : pose === 2 ? 0.6 : 0.35;
  ctx.save();
  ctx.translate(0, yDrop);

  // 背后军用帆布战术背囊
  poly(ctx, [[-4.4 + lean, -14.4], [-2.2 + lean, -14.6], [-2.0, -10.2], [-4.2, -10.2]], m.khakiMid, m.edge, 0.5);
  // 野战军服上衣 + 阵营肩章与领巾 + 武装腰带
  poly(ctx, [[-2.6, -9.8], [2.4, -9.8], [2.8, -6.6], [-2.7, -6.8]], m.oliveMid, m.edge, 0.55);
  poly(ctx, [[-2.6 + lean, -15.0], [2.4 + lean, -14.8], [2.5, -9.6], [-2.5, -9.6]], m.oliveMid, m.edge, 0.62);
  poly(ctx, [[-2.4 + lean, -14.8], [0.3 + lean, -14.7], [0.1, -9.8], [-2.3, -9.8]], m.oliveLit);
  // 醒目阵营肩袖识别块与弹袋斜带
  poly(ctx, [[-2.7 + lean, -15.0], [2.4 + lean, -14.8], [2.2 + lean, -12.6], [-2.5 + lean, -12.8]], pal.mid, m.edge, 0.45);
  poly(ctx, [[-2.5 + lean, -14.9], [0.4 + lean, -14.8], [0.2 + lean, -12.8], [-2.4 + lean, -12.9]], pal.lit);
  poly(ctx, [[-2.6, -10.3], [2.5, -10.1], [2.5, -9.2], [-2.6, -9.4]], m.khakiShade);

  drawWw2Head(ctx, pal, m, lean * 1.1, -17.6);

  // 冲锋枪（弯弹匣）或半自动步枪（木托+短黑枪管）
  const gx0 = -0.6 + lean;
  const gy0 = -12.4;
  const gx1 = pose === 1 ? 10.6 : 9.4;
  const gy1 = pose === 1 ? -13.6 : -12.8;
  strokeSeg(ctx, gx0, gy0, gx0 + 4.4, gy0 - 0.3, m.woodDark, 2.3);
  strokeSeg(ctx, gx0 + 3.0, gy0 - 0.3, gx1, gy1, m.edge, 2.2);
  strokeSeg(ctx, gx0 + 3.0, gy0 - 0.3, gx1, gy1, m.gunMid, 1.2);
  // 冲锋枪下弯弹匣（强二战自动步兵特征！）
  if (pose !== 1) {
    strokeSeg(ctx, gx0 + 5.6, gy0 - 0.2, gx0 + 6.4, gy0 + 2.4, m.gunDark, 1.3);
  }
  // 端枪前臂
  poly(ctx, [[1.0 + lean, -13.8], [2.2 + lean, -13.2], [5.2, -12.4], [4.2, -11.4]], m.oliveLit, m.edge, 0.45);
  ctx.restore();
}

function paintSquad(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 三人紧密步兵班（后左、后右、前中蹲射，火力密度一眼高于双人古代步兵！）
  ctx.save();
  ctx.translate(-4.6, -3.0);
  ctx.scale(0.86, 0.86);
  drawSquadSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(2.6, -3.4);
  ctx.scale(0.84, 0.84);
  drawSquadSoldier(ctx, pal, m, 2);
  ctx.restore();

  ctx.save();
  ctx.translate(1.2, 2.0);
  ctx.scale(0.95, 0.95);
  drawSquadSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   2. 重机枪组（hmg · 215 金 · 射程 4）：
   前排弧形防弹沙袋掩体 + 三脚架重机枪（水冷/散热粗枪管 + 黄铜弹链 + 弹药箱）+ 双人蹲姿机枪手
   ========================================================================= */
function paintHmg(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 1.0, 1.0, 10.6, 3.8);

  // 副射手/弹药手（后左伏身供弹）
  ctx.save();
  ctx.translate(-4.4, -2.0);
  ctx.scale(0.90, 0.90);
  drawSoldierLegs(ctx, m, 0.8, true);
  poly(ctx, [[-2.4, -12.8], [2.4, -12.4], [2.4, -7.6], [-2.4, -7.8]], m.oliveMid, m.edge, 0.58);
  poly(ctx, [[-2.4, -12.8], [2.4, -12.4], [2.1, -10.8], [-2.3, -11.0]], pal.mid);
  drawWw2Head(ctx, pal, m, 0.6, -15.4);
  ctx.restore();

  // 主射手（蹲踞重机枪尾部握持双握把）
  ctx.save();
  ctx.translate(-1.2, 1.2);
  ctx.scale(0.95, 0.95);
  drawSoldierLegs(ctx, m, 0.85, true);
  poly(ctx, [[-2.4, -12.8], [2.5, -12.2], [2.5, -7.6], [-2.4, -7.8]], m.oliveMid, m.edge, 0.6);
  poly(ctx, [[-2.4, -12.8], [2.4, -12.3], [2.1, -10.6], [-2.3, -10.9]], pal.lit);
  drawWw2Head(ctx, pal, m, 0.9, -15.2);
  poly(ctx, [[1.4, -11.2], [2.6, -10.6], [5.2, -9.2], [4.2, -8.2]], m.oliveLit, m.edge, 0.45);
  ctx.restore();

  // 军绿钢弹药箱 + 挂向枪膛的金黄铜弹链
  poly(ctx, [[1.0, -2.6], [4.6, -3.2], [5.8, -1.6], [2.2, -1.0]], m.oliveLit, m.edge, 0.5);
  poly(ctx, [[1.0, -2.6], [2.2, -1.0], [2.2, 1.4], [1.0, -0.2]], m.oliveMid, m.edge, 0.5);
  poly(ctx, [[2.2, -1.0], [5.8, -1.6], [5.8, 0.8], [2.2, 1.4]], m.oliveShade, m.edge, 0.5);
  strokeSeg(ctx, 3.6, -2.4, 5.2, -7.6, m.brassLit, 1.5);

  // 重型钢三脚架 + 粗管重机枪主体
  strokeSeg(ctx, 5.4, -7.0, 2.2, 1.2, m.gunDark, 1.25);
  strokeSeg(ctx, 5.4, -7.0, 8.6, 1.0, m.gunDark, 1.25);
  strokeSeg(ctx, 5.4, -7.0, 5.8, -1.0, m.gunDark, 1.1);
  // 粗壮机匣与水冷/重型枪管 + 枪盾小片
  poly(ctx, [[2.4, -9.2], [8.8, -9.6], [8.8, -6.8], [2.4, -6.6]], m.gunMid, m.edge, 0.6);
  poly(ctx, [[2.6, -9.0], [8.6, -9.4], [8.6, -8.0], [2.6, -7.8]], m.steelMid);
  // 阵营识色小机枪护盾
  poly(ctx, [[7.0, -11.4], [8.4, -11.6], [8.4, -6.2], [7.0, -6.0]], pal.mid, m.edge, 0.55);
  // 细长重枪管与消焰器
  strokeSeg(ctx, 8.4, -8.2, 14.8, -8.8, m.edge, 2.5);
  strokeSeg(ctx, 8.4, -8.2, 14.8, -8.8, m.gunDark, 1.5);
  strokeSeg(ctx, 8.6, -8.5, 14.2, -9.0, m.steelLit, 0.45);

  // 前方标志性「两层交错卡其防弹沙袋掩体」（1× 远景瞬间认出重机枪阵地！）
  const sandbag = (sx: number, sy: number) => {
    poly(ctx, [
      [sx - 2.6, sy - 0.8], [sx - 1.6, sy - 1.8], [sx + 1.8, sy - 1.8],
      [sx + 2.7, sy - 0.6], [sx + 2.0, sy + 0.8], [sx - 2.0, sy + 0.8],
    ], m.khakiMid, m.edge, 0.55);
    poly(ctx, [[sx - 2.2, sy - 0.8], [sx - 1.4, sy - 1.6], [sx + 1.4, sy - 1.6], [sx + 1.2, sy - 0.4], [sx - 2.0, sy - 0.4]], m.khakiLit);
  };
  sandbag(5.2, 1.8);
  sandbag(9.4, 0.4);
  sandbag(11.4, -2.0);
  sandbag(7.4, -0.2);
  sandbag(10.2, -1.8);

  ctx.restore();
}

/* =========================================================================
   3. 坦克（tank · 400 金 · 移 3 · 攻 56 · 甲 10 · 血 88 · 射程 3）：
   经典二战履带中型/重型坦克——双侧宽履带负重轮 + 倾斜军绿装甲车体 + 旋转炮塔阵营识别条 + 制退器长主炮
   ========================================================================= */
function paintTank(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 厚重坦克接地影
  drawShadow(ctx, 0.8, 2.0, 13.8, 5.2);

  // 远侧（左后）履带轮廓
  poly(ctx, [[-11.6, -5.2], [5.8, -8.6], [8.4, -6.2], [-9.6, -2.6]], m.gunDark, m.edge, 0.65);

  // 近侧厚重装甲履带 + 5 枚负重轮（清晰机械履带结构！）
  poly(ctx, [
    [-12.2, -1.6], [9.4, -5.0], [12.6, -1.8], [10.4, 2.4],
    [-9.8, 4.6], [-13.2, 1.6],
  ], m.gunDark, m.edge, 0.72);
  poly(ctx, [[-11.8, -1.0], [9.4, -4.2], [11.6, -1.8], [9.8, 1.4], [-9.4, 3.6], [-12.2, 1.2]], m.gunMid);
  // 5 个圆形负重轮
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const wx = -9.4 + t * 18.4;
    const wy = 1.6 - t * 2.2;
    ctx.beginPath();
    ctx.arc(wx, wy, 1.85, 0, Math.PI * 2);
    ctx.fillStyle = m.oliveShade;
    ctx.fill();
    ctx.strokeStyle = m.gunDark;
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(wx, wy, 0.65, 0, Math.PI * 2);
    ctx.fillStyle = m.steelMid;
    ctx.fill();
  }

  // 倾斜军绿装甲车体（Sloped Glacis，左受光顶甲 + 右前斜甲 + 侧裙板）
  poly(ctx, [[-12.4, -3.0], [-4.8, -8.8], [10.2, -8.0], [13.2, -3.4], [9.4, -1.6], [-10.6, 0.2]], m.oliveMid, m.edge, 0.72);
  poly(ctx, [[-11.8, -3.2], [-4.8, -8.6], [9.8, -7.8], [7.0, -4.8], [-9.6, -2.6]], m.oliveLit);
  // 车体侧面厚重装甲裙板 + 醒目阵营战术斜杠
  poly(ctx, [[-11.8, -2.8], [9.4, -4.8], [12.8, -3.2], [9.4, -1.4], [-10.8, 0.4]], m.oliveShade, m.edge, 0.58);
  poly(ctx, [[-3.4, -3.5], [1.6, -4.0], [0.4, -1.0], [-4.6, -0.5]], pal.mid);
  poly(ctx, [[-3.0, -3.4], [-0.4, -3.7], [-1.4, -0.9], [-4.0, -0.6]], pal.lit);
  // 车尾发动机散热格栅
  strokeSeg(ctx, -10.2, -4.6, -6.2, -6.8, m.gunDark, 0.85);
  strokeSeg(ctx, -8.4, -4.4, -4.4, -6.6, m.gunDark, 0.85);

  // 标志性「铸造旋转炮塔」（立体切面 + 车长指挥塔 + 细长无线电鞭状天线 + 阵营炮塔环带）
  poly(ctx, [[-6.2, -6.8], [-5.2, -13.0], [3.6, -13.2], [5.8, -8.6], [3.4, -5.6], [-5.2, -5.0]], m.oliveMid, m.edge, 0.72);
  poly(ctx, [[-5.0, -12.8], [3.4, -13.0], [4.6, -10.4], [-3.8, -10.0]], m.oliveLit);
  poly(ctx, [[-6.0, -6.8], [-5.0, -12.6], [-3.6, -10.0], [-4.8, -5.2]], m.oliveLit);
  poly(ctx, [[3.4, -5.8], [5.6, -8.6], [3.4, -12.8], [2.4, -10.2]], m.oliveShade);
  // 炮塔醒目阵营识别带（1× 远景秒分红蓝坦克！）
  poly(ctx, [[-5.6, -9.8], [4.8, -10.2], [5.2, -8.2], [-5.4, -7.8]], pal.mid, m.edge, 0.45);
  poly(ctx, [[-5.4, -9.7], [0.4, -9.9], [0.2, -8.1], [-5.3, -7.9]], pal.lit);
  // 车长指挥塔与细长鞭状天线
  poly(ctx, [[-3.6, -13.0], [-3.2, -15.0], [0.8, -15.0], [1.2, -13.0]], m.oliveLit, m.edge, 0.55);
  strokeSeg(ctx, -4.4, -12.6, -7.2, -23.4, m.gunDark, 0.75);

  // 威武「长管坦克主炮 + 炮盾 + 炮口制退器」
  poly(ctx, [[3.8, -11.4], [6.6, -11.6], [6.8, -8.6], [4.0, -8.4]], m.oliveShade, m.edge, 0.55);
  strokeSeg(ctx, 5.8, -10.2, 18.2, -13.2, m.edge, 3.3);
  strokeSeg(ctx, 5.8, -10.2, 18.2, -13.2, m.oliveMid, 2.2);
  strokeSeg(ctx, 6.2, -10.7, 17.6, -13.5, m.oliveLit, 0.75);
  // 标志性炮口制退器（T 形粗炮口）
  poly(ctx, [[16.8, -14.2], [19.4, -14.8], [19.8, -12.6], [17.2, -12.0]], m.gunDark, m.edge, 0.5);

  ctx.restore();
}

/* =========================================================================
   4. 火炮（artillery · 380 金 · 攻 47 · 射程 5 · 溅射 2）：
   双轮开脚大架野战榴弹炮——超大橡胶钢炮轮 + 倾斜防弹阵营炮盾 + 超长仰角榴弹炮管 + 炮手与黄铜炮弹
   ========================================================================= */
function paintArtillery(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后侧站立炮手
  ctx.save();
  ctx.translate(-6.6, -2.0);
  ctx.scale(0.90, 0.90);
  drawShadow(ctx, 1.4, 0.6, 4.0, 1.7);
  drawSoldierLegs(ctx, m, 0.78);
  poly(ctx, [[-2.5, -14.8], [2.4, -14.6], [2.6, -6.6], [-2.5, -6.8]], m.oliveMid, m.edge, 0.58);
  poly(ctx, [[-2.4, -14.7], [2.3, -14.6], [2.1, -12.6], [-2.3, -12.8]], pal.mid);
  drawWw2Head(ctx, pal, m, 0.3, -17.4);
  ctx.restore();

  drawShadow(ctx, 1.8, 1.8, 11.4, 4.0);

  // 开脚式双钢大架（向后叉开稳固驻锄，经典野战榴弹炮轮廓！）
  strokeSeg(ctx, 2.4, -2.6, -9.6, 0.2, m.edge, 2.8);
  strokeSeg(ctx, 2.4, -2.6, -9.6, 0.2, m.oliveShade, 1.7);
  strokeSeg(ctx, 2.4, -1.4, -6.4, 3.8, m.edge, 3.0);
  strokeSeg(ctx, 2.4, -1.4, -6.4, 3.8, m.oliveMid, 1.8);
  // 远侧大轮
  ctx.beginPath();
  ctx.arc(0.4, -3.4, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = m.gunDark;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // 标志性「超长仰角榴弹炮管」（指向高空斜前方，一眼传达射程 5 + 溅射 2！）
  strokeSeg(ctx, -1.0, -5.4, 16.4, -21.2, m.edge, 3.8);
  strokeSeg(ctx, -1.0, -5.4, 16.4, -21.2, m.oliveMid, 2.6);
  strokeSeg(ctx, -0.6, -6.0, 15.8, -21.6, m.oliveLit, 0.9);
  // 炮管下方液压复进筒
  strokeSeg(ctx, 1.2, -5.4, 10.6, -14.0, m.gunMid, 1.9);
  // 炮口制退器
  poly(ctx, [[15.0, -21.8], [17.8, -24.2], [19.2, -22.4], [16.4, -20.0]], m.gunDark, m.edge, 0.55);

  // 倾斜装甲防弹炮盾（配醒目阵营涂装带）
  poly(ctx, [[1.8, -11.6], [7.2, -10.8], [8.6, -2.0], [3.0, -2.8]], m.oliveMid, m.edge, 0.7);
  poly(ctx, [[2.0, -11.4], [5.0, -11.0], [6.0, -2.4], [3.2, -2.8]], m.oliveLit);
  poly(ctx, [[2.3, -9.0], [7.4, -8.3], [7.8, -6.0], [2.6, -6.7]], pal.mid);
  poly(ctx, [[2.4, -8.9], [5.0, -8.6], [5.3, -6.4], [2.7, -6.7]], pal.lit);

  // 近侧大型橡胶炮轮（带军绿轮毂）
  ctx.beginPath();
  ctx.arc(3.6, -0.4, 4.6, 0, Math.PI * 2);
  ctx.fillStyle = m.gunDark;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(3.6, -0.4, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = m.oliveLit;
  ctx.fill();
  ctx.strokeStyle = m.gunDark;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(3.6, -0.4, 0.9, 0, Math.PI * 2);
  ctx.fillStyle = m.steelLit;
  ctx.fill();

  // 炮旁两枚竖立闪亮黄铜炮弹
  poly(ctx, [[9.6, 1.8], [9.6, -1.6], [10.4, -3.2], [11.2, -1.6], [11.2, 1.8]], m.brassLit, m.edge, 0.45);
  poly(ctx, [[11.6, 2.2], [11.6, -1.2], [12.4, -2.8], [13.2, -1.2], [13.2, 2.2]], m.brassLit, m.edge, 0.45);

  ctx.restore();
}

/* =========================================================================
   5. 建筑队（crew · 280 金 · 建造者）：
   时代 5 机械化工程施工队——工程黄履带推土机（弧形大推土铲 + 驾驶棚 + 阵营引擎条）+ 持图纸工兵
   ========================================================================= */
function paintCrew(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后左站立的工程指挥员（安全帽/钢盔 + 白蓝施工图纸）
  ctx.save();
  ctx.translate(-7.2, -2.2);
  ctx.scale(0.88, 0.88);
  drawShadow(ctx, 1.2, 0.5, 3.8, 1.6);
  drawSoldierLegs(ctx, m, 0.75);
  poly(ctx, [[-2.4, -14.8], [2.4, -14.6], [2.5, -6.6], [-2.5, -6.8]], m.khakiMid, m.edge, 0.58);
  poly(ctx, [[-2.3, -14.7], [2.3, -14.5], [2.2, -11.4], [-2.3, -11.6]], pal.mid);
  // 工程黄安全帽
  poly(ctx, [[-1.6, -18.8], [1.6, -18.8], [1.6, -15.6], [-1.4, -15.6]], m.skinLit, m.edge, 0.52);
  poly(ctx, [[-2.5, -18.2], [-2.0, -20.6], [2.0, -20.6], [2.8, -18.2]], m.dozerLit, m.edge, 0.55);
  // 手中展开图纸
  poly(ctx, [[1.4, -13.0], [5.4, -14.2], [5.8, -10.8], [1.8, -9.6]], m.steelLit, m.edge, 0.48);
  ctx.restore();

  // 标志性「工程黄履带推土机」（1× 远景一秒识别机械化建筑队！）
  drawShadow(ctx, 2.2, 1.8, 11.4, 4.2);

  // 履带底座
  poly(ctx, [[-5.6, -1.0], [6.6, -3.2], [8.2, -0.4], [6.8, 2.2], [-4.8, 3.8], [-6.6, 1.4]], m.gunDark, m.edge, 0.7);
  poly(ctx, [[-5.2, -0.4], [6.4, -2.4], [7.2, -0.4], [6.2, 1.4], [-4.6, 2.8], [-5.8, 1.0]], m.gunMid);
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    ctx.beginPath();
    ctx.arc(-3.6 + t * 9.6, 1.4 - t * 1.4, 1.35, 0, Math.PI * 2);
    ctx.fillStyle = m.dozerShade;
    ctx.fill();
  }

  // 工程黄引擎机身 + 阵营饰条 + 垂直排气管
  poly(ctx, [[-5.4, -2.2], [-5.4, -8.8], [6.6, -9.8], [7.6, -3.4], [-4.6, -0.6]], m.dozerMid, m.edge, 0.68);
  poly(ctx, [[-5.2, -8.6], [6.4, -9.6], [4.2, -6.8], [-4.8, -6.2]], m.dozerLit);
  poly(ctx, [[-4.8, -6.0], [6.8, -7.0], [7.0, -5.2], [-4.8, -4.2]], pal.mid);
  strokeSeg(ctx, 4.2, -9.4, 4.2, -14.8, m.gunDark, 1.4);

  // 驾驶棚防滚架 + 驾驶员剪影
  poly(ctx, [[-4.4, -8.6], [-4.4, -14.8], [1.4, -15.2], [1.4, -9.2]], 'rgba(42, 46, 50, 0.28)', m.gunDark, 1.15);
  poly(ctx, [[-5.4, -14.8], [2.2, -15.4], [2.2, -14.0], [-5.4, -13.4]], m.dozerLit, m.edge, 0.6);
  // 驾驶员小头盔
  ctx.beginPath();
  ctx.arc(-1.4, -12.0, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = pal.lit;
  ctx.fill();

  // 前伸液压推臂 + 宽大弧形亮钢「推土大铲」（超强视觉特征！）
  strokeSeg(ctx, 2.0, -2.0, 10.6, -1.6, m.dozerShade, 2.2);
  ctx.beginPath();
  ctx.moveTo(8.8, -9.6);
  ctx.lineTo(13.6, -8.4);
  ctx.quadraticCurveTo(11.6, -3.4, 14.6, 0.8);
  ctx.lineTo(9.4, 2.2);
  ctx.quadraticCurveTo(7.4, -3.6, 8.8, -9.6);
  ctx.closePath();
  ctx.fillStyle = m.dozerMid;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.72;
  ctx.stroke();
  // 推土铲亮钢下铲刃
  poly(ctx, [[9.4, 0.8], [14.6, -0.4], [14.8, 0.9], [9.5, 2.2]], m.steelLit, m.edge, 0.45);

  ctx.restore();
}

/* =========================================================================
   6. 碉堡（bunker · 350 金 · 甲 13 · 血 86 · 射程 4）：
   E5 同源粗粝暖灰钢筋混凝土低矮斜壁碉堡 + 宽长黑枪眼机枪/火炮口 + 顶置观察钢穹与无线电杆（锁定西北受光）
   ========================================================================= */
function paintBunker(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.8, 1.4], [5.8, -4.4], [16.2, 1.2], [1.6, 6.8]], 'rgba(22, 23, 20, 0.38)');

  // 底部防护土坡与卡其沙袋裙
  poly(ctx, [[-13.2, 0.4], [-7.4, -4.4], [7.4, -4.4], [13.2, 0.4], [7.4, 5.2], [-7.4, 5.2]], m.khakiShade, m.edge, 0.65);

  // 厚重外斜钢筋混凝土八角碉堡主体（极厚实的防弹感，甲 13！）
  poly(ctx, [[-12.4, -0.2], [-10.0, -10.8], [-5.8, -7.2], [-7.0, 4.6]], m.concLit, m.edge, 0.72);
  poly(ctx, [[-7.0, 4.6], [-5.8, -7.2], [5.8, -7.2], [7.0, 4.6]], m.concMid, m.edge, 0.72);
  poly(ctx, [[7.0, 4.6], [5.8, -7.2], [10.0, -10.8], [12.4, -0.2]], m.concShade, m.edge, 0.72);
  // 超厚外挑混凝土防弹平顶板
  poly(ctx, [[-11.2, -11.0], [-6.2, -15.4], [6.2, -15.4], [11.2, -11.0], [6.4, -6.6], [-6.4, -6.6]], m.concTop, m.edge, 0.75);
  poly(ctx, [[-11.2, -11.0], [-6.4, -6.6], [6.4, -6.6], [11.2, -11.0], [11.0, -9.2], [6.4, -5.0], [-6.4, -5.0], [-11.0, -9.2]], m.concShade, m.edge, 0.55);

  // 标志性「深黑宽长条形射孔」+ 伸出的双联重武器炮管（1× 一眼认出混凝土碉堡！）
  poly(ctx, [[-5.0, -3.4], [5.0, -3.4], [5.0, -0.8], [-5.0, -0.8]], '#16191c', m.concLit, 0.5);
  poly(ctx, [[7.4, -4.2], [10.4, -6.2], [10.4, -3.8], [7.4, -1.8]], '#16191c', m.concMid, 0.45);
  // 射孔中伸出的黑铁炮管
  strokeSeg(ctx, -1.2, -2.1, -1.2, 2.2, m.edge, 2.8);
  strokeSeg(ctx, -1.2, -2.1, -1.2, 2.2, m.gunDark, 1.8);
  strokeSeg(ctx, 2.4, -2.1, 4.2, 1.4, m.gunDark, 1.6);
  strokeSeg(ctx, 9.0, -4.2, 13.4, -2.6, m.gunDark, 2.0);

  // 碉堡前立面醒目阵营战术标识条
  poly(ctx, [[-6.4, 2.0], [6.4, 2.0], [6.6, 3.8], [-6.6, 3.8]], pal.mid);
  poly(ctx, [[-6.4, 2.0], [0.0, 2.0], [0.0, 3.8], [-6.6, 3.8]], pal.lit);

  // 顶置装甲钢观察穹顶 + 无线电短天线与阵营小旗
  poly(ctx, [[-3.4, -12.6], [-2.8, -16.4], [2.8, -16.4], [3.4, -12.6], [0.0, -11.2]], m.steelMid, m.edge, 0.6);
  poly(ctx, [[-3.0, -12.8], [-2.6, -16.0], [0.2, -16.0], [0.0, -11.4]], m.steelLit);
  strokeSeg(ctx, -6.4, -12.4, -6.4, -24.4, m.gunDark, 1.25);
  poly(ctx, [[-6.2, -24.2], [0.4, -22.8], [-6.2, -21.0]], pal.mid, m.edge, 0.48);
  poly(ctx, [[-6.2, -24.0], [-2.2, -23.1], [-6.2, -22.2]], pal.lit);
}

/* =========================================================================
   7. 工业园（industrialpark · 390 金 · 经济建筑 · 甲 9）：
   E5 同源暖灰混凝土底坪 + 军绿圆拱波纹钢大装配厂房 + 双联工业储油罐 + 高耸钢烟囱（锁定西北受光）
   ========================================================================= */
function paintIndustrialPark(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.8, 1.4], [4.8, -5.2], [15.8, 1.2], [1.4, 6.8]], 'rgba(22, 23, 20, 0.34)');

  // 混凝土工业基坪
  poly(ctx, [[-13.0, 0.0], [0.0, -6.4], [13.0, 0.0], [0.0, 6.0]], m.concShade, m.edge, 0.7);
  poly(ctx, [[-12.2, 0.0], [0.0, -5.8], [12.2, 0.0], [0.0, 5.2]], m.concTop);

  // 后侧高耸工业钢烟囱 + 白色蒸汽云
  poly(ctx, [[4.6, -8.8], [5.2, -29.2], [7.4, -29.2], [8.0, -8.8]], m.gunMid, m.edge, 0.6);
  poly(ctx, [[5.2, -29.2], [6.4, -29.2], [6.4, -8.8], [4.8, -8.8]], m.steelMid);
  poly(ctx, [[5.1, -26.0], [7.5, -26.0], [7.6, -23.6], [5.0, -23.6]], pal.mid);
  ctx.fillStyle = 'rgba(238, 242, 244, 0.72)';
  ctx.beginPath();
  ctx.arc(7.6, -31.2, 2.1, 0, Math.PI * 2);
  ctx.arc(10.4, -33.2, 2.6, 0, Math.PI * 2);
  ctx.arc(13.2, -34.2, 1.8, 0, Math.PI * 2);
  ctx.fill();

  // 标志性「E5 圆拱顶波纹钢重工大厂房」（左中主建筑，直接呼应 E5 机械化城市！）
  poly(ctx, [[-11.2, -0.6], [-11.2, -10.8], [1.2, -15.8], [1.2, -5.6]], m.concLit, m.edge, 0.65);
  // 军绿圆拱波纹钢屋面
  ctx.beginPath();
  ctx.moveTo(-11.4, -10.4);
  ctx.quadraticCurveTo(-7.2, -21.2, -1.6, -14.8);
  ctx.lineTo(4.2, -12.0);
  ctx.quadraticCurveTo(-1.2, -18.4, -5.6, -7.6);
  ctx.closePath();
  ctx.fillStyle = m.oliveMid;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.68;
  ctx.stroke();
  // 波纹钢受光弧脊
  poly(ctx, [[-10.8, -10.6], [-7.2, -17.8], [-2.8, -15.6], [-6.6, -8.6]], m.oliveLit);
  // 拱门大卷帘货门 + 阵营横幅
  poly(ctx, [[-5.6, -7.6], [4.2, -12.0], [4.2, -3.2], [-5.6, 1.2]], m.concMid, m.edge, 0.65);
  poly(ctx, [[-4.2, 0.4], [-4.2, -5.2], [0.6, -7.2], [0.6, -1.6]], m.gunDark, m.edge, 0.55);
  poly(ctx, [[-5.4, -7.8], [4.0, -12.0], [4.0, -10.2], [-5.4, -6.0]], pal.mid);

  // 右前侧标志性「双联军用圆柱储油罐」（工业园超强剪影特征！）
  const drawTankCyl = (tx: number, ty: number) => {
    poly(ctx, [[tx - 3.2, ty], [tx - 3.2, ty - 7.8], [tx + 3.2, ty - 7.8], [tx + 3.2, ty]], m.steelMid, m.edge, 0.62);
    poly(ctx, [[tx - 3.0, ty - 0.1], [tx - 3.0, ty - 7.6], [tx + 0.2, ty - 7.6], [tx + 0.2, ty - 0.1]], m.steelLit);
    poly(ctx, [[tx - 3.1, ty - 4.8], [tx + 3.1, ty - 4.8], [tx + 3.1, ty - 3.4], [tx - 3.1, ty - 3.4]], pal.mid);
    ctx.beginPath();
    ctx.ellipse(tx, ty - 7.8, 3.2, 1.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = m.concTop;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.58;
    ctx.stroke();
  };
  drawTankCyl(7.6, -1.8);
  drawTankCyl(3.4, 2.2);
}

/* =========================================================================
   8. 前进基地（camp5 · 300 金 · 甲 8 · 血 78 · 产兵 + 自动攻击）：
   沙袋混凝土军用围坪 + 波纹钢半圆指挥库（Quonset）+ 高耸钢架无线电铁塔 + 战旗（锁定西北受光）
   ========================================================================= */
function paintCamp5(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-13.0, 1.2], [2.4, -6.4], [15.4, 0.8], [0.8, 7.0]], 'rgba(22, 23, 20, 0.36)');

  // 混凝土停机/整备底坪 + 柏油标线
  poly(ctx, [[-13.0, -0.2], [0.0, -6.6], [13.0, -0.2], [0.0, 5.8]], m.concShade, m.edge, 0.7);
  poly(ctx, [[-12.2, -0.2], [0.0, -6.0], [12.2, -0.2], [0.0, 5.2]], m.concMid);
  poly(ctx, [[-8.6, 0.8], [0.0, -3.4], [8.6, 0.8], [0.0, 4.6]], m.gunMid);
  strokeSeg(ctx, -4.6, 1.2, 4.6, 1.2, m.dozerLit, 0.75);

  // 后侧混凝土低防爆墙与警戒条
  poly(ctx, [[-12.6, -0.2], [-12.2, -4.6], [0.0, -10.4], [0.0, -6.0]], m.concLit, m.edge, 0.62);
  poly(ctx, [[0.0, -6.0], [0.0, -10.4], [12.2, -4.6], [12.6, -0.2]], m.concShade, m.edge, 0.62);

  // 基地核心：军绿圆拱波纹钢「前进指挥库」（Quonset Hut）
  ctx.beginPath();
  ctx.moveTo(-8.4, -0.8);
  ctx.quadraticCurveTo(-5.0, -12.6, 0.8, -6.2);
  ctx.lineTo(6.4, -9.0);
  ctx.quadraticCurveTo(0.8, -15.4, -2.6, -3.6);
  ctx.closePath();
  ctx.fillStyle = m.oliveMid;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.68;
  ctx.stroke();
  poly(ctx, [[-7.6, -1.6], [-4.8, -9.8], [1.4, -12.2], [-1.8, -4.0]], m.oliveLit);
  // 指挥库前山墙 + 阵营指挥标条
  poly(ctx, [[-8.4, -0.8], [-5.2, -7.8], [-2.0, -3.2], [-2.0, 2.0]], m.concLit, m.edge, 0.6);
  poly(ctx, [[-6.8, 0.4], [-6.8, -3.4], [-3.8, -2.0], [-3.8, 1.8]], m.gunDark);
  poly(ctx, [[-7.8, -4.4], [-2.6, -2.0], [-2.6, -0.8], [-7.8, -3.2]], pal.mid);

  // 标志性「钢架无线电铁塔」（高耸镂空交叉钢塔，瞬间拉出机械化前沿指挥感！）
  const tx = 6.2;
  const ty = -2.2;
  strokeSeg(ctx, tx - 3.2, ty, tx, ty - 23.6, m.gunDark, 1.3);
  strokeSeg(ctx, tx + 3.2, ty, tx, ty - 23.6, m.gunDark, 1.3);
  strokeSeg(ctx, tx - 2.6, ty - 4.8, tx + 2.6, ty - 4.8, m.steelMid, 0.8);
  strokeSeg(ctx, tx - 1.9, ty - 10.6, tx + 1.9, ty - 10.6, m.steelMid, 0.8);
  strokeSeg(ctx, tx - 1.2, ty - 16.4, tx + 1.2, ty - 16.4, m.steelMid, 0.8);
  strokeSeg(ctx, tx - 2.4, ty - 5.0, tx + 1.8, ty - 10.4, m.gunMid, 0.7);
  strokeSeg(ctx, tx + 2.4, ty - 5.0, tx - 1.8, ty - 10.4, m.gunMid, 0.7);
  // 塔顶雷达横杆与红色航标灯
  strokeSeg(ctx, tx - 2.8, ty - 21.8, tx + 2.8, ty - 21.8, m.steelLit, 1.0);
  ctx.beginPath();
  ctx.arc(tx, ty - 24.4, 1.15, 0, Math.PI * 2);
  ctx.fillStyle = pal.lit;
  ctx.fill();

  // 基地门岗阵营军旗与前哨沙袋
  poly(ctx, [[-10.4, 2.2], [-6.2, 4.0], [-5.4, 2.6], [-9.6, 0.8]], m.khakiMid, m.edge, 0.52);
  strokeSeg(ctx, -9.4, 1.2, -9.4, -18.2, m.steelLit, 1.0);
  poly(ctx, [[-9.2, -18.0], [-1.0, -16.6], [-2.2, -14.2], [-0.8, -12.0], [-9.2, -13.0]], pal.mid, m.edge, 0.5);
  poly(ctx, [[-9.2, -17.8], [-4.2, -16.9], [-4.6, -13.2], [-9.2, -13.6]], pal.lit);
}

/* =========================================================================
   9. 钢桥（bridge3 · 140 金 · 甲 6 · 血 120 · 水上工程建筑）：
   混凝土桥墩 + 深灰柏油车道 + 标志性高耸斜交「立体钢铁桁架（Warren Truss）」桥身 + 阵营旗
   ========================================================================= */
function paintBridge3(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterWake(ctx, 13.8, 5.4, pal, opts.selected, opts.target);

  // 混凝土水中桥墩
  for (const [px, py] of [[-8.6, 1.4], [-1.4, 4.0], [5.8, 1.6]] as const) {
    poly(ctx, [[px - 1.8, py - 3.6], [px + 1.8, py - 3.6], [px + 2.0, py + 2.6], [px - 2.0, py + 2.6]], m.concMid, m.edge, 0.58);
    poly(ctx, [[px - 1.7, py - 3.5], [px, py - 3.5], [px, py + 2.5], [px - 1.8, py + 2.5]], m.concLit);
  }

  // 厚钢梁桥底与深灰柏油桥面 + 中央黄实线
  poly(ctx, [[-13.0, -1.8], [-3.2, -7.8], [13.0, -1.6], [3.2, 4.4]], m.gunMid, m.edge, 0.72);
  poly(ctx, [[-13.0, -1.8], [3.2, 4.4], [3.2, 6.2], [-13.0, 0.0]], m.steelShade, m.edge, 0.65);
  poly(ctx, [[3.2, 4.4], [13.0, -1.6], [13.0, 0.2], [3.2, 6.2]], m.gunDark, m.edge, 0.65);
  strokeSeg(ctx, -8.1, -4.8, 8.1, 1.4, m.dozerLit, 0.85);

  // 标志性「立体交叉钢铁桁架桥架」（远侧桁架 -> 顶横联 -> 近侧桁架，1× 远景一眼认出钢桥！）
  const drawTrussSide = (x0: number, y0: number, x1: number, y1: number, col: string) => {
    const h = 8.4;
    // 上下弦钢梁
    strokeSeg(ctx, x0, y0, x1, y1, m.edge, 2.2);
    strokeSeg(ctx, x0, y0, x1, y1, col, 1.25);
    strokeSeg(ctx, x0 + (x1 - x0) * 0.14, y0 + (y1 - y0) * 0.14 - h, x0 + (x1 - x0) * 0.86, y0 + (y1 - y0) * 0.86 - h, m.edge, 2.2);
    strokeSeg(ctx, x0 + (x1 - x0) * 0.14, y0 + (y1 - y0) * 0.14 - h, x0 + (x1 - x0) * 0.86, y0 + (y1 - y0) * 0.86 - h, col, 1.25);
    // 锯齿状斜腹杆（Warren Truss）
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const ta = i / steps;
      const tb = (i + 1) / steps;
      const tm = (ta + tb) * 0.5;
      const bx0 = x0 + (x1 - x0) * ta;
      const by0 = y0 + (y1 - y0) * ta;
      const bx1 = x0 + (x1 - x0) * tb;
      const by1 = y0 + (y1 - y0) * tb;
      const tx = x0 + (x1 - x0) * tm;
      const ty = y0 + (y1 - y0) * tm - h;
      strokeSeg(ctx, bx0, by0, tx, ty, col, 1.15);
      strokeSeg(ctx, tx, ty, bx1, by1, col, 1.15);
    }
  };

  // 远侧桁架
  drawTrussSide(-3.2, -7.8, 13.0, -1.6, m.steelShade);
  // 顶部横联钢梁
  for (const t of [0.22, 0.5, 0.78]) {
    const fx = -13.0 + 16.2 * t;
    const fy = -1.8 + 6.2 * t - 8.4;
    const rx = -3.2 + 16.2 * t;
    const ry = -7.8 + 6.2 * t - 8.4;
    strokeSeg(ctx, fx, fy, rx, ry, m.steelMid, 1.1);
  }
  // 近侧受光桁架
  drawTrussSide(-13.0, -1.8, 3.2, 4.4, m.steelLit);

  // 桥头阵营标识牌
  poly(ctx, [[-11.8, -5.6], [-8.4, -4.3], [-8.4, -1.8], [-11.8, -3.1]], pal.mid, m.edge, 0.45);
}

export const ERA5_UNIT_SPECS: Readonly<Record<string, Era1UnitSpec>> = {
  commando: { paint: paintSquad, ringRx: 10.8, ringRy: 4.6, hitTop: 25 },
  hmg: { paint: paintHmg, ringRx: 11.4, ringRy: 4.9, barY: 5.4, hitTop: 22 },
  tank: { paint: paintTank, ringRx: 13.4, ringRy: 5.8, barY: 6.4, hitTop: 24 },
  artillery: { paint: paintArtillery, ringRx: 12.2, ringRy: 5.2, barY: 5.8, hitTop: 26 },
  crew: { paint: paintCrew, ringRx: 12.4, ringRy: 5.3, barY: 5.6, hitTop: 24 },
  bunker: { paint: paintBunker, ringRx: 13.2, ringRy: 5.8, barY: 6.4, hitTop: 26 },
  industrialpark: { paint: paintIndustrialPark, ringRx: 13.2, ringRy: 5.8, barY: 6.4, hitTop: 35 },
  camp5: { paint: paintCamp5, ringRx: 13.2, ringRy: 5.8, barY: 6.6, hitTop: 30 },
  bridge3: { paint: paintBridge3, waterUnit: true, barY: 6.8, hitTop: 20 },
};

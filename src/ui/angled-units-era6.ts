/**
 * 时代 6（信息化时代 / 21 世纪现代联合作战）全 9 个兵种与建筑的斜俯视 3D 微缩沙盘绘制模块。
 *
 * 与时代 1~5 保持统一 4.8 头身写实微缩战棋风格与西北受光体系，全面呼应 E6 现代大都会 CBD 材质语言：
 * - 洁净银白混凝土与铝塑（#e7eef3 / #b1c0cb / #8c9ca8）、蔚蓝玻璃幕墙与蓝光伏板（#6db3d9 / #478cb5 / #2f6282）、
 *   现代哑光灰绿装甲（#88948b / #616d66 / #414b46）、雷达青光与导航橙灯；
 * - 涵盖摩托化步兵、楔形复合甲中型坦克、后置炮塔自行榴弹炮、雷达桅杆八轮装甲侦察车、
 *   集装箱重卡物流中心、液压吊臂工程兵、自动炮塔混凝土碉堡、蓝玻璃光伏产业园与带雷达球/H 停机坪的联合作战中心。
 */

import type { AngledUnitPaintOpts, TeamClothPalette } from './angled-units.ts';
import type { Era1UnitSpec } from './angled-units-era1.ts';

interface Era6Mat {
  edge: string;
  whiteTop: string;
  whiteLit: string;
  whiteMid: string;
  whiteShade: string;
  glassLit: string;
  glassMid: string;
  glassShade: string;
  armorLit: string;
  armorMid: string;
  armorShade: string;
  asphalt: string;
  gunDark: string;
  gunMid: string;
  steelLit: string;
  steelMid: string;
  cyanGlow: string;
  amber: string;
  greenPark: string;
  skinLit: string;
  skinShade: string;
}

function getMat(dim: boolean): Era6Mat {
  return {
    edge: dim ? 'rgba(38, 42, 46, 0.62)' : 'rgba(28, 34, 40, 0.76)',
    whiteTop: dim ? '#bcc3c8' : '#e6eef4',
    whiteLit: dim ? '#aab2b8' : '#cfdbe4',
    whiteMid: dim ? '#90989e' : '#aebcc7',
    whiteShade: dim ? '#70777d' : '#8293a0',
    glassLit: dim ? '#8da3b0' : '#73bce0',
    glassMid: dim ? '#6f8491' : '#4a8eb8',
    glassShade: dim ? '#50616b' : '#2f6182',
    armorLit: dim ? '#8c928e' : '#8b988e',
    armorMid: dim ? '#6e7470' : '#637168',
    armorShade: dim ? '#4d524f' : '#414c46',
    asphalt: dim ? '#4e5256' : '#505b66',
    gunDark: dim ? '#383b3e' : '#282e34',
    gunMid: dim ? '#55595e' : '#4a535c',
    steelLit: dim ? '#bfc5c9' : '#dce4ea',
    steelMid: dim ? '#92999e' : '#9aa8b3',
    cyanGlow: dim ? '#9ec0c7' : '#68dcf0',
    amber: dim ? '#c7ba8b' : '#ebb846',
    greenPark: dim ? '#7d8a75' : '#74b064',
    skinLit: dim ? '#c9bfb2' : '#e6be96',
    skinShade: dim ? '#a3998d' : '#bc8f66',
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
  ctx.fillStyle = 'rgba(20, 25, 30, 0.34)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0.14, 0, Math.PI * 2);
  ctx.fill();
}

/** 现代战术单兵（凯夫拉防弹盔 + 护目镜 + 战术背心 + 紧凑现代突击步枪） */
function drawModernTrooper(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era6Mat, kneel: boolean): void {
  drawShadow(ctx, 1.4, 0.5, 3.8, 1.6);
  if (kneel) {
    poly(ctx, [[-2.0, -5.4], [-0.4, -5.4], [-1.8, -1.8], [-3.4, -2.0]], m.armorShade, m.edge, 0.48);
    poly(ctx, [[0.1, -5.2], [2.0, -5.0], [2.8, -1.8], [1.0, -2.0]], m.armorMid, m.edge, 0.48);
    poly(ctx, [[1.0, -2.0], [2.8, -1.8], [3.2, 0.6], [1.2, 0.6]], m.gunDark);
  } else {
    poly(ctx, [[-1.8, -7.4], [-0.4, -7.4], [-2.0, -2.2], [-3.2, -2.4]], m.armorShade, m.edge, 0.48);
    poly(ctx, [[-3.2, -2.4], [-2.0, -2.2], [-2.2, 0.4], [-3.5, 0.3]], m.gunDark);
    poly(ctx, [[0.0, -7.2], [1.8, -7.2], [2.2, -2.0], [0.8, -2.2]], m.armorMid, m.edge, 0.48);
    poly(ctx, [[0.8, -2.2], [2.2, -2.0], [2.6, 0.6], [0.9, 0.6]], m.gunDark);
  }

  const yDrop = kneel ? 1.6 : 0;
  const lean = kneel ? 0.9 : 0.45;
  ctx.save();
  ctx.translate(0, yDrop);
  // 现代防弹战术背心 + 醒目阵营肩袖标识
  poly(ctx, [[-2.5 + lean, -14.8], [2.4 + lean, -14.6], [2.5, -7.0], [-2.5, -7.2]], m.armorMid, m.edge, 0.58);
  poly(ctx, [[-2.3 + lean, -14.6], [0.3 + lean, -14.5], [0.1, -7.2], [-2.3, -7.3]], m.armorLit);
  poly(ctx, [[-2.5 + lean, -14.8], [2.3 + lean, -14.6], [2.2 + lean, -12.4], [-2.4 + lean, -12.6]], pal.mid);
  poly(ctx, [[-1.6 + lean, -13.6], [1.8 + lean, -13.5], [1.8, -9.8], [-1.6, -9.9]], m.gunMid, m.edge, 0.42);
  // 凯夫拉盔 + 护目镜
  const hx = lean * 1.1;
  const hy = -17.4;
  poly(ctx, [[hx - 1.4, hy - 1.0], [hx + 1.4, hy - 1.0], [hx + 1.4, hy + 1.8], [hx - 1.2, hy + 1.8]], m.skinLit, m.edge, 0.5);
  poly(ctx, [[hx - 2.3, hy - 0.6], [hx - 2.0, hy - 2.7], [hx + 0.2, hy - 3.3], [hx + 2.2, hy - 2.2], [hx + 2.0, hy - 0.5]], m.armorShade, m.edge, 0.55);
  // 反光战术护目镜（青蓝玻璃点睛）
  poly(ctx, [[hx - 0.2, hy - 1.4], [hx + 2.1, hy - 1.4], [hx + 2.1, hy - 0.4], [hx - 0.2, hy - 0.4]], m.glassLit);
  // 紧凑现代黑色突击步枪（带瞄准镜与弹匣）
  strokeSeg(ctx, -0.4 + lean, -12.0, 9.2, -13.0, m.edge, 2.2);
  strokeSeg(ctx, -0.4 + lean, -12.0, 9.2, -13.0, m.gunDark, 1.3);
  strokeSeg(ctx, 4.4, -12.4, 5.2, -9.8, m.gunDark, 1.2);
  strokeSeg(ctx, 2.4, -13.4, 4.6, -13.6, m.steelMid, 0.9);
  ctx.restore();
}

/** 现代军用战术越野摩托 + 前倾骑手（大轮距双越野胎 + 斜前叉 + 高前挡泥板 + 阵营油箱 + 战术头盔护目镜与背枪） */
function drawMilitaryMotorcycle(
  ctx: CanvasRenderingContext2D,
  pal: TeamClothPalette,
  m: Era6Mat,
  withAntenna: boolean,
): void {
  drawShadow(ctx, 0.2, 0.9, 9.6, 2.7);

  // 尾部细长战术通信鞭状天线（信息化快反小队标识）
  if (withAntenna) {
    strokeSeg(ctx, -7.4, -7.0, -9.2, -15.2, m.steelLit, 0.85);
    ctx.beginPath();
    ctx.arc(-9.2, -15.6, 0.75, 0, Math.PI * 2);
    ctx.fillStyle = m.cyanGlow;
    ctx.fill();
  }

  // 后轮 + 前轮（刻意留出充足底盘镂空与轮距，1× 一眼认出双轮摩托车！）
  for (const [wx, wy] of [[-6.0, -2.6], [6.4, -2.5]] as const) {
    ctx.beginPath();
    ctx.arc(wx, wy, 3.1, 0, Math.PI * 2);
    ctx.fillStyle = m.gunDark;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.65;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(wx, wy, 1.55, 0, Math.PI * 2);
    ctx.fillStyle = m.steelLit;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(wx, wy, 0.65, 0, Math.PI * 2);
    ctx.fillStyle = m.gunDark;
    ctx.fill();
  }

  // 银色斜上翘排气管 + 中置发动机缸体
  strokeSeg(ctx, -1.6, -2.4, -7.8, -5.0, m.edge, 2.1);
  strokeSeg(ctx, -1.6, -2.4, -7.8, -5.0, m.steelLit, 1.15);
  poly(ctx, [[-2.4, -5.4], [2.2, -5.4], [2.0, -2.2], [-2.2, -2.2]], m.gunMid, m.edge, 0.52);
  strokeSeg(ctx, -1.4, -4.2, 1.4, -4.2, m.steelMid, 0.65);

  // 上翘尾翼与军用后挡泥板 + 尾箱架
  poly(ctx, [[-9.4, -7.2], [-4.2, -7.4], [-2.0, -5.8], [-5.8, -5.2]], m.armorMid, m.edge, 0.58);
  poly(ctx, [[-8.6, -7.2], [-4.8, -7.3], [-4.2, -6.4], [-7.8, -6.3]], pal.shade);

  // 标志性「倾斜伸缩前叉 + 高位越野前挡泥板」
  strokeSeg(ctx, 3.0, -9.8, 6.4, -2.5, m.edge, 2.3);
  strokeSeg(ctx, 3.0, -9.8, 4.9, -5.8, m.gunDark, 1.4);
  strokeSeg(ctx, 4.7, -6.2, 6.4, -2.5, m.steelLit, 1.15);
  poly(ctx, [[4.2, -6.8], [8.8, -6.4], [10.0, -5.2], [5.2, -5.4]], pal.mid, m.edge, 0.55);

  // 醒目阵营色流线油箱与车体侧护板
  poly(ctx, [[-2.4, -6.2], [0.4, -8.8], [3.6, -8.4], [3.4, -6.0], [-0.6, -5.4]], pal.mid, m.edge, 0.62);
  poly(ctx, [[-1.6, -6.8], [0.6, -8.6], [3.2, -8.2], [1.2, -6.8]], pal.lit);

  // 车头灯罩、发光战术大灯、小蓝风挡与手把
  poly(ctx, [[3.2, -10.4], [5.2, -9.6], [4.6, -7.6], [2.8, -8.2]], m.armorShade, m.edge, 0.55);
  poly(ctx, [[3.0, -10.4], [4.4, -11.4], [5.0, -9.8], [3.6, -9.6]], m.glassLit, m.edge, 0.45);
  ctx.beginPath();
  ctx.arc(5.1, -8.7, 0.9, 0, Math.PI * 2);
  ctx.fillStyle = m.whiteTop;
  ctx.fill();
  strokeSeg(ctx, 1.8, -10.4, 3.6, -9.8, m.gunDark, 1.25);

  // 骑手背负的现代突击步枪（枪口斜探出左肩上方，强化步兵武装识别）
  strokeSeg(ctx, -4.4, -15.6, 0.8, -9.2, m.edge, 2.2);
  strokeSeg(ctx, -4.4, -15.6, 0.8, -9.2, m.gunDark, 1.25);
  strokeSeg(ctx, -2.6, -13.4, -4.0, -12.0, m.gunDark, 1.0);

  // 前倾骑姿的现代战术骑手（护膝腿 + 脚踏战靴 + 战术背心 + 阵营肩饰）
  poly(ctx, [[-3.2, -6.8], [-0.4, -6.6], [0.8, -4.8], [-0.4, -2.2], [-2.0, -2.4], [-1.0, -4.8]], m.armorShade, m.edge, 0.52);
  poly(ctx, [[-2.0, -2.6], [-0.2, -2.4], [0.4, -1.2], [-1.8, -1.2]], m.gunDark);
  // 前倾躯干 + 阵营肩带
  poly(ctx, [[-3.4, -6.8], [-0.8, -12.6], [2.4, -11.8], [0.2, -6.2]], m.armorMid, m.edge, 0.58);
  poly(ctx, [[-2.8, -7.2], [-0.6, -12.2], [0.8, -11.8], [-1.2, -7.0]], m.armorLit);
  poly(ctx, [[-1.0, -12.4], [2.2, -11.6], [1.6, -9.8], [-1.6, -10.6]], pal.mid);
  // 前伸握把双臂
  strokeSeg(ctx, 0.6, -11.4, 3.0, -10.0, m.edge, 2.2);
  strokeSeg(ctx, 0.6, -11.4, 3.0, -10.0, m.armorLit, 1.25);

  // 战术头盔 + 反光蔚蓝护目镜
  const hx = 1.2;
  const hy = -14.4;
  poly(ctx, [[hx - 1.4, hy - 0.8], [hx + 1.5, hy - 0.8], [hx + 1.3, hy + 1.5], [hx - 1.2, hy + 1.5]], m.skinLit, m.edge, 0.45);
  poly(ctx, [
    [hx - 2.4, hy - 0.2], [hx - 2.0, hy - 2.6], [hx + 0.4, hy - 3.1],
    [hx + 2.4, hy - 1.9], [hx + 2.0, hy - 0.2],
  ], m.armorShade, m.edge, 0.55);
  poly(ctx, [[hx - 1.6, hy - 2.2], [hx + 0.4, hy - 2.7], [hx + 1.4, hy - 1.8], [hx - 0.8, hy - 1.4]], m.armorLit);
  poly(ctx, [[hx + 0.0, hy - 1.2], [hx + 2.2, hy - 1.2], [hx + 2.1, hy - 0.1], [hx + 0.0, hy - 0.1]], m.glassLit);
}

/* =========================================================================
   1. 摩托化步兵（ct_infantry · 340 金 · 攻 55 · 射程 5）：
   双车错位冲锋编队的现代军用战术越野摩托小队（1× 轻快双轮轮廓，与侦察车/卡车显著区隔）
   ========================================================================= */
function paintCtInfantry(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后左僚车（带战术通信鞭状天线）
  ctx.save();
  ctx.translate(-3.8, -3.6);
  ctx.scale(0.84, 0.84);
  drawMilitaryMotorcycle(ctx, pal, m, true);
  ctx.restore();

  // 前右领衔突击摩托
  ctx.save();
  ctx.translate(2.6, 2.4);
  ctx.scale(0.96, 0.96);
  drawMilitaryMotorcycle(ctx, pal, m, false);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   2. 中型坦克（ct_tank · 450 金 · 攻 66 · 甲 12 · 血 96 · 射程 5）：
   现代低矮宽体主战坦克（MBT）——全覆装甲裙板 + 尖锐楔形复合装甲炮塔 + 热成像观瞄 + 中置抽烟筒长滑膛炮
   ========================================================================= */
function paintCtTank(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 0.8, 2.0, 14.4, 5.2);

  // 低矮宽阔履带底盘（带现代化全覆装甲侧裙，与二战外露圆轮坦克截然不同！）
  poly(ctx, [[-13.0, -0.6], [11.2, -4.2], [13.8, -1.2], [11.4, 2.2], [-10.8, 4.4], [-13.8, 1.6]], m.gunDark, m.edge, 0.72);
  // 现代矩形复合装甲侧裙板（遮住上半负重轮）
  poly(ctx, [[-13.0, -2.8], [11.2, -5.8], [13.6, -2.4], [11.2, -0.2], [-11.8, 1.8]], m.armorMid, m.edge, 0.68);
  // 反应装甲块竖缝线
  for (let i = 0; i < 5; i++) {
    const t = (i + 0.5) / 5;
    strokeSeg(ctx, -11.4 + t * 21.6, -2.6 - t * 2.8, -10.8 + t * 21.6, 1.2 - t * 1.8, m.armorShade, 0.65);
  }
  // 侧裙醒目阵营战术斜徽
  poly(ctx, [[-3.8, -3.4], [1.8, -4.1], [0.6, -0.4], [-5.0, 0.3]], pal.mid);
  poly(ctx, [[-3.4, -3.3], [-0.4, -3.7], [-1.4, -0.3], [-4.4, 0.1]], pal.lit);

  // 低平锐利车体前斜甲
  poly(ctx, [[-12.6, -2.8], [-5.2, -8.4], [10.4, -8.2], [13.8, -3.2], [10.6, -4.6], [-11.4, -2.4]], m.armorLit, m.edge, 0.65);

  // 标志性「现代锐角楔形复合装甲炮塔」（明显扁宽尖锐于二战圆炮塔！）
  poly(ctx, [[-8.0, -6.4], [-6.8, -11.4], [2.4, -12.0], [8.0, -9.2], [4.6, -5.4], [-6.6, -4.6]], m.armorMid, m.edge, 0.72);
  poly(ctx, [[-6.6, -11.2], [2.4, -11.8], [7.2, -9.4], [-4.8, -8.8]], m.armorLit);
  poly(ctx, [[2.4, -11.8], [7.8, -9.2], [4.6, -5.6], [1.4, -8.6]], m.armorShade);
  // 炮塔阵营识别条 + 车长独立热成像观瞄塔（青色光学镜头）
  poly(ctx, [[-7.2, -8.6], [5.8, -9.4], [6.4, -7.8], [-7.0, -7.0]], pal.mid);
  poly(ctx, [[-4.0, -11.6], [-3.6, -14.2], [-0.8, -14.2], [-0.4, -11.6]], m.steelMid, m.edge, 0.5);
  poly(ctx, [[-2.0, -13.6], [-0.6, -13.6], [-0.6, -12.4], [-2.0, -12.4]], m.cyanGlow);
  // 现代双细鞭天线
  strokeSeg(ctx, -6.2, -11.0, -8.4, -21.4, m.gunDark, 0.7);
  strokeSeg(ctx, -4.8, -11.2, -6.4, -20.2, m.gunDark, 0.6);

  // 标志性「中置抽烟装置超长滑膛炮管」（无二战 T 形制退器，一眼现代主战坦克！）
  strokeSeg(ctx, 6.2, -9.2, 20.6, -12.6, m.edge, 3.1);
  strokeSeg(ctx, 6.2, -9.2, 20.6, -12.6, m.armorMid, 2.0);
  strokeSeg(ctx, 6.6, -9.7, 20.0, -12.9, m.armorLit, 0.7);
  // 中置圆筒抽烟装置（Bore Evacuator）
  strokeSeg(ctx, 11.4, -10.5, 14.4, -11.2, m.edge, 4.2);
  strokeSeg(ctx, 11.4, -10.5, 14.4, -11.2, m.steelMid, 3.0);

  ctx.restore();
}

/* =========================================================================
   3. 榴弹炮（ct_howitzer · 360 金 · 攻 55 · 射程 6 · 溅射 2）：
   现代重型履带自行榴弹炮（SPH）——重履带底盘 + 标志性后置高大方正炮塔 + 超长高仰角 155mm 巨炮
   ========================================================================= */
function paintCtHowitzer(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 0.6, 2.0, 14.0, 5.0);

  // 后置双驻锄 + 重履带底盘
  strokeSeg(ctx, -11.6, 0.2, -14.8, 3.2, m.gunDark, 2.2);
  poly(ctx, [[-12.6, -0.8], [10.8, -4.4], [13.2, -1.4], [10.8, 2.2], [-10.4, 4.2], [-13.2, 1.4]], m.gunDark, m.edge, 0.72);
  poly(ctx, [[-12.2, -2.8], [-4.8, -8.2], [10.4, -7.8], [13.0, -2.8], [10.2, -1.2], [-11.2, 1.2]], m.armorMid, m.edge, 0.7);
  poly(ctx, [[-11.8, -3.0], [-4.8, -8.0], [10.0, -7.6], [8.0, -4.6], [-9.6, -2.2]], m.armorLit);
  // 前置驾驶舱蓝窗与阵营识色条
  poly(ctx, [[5.4, -6.4], [9.2, -6.8], [10.2, -5.0], [6.4, -4.6]], m.glassLit, m.edge, 0.45);
  poly(ctx, [[1.6, -3.8], [7.8, -4.6], [7.4, -2.4], [1.2, -1.6]], pal.mid);

  // 标志性「后置高大方正自行火炮炮塔」（刻意偏后且方正高大，一眼区别于居中低矮的主战坦克！）
  poly(ctx, [[-11.8, -4.2], [-11.4, -14.6], [-0.4, -15.2], [1.4, -5.4], [-10.2, -3.6]], m.armorMid, m.edge, 0.72);
  poly(ctx, [[-11.2, -14.4], [-5.2, -17.0], [2.4, -16.6], [-0.4, -15.0]], m.armorLit, m.edge, 0.62);
  poly(ctx, [[-11.6, -11.0], [0.2, -11.6], [0.6, -9.2], [-11.4, -8.6]], pal.mid);
  poly(ctx, [[-11.4, -10.9], [-5.2, -11.2], [-5.0, -9.0], [-11.2, -8.7]], pal.lit);
  // 炮塔侧无线电天线
  strokeSeg(ctx, -9.8, -14.8, -11.2, -23.6, m.gunDark, 0.75);

  // 标志性「超长高仰角 155mm 榴弹重炮管」（几乎贯通整个格宽直指高空，射程 6 辨识度拉满！）
  strokeSeg(ctx, -1.6, -12.6, 17.6, -25.4, m.edge, 4.0);
  strokeSeg(ctx, -1.6, -12.6, 17.6, -25.4, m.armorMid, 2.7);
  strokeSeg(ctx, -1.2, -13.2, 17.0, -25.8, m.armorLit, 0.9);
  // 中段抽烟筒 + 现代双室炮口制退器
  strokeSeg(ctx, 6.4, -18.0, 9.2, -19.8, m.steelMid, 3.6);
  poly(ctx, [[16.2, -25.8], [19.2, -27.8], [20.4, -26.0], [17.4, -24.0]], m.gunDark, m.edge, 0.55);

  ctx.restore();
}

/* =========================================================================
   4. 装甲侦察车（ct_recon · 320 金 · 移 4 · 攻 38 · 射程 4）：
   现代八轮（近侧 4 轮）船形斜甲侦察车 + 顶置机关炮塔 + 标志性高升光电雷达侦察桅杆（青光传感器）
   ========================================================================= */
function paintCtRecon(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 0.8, 1.8, 13.4, 4.6);

  // 现代船形棱角轮式装甲车体（LAV / Stryker 现代构型，与一战方盒装甲车迥然不同！）
  poly(ctx, [
    [-12.2, -3.2], [-9.8, -9.2], [4.6, -9.6], [13.4, -5.6],
    [11.8, -1.4], [-10.6, 0.8],
  ], m.armorMid, m.edge, 0.72);
  poly(ctx, [[-9.6, -9.0], [-3.2, -11.4], [7.2, -11.0], [12.8, -5.8], [4.6, -9.4]], m.armorLit, m.edge, 0.58);
  // 车首蓝色装甲观察窗 + 车身醒目阵营条
  poly(ctx, [[5.4, -9.4], [9.4, -8.2], [8.8, -6.8], [5.0, -7.8]], m.glassLit, m.edge, 0.45);
  poly(ctx, [[-11.2, -6.2], [8.6, -7.2], [9.6, -5.2], [-10.8, -4.2]], pal.mid);
  poly(ctx, [[-11.0, -6.1], [-1.8, -6.6], [-1.6, -4.8], [-10.7, -4.3]], pal.lit);

  // 近侧四枚等距现代重型越野大胎（8×8 标志性特征！）
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const wx = -8.4 + t * 17.6;
    const wy = 1.0 - t * 2.0;
    ctx.beginPath();
    ctx.arc(wx, wy, 2.75, 0, Math.PI * 2);
    ctx.fillStyle = m.gunDark;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.68;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(wx, wy, 1.25, 0, Math.PI * 2);
    ctx.fillStyle = m.steelMid;
    ctx.fill();
  }

  // 低矮现代 30mm 机关炮塔 + 标志性「高升光电雷达侦察桅杆（发光青蓝镜头）」
  poly(ctx, [[-4.8, -9.4], [-3.6, -13.6], [3.4, -13.8], [5.2, -9.6]], m.armorLit, m.edge, 0.62);
  strokeSeg(ctx, 4.4, -11.6, 13.8, -13.6, m.edge, 2.4);
  strokeSeg(ctx, 4.4, -11.6, 13.8, -13.6, m.gunDark, 1.35);

  // 高挑伸缩侦察光电桅杆 + 迷你雷达横条（1× 一眼认出侦察车！）
  strokeSeg(ctx, -3.2, -13.4, -3.2, -24.4, m.edge, 2.0);
  strokeSeg(ctx, -3.2, -13.4, -3.2, -24.4, m.steelLit, 1.15);
  poly(ctx, [[-5.4, -26.4], [-0.4, -26.4], [-0.4, -23.0], [-5.4, -23.0]], m.whiteLit, m.edge, 0.55);
  // 发光青色光电侦察镜头
  poly(ctx, [[-2.6, -25.8], [-0.6, -25.8], [-0.6, -23.8], [-2.6, -23.8]], m.cyanGlow);
  strokeSeg(ctx, -6.2, -27.2, 0.2, -27.2, pal.lit, 1.15);

  ctx.restore();
}

/* =========================================================================
   5. 物流中心（ct_logistics · 300 金 · 移 2 · 经济）：
   现代平头重型集装箱货运卡车（银白车头蓝玻璃 + 醒目波纹阵营标准集装箱货柜）
   ========================================================================= */
function paintCtLogistics(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 0.8, 2.0, 14.0, 4.8);

  // 重卡底盘梁
  poly(ctx, [[-13.0, -1.6], [12.4, -4.4], [12.8, -1.6], [-12.6, 1.4]], m.gunDark, m.edge, 0.65);

  // 标志性「标准长方波纹阵营集装箱货柜」（1× 一眼识别现代物流重卡！）
  // 集装箱顶面
  poly(ctx, [[-13.6, -12.6], [-5.6, -16.4], [7.6, -15.6], [3.0, -11.4]], pal.lit, m.edge, 0.65);
  // 集装箱侧面
  poly(ctx, [[-13.6, -12.6], [3.0, -11.4], [3.0, -2.0], [-13.6, -0.6]], pal.mid, m.edge, 0.7);
  // 集装箱白色物流条与竖向波纹筋
  poly(ctx, [[-13.4, -7.8], [2.8, -7.2], [2.8, -5.2], [-13.4, -5.8]], m.whiteTop);
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    strokeSeg(ctx, -13.6 + t * 16.6, -12.4 + t * 1.2, -13.6 + t * 16.6, -1.0 - t * 1.2, pal.shade, 0.6);
  }

  // 现代洁净银白平头重卡车头 + 宽阔蔚蓝风挡玻璃 + 橙色示廓灯
  poly(ctx, [[3.6, -12.2], [11.6, -11.8], [13.4, -7.0], [13.4, -2.6], [3.6, -2.0]], m.whiteLit, m.edge, 0.7);
  poly(ctx, [[3.6, -12.2], [8.2, -14.4], [12.6, -13.8], [11.6, -11.8]], m.whiteTop, m.edge, 0.58);
  // 蔚蓝驾驶室全景玻璃
  poly(ctx, [[6.4, -11.0], [11.4, -10.8], [12.4, -7.4], [6.4, -7.4]], m.glassLit, m.edge, 0.5);
  poly(ctx, [[10.8, -5.4], [13.2, -5.4], [13.2, -4.2], [10.8, -4.2]], m.amber);

  // 三枚重卡轮胎（双后轮 + 前轮）
  for (const [wx, wy] of [[-10.2, 1.0], [-5.2, 0.4], [9.6, -1.4]] as const) {
    ctx.beginPath();
    ctx.arc(wx, wy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = m.gunDark;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(wx, wy, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = m.whiteLit;
    ctx.fill();
  }

  ctx.restore();
}

/* =========================================================================
   6. 工程兵（ct_sapper · 300 金 · 移 2 · 建造者）：
   现代军用工程挖掘/折叠液压吊臂车（洁净银白+安全橙+阵营条）+ 手持战术平板的现代工兵
   ========================================================================= */
function paintCtSapper(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后左站立手持发光平板的现代工程兵
  ctx.save();
  ctx.translate(-7.0, -1.6);
  ctx.scale(0.86, 0.86);
  drawModernTrooper(ctx, pal, m, false);
  // 发光蓝屏战术平板
  poly(ctx, [[1.8, -13.2], [5.4, -14.2], [5.8, -10.8], [2.2, -9.8]], m.cyanGlow, m.gunDark, 0.7);
  ctx.restore();

  // 现代履带式液压工程挖掘/吊臂车（显著区别于时代 5 纯推土机！）
  drawShadow(ctx, 2.2, 1.8, 11.2, 4.2);
  poly(ctx, [[-5.6, -0.8], [6.6, -3.0], [8.0, -0.2], [6.6, 2.2], [-4.8, 3.8], [-6.6, 1.4]], m.gunDark, m.edge, 0.68);
  poly(ctx, [[-5.2, -0.2], [6.2, -2.2], [7.0, -0.2], [6.0, 1.4], [-4.4, 2.8], [-5.6, 1.0]], m.gunMid);

  // 旋转银白+战术灰机身 + 蓝玻璃全景驾驶室 + 阵营醒目条
  poly(ctx, [[-5.4, -2.2], [-5.2, -9.6], [5.8, -10.4], [6.6, -3.2], [-4.6, -0.8]], m.whiteLit, m.edge, 0.68);
  poly(ctx, [[-5.2, -9.6], [-0.4, -11.6], [6.8, -11.4], [5.8, -10.2]], m.whiteTop, m.edge, 0.55);
  poly(ctx, [[-4.8, -5.6], [5.8, -6.4], [6.0, -4.4], [-4.8, -3.6]], pal.mid);
  // 全景蓝玻璃驾驶舱 + 橙色警示灯
  poly(ctx, [[-4.4, -9.6], [-4.2, -14.6], [1.4, -15.0], [1.6, -9.8]], m.glassLit, m.edge, 0.6);
  poly(ctx, [[-4.8, -14.6], [1.8, -15.0], [1.8, -13.8], [-4.8, -13.4]], m.whiteTop, m.edge, 0.5);
  ctx.beginPath();
  ctx.arc(-1.4, -15.6, 1.05, 0, Math.PI * 2);
  ctx.fillStyle = m.amber;
  ctx.fill();

  // 标志性「折弯高举液压工程大臂 + 钢齿挖斗」（1× 一眼认出工程车！）
  strokeSeg(ctx, 2.8, -8.8, 9.2, -21.2, m.edge, 3.4);
  strokeSeg(ctx, 2.8, -8.8, 9.2, -21.2, m.amber, 2.1);
  strokeSeg(ctx, 9.2, -21.2, 14.4, -11.8, m.edge, 3.0);
  strokeSeg(ctx, 9.2, -21.2, 14.4, -11.8, m.amber, 1.8);
  // 液压油缸细杆
  strokeSeg(ctx, 5.2, -8.2, 8.8, -16.8, m.steelLit, 1.0);
  // 钢齿工程挖斗
  poly(ctx, [[12.6, -12.0], [16.4, -11.2], [15.4, -7.0], [11.6, -8.4]], m.gunMid, m.edge, 0.6);
  poly(ctx, [[11.6, -8.4], [15.4, -7.0], [13.2, -6.0]], m.steelLit, m.edge, 0.45);

  ctx.restore();
}

/* =========================================================================
   7. 混凝土碉堡（ct_pillbox · 370 金 · 甲 13 · 血 88 · 射程 5）：
   现代洁净银白斜切六角防弹堡 + 蓝玻璃装甲观察窗 + 顶置遥控双联自动炮塔与微型雷达碟（锁定西北受光）
   ========================================================================= */
function paintCtPillbox(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.8, 1.4], [5.8, -4.6], [16.0, 1.2], [1.6, 6.8]], 'rgba(20, 25, 30, 0.36)');

  // 现代银白斜切重装甲混凝土底座（干净锐利，区别于时代 5 粗粝二战碉堡）
  poly(ctx, [[-12.8, 0.2], [-7.4, -4.6], [7.4, -4.6], [12.8, 0.2], [7.4, 5.0], [-7.4, 5.0]], m.whiteShade, m.edge, 0.7);
  poly(ctx, [[-12.2, -0.2], [-10.0, -9.8], [-5.8, -6.4], [-7.0, 4.6]], m.whiteLit, m.edge, 0.7);
  poly(ctx, [[-7.0, 4.6], [-5.8, -6.4], [5.8, -6.4], [7.0, 4.6]], m.whiteMid, m.edge, 0.7);
  poly(ctx, [[7.0, 4.6], [5.8, -6.4], [10.0, -9.8], [12.2, -0.2]], m.whiteShade, m.edge, 0.7);
  poly(ctx, [[-10.4, -9.8], [-5.8, -13.8], [5.8, -13.8], [10.4, -9.8], [6.0, -6.2], [-6.0, -6.2]], m.whiteTop, m.edge, 0.72);

  // 蔚蓝防弹观察条 + 阵营现代条纹
  poly(ctx, [[-4.8, -3.6], [4.8, -3.6], [4.8, -1.6], [-4.8, -1.6]], m.glassMid, m.gunDark, 0.6);
  poly(ctx, [[-4.6, -3.4], [0.6, -3.4], [0.6, -1.8], [-4.6, -1.8]], m.cyanGlow);
  poly(ctx, [[-6.4, 1.6], [6.4, 1.6], [6.6, 3.4], [-6.6, 3.4]], pal.mid);
  poly(ctx, [[-6.4, 1.6], [0.0, 1.6], [0.0, 3.4], [-6.6, 3.4]], pal.lit);

  // 标志性「顶置遥控双联自动炮塔 + 微型旋转雷达碟」（信息化时代核心标志！）
  poly(ctx, [[-4.6, -10.2], [-4.2, -15.4], [4.2, -15.4], [4.6, -10.2]], m.armorMid, m.edge, 0.65);
  poly(ctx, [[-4.4, -10.4], [-4.0, -15.2], [0.4, -15.2], [0.2, -10.4]], m.armorLit);
  poly(ctx, [[-4.2, -15.4], [0.0, -17.2], [4.2, -15.4], [0.0, -13.8]], m.whiteLit, m.edge, 0.55);
  // 双联长速射机炮管
  strokeSeg(ctx, 3.4, -13.4, 13.8, -15.4, m.edge, 2.5);
  strokeSeg(ctx, 3.4, -13.4, 13.8, -15.4, m.gunDark, 1.45);
  strokeSeg(ctx, 3.6, -11.8, 13.4, -13.6, m.edge, 2.5);
  strokeSeg(ctx, 3.6, -11.8, 13.4, -13.6, m.gunDark, 1.45);
  // 炮塔后方小型旋转白色搜索雷达
  strokeSeg(ctx, -2.0, -16.4, -2.0, -21.2, m.steelLit, 1.1);
  poly(ctx, [[-5.6, -22.2], [1.6, -22.2], [0.8, -20.0], [-4.8, -20.0]], m.whiteTop, m.edge, 0.55);
  strokeSeg(ctx, -4.4, -21.1, 0.4, -21.1, pal.lit, 0.85);
}

/* =========================================================================
   8. 产业园（ct_industrial · 420 金 · 经济建筑 · 甲 9）：
   E6 同源洁净现代科技园——翡翠绿地 + 蔚蓝玻璃幕墙研发大厦 + 蓝光伏太阳能展馆 + 零烟囱清洁能源感（锁定西北受光）
   ========================================================================= */
function paintCtIndustrial(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.8, 1.4], [5.0, -5.2], [15.8, 1.2], [1.4, 6.8]], 'rgba(20, 25, 30, 0.32)');

  // 现代银白洁净园区底座 + 翡翠生态绿化带
  poly(ctx, [[-13.0, 0.0], [0.0, -6.4], [13.0, 0.0], [0.0, 6.0]], m.whiteShade, m.edge, 0.68);
  poly(ctx, [[-12.2, 0.0], [0.0, -5.8], [12.2, 0.0], [0.0, 5.2]], m.whiteTop);
  poly(ctx, [[-11.2, 0.2], [-4.6, -3.0], [-1.4, -1.4], [-8.0, 1.8]], m.greenPark);

  // 后右拔地而起的「现代蔚蓝全玻璃幕墙科技主楼」（直接呼应 E6 摩天大都会！）
  poly(ctx, [[-1.6, -4.6], [-1.6, -24.8], [4.6, -21.8], [4.6, -1.6]], m.glassLit, m.edge, 0.68);
  poly(ctx, [[4.6, -1.6], [4.6, -21.8], [10.4, -24.6], [10.4, -4.6]], m.glassShade, m.edge, 0.68);
  poly(ctx, [[-1.6, -24.8], [4.4, -27.6], [10.4, -24.6], [4.6, -21.8]], m.whiteTop, m.edge, 0.62);
  // 玻璃幕墙细银横格线与顶部阵营企业铭牌带
  for (let i = 1; i <= 4; i++) {
    const dy = i * 4.2;
    strokeSeg(ctx, -1.4, -24.6 + dy, 4.4, -21.8 + dy, 'rgba(235, 246, 255, 0.55)', 0.55);
    strokeSeg(ctx, 4.8, -21.8 + dy, 10.2, -24.4 + dy, 'rgba(180, 210, 232, 0.4)', 0.55);
  }
  poly(ctx, [[-1.6, -24.8], [4.6, -21.8], [4.6, -19.8], [-1.6, -22.8]], pal.mid);
  poly(ctx, [[4.6, -21.8], [10.4, -24.6], [10.4, -22.6], [4.6, -19.8]], pal.shade);

  // 左前标志性「太阳能蓝光伏斜顶现代展馆/车间」（零烟囱高科技制造特征！）
  poly(ctx, [[-10.4, -0.4], [-10.4, -7.8], [-1.0, -3.4], [-1.0, 4.0]], m.whiteLit, m.edge, 0.65);
  poly(ctx, [[-1.0, 4.0], [-1.0, -3.4], [5.4, -6.6], [5.4, 0.8]], m.whiteShade, m.edge, 0.65);
  // 整面蔚蓝太阳能光伏屋顶网格
  poly(ctx, [[-11.0, -7.6], [-4.2, -13.4], [5.8, -8.6], [-0.8, -3.0]], m.glassMid, m.edge, 0.68);
  strokeSeg(ctx, -7.6, -10.5, 2.2, -5.8, m.cyanGlow, 0.6);
  strokeSeg(ctx, -7.8, -5.4, -1.4, -11.0, m.cyanGlow, 0.55);
  strokeSeg(ctx, -4.4, -3.8, 2.0, -9.4, m.cyanGlow, 0.55);
  // 现代玻璃大门
  poly(ctx, [[-7.2, 1.0], [-7.2, -2.6], [-3.8, -1.0], [-3.8, 2.6]], m.glassLit, m.edge, 0.5);
}

/* =========================================================================
   9. 联合作战中心（camp6 · 380 金 · 甲 10 · 血 92 · 产兵 + 自动攻击）：
   E6 同源洁净银白指挥大楼 + 标志性白色球形卫星雷达罩（Radome）+ 醒目 H 停机坪 + 通信天线（锁定西北受光）
   ========================================================================= */
function paintCamp6(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-13.2, 1.4], [2.4, -6.4], [15.6, 1.0], [0.8, 7.2]], 'rgba(20, 25, 30, 0.34)');

  // 现代银白八角作战中心基坪 + 沥青停机坪
  poly(ctx, [[-13.2, -0.2], [0.0, -6.8], [13.2, -0.2], [0.0, 6.0]], m.whiteShade, m.edge, 0.7);
  poly(ctx, [[-12.4, -0.2], [0.0, -6.2], [12.4, -0.2], [0.0, 5.4]], m.whiteTop);

  // 右前标志性「现代 H 直升机停机坪」（直接呼应 E6 城市风格！）
  poly(ctx, [[-1.2, 1.6], [4.6, -1.2], [10.4, 1.6], [4.6, 4.4]], m.asphalt, m.whiteShade, 0.55);
  ctx.beginPath();
  ctx.ellipse(4.6, 1.6, 3.6, 1.8, 0, 0, Math.PI * 2);
  ctx.strokeStyle = m.amber;
  ctx.lineWidth = 0.85;
  ctx.stroke();
  strokeSeg(ctx, 3.4, 0.8, 3.4, 2.4, m.whiteTop, 0.85);
  strokeSeg(ctx, 5.8, 0.8, 5.8, 2.4, m.whiteTop, 0.85);
  strokeSeg(ctx, 3.4, 1.6, 5.8, 1.6, m.whiteTop, 0.85);

  // 后左现代银白+蓝玻璃幕墙指挥主楼
  poly(ctx, [[-10.8, -1.0], [-10.8, -11.4], [-2.0, -7.2], [-2.0, 3.0]], m.whiteLit, m.edge, 0.7);
  poly(ctx, [[-2.0, 3.0], [-2.0, -7.2], [4.6, -10.4], [4.6, -0.4]], m.whiteShade, m.edge, 0.7);
  poly(ctx, [[-10.8, -11.4], [-4.2, -14.6], [4.6, -10.4], [-2.0, -7.2]], m.whiteTop, m.edge, 0.68);
  // 指挥主楼蓝玻璃全景指挥窗 + 醒目阵营条
  poly(ctx, [[-9.6, -8.8], [-3.2, -5.8], [-3.2, -3.2], [-9.6, -6.2]], m.glassLit, m.edge, 0.48);
  poly(ctx, [[-10.6, -10.6], [-2.2, -6.6], [-2.2, -5.4], [-10.6, -9.4]], pal.mid);
  poly(ctx, [[-2.0, -6.6], [4.4, -9.8], [4.4, -8.6], [-2.0, -5.4]], pal.shade);

  // 左侧楼顶细长通信天线（蓝绿微光信标，与中间雷达球互不遮挡）
  strokeSeg(ctx, -9.2, -11.0, -9.2, -19.2, m.steelLit, 0.95);
  strokeSeg(ctx, -10.4, -15.6, -8.0, -15.6, m.steelLit, 0.65);
  ctx.beginPath();
  ctx.arc(-9.2, -19.8, 0.95, 0, Math.PI * 2);
  ctx.fillStyle = m.cyanGlow;
  ctx.fill();

  // 标志性「白色球形卫星通信雷达罩（Radome）」（1× 一眼认出信息化联合作战中心！）
  poly(ctx, [[-5.6, -12.4], [-5.6, -15.2], [-0.4, -15.2], [-0.4, -12.4]], m.whiteMid, m.edge, 0.55);
  ctx.beginPath();
  ctx.arc(-3.0, -17.4, 3.8, 0, Math.PI * 2);
  ctx.fillStyle = m.whiteLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.65;
  ctx.stroke();
  // 雷达球受光高光面与细网格弧线
  ctx.beginPath();
  ctx.arc(-4.0, -18.4, 2.0, 0, Math.PI * 2);
  ctx.fillStyle = m.whiteTop;
  ctx.fill();
  strokeSeg(ctx, -6.2, -17.2, 0.2, -17.2, 'rgba(110, 128, 142, 0.45)', 0.55);

  // 右后角高耸现代旗杆（向右飘扬，与中间白色雷达罩完全分离）
  strokeSeg(ctx, 2.8, -10.8, 2.8, -22.2, m.steelLit, 1.0);
  poly(ctx, [[3.0, -22.0], [9.8, -20.8], [8.8, -19.0], [10.0, -17.4], [3.0, -18.0]], pal.mid, m.edge, 0.5);
  poly(ctx, [[3.0, -21.8], [7.2, -21.0], [6.8, -18.2], [3.0, -18.5]], pal.lit);
}

export const ERA6_UNIT_SPECS: Readonly<Record<string, Era1UnitSpec>> = {
  ct_infantry: { paint: paintCtInfantry, ringRx: 11.8, ringRy: 5.0, barY: 5.6, hitTop: 22 },
  ct_tank: { paint: paintCtTank, ringRx: 13.8, ringRy: 5.8, barY: 6.4, hitTop: 22 },
  ct_howitzer: { paint: paintCtHowitzer, ringRx: 13.6, ringRy: 5.8, barY: 6.4, hitTop: 28 },
  ct_recon: { paint: paintCtRecon, ringRx: 13.0, ringRy: 5.5, barY: 5.8, hitTop: 28 },
  ct_logistics: { paint: paintCtLogistics, ringRx: 13.6, ringRy: 5.6, barY: 6.0, hitTop: 20 },
  ct_sapper: { paint: paintCtSapper, ringRx: 12.6, ringRy: 5.4, barY: 5.8, hitTop: 24 },
  ct_pillbox: { paint: paintCtPillbox, ringRx: 13.2, ringRy: 5.8, barY: 6.4, hitTop: 25 },
  ct_industrial: { paint: paintCtIndustrial, ringRx: 13.2, ringRy: 5.8, barY: 6.4, hitTop: 30 },
  camp6: { paint: paintCamp6, ringRx: 13.4, ringRy: 5.9, barY: 6.6, hitTop: 26 },
};

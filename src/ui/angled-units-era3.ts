/**
 * 时代 3（火器时代）原版全 11 个兵种与建筑的斜俯视 3D 微缩沙盘绘制模块。
 *
 * 与时代 1（青铜）和时代 2（铁器）保持统一 4.8 头身写实微缩战棋风格与西北受光体系，同时拉开鲜明时代阶梯：
 * - 建筑全面采用与 E3 火器城池同源的冷灰花岗岩 + 青灰瓦顶 + 黑铁加农炮（炮台 / 工厂 / 堡寨 / 石桥）；
 * - 陆战进入火枪、臼炮、长戟方阵与弯刀骠骑兵时代（宽檐军帽、斜十字白背带、火绳枪、仰角臼炮、挂肩披风马刀）；
 * - 水军升级为木壳白帆加农炮艇（将全钢炮塔与烟囱铁甲舰留给时代 4）。
 */

import type { AngledUnitPaintOpts, TeamClothPalette } from './angled-units.ts';
import type { Era1UnitSpec } from './angled-units-era1.ts';

interface Era3Mat {
  edge: string;
  steelLit: string;
  steelMid: string;
  steelShade: string;
  ironDark: string;
  ironMid: string;
  brassLit: string;
  brassMid: string;
  graniteTop: string;
  graniteLit: string;
  graniteMid: string;
  graniteShade: string;
  slateLit: string;
  slateMid: string;
  slateShade: string;
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
  horseLit: string;
  horseMid: string;
  horseShade: string;
}

function getMat(dim: boolean): Era3Mat {
  return {
    edge: dim ? 'rgba(38, 38, 36, 0.64)' : 'rgba(30, 32, 34, 0.76)',
    steelLit: dim ? '#bfc5c9' : '#e1e7ec',
    steelMid: dim ? '#969da3' : '#a8b4be',
    steelShade: dim ? '#697076' : '#697784',
    ironDark: dim ? '#3f4246' : '#2d333a',
    ironMid: dim ? '#595d62' : '#4a535e',
    brassLit: dim ? '#c7c0ad' : '#e6c873',
    brassMid: dim ? '#9f9887' : '#b89643',
    graniteTop: dim ? '#b4babf' : '#c4ccd2',
    graniteLit: dim ? '#9ba2a8' : '#a5b0ba',
    graniteMid: dim ? '#848b91' : '#8b97a2',
    graniteShade: dim ? '#686e73' : '#6c7884',
    slateLit: dim ? '#7c868e' : '#738899',
    slateMid: dim ? '#656e75' : '#586b7c',
    slateShade: dim ? '#4b5258' : '#3f4f5e',
    clothLit: dim ? '#d4d1c9' : '#f1ece0',
    clothMid: dim ? '#b3afa7' : '#d2cab8',
    clothShade: dim ? '#87837c' : '#9c9484',
    leatherLit: dim ? '#857f77' : '#7d5938',
    leatherMid: dim ? '#66615a' : '#593d24',
    leatherDark: dim ? '#46433e' : '#382515',
    skinLit: dim ? '#c9bfb2' : '#e6be96',
    skinShade: dim ? '#a3998d' : '#bc8f66',
    hairDark: dim ? '#44423f' : '#2f261e',
    woodLit: dim ? '#9a9285' : '#a67b4b',
    woodMid: dim ? '#7b7368' : '#7d5934',
    woodDark: dim ? '#554f47' : '#4f361e',
    horseLit: dim ? '#8c8882' : '#6d503a',
    horseMid: dim ? '#6e6a65' : '#513928',
    horseShade: dim ? '#4d4a46' : '#352418',
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
  ctx.fillStyle = 'rgba(24, 22, 18, 0.34)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0.14, 0, Math.PI * 2);
  ctx.fill();
}

function drawLegs(ctx: CanvasRenderingContext2D, m: Era3Mat, colFront: string, colBack: string, stride = 0.88, kneel = false): void {
  if (kneel) {
    poly(ctx, [[-2.2, -5.8], [-0.4, -5.8], [-2.0, -1.8], [-3.8, -2.0]], colBack, m.edge, 0.52);
    poly(ctx, [[-3.8, -2.0], [-2.0, -1.8], [-1.3, 0.4], [-3.2, 0.3]], m.ironDark);
    poly(ctx, [[0.1, -5.6], [2.1, -5.4], [3.0, -1.8], [1.1, -2.0]], colFront, m.edge, 0.52);
    poly(ctx, [[1.1, -2.0], [3.0, -1.8], [3.5, 0.7], [1.3, 0.7]], m.ironDark);
    return;
  }
  poly(ctx, [[-2.0, -7.8], [-0.4, -7.8], [-1.2 * stride - 1.0, -2.4], [-2.6 * stride - 0.8, -2.6]], colBack, m.edge, 0.52);
  poly(ctx, [[-2.6 * stride - 0.8, -2.7], [-1.2 * stride - 1.0, -2.5], [-1.4 * stride - 1.1, 0.3], [-2.9 * stride - 1.0, 0.2]], m.ironDark);
  poly(ctx, [[0.0, -7.6], [1.9, -7.6], [2.1 * stride + 0.5, -2.2], [0.5 * stride + 0.4, -2.4]], colFront, m.edge, 0.52);
  poly(ctx, [[0.5 * stride + 0.4, -2.4], [2.1 * stride + 0.5, -2.2], [2.5 * stride + 0.5, 0.7], [0.6 * stride + 0.4, 0.7]], m.ironDark);
}

function drawFace(ctx: CanvasRenderingContext2D, m: Era3Mat, hx: number, hy: number): void {
  poly(ctx, [[hx - 0.8, hy + 2.0], [hx + 0.9, hy + 2.0], [hx + 0.9, hy + 3.0], [hx - 0.8, hy + 3.0]], m.skinShade);
  poly(ctx, [
    [hx - 1.6, hy - 1.3], [hx + 1.5, hy - 1.3], [hx + 1.7, hy + 0.5],
    [hx + 0.9, hy + 2.1], [hx - 1.1, hy + 2.1], [hx - 1.7, hy + 0.6],
  ], m.skinLit, m.edge, 0.58);
  poly(ctx, [[hx + 0.2, hy - 1.1], [hx + 1.4, hy - 1.1], [hx + 1.5, hy + 0.5], [hx + 0.8, hy + 1.9], [hx + 0.1, hy + 1.9]], m.skinShade);
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
   1. 戟兵（halberdier · 100 金 · 甲 5 · 射程 2）：
   文艺复兴/火器时代重甲长戟兵——船形翘沿铁盔（Morion）+ 亮钢半身胸甲 + 双手三刃长战戟（无盾）
   ========================================================================= */
function drawHalberdierSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era3Mat, variant: 0 | 1): void {
  drawShadow(ctx, 1.9, 0.6, 4.8, 2.0);
  drawLegs(ctx, m, m.clothMid, m.clothShade, variant === 0 ? 0.96 : 0.76);

  const lean = variant === 0 ? 0.45 : 0.15;
  // 阵营膨松战裤/裙甲
  poly(ctx, [[-2.9, -9.8], [2.7, -9.8], [3.3, -6.2], [-3.2, -6.4]], pal.mid, m.edge, 0.6);
  poly(ctx, [[-2.7, -9.6], [0.2, -9.6], [0.0, -6.4], [-3.0, -6.5]], pal.lit);
  // 亮钢半身胸甲 + 钢护肩（反光更强，区别于时代 2 札甲）
  poly(ctx, [[-2.9 + lean, -15.6], [2.6 + lean, -15.4], [2.7, -9.6], [-2.7, -9.6]], m.steelMid, m.edge, 0.68);
  poly(ctx, [[-2.7 + lean, -15.4], [0.5 + lean, -15.3], [0.3, -9.8], [-2.5, -9.8]], m.steelLit);
  poly(ctx, [[1.1 + lean, -15.2], [2.4 + lean, -15.2], [2.5, -9.8], [1.2, -9.8]], m.steelShade);
  // 胸甲斜挂阵营指挥带
  poly(ctx, [[-2.6 + lean, -15.3], [-1.0 + lean, -15.3], [2.4, -10.2], [1.0, -10.0]], pal.mid);
  poly(ctx, [[-2.8, -10.2], [2.7, -10.0], [2.7, -9.2], [-2.8, -9.4]], m.leatherDark);

  // 头部 + 标志性船形高脊铁盔（Morion，前后翘沿 + 中央高冠脊，一眼定位时代 3！）
  const hx = lean * 1.1;
  const hy = -18.0;
  drawFace(ctx, m, hx, hy);
  // 高脊盔冠
  poly(ctx, [[hx - 1.6, hy - 3.0], [hx - 0.3, hy - 4.8], [hx + 1.4, hy - 3.6], [hx + 1.8, hy - 1.4], [hx - 2.0, hy - 1.4]], m.steelMid, m.edge, 0.6);
  poly(ctx, [[hx - 1.4, hy - 2.9], [hx - 0.3, hy - 4.6], [hx + 0.3, hy - 1.6], [hx - 1.8, hy - 1.6]], m.steelLit);
  // 船形前后翘沿
  poly(ctx, [[hx - 3.6, hy - 1.8], [hx, hy - 0.6], [hx + 3.6, hy - 1.8], [hx + 2.4, hy - 0.6], [hx, hy + 0.1], [hx - 2.4, hy - 0.6]], m.steelLit, m.edge, 0.55);

  // 标志性「双手长柄战戟」（高耸直枪尖 + 前出月牙宽斧刃 + 后出尖啄钩 + 阵营戟缨）
  const gx0 = variant === 0 ? -3.2 : -2.0;
  const gy0 = variant === 0 ? -5.0 : -4.4;
  const gx1 = variant === 0 ? 5.2 : 3.8;
  const gy1 = variant === 0 ? -24.6 : -26.8;
  const dx = gx1 - gx0;
  const dy = gy1 - gy0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const pt = (u: number, n: number): readonly [number, number] => [gx1 + ux * u + nx * n, gy1 + uy * u + ny * n];

  strokeSeg(ctx, gx0, gy0, gx1, gy1, m.edge, 2.2);
  strokeSeg(ctx, gx0, gy0, gx1, gy1, m.woodDark, 1.3);
  strokeSeg(ctx, gx0 + 0.25, gy0 - 0.2, gx1 - 0.2, gy1 - 0.2, m.woodLit, 0.45);

  // 顶部细长直刺枪尖
  poly(ctx, [pt(-0.6, -0.8), pt(5.4, 0.0), pt(-0.6, 0.9)], m.steelLit, m.edge, 0.55);
  // 前出月牙战斧刃（+n 方向宽弧）
  ctx.beginPath();
  ctx.moveTo(...pt(0.2, 0.7));
  ctx.quadraticCurveTo(...pt(1.6, 3.0), ...pt(2.4, 5.2));
  ctx.quadraticCurveTo(...pt(-1.0, 6.2), ...pt(-4.2, 4.6));
  ctx.quadraticCurveTo(...pt(-2.8, 2.4), ...pt(-2.2, 0.7));
  ctx.closePath();
  ctx.fillStyle = m.steelMid;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.58;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(...pt(2.1, 4.9));
  ctx.quadraticCurveTo(...pt(-1.0, 5.9), ...pt(-3.9, 4.3));
  ctx.strokeStyle = m.steelLit;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 后出破甲尖啄钩（-n 方向）
  poly(ctx, [pt(-0.4, -0.6), pt(-1.6, -4.4), pt(-2.8, -0.8)], m.steelShade, m.edge, 0.52);
  // 戟颈红缨
  const [tx, ty] = pt(-3.2, 0);
  poly(ctx, [[tx - 0.7, ty], [tx + 1.0, ty + 0.2], [tx + 1.4, ty + 3.2], [tx - 1.1, ty + 3.0]], pal.mid, m.edge, 0.42);

  // 双手稳握戟杆
  const gripX = gx0 + dx * 0.42;
  const gripY = gy0 + dy * 0.42;
  poly(ctx, [[1.4 + lean, -14.2], [2.8 + lean, -13.6], [gripX + 0.8, gripY + 0.7], [gripX - 0.8, gripY - 0.6]], m.steelMid, m.edge, 0.5);
}

function paintHalberdier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.6, -2.7);
  ctx.scale(0.95, 0.95);
  drawHalberdierSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.3, 1.5);
  ctx.scale(1.02, 1.02);
  drawHalberdierSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   2. 火枪兵（musketeer · 130 金 · 破甲 · 射程 4）：
   宽檐三角毛毡帽 + 阵营长军大衣 + 标志性白色十字胸带 + 长管黑铁火枪（前蹲后立排队枪毙）
   ========================================================================= */
function drawMusketeerSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era3Mat, variant: 0 | 1): void {
  drawShadow(ctx, 1.8, 0.6, 4.6, 1.9);
  drawLegs(ctx, m, m.clothLit, m.clothMid, variant === 0 ? 0.92 : 0.74, variant === 0);

  const yDrop = variant === 0 ? 1.8 : 0;
  const lean = variant === 0 ? 0.85 : 0.35;
  ctx.save();
  ctx.translate(0, yDrop);

  // 经典火器时代阵营长军大衣（修身收腰 + 外展燕尾下摆）
  poly(ctx, [[-2.7, -9.8], [2.5, -9.8], [3.3, -5.6], [-3.2, -5.8]], pal.mid, m.edge, 0.62);
  poly(ctx, [[-2.5, -9.6], [0.2, -9.6], [0.0, -5.8], [-3.0, -5.9]], pal.lit);
  poly(ctx, [[-2.7 + lean, -15.3], [2.4 + lean, -15.1], [2.5, -9.6], [-2.5, -9.6]], pal.mid, m.edge, 0.65);
  poly(ctx, [[-2.5 + lean, -15.1], [0.3 + lean, -15.0], [0.1, -9.8], [-2.3, -9.8]], pal.lit);
  // 标志性「白色斜十字胸背带」（火枪线列步兵的黄金识别符号！）
  strokeSeg(ctx, -2.3 + lean, -15.1, 2.2, -9.8, m.clothLit, 1.35);
  strokeSeg(ctx, 2.1 + lean, -15.0, -2.3, -9.8, m.clothLit, 1.35);
  poly(ctx, [[-2.6, -10.3], [2.5, -10.1], [2.5, -9.3], [-2.6, -9.5]], m.clothLit);
  poly(ctx, [[-0.6, -10.2], [0.7, -10.1], [0.7, -9.3], [-0.6, -9.4]], m.brassLit);

  // 头部 + 宽檐三角军帽（Tricorne，深灰暗毡 + 阵营白边小帽饰，区别于时代 4 钢盔步枪兵！）
  const hx = lean * 1.1;
  const hy = -17.9;
  drawFace(ctx, m, hx, hy);
  poly(ctx, [
    [hx - 4.4, hy - 1.2], [hx - 2.0, hy - 3.6], [hx + 1.2, hy - 3.4],
    [hx + 4.3, hy - 1.4], [hx + 1.6, hy - 0.5], [hx - 2.0, hy - 0.5],
  ], m.ironDark, m.edge, 0.62);
  poly(ctx, [[hx - 3.9, hy - 1.3], [hx - 1.8, hy - 3.4], [hx + 0.6, hy - 3.2], [hx + 0.2, hy - 0.8], [hx - 2.0, hy - 0.8]], m.ironMid);
  // 帽檐淡金边 + 侧边小羽饰
  strokeSeg(ctx, hx - 3.8, hy - 1.2, hx + 3.8, hy - 1.4, m.clothLit, 0.55);
  poly(ctx, [[hx - 2.4, hy - 2.6], [hx - 4.0, hy - 4.4], [hx - 2.6, hy - 4.2], [hx - 1.6, hy - 2.6]], pal.lit);

  // 标志性「长管燧发火枪」（胡桃木枪托 + 细长黑铁枪管 + 黄铜枪箍 + 枪口轻白烟）
  const mx0 = -1.2 + lean;
  const my0 = -12.6;
  const mx1 = 12.8;
  const my1 = -14.2;
  // 木枪托（后半段较粗）
  strokeSeg(ctx, mx0, my0, mx0 + 6.4, my0 - 0.7, m.edge, 2.7);
  strokeSeg(ctx, mx0, my0, mx0 + 6.4, my0 - 0.7, m.woodMid, 1.65);
  // 细长黑铁枪管（前半段纤长平直，远景一眼看出火枪！）
  strokeSeg(ctx, mx0 + 4.0, my0 - 0.7, mx1, my1, m.edge, 2.1);
  strokeSeg(ctx, mx0 + 4.0, my0 - 0.7, mx1, my1, m.ironMid, 1.15);
  strokeSeg(ctx, mx0 + 4.2, my0 - 0.9, mx1 - 0.5, my1 - 0.2, m.steelLit, 0.4);
  // 两道黄铜枪箍
  strokeSeg(ctx, mx0 + 6.6, my0 - 1.2, mx0 + 6.6, my0 - 0.1, m.brassLit, 0.9);
  strokeSeg(ctx, mx0 + 10.2, my0 - 1.6, mx0 + 10.2, my0 - 0.6, m.brassLit, 0.85);
  // 枪口淡淡一小缕白色火药青烟（点睛辨识，不喧宾夺主）
  if (variant === 0) {
    ctx.fillStyle = 'rgba(242, 246, 248, 0.62)';
    ctx.beginPath();
    ctx.arc(mx1 + 1.8, my1 - 0.6, 1.5, 0, Math.PI * 2);
    ctx.arc(mx1 + 3.4, my1 - 1.5, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  // 端枪双臂
  poly(ctx, [[1.0 + lean, -14.0], [2.4 + lean, -13.4], [5.8, -12.8], [4.8, -11.7]], pal.lit, m.edge, 0.48);

  ctx.restore();
}

function paintMusketeer(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.6, -2.7);
  ctx.scale(0.95, 0.95);
  drawMusketeerSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.0, 1.5);
  ctx.scale(1.0, 1.0);
  drawMusketeerSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   3. 臼炮（mortar · 140 金 · 攻城大师 · 溅射 1 · 射程 4）：
   厚重原木炮床 + 50° 仰角粗短黑铁黄铜箍臼炮管 + 炮弹堆 + 站立点火炮手
   ========================================================================= */
function paintMortar(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 炮手（立于后左方，手举点火绳木杆）
  ctx.save();
  ctx.translate(-5.8, -1.6);
  ctx.scale(0.92, 0.92);
  drawShadow(ctx, 1.6, 0.6, 4.2, 1.8);
  drawLegs(ctx, m, m.clothMid, m.clothShade, 0.78);
  poly(ctx, [[-2.6, -15.2], [2.4, -15.0], [2.8, -6.2], [-2.8, -6.4]], pal.mid, m.edge, 0.6);
  poly(ctx, [[-2.4, -15.0], [0.3, -14.9], [0.1, -6.4], [-2.6, -6.5]], pal.lit);
  strokeSeg(ctx, -2.2, -15.0, 2.2, -9.8, m.clothLit, 1.15);
  drawFace(ctx, m, 0.2, -17.8);
  poly(ctx, [[-3.6, -19.0], [-1.6, -21.2], [1.4, -21.0], [3.6, -19.1], [0.0, -18.2]], m.ironDark, m.edge, 0.55);
  // 手举点火绳杆探向臼炮火门
  strokeSeg(ctx, 1.8, -12.6, 9.2, -16.8, m.woodLit, 1.0);
  ctx.beginPath();
  ctx.arc(9.4, -17.0, 1.15, 0, Math.PI * 2);
  ctx.fillStyle = '#e87a38';
  ctx.fill();
  ctx.restore();

  // 厚重臼炮底盘阴影
  drawShadow(ctx, 2.4, 1.4, 8.8, 3.4);

  // 厚实原木臼炮底座（无大车轮，贴地卧床式经典臼炮特征！）
  poly(ctx, [[-3.8, 0.2], [2.8, -3.0], [10.6, -0.2], [4.0, 3.0]], m.woodLit, m.edge, 0.68);
  poly(ctx, [[-3.8, 0.2], [4.0, 3.0], [4.0, 5.2], [-3.8, 2.4]], m.woodMid, m.edge, 0.65);
  poly(ctx, [[4.0, 3.0], [10.6, -0.2], [10.6, 2.0], [4.0, 5.2]], m.woodDark, m.edge, 0.65);
  // 炮床阵营识别侧板 + 铁加固箍
  poly(ctx, [[-2.4, 1.2], [3.0, 3.2], [3.0, 4.4], [-2.4, 2.4]], pal.mid);
  strokeSeg(ctx, -1.4, 0.6, -1.4, 3.0, m.ironDark, 1.1);
  strokeSeg(ctx, 2.4, 2.0, 2.4, 4.4, m.ironDark, 1.1);

  // 标志性「大口径 50° 仰角粗短黑铁臼炮管」（一眼辨出曲射攻城臼炮！）
  ctx.save();
  ctx.translate(2.4, -0.8);
  ctx.rotate(-0.82); // 昂扬仰角指向右上方
  // 粗圆球形炮尾 + 粗短炮身
  poly(ctx, [[-4.0, -3.2], [7.8, -3.6], [8.2, 3.6], [-4.0, 3.2], [-5.6, 1.6], [-5.6, -1.6]], m.ironMid, m.edge, 0.72);
  // 上半受光金属弧面
  poly(ctx, [[-4.0, -3.0], [7.6, -3.4], [7.8, -0.4], [-4.4, -0.4]], m.steelShade);
  poly(ctx, [[-3.4, -2.5], [7.2, -2.8], [7.4, -1.4], [-3.6, -1.3]], m.steelMid);
  // 两道黄铜加强箍（经典黑火药火炮质感）
  poly(ctx, [[-1.6, -3.5], [-0.2, -3.5], [-0.2, 3.5], [-1.6, 3.5]], m.brassMid, m.edge, 0.45);
  poly(ctx, [[-1.5, -3.4], [-0.3, -3.4], [-0.3, -0.2], [-1.5, -0.2]], m.brassLit);
  poly(ctx, [[5.4, -3.8], [6.8, -3.8], [6.8, 3.8], [5.4, 3.8]], m.brassMid, m.edge, 0.45);
  poly(ctx, [[5.5, -3.7], [6.7, -3.7], [6.7, -0.2], [5.5, -0.2]], m.brassLit);
  // 醒目大口径黑洞炮口
  ctx.beginPath();
  ctx.ellipse(8.1, 0, 1.6, 3.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#191d22';
  ctx.fill();
  ctx.strokeStyle = m.steelLit;
  ctx.lineWidth = 0.85;
  ctx.stroke();
  ctx.restore();

  // 炮床前脚堆叠的三枚圆黑铁炮弹（金字塔形小弹堆）
  const ball = (bx: number, by: number) => {
    ctx.beginPath();
    ctx.arc(bx, by, 1.55, 0, Math.PI * 2);
    ctx.fillStyle = m.ironDark;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.45;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx - 0.45, by - 0.45, 0.5, 0, Math.PI * 2);
    ctx.fillStyle = m.steelMid;
    ctx.fill();
  };
  ball(9.2, 2.2);
  ball(11.6, 1.6);
  ball(10.4, 0.3);

  ctx.restore();
}

/* =========================================================================
   4. 骠骑兵（hussar · 150 金 · 移 4 · 攻 26 · 甲 4）：
   迅捷深色战马 + 高筒毛帽竖羽 + 肋条盘扣军装 + 迎风飘扬挂肩短披风 + 高举弯月亮钢马刀
   （与时代 2 克制的裸马持矛骑士形成彻底的视觉代差与武器剪影区隔！）
   ========================================================================= */
function paintHussar(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  drawShadow(ctx, 1.4, 1.0, 11.4, 3.8);

  // 疾驰甩尾
  poly(ctx, [[-9.6, -11.4], [-14.2, -9.8], [-14.8, -6.8], [-12.0, -7.8], [-10.0, -9.6]], m.hairDark, m.edge, 0.55);

  // 后侧奔跑马腿
  poly(ctx, [[-8.2, -6.6], [-6.2, -6.6], [-9.2, -1.2], [-10.8, -1.6]], m.horseShade, m.edge, 0.52);
  poly(ctx, [[4.0, -6.6], [6.2, -6.6], [10.4, -3.2], [8.8, -2.0]], m.horseShade, m.edge, 0.52);

  // 矫健深棕色疾驰战马躯干 + 镶金边阵营尖角骠骑鞍毯
  poly(ctx, [
    [-9.8, -12.4], [-3.0, -13.4], [5.4, -13.0], [8.6, -10.4],
    [7.6, -6.2], [-7.8, -6.0], [-10.2, -8.8],
  ], m.horseMid, m.edge, 0.68);
  poly(ctx, [[-9.4, -12.2], [-2.8, -13.2], [5.0, -12.8], [7.2, -10.6], [5.8, -8.8], [-8.6, -9.2]], m.horseLit);
  // 尖角镶金边阵营鞍毯（Shabraque，经典轻骑兵标识）
  poly(ctx, [[-8.4, -12.4], [4.2, -12.8], [3.6, -8.2], [-6.6, -6.8], [-9.0, -9.2]], pal.mid, m.brassLit, 0.85);
  poly(ctx, [[-8.0, -12.2], [-0.8, -12.5], [-1.2, -8.2], [-6.4, -7.2], [-8.6, -9.2]], pal.lit);

  // 前侧疾驰马腿（大幅度迈步体现移速 4！）
  poly(ctx, [[-6.4, -6.2], [-4.2, -6.2], [-5.2, 0.8], [-7.2, 0.8]], m.horseLit, m.edge, 0.55);
  poly(ctx, [[4.8, -6.4], [7.0, -6.6], [11.2, -3.0], [9.4, -1.4], [7.4, 0.8], [5.8, 0.6], [7.6, -2.6]], m.horseLit, m.edge, 0.55);

  // 昂首马颈与马头
  poly(ctx, [[4.2, -12.6], [7.8, -19.2], [11.2, -18.4], [9.6, -11.4]], m.horseLit, m.edge, 0.65);
  poly(ctx, [[4.2, -12.6], [7.6, -19.0], [8.8, -18.6], [6.4, -12.2]], m.hairDark);
  poly(ctx, [[7.8, -19.2], [11.2, -18.6], [13.4, -15.2], [11.8, -14.2], [8.8, -15.8]], m.horseMid, m.edge, 0.6);
  poly(ctx, [[8.6, -19.0], [9.2, -21.2], [10.2, -19.0]], m.horseLit, m.edge, 0.45);
  strokeSeg(ctx, 11.2, -15.4, 2.2, -15.2, m.leatherDark, 0.7);

  // 飘扬的挂肩短毛边斗篷（Pelisse，骠骑兵最拉风的剪影标识！）
  poly(ctx, [[-2.0, -19.4], [-9.6, -16.8], [-8.4, -12.4], [-1.4, -14.6]], pal.shade, m.edge, 0.58);
  poly(ctx, [[-2.0, -19.2], [-9.0, -16.8], [-5.6, -14.4], [-1.4, -16.2]], pal.lit);
  strokeSeg(ctx, -9.4, -16.6, -8.3, -12.6, m.clothLit, 1.15);

  // 骠骑兵马靴、金盘扣军上衣
  poly(ctx, [[-1.6, -12.8], [1.4, -12.8], [2.2, -6.2], [-0.4, -6.2]], m.ironDark, m.edge, 0.55);
  poly(ctx, [[-2.8, -19.8], [2.5, -19.4], [2.3, -12.6], [-2.6, -12.6]], pal.mid, m.edge, 0.65);
  poly(ctx, [[-2.6, -19.6], [0.4, -19.5], [0.2, -12.8], [-2.4, -12.8]], pal.lit);
  // 胸前三道标志性金色盘扣横纹（Dolman braiding）
  strokeSeg(ctx, -1.8, -18.0, 1.8, -17.8, m.brassLit, 0.75);
  strokeSeg(ctx, -1.8, -16.3, 1.8, -16.1, m.brassLit, 0.75);
  strokeSeg(ctx, -1.8, -14.6, 1.8, -14.4, m.brassLit, 0.75);

  // 头部 + 标志性高筒黑毛帽（Busby/Shako）+ 阵营垂袋与直立羽饰
  drawFace(ctx, m, 0.4, -21.8);
  poly(ctx, [[-2.0, -22.2], [-2.2, -26.2], [2.4, -26.0], [2.1, -22.2]], m.ironDark, m.edge, 0.62);
  poly(ctx, [[-1.8, -26.0], [0.4, -25.9], [0.3, -22.4], [-1.7, -22.4]], m.ironMid);
  // 帽顶垂下的阵营布袋 + 挺拔白羽
  poly(ctx, [[-2.1, -25.8], [-4.6, -24.2], [-3.8, -22.4], [-1.9, -23.6]], pal.lit, m.edge, 0.45);
  poly(ctx, [[0.8, -26.0], [1.6, -29.2], [2.6, -26.4]], m.clothLit, m.edge, 0.45);

  // 高举前劈的弯月亮钢马刀（Cavalry Saber，彻底区别于长矛骑士！）
  poly(ctx, [[1.8, -18.8], [3.2, -18.0], [6.6, -21.4], [5.4, -22.2]], pal.lit, m.edge, 0.48);
  ctx.beginPath();
  ctx.moveTo(6.0, -21.6);
  ctx.quadraticCurveTo(10.8, -24.2, 13.4, -28.6);
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = m.steelLit;
  ctx.lineWidth = 1.35;
  ctx.stroke();
  // 黄铜护手
  strokeSeg(ctx, 4.8, -22.4, 7.2, -20.6, m.brassLit, 1.25);

  ctx.restore();
}

/* =========================================================================
   5. 种植园主（planter · 120 金 · 经济）：
   宽檐浅色绅士遮阳帽 + 浅麻礼服外套 + 阵营领巾 + 手杖，身旁帮工与满载白棉/经济作物的木货箱
   ========================================================================= */
function paintPlanter(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后排搬货帮工
  ctx.save();
  ctx.translate(-4.0, -2.5);
  ctx.scale(0.92, 0.92);
  drawShadow(ctx, 1.6, 0.6, 4.2, 1.8);
  drawLegs(ctx, m, m.leatherMid, m.leatherDark, 0.78);
  poly(ctx, [[-2.5, -15.0], [2.3, -14.8], [2.6, -6.5], [-2.6, -6.7]], m.clothMid, m.edge, 0.6);
  poly(ctx, [[-2.5, -10.5], [2.4, -10.3], [2.4, -9.2], [-2.5, -9.4]], pal.mid);
  drawFace(ctx, m, 0.2, -17.6);
  // 宽边浅草帽
  poly(ctx, [[-3.6, -18.6], [-1.6, -20.4], [1.6, -20.4], [3.6, -18.6], [0, -18.0]], m.brassLit, m.edge, 0.55);
  // 怀抱一捆蓬松白棉/烟叶作物包
  poly(ctx, [[0.8, -14.0], [5.4, -14.6], [5.8, -10.4], [1.2, -9.8]], m.clothLit, m.edge, 0.55);
  ctx.restore();

  // 脚边盛满雪白棉花/经济作物的实木货箱与圆木桶（一眼识别商业种植园！）
  poly(ctx, [[-6.8, -1.6], [-2.0, -3.2], [1.2, -1.6], [-3.6, 0.0]], m.clothLit, m.edge, 0.55);
  poly(ctx, [[-6.8, -1.6], [-3.6, 0.0], [-3.6, 3.0], [-6.8, 1.4]], m.woodLit, m.edge, 0.58);
  poly(ctx, [[-3.6, 0.0], [1.2, -1.6], [1.2, 1.4], [-3.6, 3.0]], m.woodDark, m.edge, 0.58);
  // 箱顶蓬松白棉花团
  ctx.fillStyle = '#faf8f2';
  ctx.beginPath();
  ctx.arc(-4.2, -2.0, 1.5, 0, Math.PI * 2);
  ctx.arc(-2.0, -2.2, 1.6, 0, Math.PI * 2);
  ctx.arc(-3.0, -1.0, 1.4, 0, Math.PI * 2);
  ctx.fill();

  // 前排种植园主（浅米色长礼服外套 + 阵营马甲 + 宽檐遮阳绅士帽 + 黄铜头手杖）
  ctx.save();
  ctx.translate(3.4, 1.4);
  drawShadow(ctx, 1.8, 0.6, 4.6, 1.9);
  drawLegs(ctx, m, m.clothShade, m.ironDark, 0.72);
  // 浅米长风衣下摆 + 阵营马甲前襟
  poly(ctx, [[-2.8, -9.8], [2.6, -9.8], [3.2, -5.6], [-3.0, -5.8]], m.clothLit, m.edge, 0.62);
  poly(ctx, [[-2.8, -15.4], [2.6, -15.2], [2.7, -9.6], [-2.7, -9.6]], m.clothLit, m.edge, 0.65);
  poly(ctx, [[-0.8, -15.2], [1.6, -15.1], [1.6, -9.8], [-0.8, -9.8]], pal.mid);
  poly(ctx, [[-0.7, -15.1], [0.4, -15.1], [0.4, -9.9], [-0.7, -9.9]], pal.lit);
  // 头部 + 宽檐浅色绅士帽 + 阵营帽带
  drawFace(ctx, m, 0.2, -18.0);
  ctx.beginPath();
  ctx.ellipse(0.2, -19.2, 4.6, 1.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = m.clothMid;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.58;
  ctx.stroke();
  poly(ctx, [[-2.2, -19.2], [-2.0, -21.8], [2.4, -21.8], [2.6, -19.2]], m.clothLit, m.edge, 0.58);
  poly(ctx, [[-2.1, -19.9], [2.5, -19.9], [2.5, -19.1], [-2.1, -19.1]], pal.mid);
  // 优雅驻地手杖（黄铜圆顶）
  strokeSeg(ctx, 3.8, -10.8, 5.2, 0.6, m.woodDark, 1.2);
  ctx.beginPath();
  ctx.arc(3.8, -11.0, 0.9, 0, Math.PI * 2);
  ctx.fillStyle = m.brassLit;
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   6. 劳工（engineer · 130 金 · 建造者）：
   时代 3 工兵/筑城劳工——布便帽 + 阵营工装马甲 + 铁锹 + 载冷灰花岗岩条石的铁轮双轮板车
   ========================================================================= */
function paintEngineer(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后排扛铁锹的工兵劳工
  ctx.save();
  ctx.translate(-4.4, -2.6);
  ctx.scale(0.95, 0.95);
  drawShadow(ctx, 1.6, 0.6, 4.4, 1.8);
  drawLegs(ctx, m, m.slateMid, m.slateShade, 0.84);
  poly(ctx, [[-2.6, -15.2], [2.4, -15.0], [2.6, -6.5], [-2.6, -6.7]], m.clothLit, m.edge, 0.6);
  // 阵营工装背心
  poly(ctx, [[-2.5, -15.1], [2.3, -15.0], [2.4, -9.8], [-2.4, -9.8]], pal.mid, m.edge, 0.52);
  poly(ctx, [[-2.4, -15.0], [0.3, -14.9], [0.1, -9.9], [-2.3, -9.9]], pal.lit);
  drawFace(ctx, m, 0.2, -17.8);
  // 平顶工人便帽
  poly(ctx, [[-2.2, -18.8], [-1.8, -20.6], [2.0, -20.6], [3.0, -18.8]], m.slateShade, m.edge, 0.55);
  // 肩扛亮钢宽口工程铁锹
  strokeSeg(ctx, -3.4, -11.0, 5.2, -20.6, m.edge, 1.9);
  strokeSeg(ctx, -3.4, -11.0, 5.2, -20.6, m.woodLit, 1.1);
  poly(ctx, [[3.6, -21.8], [6.4, -23.6], [8.2, -21.6], [6.2, -19.2], [4.4, -19.8]], m.steelLit, m.edge, 0.58);
  ctx.restore();

  // 前排推板车工兵
  ctx.save();
  ctx.translate(-1.2, 1.4);
  drawShadow(ctx, 1.6, 0.6, 4.2, 1.8);
  drawLegs(ctx, m, m.slateMid, m.slateShade, 0.95);
  poly(ctx, [[-2.0, -14.8], [2.8, -14.2], [2.5, -6.6], [-2.5, -6.8]], m.clothLit, m.edge, 0.6);
  poly(ctx, [[-1.9, -14.7], [2.6, -14.2], [2.4, -9.6], [-2.2, -9.8]], pal.mid, m.edge, 0.52);
  drawFace(ctx, m, 1.0, -17.4);
  poly(ctx, [[-1.2, -18.4], [-0.8, -20.2], [2.8, -20.2], [3.6, -18.4]], m.slateShade, m.edge, 0.55);
  poly(ctx, [[1.6, -13.2], [2.8, -12.6], [5.4, -9.6], [4.2, -8.8]], m.clothLit, m.edge, 0.48);
  ctx.restore();

  // 标志性「铁轮花岗岩工程板车」（区别于时代 2 木独轮车，载冷灰花岗岩条石 + 火药桶）
  drawShadow(ctx, 7.2, 1.8, 5.8, 2.2);
  // 包铁辐条大车轮
  ctx.beginPath();
  ctx.arc(8.6, -0.4, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = m.woodMid;
  ctx.fill();
  ctx.strokeStyle = m.ironDark;
  ctx.lineWidth = 1.1;
  ctx.stroke();
  strokeSeg(ctx, 6.2, -0.4, 11.0, -0.4, m.woodDark, 0.7);
  strokeSeg(ctx, 8.6, -2.8, 8.6, 2.0, m.woodDark, 0.7);
  // 车厢与冷灰花岗岩条石（直接呼应 E3 花岗岩城池与炮台！）
  strokeSeg(ctx, 2.0, -7.8, 11.4, -3.2, m.woodDark, 1.6);
  poly(ctx, [[3.4, -6.8], [11.2, -5.8], [10.8, -2.4], [3.8, -3.2]], m.woodMid, m.edge, 0.6);
  poly(ctx, [[3.8, -8.8], [7.6, -9.8], [10.4, -8.4], [6.6, -7.4]], m.graniteTop, m.edge, 0.55);
  poly(ctx, [[3.8, -8.8], [6.6, -7.4], [6.6, -5.4], [3.8, -6.8]], m.graniteLit, m.edge, 0.55);
  poly(ctx, [[6.6, -7.4], [10.4, -8.4], [10.4, -6.4], [6.6, -5.4]], m.graniteShade, m.edge, 0.55);
  poly(ctx, [[5.4, -5.6], [8.4, -5.2], [8.2, -2.8], [5.4, -3.2]], pal.mid);

  ctx.restore();
}

/* =========================================================================
   7. 炮艇（gunboat · 130 金 · 移 4 · 攻 25 · 破甲 · 射程 4）：
   木壳风帆炮艇——鼓风白帆（带阵营横条）+ 船首与舷侧黑铁加农炮 + 船尾海军旗
   ========================================================================= */
function paintGunboat(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterWake(ctx, 13.8, 5.2, pal, opts.selected, opts.target);

  ctx.save();
  ctx.scale(opts.facing, 1);

  // 修长干练木壳帆船船体 + 船首斜桅（Bowsprit）
  strokeSeg(ctx, 11.2, -4.6, 17.0, -9.6, m.edge, 1.9);
  strokeSeg(ctx, 11.2, -4.6, 17.0, -9.6, m.woodLit, 1.05);

  poly(ctx, [
    [-13.8, -5.8], [-8.4, -6.8], [8.6, -6.2], [14.6, -5.0],
    [11.4, 1.4], [5.6, 2.8], [-7.2, 2.8], [-11.8, 0.8],
  ], m.woodDark, m.edge, 0.75);
  // 经典火器时代战舰白色炮门带（Nelson Chequer 风格亮色舷线）
  poly(ctx, [[-12.8, -3.8], [-7.8, -2.6], [7.8, -2.4], [13.4, -3.4], [12.6, -1.4], [7.2, -0.4], [-7.6, -0.6], [-12.2, -1.8]], m.clothLit);
  // 船腹阵营水线涂装
  poly(ctx, [[-12.0, -1.6], [-7.4, -0.4], [7.2, -0.2], [12.4, -1.2], [11.6, 0.4], [6.4, 1.4], [-7.2, 1.2], [-11.6, 0.0]], pal.mid);

  // 舷侧三门伸出的黑铁加农炮口 + 船首主炮
  for (const cx of [-4.6, 0.4, 5.4]) {
    poly(ctx, [[cx - 1.1, -2.4], [cx + 1.1, -2.4], [cx + 1.1, -0.8], [cx - 1.1, -0.8]], m.ironDark);
    strokeSeg(ctx, cx, -1.6, cx + 1.6, -0.2, m.ironDark, 1.8);
  }
  // 船首主炮（突出船艏，强化射程 4 火力感）
  strokeSeg(ctx, 8.2, -6.2, 13.4, -7.2, m.edge, 2.6);
  strokeSeg(ctx, 8.2, -6.2, 13.4, -7.2, m.ironMid, 1.5);

  // 中央主桅杆与横桁
  strokeSeg(ctx, -0.6, -5.8, -0.6, -28.8, m.edge, 2.0);
  strokeSeg(ctx, -0.6, -5.8, -0.6, -28.8, m.woodLit, 1.15);
  strokeSeg(ctx, -8.2, -23.4, 7.6, -22.2, m.woodDark, 1.2);
  strokeSeg(ctx, -9.2, -11.4, 8.4, -10.2, m.woodDark, 1.2);

  // 标志性「饱满鼓风白帆」（1× 一眼区分风帆炮艇 vs 时代 2 塔楼船 vs 时代 4 铁甲舰！）
  ctx.beginPath();
  ctx.moveTo(-7.6, -23.2);
  ctx.lineTo(7.2, -22.0);
  ctx.quadraticCurveTo(10.6, -16.0, 8.0, -10.4);
  ctx.lineTo(-8.4, -11.6);
  ctx.quadraticCurveTo(-4.8, -17.2, -7.6, -23.2);
  ctx.closePath();
  ctx.fillStyle = m.clothLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.68;
  ctx.stroke();
  // 帆面中央醒目阵营横纹带（远景敌我辨识拉满）
  ctx.beginPath();
  ctx.moveTo(-6.2, -18.8);
  ctx.lineTo(8.8, -17.6);
  ctx.lineTo(9.2, -14.8);
  ctx.lineTo(-6.4, -16.0);
  ctx.closePath();
  ctx.fillStyle = pal.mid;
  ctx.fill();
  // 帆右下柔影
  poly(ctx, [[3.6, -22.2], [7.0, -21.9], [7.8, -10.6], [3.2, -10.8]], 'rgba(84, 96, 108, 0.14)');

  // 桅顶尖燕尾旗 + 船尾海军旗
  poly(ctx, [[-0.4, -28.8], [-7.4, -27.4], [-0.4, -26.0]], pal.lit, m.edge, 0.45);
  strokeSeg(ctx, -12.6, -5.6, -14.2, -13.6, m.woodLit, 0.9);
  poly(ctx, [[-14.1, -13.4], [-18.4, -12.4], [-18.0, -9.4], [-13.6, -10.4]], pal.mid, m.edge, 0.45);

  strokeSeg(ctx, -10.2, 2.8, 10.0, 2.8, 'rgba(246, 252, 255, 0.78)', 0.95);
  ctx.restore();
}

/* =========================================================================
   8. 炮台（battery · 150 金 · 甲 8 · 射程 4 · 溅射 1）：
   E3 同源低矮厚重八角冷灰花岗岩棱堡 + 顶置双门黑铁加农炮 + 炮弹堆 + 旗杆（锁定西北受光）
   ========================================================================= */
function paintBattery(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-12.2, 1.0], [5.8, -4.4], [15.4, 0.8], [1.6, 6.4]], 'rgba(22, 24, 28, 0.36)');

  // 厚重外斜八角冷灰花岗岩棱堡墙（低矮敦实，与时代 2 高瘦石堡截然不同！）
  poly(ctx, [
    [-12.4, -0.4], [-7.4, -4.8], [7.4, -4.8], [12.4, -0.4],
    [7.4, 4.6], [-7.4, 4.6],
  ], m.graniteShade, m.edge, 0.72);
  // 堡体立面（左受光、中正、右背光）
  poly(ctx, [[-12.4, -0.4], [-10.8, -10.6], [-6.2, -6.8], [-7.4, 4.6]], m.graniteLit, m.edge, 0.68);
  poly(ctx, [[-7.4, 4.6], [-6.2, -6.8], [6.2, -6.8], [7.4, 4.6]], m.graniteMid, m.edge, 0.68);
  poly(ctx, [[7.4, 4.6], [6.2, -6.8], [10.8, -10.6], [12.4, -0.4]], m.graniteShade, m.edge, 0.68);

  // 棱堡顶石质炮坪
  poly(ctx, [[-10.8, -10.6], [-6.2, -14.6], [6.2, -14.6], [10.8, -10.6], [6.2, -6.8], [-6.2, -6.8]], m.graniteTop, m.edge, 0.68);
  // 胸墙前侧阵营盾徽挂布
  poly(ctx, [[-2.8, -6.4], [2.8, -6.4], [2.8, 0.4], [0.0, 2.2], [-2.8, 0.4]], pal.mid, m.edge, 0.5);
  poly(ctx, [[-2.6, -6.2], [0.0, -6.2], [0.0, 1.9], [-2.6, 0.3]], pal.lit);

  // 炮坪后侧青灰瓦小弹药掩体
  poly(ctx, [[-5.0, -11.4], [-5.0, -15.6], [1.4, -15.6], [1.4, -11.4]], m.graniteLit, m.edge, 0.55);
  poly(ctx, [[-6.0, -15.4], [-1.8, -19.0], [2.4, -15.4]], m.slateMid, m.edge, 0.58);
  poly(ctx, [[-5.8, -15.4], [-1.8, -18.8], [-1.6, -15.4]], m.slateLit);

  // 标志性「顶置双门重型黑铁加农炮」（配木炮架 + 粗黑炮管，1× 一眼认出炮台！）
  const drawCannon = (cx: number, cy: number, tx: number, ty: number) => {
    poly(ctx, [[cx - 2.6, cy + 1.4], [cx + 2.0, cy + 1.8], [cx + 1.6, cy - 0.6], [cx - 2.2, cy - 0.8]], m.woodDark, m.edge, 0.5);
    strokeSeg(ctx, cx - 1.4, cy - 0.6, tx, ty, m.edge, 4.1);
    strokeSeg(ctx, cx - 1.4, cy - 0.6, tx, ty, m.ironDark, 2.9);
    strokeSeg(ctx, cx - 1.0, cy - 1.1, tx - 0.6, ty - 0.5, m.steelMid, 0.85);
    // 黄铜炮箍
    const mx = (cx + tx) * 0.5;
    const my = (cy + ty) * 0.5;
    strokeSeg(ctx, mx - 0.3, my - 1.4, mx + 0.3, my + 1.2, m.brassLit, 1.0);
  };
  drawCannon(2.4, -11.2, 11.4, -13.6);
  drawCannon(-1.2, -9.2, 7.8, -10.8);

  // 堡顶高旗
  strokeSeg(ctx, -6.8, -11.4, -6.8, -25.8, m.edge, 1.5);
  strokeSeg(ctx, -6.8, -11.4, -6.8, -25.8, m.steelLit, 0.85);
  poly(ctx, [[-6.6, -25.6], [0.4, -24.2], [-6.6, -22.2]], pal.mid, m.edge, 0.48);
  poly(ctx, [[-6.6, -25.4], [-2.2, -24.5], [-6.6, -23.6]], pal.lit);
}

/* =========================================================================
   9. 工厂（factory · 180 金 · 经济建筑）：
   冷灰花岗岩石砌工坊 + 青灰瓦双坡大厂房 + 高耸石砌方烟囱轻烟 + 货箱
   （冷灰石 + 青灰瓦贴合 E3 城池，把红砖工业大厂留给时代 4 兵工厂！）
   ========================================================================= */
function paintFactory(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-11.8, 1.2], [5.4, -4.4], [15.4, 1.2], [1.4, 6.2]], 'rgba(22, 24, 28, 0.34)');

  // 后侧高耸石砌方烟囱（工厂最直观剪影标志！）
  poly(ctx, [[3.0, -8.8], [3.6, -28.6], [6.4, -27.6], [6.8, -7.8]], m.graniteLit, m.edge, 0.65);
  poly(ctx, [[6.4, -27.6], [9.0, -28.6], [9.4, -8.8], [6.8, -7.8]], m.graniteShade, m.edge, 0.65);
  poly(ctx, [[3.2, -28.6], [6.4, -29.8], [9.4, -28.6], [6.4, -27.4]], m.ironDark, m.edge, 0.55);
  // 烟囱口袅袅白灰轻烟
  ctx.fillStyle = 'rgba(232, 237, 240, 0.68)';
  ctx.beginPath();
  ctx.arc(7.4, -31.2, 2.0, 0, Math.PI * 2);
  ctx.arc(9.8, -33.2, 2.5, 0, Math.PI * 2);
  ctx.arc(12.6, -34.6, 1.8, 0, Math.PI * 2);
  ctx.fill();

  // 主体冷灰花岗岩石砌大厂房（左受光、右背光）
  poly(ctx, [[-11.0, -0.4], [-11.0, -11.2], [0.4, -5.8], [0.4, 4.4]], m.graniteLit, m.edge, 0.72);
  poly(ctx, [[0.4, 4.4], [0.4, -5.8], [9.6, -10.4], [9.6, -0.4]], m.graniteShade, m.edge, 0.72);
  // 厂房拱形货运大门 + 两扇暖光工坊格窗
  poly(ctx, [[-7.8, 1.0], [-7.8, -4.4], [-4.2, -2.8], [-4.2, 2.6]], m.ironDark, m.edge, 0.58);
  poly(ctx, [[2.6, -1.6], [4.4, -2.5], [4.4, -5.4], [2.6, -4.5]], m.brassLit, m.edge, 0.45);
  poly(ctx, [[6.0, -3.3], [7.8, -4.2], [7.8, -7.1], [6.0, -6.2]], m.brassLit, m.edge, 0.45);
  // 门楣阵营铭牌彩带
  poly(ctx, [[-10.8, -9.8], [0.2, -4.6], [0.2, -3.2], [-10.8, -8.4]], pal.mid);
  poly(ctx, [[-10.8, -9.8], [-5.2, -7.1], [-5.2, -5.8], [-10.8, -8.4]], pal.lit);

  // 青灰瓦双坡硬山厂房大屋顶（与 E3 城池完全同色同质！）
  poly(ctx, [[-12.4, -10.8], [-5.2, -19.8], [5.8, -14.6], [0.2, -5.0]], m.slateLit, m.edge, 0.72);
  poly(ctx, [[-5.2, -19.8], [4.0, -24.0], [11.6, -19.4], [5.8, -14.6]], m.slateMid, m.edge, 0.65);
  poly(ctx, [[0.2, -5.0], [5.8, -14.6], [10.8, -10.2]], m.slateShade, m.edge, 0.68);
  // 屋顶采光天窗脊
  poly(ctx, [[-4.8, -18.8], [-1.0, -20.6], [4.4, -18.0], [0.6, -16.2]], m.graniteTop, m.edge, 0.5);

  // 门前堆放的木货箱
  poly(ctx, [[-10.8, 1.4], [-8.4, 0.4], [-6.6, 1.4], [-9.0, 2.4]], m.woodLit, m.edge, 0.5);
  poly(ctx, [[-10.8, 1.4], [-9.0, 2.4], [-9.0, 4.4], [-10.8, 3.4]], m.woodMid, m.edge, 0.5);
  poly(ctx, [[-9.0, 2.4], [-6.6, 1.4], [-6.6, 3.4], [-9.0, 4.4]], m.woodDark, m.edge, 0.5);
}

/* =========================================================================
   10. 堡寨（camp3 · 180 金 · 甲 6 · 血 52 · 产兵 + 自动攻击）：
   冷灰花岗岩棱角低堡墙 + 入口黑铁炮位 + 院内青灰瓦兵营主楼 + 黄铜顶高耸军旗
   ========================================================================= */
function paintCamp3(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-13.0, 1.0], [2.4, -6.4], [15.4, 0.6], [0.8, 7.0]], 'rgba(22, 24, 28, 0.34)');

  // 冷灰花岗岩铺装堡坪
  poly(ctx, [[-13.0, -0.4], [0.0, -6.8], [13.0, -0.4], [0.0, 5.8]], m.graniteShade, m.edge, 0.7);
  poly(ctx, [[-12.2, -0.4], [0.0, -6.3], [12.2, -0.4], [0.0, 5.1]], m.graniteTop);

  // 后侧双段斜壁冷灰花岗岩堡墙（取代时代 2 木栅齿，全面石堡化！）
  poly(ctx, [[-12.6, -0.4], [-12.0, -6.6], [0.0, -12.4], [0.0, -6.2]], m.graniteLit, m.edge, 0.68);
  poly(ctx, [[0.0, -6.2], [0.0, -12.4], [12.0, -6.6], [12.6, -0.4]], m.graniteShade, m.edge, 0.68);
  poly(ctx, [[-12.0, -6.6], [0.0, -12.4], [12.0, -6.6], [0.0, -11.2]], m.graniteTop);

  // 堡心青灰瓦顶规整营房主楼
  poly(ctx, [[-6.8, -1.0], [-6.8, -8.4], [0.0, -5.0], [0.0, 2.2]], m.graniteLit, m.edge, 0.65);
  poly(ctx, [[0.0, 2.2], [0.0, -5.0], [6.8, -8.4], [6.8, -1.0]], m.graniteShade, m.edge, 0.65);
  poly(ctx, [[-8.2, -8.2], [0.0, -16.2], [8.2, -8.2], [0.0, -4.2]], m.slateMid, m.edge, 0.68);
  poly(ctx, [[-7.8, -8.2], [0.0, -15.8], [0.0, -4.5]], m.slateLit);
  poly(ctx, [[0.0, -15.8], [7.8, -8.2], [0.0, -4.5]], m.slateShade);
  // 营门阵营长垂幡
  poly(ctx, [[-4.4, -5.6], [-2.0, -4.4], [-2.0, 0.6], [-4.4, -0.6]], pal.mid, m.edge, 0.45);

  // 前侧两座棱角冷灰石角墩 + 右墩一门守卫铁炮
  const drawBastionCorner = (gx: number, gy: number, lit: boolean) => {
    poly(ctx, [[gx - 2.8, gy], [gx - 2.4, gy - 6.6], [gx, gy - 5.2], [gx, gy + 1.4]], lit ? m.graniteLit : m.graniteMid, m.edge, 0.58);
    poly(ctx, [[gx, gy + 1.4], [gx, gy - 5.2], [gx + 2.4, gy - 6.6], [gx + 2.8, gy]], m.graniteShade, m.edge, 0.58);
    poly(ctx, [[gx - 2.4, gy - 6.6], [gx, gy - 7.8], [gx + 2.4, gy - 6.6], [gx, gy - 5.2]], m.graniteTop, m.edge, 0.52);
  };
  drawBastionCorner(-8.4, 2.6, true);
  drawBastionCorner(8.4, 2.4, false);
  // 右角墩黑铁小防卫炮
  strokeSeg(ctx, 8.2, -4.4, 12.6, -3.4, m.edge, 2.8);
  strokeSeg(ctx, 8.2, -4.4, 12.6, -3.4, m.ironDark, 1.8);

  // 黄铜矛头高耸军团大旗
  strokeSeg(ctx, -8.4, -6.4, -8.4, -24.8, m.edge, 1.8);
  strokeSeg(ctx, -8.4, -6.4, -8.4, -24.8, m.brassLit, 0.95);
  poly(ctx, [[-8.2, -24.6], [2.6, -23.0], [1.0, -20.2], [2.8, -17.6], [-8.2, -18.6]], pal.mid, m.edge, 0.55);
  poly(ctx, [[-8.2, -24.4], [-1.6, -23.4], [-2.2, -19.0], [-8.2, -19.4]], pal.lit);
  poly(ctx, [[-9.0, -24.8], [-8.4, -27.2], [-7.8, -24.8]], m.brassLit, m.edge, 0.45);
}

/* =========================================================================
   11. 石桥（bridge2 · 85 金 · 甲 3 · 血 60 · 水上工程建筑）：
   典雅冷灰花岗岩双孔石拱桥 + 石护栏与桥头柱 + 阵营小标旗（远景一眼区别于时代 1 木板桥！）
   ========================================================================= */
function paintBridge2(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterWake(ctx, 13.4, 5.2, pal, opts.selected, opts.target);

  // 石桥厚实前侧石拱立面（带两个清晰半圆暗拱洞）
  poly(ctx, [
    [-12.8, -1.6], [3.2, 4.4], [3.2, 6.8], [-12.8, 0.8],
  ], m.graniteMid, m.edge, 0.68);
  poly(ctx, [[3.2, 4.4], [12.8, -1.4], [12.8, 1.0], [3.2, 6.8]], m.graniteShade, m.edge, 0.68);

  // 两个半圆拱洞暗影（石拱桥核心标志！）
  const drawArch = (ax: number, ay: number) => {
    ctx.beginPath();
    ctx.arc(ax, ay, 2.3, Math.PI, 0, false);
    ctx.closePath();
    ctx.fillStyle = '#253947';
    ctx.fill();
    ctx.strokeStyle = m.graniteTop;
    ctx.lineWidth = 0.75;
    ctx.stroke();
  };
  drawArch(-8.0, 2.4);
  drawArch(-1.6, 4.8);

  // 微拱宽阔花岗岩石板桥面
  poly(ctx, [[-12.8, -2.0], [-3.2, -7.8], [12.8, -1.8], [3.2, 4.0]], m.graniteTop, m.edge, 0.72);
  // 石板路中线与拼缝
  for (let i = 1; i <= 5; i++) {
    const t = i / 6;
    strokeSeg(ctx, -12.8 + t * 16.0, -2.0 + t * 6.0, -3.2 + t * 16.0, -7.8 + t * 6.0, m.graniteShade, 0.55);
  }

  // 两侧厚实花岗岩石护栏墙 + 四角桥头石柱
  poly(ctx, [[-12.4, -2.2], [-12.4, -4.8], [2.8, 1.0], [2.8, 3.6]], m.graniteLit, m.edge, 0.6);
  poly(ctx, [[-2.8, -8.0], [-2.8, -10.4], [12.4, -4.6], [12.4, -2.0]], m.graniteMid, m.edge, 0.6);
  for (const [px, py] of [[-12.2, -4.8], [2.6, 1.0], [-2.8, -10.4], [12.2, -4.6]] as const) {
    poly(ctx, [[px - 1.1, py - 1.2], [px + 1.1, py - 1.2], [px + 1.1, py + 1.8], [px - 1.1, py + 1.8]], m.graniteTop, m.edge, 0.5);
  }

  // 桥头小阵营标旗
  strokeSeg(ctx, -12.2, -5.6, -12.2, -13.2, m.ironDark, 1.0);
  poly(ctx, [[-12.0, -13.0], [-7.8, -11.8], [-12.0, -10.4]], pal.mid, m.edge, 0.45);
}

export const ERA3_UNIT_SPECS: Readonly<Record<string, Era1UnitSpec>> = {
  halberdier: { paint: paintHalberdier, hitTop: 30 },
  musketeer: { paint: paintMusketeer, hitTop: 26 },
  mortar: { paint: paintMortar, ringRx: 11.4, ringRy: 4.9, barY: 5.8, hitTop: 24 },
  hussar: { paint: paintHussar, ringRx: 12.2, ringRy: 5.2, barY: 5.2, hitTop: 30 },
  planter: { paint: paintPlanter, hitTop: 26 },
  engineer: { paint: paintEngineer, ringRx: 11.6, ringRy: 5.0, hitTop: 26 },
  gunboat: { paint: paintGunboat, waterUnit: true, barY: 6.2, hitTop: 31 },
  battery: { paint: paintBattery, ringRx: 12.8, ringRy: 5.6, barY: 6.0, hitTop: 28 },
  factory: { paint: paintFactory, ringRx: 12.8, ringRy: 5.6, barY: 6.0, hitTop: 35 },
  camp3: { paint: paintCamp3, ringRx: 13.2, ringRy: 5.8, barY: 6.6, hitTop: 28 },
  bridge2: { paint: paintBridge2, waterUnit: true, barY: 6.8, hitTop: 18 },
};

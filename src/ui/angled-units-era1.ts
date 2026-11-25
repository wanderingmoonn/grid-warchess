/**
 * 时代 1（青铜时代）全兵种与野外建筑的斜俯视 3D 微缩沙盘绘制模块。
 *
 * 与已定稿的 `militia`（民兵）保持 100% 统一的美术语言：
 * - 真实比例（约 4.8 头身）与克制微细深褐暗边（0.55~0.75px），去 Q 版、去粗黑边；
 * - 严格西北受光 / 东南背光的 3~4 阶低饱和色相块面，与斜俯视地形及青铜城池同源；
 * - 严格按造价与定位拉开剪影梯度（民兵无甲持木矛 -> 戈兵兜鍪皮甲持长柄横刃青铜戈 -> 弓手背箙拉反曲弓 ->
 *   斥候连帽短披风伏身突进 -> 农民宽檐草笠持锄背谷筐 -> 牧民持弯杖携双白羊 -> 奴隶工役扛原木挥夯槌 ->
 *   舢板尖头划桨战舟 -> 渡船宽体平底跳板运船 -> 箭塔/磨坊/军营/木桥与 E1 城池同源木构茅草）。
 */

import type { AngledUnitPaintOpts, TeamClothPalette } from './angled-units.ts';

export type Era1BodyPainter = (
  ctx: CanvasRenderingContext2D,
  pal: TeamClothPalette,
  opts: AngledUnitPaintOpts,
) => void;

export interface Era1UnitSpec {
  /** 绘制单位主体（调用方已平移至格心并缩放至 scale，未乘 facing） */
  paint: Era1BodyPainter;
  /** 脚底光环水平/垂直半径（建筑/渡船略宽，水上单位可关陆地环改画水纹） */
  ringRx?: number;
  ringRy?: number;
  waterUnit?: boolean;
  /** 血条纵向偏移 */
  barY?: number;
  /** 命中框顶高 */
  hitTop?: number;
}

interface Era1Mat {
  edge: string;
  hempLit: string;
  hempMid: string;
  hempShade: string;
  leatherLit: string;
  leatherMid: string;
  leatherDark: string;
  pantsMid: string;
  pantsShade: string;
  skinLit: string;
  skinShade: string;
  hairDark: string;
  hairLit: string;
  woodLit: string;
  woodMid: string;
  woodDark: string;
  bronzeLit: string;
  bronzeMid: string;
  bronzeShade: string;
  thatchLit: string;
  thatchMid: string;
  thatchShade: string;
  stoneLit: string;
  stoneMid: string;
  stoneShade: string;
  woolLit: string;
  woolMid: string;
  woolShade: string;
  cloakLit: string;
  cloakMid: string;
  cloakShade: string;
}

function getMat(dim: boolean): Era1Mat {
  return {
    edge: dim ? 'rgba(42, 39, 35, 0.64)' : 'rgba(38, 32, 24, 0.72)',
    hempLit: dim ? '#c7c2b7' : '#ddd3bc',
    hempMid: dim ? '#aba599' : '#bfb297',
    hempShade: dim ? '#837e74' : '#8f8168',
    leatherLit: dim ? '#8c867c' : '#8c6540',
    leatherMid: dim ? '#6e6960' : '#69492c',
    leatherDark: dim ? '#4d4942' : '#452e1b',
    pantsMid: dim ? '#7c776e' : '#7b6c55',
    pantsShade: dim ? '#5e5a53' : '#584b39',
    skinLit: dim ? '#c9bfb2' : '#e6be96',
    skinShade: dim ? '#a3998d' : '#bc8f66',
    hairDark: dim ? '#4d4a45' : '#3a2d22',
    hairLit: dim ? '#69655e' : '#594534',
    woodLit: dim ? '#9c9487' : '#ab8252',
    woodMid: dim ? '#7d7569' : '#856039',
    woodDark: dim ? '#595349' : '#583d22',
    bronzeLit: dim ? '#c7c0b0' : '#e4c980',
    bronzeMid: dim ? '#a49d8e' : '#bd9c52',
    bronzeShade: dim ? '#787266' : '#7f652e',
    thatchLit: dim ? '#cbc5b6' : '#e5d198',
    thatchMid: dim ? '#ada799' : '#c6ae6e',
    thatchShade: dim ? '#827d71' : '#957d44',
    stoneLit: dim ? '#beb9af' : '#d2cab8',
    stoneMid: dim ? '#9d988f' : '#b2a894',
    stoneShade: dim ? '#757169' : '#807664',
    woolLit: dim ? '#d7d4cd' : '#f5f0e2',
    woolMid: dim ? '#bbb7af' : '#ded6c3',
    woolShade: dim ? '#8f8b83' : '#aca28d',
    cloakLit: dim ? '#8a887d' : '#7d8364',
    cloakMid: dim ? '#6e6c63' : '#5e6549',
    cloakShade: dim ? '#4c4b44' : '#3d432f',
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

function drawGroundShadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.fillStyle = 'rgba(28, 23, 17, 0.34)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0.14, 0, Math.PI * 2);
  ctx.fill();
}

/** 通用写实双腿（与民兵完全同源的 4.8 头身下肢比例） */
function drawHumanLegs(ctx: CanvasRenderingContext2D, m: Era1Mat, stride: number, kneel = false): void {
  if (kneel) {
    // 伏身/半蹲姿态（斥候前排/弓手架姿）
    poly(ctx, [[-2.3, -5.8], [-0.4, -5.8], [-2.0, -1.8], [-3.8, -2.0]], m.pantsShade, m.edge, 0.55);
    poly(ctx, [[-3.8, -2.0], [-2.0, -1.8], [-1.4, 0.4], [-3.3, 0.3]], m.woodDark);
    poly(ctx, [[0.1, -5.6], [2.2, -5.4], [3.2, -2.0], [1.2, -2.1]], m.pantsMid, m.edge, 0.55);
    poly(ctx, [[1.2, -2.1], [3.1, -2.0], [3.6, 0.6], [1.4, 0.6]], m.hempMid, m.edge, 0.52);
    poly(ctx, [[1.3, 0.2], [4.0, 0.3], [4.1, 1.0], [1.3, 1.0]], m.woodDark);
    return;
  }
  // 后腿
  poly(ctx, [[-2.0, -7.8], [-0.4, -7.8], [-1.2 * stride - 1.0, -2.5], [-2.6 * stride - 0.8, -2.7]], m.pantsShade, m.edge, 0.55);
  poly(ctx, [[-2.6 * stride - 0.8, -2.8], [-1.2 * stride - 1.0, -2.6], [-1.4 * stride - 1.1, -0.2], [-2.8 * stride - 1.0, -0.4]], m.hempShade, m.edge, 0.52);
  poly(ctx, [[-3.0 * stride - 1.0, -0.6], [-1.0 * stride - 0.8, -0.5], [-0.8 * stride - 0.7, 0.4], [-3.1 * stride - 1.0, 0.3]], m.woodDark);
  // 前腿
  poly(ctx, [[0.0, -7.6], [1.9, -7.6], [2.1 * stride + 0.5, -2.2], [0.5 * stride + 0.4, -2.4]], m.pantsMid, m.edge, 0.55);
  poly(ctx, [[0.5 * stride + 0.4, -2.4], [2.1 * stride + 0.5, -2.2], [2.4 * stride + 0.4, 0.2], [0.7 * stride + 0.4, 0.2]], m.hempMid, m.edge, 0.52);
  poly(ctx, [[0.6 * stride + 0.4, -0.2], [3.0 * stride + 0.5, -0.1], [3.2 * stride + 0.5, 0.8], [0.6 * stride + 0.4, 0.8]], m.woodDark);
}

/** 通用写实头部（不含头饰，便于各兵种叠戴兜鍪/草笠/兜帽/发髻） */
function drawHumanFace(ctx: CanvasRenderingContext2D, m: Era1Mat, hx: number, hy: number): void {
  poly(ctx, [[hx - 0.8, hy + 2.0], [hx + 0.9, hy + 2.0], [hx + 0.9, hy + 3.1], [hx - 0.8, hy + 3.1]], m.skinShade);
  poly(ctx, [
    [hx - 1.6, hy - 1.3],
    [hx + 1.5, hy - 1.3],
    [hx + 1.7, hy + 0.5],
    [hx + 0.9, hy + 2.1],
    [hx - 1.1, hy + 2.1],
    [hx - 1.7, hy + 0.6],
  ], m.skinLit, m.edge, 0.6);
  poly(ctx, [
    [hx + 0.2, hy - 1.1],
    [hx + 1.4, hy - 1.1],
    [hx + 1.5, hy + 0.5],
    [hx + 0.8, hy + 1.9],
    [hx + 0.1, hy + 1.9],
  ], m.skinShade);
}

/* =========================================================================
   1. 戈兵（ge · 30 金 · 破甲）：青铜沿小兜鍪 + 暗褐皮甲胸板 + 长柄横刃青铜戈 + 红缨
   ========================================================================= */
function drawGeSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era1Mat, variant: 0 | 1): void {
  drawGroundShadow(ctx, 2.0, 0.6, 4.7, 2.0);
  drawHumanLegs(ctx, m, variant === 0 ? 1.0 : 0.78);

  const lean = variant === 0 ? 0.55 : 0.15;
  // 阵营深色战裙下摆（区别于民兵粗麻短褐）
  poly(ctx, [[-2.7, -9.8], [2.5, -9.8], [3.1, -6.3], [-3.0, -6.5]], pal.mid, m.edge, 0.62);
  poly(ctx, [[-2.6, -9.6], [0.2, -9.6], [0.0, -6.5], [-2.8, -6.6]], pal.lit);
  poly(ctx, [[0.9, -9.6], [2.4, -9.6], [2.9, -6.4], [1.0, -6.5]], pal.shade);

  // 上身暗褐漆皮胸甲 + 青铜铆钉束带
  poly(ctx, [[-2.8 + lean, -15.5], [2.5 + lean, -15.3], [2.6, -9.6], [-2.6, -9.6]], m.leatherMid, m.edge, 0.68);
  poly(ctx, [[-2.6 + lean, -15.3], [0.3 + lean, -15.2], [0.1, -9.8], [-2.4, -9.8]], m.leatherLit);
  poly(ctx, [[1.0 + lean, -15.1], [2.3 + lean, -15.1], [2.4, -9.8], [1.1, -9.8]], m.leatherDark);
  // 胸甲阵营肩缘 + 铜扣腰带
  poly(ctx, [[-2.8 + lean, -15.5], [2.5 + lean, -15.3], [2.5 + lean, -13.9], [-2.7 + lean, -14.1]], pal.mid, m.edge, 0.5);
  poly(ctx, [[-2.7 + lean, -15.4], [0.3 + lean, -15.3], [0.3 + lean, -14.1], [-2.6 + lean, -14.2]], pal.lit);
  poly(ctx, [[-2.7, -10.3], [2.6, -10.1], [2.6, -9.2], [-2.7, -9.4]], m.leatherDark);
  poly(ctx, [[-0.6, -10.2], [0.8, -10.1], [0.8, -9.3], [-0.6, -9.4]], m.bronzeLit);

  // 后臂
  poly(ctx, [[-2.7 + lean, -14.8], [-1.3 + lean, -14.6], [-2.0, -10.8], [-3.4, -11.2]], m.skinLit, m.edge, 0.52);

  // 头部 + 青铜沿漆皮小兜鍪（与民兵布巾明显区隔，但比未来重步兵铁盔朴素轻便）
  const hx = lean * 1.1;
  const hy = -18.0;
  drawHumanFace(ctx, m, hx, hy);
  // 兜鍪盔顶（半圆贴头皮帽 + 护颈）
  poly(ctx, [
    [hx - 2.3, hy - 0.6],
    [hx - 2.2, hy - 2.6],
    [hx - 0.6, hy - 3.6],
    [hx + 1.0, hy - 3.4],
    [hx + 2.1, hy - 2.2],
    [hx + 2.0, hy - 0.7],
  ], m.leatherMid, m.edge, 0.62);
  poly(ctx, [[hx - 2.0, hy - 2.4], [hx - 0.6, hy - 3.4], [hx + 0.4, hy - 3.3], [hx + 0.1, hy - 1.3], [hx - 2.0, hy - 1.2]], m.leatherLit);
  // 青铜盔沿与顶部小铜钮
  poly(ctx, [[hx - 2.3, hy - 1.1], [hx + 2.1, hy - 1.1], [hx + 2.1, hy - 0.3], [hx - 2.3, hy - 0.3]], m.bronzeMid, m.edge, 0.45);
  poly(ctx, [[hx - 2.2, hy - 1.0], [hx + 0.3, hy - 1.0], [hx + 0.3, hy - 0.4], [hx - 2.2, hy - 0.4]], m.bronzeLit);
  poly(ctx, [[hx - 0.5, hy - 3.9], [hx + 0.5, hy - 3.9], [hx + 0.4, hy - 3.2], [hx - 0.4, hy - 3.2]], m.bronzeLit);

  // 标志性武器：青铜长柄戈（竖斜长杆 + 垂直横出青铜啄刃 + 阵营戈缨，剪影辨识度拉满！）
  const gx0 = variant === 0 ? -3.4 : -2.2;
  const gy0 = variant === 0 ? -5.6 : -4.8;
  const gx1 = variant === 0 ? 5.8 : 4.2;
  const gy1 = variant === 0 ? -24.8 : -26.8;

  strokeSeg(ctx, gx0, gy0, gx1, gy1, m.edge, 2.2);
  strokeSeg(ctx, gx0, gy0, gx1, gy1, m.woodDark, 1.35);
  strokeSeg(ctx, gx0 + 0.25, gy0 - 0.2, gx1 - 0.2, gy1 - 0.2, m.woodLit, 0.45);

  // 戈头轴向向量与垂直横刃方向
  const dx = gx1 - gx0;
  const dy = gy1 - gy0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // 朝向前方（右侧）的垂直法向量
  const fx = -uy;
  const fy = ux;

  // 顶部小铜刺（援上微尖）
  poly(ctx, [
    [gx1 - fx * 0.8, gy1 - fy * 0.8],
    [gx1 + ux * 2.5, gy1 + uy * 2.5],
    [gx1 + fx * 0.9, gy1 + fy * 0.9],
  ], m.bronzeLit, m.edge, 0.5);

  // 垂直前探的标志性「青铜横刃（援）」+ 后端短「内」
  const bladeBaseX = gx1 - ux * 1.4;
  const bladeBaseY = gy1 - uy * 1.4;
  poly(ctx, [
    [bladeBaseX - fx * 2.1 + ux * 0.7, bladeBaseY - fy * 2.1 + uy * 0.7],
    [bladeBaseX + fx * 6.4 + ux * 0.4, bladeBaseY + fy * 6.4 + uy * 0.4],
    [bladeBaseX + fx * 7.6 - ux * 0.7, bladeBaseY + fy * 7.6 - uy * 0.7],
    [bladeBaseX + fx * 3.8 - ux * 1.8, bladeBaseY + fy * 3.8 - uy * 1.8],
    [bladeBaseX - fx * 1.9 - ux * 0.9, bladeBaseY - fy * 1.9 - uy * 0.9],
  ], m.bronzeMid, m.edge, 0.58);
  // 横刃受光锋面
  poly(ctx, [
    [bladeBaseX - fx * 1.6 + ux * 0.6, bladeBaseY - fy * 1.6 + uy * 0.6],
    [bladeBaseX + fx * 6.2 + ux * 0.3, bladeBaseY + fy * 6.2 + uy * 0.3],
    [bladeBaseX + fx * 5.2 - ux * 0.4, bladeBaseY + fy * 5.2 - uy * 0.4],
    [bladeBaseX - fx * 1.4 - ux * 0.1, bladeBaseY - fy * 1.4 - uy * 0.1],
  ], m.bronzeLit);

  // 戈颈下悬一簇紧凑阵营流苏（戈缨），强化远景读数
  const tasX = gx1 - ux * 2.8;
  const tasY = gy1 - uy * 2.8;
  poly(ctx, [
    [tasX - 0.6, tasY],
    [tasX + 1.0, tasY + 0.2],
    [tasX + 1.5, tasY + 3.4],
    [tasX - 1.1, tasY + 3.1],
  ], pal.mid, m.edge, 0.42);
  poly(ctx, [[tasX - 0.5, tasY + 0.1], [tasX + 0.3, tasY + 0.2], [tasX + 0.2, tasY + 2.8], [tasX - 0.8, tasY + 2.7]], pal.lit);

  // 前臂稳握戈杆
  const gripX = gx0 + dx * 0.38;
  const gripY = gy0 + dy * 0.38;
  poly(ctx, [[1.4 + lean, -14.2], [2.8 + lean, -13.7], [gripX + 0.8, gripY + 0.8], [gripX - 0.8, gripY - 0.5]], m.skinLit, m.edge, 0.55);
  ctx.fillStyle = m.skinLit;
  ctx.beginPath();
  ctx.arc(gripX, gripY, 1.05, 0, Math.PI * 2);
  ctx.fill();
}

function paintGe(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.6, -2.7);
  ctx.scale(0.95, 0.95);
  drawGeSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.3, 1.5);
  ctx.scale(1.02, 1.02);
  drawGeSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   2. 弓手（archer · 35 金 · 射程 3）：背负羽箭箙 + 拉满弦大反曲木弓 + 猎装短褐
   ========================================================================= */
function drawArcherSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era1Mat, variant: 0 | 1): void {
  drawGroundShadow(ctx, 1.8, 0.6, 4.5, 1.9);
  drawHumanLegs(ctx, m, variant === 0 ? 0.95 : 0.72, variant === 0);

  const yDrop = variant === 0 ? 1.8 : 0;
  const lean = variant === 0 ? 0.8 : 0.3;

  ctx.save();
  ctx.translate(0, yDrop);

  // 背负皮革箭箙 + 三支露出的白羽箭尾（极强弓手剪影特征）
  poly(ctx, [[-4.8 + lean, -16.8], [-3.0 + lean, -17.4], [-1.2, -10.8], [-3.0, -10.4]], m.leatherDark, m.edge, 0.55);
  poly(ctx, [[-4.6 + lean, -16.7], [-3.5 + lean, -17.1], [-2.0, -11.0], [-2.9, -10.8]], m.leatherLit);
  // 箭尾白羽
  strokeSeg(ctx, -4.6 + lean, -17.1, -5.6 + lean, -19.2, m.woolLit, 1.0);
  strokeSeg(ctx, -3.9 + lean, -17.3, -4.7 + lean, -19.6, m.woolMid, 1.0);
  strokeSeg(ctx, -3.2 + lean, -17.4, -3.8 + lean, -19.4, m.woolLit, 0.9);

  // 轻便猎手短褐（橄榄麻布 + 阵营护肩斜带）
  poly(ctx, [[-2.5, -9.8], [2.3, -9.8], [2.7, -6.8], [-2.7, -7.0]], m.hempShade, m.edge, 0.6);
  poly(ctx, [[-2.6 + lean, -15.2], [2.2 + lean, -15.0], [2.4, -9.6], [-2.4, -9.6]], m.cloakMid, m.edge, 0.65);
  poly(ctx, [[-2.4 + lean, -15.0], [0.2 + lean, -14.9], [0.0, -9.8], [-2.2, -9.8]], m.cloakLit);
  // 阵营肩巾与箭囊斜带
  poly(ctx, [[-2.5 + lean, -15.1], [-0.4 + lean, -15.1], [2.3, -10.2], [0.7, -10.0]], pal.mid);
  poly(ctx, [[-2.4 + lean, -15.0], [-1.0 + lean, -15.0], [0.9, -11.5], [0.0, -11.5]], pal.lit);
  poly(ctx, [[-2.5, -10.1], [2.4, -9.9], [2.4, -9.2], [-2.5, -9.4]], m.leatherDark);

  // 写实头颅 + 简洁猎手束发与阵营额巾
  const hx = lean * 1.1;
  const hy = -17.8;
  drawHumanFace(ctx, m, hx, hy);
  poly(ctx, [
    [hx - 2.1, hy - 0.8], [hx - 1.8, hy - 2.6], [hx + 0.5, hy - 3.0],
    [hx + 1.9, hy - 2.0], [hx + 1.7, hy - 0.9], [hx - 0.5, hy - 1.1],
  ], m.hairDark, m.edge, 0.58);
  poly(ctx, [[hx - 2.0, hy - 1.4], [hx + 1.8, hy - 1.4], [hx + 1.8, hy - 0.5], [hx - 2.0, hy - 0.5]], pal.mid);
  poly(ctx, [[hx - 1.9, hy - 1.3], [hx + 0.2, hy - 1.3], [hx + 0.2, hy - 0.6], [hx - 1.9, hy - 0.6]], pal.lit);

  // 前伸托弓臂 + 拉弦后臂
  const aimUp = variant === 1 ? -1.8 : 0.0;
  const handX = 6.2;
  const handY = -13.6 + aimUp;
  poly(ctx, [[1.3 + lean, -14.2], [2.5 + lean, -13.5], [handX, handY + 0.7], [handX - 0.4, handY - 0.7]], m.skinLit, m.edge, 0.5);
  // 拉弦手靠在颊侧
  poly(ctx, [[-1.6 + lean, -14.0], [-0.4 + lean, -14.6], [2.6, -13.8 + aimUp * 0.4], [1.6, -12.8 + aimUp * 0.4]], m.skinShade, m.edge, 0.48);

  // 标志性大反曲木弓（拉满弓弦 + 搭箭上弦，弧形轮廓远景极易识别）
  const bowTopX = 5.4;
  const bowTopY = -22.2 + aimUp;
  const bowBotX = 4.6;
  const bowBotY = -6.0 + aimUp;
  const bowMidX = 8.4;
  const bowMidY = -14.0 + aimUp;
  const drawX = 1.8;
  const drawY = -13.8 + aimUp * 0.5;

  // 弓弦（细白紧绷折线）
  ctx.beginPath();
  ctx.moveTo(bowTopX, bowTopY);
  ctx.lineTo(drawX, drawY);
  ctx.lineTo(bowBotX, bowBotY);
  ctx.strokeStyle = 'rgba(244, 238, 222, 0.85)';
  ctx.lineWidth = 0.65;
  ctx.stroke();

  // 弓臂（先暗边、再暖木、再受光亮脊）
  ctx.beginPath();
  ctx.moveTo(bowTopX, bowTopY);
  ctx.quadraticCurveTo(bowMidX + 1.0, bowMidY - 2.8, handX + 1.0, handY);
  ctx.quadraticCurveTo(bowMidX + 0.6, bowMidY + 2.8, bowBotX, bowBotY);
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(bowTopX, bowTopY);
  ctx.quadraticCurveTo(bowMidX + 1.0, bowMidY - 2.8, handX + 1.0, handY);
  ctx.quadraticCurveTo(bowMidX + 0.6, bowMidY + 2.8, bowBotX, bowBotY);
  ctx.strokeStyle = m.woodMid;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(bowTopX, bowTopY);
  ctx.quadraticCurveTo(bowMidX + 0.7, bowMidY - 2.6, handX + 0.8, handY);
  ctx.strokeStyle = m.woodLit;
  ctx.lineWidth = 0.55;
  ctx.stroke();

  // 搭在弦上的羽箭（木杆 + 铜镞 + 白羽）
  const arrEndX = 11.8;
  const arrEndY = -14.2 + aimUp * 1.4;
  strokeSeg(ctx, drawX, drawY, arrEndX, arrEndY, m.woodDark, 1.0);
  poly(ctx, [[arrEndX - 1.2, arrEndY - 0.8], [arrEndX + 1.6, arrEndY - 0.1], [arrEndX - 1.0, arrEndY + 0.9]], m.bronzeLit, m.edge, 0.4);
  strokeSeg(ctx, drawX - 0.6, drawY - 0.7, drawX + 0.9, drawY - 0.1, m.woolLit, 0.85);
  strokeSeg(ctx, drawX - 0.6, drawY + 0.7, drawX + 0.9, drawY + 0.1, m.woolLit, 0.85);

  ctx.restore();
}

function paintArcher(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.6, -2.8);
  ctx.scale(0.95, 0.95);
  drawArcherSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.0, 1.4);
  ctx.scale(1.0, 1.0);
  drawArcherSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   3. 斥候（scout · 50 金 · 移动4/视野4/潜行）：伏身连帽短披风 + 轻装飞奔 + 短标枪
   ========================================================================= */
function drawScoutSoldier(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era1Mat, variant: 0 | 1): void {
  drawGroundShadow(ctx, 1.6, 0.6, 5.2, 2.0);
  drawHumanLegs(ctx, m, variant === 0 ? 1.15 : 1.05, variant === 0);

  const yDrop = variant === 0 ? 2.2 : 0.8;
  const lean = variant === 0 ? 2.0 : 1.4;

  ctx.save();
  ctx.translate(0, yDrop);

  // 飘扬的林地短斗篷后摆（斥候最醒目的低姿流线剪影！）
  poly(ctx, [
    [-2.4 + lean, -14.8],
    [1.4 + lean, -14.4],
    [-2.4, -7.8],
    [-6.6, -6.2],
    [-5.8, -11.4],
  ], m.cloakShade, m.edge, 0.65);
  poly(ctx, [
    [-2.3 + lean, -14.6],
    [0.5 + lean, -14.4],
    [-2.8, -9.2],
    [-5.6, -10.8],
  ], m.cloakLit);
  // 披风底缘一条阵营滚边（隐蔽中仍一眼分敌我）
  poly(ctx, [[-6.5, -6.4], [-2.5, -8.0], [-2.8, -9.0], [-6.2, -7.6]], pal.mid);
  poly(ctx, [[-6.1, -7.5], [-3.8, -8.4], [-4.0, -9.1], [-5.9, -8.3]], pal.lit);

  // 前倾紧身皮衣躯干
  poly(ctx, [[-2.0 + lean, -14.6], [2.4 + lean, -14.0], [2.2, -8.8], [-2.2, -9.2]], m.leatherMid, m.edge, 0.62);
  poly(ctx, [[-1.8 + lean, -14.4], [0.6 + lean, -14.2], [0.4, -9.0], [-1.9, -9.2]], m.leatherLit);
  // 阵营围领
  poly(ctx, [[-2.3 + lean, -15.0], [2.4 + lean, -14.5], [2.1 + lean, -12.8], [-2.2 + lean, -13.2]], pal.mid, m.edge, 0.48);
  poly(ctx, [[-2.1 + lean, -14.9], [0.5 + lean, -14.6], [0.3 + lean, -13.2], [-2.0 + lean, -13.4]], pal.lit);

  // 低伏连帽兜帽头颅（标志性三角兜帽轮廓）
  const hx = lean * 1.15 + 0.5;
  const hy = -16.8;
  drawHumanFace(ctx, m, hx, hy);
  poly(ctx, [
    [hx - 3.6, hy - 0.6],
    [hx - 2.3, hy - 2.8],
    [hx + 0.4, hy - 3.3],
    [hx + 2.3, hy - 2.0],
    [hx + 1.8, hy - 0.8],
    [hx - 0.6, hy - 1.2],
    [hx - 2.0, hy + 1.2],
  ], m.cloakMid, m.edge, 0.65);
  poly(ctx, [[hx - 3.2, hy - 0.8], [hx - 2.1, hy - 2.6], [hx + 0.4, hy - 3.0], [hx + 0.2, hy - 1.4], [hx - 1.8, hy - 0.8]], m.cloakLit);

  // 短标枪 / 青铜侦察短刃（水平前指，轻捷迅猛）
  const jx0 = variant === 0 ? -4.2 : -5.0;
  const jy0 = variant === 0 ? -10.8 : -11.6;
  const jx1 = variant === 0 ? 7.8 : 7.0;
  const jy1 = variant === 0 ? -11.4 : -13.2;
  strokeSeg(ctx, jx0, jy0, jx1, jy1, m.edge, 1.9);
  strokeSeg(ctx, jx0, jy0, jx1, jy1, m.woodMid, 1.05);
  poly(ctx, [[jx1 - 0.6, jy1 - 1.1], [jx1 + 3.4, jy1 - 0.3], [jx1 - 0.4, jy1 + 1.1]], m.bronzeLit, m.edge, 0.5);

  // 前臂持标枪
  poly(ctx, [[0.8 + lean, -13.5], [2.3 + lean, -12.9], [3.8, -11.2], [2.4, -10.6]], m.skinLit, m.edge, 0.5);

  ctx.restore();
}

function paintScout(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  ctx.save();
  ctx.translate(-3.8, -2.5);
  ctx.scale(0.94, 0.94);
  drawScoutSoldier(ctx, pal, m, 1);
  ctx.restore();

  ctx.save();
  ctx.translate(3.4, 1.8);
  ctx.scale(1.0, 1.0);
  drawScoutSoldier(ctx, pal, m, 0);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   4. 农民（farmer · 45 金 · 经济）：宽檐黄金草斗笠 + 扛长柄青铜锄头 + 满筐金黄麦穗
   ========================================================================= */
function drawFarmerPerson(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era1Mat, withHoe: boolean): void {
  drawGroundShadow(ctx, 1.8, 0.6, 4.6, 1.9);
  drawHumanLegs(ctx, m, withHoe ? 0.82 : 0.7);

  const lean = withHoe ? 0.5 : 0.2;
  // 挽袖粗麻农衣 + 宽阵营腰布
  poly(ctx, [[-2.5, -9.8], [2.4, -9.8], [2.8, -6.6], [-2.7, -6.8]], m.hempMid, m.edge, 0.6);
  poly(ctx, [[-2.6 + lean, -15.2], [2.3 + lean, -15.0], [2.4, -9.6], [-2.4, -9.6]], m.hempLit, m.edge, 0.65);
  poly(ctx, [[0.7 + lean, -15.0], [2.2 + lean, -15.0], [2.3, -9.8], [0.8, -9.8]], m.hempShade);
  // 宽阵营束腰布带（温和清晰的阵营识别）
  poly(ctx, [[-2.6, -10.8], [2.5, -10.6], [2.6, -8.8], [-2.7, -9.0]], pal.mid, m.edge, 0.48);
  poly(ctx, [[-2.5, -10.7], [0.4, -10.6], [0.3, -8.9], [-2.6, -9.0]], pal.lit);
  // 领口阵营滚边
  poly(ctx, [[-1.6 + lean, -15.2], [1.6 + lean, -15.1], [1.1 + lean, -13.6], [-1.1 + lean, -13.6]], pal.mid);

  // 头部 + 标志性宽檐圆锥草斗笠（1× 远景一眼辨出农民！）
  const hx = lean * 1.05;
  const hy = -17.7;
  drawHumanFace(ctx, m, hx, hy);
  // 斗笠暗底沿
  ctx.beginPath();
  ctx.ellipse(hx, hy - 1.1, 4.9, 1.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = m.thatchShade;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // 斗笠锥顶（左受光、右背光）
  poly(ctx, [
    [hx - 5.0, hy - 1.2],
    [hx, hy - 4.7],
    [hx + 5.0, hy - 1.2],
    [hx, hy - 0.3],
  ], m.thatchMid, m.edge, 0.62);
  poly(ctx, [[hx - 4.7, hy - 1.2], [hx, hy - 4.5], [hx + 0.3, hy - 0.5]], m.thatchLit);
  // 斗笠一圈阵营细带
  poly(ctx, [[hx - 2.3, hy - 2.8], [hx + 2.3, hy - 2.8], [hx + 2.8, hy - 2.1], [hx - 2.8, hy - 2.1]], pal.mid);

  if (withHoe) {
    // 肩扛/斜持长柄农锄（曲头宽铲刃）
    const hx0 = -4.6;
    const hy0 = -9.6;
    const hx1 = 6.6;
    const hy1 = -21.2;
    strokeSeg(ctx, hx0, hy0, hx1, hy1, m.edge, 2.0);
    strokeSeg(ctx, hx0, hy0, hx1, hy1, m.woodMid, 1.15);
    // 垂直下垂的宽板锄头
    poly(ctx, [
      [hx1 - 0.8, hy1 - 0.4],
      [hx1 + 1.2, hy1 - 1.2],
      [hx1 + 3.6, hy1 + 3.0],
      [hx1 + 1.0, hy1 + 3.6],
    ], m.bronzeMid, m.edge, 0.58);
    poly(ctx, [[hx1 - 0.5, hy1 - 0.3], [hx1 + 0.8, hy1 - 0.8], [hx1 + 2.2, hy1 + 2.6], [hx1 + 1.0, hy1 + 3.2]], m.bronzeLit);
    // 前手握锄柄
    poly(ctx, [[1.2 + lean, -14.0], [2.6 + lean, -13.4], [2.4, -15.4], [1.0, -15.8]], m.skinLit, m.edge, 0.5);
  } else {
    // 怀抱一捆金黄麦穗
    poly(ctx, [[0.8, -14.2], [5.4, -16.8], [6.4, -14.2], [1.8, -11.4]], m.thatchMid, m.edge, 0.55);
    poly(ctx, [[1.2, -14.0], [5.2, -16.4], [5.8, -15.0], [1.8, -12.6]], m.thatchLit);
    strokeSeg(ctx, 2.6, -13.6, 3.8, -11.8, pal.mid, 1.0);
    poly(ctx, [[-1.6 + lean, -14.2], [0.2 + lean, -14.0], [2.4, -11.6], [1.0, -10.8]], m.skinLit, m.edge, 0.5);
  }
}

function paintFarmer(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后排抱麦穗农民
  ctx.save();
  ctx.translate(-3.8, -2.4);
  ctx.scale(0.94, 0.94);
  drawFarmerPerson(ctx, pal, m, false);
  ctx.restore();

  // 脚边一筐满载金谷的竹编大箩筐（一眼传达经济采集单位）
  poly(ctx, [[-5.6, -1.6], [-1.0, -1.6], [-1.6, 2.4], [-5.0, 2.4]], m.woodMid, m.edge, 0.58);
  poly(ctx, [[-5.4, -1.5], [-3.2, -1.5], [-3.5, 2.2], [-4.9, 2.2]], m.woodLit);
  ctx.beginPath();
  ctx.ellipse(-3.3, -1.8, 2.4, 1.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = m.thatchLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // 前排扛锄农民
  ctx.save();
  ctx.translate(3.2, 1.5);
  ctx.scale(1.0, 1.0);
  drawFarmerPerson(ctx, pal, m, true);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   5. 牧民（herder · 45 金 · 高地/丘陵经济）：牧羊人持高弯木杖 + 两只写实白绵羊
   ========================================================================= */
function drawSheep(ctx: CanvasRenderingContext2D, m: Era1Mat, ox: number, oy: number, s: number, headDown: boolean): void {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  drawGroundShadow(ctx, 0.8, 0.6, 4.0, 1.5);
  // 四条细暗腿
  strokeSeg(ctx, -2.2, -1.4, -2.4, 0.7, m.hairDark, 0.95);
  strokeSeg(ctx, -0.7, -1.2, -0.8, 0.9, m.hairDark, 0.95);
  strokeSeg(ctx, 1.4, -1.2, 1.5, 0.9, m.hairDark, 0.95);
  strokeSeg(ctx, 2.5, -1.4, 2.7, 0.6, m.hairDark, 0.95);
  // 蓬松羊毛椭圆身躯（NW 亮顶 + SE 暖灰暗腹）
  poly(ctx, [
    [-3.6, -2.4], [-3.0, -4.6], [-0.4, -5.2], [2.4, -4.7],
    [3.6, -3.2], [3.2, -1.2], [0.2, -0.8], [-2.8, -1.1],
  ], m.woolMid, m.edge, 0.58);
  poly(ctx, [
    [-3.3, -2.8], [-2.6, -4.4], [-0.3, -5.0], [2.0, -4.5], [1.4, -2.6], [-2.4, -2.4],
  ], m.woolLit);
  poly(ctx, [[-1.6, -1.6], [2.8, -1.8], [3.0, -1.2], [0.1, -0.9], [-2.4, -1.1]], m.woolShade);
  // 深棕绵羊小头 + 下垂耳朵
  const hy = headDown ? -1.4 : -3.5;
  const hx = headDown ? 4.4 : 4.2;
  poly(ctx, [[hx - 1.2, hy - 1.1], [hx + 1.3, hy - 0.8], [hx + 1.5, hy + 0.8], [hx - 0.8, hy + 1.0]], m.hairDark, m.edge, 0.5);
  poly(ctx, [[hx - 1.4, hy - 0.6], [hx - 0.4, hy - 0.9], [hx - 0.7, hy + 0.5]], m.hairLit);
  ctx.restore();
}

function paintHerder(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后排一只吃草绵羊
  drawSheep(ctx, m, 3.8, -2.2, 0.92, false);

  // 左侧站立牧羊人（羊皮坎肩 + 阵营长围巾 + 高挑弯头牧羊杖）
  ctx.save();
  ctx.translate(-3.4, -0.8);
  drawGroundShadow(ctx, 1.8, 0.6, 4.5, 1.9);
  drawHumanLegs(ctx, m, 0.75);
  // 粗麻下摆 + 暖羊毛坎肩
  poly(ctx, [[-2.5, -9.8], [2.4, -9.8], [2.9, -6.5], [-2.8, -6.8]], m.hempMid, m.edge, 0.6);
  poly(ctx, [[-2.6, -15.4], [2.4, -15.2], [2.5, -9.6], [-2.5, -9.6]], m.woolMid, m.edge, 0.65);
  poly(ctx, [[-2.4, -15.2], [0.4, -15.1], [0.2, -9.8], [-2.3, -9.8]], m.woolLit);
  // 鲜明阵营围巾 + 飘尾
  poly(ctx, [[-2.7, -15.5], [2.4, -15.2], [2.2, -13.0], [-2.6, -13.2]], pal.mid, m.edge, 0.5);
  poly(ctx, [[-2.6, -15.4], [0.4, -15.2], [0.2, -13.3], [-2.5, -13.4]], pal.lit);
  poly(ctx, [[-2.5, -14.8], [-5.4, -12.0], [-4.5, -10.8], [-2.1, -13.4]], pal.mid, m.edge, 0.45);
  // 头部 + 毡帽
  drawHumanFace(ctx, m, 0.2, -18.0);
  poly(ctx, [[-2.2, -18.8], [-1.7, -21.0], [1.6, -21.2], [2.3, -18.8]], m.leatherMid, m.edge, 0.6);
  poly(ctx, [[-2.0, -19.0], [-1.5, -20.8], [0.3, -20.9], [0.1, -19.0]], m.leatherLit);
  poly(ctx, [[-2.3, -19.2], [2.3, -19.2], [2.3, -18.4], [-2.3, -18.4]], pal.lit);
  // 标志性高挑弯头牧羊杖（直立高出头顶带 J 形弯钩）
  strokeSeg(ctx, 3.6, 0.4, 4.4, -22.2, m.edge, 2.0);
  strokeSeg(ctx, 3.6, 0.4, 4.4, -22.2, m.woodMid, 1.15);
  ctx.beginPath();
  ctx.arc(6.0, -22.2, 1.7, Math.PI, 0.25, false);
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.0;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(6.0, -22.2, 1.7, Math.PI, 0.25, false);
  ctx.strokeStyle = m.woodLit;
  ctx.lineWidth = 1.1;
  ctx.stroke();
  // 扶杖手
  poly(ctx, [[1.4, -14.2], [2.6, -13.6], [4.2, -13.0], [3.6, -11.9]], m.skinLit, m.edge, 0.48);
  ctx.restore();

  // 前排低头吃草绵羊（双羊簇拥，远景一眼识别牧民）
  drawSheep(ctx, m, 3.4, 2.2, 1.0, true);

  ctx.restore();
}

/* =========================================================================
   6. 奴隶/工役（laborer · 50 金 · 建造者）：扛长原木梁 + 挥夯土大木槌 + 脚边石料
   ========================================================================= */
function drawLaborerPerson(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, m: Era1Mat, carryLog: boolean): void {
  drawGroundShadow(ctx, 1.8, 0.6, 4.5, 1.9);
  drawHumanLegs(ctx, m, carryLog ? 0.85 : 0.95);

  const lean = carryLog ? 0.6 : 0.85;
  // 简陋粗麻短裙 + 阵营腰带（赤膊劳作感，直观区别于战士和农民）
  poly(ctx, [[-2.5, -10.2], [2.4, -10.2], [2.8, -6.5], [-2.7, -6.7]], m.hempShade, m.edge, 0.6);
  poly(ctx, [[-2.4, -10.0], [0.2, -10.0], [0.0, -6.7], [-2.6, -6.8]], m.hempMid);
  poly(ctx, [[-2.6, -10.7], [2.5, -10.5], [2.6, -9.2], [-2.7, -9.4]], pal.mid, m.edge, 0.48);
  poly(ctx, [[-2.5, -10.6], [0.4, -10.5], [0.3, -9.3], [-2.6, -9.4]], pal.lit);

  // 古铜健硕赤膊上身 + 斜背绳带
  poly(ctx, [[-2.6 + lean, -15.3], [2.4 + lean, -15.1], [2.3, -10.2], [-2.4, -10.2]], m.skinLit, m.edge, 0.65);
  poly(ctx, [[0.5 + lean, -15.1], [2.3 + lean, -15.0], [2.2, -10.3], [0.6, -10.3]], m.skinShade);
  poly(ctx, [[-2.3 + lean, -15.2], [-1.0 + lean, -15.2], [2.2, -10.4], [1.1, -10.3]], pal.mid);

  // 头颅 + 短发阵营汗巾
  const hx = lean * 1.1;
  const hy = -17.9;
  drawHumanFace(ctx, m, hx, hy);
  poly(ctx, [
    [hx - 2.0, hy - 1.0], [hx - 1.7, hy - 2.6], [hx + 0.5, hy - 2.9], [hx + 1.8, hy - 1.9], [hx + 1.6, hy - 1.0],
  ], m.hairDark, m.edge, 0.55);
  poly(ctx, [[hx - 1.9, hy - 1.4], [hx + 1.7, hy - 1.4], [hx + 1.7, hy - 0.5], [hx - 1.9, hy - 0.5]], pal.lit);

  if (carryLog) {
    // 肩扛一整根长圆原木梁（超强工程建造辨识度！）
    poly(ctx, [[-7.6, -14.2], [7.8, -19.2], [8.5, -16.8], [-6.8, -11.8]], m.woodMid, m.edge, 0.62);
    poly(ctx, [[-7.5, -14.1], [7.7, -19.0], [8.0, -18.0], [-7.2, -13.1]], m.woodLit);
    // 原木端面年轮亮圈
    ctx.beginPath();
    ctx.ellipse(8.1, -18.0, 1.1, 1.3, 0.28, 0, Math.PI * 2);
    ctx.fillStyle = m.hempLit;
    ctx.fill();
    ctx.strokeStyle = m.edge;
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // 举手扶木
    poly(ctx, [[1.4 + lean, -14.4], [2.8 + lean, -14.2], [3.6, -16.8], [2.2, -17.0]], m.skinLit, m.edge, 0.48);
  } else {
    // 扛/挥厚重双面木槌（建造夯土大槌）
    strokeSeg(ctx, -1.2, -11.8, 6.2, -20.2, m.edge, 2.0);
    strokeSeg(ctx, -1.2, -11.8, 6.2, -20.2, m.woodMid, 1.15);
    // 粗大圆筒槌头
    poly(ctx, [[3.4, -21.4], [7.8, -23.0], [9.4, -19.8], [5.0, -18.2]], m.woodDark, m.edge, 0.62);
    poly(ctx, [[3.6, -21.3], [7.6, -22.8], [8.4, -21.2], [4.4, -19.7]], m.woodLit);
    poly(ctx, [[1.2 + lean, -14.2], [2.6 + lean, -13.6], [3.4, -15.4], [2.0, -16.0]], m.skinLit, m.edge, 0.48);
  }
}

function paintLaborer(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  ctx.save();
  ctx.scale(opts.facing, 1);

  // 后排扛长原木工役
  ctx.save();
  ctx.translate(-3.4, -2.5);
  ctx.scale(0.95, 0.95);
  drawLaborerPerson(ctx, pal, m, true);
  ctx.restore();

  // 脚边两块凿好的条石（强化建造工兵语义）
  poly(ctx, [[-6.8, -0.4], [-2.8, -1.8], [-0.4, -0.6], [-4.4, 0.8]], m.stoneLit, m.edge, 0.55);
  poly(ctx, [[-6.8, -0.4], [-4.4, 0.8], [-4.4, 2.8], [-6.8, 1.6]], m.stoneMid, m.edge, 0.55);
  poly(ctx, [[-4.4, 0.8], [-0.4, -0.6], [-0.4, 1.4], [-4.4, 2.8]], m.stoneShade, m.edge, 0.55);

  // 前排挥大木槌工役
  ctx.save();
  ctx.translate(3.4, 1.5);
  ctx.scale(1.0, 1.0);
  drawLaborerPerson(ctx, pal, m, false);
  ctx.restore();

  ctx.restore();
}

/* =========================================================================
   7. 舢板（boat · 45 金 · 水上战船）：双头尖木舟 + 水面涟漪 + 双人划桨执矛 + 船首三角旗
   ========================================================================= */
function drawWaterRipples(ctx: CanvasRenderingContext2D, rx: number, ry: number, pal: TeamClothPalette, selected: boolean, target: boolean): void {
  ctx.save();
  // 外圈轻水波涟漪
  ctx.beginPath();
  ctx.ellipse(0, 1.8, rx + 2.4, ry + 1.2, 0, 0, Math.PI * 2);
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : 'rgba(240, 248, 252, 0.56)';
  ctx.lineWidth = selected || target ? 1.8 : 1.0;
  ctx.stroke();

  // 内圈船体水影 + 阵营水色衬底
  ctx.beginPath();
  ctx.ellipse(0, 1.5, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected ? 'rgba(210, 236, 248, 0.48)' : target ? 'rgba(248, 224, 214, 0.48)' : 'rgba(20, 42, 56, 0.34)';
  ctx.fill();
  ctx.strokeStyle = pal.ring;
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.restore();
}

function paintBoat(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterRipples(ctx, 11.8, 4.4, pal, opts.selected, opts.target);

  ctx.save();
  ctx.scale(opts.facing, 1);

  // 船尾斜入水面的长木桨（压在船身下方/外侧）
  strokeSeg(ctx, -6.2, -5.2, -13.2, 2.2, m.edge, 2.0);
  strokeSeg(ctx, -6.2, -5.2, -13.2, 2.2, m.woodLit, 1.1);
  poly(ctx, [[-12.2, 1.0], [-14.8, 2.2], [-13.6, 3.6], [-11.5, 2.2]], m.woodMid, m.edge, 0.5);

  // 船舱背舷（深木暗槽）
  poly(ctx, [
    [-12.6, -4.4], [-6.8, -6.6], [6.4, -6.2], [13.4, -3.6],
    [8.0, -1.8], [-8.0, -2.0],
  ], m.woodDark, m.edge, 0.65);

  // 船内两名缩微水手（后排操桨手 + 前排执矛水兵）
  const drawCrew = (cx: number, cy: number, armed: boolean) => {
    poly(ctx, [[cx - 2.0, cy - 5.2], [cx + 1.9, cy - 5.0], [cx + 2.0, cy], [cx - 2.0, cy]], m.hempMid, m.edge, 0.55);
    poly(ctx, [[cx - 1.9, cy - 5.0], [cx + 0.2, cy - 5.0], [cx + 0.1, cy], [cx - 1.8, cy]], m.hempLit);
    poly(ctx, [[cx - 2.0, cy - 5.1], [cx + 1.9, cy - 5.0], [cx + 1.9, cy - 3.6], [cx - 2.0, cy - 3.8]], pal.mid);
    drawHumanFace(ctx, m, cx, cy - 7.4);
    poly(ctx, [[cx - 1.8, cy - 8.2], [cx - 1.4, cy - 9.8], [cx + 1.4, cy - 9.6], [cx + 1.7, cy - 8.2]], m.hairDark, m.edge, 0.5);
    poly(ctx, [[cx - 1.8, cy - 8.7], [cx + 1.7, cy - 8.7], [cx + 1.7, cy - 7.9], [cx - 1.8, cy - 7.9]], pal.lit);
    if (armed) {
      strokeSeg(ctx, cx - 2.6, cy - 3.4, cx + 6.8, cy - 12.2, m.edge, 1.8);
      strokeSeg(ctx, cx - 2.6, cy - 3.4, cx + 6.8, cy - 12.2, m.woodLit, 1.0);
      poly(ctx, [[cx + 6.0, cy - 11.6], [cx + 8.8, cy - 14.0], [cx + 7.2, cy - 10.8]], m.bronzeLit, m.edge, 0.45);
    }
  };
  drawCrew(-4.8, -3.2, false);
  drawCrew(2.6, -2.6, true);

  // 尖头翘首木船前舷（NW 受光暖木 + 船底吃水暗部 + 阵营舷线）
  poly(ctx, [
    [-12.8, -4.4], [-7.2, -2.8], [7.0, -2.6], [13.8, -4.2],
    [10.8, 0.9], [4.8, 2.2], [-6.2, 2.2], [-10.4, 0.6],
  ], m.woodMid, m.edge, 0.72);
  poly(ctx, [
    [-12.4, -4.2], [-7.0, -2.8], [7.0, -2.6], [13.0, -4.0],
    [11.8, -1.6], [5.8, -0.5], [-6.6, -0.6], [-11.2, -1.8],
  ], m.woodLit);
  // 船舷阵营涂装条
  poly(ctx, [
    [-11.2, -3.4], [-6.8, -2.2], [6.8, -2.0], [12.0, -3.2],
    [11.2, -2.1], [6.4, -1.0], [-6.5, -1.2], [-10.6, -2.4],
  ], pal.mid);
  // 船底吃水阴面
  poly(ctx, [[-10.1, 0.4], [-6.0, 2.0], [4.8, 2.0], [10.4, 0.6], [9.6, 1.6], [4.6, 2.5], [-6.2, 2.4], [-9.8, 1.1]], m.woodDark);

  // 船首高挑小旗杆 + 阵营三角战旗
  strokeSeg(ctx, 10.6, -3.6, 11.4, -14.8, m.edge, 1.5);
  strokeSeg(ctx, 10.6, -3.6, 11.4, -14.8, m.woodLit, 0.85);
  poly(ctx, [[11.3, -14.6], [4.6, -12.6], [11.1, -10.4]], pal.mid, m.edge, 0.5);
  poly(ctx, [[11.2, -14.4], [6.4, -13.0], [11.1, -12.2]], pal.lit);

  // 前舷白色划水泡沫高光
  strokeSeg(ctx, -9.2, 2.2, 8.6, 2.3, 'rgba(246, 252, 255, 0.75)', 0.9);
  ctx.restore();
}

/* =========================================================================
   8. 渡船（ferry · 60 金 · 水上运兵/载2人）：宽体平底木方舟 + 登船跳板 + 蓬棚 + 撑篙船夫
   ========================================================================= */
function paintFerry(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterRipples(ctx, 13.4, 5.2, pal, opts.selected, opts.target);

  ctx.save();
  ctx.scale(opts.facing, 1);

  // 宽大平底方形甲板（刻意与尖瘦舢板形成强烈剪影对比！）
  poly(ctx, [
    [-12.4, -3.6], [-4.8, -7.8], [11.8, -6.2], [12.6, -1.2], [5.4, 2.4], [-11.4, 1.0],
  ], m.woodLit, m.edge, 0.72);
  // 甲板木板拼缝线
  strokeSeg(ctx, -8.8, -3.8, 8.0, -2.4, m.woodDark, 0.55);
  strokeSeg(ctx, -6.6, -5.6, 9.8, -4.2, m.woodDark, 0.55);
  // 船帮厚立面（深木吃水墙）
  poly(ctx, [[-12.4, -3.6], [-11.4, 1.0], [5.4, 2.4], [12.6, -1.2], [12.2, 1.0], [5.4, 4.0], [-11.0, 2.6], [-12.0, -1.4]], m.woodDark, m.edge, 0.68);
  poly(ctx, [[-11.2, 1.0], [5.4, 2.4], [5.4, 3.8], [-11.0, 2.4]], m.woodMid);
  // 侧帮阵营识色条
  poly(ctx, [[-10.6, 1.2], [4.8, 2.5], [4.8, 3.3], [-10.5, 2.0]], pal.mid);

  // 船首倾斜登船跳板（运兵渡船独有特征！）
  poly(ctx, [[10.0, -5.4], [14.8, -4.4], [15.4, -1.0], [10.6, -1.8]], m.woodMid, m.edge, 0.65);
  poly(ctx, [[10.3, -5.2], [14.6, -4.3], [14.9, -2.8], [10.5, -3.6]], m.woodLit);
  strokeSeg(ctx, 11.4, -5.0, 11.8, -1.6, m.woodDark, 0.6);
  strokeSeg(ctx, 13.1, -4.6, 13.5, -1.2, m.woodDark, 0.6);

  // 两侧矮木护栏
  strokeSeg(ctx, -10.8, -4.4, 8.6, -2.8, m.woodDark, 1.2);
  strokeSeg(ctx, -10.8, -4.4, -10.8, -1.6, m.woodDark, 1.0);
  strokeSeg(ctx, -2.2, -3.6, -2.2, -0.8, m.woodDark, 1.0);
  strokeSeg(ctx, 6.2, -2.9, 6.2, -0.2, m.woodDark, 1.0);

  // 后舱苇席拱形货棚 + 阵营篷顶纹带（清楚表达运输载具属性）
  poly(ctx, [[-10.6, -5.0], [-5.2, -8.2], [0.8, -7.4], [-4.6, -4.0]], m.thatchMid, m.edge, 0.62);
  poly(ctx, [[-10.2, -5.2], [-5.2, -8.1], [-2.0, -7.7], [-7.2, -4.6]], m.thatchLit);
  // 蓬棚顶一道阵营织带
  poly(ctx, [[-7.6, -6.7], [-5.4, -7.9], [-2.4, -7.5], [-4.6, -6.2]], pal.mid);
  // 舱口补给木箱
  poly(ctx, [[-4.2, -4.8], [-1.0, -5.4], [0.8, -4.4], [-2.4, -3.8]], m.woodLit, m.edge, 0.5);
  poly(ctx, [[-4.2, -4.8], [-2.4, -3.8], [-2.4, -1.6], [-4.2, -2.6]], m.woodMid, m.edge, 0.5);
  poly(ctx, [[-2.4, -3.8], [0.8, -4.4], [0.8, -2.2], [-2.4, -1.6]], m.woodDark, m.edge, 0.5);

  // 船尾撑篙船夫 + 超长斜竹篙
  const fx = 2.6;
  const fy = -3.8;
  poly(ctx, [[fx - 1.8, fy - 5.2], [fx + 1.8, fy - 5.0], [fx + 2.0, fy + 0.4], [fx - 1.9, fy + 0.4]], m.hempMid, m.edge, 0.55);
  poly(ctx, [[fx - 1.8, fy - 5.0], [fx + 1.7, fy - 4.9], [fx + 1.7, fy - 3.6], [fx - 1.8, fy - 3.8]], pal.mid);
  drawHumanFace(ctx, m, fx, fy - 7.3);
  // 草斗笠
  poly(ctx, [[fx - 3.6, fy - 8.2], [fx, fy - 10.8], [fx + 3.6, fy - 8.2], [fx, fy - 7.5]], m.thatchLit, m.edge, 0.55);
  // 斜插入水的长撑船竹篙
  strokeSeg(ctx, fx - 5.2, fy - 11.4, fx + 7.4, fy + 5.6, m.edge, 1.8);
  strokeSeg(ctx, fx - 5.2, fy - 11.4, fx + 7.4, fy + 5.6, m.thatchMid, 0.95);

  // 船尾阵营方旗
  strokeSeg(ctx, -9.2, -5.4, -9.2, -16.0, m.edge, 1.5);
  strokeSeg(ctx, -9.2, -5.4, -9.2, -16.0, m.woodLit, 0.85);
  poly(ctx, [[-9.2, -15.8], [-14.2, -15.0], [-14.0, -11.4], [-9.2, -12.2]], pal.mid, m.edge, 0.5);
  poly(ctx, [[-9.2, -15.6], [-12.0, -15.1], [-11.9, -12.8], [-9.2, -13.2]], pal.lit);

  ctx.restore();
}

/* =========================================================================
   9. 箭塔（tower · 55 金 · 建筑/射程3）：E1 同源木构高脚瞭望箭楼 + 茅草顶 + 阵营旗
   （建筑不随 facing 水平翻转，确保西北受光与城池、地形 100% 同向！）
   ========================================================================= */
function paintTower(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  // 建筑东南长投影
  poly(ctx, [[-6.0, 0.6], [6.4, -2.0], [14.4, 2.2], [2.4, 5.4]], 'rgba(26, 21, 15, 0.34)');

  // 底部矮石木基础与四根微斜粗原木支柱
  poly(ctx, [[-8.0, 0.2], [0.0, -3.4], [8.0, 0.2], [0.0, 3.8]], m.stoneMid, m.edge, 0.65);
  poly(ctx, [[-7.6, 0.1], [0.0, -3.2], [0.0, 3.5]], m.stoneLit);
  // 后两支柱
  strokeSeg(ctx, -5.4, -1.6, -4.4, -15.4, m.woodDark, 2.0);
  strokeSeg(ctx, 5.4, -1.6, 4.4, -15.4, m.woodDark, 2.0);
  // 木架交叉斜撑（X 桁架，箭塔结构标志）
  strokeSeg(ctx, -5.6, -2.4, 4.6, -13.8, m.woodDark, 1.25);
  strokeSeg(ctx, 5.6, -2.4, -4.6, -13.8, m.woodMid, 1.25);
  // 前两支柱（受光亮木）
  strokeSeg(ctx, -5.8, 1.6, -4.8, -14.2, m.edge, 2.8);
  strokeSeg(ctx, -5.8, 1.6, -4.8, -14.2, m.woodLit, 1.75);
  strokeSeg(ctx, 5.8, 1.6, 4.8, -14.2, m.edge, 2.8);
  strokeSeg(ctx, 5.8, 1.6, 4.8, -14.2, m.woodMid, 1.75);
  strokeSeg(ctx, 0.0, 3.2, 0.0, -13.2, m.edge, 2.4);
  strokeSeg(ctx, 0.0, 3.2, 0.0, -13.2, m.woodMid, 1.45);
  // 横梁
  strokeSeg(ctx, -5.4, -6.2, 0.0, -4.2, m.woodLit, 1.3);
  strokeSeg(ctx, 0.0, -4.2, 5.4, -6.2, m.woodDark, 1.3);

  // 高空木构女墙战斗平台（左 NW 受光、右 SE 背光）
  poly(ctx, [[-7.6, -14.2], [0.0, -11.4], [0.0, -16.8], [-7.6, -19.6]], m.woodLit, m.edge, 0.68);
  poly(ctx, [[0.0, -11.4], [7.6, -14.2], [7.6, -19.6], [0.0, -16.8]], m.woodDark, m.edge, 0.68);
  // 女墙原木竖纹
  for (const lx of [-5.6, -3.8, -2.0]) strokeSeg(ctx, lx, -18.8 + (lx + 7.6) * 0.35, lx, -13.6 + (lx + 7.6) * 0.35, m.woodDark, 0.55);
  for (const lx of [2.0, 3.8, 5.6]) strokeSeg(ctx, lx, -16.8 - lx * 0.35, lx, -11.6 - lx * 0.35, 'rgba(34, 24, 15, 0.55)', 0.55);

  // 平台前缘悬挂一块醒目阵营战布（远景速判归属）
  poly(ctx, [[-4.8, -17.8], [-1.2, -16.5], [-1.2, -12.6], [-4.8, -13.9]], pal.lit, m.edge, 0.5);
  poly(ctx, [[1.4, -16.4], [4.8, -17.7], [4.8, -13.8], [1.4, -12.5]], pal.shade, m.edge, 0.5);

  // 四角支木 + 微小瞭望弓手剪影
  strokeSeg(ctx, -6.4, -19.2, -6.4, -23.6, m.woodLit, 1.2);
  strokeSeg(ctx, 0.0, -16.8, 0.0, -21.2, m.woodMid, 1.2);
  strokeSeg(ctx, 6.4, -19.2, 6.4, -23.6, m.woodDark, 1.2);
  // 塔楼四坡金黄茅草顶（与 E1 城池屋顶完全同色同质感）
  poly(ctx, [[0.0, -28.6], [-9.2, -22.8], [0.0, -19.6]], m.thatchLit, m.edge, 0.68);
  poly(ctx, [[0.0, -28.6], [0.0, -19.6], [9.2, -22.8]], m.thatchShade, m.edge, 0.68);
  poly(ctx, [[0.0, -28.6], [-4.2, -24.4], [0.0, -21.6], [4.0, -24.4]], m.thatchMid);

  // 塔顶旗杆 + 阵营尖旗
  strokeSeg(ctx, 0.0, -28.4, 0.0, -34.2, m.edge, 1.4);
  strokeSeg(ctx, 0.0, -28.4, 0.0, -34.2, m.woodLit, 0.8);
  poly(ctx, [[0.2, -34.0], [6.4, -32.4], [0.2, -30.6]], pal.mid, m.edge, 0.48);
  poly(ctx, [[0.2, -33.8], [4.2, -32.8], [0.2, -32.0]], pal.lit);
}

/* =========================================================================
   10. 磨坊（mill · 65 金 · 建筑/经济）：夯土石基圆屋 + 锥形厚茅草顶 + 转动木水磨轮 + 谷袋
   ========================================================================= */
function paintMill(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-8.6, 0.8], [4.8, -3.2], [13.8, 1.2], [1.6, 5.2]], 'rgba(26, 21, 15, 0.34)');

  // 圆柱/八棱夯土石砌磨坊主体（左侧受光、右侧背光）
  poly(ctx, [
    [-8.6, -1.2], [-8.2, -13.2], [7.8, -13.2], [8.2, -1.2],
    [5.2, 2.2], [-5.2, 2.2],
  ], m.stoneMid, m.edge, 0.72);
  poly(ctx, [[-8.4, -1.4], [-8.0, -13.0], [0.2, -13.0], [0.0, 2.0], [-5.0, 2.0]], m.stoneLit);
  poly(ctx, [[2.0, -13.0], [7.6, -13.0], [8.0, -1.4], [5.0, 2.0], [1.6, 2.0]], m.stoneShade);
  // 石墙木梁腰带 + 拱形暗木门
  poly(ctx, [[-8.3, -12.6], [7.9, -12.6], [7.9, -11.2], [-8.3, -11.2]], m.woodMid, m.edge, 0.5);
  poly(ctx, [[-2.6, 2.1], [-2.6, -4.6], [-0.4, -5.8], [1.8, -4.6], [1.8, 2.1]], m.woodDark, m.edge, 0.58);

  // 厚重圆锥形金黄茅草大屋顶（E1 城池同源草顶 + 阵营檐带）
  poly(ctx, [[-11.2, -11.4], [0.0, -24.8], [11.0, -11.4], [0.0, -8.2]], m.thatchMid, m.edge, 0.72);
  poly(ctx, [[-10.8, -11.4], [0.0, -24.5], [0.2, -8.5]], m.thatchLit);
  poly(ctx, [[2.4, -21.8], [10.7, -11.5], [0.4, -8.6]], m.thatchShade);
  // 屋脊阵营布旗
  strokeSeg(ctx, 0.0, -24.6, 0.0, -29.8, m.woodDark, 1.1);
  poly(ctx, [[0.2, -29.6], [5.8, -28.0], [0.2, -26.4]], pal.mid, m.edge, 0.48);
  poly(ctx, [[0.2, -29.4], [3.8, -28.4], [0.2, -27.6]], pal.lit);

  // 标志性外挂大木磨轮 / 水车轮（右侧立面斜椭圆木辐轮，1× 一眼认出磨坊！）
  ctx.save();
  ctx.translate(7.8, -5.2);
  ctx.beginPath();
  ctx.ellipse(0, 0, 4.4, 6.2, 0.16, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(42, 31, 19, 0.25)';
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.strokeStyle = m.woodLit;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // 八辐木轮条
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    const dx = Math.cos(a) * 4.0;
    const dy = Math.sin(a) * 5.8;
    strokeSeg(ctx, -dx, -dy, dx, dy, m.woodDark, 1.0);
  }
  ctx.beginPath();
  ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = m.bronzeLit;
  ctx.fill();
  ctx.strokeStyle = m.edge;
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.restore();

  // 门前堆放两只鼓囊囊的粗麻谷袋（强化粮食产出的直觉读数）
  const drawSack = (sx: number, sy: number) => {
    poly(ctx, [[sx - 2.2, sy], [sx - 1.6, sy - 3.4], [sx + 1.6, sy - 3.4], [sx + 2.3, sy], [sx, sy + 1.1]], m.hempLit, m.edge, 0.55);
    poly(ctx, [[sx, sy - 3.3], [sx + 1.5, sy - 3.3], [sx + 2.1, sy], [sx, sy + 1.0]], m.hempShade);
    strokeSeg(ctx, sx - 1.2, sy - 2.6, sx + 1.2, sy - 2.6, pal.mid, 0.9);
  };
  drawSack(-6.4, 2.2);
  drawSack(-3.2, 3.4);
}

/* =========================================================================
   11. 军营（camp · 90 金 · 产兵/自动攻击建筑）：尖木栅栏围墙 + 双顶军帐 + 帅旗
   ========================================================================= */
function paintCamp(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  poly(ctx, [[-11.8, 0.8], [2.4, -5.8], [14.2, 0.4], [0.8, 6.2]], 'rgba(26, 21, 15, 0.32)');

  // 营地夯土底坪
  poly(ctx, [[-12.2, -0.4], [0.0, -6.2], [12.2, -0.4], [0.0, 5.2]], m.stoneMid, m.edge, 0.65);
  poly(ctx, [[-11.4, -0.4], [0.0, -5.8], [11.4, -0.4], [0.0, 4.6]], m.hempShade);

  // 后围尖顶原木栅栏（直接呼应 E1 青铜城池木墙）
  const drawStake = (sx: number, sy: number, h: number, lit: boolean) => {
    poly(ctx, [[sx - 1.1, sy], [sx - 1.1, sy - h], [sx, sy - h - 1.8], [sx + 1.1, sy - h], [sx + 1.1, sy]], lit ? m.woodLit : m.woodMid, m.edge, 0.5);
  };
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    drawStake(-11.2 + t * 11.2, -0.8 - t * 5.2, 5.4, true);
    drawStake(0.0 + t * 11.2, -6.0 + t * 5.2, 5.4, false);
  }

  // 主帅人字形大军帐（厚帆布 + 醒目阵营帐脊与垂帘）
  // 副小帐（右后）
  poly(ctx, [[1.8, -2.0], [5.8, -9.2], [9.8, -2.0], [5.8, 0.2]], m.hempMid, m.edge, 0.6);
  poly(ctx, [[1.8, -2.0], [5.8, -9.2], [5.8, 0.2]], m.hempLit);
  poly(ctx, [[4.6, -7.2], [5.8, -9.2], [7.0, -7.2], [5.8, -6.4]], pal.mid);

  // 主帐（左中大帐）
  poly(ctx, [[-8.6, 0.2], [-2.2, -13.6], [4.4, -0.8], [-2.0, 2.8]], m.hempMid, m.edge, 0.7);
  poly(ctx, [[-8.3, 0.1], [-2.2, -13.2], [-2.0, 2.5]], m.hempLit);
  poly(ctx, [[-2.0, -13.2], [4.2, -0.8], [-1.8, 2.5]], m.hempShade);
  // 主帐顶部阵营彩顶 + 暗门帘
  poly(ctx, [[-5.6, -6.2], [-2.2, -13.5], [1.2, -6.8], [-2.1, -5.2]], pal.mid, m.edge, 0.5);
  poly(ctx, [[-5.4, -6.2], [-2.2, -13.2], [-2.1, -5.3]], pal.lit);
  poly(ctx, [[-3.4, 2.0], [-2.1, -3.4], [-0.5, 1.8]], m.leatherDark);

  // 营前矮栅栏入口 + 兵器架三支竖矛
  drawStake(-9.8, 1.8, 4.2, true);
  drawStake(-7.6, 2.9, 4.2, true);
  drawStake(7.8, 2.4, 4.2, false);
  drawStake(10.0, 1.2, 4.2, false);
  strokeSeg(ctx, 2.6, 2.2, 3.8, -6.2, m.woodDark, 0.9);
  strokeSeg(ctx, 4.4, 2.8, 5.4, -5.6, m.woodDark, 0.9);
  poly(ctx, [[3.5, -6.2], [4.0, -8.0], [4.3, -6.0]], m.bronzeLit);
  poly(ctx, [[5.1, -5.6], [5.6, -7.4], [5.9, -5.4]], m.bronzeLit);

  // 营门高耸阵营战旗（远景一眼分辨军营与民居/磨坊）
  strokeSeg(ctx, -7.8, 1.2, -7.8, -22.4, m.edge, 1.8);
  strokeSeg(ctx, -7.8, 1.2, -7.8, -22.4, m.woodLit, 1.0);
  poly(ctx, [[-7.6, -22.2], [1.8, -20.6], [0.4, -18.2], [2.0, -15.8], [-7.6, -16.8]], pal.mid, m.edge, 0.55);
  poly(ctx, [[-7.6, -22.0], [-1.8, -21.0], [-2.2, -17.2], [-7.6, -17.6]], pal.lit);
  // 旗杆铜顶
  poly(ctx, [[-8.4, -22.4], [-7.8, -24.4], [-7.2, -22.4]], m.bronzeLit, m.edge, 0.4);
}

/* =========================================================================
   12. 木桥（bridge · 45 金 · 水上工程建筑）：双排木桩 + 微拱厚木板桥面 + 原木栏杆
   ========================================================================= */
function paintBridge(ctx: CanvasRenderingContext2D, pal: TeamClothPalette, opts: AngledUnitPaintOpts): void {
  const m = getMat(opts.dim);
  drawWaterRipples(ctx, 12.6, 4.8, pal, opts.selected, opts.target);

  // 下方木桩柱
  for (const [px, py] of [[-8.6, 0.6], [-2.6, 2.2], [3.6, 1.4], [8.8, -0.6]] as const) {
    poly(ctx, [[px - 1.1, py - 4.2], [px + 1.1, py - 4.2], [px + 1.1, py + 2.2], [px - 1.1, py + 2.2]], m.woodDark, m.edge, 0.55);
  }
  // 微拱斜向厚木桥面
  poly(ctx, [[-12.4, -2.0], [-3.2, -7.4], [12.4, -1.6], [3.2, 3.8]], m.woodLit, m.edge, 0.72);
  // 桥侧厚木沿
  poly(ctx, [[-12.4, -2.0], [3.2, 3.8], [3.2, 5.6], [-12.4, -0.2]], m.woodMid, m.edge, 0.65);
  poly(ctx, [[3.2, 3.8], [12.4, -1.6], [12.4, 0.2], [3.2, 5.6]], m.woodDark, m.edge, 0.65);
  // 桥板横缝
  for (let i = 1; i <= 5; i++) {
    const t = i / 6;
    strokeSeg(ctx, -12.4 + t * 15.6, -2.0 + t * 5.8, -3.2 + t * 15.6, -7.4 + t * 5.8, m.woodDark, 0.65);
  }
  // 两侧矮原木护栏
  strokeSeg(ctx, -11.4, -5.0, 2.8, 0.6, m.edge, 2.0);
  strokeSeg(ctx, -11.4, -5.0, 2.8, 0.6, m.woodLit, 1.15);
  strokeSeg(ctx, -2.8, -10.2, 11.4, -4.6, m.edge, 2.0);
  strokeSeg(ctx, -2.8, -10.2, 11.4, -4.6, m.woodMid, 1.15);
  // 桥头小阵营标旗
  strokeSeg(ctx, -11.2, -2.0, -11.2, -10.2, m.woodDark, 1.0);
  poly(ctx, [[-11.0, -10.0], [-7.2, -8.8], [-11.0, -7.6]], pal.mid, m.edge, 0.45);
}

export const ERA1_UNIT_SPECS: Readonly<Record<string, Era1UnitSpec>> = {
  ge: { paint: paintGe, hitTop: 29 },
  archer: { paint: paintArcher, hitTop: 27 },
  scout: { paint: paintScout, hitTop: 24 },
  farmer: { paint: paintFarmer, hitTop: 26 },
  herder: { paint: paintHerder, ringRx: 10.6, ringRy: 4.5, hitTop: 27 },
  laborer: { paint: paintLaborer, hitTop: 27 },
  boat: { paint: paintBoat, waterUnit: true, barY: 5.2, hitTop: 20 },
  ferry: { paint: paintFerry, waterUnit: true, barY: 6.0, hitTop: 22 },
  tower: { paint: paintTower, ringRx: 11.4, ringRy: 4.9, barY: 5.6, hitTop: 34 },
  mill: { paint: paintMill, ringRx: 11.8, ringRy: 5.1, barY: 5.6, hitTop: 30 },
  camp: { paint: paintCamp, ringRx: 12.4, ringRy: 5.4, barY: 6.2, hitTop: 26 },
  bridge: { paint: paintBridge, waterUnit: true, barY: 6.2, hitTop: 18 },
};

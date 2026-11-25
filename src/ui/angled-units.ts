/**
 * 斜俯视（侧俯视）3D 微缩沙盘兵种美术绘制模块。
 *
 * 美术定位：参考《陷阵之志》（Into the Breach）与《旗帜的传说》的写实微缩战棋质感：
 * - **去 Q 版、去廉价黑粗描边**：采用真实比例（约 4.8 头身）与克制微细轮廓（0.7px 深褐暗边），
 *   内部结构靠西北受光 / 东南背光的 3~4 阶色相偏移块面塑形，与地形地貌及八时代城池无缝融合；
 * - **严格匹配时代与造价层级**：青铜时代「民兵」（25 金）表现为 2 人错落编组的轻装征召乡勇——
 *   无头盔、无护甲、无盾牌、无披风，仅着粗麻短褐、系阵营布巾与斜肩布带、双手持削尖长木矛（麻绳绑原始小铜镞），
 *   为后续戈兵、重步兵、骑士等装备齐全的精锐兵种留出清晰阶梯与剪影辨识空间。
 */

import type { PlayerId } from '../core/types.ts';

export interface AngledUnitPaintOpts {
  typeId: string;
  owner: PlayerId;
  hp: number;
  maxHp: number;
  extraHp?: number;
  selected: boolean;
  target: boolean;
  dim: boolean;
  isMine: boolean;
  spent: boolean;
  moved: boolean;
  airborne: boolean;
  /** 透视缩放系数（近大远小） */
  scale: number;
  /** 局部锚点（格心脚底坐标，已由调用方完成透视投影） */
  x: number;
  y: number;
  /** 朝向：1 = 面向右前，-1 = 面向左前 */
  facing: 1 | -1;
}

interface TeamClothPalette {
  lit: string;
  mid: string;
  shade: string;
  ring: string;
  ringFill: string;
}

const TEAM_PALETTES: Record<PlayerId, TeamClothPalette> = {
  A: {
    lit: '#c95c4e',
    mid: '#9f3d33',
    shade: '#68231c',
    ring: 'rgba(176, 66, 56, 0.78)',
    ringFill: 'rgba(176, 66, 56, 0.14)',
  },
  B: {
    lit: '#568ec2',
    mid: '#31628f',
    shade: '#1c3c5c',
    ring: 'rgba(49, 98, 143, 0.80)',
    ringFill: 'rgba(49, 98, 143, 0.15)',
  },
  C: {
    lit: '#679c5f',
    mid: '#43733e',
    shade: '#274724',
    ring: 'rgba(67, 115, 62, 0.78)',
    ringFill: 'rgba(67, 115, 62, 0.14)',
  },
  D: {
    lit: '#cfa444',
    mid: '#a17722',
    shade: '#664810',
    ring: 'rgba(161, 119, 34, 0.80)',
    ringFill: 'rgba(161, 119, 34, 0.15)',
  },
};

const DIM_PALETTE: TeamClothPalette = {
  lit: '#9a958b',
  mid: '#78736a',
  shade: '#504c45',
  ring: 'rgba(116, 110, 100, 0.62)',
  ringFill: 'rgba(106, 100, 90, 0.10)',
};

const SUPPORTED_UNIT_ART = new Set<string>(['militia']);

export function hasAngledUnitArt(typeId: string): boolean {
  return SUPPORTED_UNIT_ART.has(typeId);
}

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

/**
 * 绘制单个写实比例（约 4.8 头身）青铜时代征召民兵：
 * - 锚点 (0, 0) 为双脚站立中心，总高约 21px（无头盔、无盾、无甲、无披风）
 * - variant = 0：前排警戒斜持长木矛（微前倾突刺架势）
 * - variant = 1：后排稳步竖斜持矛（高举略后仰，与前排形成自然兵阵层次）
 */
function drawLevySoldier(
  ctx: CanvasRenderingContext2D,
  pal: TeamClothPalette,
  dim: boolean,
  variant: 0 | 1,
): void {
  // 低饱和写实粗麻、暖肤、深棕发、原木、暗铜色板（与沙盘地形同源）
  const edge = dim ? 'rgba(42, 39, 35, 0.65)' : 'rgba(38, 32, 24, 0.72)';
  const hempLit = dim ? '#c7c2b7' : '#ddd3bc';
  const hempMid = dim ? '#aba599' : '#bfb297';
  const hempShade = dim ? '#837e74' : '#8f8168';
  const pantsMid = dim ? '#7c776e' : '#7b6c55';
  const pantsShade = dim ? '#5e5a53' : '#584b39';
  const wrapCol = dim ? '#969086' : '#a89a7e';
  const skinLit = dim ? '#c9bfb2' : '#e6be96';
  const skinShade = dim ? '#a3998d' : '#bc8f66';
  const hairDark = dim ? '#4d4a45' : '#3a2d22';
  const hairLit = dim ? '#69655e' : '#594534';
  const woodDark = dim ? '#5e584e' : '#5c4126';
  const woodMid = dim ? '#7d7569' : '#856039';
  const woodLit = dim ? '#9c9487' : '#a87f50';
  const tipLit = dim ? '#bdb5a4' : '#d6bc7c';
  const tipShade = dim ? '#7e786c' : '#8c723a';

  // 1. 东南向微缩长投影（与松树、城池严格一致的西北受光投影方向）
  ctx.fillStyle = 'rgba(28, 23, 17, 0.34)';
  ctx.beginPath();
  ctx.ellipse(2.0, 0.6, 4.6, 2.0, 0.14, 0, Math.PI * 2);
  ctx.fill();

  // 2. 双腿与麻布绑腿、草鞋（细长写实比例，稳健前后跨步）
  const stride = variant === 0 ? 1.0 : 0.75;
  // 后腿（深影侧）
  poly(ctx, [
    [-2.1, -7.8], [-0.4, -7.8], [-1.3 * stride - 1.1, -2.5], [-2.7 * stride - 0.9, -2.7],
  ], pantsShade, edge, 0.55);
  // 后小腿绑腿与脚
  poly(ctx, [
    [-2.7 * stride - 0.9, -2.9], [-1.3 * stride - 1.1, -2.7], [-1.5 * stride - 1.2, -0.2], [-2.9 * stride - 1.1, -0.4],
  ], wrapCol, edge, 0.55);
  poly(ctx, [
    [-3.1 * stride - 1.1, -0.6], [-1.0 * stride - 0.9, -0.5], [-0.8 * stride - 0.8, 0.4], [-3.2 * stride - 1.1, 0.3],
  ], woodDark);

  // 前腿（受光微亮）
  poly(ctx, [
    [0.0, -7.6], [1.9, -7.6], [2.2 * stride + 0.5, -2.2], [0.5 * stride + 0.4, -2.4],
  ], pantsMid, edge, 0.55);
  // 前小腿绑腿与草鞋
  poly(ctx, [
    [0.5 * stride + 0.4, -2.5], [2.1 * stride + 0.5, -2.3], [2.4 * stride + 0.4, 0.2], [0.7 * stride + 0.4, 0.2],
  ], hempMid, edge, 0.55);
  poly(ctx, [
    [0.6 * stride + 0.4, -0.2], [3.0 * stride + 0.6, -0.1], [3.2 * stride + 0.6, 0.8], [0.6 * stride + 0.4, 0.8],
  ], woodDark);

  // 3. 粗麻短褐躯干（微前倾，自然窄肩收腰，绝非胖方盒）
  const lean = variant === 0 ? 0.6 : 0.1;
  // 下摆开叉布裾
  poly(ctx, [
    [-2.6, -9.8], [2.4, -9.8], [3.0, -6.5], [-2.9, -6.8],
  ], hempMid, edge, 0.65);
  poly(ctx, [
    [-2.5, -9.6], [0.3, -9.6], [0.1, -6.7], [-2.7, -6.9],
  ], hempLit);
  poly(ctx, [
    [0.9, -9.6], [2.3, -9.6], [2.8, -6.6], [1.1, -6.7],
  ], hempShade);

  // 上身无袖粗麻短褐
  poly(ctx, [
    [-2.7 + lean, -15.4], [2.3 + lean, -15.2], [2.5, -9.6], [-2.5, -9.6],
  ], hempMid, edge, 0.7);
  // 西北受光左胸与肩
  poly(ctx, [
    [-2.5 + lean, -15.2], [0.3 + lean, -15.1], [0.0, -9.8], [-2.3, -9.8],
  ], hempLit);
  // 东南背光右肋
  poly(ctx, [
    [0.9 + lean, -15.0], [2.1 + lean, -15.0], [2.3, -9.8], [1.0, -9.8],
  ], hempShade);

  // 4. 阵营辨识核心：斜跨肩部的粗布阵营带 + 麻绳腰带（朴素却一眼分敌我）
  poly(ctx, [
    [-2.4 + lean, -15.3], [-0.4 + lean, -15.3], [2.4, -10.0], [0.8, -9.8],
  ], pal.mid);
  poly(ctx, [
    [-2.3 + lean, -15.2], [-1.1 + lean, -15.2], [0.9, -11.4], [0.0, -11.4],
  ], pal.lit);
  poly(ctx, [
    [0.8, -11.4], [1.7, -11.4], [2.3, -10.1], [1.2, -10.0],
  ], pal.shade);
  // 朴素麻绳腰带
  poly(ctx, [
    [-2.6, -10.2], [2.5, -10.0], [2.5, -9.2], [-2.6, -9.4],
  ], woodDark);

  // 5. 后臂（持矛后手，自然肤色无护臂）
  poly(ctx, [
    [-2.6 + lean, -14.8], [-1.3 + lean, -14.6], [-2.2, -10.8], [-3.6, -11.2],
  ], skinLit, edge, 0.55);

  // 6. 写实比例小头颅 + 束发粗布阵营抹额（无头盔！彻底区别于后续铁甲正规军）
  const hx = lean * 1.15;
  const hy = -18.0;
  // 颈部暗影
  poly(ctx, [[hx - 0.8, -16.0], [hx + 0.9, -16.0], [hx + 0.9, -14.9], [hx - 0.8, -14.9]], skinShade);
  // 脸部轮廓（紧凑写实鹅蛋形）
  poly(ctx, [
    [hx - 1.7, hy - 1.3],
    [hx + 1.5, hy - 1.3],
    [hx + 1.8, hy + 0.5],
    [hx + 0.9, hy + 2.1],
    [hx - 1.1, hy + 2.1],
    [hx - 1.8, hy + 0.6],
  ], skinLit, edge, 0.65);
  // 右半脸东南暗影面
  poly(ctx, [
    [hx + 0.2, hy - 1.1],
    [hx + 1.4, hy - 1.1],
    [hx + 1.6, hy + 0.5],
    [hx + 0.8, hy + 1.9],
    [hx + 0.1, hy + 1.9],
  ], skinShade);
  // 蓬松深棕束发（头顶与后脑发髻）
  poly(ctx, [
    [hx - 2.2, hy - 0.8],
    [hx - 1.9, hy - 2.6],
    [hx + 0.4, hy - 3.1],
    [hx + 1.9, hy - 2.1],
    [hx + 1.7, hy - 0.9],
    [hx - 0.6, hy - 1.1],
  ], hairDark, edge, 0.6);
  // 发顶受光微亮
  poly(ctx, [
    [hx - 1.7, hy - 2.3], [hx + 0.2, hy - 2.8], [hx + 0.4, hy - 1.8], [hx - 1.6, hy - 1.5],
  ], hairLit);
  // 脑后小发髻
  poly(ctx, [
    [hx - 2.9, hy - 1.8], [hx - 1.8, hy - 2.4], [hx - 1.6, hy - 0.9], [hx - 2.7, hy - 0.7],
  ], hairDark, edge, 0.5);
  // 阵营额带（窄布巾 + 脑后飘带尾端，轻灵利落）
  poly(ctx, [
    [hx - 2.0, hy - 1.4], [hx + 1.8, hy - 1.4], [hx + 1.8, hy - 0.4], [hx - 2.0, hy - 0.4],
  ], pal.mid);
  poly(ctx, [
    [hx - 1.9, hy - 1.3], [hx + 0.2, hy - 1.3], [hx + 0.2, hy - 0.5], [hx - 1.9, hy - 0.5],
  ], pal.lit);
  // 飘带小尾
  poly(ctx, [
    [hx - 2.1, hy - 1.1], [hx - 3.7, hy - 0.1], [hx - 3.3, hy + 0.6], [hx - 1.9, hy - 0.4],
  ], pal.shade);

  // 7. 朴素长木矛（削尖原木长杆 + 麻绳扎原始小铜镞，无旗穗、无华饰）
  const sx0 = variant === 0 ? -7.2 : -5.6;
  const sy0 = variant === 0 ? -8.6 : -7.2;
  const sx1 = variant === 0 ? 9.8 : 7.6;
  const sy1 = variant === 0 ? -18.8 : -23.8;

  ctx.lineCap = 'round';
  // 微细暗边 + 原木杆身 + 上缘受光线
  ctx.beginPath();
  ctx.moveTo(sx0, sy0);
  ctx.lineTo(sx1, sy1);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2.0;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(sx0, sy0);
  ctx.lineTo(sx1, sy1);
  ctx.strokeStyle = woodMid;
  ctx.lineWidth = 1.15;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(sx0 + 0.3, sy0 - 0.35);
  ctx.lineTo(sx1 - 0.4, sy1 - 0.35);
  ctx.strokeStyle = woodLit;
  ctx.lineWidth = 0.45;
  ctx.stroke();

  // 麻绳扎结 + 原始小青铜/燧石矛尖（沿矛杆方向精确延展）
  const dx = sx1 - sx0;
  const dy = sy1 - sy0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const tipEnd: readonly [number, number] = [sx1 + ux * 4.2, sy1 + uy * 4.2];
  const tipL: readonly [number, number] = [sx1 + ux * 0.9 + px * 1.15, sy1 + uy * 0.9 + py * 1.15];
  const tipR: readonly [number, number] = [sx1 + ux * 0.9 - px * 1.15, sy1 + uy * 0.9 - py * 1.15];
  const tipBase: readonly [number, number] = [sx1 - ux * 0.4, sy1 - uy * 0.4];

  poly(ctx, [tipBase, tipL, tipEnd, tipR], tipShade, edge, 0.55);
  poly(ctx, [tipBase, tipL, tipEnd], tipLit);
  // 麻绳缠绕结
  ctx.beginPath();
  ctx.moveTo(sx1 - ux * 0.9 + px * 0.9, sy1 - uy * 0.9 + py * 0.9);
  ctx.lineTo(sx1 - ux * 0.9 - px * 0.9, sy1 - uy * 0.9 - py * 0.9);
  ctx.strokeStyle = hempMid;
  ctx.lineWidth = 1.25;
  ctx.stroke();

  // 8. 前臂与前手（双手稳握木矛）
  const gripX = sx0 + dx * 0.55;
  const gripY = sy0 + dy * 0.55;
  poly(ctx, [
    [1.2 + lean, -14.6], [2.4 + lean, -14.2], [gripX + 0.8, gripY + 0.6], [gripX - 0.7, gripY - 0.5],
  ], skinShade, edge, 0.55);
  poly(ctx, [
    [1.2 + lean, -14.5], [1.9 + lean, -14.3], [gripX + 0.1, gripY + 0.1], [gripX - 0.5, gripY - 0.4],
  ], skinLit);
  // 前后握矛手掌
  ctx.fillStyle = skinLit;
  ctx.beginPath();
  ctx.arc(gripX, gripY, 1.05, 0, Math.PI * 2);
  ctx.fill();
  const rearGripX = sx0 + dx * 0.25;
  const rearGripY = sy0 + dy * 0.25;
  ctx.fillStyle = skinShade;
  ctx.beginPath();
  ctx.arc(rearGripX, rearGripY, 1.0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 绘制指定兵种的斜俯视微缩模型 + 底座战术标识 + 血条/行动点/选中与目标准星。
 * 返回用于命中检测的屏幕空间凸四边形（由调用方写入 `faces`）。
 */
export function paintAngledUnit(
  ctx: CanvasRenderingContext2D,
  opts: AngledUnitPaintOpts,
): readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]] {
  const { x, y, scale, owner, dim, selected, target, isMine, spent, moved, hp, maxHp, extraHp, facing } = opts;
  const pal = dim ? DIM_PALETTE : (TEAM_PALETTES[owner] ?? TEAM_PALETTES.A);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // 1. 克制的桌面战棋脚底阵营/选中/受击光环（细线低饱和，不抢地面与兵偶风头）
  ctx.beginPath();
  ctx.ellipse(0, 0.6, selected || target ? 11.4 : 9.8, selected || target ? 5.0 : 4.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected
    ? 'rgba(210, 236, 248, 0.58)'
    : target
      ? 'rgba(248, 224, 214, 0.58)'
      : pal.ringFill;
  ctx.fill();
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : pal.ring;
  ctx.lineWidth = selected || target ? 1.85 : 1.05;
  ctx.stroke();

  // 2. 双人错落征召民兵小组（按前后景深度先绘后排、再绘前排，按阵营朝向对峙）
  ctx.save();
  if (dim) ctx.globalAlpha = 0.72;
  ctx.scale(facing, 1);

  // 后排民兵（略靠后上方，高斜持矛）
  ctx.save();
  ctx.translate(-3.6, -2.8);
  ctx.scale(0.95, 0.95);
  drawLevySoldier(ctx, pal, dim, 1);
  ctx.restore();

  // 前排民兵（略靠前下方，前倾平举短矛护阵）
  ctx.save();
  ctx.translate(3.4, 1.5);
  ctx.scale(1.02, 1.02);
  drawLevySoldier(ctx, pal, dim, 0);
  ctx.restore();

  ctx.restore();

  // 3. 受击目标红色角标准星
  if (target) {
    ctx.strokeStyle = '#c4322b';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    const drawCorner = (cx: number, cy: number, sx: number, sy: number) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * 4.8);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * 4.8, cy);
      ctx.stroke();
    };
    drawCorner(-13.2, -26.5, 1, 1);
    drawCorner(13.2, -26.5, -1, 1);
    drawCorner(-13.2, 3.2, 1, -1);
    drawCorner(13.2, 3.2, -1, -1);
  }

  // 4. 纤细战术血条 + 额外护盾条 + 己方可行动状态点（始终正立）
  const barW = 19;
  const barH = 2.6;
  const barX = -barW / 2;
  const barY = 4.4;
  ctx.fillStyle = 'rgba(28, 25, 20, 0.88)';
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
    ctx.fillRect(barX, barY - 2.1, Math.min(barW, barW * (extraHp / Math.max(1, maxHp))), 1.5);
  }

  // 己方可行动小圆点（绿 = 可走可打，橙 = 已走仍可打）
  if (isMine && !spent) {
    ctx.beginPath();
    ctx.arc(barX - 3.3, barY + barH / 2, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = moved ? '#de922c' : '#46a85d';
    ctx.fill();
    ctx.strokeStyle = '#fdfaf2';
    ctx.lineWidth = 0.85;
    ctx.stroke();
  }

  ctx.restore();

  const hw = 13 * scale;
  const hTop = 27 * scale;
  const hBot = 7 * scale;
  return [
    [x - hw, y - hTop],
    [x + hw, y - hTop],
    [x + hw, y + hBot],
    [x - hw, y + hBot],
  ];
}

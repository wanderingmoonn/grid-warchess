/**
 * 斜俯视（侧俯视）3D 微缩沙盘兵种美术绘制模块。
 *
 * 美术定位：参考《陷阵之志》（Into the Breach）的微缩桌面战棋风格，
 * 与 `angled-board.ts` 的地形地貌及八时代城池共用同一套受光法则（西北受光、东南背光）、
 * 暖炭墨外描边（#221f1a）与低饱和温润沙盘色板，确保在 1× 全局视野下剪影一秒可辨，
 * 放大至 2×/3× 后装备材质与光影层次依然扎实耐看。
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

interface TeamPalette {
  lit: string;
  mid: string;
  shade: string;
  ring: string;
  ringFill: string;
  trim: string;
}

const TEAM_PALETTES: Record<PlayerId, TeamPalette> = {
  A: {
    lit: '#de6b5d',
    mid: '#b4453a',
    shade: '#7c2b23',
    ring: '#b4453a',
    ringFill: 'rgba(180, 69, 58, 0.18)',
    trim: '#f0c866',
  },
  B: {
    lit: '#619ed1',
    mid: '#346b99',
    shade: '#1f4466',
    ring: '#346b99',
    ringFill: 'rgba(52, 107, 153, 0.18)',
    trim: '#ebdcb2',
  },
  C: {
    lit: '#76ae6c',
    mid: '#4d8246',
    shade: '#2f542a',
    ring: '#4d8246',
    ringFill: 'rgba(77, 130, 70, 0.18)',
    trim: '#ecd37d',
  },
  D: {
    lit: '#dfb44f',
    mid: '#b08328',
    shade: '#745314',
    ring: '#b08328',
    ringFill: 'rgba(176, 131, 40, 0.20)',
    trim: '#f5ebd1',
  },
};

const DIM_PALETTE: TeamPalette = {
  lit: '#a8a296',
  mid: '#827c70',
  shade: '#59554c',
  ring: '#827c70',
  ringFill: 'rgba(110, 104, 94, 0.16)',
  trim: '#cfc7b4',
};

const INK = '#221f1a';
const SUPPORTED_UNIT_ART = new Set<string>(['militia']);

export function hasAngledUnitArt(typeId: string): boolean {
  return SUPPORTED_UNIT_ART.has(typeId);
}

function fillStrokePoly(
  ctx: CanvasRenderingContext2D,
  pts: ReadonlyArray<readonly [number, number]>,
  fill: string,
  stroke?: string,
  lw = 1.15,
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
 * 青铜时代「民兵」（militia）：
 * - 造型：3/4 侧俯视备战微缩兵偶（微壮比例 + 醒目硬朗暗墨轮廓，参考《陷阵之志》）
 * - 装备：青铜圆顶护颊兜鍪 + 阵营顶缨、麻布衬衣与阵营短袍、铜扣皮带、
 *         右手斜举木柄青铜叶形短矛（挂阵营小穗）、左手前持铜边木圆盾（带阵营盾徽与凸起铜盾脐）
 * - 受光：严格沿用场景西北受光、东南背光的两档平涂明暗
 */
function drawMilitiaBody(ctx: CanvasRenderingContext2D, pal: TeamPalette, dim: boolean): void {
  const bronzeLit = dim ? '#c7beaa' : '#ead18d';
  const bronzeMid = dim ? '#9e9684' : '#c7a24f';
  const bronzeShade = dim ? '#6f695c' : '#876729';
  const skinLit = dim ? '#cfc2b0' : '#f0cba4';
  const skinShade = dim ? '#a69887' : '#cc9c72';
  const leatherLit = dim ? '#9c9284' : '#a87d4c';
  const leatherMid = dim ? '#7c7468' : '#855d34';
  const leatherShade = dim ? '#575149' : '#583c20';
  const linenLit = dim ? '#d2cdc1' : '#eee5cf';
  const linenShade = dim ? '#a8a296' : '#c6b99c';
  const spearWood = dim ? '#7c7366' : '#7b552f';
  const spearWoodLit = dim ? '#9c9284' : '#a87c4b';

  // 1. 背后短披风/肩巾（增强冲锋动势与阵营辨识面积）
  fillStrokePoly(
    ctx,
    [
      [-3.5, -18.5],
      [-8.8, -12.8],
      [-7.6, -6.2],
      [-2.0, -7.8],
    ],
    pal.shade,
    INK,
    1.15,
  );
  fillStrokePoly(
    ctx,
    [
      [-3.6, -18.0],
      [-7.8, -13.2],
      [-5.6, -10.8],
      [-2.8, -14.2],
    ],
    pal.mid,
  );

  // 2. 右后臂 + 斜举木柄青铜短矛（从左腰斜指右上方，形成一眼可辨的近战步兵剪影）
  // 矛杆（先描深墨外框，再铺暖木色杆身与受光边）
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-10.2, -8.2);
  ctx.lineTo(8.8, -24.4);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3.2;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-10.2, -8.2);
  ctx.lineTo(8.8, -24.4);
  ctx.strokeStyle = spearWood;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-9.6, -8.8);
  ctx.lineTo(8.0, -24.0);
  ctx.strokeStyle = spearWoodLit;
  ctx.lineWidth = 0.65;
  ctx.stroke();

  // 矛下小旗穗（阵营色点缀，动态感十足）
  fillStrokePoly(
    ctx,
    [
      [6.4, -22.2],
      [9.4, -19.2],
      [6.8, -17.6],
      [4.9, -20.6],
    ],
    pal.mid,
    INK,
    0.9,
  );
  fillStrokePoly(
    ctx,
    [
      [6.4, -22.0],
      [8.2, -20.0],
      [6.4, -19.4],
      [5.5, -20.9],
    ],
    pal.lit,
  );

  // 叶形青铜矛头（受光亮面 + 背光暗面 + 中脊）
  fillStrokePoly(
    ctx,
    [
      [7.4, -23.3],
      [13.4, -28.9],
      [11.3, -24.2],
      [9.1, -21.9],
    ],
    bronzeShade,
    INK,
    1.1,
  );
  fillStrokePoly(
    ctx,
    [
      [7.5, -23.4],
      [13.2, -28.7],
      [9.2, -25.4],
    ],
    bronzeLit,
  );
  // 矛头金属高光边
  ctx.beginPath();
  ctx.moveTo(8.6, -24.6);
  ctx.lineTo(12.6, -28.2);
  ctx.strokeStyle = dim ? '#e2dccf' : '#fff6d6';
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // 后手握矛拳头
  ctx.beginPath();
  ctx.arc(-5.2, -12.3, 2.0, 0, Math.PI * 2);
  ctx.fillStyle = skinShade;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.05;
  ctx.stroke();

  // 3. 双腿与厚底皮靴（稳健 3/4 弓箭步站姿）
  // 后腿（左脚）
  fillStrokePoly(
    ctx,
    [
      [-4.8, -6.2],
      [-1.4, -6.2],
      [-2.1, -1.6],
      [-5.6, -1.8],
    ],
    leatherShade,
    INK,
    1.1,
  );
  // 后脚靴头
  fillStrokePoly(
    ctx,
    [
      [-6.0, -2.0],
      [-1.5, -2.0],
      [-1.2, 0.2],
      [-6.2, 0.0],
    ],
    leatherMid,
    INK,
    1.1,
  );

  // 前腿（右脚）
  fillStrokePoly(
    ctx,
    [
      [0.4, -6.0],
      [4.2, -6.0],
      [4.6, -1.0],
      [1.0, -1.0],
    ],
    leatherMid,
    INK,
    1.1,
  );
  // 前脚靴头（带微受光鞋面）
  fillStrokePoly(
    ctx,
    [
      [0.8, -1.4],
      [5.8, -1.2],
      [6.2, 1.0],
      [0.8, 1.0],
    ],
    leatherLit,
    INK,
    1.1,
  );

  // 4. 下摆麻布裙甲与阵营短袍躯干
  // 麻布下摆
  fillStrokePoly(
    ctx,
    [
      [-5.5, -8.8],
      [5.2, -8.8],
      [5.8, -4.6],
      [-5.8, -4.8],
    ],
    linenShade,
    INK,
    1.1,
  );
  fillStrokePoly(
    ctx,
    [
      [-5.2, -8.5],
      [1.6, -8.5],
      [1.2, -5.0],
      [-5.3, -5.1],
    ],
    linenLit,
  );

  // 躯干阵营短袍（宽肩微收腰，桌面战棋雕塑感）
  fillStrokePoly(
    ctx,
    [
      [-5.8, -18.2],
      [4.8, -18.2],
      [5.2, -8.8],
      [-5.4, -8.8],
    ],
    pal.mid,
    INK,
    1.25,
  );
  // 左肩与胸口西北受光面
  fillStrokePoly(
    ctx,
    [
      [-5.4, -17.8],
      [0.8, -17.8],
      [0.4, -9.2],
      [-5.0, -9.2],
    ],
    pal.lit,
  );
  // 右肋东南背光面
  fillStrokePoly(
    ctx,
    [
      [1.6, -17.8],
      [4.4, -17.8],
      [4.7, -9.2],
      [1.8, -9.2],
    ],
    pal.shade,
  );

  // 护肩皮甲片（左肩亮面）
  fillStrokePoly(
    ctx,
    [
      [-6.5, -17.8],
      [-2.2, -18.6],
      [-2.0, -14.8],
      [-6.4, -14.4],
    ],
    leatherLit,
    INK,
    1.05,
  );
  // 斜跨皮带与腰间青铜扣
  fillStrokePoly(
    ctx,
    [
      [-5.4, -10.5],
      [5.1, -10.5],
      [5.2, -8.5],
      [-5.4, -8.5],
    ],
    leatherShade,
    INK,
    0.95,
  );
  fillStrokePoly(
    ctx,
    [
      [-1.4, -10.7],
      [1.6, -10.7],
      [1.6, -8.3],
      [-1.4, -8.3],
    ],
    bronzeLit,
    INK,
    0.85,
  );

  // 5. 头部与青铜圆顶兜鍪（干净利落的大众微缩审美）
  // 脸颊与下颌（柔和光影，不画容易糊掉的细碎五官）
  ctx.beginPath();
  ctx.roundRect(-3.6, -23.0, 7.0, 5.4, 2.2);
  ctx.fillStyle = skinLit;
  ctx.fill();
  // 脸部右侧微暗阴影 + 头盔檐下投影
  fillStrokePoly(
    ctx,
    [
      [0.6, -22.8],
      [3.3, -22.8],
      [3.3, -17.8],
      [0.8, -17.8],
    ],
    skinShade,
  );
  fillStrokePoly(
    ctx,
    [
      [-3.5, -22.8],
      [3.3, -22.8],
      [3.3, -21.2],
      [-3.5, -21.2],
    ],
    'rgba(48, 34, 24, 0.28)',
  );
  ctx.beginPath();
  ctx.roundRect(-3.6, -23.0, 7.0, 5.4, 2.2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.15;
  ctx.stroke();

  // 头盔顶部阵营绒缨（提升头顶辨识度与灵气）
  fillStrokePoly(
    ctx,
    [
      [-1.4, -27.4],
      [0.4, -30.5],
      [2.0, -28.0],
      [0.2, -26.8],
    ],
    pal.mid,
    INK,
    1.0,
  );
  fillStrokePoly(
    ctx,
    [
      [-0.8, -27.6],
      [0.4, -29.9],
      [0.8, -27.8],
    ],
    pal.lit,
  );

  // 青铜兜鍪主帽体（微尖圆顶 + 护耳护颊）
  ctx.beginPath();
  ctx.moveTo(-5.2, -21.6);
  ctx.quadraticCurveTo(-4.8, -27.2, -0.2, -28.2);
  ctx.quadraticCurveTo(4.6, -27.2, 4.9, -21.6);
  ctx.lineTo(3.6, -20.2);
  ctx.lineTo(2.0, -21.5);
  ctx.lineTo(-2.6, -21.5);
  ctx.lineTo(-4.4, -19.8);
  ctx.closePath();
  ctx.fillStyle = bronzeMid;
  ctx.fill();
  // 兜鍪西北高光块
  ctx.beginPath();
  ctx.moveTo(-4.6, -22.0);
  ctx.quadraticCurveTo(-4.0, -26.5, -0.3, -27.5);
  ctx.lineTo(-0.5, -21.8);
  ctx.closePath();
  ctx.fillStyle = bronzeLit;
  ctx.fill();
  // 兜鍪东南背光块
  ctx.beginPath();
  ctx.moveTo(1.2, -27.2);
  ctx.quadraticCurveTo(4.2, -26.2, 4.5, -21.8);
  ctx.lineTo(1.6, -21.8);
  ctx.closePath();
  ctx.fillStyle = bronzeShade;
  ctx.fill();
  // 兜鍪额沿铜箍与轮廓
  ctx.beginPath();
  ctx.moveTo(-5.2, -21.6);
  ctx.quadraticCurveTo(-4.8, -27.2, -0.2, -28.2);
  ctx.quadraticCurveTo(4.6, -27.2, 4.9, -21.6);
  ctx.lineTo(3.6, -20.2);
  ctx.lineTo(2.0, -21.5);
  ctx.lineTo(-2.6, -21.5);
  ctx.lineTo(-4.4, -19.8);
  ctx.closePath();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 盔顶金属高光点
  ctx.beginPath();
  ctx.ellipse(-2.0, -25.1, 1.4, 0.75, -0.55, 0, Math.PI * 2);
  ctx.fillStyle = dim ? '#e6e0d4' : '#fff8dc';
  ctx.fill();

  // 6. 前手青铜包边木圆盾（处于最前景，塑造厚实坚固的“民兵盾矛”轮廓）
  ctx.save();
  ctx.translate(4.8, -11.8);
  ctx.rotate(-0.08);
  // 盾牌厚度侧边（3D 立体感）
  ctx.beginPath();
  ctx.ellipse(1.0, 0.5, 5.6, 6.7, 0, 0, Math.PI * 2);
  ctx.fillStyle = bronzeShade;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.15;
  ctx.stroke();

  // 盾牌正面外框（青铜包边）
  ctx.beginPath();
  ctx.ellipse(0, 0, 5.4, 6.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = bronzeMid;
  ctx.fill();
  // 左上包边亮弧
  ctx.beginPath();
  ctx.ellipse(-0.4, -0.5, 4.8, 5.9, 0, Math.PI * 0.85, Math.PI * 1.9);
  ctx.strokeStyle = bronzeLit;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 盾面（暖米白底 + 醒目阵营横纹/上下双色分格）
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, 4.1, 5.2, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = linenLit;
  ctx.fillRect(-5, -6, 10, 12);
  // 阵营中带与下部色块
  ctx.fillStyle = pal.mid;
  ctx.fillRect(-5, -2.0, 10, 4.0);
  ctx.fillStyle = pal.lit;
  ctx.fillRect(-5, -2.0, 4.8, 4.0);
  ctx.fillStyle = pal.shade;
  ctx.fillRect(1.5, -2.0, 4.0, 4.0);
  // 盾面右下柔暗
  ctx.fillStyle = 'rgba(30, 24, 18, 0.14)';
  ctx.fillRect(0.6, -6, 5, 12);
  ctx.restore();

  // 盾牌外墨线
  ctx.beginPath();
  ctx.ellipse(0, 0, 5.4, 6.6, 0, 0, Math.PI * 2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 盾心立体青铜圆脐 + 闪亮点
  ctx.beginPath();
  ctx.ellipse(0, 0, 1.95, 2.25, 0, 0, Math.PI * 2);
  ctx.fillStyle = bronzeLit;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.95;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-0.55, -0.65, 0.65, 0, Math.PI * 2);
  ctx.fillStyle = dim ? '#e6e0d4' : '#fff8dc';
  ctx.fill();
  ctx.restore();
}

/**
 * 绘制指定兵种的斜俯视微缩模型 + 底座阵营光环 + 血条/行动点/选中与目标准星。
 * 返回用于命中检测的屏幕空间凸四边形（由调用方写入 `faces`）。
 */
export function paintAngledUnit(
  ctx: CanvasRenderingContext2D,
  opts: AngledUnitPaintOpts,
): readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]] {
  const { x, y, scale, owner, dim, selected, target, isMine, spent, moved, airborne, hp, maxHp, extraHp, facing } = opts;
  const pal = dim ? DIM_PALETTE : (TEAM_PALETTES[owner] ?? TEAM_PALETTES.A);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // 1. 底座阴影与阵营/选中/受击战术环
  ctx.fillStyle = airborne ? 'rgba(38, 32, 24, 0.28)' : 'rgba(32, 26, 18, 0.42)';
  ctx.beginPath();
  ctx.ellipse(0, airborne ? 6.5 : 1.4, airborne ? 9.5 : 10.6, airborne ? 3.4 : 4.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // 战术脚底环（保证所有地形上阵营色一秒可分）
  ctx.beginPath();
  ctx.ellipse(0, 0.8, selected || target ? 11.4 : 9.8, selected || target ? 4.9 : 4.1, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected
    ? 'rgba(220, 239, 246, 0.68)'
    : target
      ? 'rgba(250, 232, 223, 0.68)'
      : pal.ringFill;
  ctx.fill();
  ctx.strokeStyle = selected ? '#1f6c96' : target ? '#c4322b' : pal.ring;
  ctx.lineWidth = selected || target ? 2.2 : 1.35;
  ctx.stroke();

  // 2. 兵偶主体（按阵营方向水平镜像，交战双方自然相对）
  ctx.save();
  if (dim) ctx.globalAlpha = 0.80;
  ctx.scale(facing, 1);
  drawMilitiaBody(ctx, pal, dim);
  ctx.restore();

  // 3. 受击目标红色角标准星
  if (target) {
    ctx.strokeStyle = '#c4322b';
    ctx.lineWidth = 1.65;
    ctx.lineCap = 'round';
    const drawCorner = (cx: number, cy: number, sx: number, sy: number) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * 5.2);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * 5.2, cy);
      ctx.stroke();
    };
    drawCorner(-13.5, -30.5, 1, 1);
    drawCorner(13.5, -30.5, -1, 1);
    drawCorner(-13.5, 2.5, 1, -1);
    drawCorner(13.5, 2.5, -1, -1);
  }

  // 4. 紧凑战术血条 + 额外护盾条 + 己方可行动状态点（始终正立不镜像）
  const barW = 20;
  const barH = 3.0;
  const barX = -barW / 2;
  const barY = 3.8;
  ctx.fillStyle = '#24211c';
  ctx.beginPath();
  ctx.roundRect(barX - 1, barY - 1, barW + 2, barH + 2, 1.5);
  ctx.fill();

  const ratio = Math.max(0, Math.min(1, maxHp > 0 ? hp / maxHp : 1));
  ctx.fillStyle = '#575046';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = ratio > 0.5 ? '#58a86b' : ratio > 0.25 ? '#d99838' : '#cf4c42';
  ctx.fillRect(barX, barY, barW * ratio, barH);

  if (extraHp && extraHp > 0) {
    ctx.fillStyle = '#47b4e6';
    ctx.fillRect(barX, barY - 2.3, Math.min(barW, barW * (extraHp / Math.max(1, maxHp))), 1.7);
  }

  // 己方可行动高亮小圆点（绿 = 可走可打，橙 = 已走仍可打）
  if (isMine && !spent) {
    ctx.beginPath();
    ctx.arc(barX - 3.6, barY + barH / 2, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = moved ? '#de922c' : '#46a85d';
    ctx.fill();
    ctx.strokeStyle = '#fdfaf2';
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }

  ctx.restore();

  const hw = 13 * scale;
  const hTop = 31 * scale;
  const hBot = 7 * scale;
  return [
    [x - hw, y - hTop],
    [x + hw, y - hTop],
    [x + hw, y + hBot],
    [x - hw, y + hBot],
  ];
}

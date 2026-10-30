/**
 * 扩展规则：地形高差。
 *
 * 本体只认"这一格什么地形、加多少防御、走一格几步"。这个扩展在这之上
 * 加了三层东西：
 *
 *   1. **高度**。每类地形有一个高度（层），是所有高差规则的唯一输入；
 *   2. **高差咬住战斗与机动**：站得比目标高 2 层以上射程 +1、低 2 层以上 -1；
 *      往高处走每层多花 1 点移动力（封顶算 2 层），下坡不加价；
 *   3. **每类地形自己的脾气**（不只是数字高低）：
 *        · 熔岩  —— 能过，但回合末会烧人（5 点真伤），逼你算清"值不值得抄近路"；
 *        · 沼泽  —— 陷足，走出去那一步还要多花 1 点（进来便宜、出去难）；
 *        · 沙丘  —— 沙脊视野 +1，但没有掩体（防御只有 +1）；
 *        · 台地  —— 视野 +1、射程 +1，代价是从下面爬上来要 4 点；
 *        · 谷地  —— 视野 -1、射程 -1，但防御 +2，是"躲"的地方不是"打"的地方；
 *        · 浅流  —— 陆军唯一能涉水过去的水域，防御 -1（站在水里没处躲），
 *                   水军反而进不来（水太浅，船搁底）；
 *        · 火山  —— 整张图最高的东西，纯粹是墙。
 *
 * 关掉这个扩展：没有新地形、没有高度、没有熔岩烫人，步耗与射程与本体完全一致——
 * 所有规则都挂在这一个 Expansion 的钩子里，本体一行都不认识"高度"。
 *
 * 为什么"高度差"要放在射程钩子而不是兵种射程里：同一支弓箭手，
 * 站台地上和站谷地里射程本来就该不一样，那是**地形**的属性，
 * 写进兵种表就变成"每个兵种都要为每类地形各写一份"。
 */

import { buildContour } from './height-mapgen.ts';
import type { Expansion } from './expansions.ts';
import type { Terrain } from './types.ts';

/**
 * 高度（层）：**相对平原**的带符号层数，平原 = 0。
 *
 * 2026-10-30 改成有符号：以前是"绝对海拔"（水 0、平原 2、台地 4），
 * 差值才是规则真正读的东西，而绝对刻度逼着人每次心算减法。现在直接写差值，
 * 面板上"高 2 层"和表里的数字是同一个数。
 *
 *   valley / marsh −1 → plain（水、森林、城、桥）0 → hill / dune +1
 *   → plateau +2 → mountain +∞（站不上去）
 *
 * 浅流、水域、深水都是 0：水面和陆地基准面齐平，真正的落差来自岸线而不是水深
 * （水文上的深浅由"能不能过、大舰会不会搁浅"表达，那是另一条规则）。
 */
export const TERRAIN_HEIGHT: Record<Terrain, number> = {
  water: 0,
  deep: 0,
  shallow: 0,
  valley: -1,
  marsh: -1,
  plain: 0,
  forest: 0,
  city: 0,
  bridge: 0,
  hill: 1,
  dune: 1,
  plateau: 2,
  // 天险：任何单位都上不去，用无穷大表示"不参与算账"
  mountain: Number.POSITIVE_INFINITY,
};

/**
 * 进入这一格要额外花的行动点（E）。**地形本身的代价**，和高差无关。
 *
 * 这一列 2026-10-30 取代了原来的"基础步耗"：地形不再改移动力，
 * 改的是行动点——移动这件事在一次行动里按走过的每一格收。
 *
 *   森林 5（穿林）、丘陵 5（上坡起步）、沼泽 10 / 浅流 10 / 沙丘 10（难走）
 *   其余 0；高山不可通行
 */
export const TERRAIN_EXTRA_E: Record<Terrain, number> = {
  water: 0,
  deep: 0,
  shallow: 10,
  valley: 0,
  marsh: 10,
  plain: 0,
  forest: 5,
  city: 0,
  bridge: 0,
  hill: 5,
  dune: 10,
  plateau: 0,
  mountain: Number.POSITIVE_INFINITY,
};

/**
 * 视野 = 高度层数（森林额外 −1，树冠把天遮了一半）。
 *
 * 2026-10-30 取消了两张"地形静态修正"表里的射程那一张：射程只由**高差**决定
 * （差 2 层以上 ±1），丘陵/台地/沙丘以前那点"制高点 +1"现在由高度自然表达，
 * 再单独挂一份静态修正就是同一件事算两次。视野留着，因为森林挡视线是高度算不出来的。
 */
export const TERRAIN_VISION_MOD: Record<Terrain, number> = {
  // 水面上没有遮挡，也没有制高点
  water: 0,
  deep: 0,
  shallow: 0,
  // 洼地：被两侧坡挡住
  valley: -1,
  marsh: -1,
  // 基准面。森林是唯一"高度 0 但挡视线"的：树冠
  plain: 0,
  forest: -1,
  city: 0,
  bridge: 0,
  // 高处看得远
  hill: 1,
  dune: 1,
  plateau: 2,
  // 站不上去，写 0 只是为了让表完整
  mountain: 0,
};

/** 每往上 1 层多花多少行动点 */
export const CLIMB_E = 10;
/** 每往下 1 层少花多少行动点（下坡省力，但不会倒赚：见 stepExtraE 的钳位） */
export const DESCEND_E = 10;

/**
 * 高度差影响射程的阈值。
 *
 * 定 2 而不是 1：平原↔丘陵只差一层，那是"略高一点"，弓箭手站上去就多一格射程的话，
 * 地形会压过兵种本身的差异。
 */
export const RANGE_HEIGHT_BAND = 2;
/** 沼泽陷足：从泥里拔出脚的那一格多花多少 */
export const MARSH_BOG_E = 10;

/**
 * 从 `from` 走进 `to` 这一格，地形要多收多少行动点。
 *
 * 三段相加：目标地形自带的额外消耗 + 爬坡（每层 +10）/ 下坡（每层 −10）+ 陷足
 * （从沼泽走出去 +10）。**下坡的减免最多把这一格的地形价抹平，不会变成"走路赚钱"**，
 * 所以结果钳在 0 以上——不然从台地冲下来一路倒赚，玩家会绕着山跑圈刷 E。
 */
export function stepExtraE(from: Terrain | undefined, to: Terrain): number {
  const toExtra = TERRAIN_EXTRA_E[to] ?? 0;
  if (!Number.isFinite(toExtra)) return Number.POSITIVE_INFINITY;
  let e = toExtra;
  if (from) {
    const dh = (TERRAIN_HEIGHT[to] ?? 0) - (TERRAIN_HEIGHT[from] ?? 0);
    if (Number.isFinite(dh)) {
      if (dh > 0) e += dh * CLIMB_E;
      else if (dh < 0) e -= Math.min(-dh * DESCEND_E, toExtra);
    }
    if (from === 'marsh') e += MARSH_BOG_E;
  }
  return Math.max(0, e);
}
/** 这个扩展带来的地貌风格（地图生成器认这几个 id，各自带生成器） */
export const HEIGHT_MAP_STYLES: Array<{
  id: string;
  name: string;
  note: string;
  build: (c: Parameters<typeof buildContour>[0]) => void;
}> = [
  {
    id: 'highland',
    name: '高原',
    note: '层层递进的高地：山心、台地、丘陵、平原一圈圈铺开，俯射优势明显',
    build: (c) => buildContour(c, 'highland'),
  },
  {
    id: 'canyon',
    name: '峡谷',
    note: '一条深沟横在中间，两岸越往外越高；沟底走得快但仰攻吃亏',
    build: (c) => buildContour(c, 'canyon'),
  },
  {
    id: 'marsh',
    name: '沼泽',
    note: '低平积水，塘洼与烂地交错；走出去比走进来贵',
    build: (c) => buildContour(c, 'marsh'),
  },
  {
    id: 'isles',
    name: '群岛',
    note: '整片海隔开两军，只有几串浅滩能徒涉，其余得靠船或桥',
    build: (c) => buildContour(c, 'isles'),
  },
  {
    id: 'river',
    name: '大川',
    note: '一条大河南北（或东西）贯到底，只有几处浅滩能过，其余要架桥',
    build: (c) => buildContour(c, 'river'),
  },
];

/** 这个扩展带来的新地形（地图生成与上帝模式画笔都照这张表） */
export const HEIGHT_PAINT_TERRAINS: readonly Terrain[] = [
  'plateau',
  'valley',
  'marsh',
  'dune',
  'shallow',
];

/**
 * 收尾：给每一个山心补上"山脚"。
 *
 * 本体那五种地貌是**撒团块**的：山是一坨一坨撒出来的，团块的边缘也就是山的边缘，
 * 靠外的格子直接和平原/丘陵接壤——一步就从 2 层跨到 5 层。
 * 这个扩展的卖点是"高低差层层递进"，所以开它的时候要把这道悬崖抹成坡：
 *
 *   1. 从所有高山/火山出发做一次 4 邻 BFS，记下"离山心几格"；
 *   2. 第 1 圈抬成台地（4 层）、第 2 圈抬成丘陵（3 层）；
 *   3. 只抬平原/林地/丘陵这三类"软地面"——水、浅流、谷地、沼泽、熔岩、沙丘、
 *      城市一律不动：海边是悬崖、沟底是沟底，那些本来就该是断的。
 *
 * 于是任何一座山从外往内一定是 平原(2) → 丘陵(3) → 台地(4) → 高山(5)，
 * 每步只差一层；特征尺度也从"一格柱子"变成"三圈 5~9 格"的山体。
 *
 * 为什么不做"整体重新生成"：本体地貌有它自己的手感（开阔图就该平），
 * 换掉生成器等于把原版地图全变样。这里只补山脚，不搬山。
 */
export function softenPeaks(g: Terrain[], w: number, h: number, keep?: ReadonlySet<number>): void {
  const n = w * h;
  /** 离山心几格：0 = 山心本身，-1 = 没算到 */
  const dist = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    const t = g[i];
    if (t === 'mountain') {
      dist[i] = 0;
      queue[tail] = i;
      tail += 1;
    }
  }
  // 两圈就够了：再往外是平原，不需要更远的"缓坡"。
  // 水不参与传播——隔着一条河的对岸不该被算成这座山的山脚。
  for (let head = 0; head < tail; head += 1) {
    const cur = queue[head] as number;
    const d = dist[cur] as number;
    if (d >= 2) continue;
    const x = cur % w;
    const y = (cur - x) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== -1) continue;
      const t = g[ni];
      if (t === 'water' || t === 'shallow') continue;
      dist[ni] = d + 1;
      queue[tail] = ni;
      tail += 1;
    }
  }

  for (let i = 0; i < n; i += 1) {
    const d = dist[i];
    if (d !== 1 && d !== 2) continue;
    // 城郊那一圈不能抬：出生点要能站人，城门口也不该变成台地
    if (keep?.has(i)) continue;
    const t = g[i] as Terrain;
    if (t !== 'plain' && t !== 'forest' && t !== 'hill') continue;
    const height = TERRAIN_HEIGHT[t] ?? 0;
    if (d === 1 && height < 4) g[i] = 'plateau';
    else if (d === 2 && height < 3) g[i] = 'hill';
  }
}

export const HEIGHT_TERRAIN: Expansion = {
  id: 'height-terrain',
  name: '地形高差',
  summary:
    '每类地形有自己的高度与脾气：站得高看得远（俯射 +1 格、视野 +1），仰攻吃亏，' +
    '往高处走每层多花 1 点移动力；熔岩会烧人、沼泽会陷脚、沙丘看得远但没掩体、' +
    '浅流是唯一两边都能走的水（陆军涉水、水军贴滩）。带 7 种新地形与 6 种等高线地貌（高原、峡谷、火山群、' +
    '沼泽、群岛、大川）。',
  scale: 'small',
  // 对玩家开放。开局面板的「扩展」里勾上它，才做三件事：
  //   1. 地图里才会出现那 7 种新地形（`terrains` 门控）；
  //   2. 「地貌」一栏才会多出高原/峡谷/火山群/沼泽/群岛/大川六颗 chip（`mapStyles`）；
  //   3. 步耗与射程的那套钩子才会挂上（关掉 = 与从前逐格相同）。
  // 换句话说："勾了才有那些按钮"，勾选本身就是这一整套规则的开关。
  // 这些地形只有勾了本扩展才会被画进地图、才会出现在上帝模式的画笔里
  terrains: HEIGHT_PAINT_TERRAINS,
  // 六种高差地貌同理：开局界面的"地貌"一栏跟着扩展开关一起增减
  mapStyles: HEIGHT_MAP_STYLES,
  // 不论哪张地貌（包括本体的开阔/山岭/横河/纵河），长完都补一遍"山脚"
  afterTerrain: softenPeaks,
  hooks: {
    terrainHeight: (t) => TERRAIN_HEIGHT[t] ?? 0,

    /**
     * 射程：只看与目标的高度差。
     *
     * 只对**远程兵种**生效。近战兵种的 range 就是它的贴身距离，
     * 站上台地让它"隔三格砍人"不是我们所想的"看得远"——
     * 判断依据取兵种表里的基础射程，不取传进来的 range
     * （那个已经被天气之类改过了，浓雾天会让弓兵看起来像近战）。
     *
     * 加成分可以叠加，减成分取最差的那一个、不叠加：
     *   台地打谷地  +1（制高点）+1（高差）= +2，站得又高、对面又在坑里；
     *   谷地打台地  -1，不是 -2——"被坡挡住"和"被地形本身压住"是同一件事，
     *               把两个惩罚乘在一起会让弓兵在谷地里只剩射程 1，那不是削弱，是废掉。
     */
    modifyRangeAgainst: ({ unit, targetTerrain, range, state }) => {
      const base = state.unitTypes[unit.type]?.range ?? 1;
      if (base <= 1) return range;
      const here = state.tiles[unit.y * state.w + unit.x]?.terrain;
      if (!here) return range;

      // 只有高差这一条：站得比目标高 2 层以上 +1，低 2 层以上 −1，其余不动。
      // 地形自带的"制高点 +1"已经由高度表达过了，不再单独加一份。
      if (!targetTerrain) return range;
      const dh = (TERRAIN_HEIGHT[here] ?? 0) - (TERRAIN_HEIGHT[targetTerrain] ?? 0);
      if (!Number.isFinite(dh)) return range;
      if (dh >= RANGE_HEIGHT_BAND) return range + 1;
      if (dh <= -RANGE_HEIGHT_BAND) return Math.max(1, range - 1);
      return range;
    },

    /**
     * 视野：站在什么样的地上，就能看多远。
     *
     * 只改"这个兵自己看多远"，不改整方的视野半径——后者是"国家有多少眼睛"，
     * 和脚下站的是什么没关系（这一条由 unit 是否为空区分）。
     */
    modifyVision: ({ state, unit, base }) => {
      if (!unit) return base;
      const here = state.tiles[unit.y * state.w + unit.x]?.terrain;
      if (!here) return base;
      return Math.max(1, base + (TERRAIN_VISION_MOD[here] ?? 0));
    },

  },
};

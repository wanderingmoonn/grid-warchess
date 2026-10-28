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
import type { Expansion, TurnEndCtx } from './expansions.ts';
import type { Terrain } from './types.ts';

/**
 * 高度阶梯（层）。
 *
 * 数值刻意做成整数层而不是"海拔多少米"：规则只关心相对高低，
 * 层数越少越容易在界面上讲清楚（面板直接写"高 2 层"）。
 *
 *   water 0 → shallow / valley / marsh / lava 1 → plain / forest / city / bridge 2
 *   → hill / dune 3 → plateau 4 → mountain 5 → volcano 6
 */
export const TERRAIN_HEIGHT: Record<Terrain, number> = {
  water: 0,
  // 浅流：水皮刚过脚踝，跟谷地/沼泽一个高度档
  shallow: 1,
  // 低洼：谷地、沼泽，还有火山脚下那圈熔岩
  valley: 1,
  marsh: 1,
  lava: 1,
  // 基准面：平原、林地、城、桥
  plain: 2,
  forest: 2,
  city: 2,
  bridge: 2,
  // 上一层：丘陵与沙脊
  hill: 3,
  dune: 3,
  // 台地比丘陵再高一档
  plateau: 4,
  // 天险：高山、火山
  mountain: 5,
  volcano: 6,
};

/**
 * 地形自带的射程修正（站在这一格上时生效）。
 *
 * 和"高度差"是两回事，两个都要算：
 *   · 高度差讲"我和目标谁高"（动态，看对手站哪）；
 *   · 这里讲"这一格本身好不好观察"（静态）。森林哪怕在山脊上也挡视线，
 *     所以它不能只由高度算出来。
 */
export const TERRAIN_RANGE_MOD: Record<Terrain, number> = {
  plain: 0,
  forest: -1, // 树冠挡视线
  hill: 1, // 制高点
  water: 0,
  shallow: 0, // 蹲在水里，视野没好处也没坏处
  mountain: 0,
  bridge: 0,
  city: 0,
  plateau: 1, // 台地边缘视野极好
  valley: -1, // 被两坡夹着，看出去一半是坡
  marsh: 0, // 芦苇挡一点、地势平，对冲
  dune: 1, // 沙脊上看得远
  lava: 0,
  volcano: 0,
};

/**
 * 地形自带的视野修正（站上去那一刻）。
 *
 * 和射程修正分开列：视野是"我能看多远"，射程是"我能打多远"，
 * 海面上看得远不代表打得远。浅流踩在水里，视野不打折但防御要打折（那是另一条规则）。
 */
export const TERRAIN_VISION_MOD: Record<Terrain, number> = {
  plain: 0,
  forest: -1, // 树冠把天遮了一半
  hill: 1,
  water: 0,
  shallow: 0,
  mountain: 0,
  bridge: 0,
  city: 0,
  plateau: 1,
  valley: -1,
  marsh: -1, // 芦苇比人高
  dune: 1,
  lava: 0,
  volcano: 0,
};

/** 每往上一层多花多少移动力 */
export const CLIMB_COST = 1;
/** 爬坡附加最多算几层（防止台地变成 4 点/格的天堑） */
export const CLIMB_CAP = 2;
/**
 * 高度差影响射程的阈值。
 *
 * 定 2 而不是 1：平原(2)↔丘陵(3) 只差一层，那是"略高一点"，
 * 弓箭手站上去就多一格射程的话，地形会压过兵种本身的差异。
 */
export const RANGE_HEIGHT_BAND = 2;
/** 熔岩每回合末的真伤：够疼，但一队满血兵不会当场烧死（可以硬闯一次） */
export const LAVA_BURN = 5;
/** 沼泽陷足：从泥里拔出脚的那一步多花多少 */
export const MARSH_BOG = 1;

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
    id: 'volcanic',
    name: '火山群',
    note: '锥体从山口往外依次是熔岩、台地、丘陵；熔岩能过，但会烧人',
    build: (c) => buildContour(c, 'volcanic'),
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
  'lava',
  'volcano',
];

/**
 * 收尾：把"从平地上孤零零拔起来"的高山降成台地。
 *
 * 本体那五种地貌是**撒团块**的：山是一坨一坨撒的，团块边缘必然出现
 * "四周全是平原、中间一柱高山"——那不是等高线，是石头柱子。
 * 这个扩展的卖点是"高低差层层递进"，所以开它的时候要把这种柱子抹平：
 *
 *   · 一格高山只要四邻里**没有**台地或高山，它就缺"山脚"，降成台地；
 *   · 台地本身算 4 层，能给别人当山脚，所以这条规则跑一遍就收敛
 *     （最多两遍：先补一圈台地，再确认新台地够不够当裙边）；
 *   · 结果是一座山的边缘永远有一圈台地托着，山体从外往内是
 *     平原 → 丘陵 → 台地 → 高山，正好是现实里等高线的顺序。
 *
 * 为什么不做"整体重新生成"：本体地貌有它自己的手感（开阔图就该平），
 * 换掉生成器等于把原版地图全变样。这里只动"明显不合理的那一类格子"。
 */
export function softenPeaks(g: Terrain[], w: number, h: number): void {
  const tall = (t: Terrain): number => TERRAIN_HEIGHT[t] ?? 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const snap = [...g];
    let changed = false;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (snap[i] !== 'mountain') continue;
        let skirt = false;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (tall(snap[ny * w + nx] as Terrain) >= 4) {
            skirt = true;
            break;
          }
        }
        if (!skirt) {
          g[i] = 'plateau';
          changed = true;
        }
      }
    }
    if (!changed) break;
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
  // 规则已经在跑（新 AI 的射程/寻路按它算步耗），但这一批不对玩家开放：
  // 先让带高差感知的 AI 上线，地形本身等打磨完再开。
  hidden: true,
  // 这些地形只有勾了本扩展才会被画进地图、才会出现在上帝模式的画笔里
  terrains: HEIGHT_PAINT_TERRAINS,
  // 六种高差地貌同理：开局界面的"地貌"一栏跟着扩展开关一起增减
  mapStyles: HEIGHT_MAP_STYLES,
  // 不论哪张地貌（包括本体的开阔/山岭/横河/纵河），长完都补一遍"山脚"
  afterTerrain: softenPeaks,
  hooks: {
    terrainHeight: (t) => TERRAIN_HEIGHT[t] ?? 0,

    /**
     * 单格步耗：爬坡 + 沼泽陷足。
     *
     * 爬坡只在"往高处走"时加价，下坡免费（顺坡不慢），也绝不减价
     * （减价会变成"从山上冲下来"的免费机动外挂，而高地本来就带射程优势）。
     * 陷足反过来看的是"来处"：从沼泽里往外走要多花一点——进来便宜、出去难，
     * 这才是泥地该死的样子。
     */
    modifyStepCost: ({ from, to, cost }) => {
      if (!from) return undefined;
      let out = cost;
      const dh = (TERRAIN_HEIGHT[to] ?? 0) - (TERRAIN_HEIGHT[from] ?? 0);
      if (dh > 0) out += Math.min(CLIMB_CAP, dh) * CLIMB_COST;
      if (from === 'marsh') out += MARSH_BOG;
      return out;
    },

    /**
     * 射程：所站地形的静态修正 + 与目标的高度差。
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

      let plus = 0;
      let minus = 0;
      const taste = (v: number) => {
        if (v > 0) plus += v;
        else if (v < 0) minus = Math.min(minus, v);
      };
      taste(TERRAIN_RANGE_MOD[here] ?? 0);
      if (targetTerrain) {
        const dh = (TERRAIN_HEIGHT[here] ?? 0) - (TERRAIN_HEIGHT[targetTerrain] ?? 0);
        if (dh >= RANGE_HEIGHT_BAND) taste(1);
        else if (dh <= -RANGE_HEIGHT_BAND) taste(-1);
      }
      return Math.max(1, range + plus + minus);
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

    /**
     * 回合末：熔岩灼烧。
     *
     * 为什么是"回合末"而不是"进入即伤"：进入即伤会让 AI 的寻路无法评估
     * （它只看步耗），也会让"路过熔岩边缘"变得莫名其妙地疼。
     * 回合末结算的语义很干净——**你在岩浆上停了一整个回合**，所以被烧。
     * 战报按方汇总一条，不逐兵刷屏。
     */
    onTurnEnd: ({ state, hurt, log }: TurnEndCtx) => {
      const total: Record<string, number> = { A: 0, B: 0 };
      const count: Record<string, number> = { A: 0, B: 0 };
      for (const u of [...state.units]) {
        const tile = state.tiles[u.y * state.w + u.x];
        if (tile?.terrain !== 'lava') continue;
        hurt(u, LAVA_BURN);
        total[u.owner] = (total[u.owner] ?? 0) + LAVA_BURN;
        count[u.owner] = (count[u.owner] ?? 0) + 1;
      }
      for (const p of ['A', 'B'] as const) {
        const n = count[p] ?? 0;
        if (n <= 0) continue;
        log(p, `熔岩灼烧：${n} 支部队停在岩浆上，共受 ${total[p] ?? 0} 点伤害`);
      }
    },
  },
};

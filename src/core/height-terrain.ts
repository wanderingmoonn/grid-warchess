/**
 * 扩展规则：地形高差。
 *
 * 本体只认"这一格什么地形、加多少防御、走一格几步"。这个扩展在这之上
 * 加了一层**高度**，并让它真的咬住战斗与机动：
 *
 *   1. 每类地形有一个高度（层）。高度不是装饰数字，是下面两条规则的唯一输入；
 *   2. 射程：站得比目标高 2 层以上，看得更远（+1 格）；比目标低 2 层以上，
 *      仰攻吃亏（-1 格）。另外地形本身也有静态修正（丘陵制高点、树冠遮挡）；
 *   3. 机动：往高处走要多花移动力（每层 +1，最多算 2 层）；下坡不加价。
 *
 * 关掉这个扩展：没有新地形、没有高度、射程与步耗与本体完全一致——
 * 所有规则都挂在这一个 Expansion 的钩子里，本体一行都不认识"高度"。
 *
 * 为什么"高度差"要放在射程钩子而不是兵种射程里：同一支弓箭手，
 * 站台地上和站谷地里射程本来就该不一样，那是**地形**的属性，
 * 写进兵种表就变成"每个兵种都要为每类地形各写一份"。
 */

import type { Terrain } from './types.ts';
import type { Expansion } from './expansions.ts';

/**
 * 高度阶梯（层）。
 *
 * 数值刻意做成整数层而不是"海拔多少米"：规则只关心相对高低，
 * 层数越少越容易在界面上讲清楚（面板直接写"高 2 层"）。
 *
 *   water 0 → valley / marsh / lava 1 → plain / forest / city / bridge 2
 *   → hill / dune 3 → plateau 4 → mountain 5 → volcano 6
 */
export const TERRAIN_HEIGHT: Record<Terrain, number> = {
  water: 0,
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

/** 这个扩展带来的地貌风格（地图生成器认这几个 id） */
export const HEIGHT_MAP_STYLES: Array<{ id: string; name: string; note: string }> = [
  { id: 'highland', name: '高原', note: '成片台地与丘陵，俯射优势明显' },
  { id: 'canyon', name: '峡谷', note: '谷地与台地交错，仰攻吃亏' },
  { id: 'volcanic', name: '火山群', note: '火山锥与熔岩浅流，绕路比直穿快' },
  { id: 'marsh', name: '沼泽', note: '低洼烂地，走不快也藏不住' },
];

/** 这个扩展带来的不可刷地形之外的新地形（上帝模式笔刷用） */
export const HEIGHT_PAINT_TERRAINS: readonly Terrain[] = [
  'plateau',
  'valley',
  'marsh',
  'dune',
  'lava',
  'volcano',
];

/** 关掉扩展时的空实现：本体拿到的就是这些数 */
const NO_SHIFT = 0;

export const HEIGHT_TERRAIN: Expansion = {
  id: 'height-terrain',
  name: '地形高差',
  summary:
    '给每类地形定一个高度：站得高看得远（俯射 +1 格）、从低处仰攻射程 -1，' +
    '往高处走每层多花 1 点移动力。同时带来台地 / 谷地 / 沙丘 / 沼泽 / 熔岩浅流 / 火山' +
    '与四种高差地貌（高原、峡谷、火山群、沼泽）。',
  scale: 'small',
  // 规则已经在跑（新 AI 的射程/寻路按它算步耗），但这一批不对玩家开放：
  // 先让带高差感知的 AI 上线，地形本身等打磨完再开。
  hidden: true,
  // 这六样只有勾了本扩展才会被画进地图、才会出现在上帝模式的画笔里
  terrains: HEIGHT_PAINT_TERRAINS,
  // 四种高差地貌同理：开局界面的"地貌"一栏跟着扩展开关一起增减
  mapStyles: HEIGHT_MAP_STYLES,
  hooks: {
    terrainHeight: (t) => TERRAIN_HEIGHT[t] ?? 0,
    // 爬坡：只在"往高处走"时加价，下坡免费（顺坡不慢），也绝不减价
    // （减价会变成"从山上冲下来"的免费机动外挂，而高地本来就带射程优势）。
    modifyStepCost: ({ from, to, cost }) => {
      if (!from) return undefined;
      const dh = (TERRAIN_HEIGHT[to] ?? NO_SHIFT) - (TERRAIN_HEIGHT[from] ?? NO_SHIFT);
      if (dh <= 0) return undefined;
      return cost + Math.min(CLIMB_CAP, dh) * CLIMB_COST;
    },
    // 射程：所站地形的静态修正 + 与目标的高度差
    //
    // 只对**远程兵种**生效。近战兵种的 range 就是它的贴身距离，
    // 站上台地让它"隔三格砍人"不是我们所想的"看得远"——
    // 判断依据取兵种表里的基础射程，不取传进来的 range
    // （那个已经被天气之类改过了，浓雾天会让弓兵看起来像近战）。
    //
    // 加成分可以叠加，减成分取更差的那一个、不叠加：
    //   台地打谷地  +1（制高点）+1（高差）= +2，站得又高、对面又在坑里；
    //   谷地打台地  -1，不是 -2——"被坡挡住"和"被地形本身压住"是同一件事，
    //               把两个惩罚乘在一起会让弓兵在谷地里只剩射程 1，那不是削弱，是废掉。
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
  },
};

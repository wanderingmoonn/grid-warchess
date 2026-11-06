/**
 * **扩展描述向量**：把"这一局开的是哪个环境"变成一组数字，喂给网络当输入。
 *
 * ── 为什么不是"扩展 one-hot" ────────────────────────────────────────────
 *
 * 项目里有二十多个扩展（血战、先行补偿、行动点、城郭物料、修真、地形高差…），
 * 而且还会继续加。用 one-hot 的问题是：它只描述"我见过的那几个"，
 * 新扩展进来就是一个全零向量，网络对它一无所知——那不是泛化，是回避。
 *
 * 所以这里描述的是**环境的结构属性**，不是身份：
 *
 *   · 有几种资源、分别是什么（`RESOURCES` 注册表是活的，扩展注册新资源就自动进来）
 *   · 兵种池的形状（多少个、按类别怎么分、造价/血量/射程/移动的均值、价格离散度）
 *   · 机制开关（迷雾、行动点、地形高度、多资源消耗……）
 *   · 棋盘与开局（边长、人数、起始时代、回合上限）
 *
 * 新扩展只要"注册一种资源"或"给兵种加个 ap 字段"，这些数字就会自己变——
 * 网络因此可以在一组它**没见过**的数值下做出合理反应，而不是撞墙。
 *
 * 少数几条没有结构痕迹的开关（血战、先行补偿是纯规则分支，状态里看不出来）
 * 只能用 id 判断。这些位的语义是"这个已知机制开着"，未知扩展一律置 0，
 * 属于有意的降级：宁可少一个开关，也不要让整块向量变成身份编码。
 *
 * ── 它会进哪里 ──────────────────────────────────────────────────────────
 *
 * v2 的观测 = 现有全局块（扩展无关化之后）+ 这块描述 + 粗化棋盘 + 意图 one-hot。
 * 也就是说"环境"是一等输入，不是训练时写死的常量。
 */
import { RESOURCES } from '../../src/core/resources.ts';
import { heightOfTerrain, utype } from '../../src/core/rules.ts';
import type { GameState } from '../../src/core/types.ts';

export const ENV_DIM = 27;

/**
 * 纯规则分支、状态里没有结构痕迹的机制，只能按 id 认。
 *
 * 行动点属于这一类的理由值得记一下：它的默认值不在兵种表里（`def.ap` 只是个别兵种的
 * 覆盖项，缺省走 action-points 模块内部的分档），而真正落到状态里的 `u.custom.ap`
 * 要等第一回合开账才写——也就是说"开局那一刻状态里看不出来"。与其用一个会随时间
 * 变化的信号，不如老老实实按 id 认，并把它标注成"已知机制的开关"。
 */
const ID_FLAGS: ReadonlyArray<readonly [string, number]> = [
  ['bloodbath', 18],
  ['turn-order-comp', 19],
  ['action-points', 26],
];

/**
 * 地形高度的查表器（按"扩展组合 + 地形"记忆）。
 *
 * 为什么需要它：`heightOfTerrain` 每次都要遍历 activeExpansions 的钩子，
 * 而编码要逐格查高度（12×12 就是 144 次）。实测这一条就吃掉了每步 0.2ms——
 * 而高度是**地形类型**的属性，一张图上最多 13 种地形，查一次就够一辈子。
 * 键里带扩展组合，是为了"同一进程里跑不同扩展的多局"不会互相污染。
 */
const HEIGHT_MEMO = new Map<string, Map<string, number>>();
export function heightLookup(s: GameState): (t: string) => number {
  const key = s.config.expansionIds.join(',');
  let memo = HEIGHT_MEMO.get(key);
  if (!memo) {
    memo = new Map();
    HEIGHT_MEMO.set(key, memo);
  }
  const m = memo;
  return (t: string): number => {
    const hit = m.get(t);
    if (hit !== undefined) return hit;
    const v = heightOfTerrain(s, t as never);
    m.set(t, v);
    return v;
  };
}

/** 压进 [-4, 4]：和 features.ts 同一个口径，网络吃不了 inf */
function clip(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -4 ? -4 : v > 4 ? 4 : v;
}

/**
 * 算出这一局的环境描述。纯函数（只读 `s`，不碰全局状态），可复用缓冲。
 *
 * 每格的归一化分母都写在下面对应的注释里。原则和 v2 规格一致：
 * **能用比值就不用绝对值**——价格除以"平均价"，血量除以经验常数，
 * 这样兵种表整体调价时向量基本不动。
 */
export function describeEnv(s: GameState, out?: Float32Array): Float32Array {
  const f = out ?? new Float32Array(ENV_DIM);
  f.fill(0);

  // ── 资源 ──────────────────────────────────────────────────────────────
  // [0] 资源种类数（含金币）。分母 6：项目现在最多同时 3~4 种，留余量。
  const ids = RESOURCES.map((r) => r.id);
  f[0] = clip(ids.length / 6);
  // [1..3] 三个"原版/常见"资源的存在位。按 id 认，因为这三条是语义固定的。
  f[1] = ids.includes('gold') ? 1 : 0;
  f[2] = ids.includes('food') ? 1 : 0;
  f[3] = ids.includes('material') ? 1 : 0;
  // [4] 其它资源数（灵石之类扩展加的）。分母 4。
  const known = new Set(['gold', 'food', 'material']);
  f[4] = clip(ids.filter((id) => !known.has(id)).length / 4);
  // [5] 平均每个兵种要花几种资源（>1 就是多资源经济）。分母 3。
  const pool = s.config.enabledUnits;
  let resTypes = 0;
  let defs = 0;
  let sumCost = 0;
  let minCost = Infinity;
  let maxCost = 0;
  let sumHp = 0;
  let sumRange = 0;
  let sumMove = 0;
  let sumAp = 0;
  let apCount = 0;
  let combat = 0;
  let eco = 0;
  let building = 0;
  for (const id of pool) {
    const d = utype(s, id);
    if (!d) continue;
    defs += 1;
    resTypes += 1 + Object.keys(d.costRes ?? {}).length;
    sumCost += d.cost;
    if (d.cost < minCost) minCost = d.cost;
    if (d.cost > maxCost) maxCost = d.cost;
    sumHp += d.maxHp;
    sumRange += d.range;
    sumMove += d.move;
    if (d.ap !== undefined) {
      apCount += 1;
      sumAp += d.ap;
    }
    if (d.category === 'combat') combat += 1;
    else if (d.category === 'economy') eco += 1;
    else building += 1;
  }
  const n = Math.max(1, defs);
  f[5] = clip(resTypes / n / 3);

  // ── 兵种池形状 ────────────────────────────────────────────────────────
  f[6] = clip(defs / 32);
  f[7] = clip(combat / 24);
  f[8] = clip(eco / 12);
  f[9] = clip(building / 8);
  // [10] 带行动点字段的兵种占比：**行动点机制的structural 信号**，不用认扩展 id。
  f[10] = clip(apCount / n);
  f[11] = apCount > 0 ? clip(sumAp / apCount / 200) : 0;
  // [12] 平均造价：分母是"平均价"自己做不到，用 100 当量纲（各时代均价都在这个量级）。
  f[12] = clip(sumCost / n / 100);
  // [13] 价格离散度（最贵/最便宜）：描述"这个池子里有没有贵东西"。clip 到 8。
  f[13] = minCost > 0 ? clip(maxCost / minCost / 8) : 0;
  f[14] = clip(sumHp / n / 30);
  f[15] = clip(sumRange / n / 8);
  f[16] = clip(sumMove / n / 8);

  // ── 机制开关 ──────────────────────────────────────────────────────────
  f[17] = s.fog ? 1 : 0;
  for (const [id, at] of ID_FLAGS) f[at] = s.config.expansionIds.includes(id) ? 1 : 0;
  // [20] 站得比地面高的地块占比：「地形高差」扩展的结构信号。
  // 高度是**地形类型**的属性（`TERRAIN_HEIGHT`），不是每格的字段，所以要走 heightOfTerrain；
  // 扩展没开时它对所有地形都是 0，这一格自然就是 0，不需要认扩展 id。
  let withH = 0;
  const hOf = heightLookup(s);
  for (const t of s.tiles) if (hOf(t.terrain) > 0) withH += 1;
  f[20] = s.tiles.length > 0 ? clip(withH / s.tiles.length) : 0;
  // [21] 非金币资源种类数：说明"经济不是单资源"。分母 4。
  f[21] = clip((ids.length - 1) / 4);
  // [22] 开了几个扩展。分母 8。
  f[22] = clip(s.config.expansionIds.length / 8);

  // ── 棋盘与开局 ────────────────────────────────────────────────────────
  f[23] = clip(Math.max(s.w, s.h) / 24);
  f[24] = clip((s.config.playerCount ?? 2) / 4);
  f[25] = clip((s.config.startEra ?? 1) / 5);
  return f;
}

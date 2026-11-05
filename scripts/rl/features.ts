/**
 * 观测编码：把一局棋变成一个网络能吃的数字块。
 *
 * ── 四组特征，各有各的理由 ───────────────────────────────────────────────
 *
 * 1. **全局**（50 维）：钱、资源、时代、城数、兵力值、双方对比、地图水域占比…
 *    这些是"我现在是赢是输"的粗坐标。价值头主要靠它，动作打分也靠它定基调。
 *
 * 2. **环境描述**（27 维，见 `env-desc.ts`）：这一局开的是什么样的环境——
 *    资源表、兵种池形状、机制开关。用结构属性而不是扩展 one-hot，
 *    新扩展进来时向量会自己变，而不是变成一片零。
 *
 * 3. **局面**（6×6×4 = 144 维）：把地图粗化到 6×6，四个平面记地形、兵力、
 *    城市归属、地形高度。为什么不按原尺寸铺（12×12×N）：那会让"状态 ⊕ 动作"
 *    的维度翻三倍，而线性预筛的成本正比于维度。6×6 在 12×12 的图上每格约 2×2，
 *    "这一带有我的兵/有他的城"这类信息还留得住，细节交给全局的最近距离特征。
 *
 * 4. **意图**（4 维，在全局块末尾）：rush / harass / boom / auto 的 one-hot。
 *    为什么要这个：老 AI 有三套 doctrine，策略这一侧原本没有任何对应物，
 *    造兵多样性只能靠 softmax 的残余熵，训练一收敛就没了。
 *
 * ── v2 改了什么（相对 v1 的 148 维）─────────────────────────────────────
 *
 * v1 的三个结构性毛病，每条都有实测证据：
 *
 *   · **只编了金币**。引擎的资源是动态表（`player.res[id]`），扩展可以随时加
 *     粮食/建材/灵石，而 v1 的观测里只有金币——"粮材怎么分配"策略完全看不见。
 *   · **标度写死**。`gold / 150`、`value / 1200`、`cost / 200` 这些常数一旦碰上
 *     平衡性调整就整体失准：均价翻倍，所有价值类特征的幅度就减半。
 *     v2 的口径是**能用比值就不用绝对值**，分母尽量取"活的参照物"（收入、
 *     最便宜价、棋盘边长），这样整体缩放时商不变。
 *   · **没有意图输入**。见上。
 *
 * ── 一条硬约束 ───────────────────────────────────────────────────────────
 *
 * 编码必须是**从 `seat` 的视角**看的：永远"我是 +，对面是 −"。
 * 这样同一套权重能同时下两边（自博弈的前提），也省掉一个"我是哪家"的输入。
 *
 * ── 成本 ─────────────────────────────────────────────────────────────────
 *
 * 目标 0.1 ms/步以内（状态一次，动作 N 次）。所以这里只做 O(兵+城+格) 的事，
 * 不跑 reachableTiles、不调 computeDamage（那是 10µs 级的），
 * 伤害一律用 `atk − armor` 的粗估——精确值网络自己能从 atk/armor/hp 这三个数里学。
 */
import { canUseType } from '../../src/core/draft.ts';
import {
  citiesOf,
  distance,
  distToCity,
  incomeResOf,
  tileAt,
  upgradeCostOf,
  utype,
} from '../../src/core/rules.ts';
import { RESOURCES, resOf } from '../../src/core/resources.ts';
import { unitValue } from '../../src/core/ai-tactics.ts';
import type { Action, City, GameState, PlayerId, ResourceId, Terrain, Unit, UnitTypeDef } from '../../src/core/types.ts';
import { TRAIN } from './config.ts';
import { ENV_DIM, describeEnv, heightLookup } from './env-desc.ts';

export { ENV_DIM };

/** 全局特征的维度。改它必须同时改下面的编码函数（末尾有断言） */
export const GLOBAL_DIM = 50;
/** 粗化网格边长 */
export const BOARD_N = 6;
/** 粗化平面数：地形 / 兵力 / 城市归属 / 地形高度 */
export const BOARD_PLANES = 4;
export const BOARD_DIM = BOARD_N * BOARD_N * BOARD_PLANES;
/** 资源槽位数：金币 + 4 种（现在项目里最多同时出现 3~4 种，留一个位） */
export const RES_SLOTS = 5;
/** 状态向量 = 全局 + 环境描述 + 粗化棋盘 */
export const STATE_DIM = GLOBAL_DIM + ENV_DIM + BOARD_DIM;
/** 单个动作的特征维度 */
export const ACTION_DIM = 62;
/** 动作类型 one-hot 的格数（见 `ACTION_KINDS`） */
export const ACTION_KINDS = 13;

/**
 * 意图：告诉策略"这局按什么打法"。
 *
 * 命名和 `AiDoctrine` 一一对应，`auto` 是"没有指定，自己判断"——四格全 0。
 * 它同时是**训练标签**的来源（模仿时记老师当时的 doctrine）和**推理时的指令**。
 */
export type Intent = 'rush' | 'harass' | 'boom' | 'auto';
export const INTENT_NAMES: Intent[] = ['rush', 'harass', 'boom', 'auto'];
const INTENT_INDEX: Record<Intent, number> = { rush: 0, harass: 1, boom: 2, auto: 3 };

/** 把值压进 [-4, 4]：网络吃不了 inf，也不该被一个 3000 金的极端值带跑 */
function clip(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -4 ? -4 : v > 4 ? 4 : v;
}
const nz = (v: number, scale: number): number => clip(v / scale);

/**
 * 地形的"可通行度"。
 *
 * 不是通行成本的反比，而是**战术价值**的粗略打分：平原最好走、山林能藏、
 * 水要绕、山过不去。城市格算满——城是目标，不是障碍。
 */
const TERRAIN_VALUE: Record<Terrain, number> = {
  plain: 1,
  forest: 0.8,
  hill: 0.85,
  plateau: 0.7,
  valley: 0.9,
  marsh: 0.45,
  dune: 0.7,
  water: 0.15,
  shallow: 0.5,
  deep: 0.05,
  mountain: 0.1,
  bridge: 1,
  city: 1,
};

/**
 * 一个兵种"值多少"的归一化。
 *
 * v2 保留了这个常数，但**只用在动作特征里**（那里没有更好的活参照物：
 * 分母若取"场上均价"，同一支部队在不同局面下会得到不同的值，动作打分就不稳）。
 * 状态里凡是能换成比值的地方都换了。
 */
const UNIT_VALUE_SCALE = 200;

/** 战斗单位之外的类别：给动作特征用 */
const CATEGORY_INDEX: Record<string, number> = { combat: 0, economy: 1, builder: 2, building: 3 };

/** 这一方是不是我（从 seat 视角） */
const rel = (owner: PlayerId, seat: PlayerId): number => (owner === seat ? 1 : -1);

/** 比值，分母为 0 时给 0.5（"看不出谁占优"），不给 0（那等于说"我全输"） */
const ratio = (a: number, b: number): number => (a + b > 0 ? a / (a + b) : 0.5);

/**
 * 分布熵，按"双方一共出现了几种"归一化。
 *
 * 归一化而不给绝对值：兵种池大小随扩展变，绝对熵没法跨环境比较。
 * 只有一种兵时熵为 0，正好表示"毫无变化"。
 */
function entropy(counts: Map<string, number>, kinds: number): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  if (total <= 0) return 0;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / total;
    if (p > 0) h -= p * Math.log(p);
  }
  return clip(h / Math.log(Math.max(2, kinds)));
}

interface Side {
  gold: number;
  income: number;
  cities: number;
  cityEra: number;
  units: number;
  value: number;
  hpRatio: number;
  economy: number;
  ranged: number;
  centroid: { x: number; y: number } | null;
  era: number;
  /** 按兵种 id 的兵数，算分布熵用 */
  types: Map<string, number>;
}

/**
 * 汇总一方的粗指标。
 *
 * `era` 取"最高的一座城"而不是平均：能造几代兵只取决于最好的那座城，
 * 平均值会让"三座一代城 + 一座五代城"看起来像个二代文明。
 */
function sideOf(s: GameState, p: PlayerId, income: number): Side {
  const cities = citiesOf(s, p).filter((c) => !c.ruined);
  let value = 0;
  let hp = 0;
  let maxHp = 0;
  let economy = 0;
  let ranged = 0;
  let cx = 0;
  let cy = 0;
  let units = 0;
  const types = new Map<string, number>();
  for (const u of s.units) {
    if (u.owner !== p || u.hp <= 0) continue;
    const def = utype(s, u.type);
    value += unitValue(s, u);
    hp += u.hp;
    maxHp += def.maxHp;
    if (def.category === 'economy') economy += 1;
    if ((def.range ?? 1) >= 3) ranged += 1;
    cx += u.x;
    cy += u.y;
    units += 1;
    types.set(u.type, (types.get(u.type) ?? 0) + 1);
  }
  return {
    gold: s.players[p].gold,
    income,
    cities: cities.length,
    cityEra: cities.reduce((n, c) => Math.max(n, c.era), 0),
    units,
    value,
    hpRatio: maxHp > 0 ? hp / maxHp : 0,
    economy,
    ranged,
    centroid: units > 0 ? { x: cx / units, y: cy / units } : null,
    era: cities.reduce((n, c) => Math.max(n, c.era), 0),
    types,
  };
}

/** 一方某种资源的"够花几个回合"：存量 / 每回合进账，压到 10 个回合 */
function turnsOfStock(stock: number, income: number): number {
  return clip(stock / Math.max(1, income) / 10);
}

/**
 * 编码全局特征（50 维）。
 *
 * 顺序一旦定下就不能动：训练好的权重是按位置读的。要加特征只能往末尾追。
 *
 * 字段表（v2）：
 * ```
 *   0  turn / capTurns              时间进度
 *   1  本回合已消耗比例              (已动 + 已战) / (2 × 兵数)
 *   2..6   我方 5 种资源"够花几回合"  stock / 每回合进账
 *   7..11  敌方同上
 *  12  资源种数 / 5
 *  13  可造兵种数 / 64
 *  14  最便宜可造价 / 收入           "几回合的收入能买一个"
 *  15  最贵可造价 / 收入
 *  16  可用域数 / 3                 land / water / air
 *  17  我方兵种分布熵 / ln(种类数)
 *  18  敌方同上
 *  19  远程兵占比（我 / 双方）
 *  20  经济单位占比（我 / 双方）
 *  21  单位数比（我 / 双方）
 *  22  城数比
 *  23  兵力值比
 *  24  时代差 / 5
 *  25  被毁城市比（我 / 双方）
 *  26  城墙血比（我 / 双方）
 *  27  水域占比
 *  28  我方重心 x / 边长
 *  29  我方重心 y / 棋盘高
 *  30  双方重心距离 / 边长
 *  31  最近敌我单位距离 / 边长
 *  32  已动比例
 *  33  已战比例
 *  34  围城压力（最近敌兵到我城距离 / 边长）
 *  35  我方城墙平均血比
 *  36  敌方城墙平均血比
 *  37  攻城窗口（能打到敌城的战斗兵比例）
 *  38  我 gold / 最便宜升级价
 *  39  我 gold / 最便宜兵价
 *  40..43 意图 one-hot（rush / harass / boom / auto）
 *  44..48 机制开关：迷雾 / 血战 / 行动点 / 地形高度 / 先行补偿
 *  49  预留
 * ```
 */
export function encodeGlobal(
  s: GameState,
  seat: PlayerId,
  intent: Intent = 'auto',
  out?: Float32Array,
): Float32Array {
  const f = out ?? new Float32Array(GLOBAL_DIM);
  // 收入表一次算完：`incomeResOf` 要扫全城全兵，重复调用的代价在每步都付
  const foeSeats: PlayerId[] = (Object.keys(s.players) as PlayerId[]).filter((p) => p !== seat);
  const myIncTable = incomeResOf(s, seat);
  const foeInc = foeSeats.map((p) => incomeResOf(s, p));
  const me = sideOf(s, seat, myIncTable.gold ?? 0);
  const foes: Side[] = foeSeats.map((p, i) => sideOf(s, p, foeInc[i]!.gold ?? 0));
  const foe = foes.reduce<Side>(
    (acc, x) => ({
      gold: acc.gold + x.gold,
      income: acc.income + x.income,
      cities: acc.cities + x.cities,
      cityEra: Math.max(acc.cityEra, x.cityEra),
      units: acc.units + x.units,
      value: acc.value + x.value,
      hpRatio: 0,
      economy: acc.economy + x.economy,
      ranged: acc.ranged + x.ranged,
      centroid: null,
      era: Math.max(acc.era, x.era),
      types: acc.types,
    }),
    {
      gold: 0, income: 0, cities: 0, cityEra: 0, units: 0, value: 0,
      hpRatio: 0, economy: 0, ranged: 0, centroid: null, era: 0, types: new Map(),
    },
  );
  for (const x of foes) for (const [k, n] of x.types) foe.types.set(k, (foe.types.get(k) ?? 0) + n);

  const mine = s.units.filter((u) => u.owner === seat && u.hp > 0);
  const myCities = citiesOf(s, seat).filter((c) => !c.ruined);

  // ── 时间 ──────────────────────────────────────────────────────────────
  f[0] = nz(s.turn, TRAIN.capTurns);
  {
    let moved = 0;
    let acted = 0;
    for (const u of mine) {
      if (u.moved) moved += 1;
      if (u.acted) acted += 1;
    }
    f[1] = mine.length > 0 ? clip((moved + acted) / (2 * mine.length)) : 0;
    f[32] = mine.length > 0 ? clip(moved / mine.length) : 0;
    f[33] = mine.length > 0 ? clip(acted / mine.length) : 0;
  }

  // ── 资源：每种"够花几个回合" ──────────────────────────────────────────
  //
  // 为什么用"够花几回合"而不是绝对值：绝对金币在平衡性调整后会整体平移，
  // 而"还能撑几个回合"在任何数值下含义都一样。分母是自己那条资源的进账，
  // 所以多资源的经济（粮/材/灵石）和纯金币的经济读数语义一致。
  {
    const mineInc = myIncTable;
    for (let i = 0; i < RES_SLOTS; i++) {
      const def = RESOURCES[i];
      if (!def) {
        f[2 + i] = 0;
        f[7 + i] = 0;
        continue;
      }
      const id = def.id;
      f[2 + i] = turnsOfStock(resOf(s.players[seat], id), mineInc[id] ?? 0);
      // 敌方多人局里资源表要合并：只取第一家会把"三家联军"读成一家
      let stock = 0;
      let inc = 0;
      for (let k = 0; k < foeSeats.length; k++) {
        stock += resOf(s.players[foeSeats[k]!], id);
        inc += foeInc[k]![id] ?? 0;
      }
      f[7 + i] = foes.length > 0 ? turnsOfStock(stock, inc) : 0;
    }
    f[12] = clip(RESOURCES.length / RES_SLOTS);
  }

  // ── 兵种池形状 ────────────────────────────────────────────────────────
  //
  // 只数"我现在的城造得出来"的那些。分母全用收入或经验上限，不用写死的常数：
  // 最便宜价 / 收入 = "几回合的收入能买一个"，这条在任何数值下都读得通。
  {
    let cheapest = Infinity;
    let priciest = 0;
    let count = 0;
    let land = 0;
    let water = 0;
    let air = 0;
    const era = me.cityEra;
    for (const id of s.config.enabledUnits) {
      const def = utype(s, id);
      if (!def) continue;
      if (def.category === 'building') continue;
      if (def.summonedOnly) continue;
      if ((def.era ?? 1) > era) continue;
      if (!canUseType(s, seat, id)) continue;
      count += 1;
      if (def.cost < cheapest) cheapest = def.cost;
      if (def.cost > priciest) priciest = def.cost;
      if (def.layer === 'air') air = 1;
      else if (def.domain === 'water') water = 1;
      else land = 1;
    }
    const income = Math.max(1, me.income);
    f[13] = clip(count / 64);
    f[14] = Number.isFinite(cheapest) ? clip(cheapest / income) : 0;
    f[15] = clip(priciest / income);
    f[16] = clip((land + water + air) / 3);
  }

  // ── 兵种构成 ──────────────────────────────────────────────────────────
  {
    const kinds = new Set<string>([...me.types.keys(), ...foe.types.keys()]).size;
    f[17] = entropy(me.types, kinds);
    f[18] = entropy(foe.types, kinds);
    f[19] = clip(ratio(me.ranged, foe.ranged));
    f[20] = clip(ratio(me.economy, foe.economy));
  }

  // ── 规模 ──────────────────────────────────────────────────────────────
  f[21] = clip(ratio(me.units, foe.units));
  f[22] = clip(ratio(me.cities, foe.cities));
  f[23] = clip(ratio(me.value, foe.value));
  f[24] = clip((me.era - foe.era) / 5);
  f[25] = clip(
    ratio(
      s.cities.filter((c) => c.owner === seat && c.ruined).length,
      s.cities.filter((c) => c.owner !== seat && c.ruined).length,
    ),
  );
  {
    const hpOf = (list: City[]) =>
      list.length ? list.reduce((n, c) => n + c.hp / Math.max(1, c.maxHp), 0) / list.length : 0;
    const foeCities = s.cities.filter((c) => c.owner !== seat && !c.ruined);
    f[26] = clip(ratio(hpOf(myCities), hpOf(foeCities)));
    f[35] = clip(hpOf(myCities));
    f[36] = clip(hpOf(foeCities));
  }

  // ── 地理 ──────────────────────────────────────────────────────────────
  let water = 0;
  for (const t of s.tiles) if (t.terrain === 'water' || t.terrain === 'deep') water += 1;
  f[27] = s.tiles.length > 0 ? clip(water / s.tiles.length) : 0;

  const home = myCities.length
    ? {
        x: myCities.reduce((n, c) => n + c.x, 0) / myCities.length,
        y: myCities.reduce((n, c) => n + c.y, 0) / myCities.length,
      }
    : me.centroid;
  const span = Math.max(1, s.w, s.h);
  f[28] = home ? clip(home.x / Math.max(1, s.w)) : 0.5;
  f[29] = home ? clip(home.y / Math.max(1, s.h)) : 0.5;
  f[30] = home && foe.centroid ? clip(Math.max(
    Math.abs(home.x - foe.centroid.x),
    Math.abs(home.y - foe.centroid.y),
  ) / span) : 1;

  // 最近的一对敌我单位：这个数直接决定"现在该打还是该退"
  let nearestFoe = 99;
  for (const a of mine) {
    for (const b of s.units) {
      if (b.owner === seat || b.hp <= 0) continue;
      const d = distance(a, b);
      if (d < nearestFoe) nearestFoe = d;
    }
  }
  f[31] = nearestFoe === 99 ? 1 : clip(nearestFoe / span);

  // ── 态势 ──────────────────────────────────────────────────────────────
  {
    // 城离最近敌军的距离（被围城的紧迫度）
    let pressure = 99;
    for (const c of myCities) {
      for (const b of s.units) {
        if (b.owner === seat || b.hp <= 0) continue;
        const d = distToCity(b, c);
        if (d < pressure) pressure = d;
      }
    }
    f[34] = pressure === 99 ? 1 : clip(pressure / span);

    // 有多少兵已经站在能打到敌城的距离上（攻城窗口）
    let siegers = 0;
    const foeCities = s.cities.filter((c) => c.owner !== seat && !c.ruined);
    for (const u of mine) {
      const def = utype(s, u.type);
      if (def.category !== 'combat') continue;
      if (foeCities.some((c) => distToCity(u, c) <= (def.range ?? 1))) siegers += 1;
    }
    f[37] = mine.length > 0 ? clip(siegers / mine.length) : 0;
  }

  // ── 空地比：账上的钱够买几个 ──────────────────────────────────────────
  {
    let cheapestUpgrade = Infinity;
    for (const c of myCities) {
      const cost = upgradeCostOf(s, c);
      if (cost !== null && cost < cheapestUpgrade) cheapestUpgrade = cost;
    }
    f[38] = Number.isFinite(cheapestUpgrade) ? clip(me.gold / Math.max(1, cheapestUpgrade)) : 0;

    let cheapestUnit = Infinity;
    for (const id of s.config.enabledUnits) {
      const def = utype(s, id);
      if (!def || def.category === 'building' || def.summonedOnly) continue;
      if ((def.era ?? 1) > me.cityEra) continue;
      if (def.cost > 0 && def.cost < cheapestUnit) cheapestUnit = def.cost;
    }
    f[39] = Number.isFinite(cheapestUnit) ? clip(me.gold / Math.max(1, cheapestUnit)) : 0;
  }

  // ── 意图 one-hot ──────────────────────────────────────────────────────
  //
  // auto 也占一格（全 0 是"没给指令"的表示，但这里仍然亮 auto 那一位）：
  // 亮一位而不是四格全 0，是为了让"没有意图"和"编码漏了"在数值上分得开。
  for (let k = 0; k < 4; k++) f[40 + k] = INTENT_INDEX[intent] === k ? 1 : 0;

  // ── 机制开关 ──────────────────────────────────────────────────────────
  f[44] = s.fog ? 1 : 0;
  f[45] = s.config.expansionIds.includes('bloodbath') ? 1 : 0;
  f[46] = s.config.expansionIds.includes('action-points') ? 1 : 0;
  {
    let withH = 0;
    const hOf = heightLookup(s);
    for (const t of s.tiles) if (hOf(t.terrain) > 0) withH += 1;
    f[47] = s.tiles.length > 0 ? clip(withH / s.tiles.length) : 0;
  }
  f[48] = s.config.expansionIds.includes('turn-order-comp') ? 1 : 0;
  f[49] = 0; // 预留

  return f;
}

/**
 * 编码粗化棋盘（144 维 = 6×6×4 平面）。
 *
 * 平面 0 地形、平面 1 兵力（净，我正敌负）、平面 2 城市归属、平面 3 地形高度。
 * 每格的值都夹在 [-1, 1]，所以四组平面能共用一个尺度。
 *
 * 平面 3 是为「地形高差」准备的：高度是**地形类型**的属性（`TERRAIN_HEIGHT`），
 * 扩展没开时所有地形的高度都是 0，这一面自然整片归零——不需要认扩展 id。
 */
export function encodeBoard(s: GameState, seat: PlayerId, out?: Float32Array): Float32Array {
  const f = out ?? new Float32Array(BOARD_DIM);
  f.fill(0);
  const cell = (x: number, y: number): number => {
    const cx = Math.min(BOARD_N - 1, Math.floor((x * BOARD_N) / Math.max(1, s.w)));
    const cy = Math.min(BOARD_N - 1, Math.floor((y * BOARD_N) / Math.max(1, s.h)));
    return cy * BOARD_N + cx;
  };
  const plane = BOARD_N * BOARD_N;

  // 地形：每格取平均可通行度；高度：每格取平均高度
  const counts = new Float32Array(plane);
  const hOf = heightLookup(s);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const t = tileAt(s, x, y);
      const c = cell(x, y);
      f[c] += t ? TERRAIN_VALUE[t.terrain] ?? 0.5 : 0;
      if (t) {
        // 天险是 +∞（"不参与算账"），当 0 处理——它已经在地形面里是最差的了
        const h = hOf(t.terrain);
        f[plane * 3 + c] += Number.isFinite(h) ? h : 0;
      }
      counts[c] += 1;
    }
  }
  for (let i = 0; i < plane; i++) {
    if (counts[i]! > 0) {
      f[i] = clip(f[i]! / counts[i]!);
      // 高度压到 [-0.5, 1]：TERRAIN_HEIGHT 现在落在 -1..2
      f[plane * 3 + i] = clip(f[plane * 3 + i]! / counts[i]! / 2);
    }
  }

  // 兵力：净单位值密度（我 +，敌 −），按 200 归一后夹紧
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    const c = plane + cell(u.x, u.y);
    const v = unitValue(s, u) / UNIT_VALUE_SCALE;
    f[c] = clip(f[c]! + rel(u.owner, seat) * v * Math.min(1, u.hp / Math.max(1, utype(s, u.type).maxHp)));
  }

  // 城市：整块地盘都标上归属（城的边长 2~3，粗化后正好占一格以上）
  for (const c of s.cities) {
    const sign = rel(c.owner, seat) * (c.ruined ? 0.3 : 1);
    for (let dy = 0; dy < c.size; dy++) {
      for (let dx = 0; dx < c.size; dx++) {
        const t = tileAt(s, c.x + dx, c.y + dy);
        if (!t) continue;
        const i = plane * 2 + cell(c.x + dx, c.y + dy);
        f[i] = clip(f[i]! + sign);
      }
    }
  }
  return f;
}

/**
 * 状态向量 = 全局 ⊕ 环境描述 ⊕ 粗化棋盘。
 *
 * `out` 可复用，避免每步新建 221 个 float。`intent` 只影响全局块末尾那 4 格。
 */
export function encodeState(
  s: GameState,
  seat: PlayerId,
  intent: Intent = 'auto',
  out?: Float32Array,
): Float32Array {
  const f = out ?? new Float32Array(STATE_DIM);
  encodeGlobal(s, seat, intent, f.subarray(0, GLOBAL_DIM) as Float32Array);
  describeEnv(s, f.subarray(GLOBAL_DIM, GLOBAL_DIM + ENV_DIM) as Float32Array);
  encodeBoard(s, seat, f.subarray(GLOBAL_DIM + ENV_DIM) as Float32Array);
  return f;
}


// ── 动作特征 ────────────────────────────────────────────────────────────

/**
 * 一批动作共用的中间量。
 *
 * 为什么要单拎出来：动作特征里有一半是**与具体动作无关**的环境量——
 * 这回合收入多少、每支兵离家多远、场上都有谁、城在哪。按最初的写法，
 * 这些要在每个动作里重算一遍（`incomeOf` 一次就要扫全城全兵），
 * 72 个动作就是 72 次，实测 0.31ms/步，占掉整个决策时间的六成。
 * 提到外面算一次之后降到 0.1ms 以内——这就是"看不出优化空间"和"知道钱花在哪"的区别。
 */
export interface ActionContext {
  seat: PlayerId;
  income: number;
  gold: number;
  /** 我还没塌的城 */
  myCities: City[];
  /** 对手还没塌的城（攻城目标池） */
  foeCities: City[];
  unitById: Map<string, Unit>;
  cityById: Map<string, City>;
  /** 每支我方兵到最近自家城的距离 */
  homeDist: Map<string, number>;
  /** 每支我方兵到最近敌人的距离 */
  foeDist: Map<string, number>;
  /** 每座城到最近我方兵的距离（攻城够不够得着） */
  cityGuard: Map<string, number>;
  /** 每支兵的单位值（`unitValue` 会查兵种表和能力，不值得每个动作调一次） */
  valueOf: Map<string, number>;
  /** 我方还有兵没动完：结束回合时这就是"提前收手" */
  hasIdle: boolean;
}

/**
 * 扫一遍局面，把动作特征要用的环境量一次算完。
 *
 * 传 `reuse` 就**原地重填**旧的那份：每步都新建五张 Map 看着无害，
 * 但那是每秒几千次分配，GC 会把它连本带利收回去（实测这一步能差出 0.1ms/步）。
 */
export function actionContext(s: GameState, seat: PlayerId, reuse?: ActionContext): ActionContext {
  const unitById = reuse?.unitById ?? new Map<string, Unit>();
  unitById.clear();
  for (const u of s.units) unitById.set(u.id, u);
  const cityById = reuse?.cityById ?? new Map<string, City>();
  cityById.clear();
  for (const c of s.cities) cityById.set(c.id, c);

  const myCities = (reuse?.myCities ?? []).slice();
  myCities.length = 0;
  for (const c of s.cities) if (c.owner === seat && !c.ruined) myCities.push(c);
  const foeCities = (reuse?.foeCities ?? []).slice();
  foeCities.length = 0;
  for (const c of s.cities) if (c.owner !== seat && !c.ruined) foeCities.push(c);
  const mine: Unit[] = [];
  const foes: Unit[] = [];
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    if (u.owner === seat) mine.push(u);
    else foes.push(u);
  }

  const homeDist = reuse?.homeDist ?? new Map<string, number>();
  const foeDist = reuse?.foeDist ?? new Map<string, number>();
  const valueOf = reuse?.valueOf ?? new Map<string, number>();
  homeDist.clear();
  foeDist.clear();
  valueOf.clear();
  let hasIdle = false;
  for (const u of mine) {
    homeDist.set(u.id, myCities.length ? Math.min(...myCities.map((c) => distToCity(u, c))) : 12);
    foeDist.set(u.id, foes.length ? Math.min(...foes.map((b) => distance(u, b))) : 12);
    valueOf.set(u.id, unitValue(s, u));
    if (!u.moved || !u.acted) hasIdle = true;
  }
  const cityGuard = reuse?.cityGuard ?? new Map<string, number>();
  cityGuard.clear();
  for (const c of s.cities) {
    cityGuard.set(c.id, mine.length ? Math.min(...mine.map((u) => distToCity(u, c))) : 12);
  }

  return {
    seat,
    income: incomeResOf(s, seat).gold ?? 0,
    gold: s.players[seat].gold,
    myCities,
    foeCities,
    unitById,
    cityById,
    homeDist,
    foeDist,
    cityGuard,
    valueOf,
    hasIdle,
  };
}

/**
 * 编码一批动作（N × 62，平铺成一个 Float32Array）。
 *
 * 平铺而不是 `Action[][]`：预筛就是一次点积，平铺的连续内存能让它跑满 CPU 缓存，
 * 而且 N 个动作只分配一次。
 */
export function encodeActions(
  s: GameState,
  seat: PlayerId,
  actions: readonly Action[],
  out?: Float32Array,
  ctx?: ActionContext,
): Float32Array {
  const f = out && out.length >= actions.length * ACTION_DIM ? out : new Float32Array(actions.length * ACTION_DIM);
  const c = ctx ?? actionContext(s, seat);
  for (let i = 0; i < actions.length; i++) encodeOne(s, c, actions[i]!, f, i * ACTION_DIM);
  return f;
}

/**
 * 动作类型的下标。
 *
 * v1 只有 7 格（RECRUIT 按城市/军营拆两个），结果老 AI 7% 的决策落不进任何一格；
 * v2 补到 13 格，一是让那 7% 能被表示，二是给"换扩展时冒出新动作类型"留位置——
 * 修真、地形高差将来再加类型时，不必再动 `ACTION_DIM`。
 */
export const ACTION_KINDS_NAMES: string[] = [
  'MOVE', 'ATTACK', 'SIEGE', 'RECRUIT_CITY', 'RECRUIT_CAMP', 'UPGRADE', 'END_TURN',
  'BUILD', 'LOAD', 'UNLOAD', 'HERO_SKILL', 'DISBAND', 'PLACE_EGG',
];

function kindOf(a: Action): number {
  switch (a.type) {
    case 'MOVE': return 0;
    case 'ATTACK': return 1;
    case 'SIEGE': return 2;
    case 'RECRUIT': return a.cityId ? 3 : 4;
    case 'UPGRADE': return 5;
    case 'END_TURN': return 6;
    case 'BUILD': return 7;
    case 'LOAD': return 8;
    case 'UNLOAD': return 9;
    case 'HERO_SKILL': return 10;
    case 'DISBAND': return 11;
    case 'PLACE_EGG': return 12;
    default: return ACTION_KINDS;
  }
}

/** 一个动作的特征：写进 `f` 的 `base` 起 62 格 */
function encodeOne(s: GameState, ctx: ActionContext, a: Action, f: Float32Array, base: number): void {
  const w = Math.max(1, s.w);
  const h = Math.max(1, s.h);
  let i = base;
  const put = (v: number) => {
    f[i++] = clip(v);
  };

  // 类型 one-hot（13）
  const kind = kindOf(a);
  for (let k = 0; k < ACTION_KINDS; k++) put(k === kind ? 1 : 0);

  // 发起单位
  const u: Unit | undefined = 'unitId' in a && a.unitId ? ctx.unitById.get(a.unitId) : undefined;
  put(u ? 1 : 0);
  const def: UnitTypeDef | null = u ? utype(s, u.type) : null;
  const cat = def ? (CATEGORY_INDEX[def.category] ?? 0) : -1;
  for (let k = 0; k < 4; k++) put(k === cat ? 1 : 0);
  put(def && u ? u.hp / Math.max(1, def.maxHp) : 0);
  put(u?.moved ? 1 : 0);
  put(u?.acted ? 1 : 0);
  put(def ? def.atk / 30 : 0);
  put(def ? def.armor / 12 : 0);
  put(def ? (def.range ?? 1) / 5 : 0);
  put(def ? def.move / 6 : 0);
  // 造价 / 我这回合的收入：几回合的积蓄换一个兵。v2 不再除以常数 200
  put(def ? def.cost / Math.max(1, ctx.income) / 10 : 0);
  put(def ? def.era / 5 : 0);
  put(u ? u.x / w : 0);
  put(u ? u.y / h : 0);

  // 离我最近城的距离：AI 的"离家多远"直觉，网络也该有
  put(u ? (ctx.homeDist.get(u.id) ?? 12) / 12 : 1);
  // 离最近敌人的距离
  put(u ? (ctx.foeDist.get(u.id) ?? 12) / 12 : 1);
  put(u ? (ctx.valueOf.get(u.id) ?? 0) / UNIT_VALUE_SCALE : 0);

  // ── 目标：各种动作指向不同的东西，统一到同一组槽位 ──────────────────
  let tgt: Unit | undefined;
  let city: City | undefined;
  let tile: { x: number; y: number } | undefined;
  let tDef: UnitTypeDef | null = null;

  if (a.type === 'ATTACK') {
    tgt = ctx.unitById.get(a.targetId);
    if (tgt) tDef = utype(s, tgt.type);
    tile = tgt;
  } else if (a.type === 'MOVE') {
    tile = { x: a.x, y: a.y };
  } else if (a.type === 'SIEGE' || a.type === 'UPGRADE') {
    city = ctx.cityById.get(a.cityId);
    tile = city;
  } else if (a.type === 'RECRUIT' && a.cityId) {
    city = ctx.cityById.get(a.cityId);
    tile = city;
  } else if (a.type === 'RECRUIT') {
    tDef = s.unitTypes[a.unitType] ?? null;
  } else if (a.type === 'BUILD') {
    tile = { x: a.x, y: a.y };
    tDef = s.unitTypes[a.unitType] ?? null;
  } else if (a.type === 'UNLOAD') {
    tile = { x: a.x, y: a.y };
  } else if (a.type === 'PLACE_EGG') {
    tile = { x: a.x, y: a.y };
  } else if (a.type === 'LOAD' || a.type === 'DISBAND') {
    // 目标在货舱/自己身上：没有格点，用发起单位的位置
    tile = u ? { x: u.x, y: u.y } : undefined;
  }

  put(tile || tDef ? 1 : 0);
  put(tgt && tDef ? tgt.hp / Math.max(1, tDef.maxHp) : 0);
  put(u && tile ? distance(u, tile) / 10 : 0);
  {
    const t = tile ? tileAt(s, tile.x, tile.y) : null;
    put(t ? (TERRAIN_VALUE[t.terrain] ?? 0.5) : 0);
  }
  // 落点/目标所在的格子归属
  {
    const t = tile ? tileAt(s, tile.x, tile.y) : null;
    const c = t?.cityId ? ctx.cityById.get(t.cityId) : undefined;
    put(c && c.owner !== ctx.seat && !c.ruined ? 1 : 0);
    put(c && c.owner === ctx.seat && !c.ruined ? 1 : 0);
    put(c?.ruined ? 1 : 0);
    // 落点上站着人（不管敌我）：MOVE 的落点绝不会有人，ATTACK 的落点必然有人
    put(tile && s.units.some((x) => x.hp > 0 && x.x === tile!.x && x.y === tile!.y) ? 1 : 0);
  }
  put(city && city.owner === ctx.seat ? 1 : 0);

  // ── 兵种（RECRUIT / BUILD 时才是"要造的那个"）────────────────────
  const recDef = (a.type === 'RECRUIT' || a.type === 'BUILD') ? (s.unitTypes[a.unitType] ?? null) : null;
  const rcat = recDef ? (CATEGORY_INDEX[recDef.category] ?? 0) : -1;
  for (let k = 0; k < 4; k++) put(k === rcat ? 1 : 0);
  put(recDef ? recDef.atk / 30 : 0);
  put(recDef ? recDef.armor / 12 : 0);
  put(recDef ? (recDef.range ?? 1) / 5 : 0);
  put(recDef ? recDef.cost / 200 : 0);
  put(recDef ? recDef.era / 5 : 0);
  put(recDef?.hero ? 1 : 0);
  put(recDef?.category === 'economy' ? 1 : 0);
  // 造价 / 我这回合的收入：几回合的积蓄换一个兵
  put(recDef ? recDef.cost / Math.max(1, ctx.income) : 0);

  // ── 结果预估（都是粗估，只用 atk/armor/hp，不跑 computeDamage）──────
  {
    const atk = def?.atk ?? 0;
    const lethal = tgt && tDef ? atk - tDef.armor >= tgt.hp : false;
    put(lethal ? 1 : 0);
    put(city ? (atk - city.armor >= city.hp ? 1 : 0) : 0);
    put(city ? city.era / 5 : 0);
    put(city ? city.hp / Math.max(1, city.maxHp) : 0);
    // 城离我最近单位的距离：攻城是不是"够得着"
    put(city ? (ctx.cityGuard.get(city.id) ?? 12) / 12 : 1);
  }
  put(ctx.gold / 150);
  put(ctx.income / 30);
  // 结束回合时还有兵没动完？那是一次"提前收手"
  put(a.type === 'END_TURN' && ctx.hasIdle ? 1 : 0);
  put(0);

  // 写满的格数必须恰好是 62：多写少写都会让训练读到错位的特征，宁可在加载时就炸
  if (i - base !== ACTION_DIM) {
    throw new Error(`动作特征维度不对：写了 ${i - base} 格，应为 ${ACTION_DIM}`);
  }
}

/** 资源 id 列表（给别的脚本按槽位解释特征用） */
export const RESOURCE_SLOTS: ResourceId[] = RESOURCES.slice(0, RES_SLOTS).map((r) => r.id);

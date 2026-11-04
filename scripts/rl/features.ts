/**
 * 观测编码：把一局棋变成一个网络能吃的数字块。
 *
 * ── 三组特征，各有各的理由 ───────────────────────────────────────────────
 *
 * 1. **全局**（40 维）：钱、收入、时代、城数、兵力值、双方对比、地图水域占比…
 *    这些是"我现在是赢是输"的粗坐标。价值头主要靠它，动作打分也靠它定基调。
 *
 * 2. **局面**（6×6×3 = 108 维）：把地图粗化到 6×6，三个平面记地形、兵力、城市归属。
 *    为什么不按原尺寸铺（12×12×N）：那会让"状态 ⊕ 动作"的维度翻三倍，
 *    而线性预筛的成本正比于维度。6×6 在 12×12 的图上每格约 2×2，
 *    "这一带有我的兵/有他的城"这类信息还留得住，细节交给全局的最近距离特征。
 *
 * 3. **动作**（56 维）：动作类型、发起单位、目标、结果预估。
 *    动作打分头要对几百个动作各打一个分，所以每个动作的特征必须能**独立算出来**，
 *    不能依赖"和别的动作比"。这也是为什么动作特征里没有"这是不是最好的那条"。
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
import {
  citiesOf,
  distance,
  distToCity,
  incomeOf,
  tileAt,
  upgradeCostOf,
  utype,
} from '../../src/core/rules.ts';
import { unitValue } from '../../src/core/ai-tactics.ts';
import type { Action, City, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from '../../src/core/types.ts';

/** 全局特征的维度。改它必须同时改下面的编码函数（末尾有断言） */
export const GLOBAL_DIM = 40;
/** 粗化网格边长 */
export const BOARD_N = 6;
/** 粗化平面数：地形 / 兵力 / 城市归属 */
export const BOARD_PLANES = 3;
export const BOARD_DIM = BOARD_N * BOARD_N * BOARD_PLANES;
/** 状态向量 = 全局 + 粗化棋盘 */
export const STATE_DIM = GLOBAL_DIM + BOARD_DIM;
/** 单个动作的特征维度 */
export const ACTION_DIM = 56;

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

/** 一个兵种"值多少"的归一化：造价 + 经济产出，和 AI 用的是同一套口径 */
const UNIT_VALUE_SCALE = 200;

/** 战斗单位之外的类别：给动作特征用 */
const CATEGORY_INDEX: Record<string, number> = { combat: 0, economy: 1, builder: 2, building: 3 };

/** 这一方是不是我（从 seat 视角） */
const rel = (owner: PlayerId, seat: PlayerId): number => (owner === seat ? 1 : -1);

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
}

/**
 * 汇总一方的粗指标。
 *
 * `era` 取"最高的一座城"而不是平均：能造几代兵只取决于最好的那座城，
 * 平均值会让"三座一代城 + 一座五代城"看起来像个二代文明。
 */
function sideOf(s: GameState, p: PlayerId): Side {
  const cities = citiesOf(s, p).filter((c) => !c.ruined);
  let value = 0;
  let hp = 0;
  let maxHp = 0;
  let economy = 0;
  let ranged = 0;
  let cx = 0;
  let cy = 0;
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
  }
  const units = s.units.filter((u) => u.owner === p && u.hp > 0).length;
  return {
    gold: s.players[p].gold,
    income: incomeOf(s, p),
    cities: cities.length,
    cityEra: cities.reduce((n, c) => Math.max(n, c.era), 0),
    units,
    value,
    hpRatio: maxHp > 0 ? hp / maxHp : 0,
    economy,
    ranged,
    centroid: units > 0 ? { x: cx / units, y: cy / units } : null,
    era: cities.reduce((n, c) => Math.max(n, c.era), 0),
  };
}

/**
 * 编码全局特征（40 维）。
 *
 * 顺序一旦定下就不能动：训练好的权重是按位置读的。要加特征只能往末尾追。
 */
export function encodeGlobal(s: GameState, seat: PlayerId, out?: Float32Array): Float32Array {
  const f = out ?? new Float32Array(GLOBAL_DIM);
  const me = sideOf(s, seat);
  const foes: Side[] = [];
  for (const p of Object.keys(s.players) as PlayerId[]) if (p !== seat) foes.push(sideOf(s, p));
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
    }),
    { gold: 0, income: 0, cities: 0, cityEra: 0, units: 0, value: 0, hpRatio: 0, economy: 0, ranged: 0, centroid: null, era: 0 },
  );

  // ── 战况：钱、收入、时代、城、兵、兵力值 ────────────────────────────
  f[0] = nz(s.turn, 120);
  f[1] = nz(me.gold, 150);
  f[2] = nz(me.income, 30);
  f[3] = nz(foe.gold, 150);
  f[4] = nz(foe.income, 30);
  f[5] = nz(me.era, 5);
  f[6] = nz(foe.era, 5);
  f[7] = nz(me.cities, 5);
  f[8] = nz(foe.cities, 5);
  f[9] = nz(me.units, 12);
  f[10] = nz(foe.units, 12);
  f[11] = nz(me.value, 1200);
  f[12] = nz(foe.value, 1200);
  // 兵力对比：用比值而不是差值，1 万对 9 千和 1 千对 0 是两回事
  f[13] = me.value + foe.value > 0 ? me.value / (me.value + foe.value) : 0.5;
  f[14] = nz(me.economy, 6);
  f[15] = nz(foe.economy, 6);
  f[16] = nz(me.ranged, 6);
  f[17] = nz(foe.ranged, 6);
  f[18] = clip(me.hpRatio);
  // 对面临时汇总的 hpRatio 没算（要再扫一遍），这里单独算：它是个常用信号
  {
    let hp = 0;
    let max = 0;
    for (const u of s.units) {
      if (u.owner === seat || u.hp <= 0) continue;
      hp += u.hp;
      max += utype(s, u.type).maxHp;
    }
    f[19] = max > 0 ? clip(hp / max) : 0;
  }
  // 存款能撑几个回合的收入：0 就是"这回合不造兵就没钱造了"。按 10 回合归一
  f[20] = clip(me.gold / Math.max(1, me.income) / 10);
  f[21] = clip(foe.gold / Math.max(1, foe.income) / 10);

  // ── 地图 ────────────────────────────────────────────────────────────
  let water = 0;
  for (const t of s.tiles) if (t.terrain === 'water' || t.terrain === 'deep') water += 1;
  f[22] = s.tiles.length > 0 ? clip(water / s.tiles.length) : 0;

  const mine = s.units.filter((u) => u.owner === seat && u.hp > 0);
  const myCities = citiesOf(s, seat).filter((c) => !c.ruined);
  const home = myCities.length
    ? {
        x: myCities.reduce((n, c) => n + c.x, 0) / myCities.length,
        y: myCities.reduce((n, c) => n + c.y, 0) / myCities.length,
      }
    : me.centroid;
  f[23] = home ? clip(home.x / Math.max(1, s.w)) : 0.5;
  f[24] = home ? clip(home.y / Math.max(1, s.h)) : 0.5;

  // 最近的一对敌我单位：这个数直接决定"现在该打还是该退"
  let nearestFoe = 99;
  for (const a of mine) {
    for (const b of s.units) {
      if (b.owner === seat || b.hp <= 0) continue;
      const d = distance(a, b);
      if (d < nearestFoe) nearestFoe = d;
    }
  }
  f[25] = nearestFoe === 99 ? 1 : nz(nearestFoe, 12);

  // 兵力集中度：有多少兵在我城 4 格内（守家的兵力比例）
  {
    let near = 0;
    for (const u of mine) if (myCities.some((c) => distToCity(u, c) <= 4)) near += 1;
    f[26] = mine.length > 0 ? clip(near / mine.length) : 0;
  }
  // 还有多少兵没动 / 没打：回合内"还有事可做"的程度
  {
    let moved = 0;
    let acted = 0;
    for (const u of mine) {
      if (u.moved) moved += 1;
      if (u.acted) acted += 1;
    }
    f[27] = mine.length > 0 ? clip(moved / mine.length) : 0;
    f[28] = mine.length > 0 ? clip(acted / mine.length) : 0;
  }
  // 有多少兵已经站在能打到敌城的距离上（攻城窗口）
  {
    let siegers = 0;
    const foeCities = s.cities.filter((c) => c.owner !== seat && !c.ruined);
    for (const u of mine) {
      const def = utype(s, u.type);
      if (def.category !== 'combat') continue;
      if (foeCities.some((c) => distToCity(u, c) <= (def.range ?? 1))) siegers += 1;
    }
    f[29] = nz(siegers, 6);
  }

  // ── 城市细节 ────────────────────────────────────────────────────────
  {
    const hpOf = (list: typeof myCities) =>
      list.length ? list.reduce((n, c) => n + c.hp / Math.max(1, c.maxHp), 0) / list.length : 0;
    f[30] = clip(hpOf(myCities));
    f[31] = clip(hpOf(s.cities.filter((c) => c.owner !== seat && !c.ruined)));
    // 废墟：自己的城塌了但还没被接管 —— 这是"马上丢城"的信号
    f[32] = nz(s.cities.filter((c) => c.owner === seat && c.ruined).length, 3);
    f[33] = nz(s.cities.filter((c) => c.owner !== seat && c.ruined).length, 3);
    // 城离最近敌军的距离（被围城的紧迫度）
    let siegePressure = 99;
    for (const c of myCities) {
      for (const b of s.units) {
        if (b.owner === seat || b.hp <= 0) continue;
        const d = distToCity(b, c);
        if (d < siegePressure) siegePressure = d;
      }
    }
    f[34] = siegePressure === 99 ? 1 : nz(siegePressure, 8);
    f[35] = nz(myCities.length > 0 ? Math.min(...myCities.map((c) => c.hp)) / Math.max(1, Math.max(...myCities.map((c) => c.maxHp))) : 0, 1);
  }

  // ── 扩张与产线 ──────────────────────────────────────────────────────
  f[36] = nz(myCities.length > 0 ? Math.max(...myCities.map((c) => c.size)) : 0, 3);
  // 现在能不能升城：离"最便宜那次升级"还差多少。这是"该攒钱还是该花"的直接信号
  {
    let cheapest = Infinity;
    for (const c of myCities) {
      const cost = upgradeCostOf(s, c);
      if (cost !== null && cost < cheapest) cheapest = cost;
    }
    f[37] = Number.isFinite(cheapest) ? clip(me.gold / Math.max(1, cheapest)) : 0;
  }
  // 对面最强的城有几代：代差是这游戏最硬的胜负手
  f[38] = nz(foe.cityEra, 5);
  f[39] = clip((me.era - foe.era) / 3);
  return f;
}

/**
 * 编码粗化棋盘（108 维 = 6×6×3 平面）。
 *
 * 平面 0 地形、平面 1 兵力（净，我正敌负）、平面 2 城市归属。
 * 每格的值都夹在 [-1, 1]，所以三组平面能共用一个尺度。
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

  // 地形：每格取平均可通行度
  const counts = new Float32Array(plane);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const t = tileAt(s, x, y);
      const c = cell(x, y);
      f[c] += t ? TERRAIN_VALUE[t.terrain] ?? 0.5 : 0;
      counts[c] += 1;
    }
  }
  for (let i = 0; i < plane; i++) if (counts[i]! > 0) f[i] = clip(f[i]! / counts[i]!);

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

/** 状态向量 = 全局 ⊕ 粗化棋盘。`out` 可复用，避免每步新建 148 个 float */
export function encodeState(s: GameState, seat: PlayerId, out?: Float32Array): Float32Array {
  const f = out ?? new Float32Array(STATE_DIM);
  encodeGlobal(s, seat, f.subarray(0, GLOBAL_DIM) as Float32Array);
  encodeBoard(s, seat, f.subarray(GLOBAL_DIM) as Float32Array);
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
    income: incomeOf(s, seat),
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
 * 编码一批动作（N × 56，平铺成一个 Float32Array）。
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

/** 一个动作的特征：写进 `f` 的 `base` 起 56 格 */
function encodeOne(s: GameState, ctx: ActionContext, a: Action, f: Float32Array, base: number): void {
  const w = Math.max(1, s.w);
  const h = Math.max(1, s.h);
  let i = base;
  const put = (v: number) => {
    f[i++] = clip(v);
  };

  // 类型 one-hot（7）
  const kind =
    a.type === 'MOVE' ? 0
    : a.type === 'ATTACK' ? 1
    : a.type === 'SIEGE' ? 2
    : a.type === 'RECRUIT' ? (a.cityId ? 3 : 4)
    : a.type === 'UPGRADE' ? 5
    : a.type === 'END_TURN' ? 6
    : 7;
  for (let k = 0; k < 7; k++) put(k === kind ? 1 : 0);

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
  put(def ? def.cost / 200 : 0);
  put(def ? def.era / 5 : 0);
  put(u ? u.x / w : 0);
  put(u ? u.y / h : 0);

  // 离我最近城的距离：AI 的"离家多远"直觉，网络也该有
  put(u ? (ctx.homeDist.get(u.id) ?? 12) / 12 : 1);
  // 离最近敌人的距离
  put(u ? (ctx.foeDist.get(u.id) ?? 12) / 12 : 1);
  put(u ? (ctx.valueOf.get(u.id) ?? 0) / UNIT_VALUE_SCALE : 0);

  // ── 目标：三种动作指向三种东西，统一到同一组槽位 ──────────────────
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

  // ── 兵种（RECRUIT 时才是"要造的那个"）────────────────────────────
  const recDef = a.type === 'RECRUIT' ? (s.unitTypes[a.unitType] ?? null) : null;
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

  // 写满的格数必须恰好是 56：多写少写都会让训练读到错位的特征，宁可在加载时就炸
  if (i - base !== ACTION_DIM) {
    throw new Error(`动作特征维度不对：写了 ${i - base} 格，应为 ${ACTION_DIM}`);
  }
}

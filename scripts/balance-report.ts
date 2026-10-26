/**
 * 平衡统计器：按时代批量跑 AI 对 AI，算兵种的交换比、每 100 金输出、采用率和先后手胜率。
 *
 * 为什么单独写一个而不是改 test/sim：这些数字要跑几十局才有意义，
 * 而且口径必须是"只看野战交换"——把攻城、城陷守军损失也算进来，
 * 一个从头到尾没打过硬仗的炮兵会因为最后拆城拿到漂亮数据。
 *
 * 口径：
 *   · 只统计 ATTACK 动作造成的单位掉血。攻城打的是城市耐久，不算单位交换。
 *   · 溅射算在开火方头上（一炮打三个，就是这一个兵种的输出）。
 *   · 反击算在防守方头上（挨打之后还手打出的伤害，是防守兵种的能力）。
 *   · 开局就摆在棋盘上的兵和后来招的兵分开记：招的兵才对应"这笔钱花得值不值"，
 *     开局那些是免费给的，混在一起会把每 100 金输出算虚。
 *
 * 用法：
 *   node --experimental-strip-types scripts/balance-report.ts --era 1 --games 30 --seed 900
 * 输出：  results/balance-era1.json（每个时代一个文件，便于三个进程并行跑）
 */

import { DEFAULT_SIZE_FOR_ERA } from '../src/ui/setup-panel.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import {
  applyAction,
  armySize,
  citiesOf,
  distToCity,
  idx,
  inBounds,
  recruitCost,
  tileAt,
  unitAt,
  unitsOf,
  utype,
} from '../src/core/rules.ts';
import { CONFIG, UNIT_TYPES, eraDef } from '../src/core/config.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { Action, City, GameState, PlayerId, Terrain, Unit } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const ERA = Number(argOf('era', '1'));
const GAMES = Number(argOf('games', '30'));
const BASE_SEED = Number(argOf('seed', '900'));
const CAP = Number(argOf('cap', '200')); // 回合上限，超过算"未决"
const OUT = argOf('out', `results/balance-era${ERA}.json`);
/** 给了这个目录就把每一局"打到上限还没分出胜负"的终局场面存下来 */
const DRAWS = argOf('draws', '');
/**
 * 开哪些扩展规则，逗号分隔；`none` 表示一个都不开。
 * 默认只开「血战」——前面几轮的平衡基线都是这么跑的，要跟历史结果对得上就不能变。
 * 想带上「先后手补偿」就跑 `--expansions bloodbath,turn-order-comp`；
 * 要测某个 DLC 的影响，就跟 `--expansions none`（或别的组合）配对跑同种子。
 */
const EXPANSIONS = (() => {
  const v = argOf('expansions', 'bloodbath');
  if (v === 'none') return [] as string[];
  return v.split(',').map((x) => x.trim()).filter(Boolean);
})();
/**
 * 棋盘边长：不给就按时代默认（古典 12、中世 16、火药以上 20）。
 * 要测"同一尺寸下不同时代的先后手差距"时，必须能把这个变量按住。
 */
const SIZE = Number(argOf('size', '0'));
/**
 * 后手（B）开局金币补偿比例，默认 0。
 * 测"先手优势能不能用钱补回来"时用，例如 `--second-bonus 0.05`。
 */
const SECOND_BONUS = Number(argOf('second-bonus', '0'));
/** 带上这个开关就表示"先手第一回合不结算收入"（测结构性配平时用） */
const NO_FIRST_INCOME = args.includes('--no-first-income');
/**
 * 指挥官模式：双方每回合都只能产 1 个兵（和界面层 runAiTurn 的口径一致）。
 *
 * 双 AI 跑批里，"指挥官模式"和普通模式的差别**只有这一条**：AI 本来就不排生产序列，
 * 而人类那侧"排 5 格、AI 执行"在跑批里没有等价物（没有会排序列的 AI）。
 * 所以这里测的是"产能从每回合 2 个砍到 1 个"本身，别把它当成完整的指挥官体验。
 */
const COMMANDER = args.includes('--commander');
/** 给了路径就额外写一份 Markdown 表格（模组平衡报告直接引用这一份） */
const MD = argOf('md', '');

/** 一个兵种的累计账 */
interface Tally {
  built: number; // 招募数量
  spend: number; // 招募花掉的金币
  /** 招募出来的兵打出的伤害 */
  dealt: number;
  /** 招募出来的兵承受的伤害 */
  taken: number;
  kills: number;
  /** 开局白送的那批兵，单独记 */
  initDealt: number;
  initTaken: number;
  initCount: number;
}

interface TypeStat {
  type: string;
  name: string;
  era: number;
  category: string;
  cost: number;
  built: number;
  spend: number;
  share: number; // 招募次数占比
  goldShare: number; // 招募金币占比
  dealt: number;
  taken: number;
  ratio: number | null; // 交换比 = 输出 / 承伤；承伤为 0 记 null（∞）
  per100: number; // 每 100 金输出（杀伤）
  /** 每 100 金承伤：这笔钱在前线"吸"了多少伤害，衡量的是坦度而不是硬度 */
  per100Taken: number;
  kills: number;
  initCount: number;
  initRatio: number | null;
}

interface GameResult {
  era: number;
  size: number;
  seed: number;
  winner: string | null;
  turns: number;
  steps: number;
  recruitsA: number;
  recruitsB: number;
  unitsA: number;
  unitsB: number;
  /**
   * 第一座被攻下的城。
   *
   * 这一个字段就是"滚雪球"的起点：谁先破城、对手有没有在**下一个自己的回合**
   * 把它抢回来。抢回来了，这只是一次交换；抢不回来，就是三城打两城。
   */
  firstCap: {
    turn: number;
    by: string;
    city: string;
    /** 城被原主抢回来的回合；从没抢回来就是 null */
    retakeTurn: number | null;
    /** 是不是在对手的下一个回合内就抢回来了 */
    retakenNext: boolean;
  } | null;
  /** 终局双方城数 */
  citiesA: number;
  citiesB: number;
  /** 整局城市易主次数 */
  flipCount: number;
  /**
   * 每一次城市易主的完整流水。
   *
   * 只留"第一次"是不够的：玩家真正问的是"城换了手、短时间又没被抢回来"这个状态，
   * 它可能发生在第二座城、第三座城上。有了流水，报告那边才能按"几回合内没夺回"分档。
   */
  flipLog: Array<{ turn: number; city: string; from: string; to: string }>;
}

/**
 * 一局打到上限还没分胜负时的现场。
 *
 * 磨局不是一种毛病，是好几种："兵根本过不去""兵到城下了但破不了甲"
 * "伤害摊在三座城上谁都没拆穿""前 150 回合打得热闹，最后 50 回合集体发呆"。
 * 所以这里不存一句结论，而是把判断结论需要的原始数字全存下来：
 * 距离、护甲、累计攻城伤害、最近 40 回合的动作次数、以及完整棋盘。
 */
interface DrawInfo {
  seed: number;
  era: number;
  turn: number;
  compA: Record<string, number>;
  compB: Record<string, number>;
  /** 能开火的战斗单位数（建筑、农民不算） */
  combatA: number;
  combatB: number;
  hpA: number;
  hpB: number;
  citiesA: number;
  citiesB: number;
  /** 单位总数（含建筑和经济单位——CONFIG.maxUnits 数的是这个） */
  armyA: number;
  armyB: number;
  /** 编制上限 */
  cap: number;
  /** 场上已有的桥数量 */
  bridgesA: number;
  bridgesB: number;
  /**
   * 全图最窄的一条"一条直线走到底"的过河线要连铺几座桥；0 = 没有这样的窄口。
   * 这条数字决定了"过不去"到底是地形问题还是架桥问题：
   * 要连铺 3 座，说明不是 AI 笨，是这条河压根不该这么宽。
   */
  bandGap: number;
  /** 城市总耐久 / 满耐久 */
  cityHpA: number;
  cityFullA: number;
  cityHpB: number;
  cityFullB: number;
  cityArmorA: number;
  cityArmorB: number;
  goldA: number;
  goldB: number;
  /** 到对方城市的最近曼哈顿距离；-1 表示没有兵 */
  nearestA: number;
  nearestB: number;
  /** 这一回合就已经打在城下的单位数 */
  onWallA: number;
  onWallB: number;
  /**
   * 只按地形连通性判断（不考虑回合数）：这批兵这辈子有没有可能摸到敌城。
   * false = 被水/山隔死；null = 已经没有能动的兵了。
   */
  reachA: boolean | null;
  reachB: boolean | null;
  attacksA: number;
  attacksB: number;
  siegesA: number;
  siegesB: number;
  /** 累计打进城市耐久的总伤害 */
  siegeDmgA: number;
  siegeDmgB: number;
  recentAttacksA: number;
  recentAttacksB: number;
  recentSiegesA: number;
  recentSiegesB: number;
  lastSiegeA: number;
  lastSiegeB: number;
  /** 主因标签，同类聚在一起才能看出"磨局主要是哪种" */
  cause: string;
  /** 带数字的一句话，别只给标签 */
  detail: string;
  terrain: string[];
  units: string[];
  unitList: Array<{
    id: string;
    type: string;
    name: string;
    owner: PlayerId;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
  }>;
  cityList: Array<{
    id: string;
    owner: PlayerId;
    x: number;
    y: number;
    era: number;
    hp: number;
    maxHp: number;
    armor: number;
  }>;
  /** 每座被打过的城吃了多少伤害：看得出是不是在摊大饼 */
  cityDmg: Array<{ id: string; owner: PlayerId; dmg: number; hp: number; maxHp: number }>;
}

/** 一局之内的动作计数，专供磨局诊断用 */
interface PlayCounters {
  attacksA: number;
  attacksB: number;
  siegesA: number;
  siegesB: number;
  siegeDmgA: number;
  siegeDmgB: number;
  lastAttackA: number;
  lastAttackB: number;
  lastSiegeA: number;
  lastSiegeB: number;
  /** 城市 id -> 累计吃到的攻城伤害 */
  cityDmg: Map<string, number>;
  /** 回合 -> 这一回合各类动作次数 */
  byTurn: Map<number, { a: number; b: number; sa: number; sb: number }>;
}

function emptyPlay(): PlayCounters {
  return {
    attacksA: 0,
    attacksB: 0,
    siegesA: 0,
    siegesB: 0,
    siegeDmgA: 0,
    siegeDmgB: 0,
    lastAttackA: 0,
    lastAttackB: 0,
    lastSiegeA: 0,
    lastSiegeB: 0,
    cityDmg: new Map(),
    byTurn: new Map(),
  };
}

const TERRAIN_CH: Record<string, string> = {
  plain: '.',
  forest: 'f',
  hill: 'h',
  water: '~',
  mountain: '#',
  bridge: '=',
  city: 'c',
};

/** 两张同尺寸的字符图：地形一张、单位一张。人眼扫一眼就知道卡在哪 */
function boardOf(s: GameState): { terrain: string[]; units: string[] } {
  const terrain: string[] = [];
  const units: string[] = [];
  for (let y = 0; y < s.h; y++) {
    let trow = '';
    let urow = '';
    for (let x = 0; x < s.w; x++) {
      const t = tileAt(s, x, y);
      trow += t ? (TERRAIN_CH[t.terrain] ?? '?') : '?';
      const u = unitAt(s, x, y);
      urow += u ? (utype(s, u.type).short || '?') : '.';
    }
    terrain.push(trow);
    units.push(urow);
  }
  return { terrain, units };
}

/**
 * 地形连通性（不看回合数、不看移动力）。
 *
 * 这是"磨局"和"慢局"的分界线：如果一支部队连一条通到城下的路都没有，
 * 那再打 200 回合也没用，问题在地图/架桥，不在数值。
 * 移动力 0 的建筑和纯经济单位不参与判断——它们本来就不攻城。
 */
function canEverReach(s: GameState, p: PlayerId, foes: City[]): boolean | null {
  if (foes.length === 0) return true;
  const DIRS4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  let tried = 0;
  for (const u of unitsOf(s, p)) {
    const def = s.unitTypes[u.type];
    if (!def || def.category === 'building' || def.move <= 0 || def.atk <= 0) continue;
    tried += 1;
    const waterUnit = def.domain === 'water';
    const seen = new Set<number>([idx(s, u.x, u.y)]);
    const queue: Array<{ x: number; y: number }> = [{ x: u.x, y: u.y }];
    while (queue.length > 0) {
      const cur = queue.shift() as { x: number; y: number };
      for (const c of foes) if (distToCity(cur, c) <= Math.max(1, def.range)) return true;
      for (const [dx, dy] of DIRS4) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (!inBounds(s, nx, ny)) continue;
        const t = tileAt(s, nx, ny);
        if (!t) continue;
        // 陆军进不了水（桥面算路）；水军只能待在航道和桥下
        if (waterUnit) {
          if (t.terrain !== 'water' && t.terrain !== 'bridge') continue;
        } else if (CONFIG.terrainCost[t.terrain] >= 99) continue;
        const ni = idx(s, nx, ny);
        if (seen.has(ni)) continue;
        seen.add(ni);
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return tried === 0 ? null : false;
}

/** 一条直线（整列/整行）上，两端都接陆地的连续水面最短要几格 —— 也就是最少要连铺几座桥 */
function minBridgeSpan(s: GameState): number {
  const pass = (t: Terrain): boolean => CONFIG.terrainCost[t] < 99;
  let best = 0;
  const consider = (n: number) => {
    if (n > 0 && (best === 0 || n < best)) best = n;
  };
  for (let x = 0; x < s.w; x++) {
    let y = 0;
    while (y < s.h) {
      if (s.tiles[y * s.w + x].terrain !== 'water') {
        y += 1;
        continue;
      }
      const y0 = y;
      while (y < s.h && s.tiles[y * s.w + x].terrain === 'water') y += 1;
      const y1 = y - 1;
      if (y0 > 0 && y1 < s.h - 1) {
        const a = s.tiles[(y0 - 1) * s.w + x];
        const b = s.tiles[(y1 + 1) * s.w + x];
        if (a && b && pass(a.terrain) && pass(b.terrain)) consider(y1 - y0 + 1);
      }
    }
  }
  for (let y = 0; y < s.h; y++) {
    let x = 0;
    while (x < s.w) {
      if (s.tiles[y * s.w + x].terrain !== 'water') {
        x += 1;
        continue;
      }
      const x0 = x;
      while (x < s.w && s.tiles[y * s.w + x].terrain === 'water') x += 1;
      const x1 = x - 1;
      if (x0 > 0 && x1 < s.w - 1) {
        const a = s.tiles[y * s.w + x0 - 1];
        const b = s.tiles[y * s.w + x1 + 1];
        if (a && b && pass(a.terrain) && pass(b.terrain)) consider(x1 - x0 + 1);
      }
    }
  }
  return best;
}

/** 把一局的终局现场摊平成可序列化的快照 */
function drawSnapshot(s: GameState, play: PlayCounters, seed: number): DrawInfo {
  const unitsA = unitsOf(s, 'A');
  const unitsB = unitsOf(s, 'B');
  const citiesA = citiesOf(s, 'A');
  const citiesB = citiesOf(s, 'B');

  const isCombat = (u: Unit): boolean => {
    const d = s.unitTypes[u.type];
    return !!d && d.category === 'combat' && d.atk > 0;
  };
  const combatOf = (us: Unit[]): Unit[] => us.filter(isCombat);
  const comp = (us: Unit[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const u of us) out[u.type] = (out[u.type] ?? 0) + 1;
    return out;
  };
  const nearestTo = (us: Unit[], foes: City[]): number => {
    if (us.length === 0 || foes.length === 0) return -1;
    let best = Infinity;
    for (const u of us) for (const c of foes) best = Math.min(best, distToCity(u, c));
    return best === Infinity ? -1 : best;
  };
  const onWall = (us: Unit[], foes: City[]): number =>
    combatOf(us).filter((u) => {
      const d = s.unitTypes[u.type];
      if (!d) return false;
      return foes.some((c) => distToCity(u, c) <= Math.max(1, d.range));
    }).length;
  const cityHp = (cs: City[]): number => cs.reduce((n, c) => n + Math.max(0, c.hp), 0);
  const cityFull = (cs: City[]): number => cs.reduce((n, c) => n + c.maxHp, 0);
  const cityArmor = (cs: City[]): number => cs.reduce((n, c) => Math.max(n, c.armor), 0);

  const winStart = Math.max(1, s.turn - 40);
  let recentAttacksA = 0;
  let recentAttacksB = 0;
  let recentSiegesA = 0;
  let recentSiegesB = 0;
  for (const [t, r] of play.byTurn) {
    if (t < winStart) continue;
    recentAttacksA += r.a;
    recentAttacksB += r.b;
    recentSiegesA += r.sa;
    recentSiegesB += r.sb;
  }

  const board = boardOf(s);

  const d: DrawInfo = {
    seed,
    era: ERA,
    turn: s.turn,
    compA: comp(unitsA),
    compB: comp(unitsB),
    combatA: combatOf(unitsA).length,
    combatB: combatOf(unitsB).length,
    hpA: unitsA.reduce((n, u) => n + Math.max(0, u.hp), 0),
    hpB: unitsB.reduce((n, u) => n + Math.max(0, u.hp), 0),
    citiesA: citiesA.length,
    citiesB: citiesB.length,
    // 编制只数作战单位：建筑不占编（和 rules.armySize 同一个口径），
    // 否则"24 个单位里只有 4 个能打仗"这种局面会被误报成"编制已满"
    armyA: armySize(s, 'A'),
    armyB: armySize(s, 'B'),
    cap: CONFIG.maxUnits,
    bridgesA: unitsA.filter((u) => !!s.unitTypes[u.type]?.bridges).length,
    bridgesB: unitsB.filter((u) => !!s.unitTypes[u.type]?.bridges).length,
    bandGap: minBridgeSpan(s),
    cityHpA: cityHp(citiesA),
    cityFullA: cityFull(citiesA),
    cityHpB: cityHp(citiesB),
    cityFullB: cityFull(citiesB),
    cityArmorA: cityArmor(citiesA),
    cityArmorB: cityArmor(citiesB),
    goldA: s.players.A.gold,
    goldB: s.players.B.gold,
    nearestA: nearestTo(combatOf(unitsA), citiesB),
    nearestB: nearestTo(combatOf(unitsB), citiesA),
    onWallA: onWall(unitsA, citiesB),
    onWallB: onWall(unitsB, citiesA),
    reachA: canEverReach(s, 'A', citiesB),
    reachB: canEverReach(s, 'B', citiesA),
    attacksA: play.attacksA,
    attacksB: play.attacksB,
    siegesA: play.siegesA,
    siegesB: play.siegesB,
    siegeDmgA: play.siegeDmgA,
    siegeDmgB: play.siegeDmgB,
    recentAttacksA,
    recentAttacksB,
    recentSiegesA,
    recentSiegesB,
    lastSiegeA: play.lastSiegeA,
    lastSiegeB: play.lastSiegeB,
    cause: '',
    detail: '',
    terrain: board.terrain,
    units: board.units,
    unitList: s.units.map((u) => ({
      id: u.id,
      type: u.type,
      name: s.unitTypes[u.type]?.name ?? u.type,
      owner: u.owner,
      x: u.x,
      y: u.y,
      hp: u.hp,
      maxHp: s.unitTypes[u.type]?.maxHp ?? 0,
    })),
    cityList: s.cities.map((c) => ({
      id: c.id,
      owner: c.owner,
      x: c.x,
      y: c.y,
      era: c.era,
      hp: c.hp,
      maxHp: c.maxHp,
      armor: c.armor,
    })),
    cityDmg: Array.from(play.cityDmg.entries())
      .map(([id, dmg]) => {
        const c = s.cities.find((x) => x.id === id);
        return { id, owner: (c?.owner ?? 'A') as PlayerId, dmg, hp: c?.hp ?? 0, maxHp: c?.maxHp ?? 0 };
      })
      .sort((a, b) => b.dmg - a.dmg),
  };

  const verdict = classifyDraw(d);
  d.cause = verdict.cause;
  d.detail = verdict.detail;
  return d;
}

/**
 * 给磨局贴一个主因标签。
 *
 * 顺序就是排查顺序：先看"兵还有没有""路通不通"，这两条是硬阻断；
 * 再看"兵到没到城下"，这是行军问题；最后才看"到了城下打成什么样"。
 * 平均铺伤害那一档是真的会发生的——AI 每回合重新挑最划算的城，
 * 三座城轮着啃，结果哪座都没破。
 */
/**
 * 判定之外再补一句"编制"。24 个单位的硬上限是本作磨局最容易被忽略的一环：
 * 一边顶满了、金库里还压着几千金，它其实已经没有任何"加压"的手段了——
 * 兵是满的、钱是多的、局势是死的。这一句要加在所有成因后面，不能只挂在某一档上。
 */
function capNote(d: DrawInfo): string {
  const parts: string[] = [];
  if (d.armyA >= d.cap && d.goldA >= 800) parts.push(`A 顶满 ${d.cap} 个单位、金库里还压着 ${d.goldA} 金`);
  if (d.armyB >= d.cap && d.goldB >= 800) parts.push(`B 顶满 ${d.cap} 个单位、金库里还压着 ${d.goldB} 金`);
  return parts.length > 0 ? `　另外${parts.join('，')}——编制满了，钱花不出去，也就加不上压力。` : '';
}

function classifyDraw(d: DrawInfo): { cause: string; detail: string } {
  const base = classifyBase(d);
  return { cause: base.cause, detail: base.detail + capNote(d) };
}

function classifyBase(d: DrawInfo): { cause: string; detail: string } {
  const pct = (hp: number, full: number) => (full > 0 ? Math.round((hp / full) * 100) : 0);

  // 1. 一方已经把野战军打光了：城还在，但没人能上去拆
  if (d.combatA === 0 || d.combatB === 0) {
    const dead = d.combatA === 0 ? 'A' : 'B';
    const alive = dead === 'A' ? 'B' : 'A';
    const aliveSiege = dead === 'A' ? d.siegesB : d.siegesA;
    const aliveDmg = dead === 'A' ? d.siegeDmgB : d.siegeDmgA;
    return {
      cause: '一方野战军打光，城却拆不动',
      detail: `${dead} 方一个能开火的单位都不剩了，${alive} 方 ${aliveSiege} 次攻城共打出 ${Math.round(aliveDmg)} 点城市伤害，${dead} 方城防还剩 ${pct(dead === 'A' ? d.cityHpA : d.cityHpB, dead === 'A' ? d.cityFullA : d.cityFullB)}%。`,
    };
  }

  // 2. 地形隔断：有兵、有路可走，但走不到对面
  if (d.reachA === false || d.reachB === false) {
    const who = d.reachA === false && d.reachB === false ? '双方' : d.reachA === false ? 'A 方' : 'B 方';
    const span =
      d.bandGap === 1
        ? '图里最窄的地方只差 1 座桥就能过去'
        : d.bandGap > 0
          ? `图里最窄的一条过河线要连铺 ${d.bandGap} 座桥`
          : '图里没有一条能直线铺过去的窄口';
    return {
      cause: '地形隔断（走不到对面城下）',
      detail: `${who}按地形连通性找不到一条通往敌方城市的路线，最近的部队还隔着 ${d.reachA === false ? d.nearestA : d.nearestB} 格。${span}；场上现有 A ${d.bridgesA} 座、B ${d.bridgesB} 座，一条都没铺通，所以谁也过不去。`,
    };
  }

  // 3. 双方都没有兵站到城下：卡在行军
  if (d.onWallA === 0 && d.onWallB === 0) {
    return {
      cause: '卡在行军（谁也到不了城下）',
      detail: `A 到 B 城最近 ${d.nearestA} 格、B 到 A 城最近 ${d.nearestB} 格；最近 40 回合只打了 ${d.recentAttacksA + d.recentAttacksB} 次野战、攻城 ${d.recentSiegesA + d.recentSiegesB} 次。兵在野外围着，推不进城墙。`,
    };
  }

  // 4. 后期停摆：前中期在打，最后 40 回合一次攻城都没有
  if (d.recentSiegesA + d.recentSiegesB === 0 && d.siegesA + d.siegesB > 0) {
    const last = Math.max(d.lastSiegeA, d.lastSiegeB);
    return {
      cause: '后期停摆（最后一次攻城在第 ' + last + ' 回合）',
      detail: `前 ${last} 回合打了 ${d.siegesA + d.siegesB} 次攻城，之后 40 回合一次都没有；双方还剩 ${d.combatA}/${d.combatB} 个战斗单位、金库 ${d.goldA}/${d.goldB}，兵和金都有，就是不再往前压。`,
    };
  }

  const hitCities = d.cityDmg.filter((c) => c.dmg > 0);

  // 4.4 城被抢来抢去：累计吃到的伤害超过了城的满耐久，却没有一座城被打下来。
  // 城一易主，耐久按 captureHpRatio 重置，等于每次把之前的伤害清零。
  // 这一条比"回血"更常见，也更容易被误读成"打不动"——其实打得动，只是站不住。
  const flipped = hitCities.filter((c) => c.dmg > c.maxHp * 1.05);
  if (flipped.length > 0) {
    const list = flipped
      .map((c) => `${c.id} 累计吃 ${Math.round(c.dmg)} 点（满耐久 ${c.maxHp}），现在 ${c.owner} 方手上、还剩 ${pct(c.hp, c.maxHp)}%`)
      .join('；');
    return {
      cause: '城市反复易主（耐久被重置）',
      detail: `${list}。城被攻陷后耐久会按比例重置，抢来抢去等于每次把伤害清零：双方累计攻城 ${Math.round(d.siegeDmgA)} / ${Math.round(d.siegeDmgB)} 点，谁也没能在城里站住。`,
    };
  }

  // 4.5 打进去的伤害又被回血补回来了（血战要到第 50 回合才关掉城市回血）
  const healed = hitCities.filter((c) => c.dmg >= 20 && c.hp >= c.maxHp * 0.98);
  if (healed.length > 0) {
    const list = healed.map((c) => `${c.id} 吃了 ${Math.round(c.dmg)} 点又回满`).join('、');
    return {
      cause: '城防回血（伤害被补回来）',
      detail: `${list}。第 50 回合前城市还在每回合回血，攻方的持续输出低于回血速度，等于白打。`,
    };
  }

  // 5. 攻城伤害摊在几座城上，谁都没破
  const lowCities = hitCities.filter((c) => c.hp / Math.max(1, c.maxHp) < 0.5);
  if (hitCities.length >= 2 && lowCities.length === 0) {
    const list = hitCities.map((c) => `${c.id} 剩 ${pct(c.hp, c.maxHp)}%`).join('、');
    return {
      cause: '伤害摊在几座城上，谁都没拆穿',
      detail: `一共啃过 ${hitCities.length} 座城（${list}），但没有一座掉到一半以下；总攻城伤害 ${Math.round(d.siegeDmgA + d.siegeDmgB)} 点被分薄了。`,
    };
  }

  // 6. 破不了防：攻城次数不少，伤害却几乎为零（护甲吃掉全部输出）
  if (d.siegesA + d.siegesB >= 10 && d.siegeDmgA + d.siegeDmgB < 20) {
    return {
      cause: '破不了城防（伤害被护甲吃光）',
      detail: `${d.siegesA + d.siegesB} 次攻城只打出 ${Math.round(d.siegeDmgA + d.siegeDmgB)} 点伤害，对面城护甲 ${Math.max(d.cityArmorA, d.cityArmorB)}——攻方的攻击力压在护甲线上，每一下都被抹平。`,
    };
  }

  // 7. 谁也不肯先上：野战打得凶，但很少攻城
  if (d.siegesA + d.siegesB <= 5 && d.attacksA + d.attacksB > 100) {
    return {
      cause: '只换子不攻城',
      detail: `野战 ${d.attacksA + d.attacksB} 次、攻城只有 ${d.siegesA + d.siegesB} 次；双方野战军一直有得打，就没有余力去拆墙。`,
    };
  }

  // 8. 剩下的就是慢：还在推进，只是 200 回合不够
  return {
    cause: '慢局（还在推进，回合不够）',
    detail: `双方都还有兵顶在城下（A ${d.onWallA} 个、B ${d.onWallB} 个），城防已掉到 A ${pct(d.cityHpA, d.cityFullA)}% / B ${pct(d.cityHpB, d.cityFullB)}%，差的是回合数而不是能力。`,
  };
}

function emptyTally(): Tally {
  return {
    built: 0,
    spend: 0,
    dealt: 0,
    taken: 0,
    kills: 0,
    initDealt: 0,
    initTaken: 0,
    initCount: 0,
  };
}

function runGame(seed: number): {
  result: GameResult;
  tallies: Map<string, Tally>;
  draw: DrawInfo | null;
} {
  const size = SIZE > 0 ? SIZE : DEFAULT_SIZE_FOR_ERA(ERA);
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size,
      startEra: ERA,
      aiOpponent: true,
      aiAlly: true,
      aiLevel: 'advanced',
      expansionIds: EXPANSIONS,
      secondGoldBonus: SECOND_BONUS,
      noFirstIncome: NO_FIRST_INCOME,
      commanderMode: COMMANDER,
    },
    seed,
  );

  const tallies = new Map<string, Tally>();
  const tallyOf = (type: string): Tally => {
    let t = tallies.get(type);
    if (!t) {
      t = emptyTally();
      tallies.set(type, t);
    }
    return t;
  };

  // 开局就存在的单位记为"白送"，后面招的才算投入
  const initialIds = new Set(s.units.map((u) => u.id));
  for (const u of s.units) tallyOf(u.type).initCount += 1;

  let steps = 0;
  let turns = 0;
  let recruitsA = 0;
  let recruitsB = 0;
  const play = emptyPlay();
  /** 城市易主流水：整局记下来，事后再判"首城"和"有没有立刻抢回来" */
  const flips: Array<{ turn: number; cityId: string; from: string; to: string }> = [];
  const turnRec = (t: number) => {
    let r = play.byTurn.get(t);
    if (!r) {
      r = { a: 0, b: 0, sa: 0, sb: 0 };
      play.byTurn.set(t, r);
    }
    return r;
  };

  /** 记一笔账 + 结算这一次动作的交换，然后把动作真的打出去 */
  const act = (action: Action): boolean => {
    // 招兵 / 建造先记账（用当下的价格，含扩展规则对造价的改动）
    if (action.type === 'RECRUIT' || action.type === 'BUILD') {
      const def = s.unitTypes[action.unitType];
      if (def) {
        const who = s.current;
        const cost = recruitCost(s, who, def);
        const t = tallyOf(action.unitType);
        t.built += 1;
        t.spend += cost;
        if (action.type === 'RECRUIT') {
          if (who === 'A') recruitsA += 1;
          else recruitsB += 1;
        }
      }
    }

    const before = s;
    const r = applyAction(s, action);
    if (!r.ok) return false;
    const after = r.state;

    // 城市易主：一条一条记，别只记"有没有发生过"——是哪一座、第几回合、谁抢的，后面都要用
    for (const c0 of before.cities) {
      const c1 = after.cities.find((c) => c.id === c0.id);
      if (c1 && c1.owner !== c0.owner) {
        flips.push({ turn: before.turn, cityId: c0.id, from: c0.owner, to: c1.owner });
      }
    }

    // 磨局诊断：动作级计数。攻城伤害要记到"具体哪座城"上，
    // 否则分不清是"打不动"还是"三座城轮着啃、谁都没破"。
    if (action.type === 'ATTACK') {
      const shooter = before.units.find((u) => u.id === action.unitId);
      if (shooter) {
        const r2 = turnRec(before.turn);
        if (shooter.owner === 'A') {
          play.attacksA += 1;
          play.lastAttackA = before.turn;
          r2.a += 1;
        } else {
          play.attacksB += 1;
          play.lastAttackB = before.turn;
          r2.b += 1;
        }
      }
    } else if (action.type === 'SIEGE') {
      const shooter = before.units.find((u) => u.id === action.unitId);
      const c0 = before.cities.find((c) => c.id === action.cityId);
      const c1 = after.cities.find((c) => c.id === action.cityId);
      if (shooter && c0 && c1) {
        const lost = Math.max(0, c0.hp - c1.hp);
        const r2 = turnRec(before.turn);
        if (shooter.owner === 'A') {
          play.siegesA += 1;
          play.siegeDmgA += lost;
          play.lastSiegeA = before.turn;
          r2.sa += 1;
        } else {
          play.siegesB += 1;
          play.siegeDmgB += lost;
          play.lastSiegeB = before.turn;
          r2.sb += 1;
        }
        play.cityDmg.set(c0.id, (play.cityDmg.get(c0.id) ?? 0) + lost);
      }
    }

    // 只统计野战交换
    if (action.type === 'ATTACK') {
      const atk = before.units.find((u) => u.id === action.unitId);
      const tgt = before.units.find((u) => u.id === action.targetId);
      const afterHp = new Map<string, number>();
      for (const u of after.units) afterHp.set(u.id, u.hp);
      const dead = new Set<string>();
      for (const u of before.units) if (!afterHp.has(u.id)) dead.add(u.id);

      if (atk) {
        const atkInitial = initialIds.has(atk.id);
        const at = tallyOf(atk.type);
        for (const u of before.units) {
          const hp = afterHp.get(u.id) ?? 0;
          const lost = Math.max(0, u.hp - hp);
          if (lost <= 0) continue;
          const t = tallyOf(u.type);
          // 承受伤害：不管谁打的，都是这个兵种扛下来的
          if (initialIds.has(u.id)) t.initTaken += lost;
          else t.taken += lost;

          if (u.owner === atk.owner) continue;
          // 敌方掉血 = 开火方这个兵种的输出（溅射也算进来）
          if (atkInitial) at.initDealt += lost;
          else at.dealt += lost;
          if (dead.has(u.id) && !atkInitial) at.kills += 1;
        }
        // 反击：攻击者自己掉的那部分，是防守兵种打出来的
        if (tgt) {
          const selfLost = Math.max(0, atk.hp - (afterHp.get(atk.id) ?? 0));
          if (selfLost > 0) {
            const t = tallyOf(tgt.type);
            if (initialIds.has(tgt.id)) t.initDealt += selfLost;
            else t.dealt += selfLost;
          }
        }
      }
    }

    s = after;
    steps += 1;
    return true;
  };

  while (!s.winner && s.turn <= CAP && turns < CAP * 4) {
    turns += 1;
    // 一回合 = 每回合预算 + 步数上限，和 main.ts 的 runAiTurn 完全同构。
    // 少了这一层，AI 会在一回合里把金库花光——那样测出来的采用率跟实战不是一回事。
    const budget = { ...DEFAULT_BUDGET, ...(COMMANDER ? { maxRecruit: 1 } : {}) };
    for (let step = 0; step < AI_MAX_STEPS && !s.winner; step++) {
      const action = aiNextAction(s, budget);
      if (!action) break;
      if (!act(action)) break;
      if (action.type === 'RECRUIT') budget.recruited += 1;
      if (action.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    if (!act({ type: 'END_TURN' })) break;
  }

  const draw = s.winner ? null : drawSnapshot(s, play, seed);

  const result: GameResult = {
    era: ERA,
    size,
    seed,
    winner: s.winner,
    turns: s.turn,
    steps,
    recruitsA,
    recruitsB,
    unitsA: s.units.filter((u) => u.owner === 'A').length,
    unitsB: s.units.filter((u) => u.owner === 'B').length,
    firstCap: null,
    citiesA: citiesOf(s, 'A').length,
    citiesB: citiesOf(s, 'B').length,
    flipCount: flips.length,
    flipLog: flips.map((f) => ({ turn: f.turn, city: f.cityId, from: f.from, to: f.to })),
  };

  const first = flips[0];
  if (first) {
    // "次回合打回来"= 原主在自己紧接着的那个回合里就把城抢回来了。
    // 回合号每换手 +1，所以攻下的那一回合是 T、对手的下一回合就是 T+1。
    const back = flips.find((f) => f.cityId === first.cityId && f.to === first.from && f.turn > first.turn);
    result.firstCap = {
      turn: first.turn,
      by: first.to,
      city: first.cityId,
      retakeTurn: back ? back.turn : null,
      retakenNext: back !== undefined && back.turn <= first.turn + 1,
    };
  }

  return { result, tallies, draw };
}


async function main(): Promise<void> {
  const games: GameResult[] = [];
  const stuck: DrawInfo[] = [];
  const total = new Map<string, Tally>();

  for (let i = 0; i < GAMES; i++) {
    const seed = BASE_SEED + i;
    const { result, tallies, draw } = runGame(seed);
    games.push(result);
    if (draw) stuck.push(draw);

    for (const [type, t] of tallies) {
      const acc = total.get(type) ?? emptyTally();
      acc.built += t.built;
      acc.spend += t.spend;
      acc.dealt += t.dealt;
      acc.taken += t.taken;
      acc.kills += t.kills;
      acc.initDealt += t.initDealt;
      acc.initTaken += t.initTaken;
      acc.initCount += t.initCount;
      total.set(type, acc);
    }

    process.stderr.write(
      `era${ERA} ${i + 1}/${GAMES} seed=${seed} winner=${result.winner ?? '-'} turns=${result.turns}${draw ? ` 未决:${draw.cause}` : ''}\n`,
    );
  }

  // 汇总
  let builtSum = 0;
  let spendSum = 0;
  for (const t of total.values()) {
    builtSum += t.built;
    spendSum += t.spend;
  }

  // 必须把这一轮实际跑的扩展一起传进去：模组单位只存在于"带这个扩展"的兵种表里，
  // 否则这里查不到它们的 cost，两个"每百金"指标会整列变成 0。
  const defs = createMatch(
    { ...DEFAULT_CONFIG, startEra: ERA, expansionIds: EXPANSIONS },
    BASE_SEED,
  ).unitTypes;
  const stats: TypeStat[] = [];
  for (const [type, t] of total) {
    const def = defs[type];
    const cost = def?.cost ?? 0;
    const inv = t.built * cost;
    stats.push({
      type,
      name: def?.name ?? type,
      era: def?.era ?? 0,
      category: def?.category ?? '?',
      cost,
      built: t.built,
      spend: t.spend,
      share: builtSum > 0 ? t.built / builtSum : 0,
      goldShare: spendSum > 0 ? t.spend / spendSum : 0,
      dealt: t.dealt,
      taken: t.taken,
      // 承伤为 0 时比值在数学上是无穷：JSON 没有 Infinity，落成 null 由报表显示成 ∞
      ratio: t.taken > 0 ? t.dealt / t.taken : t.dealt > 0 ? null : 0,
      per100: inv > 0 ? (t.dealt / inv) * 100 : 0,
      per100Taken: inv > 0 ? (t.taken / inv) * 100 : 0,
      kills: t.kills,
      initCount: t.initCount,
      initRatio: t.initTaken > 0 ? t.initDealt / t.initTaken : t.initDealt > 0 ? null : 0,
    });
  }
  stats.sort((a, b) => b.dealt - a.dealt);

  const aWins = games.filter((g) => g.winner === 'A').length;
  const bWins = games.filter((g) => g.winner === 'B').length;
  const draws = games.filter((g) => g.winner === null || g.winner === undefined).length;
  const done = games.filter((g) => g.turns <= CAP).length;
  const turnsAvg = done > 0 ? games.filter((g) => g.turns <= CAP).reduce((n, g) => n + g.turns, 0) / done : CAP;

  const payload = {
    era: ERA,
    // 这里以前写死成"时代默认尺寸"，用 --size 按住棋盘时元数据会说谎，
    // 下游的对比脚本（exp-compare / bonus-compare）就直接按它印表头，一错错一片。
    size: SIZE > 0 ? SIZE : DEFAULT_SIZE_FOR_ERA(ERA),
    commander: COMMANDER,
    expansions: EXPANSIONS,
    games: GAMES,
    baseSeed: BASE_SEED,
    cap: CAP,
    summary: {
      aWins,
      bWins,
      draws,
      aRate: games.length > 0 ? aWins / games.length : 0,
      bRate: games.length > 0 ? bWins / games.length : 0,
      drawRate: games.length > 0 ? draws / games.length : 0,
      turnsAvg,
      recruitsPerGame: builtSum / Math.max(1, games.length),
      spendPerGame: spendSum / Math.max(1, games.length),
    },
    stats,
    results: games,
    draw: {
      count: stuck.length,
      causes: Array.from(
        stuck.reduce((m, d) => {
          const cur = m.get(d.cause) ?? { n: 0, seeds: [] as number[] };
          cur.n += 1;
          cur.seeds.push(d.seed);
          m.set(d.cause, cur);
          return m;
        }, new Map<string, { n: number; seeds: number[] }>()),
      )
        .map(([cause, v]) => ({ cause, ...v }))
        .sort((a, b) => b.n - a.n),
      list: stuck.map((d) => ({
        seed: d.seed,
        turn: d.turn,
        cause: d.cause,
        detail: d.detail,
        combatA: d.combatA,
        combatB: d.combatB,
        citiesA: d.citiesA,
        citiesB: d.citiesB,
        armyA: d.armyA,
        armyB: d.armyB,
        cap: d.cap,
        bridgesA: d.bridgesA,
        bridgesB: d.bridgesB,
        bandGap: d.bandGap,
        cityHpA: d.cityHpA,
        cityFullA: d.cityFullA,
        cityHpB: d.cityHpB,
        cityFullB: d.cityFullB,
        cityArmorA: d.cityArmorA,
        cityArmorB: d.cityArmorB,
        nearestA: d.nearestA,
        nearestB: d.nearestB,
        onWallA: d.onWallA,
        onWallB: d.onWallB,
        reachA: d.reachA,
        reachB: d.reachB,
        attacksA: d.attacksA,
        attacksB: d.attacksB,
        siegesA: d.siegesA,
        siegesB: d.siegesB,
        siegeDmgA: d.siegeDmgA,
        siegeDmgB: d.siegeDmgB,
        recentAttacksA: d.recentAttacksA,
        recentAttacksB: d.recentAttacksB,
        recentSiegesA: d.recentSiegesA,
        recentSiegesB: d.recentSiegesB,
        goldA: d.goldA,
        goldB: d.goldB,
      })),
    },
  };

  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.dirname(OUT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  process.stderr.write(`\n写出 ${OUT}\n`);

  // 每一把磨局都留一份完整场面：JSON 给程序读，txt 给人看
  if (DRAWS) {
    fs.mkdirSync(DRAWS, { recursive: true });
    for (const d of stuck) {
      const base = path.join(DRAWS, `era${ERA}-seed${d.seed}`);
      fs.writeFileSync(`${base}.json`, JSON.stringify(d, null, 2));
      const pct = (hp: number, full: number) => (full > 0 ? Math.round((hp / full) * 100) : 0);
      const lines: string[] = [];
      lines.push(`era${ERA} seed=${d.seed} 第 ${d.turn} 回合 未分胜负（上限 ${CAP}）`);
      lines.push(`判定：${d.cause}`);
      lines.push(`理由：${d.detail}`);
      lines.push('');
      lines.push(
        `A  城 ${d.citiesA} 座 耐久 ${d.cityHpA}/${d.cityFullA}（${pct(d.cityHpA, d.cityFullA)}%，护甲 ${d.cityArmorA}）` +
          `  单位 ${d.unitList.filter((u) => u.owner === 'A').length}（战斗 ${d.combatA}，总血 ${d.hpA}）  金 ${d.goldA}`,
      );
      lines.push(
        `B  城 ${d.citiesB} 座 耐久 ${d.cityHpB}/${d.cityFullB}（${pct(d.cityHpB, d.cityFullB)}%，护甲 ${d.cityArmorB}）` +
          `  单位 ${d.unitList.filter((u) => u.owner === 'B').length}（战斗 ${d.combatB}，总血 ${d.hpB}）  金 ${d.goldB}`,
      );
      lines.push('');
      lines.push(`距离：A 到 B 城最近 ${d.nearestA} 格（城下 ${d.onWallA} 个），B 到 A 城最近 ${d.nearestB} 格（城下 ${d.onWallB} 个）`);
      lines.push(
        `累计：A 野战 ${d.attacksA} / 攻城 ${d.siegesA} 次（${Math.round(d.siegeDmgA)} 伤害），` +
          `B 野战 ${d.attacksB} / 攻城 ${d.siegesB} 次（${Math.round(d.siegeDmgB)} 伤害）`,
      );
      lines.push(
        `最近 40 回合：A 野战 ${d.recentAttacksA} / 攻城 ${d.recentSiegesA}，B 野战 ${d.recentAttacksB} / 攻城 ${d.recentSiegesB}`,
      );
      lines.push(
        `过河：最窄的一条直线需要连铺 ${d.bandGap || '—'} 座桥，场上现有 A ${d.bridgesA} 座 / B ${d.bridgesB} 座`,
      );
      lines.push(`编制：A ${d.armyA}/${d.cap}（金 ${d.goldA}）　B ${d.armyB}/${d.cap}（金 ${d.goldB}）`);
      if (d.cityDmg.length > 0) {
        lines.push(
          `城防账本：${d.cityDmg.map((c) => `${c.id}(${c.owner}) 吃 ${Math.round(c.dmg)} 剩 ${pct(c.hp, c.maxHp)}%`).join('  ')}`,
        );
      }
      lines.push('');
      lines.push('地形  .平原 f森林 h丘陵 ~水 #山 =桥 c城');
      for (const row of d.terrain) lines.push('  ' + row);
      lines.push('');
      lines.push('单位  . 表示空；同字可能分属两方，阵营看下方清单');
      for (const row of d.units) lines.push('  ' + row);
      lines.push('');
      lines.push('单位清单');
      for (const u of d.unitList) {
        lines.push(`  ${u.owner} ${u.name} @(${u.x},${u.y}) ${u.hp}/${u.maxHp}`);
      }
      lines.push('');
      lines.push('城市清单');
      for (const c of d.cityList) {
        lines.push(`  ${c.id} ${c.owner} @(${c.x},${c.y}) 时代 ${c.era} ${c.hp}/${c.maxHp} 护甲 ${c.armor}`);
      }
      fs.writeFileSync(`${base}.txt`, lines.join('\n'));
    }
    process.stderr.write(`磨局场面 ${stuck.length} 份 -> ${DRAWS}\n`);
  }
  console.log(
    `era${ERA}: ${GAMES} 局 | 先手 ${aWins} 后手 ${bWins} 未决 ${draws} | 均 ${turnsAvg.toFixed(1)} 回合 | 均招兵 ${(builtSum / Math.max(1, games.length)).toFixed(1)}`,
  );

  // ---- Markdown 表格：给"模组平衡报告"直接拼接用 ----
  if (MD) {
    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const sizeN = SIZE > 0 ? SIZE : DEFAULT_SIZE_FOR_ERA(ERA);
    const packName = EXPANSIONS.filter((id) => id.startsWith('pack-')).join('+');
    const lines: string[] = [];
    lines.push(`#### ${eraDef(ERA).name}${packName ? `（${packName}）` : ''}`);
    lines.push('');
    lines.push(
      `${GAMES} 局 · ${sizeN}×${sizeN} · 种子 ${BASE_SEED} · 先手 ${aWins} / 后手 ${bWins} / 未决 ${draws}` +
        ` · 平均 ${turnsAvg.toFixed(1)} 回合 · 场均招兵 ${(builtSum / Math.max(1, games.length)).toFixed(1)}`,
    );
    lines.push('');
    lines.push('| 兵种 | 归属 | 价 | 招募 | 采用率 | 总输出 | 总承伤 | 交换比 | 每百金杀伤 | 每百金抗伤 | 击杀 |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const s of stats) {
      const src = UNIT_TYPES[s.type] ? '原版' : '模组';
      const r = s.ratio === null ? '∞' : s.ratio.toFixed(2);
      // 招募数太少时这两个比值基本是噪声，用 ⚠ 标出来，别让人当真
      const thin = s.built > 0 && s.built < 10 ? ' ⚠' : '';
      lines.push(
        `| ${s.name} | ${src} | ${s.cost} | ${s.built}${thin} | ${(s.share * 100).toFixed(1)}% | ` +
          `${Math.round(s.dealt)} | ${Math.round(s.taken)} | ${r} | ${s.per100.toFixed(1)} | ` +
          `${s.per100Taken.toFixed(1)} | ${s.kills} |`,
      );
    }

    // 两组分开汇总：模组到底是"多了一种选择"还是"整体更强"，看这两行就够。
    // 口径只算**战斗单位**：建筑/经济/建造单位本来就该 0 输出，混进来会把每百金指标拉平，
    // 变成"谁的工事多谁吃亏"，那不是平衡结论。
    const sum = (pred: (t: TypeStat) => boolean) => {
      const g = stats.filter(pred);
      const spend = g.reduce((n, t) => n + t.spend, 0);
      const dealt = g.reduce((n, t) => n + t.dealt, 0);
      const taken = g.reduce((n, t) => n + t.taken, 0);
      const built = g.reduce((n, t) => n + t.built, 0);
      return {
        n: g.length,
        built,
        spend,
        dealt,
        taken,
        per100: spend > 0 ? (dealt / spend) * 100 : 0,
        per100Taken: spend > 0 ? (taken / spend) * 100 : 0,
        ratio: taken > 0 ? dealt / taken : null,
      };
    };
    const isCombat = (t: TypeStat) => t.category === 'combat' && t.built > 0;
    const pack = sum((t) => !UNIT_TYPES[t.type] && isCombat(t));
    const base = sum((t) => !!UNIT_TYPES[t.type] && isCombat(t));
    lines.push('');
    lines.push('| 分组（只算战斗单位） | 兵种数 | 招募 | 花费 | 每百金杀伤 | 每百金抗伤 | 交换比 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    const row = (label: string, s: ReturnType<typeof sum>) =>
      `| ${label} | ${s.n} | ${s.built} | ${Math.round(s.spend)} | ${s.per100.toFixed(1)} | ` +
      `${s.per100Taken.toFixed(1)} | ${s.ratio === null ? '∞' : s.ratio.toFixed(2)} |`;
    lines.push(row('模组新增', pack));
    lines.push(row('原版', base));
    lines.push('');
    if (pack.spend > 0 && base.spend > 0) {
      lines.push(
        `模组/原版：杀伤 ×${(pack.per100 / base.per100).toFixed(2)}、抗伤 ×${(pack.per100Taken / base.per100Taken).toFixed(2)}`,
      );
      lines.push('');
    }

    fs2.mkdirSync(path2.dirname(MD), { recursive: true });
    fs2.writeFileSync(MD, lines.join('\n'));
    process.stderr.write(`写出 ${MD}\n`);
  }
}

await main();

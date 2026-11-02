/**
 * 兵种平衡诊断：把跑批出来的四条指标，翻成"该动谁、往哪动、动多少"。
 *
 * 为什么要有这一步：`merged-*.json` 里已经有每百金输出、每百金抗伤、采用率、
 * 交换比，但一张 90 行的表本身不是结论。谁超标、超多少、超的部分怎么用最少的
 * 改动收回来——这需要一条**判定线**，而判定线必须写下来，否则下次换个人看同一张表
 * 会得出相反的结论。
 *
 * 判定用一个参照池：**同批数据里有足够样本的战斗单位**。不用"策划预期的强度表"，
 * 因为那张表不存在；也不用手写的阈值，因为阈值会随着新扩展漂移。
 * 参照值取中位数而不是平均数——几个极端值（火炮那种远程白打的）会把平均数拽走。
 *
 * 三条口径要记住，不然会读歪：
 *
 *   1. **样本量分档**。built < 30 的单位只报数字不下结论：AI 的随机性叠上
 *      "这一局刚好需要它"，30 次以下看不出趋势。这些单位在结果里标 C 档。
 *   2. **每百金抗伤高不一定是坏事**。肉盾的价值在于"别人没挨打"，它自己挨打
 *      正是本职。所以"高抗伤"要和"低输出"一起出现才判成问题（纯送）。
 *   3. **交换比高也可能是射程的功劳**。火炮/榴弹炮交换比 6~12，不是因为它伤害高，
 *      而是因为对手够不着它。修这种不能降价，得动射程或压制。
 *
 * 用法：
 *   node --experimental-strip-types scripts/balance-advice.ts results/bf-modern/merged-era3.json \
 *     --md results/bf-modern/advice-era3.md --json results/bf-modern/advice-era3.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
if (!file) {
  console.error('用法：node --experimental-strip-types scripts/balance-advice.ts <merged-*.json> [--md out.md] [--json out.json]');
  process.exit(1);
}

/** 样本门槛：低于这个数只报数不下结论 */
const MIN_SAMPLE = 30;
/** 强结论门槛：到这个数，"它偏强"就不再是随机波动 */
const SOLID_SAMPLE = 100;
/**
 * 价格建议的上下限。
 *
 * 只按 "cost × 倍数" 算会给出把 480 金改成 880 金的建议——那不是调平衡，那是
 * 把它从池子里删掉。一次改价超过 ±40% 会让"这个兵种还值不值得造"变成另一个问题，
 * 剩下的差距应该由属性/射程承担。所以这里钳住幅度，并在被钳住时明说"价格治不了根"。
 */
const PRICE_UP_CAP = 0.4;
const PRICE_DOWN_CAP = -0.35;

interface MergedRow {
  type: string;
  name: string;
  era: number;
  category: string;
  domain: 'water' | 'land';
  pack: string;
  cost: number;
  built: number;
  seen: number;
  spend: number;
  share: number;
  dealt: number;
  taken: number;
  ratio: number | null;
  per100: number;
  per100Taken: number;
  kills: number;
}

interface Merged {
  era: number;
  size: number;
  expansions: string[];
  games: number;
  cap: number;
  summary: {
    aWins: number;
    bWins: number;
    draws: number;
    drawRate: number;
    turnsAvg: number;
    recruitsPerGame: number;
    spendPerGame: number;
  };
  stats: MergedRow[];
}

const data = JSON.parse(readFileSync(file, 'utf-8')) as Merged;

/**
 * 这一局的兵种表。
 *
 * 需要它只为一件事：`range` / `summon` / `magicAtk` 这些字段不在跑批输出里，
 * 而"输出低"到底该怪数值还是怪 AI 站位，恰恰要看它们。
 */
const defs = createMatch({ ...DEFAULT_CONFIG, startEra: data.era, expansionIds: data.expansions }, 900).unitTypes;


const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * 判定用的参照池。
 *
 * 只收**有建造记录的战斗单位**：建筑（塔、桥、营）根本不参与"兵种强弱"这件事，
 * 它们的 per100 恒为 0 会压低中位数；built = 0 的单位没有数据，进池子等于给 0。
 */
const pool = data.stats.filter((r) => r.category === 'combat' && r.built >= MIN_SAMPLE);
const ref = {
  per100: median(pool.map((r) => r.per100)),
  per100Taken: median(pool.map((r) => r.per100Taken)),
  ratio: median(pool.map((r) => (r.ratio === null ? 8 : r.ratio))),
  share: median(pool.map((r) => r.share)),
  cost: median(pool.map((r) => r.cost)),
};

/** 每个兵种的判定结果 */
interface Verdict {
  type: string;
  name: string;
  era: number;
  pack: string;
  cost: number;
  built: number;
  /**
   * 出场人次。和 built 分开看：召唤/分裂/孵化的兵 built 是 0 或极小，
   * 但 seen 很大——只看得建造次数会把"召唤物"误读成"没人用"。
   */
  seen: number;
  dealt: number;
  taken: number;
  kills: number;
  /** 置信档：A 稳 / B 方向 / C 只报数 */
  tier: 'A' | 'B' | 'C';
  per100: number;
  per100Taken: number;
  ratio: number | null;
  share: number;
  /** 相对参照池的倍数，看"超了几倍"比看绝对值直观 */
  xOutput: number;
  xTaken: number;
  /** 命中的问题标签 */
  flags: string[];
  /** 建议（结构化，便于以后批量套用） */
  advice: Array<{
    lever: 'cost' | 'attack' | 'hp' | 'range' | 'cap' | 'none';
    direction: 'up' | 'down' | 'hold';
    /** 建议的新数值；lever 为 none 时是 0 */
    target?: number;
    /** 相对当前值的变化比例，正数是涨 */
    delta?: number;
    why: string;
  }>;
}

const verdicts: Verdict[] = [];

for (const r of data.stats) {
  if (r.category !== 'combat') continue;
  const tier: Verdict['tier'] = r.built >= SOLID_SAMPLE ? 'A' : r.built >= MIN_SAMPLE ? 'B' : 'C';
  const xOutput = ref.per100 > 0 ? r.per100 / ref.per100 : 0;
  const xTaken = ref.per100Taken > 0 ? r.per100Taken / ref.per100Taken : 0;
  const flags: string[] = [];
  const advice: Verdict['advice'] = [];

  // ── 远程白打：交换比极高、抗伤极低，而且**确实打出了伤害** ──
  // 不是"伤害高"，是"对手够不着"。这种单位降价会更糟，只能动射程/成本双管。
  // 必须加 per100 的下限：没接过战的单位（抗伤 0、交换比 ∞ 或几十）长得一模一样，
  // 但它的病是"根本没上场"，不是"射程太远"——两者的药方相反。
  const ranged = (r.ratio ?? 0) >= 4 && xTaken <= 0.5 && xOutput >= 0.7;
  if (ranged) {
    flags.push('远程白打');
    // 只对样本够的动刀：C 档提一句，不给数字
    if (tier !== 'C') {
      advice.push({
        lever: 'cost',
        direction: 'up',
        target: Math.round(r.cost * 1.25),
        delta: 0.25,
        why: `交换比 ${r.ratio?.toFixed(1)}、抗伤只有参照的 ${xTaken.toFixed(2)} 倍：它几乎没被对手碰到。涨价能压低出勤，但治不了根`,
      });
      advice.push({
        lever: 'range',
        direction: 'down',
        delta: -1,
        why: '真正的病根在射程——压一格射程，让它必须进入被反击的范围',
      });
    }
  }

  // ── 输出过量：每百金输出远超参照 ──
  if (xOutput >= 1.8 && !ranged) {
    flags.push('输出过量');
    if (tier !== 'C') {
      // 把每百金输出压到参照的 1.5 倍：这是"允许它强一点，但不许一边倒"的意思
      const raw = Math.round(r.cost * (xOutput / 1.5));
      const capped = Math.min(raw, Math.round(r.cost * (1 + PRICE_UP_CAP)));
      advice.push({
        lever: 'cost',
        direction: 'up',
        target: capped,
        delta: (capped - r.cost) / r.cost,
        why: `每百金输出 ${r.per100.toFixed(1)}（参照 ${ref.per100.toFixed(1)} 的 ${xOutput.toFixed(2)} 倍）。按比例该涨到 ${raw} 金，已钳到 ${capped}`,
      });
      if (capped < raw) {
        advice.push({
          lever: 'attack',
          direction: 'down',
          delta: -0.2,
          why: `剩下的差距（${raw} 金才算平）涨价治不了根：一次涨 ${Math.round(PRICE_UP_CAP * 100)}% 已经到顶，再涨就是把兵种删掉。配合攻击力 −20% 或加一条使用限制`,
        });
      }
    }
  }

  // ── 只挨打：抗伤很高但几乎打不出伤害 ──
  //
  // 便宜的那批要分开看：25 金的民兵吸 79.5 的伤害不是失衡，那是它的本职。
  // 把炮灰判成"要改"会让整张表失去重点——真正该看的是**贵而不打**的那些。
  const cheap = r.cost <= ref.cost * 0.7;
  if (xTaken >= 2 && xOutput <= 0.6) {
    if (cheap) {
      flags.push('耗材（设计如此）');
      advice.push({
        lever: 'none',
        direction: 'hold',
        why: `${r.cost} 金吸 ${r.per100Taken.toFixed(1)} 的伤害（参照的 ${xTaken.toFixed(1)} 倍），输出 ${r.per100.toFixed(1)}。便宜单位当肉是本职，不建议动；要动就动"它太便宜"这件事本身`,
      });
    } else {
      flags.push('只挨打');
      if (tier !== 'C') {
        advice.push({
          lever: 'attack',
          direction: 'up',
          delta: 0.25,
          why: `抗伤是参照的 ${xTaken.toFixed(1)} 倍、输出只有 ${xOutput.toFixed(2)} 倍，而它不便宜（${r.cost} 金）。钱花在"能挨"上了，补一点攻击让它不只是耗材`,
        });
      }
    }
  }

  // ── 输出过低：连参照的四成都不到 ──
  //
  // 先分流：站在场上、挨打正常、射程却不短的单位，输出低多半不是数值问题，
  // 而是 AI 根本没让它开火（远程兵被顶到前排、或者 AI 不认识"隔着三格打"）。
  // 这种要是照建议降价，等于罚一个受害者：它本来就不该被当成近战用。
  const def = defs[r.type];
  const rangedIdle = (def?.range ?? 0) >= 3 && xTaken <= 1.2 && r.built >= 50 && xOutput <= 0.4;
  if (xOutput <= 0.4 && !(xTaken >= 2)) {
    if (rangedIdle) {
      flags.push('疑似 AI 不会用');
      advice.push({
        lever: 'none',
        direction: 'hold',
        why:
          `射程 ${def?.range}、抗伤 ${r.per100Taken.toFixed(1)}（参照的 ${xTaken.toFixed(2)} 倍）都不算差，` +
          `但每百金只打出 ${r.per100.toFixed(1)}（参照的 ${xOutput.toFixed(2)} 倍）——它是站在场上却几乎没开火。` +
          `先查 AI 的远程站位和目标选择，不要据这个数字砍它`,
      });
      if (def?.summon) {
        advice.push({
          lever: 'none',
          direction: 'hold',
          why: `而且它会召唤（\`${String((def.summon as { type?: string }).type ?? '随机')}\`），召唤物的伤害记在召唤物头上，这个数字天生偏低`,
        });
      }
    } else {
      flags.push('输出过低');
      if (tier !== 'C') {
        const raw = Math.round(r.cost * (xOutput / 0.7));
        const floor = Math.max(20, Math.round(r.cost * (1 + PRICE_DOWN_CAP)));
        const target = Math.max(floor, raw);
        advice.push({
          lever: 'cost',
          direction: 'down',
          target,
          delta: (target - r.cost) / r.cost,
          why: `每百金输出 ${r.per100.toFixed(1)}，只有参照的 ${xOutput.toFixed(2)} 倍，而且没换来对应的抗伤。按比例该降到 ${Math.max(20, raw)} 金，已钳到 ${target}`,
        });
        if (target > raw) {
          advice.push({
            lever: 'attack',
            direction: 'up',
            delta: 0.2,
            why: `降价到顶也补不回来（${Math.max(20, raw)} 金才算平），说明它的属性本身不值这个价：配合攻击力 +20%，或者给它一个别的手段`,
          });
        }
      }
    }
  }

  // ── 好但没人用：数据明显不差，采用率却极低 ──
  // 门槛设 1.3 倍而不是 1 倍：刚好在参照线上的单位"没人用"很正常，
  // 那是同价位里有更好的选择，不是失衡。
  // 门槛从 30 降到 10：天使（550 金、每百金输出 66.9、只造 25 次）本来是最典型的
  // "好却没人用"，却被旧门槛整条丢掉。造得少不等于不值得看，把样本量写进文案就行。
  if (r.built >= 10 && r.share < ref.share * 0.5 && xOutput >= 1.3) {
    flags.push('好但没人用');
    advice.push({
      lever: 'none',
      direction: 'hold',
      why:
        `采用率 ${(r.share * 100).toFixed(2)}%（参照 ${(ref.share * 100).toFixed(2)}%），但每百金输出是参照的 ${xOutput.toFixed(2)} 倍` +
        `（样本 ${r.built} 次${r.built < MIN_SAMPLE ? '，偏少，看方向' : ''}）。数值不需要动，要查的是门槛（时代/前置）和 AI 会不会用`,
    });
  }

  // 两条判定打架时要收口：既"输出过量"又"没人用"的单位，不能给涨价建议——
  // 没人造还涨价只会更没人造。先解释"为什么没人造"，数值等查清楚再说。
  if (flags.includes('好但没人用')) {
    for (let i = advice.length - 1; i >= 0; i--) {
      const a = advice[i];
      if (a && a.lever === 'cost' && a.direction === 'up') advice.splice(i, 1);
    }
    advice.push({
      lever: 'none',
      direction: 'hold',
      why: '在"为什么没人造"查清之前不建议涨价：涨价只会让采用率更低，把真因（门槛 / 同价位竞争 / AI 不认识）盖住',
    });
  }

  verdicts.push({
    type: r.type,
    name: r.name,
    era: r.era,
    pack: r.pack,
    cost: r.cost,
    built: r.built,
    seen: r.seen,
    dealt: r.dealt,
    taken: r.taken,
    kills: r.kills,
    tier,
    per100: r.per100,
    per100Taken: r.per100Taken,
    ratio: r.ratio,
    share: r.share,
    xOutput,
    xTaken,
    flags,
    advice,
  });
}

verdicts.sort((a, b) => b.xOutput + b.xTaken - (a.xOutput + a.xTaken));

/* ---------------- 跨代金币效率：贵的到底值不值 ---------------- */

/**
 * 同一个池子里，一代比一代贵，但每百金输出是不是也一代比一代高？
 *
 * 这条检查是给"后期兵种没人造"找根因的：如果 era3 的兵每百金输出反而高于
 * era6，那 AI 死守低级兵就是**理性**的，问题在成本曲线而不在 AI。
 */
const eraRows = new Map<number, { n: number; per100: number; per100Taken: number; cost: number; built: number }>();
for (const v of verdicts) {
  if (v.tier === 'C') continue;
  const cur = eraRows.get(v.era) ?? { n: 0, per100: 0, per100Taken: 0, cost: 0, built: 0 };
  cur.n += 1;
  cur.per100 += v.per100;
  cur.per100Taken += v.per100Taken;
  cur.cost += v.cost;
  cur.built += v.built;
  eraRows.set(v.era, cur);
}
const eraCurve = [...eraRows.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([era, v]) => ({
    era,
    units: v.n,
    avgCost: Math.round(v.cost / v.n),
    avgPer100: v.per100 / v.n,
    avgPer100Taken: v.per100Taken / v.n,
    built: v.built,
  }));

/**
 * 伤害都打在谁身上了。
 *
 * 这是这批数据里最容易被忽略、但最影响结论的一件事：如果伤害高度集中在
 * 便宜的那一批，那么"交换比"衡量的就不是兵种强弱，而是"AI 挑谁打"——
 * 远程单位的漂亮比值里，有很大一块是"对手根本没机会够到它"。
 */
const takenSum = data.stats.reduce((n, r) => n + r.taken, 0);
const dealtSum = data.stats.reduce((n, r) => n + r.dealt, 0);
const cheapCeiling = ref.cost * 0.7;
const cheapTypes = new Set(verdicts.filter((v) => v.cost <= cheapCeiling).map((v) => v.type));
const dearTypes = new Set(verdicts.filter((v) => v.cost >= ref.cost * 1.4).map((v) => v.type));
const sumOf = (set: Set<string>, pick: (r: MergedRow) => number): number =>
  data.stats.filter((r) => set.has(r.type)).reduce((n, r) => n + pick(r), 0);
const cheapTaken = sumOf(cheapTypes, (r) => r.taken);
const cheapBuilt = verdicts.filter((v) => cheapTypes.has(v.type)).reduce((n, v) => n + v.built, 0);
const totalBuilt = verdicts.reduce((n, v) => n + v.built, 0);
const cheapSpend = sumOf(cheapTypes, (r) => r.spend);
const dearSpend = sumOf(dearTypes, (r) => r.spend);
const dearTaken = sumOf(dearTypes, (r) => r.taken);
const concentration = {
  takenSum,
  dealtSum,
  /** 这一档造价以下的算"便宜兵"，以上的算"贵兵" */
  cheapCostCeiling: Math.round(cheapCeiling),
  dearCostFloor: Math.round(ref.cost * 1.4),
  cheapUnits: cheapTypes.size,
  dearUnits: dearTypes.size,
  cheapBuilt,
  cheapBuiltShare: totalBuilt > 0 ? cheapBuilt / totalBuilt : 0,
  cheapTaken,
  /** 便宜兵吃掉的伤害占比 */
  cheapTakenShare: takenSum > 0 ? cheapTaken / takenSum : 0,
  dearTaken,
  dearTakenShare: takenSum > 0 ? dearTaken / takenSum : 0,
  /** 每花 100 金，便宜兵 vs 贵兵各自吸走多少伤害 —— 这才是"买肉值不值"的尺子 */
  cheapPer100Taken: cheapSpend > 0 ? (cheapTaken / cheapSpend) * 100 : 0,
  dearPer100Taken: dearSpend > 0 ? (dearTaken / dearSpend) * 100 : 0,
};

/**
 * 召唤物代打：有输出、但一次都没被"建造"过的单位。
 *
 * 这一段的用处是给"法师类输出过低"这条判定打补丁。召唤物的伤害记在召唤物
 * 自己头上（它是个独立单位），而钱是花在召唤师身上的。于是
 * "元素召唤师每百金输出 10.8"这个数字，实际上漏掉了它召出来的风/火/土元素
 * 打的那一大半——照这个数去削它，会把它削成废卡。
 *
 * 反过来也不能直接把召唤物全算给召唤师：在场上的召唤物可能来自英雄、法术、
 * 分裂，来源不止一个。所以这里只给总量，不下单个兵种的结论。
 */
const summons = data.stats
  .filter((r) => r.built === 0 && r.dealt > 0)
  .sort((a, b) => b.dealt - a.dealt)
  .map((r) => ({ type: r.type, name: r.name, cost: r.cost, seen: r.seen, dealt: r.dealt, kills: r.kills }));
const summonDealt = summons.reduce((n, s) => n + s.dealt, 0);
const summonShare = dealtSum > 0 ? summonDealt / dealtSum : 0;

/**
 * 产出关系：被产出的类型 → 谁会产出它。
 *
 * 五个来源都算：召唤（含 random 多选）、分裂、孵化、聚合。
 * 这张表有两个用途：
 *   1. 把召唤物的输出并回召唤师，算出"含召唤"的每百金——否则元素召唤师
 *      永远显示成 ×0.45 的废卡；
 *   2. 给全表里那些"召唤物"行打个标，它们那个每百金是分母假象，不该被当成强弱。
 */
const producers = new Map<string, string[]>();
for (const [id, d] of Object.entries(defs)) {
  const outs = [
    ...(d.summon?.type ? [d.summon.type] : []),
    ...(d.summon?.random ?? []),
    ...(d.splitInto ? [d.splitInto] : []),
    ...(d.hatch?.into ? [d.hatch.into] : []),
    ...(d.mergeInto ? [d.mergeInto] : []),
  ];
  for (const t of new Set(outs)) {
    const bag = producers.get(t) ?? [];
    bag.push(id);
    producers.set(t, bag);
  }
}

interface SummonLedger {
  /** 召唤师自己的兵种 id */
  type: string;
  name: string;
  built: number;
  spend: number;
  selfDealt: number;
  selfTaken: number;
  summonDealt: number;
  summonedTypes: string[];
  /** 某个产出类型有多个来源时，账分不开，按均分 */
  ambiguous: boolean;
  per100Self: number;
  per100Incl: number;
}

/** 谁是召唤师：所有产出关系的甲方 */
const producerIds = new Set<string>();
for (const owners of producers.values()) for (const o of owners) producerIds.add(o);

const ledger: SummonLedger[] = [];
for (const id of producerIds) {
  const own = data.stats.find((r) => r.type === id);
  if (!own) continue;
  const cost = defs[id]?.cost ?? 0;
  const inv = own.built * cost;
  let summonDealt = 0;
  let ambiguous = false;
  const summonedTypes: string[] = [];
  for (const [produced, owners] of producers) {
    if (!owners.includes(id)) continue;
    const r = data.stats.find((x) => x.type === produced);
    if (!r) continue;
    if (owners.length > 1) ambiguous = true;
    summonDealt += r.dealt / owners.length;
    if (r.seen > 0) summonedTypes.push(`${r.name}×${r.seen}`);
  }
  ledger.push({
    type: id,
    name: own.name,
    built: own.built,
    spend: own.spend,
    selfDealt: own.dealt,
    selfTaken: own.taken,
    summonDealt,
    summonedTypes,
    ambiguous,
    per100Self: inv > 0 ? (own.dealt / inv) * 100 : 0,
    per100Incl: inv > 0 ? ((own.dealt + summonDealt) / inv) * 100 : 0,
  });
}
ledger.sort((a, b) => b.summonDealt - a.summonDealt);

/* ---------------- 输出 ---------------- */

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const fx = (v: number): string => v.toFixed(2);
const rowsWithFlags = verdicts.filter((v) => v.flags.length > 0);
const actionable = rowsWithFlags.filter((v) => v.advice.some((a) => a.lever !== 'none'));

const payload = {
  source: path.basename(file),
  setup: {
    era: data.era,
    size: data.size,
    games: data.games,
    cap: data.cap,
    expansions: data.expansions,
  },
  outcome: data.summary,
  reference: ref,
  sampleThresholds: { min: MIN_SAMPLE, solid: SOLID_SAMPLE },
  concentration,
  summons: { total: summonDealt, share: summonShare, list: summons.slice(0, 10) },
  summonLedger: ledger,
  eraCurve,
  verdicts,
  findings: rowsWithFlags.map((v) => ({
    type: v.type,
    name: v.name,
    tier: v.tier,
    flags: v.flags,
    metrics: {
      cost: v.cost,
      built: v.built,
      share: v.share,
      per100: v.per100,
      per100Taken: v.per100Taken,
      ratio: v.ratio,
      xOutput: v.xOutput,
      xTaken: v.xTaken,
    },
    advice: v.advice,
  })),
};

const jsonOut = argOf('json', '');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(payload, null, 2), 'utf-8');

const mdOut = argOf('md', '');
if (mdOut) {
  const L: string[] = [];
  const say = (s = ''): void => void L.push(s);

  say(`# 兵种平衡诊断 · era${data.era} · ${data.size}×${data.size} · ${data.games} 局`);
  say();
  say(`扩展：\`${data.expansions.join('`, `')}\``);
  say();
  say(
    `胜负 ${data.summary.aWins}:${data.summary.bWins}，未决 ${data.summary.draws}（${pct(data.summary.drawRate)}），` +
      `均 ${data.summary.turnsAvg.toFixed(0)} 回合，局均招兵 ${data.summary.recruitsPerGame.toFixed(0)}，局均军费 ${Math.round(data.summary.spendPerGame)}。`,
  );
  say();
  say('## 参照线');
  say();
  say('判定基准取"有建造记录（≥30 次）的战斗单位"的中位数，不是平均数，也不是策划预期表。');
  say();
  say('| 指标 | 参照值 |');
  say('|---|---|');
  say(`| 每百金输出 | ${fx(ref.per100)} |`);
  say(`| 每百金抗伤 | ${fx(ref.per100Taken)} |`);
  say(`| 交换比（输出/承伤） | ${fx(ref.ratio)} |`);
  say(`| 采用率 | ${pct(ref.share)} |`);
  say(`| 造价 | ${ref.cost} |`);
  say();
  say(`参照池 ${pool.length} 个单位；全表 ${verdicts.length} 个战斗单位。`);
  say();

  say('## 命中判定线的单位');
  say();
  say('**不按样本量筛。** 建造次数写在表里，数字和判定都摊开——');
  say('造了 3 次就算出 24 倍，那也是事实，只是它的"倍数"不稳定，别当精确值用。');
  say();
  const shown = rowsWithFlags;
  if (shown.length === 0) {
    say('这批数据里没有越过判定线的单位。');
  } else {
    say('| 单位 | 代 | 档 | 建造 | 命中 | 造价 | 采用率 | 每百金输出 | 每百金抗伤 | 交换比 |');
    say('|---|---|---|---|---|---|---|---|---|---|');
    for (const v of shown) {
      say(
        `| ${v.name} | ${v.era} | ${v.tier} | ${v.built} | ${v.flags.join(' / ')} | ${v.cost} | ` +
          `${pct(v.share)} | ${v.per100.toFixed(1)}（×${fx(v.xOutput)}） | ${v.per100Taken.toFixed(1)}（×${fx(v.xTaken)}） | ` +
          `${v.ratio === null ? '∞' : v.ratio.toFixed(2)} |`,
      );
    }
  }
  say();
  say('档位只表示"这个数字有多稳"，不表示"要不要看它"：**A** = 建造 ≥100 次；**B** = 30~99；**C** = <30（倍数波动大，方向可参考）。');
  say();

  say('## 伤害分配：交换比到底在衡量什么');
  say();
  say(
    `全场总输出 ${Math.round(dealtSum).toLocaleString('en-US')}、总承伤 ${Math.round(takenSum).toLocaleString('en-US')}。` +
      `造价 ≤ ${concentration.cheapCostCeiling} 金的便宜兵（${concentration.cheapUnits} 个）占建造量的 ${pct(concentration.cheapBuiltShare)}，` +
      `吃了 ${pct(concentration.cheapTakenShare)} 的伤害；` +
      `造价 ≥ ${concentration.dearCostFloor} 金的贵兵（${concentration.dearUnits} 个）吃了 ${pct(concentration.dearTakenShare)}。`,
  );
  say();
  say(
    `但按**钱**算就翻过来了：同样花 100 金，便宜兵吸走 **${concentration.cheapPer100Taken.toFixed(1)}** 点伤害，` +
      `贵兵只有 **${concentration.dearPer100Taken.toFixed(1)}** 点，差 ${concentration.dearPer100Taken > 0 ? (concentration.cheapPer100Taken / concentration.dearPer100Taken).toFixed(1) : '∞'} 倍。`,
  );
  say();
  say('> 这就是为什么 AI 一路狂买民兵/弓手/戟兵：不是它不会用高级兵，是"买肉"这件事');
  say('> 在每金口径上太划算了。也解释了那批高交换比单位：它们之所以能打出 3~12 的比值，');
  say('> 很大一块来自"对面在忙着啃便宜的肉，够不着它"。');
  say('> 所以只看交换比砍人一定会砍错：该动的是"便宜兵每金能吸多少"这条曲线，');
  say('> 或者让高级兵在每金口径上追回来。');
  say();

  say('## 全表：所有上场过的战斗单位（按建造次数排）');
  say();
  say('**不设样本门槛。** 造得少本身就是要看的信号——它可能是"没人愿意造"（定价/门槛问题），');
  say('> 也可能是"这局刚好用不上"（被某个更强的同价位压住）。两种都不该被藏起来，');
  say('> 区别只在结论的强度：下面按建造次数从多到少排，自己看数。');
  say();
  say('| 单位 | id | 代 | 造价 | 建造 | 出场 | 采用率 | 输出 | 承伤 | 每百金输出 | 每百金抗伤 | 交换比 | 击杀 | 命中 |');
  say('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const allCombat = verdicts.filter((v) => v.built > 0).sort((a, b) => b.built - a.built);
  for (const v of allCombat) {
    say(
      `| ${v.name} | \`${v.type}\` | ${v.era} | ${v.cost} | ${v.built} | ${v.seen} | ${pct(v.share)} | ` +
        `${Math.round(v.dealt).toLocaleString('en-US')} | ${Math.round(v.taken).toLocaleString('en-US')} | ` +
        `${v.per100.toFixed(1)} | ${v.per100Taken.toFixed(1)} | ${v.ratio === null ? '∞' : v.ratio.toFixed(2)} | ` +
        `${v.kills} | ${[...v.flags, ...(producers.has(v.type) ? ['召唤物（每百金是分母假象）'] : [])].join(' / ') || '—'} |`,
    );
  }
  say();
  say(`共 ${allCombat.length} 个；另有 ${verdicts.filter((v) => v.built === 0).length} 个一次都没被造（见下表）。`);
  say();

  /* 造了但一点伤害都没打出去 */
  const noOutput = allCombat.filter((v) => v.dealt === 0);
  say('### 造了，但一点伤害都没打出去');
  say();
  if (noOutput.length === 0) {
    say('没有。');
  } else {
    say('| 单位 | id | 造价 | 建造 | 出场 | 承伤 |');
    say('|---|---|---|---|---|---|');
    for (const v of noOutput) {
      say(`| ${v.name} | \`${v.type}\` | ${v.cost} | ${v.built} | ${v.seen} | ${Math.round(v.taken)} |`);
    }
    say();
    say('> 这类要分两种：**出场也是 0** 的，是"造出来就死/根本没走到前线"；');
    say('> **出场很多但输出 0** 的，多半是纯功能单位（修桥、产金、当肉），');
    say('> 它的价值不在这张表里，别按"输出 0"当成废卡。');
  }
  say();

  /* 一次都没被造 —— 池子里有、场上没有 */
  const neverBuilt = verdicts.filter((v) => v.built === 0);
  say('### 一次都没被造');
  say();
  if (neverBuilt.length === 0) {
    say('池子里每个战斗单位都被造过至少一次。');
  } else {
    say(`共 ${neverBuilt.length} 个。造不出来 / 太贵 / 同价位有更好的，三种原因要看它们的门槛和定价：`);
    say();
    say('| 单位 | id | 代 | 造价 | 出场 |');
    say('|---|---|---|---|---|');
    for (const v of neverBuilt.sort((a, b) => a.cost - b.cost)) {
      say(`| ${v.name} | \`${v.type}\` | ${v.era} | ${v.cost} | ${v.seen} |`);
    }
    say();
    say('> "出场"不为 0 但"建造"为 0 的，是被召唤/分裂出来的，它本来就不该花钱造。');
  }
  say();

  say('## 召唤师：把召唤物的账并回去');
  say();
  say('钱花在召唤师身上、伤害记在召唤物头上，所以召唤师的"每百金输出"天生偏低。');
  say('这一节把召唤物的输出按产出关系并回召唤师，给出"含召唤"的口径——');
  say('**判断召唤系强弱要看这一列，不是全表那一列**。');
  say();
  const realLedger = ledger.filter((x) => x.built > 0 && x.summonDealt > 0);
  if (realLedger.length === 0) {
    say('这批里没有"有建造记录且真的召出了东西"的召唤师。');
  } else {
    say('| 召唤师 | id | 建造 | 自身输出 | 召唤物输出 | 合计 | 自身每百金 | 含召唤每百金 | 召唤物 | 说明 |');
    say('|---|---|---|---|---|---|---|---|---|---|');
    for (const x of realLedger) {
      const total = x.selfDealt + x.summonDealt;
      say(
        `| ${x.name} | \`${x.type}\` | ${x.built} | ${Math.round(x.selfDealt).toLocaleString('en-US')} | ` +
          `${Math.round(x.summonDealt).toLocaleString('en-US')} | ${Math.round(total).toLocaleString('en-US')} | ` +
          `${x.per100Self.toFixed(1)} | **${x.per100Incl.toFixed(1)}** | ${x.summonedTypes.join('、')} | ` +
          `${x.ambiguous ? '多个来源共用，按均分估算' : '单一来源'} |`,
      );
    }
  }
  say();
  say('> 口径说明：产出关系取自兵种表的 summon / splitInto / hatch / mergeInto 五个字段。');
  say('> 一个产出类型有多个来源时（比如骷髅既能被死灵法师召、也可能被别的拉起来），账按均分估，别当精确值。');
  say('> 召唤物的"每百金"在全表里仍然是分母假象（分母是它们自己的 built×cost，而它们没花钱），已打标。');
  say();

  say('## 具体建议');
  say();
  say('按命中标签逐个给。C 档也照给——建造少的兵种往往是"没人愿意造"，');
  say('这本身就是个需要解释的现象，不该因为它样本小就说"没意见"。只是幅度要打折看。');
  say();
  for (const v of rowsWithFlags) {
    say(`### ${v.name}（\`${v.type}\`）· 造价 ${v.cost} · 第 ${v.era} 代 · ${v.tier} 档`);
    say();
    for (const a of v.advice) {
      const pctStr = `${Math.abs((a.delta ?? 0) * 100).toFixed(0)}%`;
      const what =
        a.lever === 'cost'
          ? `造价 ${v.cost} → **${a.target}**（${(a.delta ?? 0) > 0 ? '+' : ''}${((a.delta ?? 0) * 100).toFixed(0)}%）`
          : a.lever === 'range'
            ? '射程 −1 格'
            : a.lever === 'attack'
              ? `攻击力 ${a.direction === 'up' ? '+' : '−'}${pctStr}`
              : '数值不动';
      say(`- **${what}**：${a.why}`);
    }
    say();
  }

  say('## 跨代金币效率');
  say();
  say('| 代 | 单位数 | 均造价 | 均每百金输出 | 均每百金抗伤 | 建造次数 |');
  say('|---|---|---|---|---|---|');
  for (const e of eraCurve) {
    say(`| era${e.era} | ${e.units} | ${e.avgCost} | ${e.avgPer100.toFixed(1)} | ${e.avgPer100Taken.toFixed(1)} | ${e.built} |`);
  }
  say();
  say('> 这张表回答"贵的是不是真的强"。如果某代造价翻了倍、每百金输出却没涨，');
  say('> 那么死守低级兵是理性选择，问题在成本曲线而不是 AI 的偏好。');
  say();

  say('## 测量盲区：召唤师被算低了');
  say();
  say(
    `有 ${summons.length} 种单位"有输出但零建造"——它们是召唤/分裂/孵化出来的，` +
      `合计打出 ${Math.round(summonDealt).toLocaleString('en-US')} 伤害，占全场输出的 **${pct(summonShare)}**。`,
  );
  say();
  if (summons.length > 0) {
    say('| 召唤物 | 出场 | 输出 | 击杀 |');
    say('|---|---|---|---|');
    for (const s of summons.slice(0, 6)) {
      say(`| ${s.name} | ${s.seen} | ${Math.round(s.dealt).toLocaleString('en-US')} | ${s.kills} |`);
    }
    say();
  }
  say('> 钱花在召唤师身上，伤害记在召唤物头上。所以上面"输出过低"里凡是召唤系/辅助系，');
  say('> 都要先把召唤物的输出并回去再判断：照原始数字削会削错人。');
  say('> 但也不能全算给召唤师——同一只骷髅可能来自死灵法师，也可能来自别的来源，');
  say('> 所以这里只给总量，不下单个兵种的结论。');
  say();

  say('## 这套方法看不到什么');
  say();
  say('- **AI 的操作水平会污染输出数据**：一个不会走位的兵种，在 AI 手里打不出它纸面上的输出。');
  say('  所以"输出过低"要先排除"AI 不会用它"，再谈数值。');
  say('- **抗伤是结果不是设计**：对手打了谁，取决于 AI 的目标选择，不完全取决于这个兵种的设计定位。');
  say('- **纯 AI 对 AI**：没有人类会用的"憋大招""换家""卡位"这类打法，所以爆发型单位会被低估。');
  say('- **cap 上限会让长局失真**：打满上限的局，后期兵种的投入收不回来，数据偏低。');
  say();

  writeFileSync(mdOut, L.join('\n'), 'utf-8');
  console.log(`→ ${mdOut}`);
}
if (jsonOut) console.log(`→ ${jsonOut}`);

console.log(
  `参照线：每百金输出 ${fx(ref.per100)} / 每百金抗伤 ${fx(ref.per100Taken)} / 交换比 ${fx(ref.ratio)} / 采用率 ${pct(ref.share)}`,
);
console.log(`命中 ${rowsWithFlags.length} 个，其中 ${actionable.length} 个建议动数值`);

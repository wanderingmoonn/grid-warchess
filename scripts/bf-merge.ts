/**
 * 把分块跑出来的 balance-report JSON 合并成一份。
 *
 * 为什么要分块：一局要几十秒到几分钟，60 局串起来是小时级。这台机器有 32 核，
 * 而原来的脚本是单进程顺序跑的——分块并行是唯一能把等待时间压到能接受的办法。
 *
 * 合并口径必须和 balance-report 自己一致，否则"分块 60 局"和"一次跑 60 局"
 * 会得出两套数。派生字段一律重算，不直接相加：
 *   per100 = dealt / (built × cost) × 100
 *   ratio  = dealt / taken
 *   share  = seen / Σseen（出场占比）
 *   goldShare = spend / Σspend
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] ?? 'results-bf';
const ERA = Number(process.argv[3] ?? '1');
const OUT = process.argv[4] ?? path.join(DIR, `e${ERA}.json`);

interface Tally {
  built: number;
  seen: number;
  spend: number;
  dealt: number;
  taken: number;
  kills: number;
  initDealt: number;
  initTaken: number;
  initCount: number;
}

interface Chunk {
  era: number;
  size: number;
  commander: boolean;
  expansions: string[];
  games: number;
  results: Array<Record<string, unknown> & { turns: number; winner: string | null }>;
  stats: Array<{
    type: string;
    name: string;
    era: number;
    category: string;
    cost: number;
    dealt: number;
    taken: number;
    initDealt?: number;
    initTaken?: number;
  }>;
  cap?: number;
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.startsWith(`c${ERA}-`) && f.endsWith('.json'))
  .sort();

if (files.length === 0) {
  console.error(`没有找到分块文件 ${DIR}/c${ERA}-*.json`);
  process.exit(1);
}

const totals = new Map<string, Tally>();
const results: Chunk['results'] = [];
/** type → 静态信息（cost/name/era/category）：各块一致，取第一份即可 */
const meta = new Map<string, { name: string; era: number; category: string; cost: number }>();
let size = 0;
let commander = false;
let expansions: string[] = [];
let cap = 200;
let initDealtAll = 0;
let initTakenAll = 0;

for (const f of files) {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Chunk;
  if (!size) {
    size = c.size;
    commander = c.commander;
    expansions = c.expansions;
    cap = c.cap ?? 200;
  }
  results.push(...(c.results ?? []));
  for (const s of c.stats) {
    // 从 stats 反推 tally：dealt/taken 有，built 要用 per100 反解不稳，
    // 所以分块文件里额外写了 built/spend/seen（见 balance-report 的 stats 字段）
    const raw = s as unknown as {
      built: number;
      seen: number;
      spend: number;
      kills?: number;
      initCount?: number;
    };
    const acc =
      totals.get(s.type) ??
      ({
        built: 0,
        seen: 0,
        spend: 0,
        dealt: 0,
        taken: 0,
        kills: 0,
        initDealt: 0,
        initTaken: 0,
        initCount: 0,
      } as Tally);
    acc.built += raw.built ?? 0;
    acc.seen += raw.seen ?? 0;
    acc.spend += raw.spend ?? 0;
    acc.dealt += s.dealt ?? 0;
    acc.taken += s.taken ?? 0;
    acc.kills += raw.kills ?? 0;
    acc.initDealt += s.initDealt ?? 0;
    acc.initTaken += s.initTaken ?? 0;
    acc.initCount += raw.initCount ?? 0;
    totals.set(s.type, acc);
    if (!meta.has(s.type)) {
      meta.set(s.type, { name: s.name, era: s.era, category: s.category, cost: s.cost });
    }
  }
}

let seenSum = 0;
let spendSum = 0;
for (const t of totals.values()) {
  seenSum += t.seen;
  spendSum += t.spend;
}

const stats = [];
for (const [type, t] of totals) {
  const m = meta.get(type)!;
  const inv = t.built * m.cost;
  stats.push({
    type,
    name: m.name,
    era: m.era,
    category: m.category,
    cost: m.cost,
    built: t.built,
    seen: t.seen,
    spend: t.spend,
    share: seenSum > 0 ? t.seen / seenSum : 0,
    goldShare: spendSum > 0 ? t.spend / spendSum : 0,
    dealt: t.dealt,
    taken: t.taken,
    ratio: t.taken > 0 ? t.dealt / t.taken : t.dealt > 0 ? null : 0,
    per100: inv > 0 ? (t.dealt / inv) * 100 : 0,
    per100Taken: inv > 0 ? (t.taken / inv) * 100 : 0,
    kills: t.kills,
    initCount: t.initCount,
    initRatio: t.initTaken > 0 ? t.initDealt / t.initTaken : t.initDealt > 0 ? null : 0,
  });
}
stats.sort((a, b) => b.dealt - a.dealt);

const won = (w: string) => results.filter((g) => g.winner === w).length;
const aWins = won('A');
const bWins = won('B');
const draws = results.length - aWins - bWins;
const decided = results.filter((g) => g.turns <= cap);
const turnsAvg =
  decided.length > 0 ? decided.reduce((n, g) => n + g.turns, 0) / decided.length : cap;

const payload = {
  era: ERA,
  size,
  commander,
  expansions,
  games: results.length,
  baseSeed: 0,
  cap,
  summary: {
    aWins,
    bWins,
    draws,
    aRate: results.length > 0 ? aWins / results.length : 0,
    bRate: results.length > 0 ? bWins / results.length : 0,
    drawRate: results.length > 0 ? draws / results.length : 0,
    turnsAvg,
    recruitsPerGame:
      results.length > 0
        ? results.reduce(
            (n, g) => n + ((g as { recruitsA?: number }).recruitsA ?? 0) + ((g as { recruitsB?: number }).recruitsB ?? 0),
            0,
          ) / results.length
        : 0,
    spendPerGame: results.length > 0 ? spendSum / results.length : 0,
  },
  stats,
  results,
  draw: [],
};

void initDealtAll;
void initTakenAll;
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(
  `合并 ${files.length} 块 → ${OUT}：${payload.games} 局，${stats.length} 个兵种，` +
    `先手 ${aWins} / 后手 ${bWins} / 未决 ${draws}`,
);

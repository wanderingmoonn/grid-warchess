/**
 * 把同一组配置的多次跑批结果合成一份。
 *
 * 为什么要它：一次跑 60 局会被系统按内存/时长杀掉（试过，30 局就够呛），
 * 所以真实的做法是"20 局一批、跑三批"，每批下盘一次，最后合并。
 * 合并必须**按原始计数加**，不能把几份报表里的比率再平均一遍——
 * `per100`、`adoptRate`、`turnsAvg` 的权重都不一样，平均平均数是错的。
 *
 * 用法：
 *   node --experimental-strip-types scripts/merge-balance.ts \
 *     --in results/reaction/after-era1-a.json,results/reaction/after-era1-b.json \
 *     --out results/reaction/after-era1.json
 */

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const OUT = argOf('out', '');
const FILES = argOf('in', '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
if (!OUT || FILES.length === 0) {
  console.error('用法：--in a.json,b.json --out merged.json');
  process.exit(1);
}

const docs = FILES.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const head = docs[0]!;
for (const d of docs.slice(1)) {
  if (d.era !== head.era || d.size !== head.size || d.cap !== head.cap) {
    console.error('这几份不是同一组配置，别硬合');
    process.exit(1);
  }
}

const results = docs.flatMap((d) => d.results ?? []);
const n = results.length;

/** 稳定排序：合并顺序不影响结果 */
const byType = new Map<string, Record<string, number>>();
const meta = new Map<string, { type: string; name: string; era: number; category: string; cost: number }>();
const ADD = [
  'built', 'seen', 'spend', 'dealt', 'taken', 'kills',
  'initDealt', 'initTaken', 'initCount',
  'intent', 'fail', 'foeDistSum', 'foeDistN',
  'lost', 'lostValue', 'adoptGames', 'firstTurnN',
] as const;

for (const d of docs) {
  for (const s of d.stats ?? []) {
    const cur = byType.get(s.type) ?? {};
    for (const k of ADD) cur[k] = (cur[k] ?? 0) + (s[k] ?? 0);
    // firstTurnAvg 是平均值，合并要按 firstTurnN 加权
    if (s.firstTurnAvg != null && s.firstTurnN > 0) {
      cur.firstTurnSum = (cur.firstTurnSum ?? 0) + s.firstTurnAvg * s.firstTurnN;
    }
    /*
     * foeDistAvg 在早期的分片里只留了平均值、没留样本数。用建造意图数当权重
     * 近似（两者几乎总是相等）——不这么做，合并出来的这一列会整列变成空。
     */
    if (s.foeDistAvg != null) {
      const w = s.foeDistN ?? s.intent ?? 0;
      if (w > 0) {
        cur.foeDistSum2 = (cur.foeDistSum2 ?? 0) + s.foeDistAvg * w;
        cur.foeDistW = (cur.foeDistW ?? 0) + w;
      }
    }
    byType.set(s.type, cur);
    meta.set(s.type, { type: s.type, name: s.name, era: s.era, category: s.category, cost: s.cost });
  }
}

let builtSum = 0;
let seenSum = 0;
let spendSum = 0;
for (const s of byType.values()) {
  builtSum += s.built ?? 0;
  seenSum += s.seen ?? 0;
  spendSum += s.spend ?? 0;
}

const stats = [...byType.entries()].map(([type, t]) => {
  const m = meta.get(type)!;
  const inv = (t.built ?? 0) * m.cost;
  return {
    ...m,
    built: t.built ?? 0,
    seen: t.seen ?? 0,
    spend: t.spend ?? 0,
    share: seenSum > 0 ? (t.seen ?? 0) / seenSum : 0,
    goldShare: spendSum > 0 ? (t.spend ?? 0) / spendSum : 0,
    dealt: t.dealt ?? 0,
    taken: t.taken ?? 0,
    ratio: (t.taken ?? 0) > 0 ? (t.dealt ?? 0) / (t.taken ?? 1) : (t.dealt ?? 0) > 0 ? null : 0,
    per100: inv > 0 ? ((t.dealt ?? 0) / inv) * 100 : 0,
    per100Taken: inv > 0 ? ((t.taken ?? 0) / inv) * 100 : 0,
    kills: t.kills ?? 0,
    initCount: t.initCount ?? 0,
    initRatio:
      (t.initTaken ?? 0) > 0 ? (t.initDealt ?? 0) / (t.initTaken ?? 1) : (t.initDealt ?? 0) > 0 ? null : 0,
    intent: t.intent ?? 0,
    intentPerGame: n > 0 ? (t.intent ?? 0) / n : 0,
    failRate: (t.intent ?? 0) > 0 ? (t.fail ?? 0) / (t.intent ?? 1) : 0,
    adoptRate: n > 0 ? (t.adoptGames ?? 0) / n : 0,
    firstTurnAvg: (t.firstTurnN ?? 0) > 0 ? (t.firstTurnSum ?? 0) / (t.firstTurnN ?? 1) : null,
    foeDistAvg: (t.foeDistW ?? 0) > 0 ? (t.foeDistSum2 ?? 0) / (t.foeDistW ?? 1) : null,
    lost: t.lost ?? 0,
    lostValue: t.lostValue ?? 0,
    lostPerGame: n > 0 ? (t.lost ?? 0) / n : 0,
    adoptGames: t.adoptGames ?? 0,
    firstTurnN: t.firstTurnN ?? 0,
  };
});
stats.sort((a, b) => b.dealt - a.dealt);

const aWins = results.filter((g: { winner: string | null }) => g.winner === 'A').length;
const bWins = results.filter((g: { winner: string | null }) => g.winner === 'B').length;
const draws = results.filter((g: { winner: string | null }) => !g.winner).length;
const done = results.filter((g: { turns: number }) => g.turns <= head.cap);
const turnsAvg = done.length > 0 ? done.reduce((a: number, g: { turns: number }) => a + g.turns, 0) / done.length : head.cap;

const merged = {
  ...head,
  games: n,
  baseSeed: FILES.length > 1 ? `${head.baseSeed}+${FILES.length}批` : head.baseSeed,
  summary: {
    aWins,
    bWins,
    draws,
    aRate: n > 0 ? aWins / n : 0,
    bRate: n > 0 ? bWins / n : 0,
    drawRate: n > 0 ? draws / n : 0,
    turnsAvg,
    recruitsPerGame: n > 0 ? builtSum / n : 0,
    spendPerGame: n > 0 ? spendSum / n : 0,
  },
  stats,
  results,
  draw: { count: draws, causes: docs.flatMap((d) => d.draw?.causes ?? []), list: docs.flatMap((d) => d.draw?.list ?? []) },
};

writeFileSync(OUT, JSON.stringify(merged, null, 2), 'utf8');
console.log(`${FILES.length} 份合并 → ${OUT}：${n} 局，均 ${turnsAvg.toFixed(1)} 回合`);

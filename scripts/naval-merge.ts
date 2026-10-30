/**
 * 把分片跑出来的 N 份 balance-era*.json 合并成一份，并按单位 / 阵容两个维度出表。
 *
 * 合并的规矩只有一条：**先加原始计数，再重算比率**。
 * 三份文件各自算好的 ratio 不能取平均——那是"比值的平均"，不是"比值"
 * （第 1 局打 3 局、第 2 局打 1 局，平均出来是 2，真实是 4/2=2 还是 8/4=2 全靠运气）。
 * 所以这里把 dealt/taken/spend/built 这些可加的原始量相加，
 * 再按 balance-report 里同一套公式重算 share / ratio / per100 / per100Taken。
 *
 * 用法：
 *   node --experimental-strip-types scripts/naval-merge.ts --dir results/naval --tag run
 * 输出：
 *   results/naval/merged.json    合并后的等价物（和"一次连续跑 50 局"结构一致）
 *   results/naval/report.md      人看的表
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { unitSourceIdOf } from '../src/core/expansions.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const DIR = argOf('dir', 'results/naval');
const TAG = argOf('tag', 'run');

interface Raw {
  era: number;
  games: number;
  baseSeed: number;
  cap: number;
  expansions: string[];
  summary: { aWins: number; bWins: number; draws: number; turnsAvg: number; recruitsPerGame: number; spendPerGame: number };
  stats: Array<Record<string, number | string | null>>;
  results: Array<{ seed: number; winner: string | null; turns: number }>;
}

const files = readdirSync(DIR)
  .filter((f) => f.startsWith(`${TAG}-`) && f.endsWith('.json'))
  .sort();
if (files.length === 0) {
  console.error(`${DIR} 下没有 ${TAG}-*.json`);
  process.exit(1);
}

const parts: Raw[] = files.map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf-8')) as Raw);
const head = parts[0]!;
const EXPANSIONS = head.expansions;

/** 兵种表：必须带上这一轮实际开的扩展，否则查不到扩展兵的 cost/domain */
const defs = createMatch({ ...DEFAULT_CONFIG, startEra: head.era, expansionIds: EXPANSIONS }, head.baseSeed).unitTypes;

interface Tally {
  built: number;
  seen: number;
  spend: number;
  dealt: number;
  taken: number;
  kills: number;
  initCount: number;
  initDealt: number;
  initTaken: number;
}

const total = new Map<string, Tally>();
const results: Raw['results'] = [];
let aWins = 0;
let bWins = 0;
let draws = 0;
let turnsDone = 0;
let turnsSum = 0;
let recruits = 0;
let spend = 0;
let games = 0;
let capped = 0;
const cap = head.cap;
const seeds: number[] = [];

for (const p of parts) {
  games += p.games;
  aWins += p.summary.aWins;
  bWins += p.summary.bWins;
  draws += p.summary.draws;
  recruits += p.summary.recruitsPerGame * p.games;
  spend += p.summary.spendPerGame * p.games;
  for (const r of p.results) {
    results.push(r);
    seeds.push(r.seed);
    if (r.turns > cap) {
      capped++;
    } else {
      turnsDone += 1;
      turnsSum += r.turns;
    }
  }
  for (const s of p.stats) {
    const type = String(s.type);
    const acc = total.get(type) ?? { built: 0, seen: 0, spend: 0, dealt: 0, taken: 0, kills: 0, initCount: 0, initDealt: 0, initTaken: 0 };
    acc.built += Number(s.built ?? 0);
    acc.seen += Number(s.seen ?? 0);
    acc.spend += Number(s.spend ?? 0);
    acc.dealt += Number(s.dealt ?? 0);
    acc.taken += Number(s.taken ?? 0);
    acc.kills += Number(s.kills ?? 0);
    acc.initCount += Number(s.initCount ?? 0);
    acc.initDealt += Number(s.initDealt ?? 0);
    acc.initTaken += Number(s.initTaken ?? 0);
    total.set(type, acc);
  }
}

let seenSum = 0;
let builtSum = 0;
let spendSum = 0;
for (const t of total.values()) {
  seenSum += t.seen;
  builtSum += t.built;
  spendSum += t.spend;
}

interface Row {
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
  goldShare: number;
  dealt: number;
  taken: number;
  ratio: number | null;
  per100: number;
  per100Taken: number;
  kills: number;
  killShare: number;
}

const killSum = [...total.values()].reduce((n, t) => n + t.kills, 0);

const rows: Row[] = [];
for (const [type, t] of total) {
  const def = defs[type];
  const cost = def?.cost ?? 0;
  const inv = t.built * cost;
  rows.push({
    type,
    name: def?.name ?? type,
    era: def?.era ?? 0,
    category: def?.category ?? '?',
    domain: def?.domain === 'water' ? 'water' : 'land',
    pack: unitSourceIdOf(type) ?? 'core',
    cost,
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
    killShare: killSum > 0 ? t.kills / killSum : 0,
  });
}
rows.sort((a, b) => b.dealt - a.dealt);

// ── 合并后的等价物 ────────────────────────────
const merged = {
  era: head.era,
  size: (head as unknown as { size?: number }).size ?? 0,
  commander: false,
  expansions: EXPANSIONS,
  games,
  baseSeed: head.baseSeed,
  cap,
  seeds: seeds.sort((a, b) => a - b),
  chunks: files.length,
  summary: {
    aWins,
    bWins,
    draws,
    aRate: games > 0 ? aWins / games : 0,
    bRate: games > 0 ? bWins / games : 0,
    drawRate: games > 0 ? draws / games : 0,
    cappedGames: capped,
    turnsAvg: turnsDone > 0 ? turnsSum / turnsDone : cap,
    recruitsPerGame: games > 0 ? recruits / games : 0,
    spendPerGame: games > 0 ? spend / games : 0,
  },
  stats: rows,
};
writeFileSync(path.join(DIR, `merged-${TAG}.json`), JSON.stringify(merged, null, 1), 'utf-8');

// ── 分组（阵容维度） ──────────────────────────
interface Group {
  key: string;
  label: string;
  built: number;
  seen: number;
  spend: number;
  inv: number;
  dealt: number;
  taken: number;
  kills: number;
}

function groupBy(pick: (r: Row) => string | null, label: (k: string) => string): Group[] {
  const m = new Map<string, Group>();
  for (const r of rows) {
    const k = pick(r);
    if (k === null) continue;
    const g = m.get(k) ?? { key: k, label: label(k), built: 0, seen: 0, spend: 0, inv: 0, dealt: 0, taken: 0, kills: 0 };
    g.built += r.built;
    g.seen += r.seen;
    g.spend += r.spend;
    g.inv += r.built * r.cost;
    g.dealt += r.dealt;
    g.taken += r.taken;
    g.kills += r.kills;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.dealt - a.dealt);
}

const water = rows.filter((r) => r.domain === 'water');
const land = rows.filter((r) => r.domain === 'land');

const domainGroups = groupBy((r) => r.domain, (k) => (k === 'water' ? '海军（水域单位）' : '陆军 / 建筑'));
const packGroups = groupBy((r) => r.pack, (k) => k);

// ── 报表 ─────────────────────────────────────
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const num = (v: number): string => Math.round(v).toLocaleString('en-US');
const dec = (v: number | null, d = 2): string => (v === null ? '∞' : v.toFixed(d));

const lines: string[] = [];
lines.push(`# 海军阵营批量对局 · 合并报表`);
lines.push('');
lines.push(
  `时代 **${head.era}**（火药）· 地貌 **${(head as unknown as { mapStyle?: string }).mapStyle ?? 'isles'}** · ` +
  `扩展 \`${EXPANSIONS.join('`, `')}\` · **${games} 局**（种子 ${merged.seeds[0]}..${merged.seeds.at(-1)}）· ` +
  `回合上限 ${cap}`,
);
lines.push('');
lines.push(`## 1. 总体`);
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('|---|---|');
lines.push(`| 先手 A 胜 | ${aWins}（${pct(aWins / games)}） |`);
lines.push(`| 后手 B 胜 | ${bWins}（${pct(bWins / games)}） |`);
lines.push(`| 未决（打满 ${cap} 回合） | ${draws}（${pct(draws / games)}） |`);
lines.push(`| 平均回合数 | ${merged.summary.turnsAvg.toFixed(1)} |`);
lines.push(`| 平均每局招兵 | ${merged.summary.recruitsPerGame.toFixed(1)} |`);
lines.push(`| 平均每局军费 | ${num(merged.summary.spendPerGame)} |`);

function table(title: string, list: Row[], keys: Array<keyof Row>, headers: string[]): void {
  lines.push('');
  lines.push(`### ${title}`);
  lines.push('');
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`|${headers.map(() => '---').join('|')}|`);
  for (const r of list) {
    const cells = keys.map((k) => {
      const v = r[k];
      if (k === 'ratio') return dec(v as number | null);
      if (k === 'share' || k === 'goldShare' || k === 'killShare') return pct(v as number);
      if (k === 'per100' || k === 'per100Taken') return (v as number).toFixed(1);
      if (k === 'dealt' || k === 'taken' || k === 'spend' || k === 'kills' || k === 'built' || k === 'seen' || k === 'cost') return num(v as number);
      return String(v);
    });
    lines.push(`| ${cells.join(' | ')} |`);
  }
}

const unitKeys: Array<keyof Row> = ['name', 'era', 'category', 'cost', 'built', 'share', 'dealt', 'taken', 'ratio', 'per100', 'per100Taken', 'kills'];
const unitHeaders = ['单位', '代', '类别', '造价', '建造', '采用率', '输出', '承伤', '交换比', '每百金输出', '每百金承伤', '击杀'];

lines.push('');
lines.push(`## 2. 单位表（按总输出排序，只列真的有建造记录的）`);
table(`全部单位`, rows.filter((r) => r.built > 0), unitKeys, unitHeaders);
table(`海军（水域）`, water.filter((r) => r.built > 0), unitKeys, unitHeaders);
table(`陆军 / 建筑`, land.filter((r) => r.built > 0), unitKeys, unitHeaders);

lines.push('');
lines.push('## 3. 阵容维度');
lines.push('');
lines.push('| 阵容 | 建造 | 军费 | 输出 | 承伤 | 交换比 | 每百金输出 | 每百金承伤 | 击杀 |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const g of domainGroups) {
  lines.push(
    `| ${g.label} | ${num(g.built)} | ${num(g.spend)} | ${num(g.dealt)} | ${num(g.taken)} | ` +
    `${g.taken > 0 ? (g.dealt / g.taken).toFixed(2) : '∞'} | ${g.inv > 0 ? ((g.dealt / g.inv) * 100).toFixed(1) : '-'} | ` +
    `${g.inv > 0 ? ((g.taken / g.inv) * 100).toFixed(1) : '-'} | ${num(g.kills)} |`,
  );
}

lines.push('');
lines.push('### 按扩展包');
lines.push('');
lines.push('| 包 | 建造 | 军费 | 输出 | 承伤 | 交换比 | 每百金输出 | 击杀 |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const g of packGroups) {
  lines.push(
    `| ${g.label} | ${num(g.built)} | ${num(g.spend)} | ${num(g.dealt)} | ${num(g.taken)} | ` +
    `${g.taken > 0 ? (g.dealt / g.taken).toFixed(2) : '∞'} | ${g.inv > 0 ? ((g.dealt / g.inv) * 100).toFixed(1) : '-'} | ${num(g.kills)} |`,
  );
}

// 强弱榜：只统计"造得够多"的单位，否则 1 个兵的样本会霸榜
const MIN_BUILT = Math.max(5, Math.round(builtSum * 0.005));
const sample = rows.filter((r) => r.built >= MIN_BUILT && r.cost > 0);
const byPer100 = [...sample].sort((a, b) => b.per100 - a.per100);
const byRatio = [...sample].filter((r) => r.ratio !== null).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
const byTaken = [...sample].sort((a, b) => b.per100Taken - a.per100Taken);

const brief = (r: Row): string =>
  `**${r.name}**（${r.type}，${r.cost} 金，造 ${r.built}）每百金输出 ${r.per100.toFixed(1)} · 交换比 ${dec(r.ratio)}`;

lines.push('');
lines.push('## 4. 强弱榜');
lines.push('');
lines.push(`> 只统计建造数 ≥ ${MIN_BUILT} 的单位（全场合计造了 ${num(builtSum)} 个），避免一两个样本霸榜。`);
lines.push('');
lines.push('**每百金输出 · 最高 5**');
for (const r of byPer100.slice(0, 5)) lines.push(`- ${brief(r)}`);
lines.push('');
lines.push('**每百金输出 · 最低 5**');
for (const r of byPer100.slice(-5).reverse()) lines.push(`- ${brief(r)}`);
lines.push('');
lines.push('**交换比 · 最高 5**');
for (const r of byRatio.slice(0, 5)) lines.push(`- ${brief(r)}`);
lines.push('');
lines.push('**交换比 · 最低 5**');
for (const r of byRatio.slice(-5).reverse()) lines.push(`- ${brief(r)}`);
lines.push('');
lines.push('**每百金承伤 · 最高 5**（等于"最容易被消耗"）');
for (const r of byTaken.slice(0, 5)) lines.push(`- ${brief(r)}，每百金承伤 ${r.per100Taken.toFixed(1)}`);

writeFileSync(path.join(DIR, `report-${TAG}.md`), `${lines.join('\n')}\n`, 'utf-8');

// 终端摘要
console.log(lines.slice(0, 40).join('\n'));
console.log(`\n→ ${path.join(DIR, `report-${TAG}.md`)}`);
console.log(`→ ${path.join(DIR, `merged-${TAG}.json`)}`);

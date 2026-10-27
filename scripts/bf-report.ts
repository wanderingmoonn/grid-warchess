/**
 * 「奇想系列」平衡实测报告。
 *
 * 吃 balance-report.ts 打在 results-bf/ 下的三个时代结果，出三张表：
 *   · 兵种表：招募数 / 采用率 / 交换比 / 每百金杀伤 / 每百金抗伤 / 同时代基准指数
 *   · 英雄表：再加上"招了它的一方赢了多少局"
 *   · 概览：先后手胜率、平均回合、平均招兵
 *
 * 三条口径，先说清楚，否则数字会被误读：
 *   1. **采用率**用「这一局有没有人招过它」算，不用 `seen`。
 *      `seen` 是"出场过的单位个数"，开局白送的那几个也在里面，不是采用率。
 *   2. **同时代基准**只算同一局里**非奇想**的战斗单位，按造价加权——
 *      加权是必须的：不加权的话，一堆便宜民兵就能把基准拉平，
 *      而真正占钱的兵种反而没算进去。
 *   3. **英雄胜率**按"这一方招了它、这一方赢没赢"记，双向都记；
 *      对手也招了的话两边各记一笔（镜像对局对胜率无偏，只是样本相关）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { EXPANSIONS } from '../src/core/expansions.ts';

const DIR = process.argv[2] ?? 'results-bf';
const ERAS = (process.argv[3] ?? '1,2,3').split(',').map(Number);

/** 奇想系兵种：id → { 名字, 是不是英雄 } */
const PACK = new Map<string, { name: string; hero: boolean; era: number }>();
for (const e of EXPANSIONS) {
  if (!e.id.startsWith('fantasy-')) continue;
  for (const u of e.units ?? []) {
    PACK.set(u.id, { name: u.name, hero: u.hero === true, era: u.era });
  }
}

interface Stat {
  type: string;
  name: string;
  era: number;
  category: string;
  cost: number;
  built: number;
  spend: number;
  dealt: number;
  taken: number;
  ratio: number | null;
  per100: number;
  per100Taken: number;
  kills: number;
}

interface Game {
  seed: number;
  winner: 'A' | 'B' | null;
  turns: number;
  picksA?: Record<string, number>;
  picksB?: Record<string, number>;
}

interface Report {
  era: number;
  games: number;
  summary: {
    aWins: number;
    bWins: number;
    draws: number;
    turnsAvg: number;
    recruitsPerGame: number;
    spendPerGame: number;
  };
  stats: Stat[];
  results: Game[];
}

const load = (p: string): Report | null => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
  } catch {
    return null;
  }
};

const f = (x: number, nd = 1): string => x.toFixed(nd);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
/** 指数：≥1 表示高于基准，标个箭头方便扫读 */
const idx = (x: number): string => (x >= 1 ? `**${f(x, 2)}**` : f(x, 2));

/** 同一局里非奇想战斗单位的加权基准 */
function baseline(r: Report): { per100: number; per100Taken: number; n: number } {
  let spend = 0;
  let dealt = 0;
  let taken = 0;
  let n = 0;
  for (const s of r.stats) {
    if (PACK.has(s.type)) continue;
    if (s.category === 'building') continue;
    if (s.spend <= 0) continue;
    spend += s.spend;
    dealt += s.dealt;
    taken += s.taken;
    n += 1;
  }
  return {
    per100: spend > 0 ? (dealt / spend) * 100 : 0,
    per100Taken: spend > 0 ? (taken / spend) * 100 : 0,
    n,
  };
}

/** 这一局有没有人招过 type */
function adopted(g: Game, type: string): boolean {
  return (g.picksA?.[type] ?? 0) > 0 || (g.picksB?.[type] ?? 0) > 0;
}

/** 英雄胜率：招了它的一方的战绩 */
function heroRecord(games: Game[], type: string): { side: number; win: number } {
  let side = 0;
  let win = 0;
  for (const g of games) {
    if (!g.winner) continue;
    for (const p of ['A', 'B'] as const) {
      const bag = p === 'A' ? g.picksA : g.picksB;
      if (!bag || !((bag[type] ?? 0) > 0)) continue;
      side += 1;
      if (g.winner === p) win += 1;
    }
  }
  return { side, win };
}

const lines: string[] = [];
const say = (s = ''): void => {
  lines.push(s);
};

say('# 奇想系列 · 平衡实测');
say();
say(`配置：\`血战 + 先后手补偿 + 奇想·法则/骑士团/荒兽/秘法/英雄\`，每时代 60 局，AI 对 AI。`);
say();

const overview: string[] = [];
const perEra: Array<{ era: number; r: Report; base: ReturnType<typeof baseline> }> = [];

for (const era of ERAS) {
  const p = path.join(DIR, `e${era}.json`);
  const r = load(p);
  if (!r) {
    console.error(`跳过 era${era}：读不到 ${p}`);
    continue;
  }
  const base = baseline(r);
  perEra.push({ era, r, base });

  const decided = r.summary.aWins + r.summary.bWins;
  const aRate = decided > 0 ? r.summary.aWins / decided : 0;
  overview.push(
    `| ${era} | ${r.games} | ${pct(aRate)} / ${pct(1 - aRate)} | ${pct(r.summary.draws / r.games)} | ` +
      `${f(r.summary.turnsAvg, 0)} | ${f(r.summary.recruitsPerGame)} | ${f(r.summary.spendPerGame, 0)} |`,
  );
}

say('## 一、对局概览');
say();
say('| 时代 | 局数 | 先手 / 后手胜率 | 未决率 | 平均回合 | 场均招兵 | 场均花费 |');
say('|---|---|---|---|---|---|---|');
lines.push(...overview);
say();
say('「先手 / 后手」是分出胜负的局里各自占的比例——开了先后手补偿之后，这两个数字应该贴着一半。');
say();

for (const { era, r, base } of perEra) {
  say(`## 二、${era} 时代奇想兵种（${r.games} 局，基准 ${base.n} 个非奇想战斗单位）`);
  say();
  say(
    `同时代基准：每百金杀伤 **${f(base.per100)}**、每百金抗伤 **${f(base.per100Taken)}**（按造价加权）。` +
      `指数 = 该兵 ÷ 基准，**加粗**表示高于基准。`,
  );
  say();
  say('| 兵种 | 招募数 | 采用率 | 交换比 | 每百金杀伤 | 杀伤指数 | 每百金抗伤 | 抗伤指数 |');
  say('|---|---|---|---|---|---|---|---|');

  const rows = r.stats
    // built = 0 的是召唤物/分裂体：它们不是"招来的"，放进来会把采用率和
    // 每百金指标搅浑（分母是 0，算出来的数没意义）
    .filter((s) => PACK.has(s.type) && s.built > 0)
    .sort((a, b) => (b.per100 ?? 0) - (a.per100 ?? 0));

  if (rows.length === 0) {
    say('| （本时代没有奇想兵种出场） | | | | | | | |');
  }
  for (const s of rows) {
    const adopt = r.games > 0 ? r.results.filter((g) => adopted(g, s.type)).length / r.games : 0;
    const ratio = s.taken > 0 ? f(s.dealt / s.taken, 2) : '∞';
    const mark = s.built < 10 ? '†' : '';
    say(
      `| ${s.name}${mark} | ${s.built} | ${pct(adopt)} | ${ratio} | ${f(s.per100)} | ` +
        `${idx(base.per100 > 0 ? s.per100 / base.per100 : 0)} | ${f(s.per100Taken)} | ` +
        `${idx(base.per100Taken > 0 ? s.per100Taken / base.per100Taken : 0)} |`,
    );
  }
  say();
  say('† 招募数不足 10，单项数字会被一两个极端对局带飞，只看方向。');
  say();

  // 英雄单独一张表
  const heroes = rows.filter((s) => PACK.get(s.type)?.hero);
  if (heroes.length > 0) {
    say('### 英雄胜率');
    say();
    say('| 英雄 | 出场方次 | 胜 | 负 | 胜率 | 对照（该时代总体） |');
    say('|---|---|---|---|---|---|');
    const decided = r.summary.aWins + r.summary.bWins;
    const overall = decided > 0 ? r.summary.aWins / decided : 0.5;
    for (const s of heroes) {
      const rec = heroRecord(r.results, s.type);
      const wr = rec.side > 0 ? rec.win / rec.side : 0;
      say(
        `| ${s.name} | ${rec.side} | ${rec.win} | ${rec.side - rec.win} | ` +
          `${rec.side > 0 ? pct(wr) : '—'} | ${pct(overall)} |`,
      );
    }
    say();
    say('「对照」是同期先手方胜率。样本小的时候胜率抖得厉害，低于 20 个出场方次只看方向、别当结论。');
    say();
  }
}

const outPath = path.join(DIR, 'report.md');
fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
console.log(`\n写入 ${outPath}`);

/**
 * DLC / 扩展规则对"回合数"和"先后手胜率"的影响：同种子配对比较。
 *
 * 用法：
 *   node --experimental-strip-types scripts/dlc-compare.ts \
 *     --dir results17 --eras 1,2 --on dlc-on-era --off dlc-off-era --label 血战
 *
 * 为什么必须配对：同一个种子 → 同一张图、同一套开局。扩展只加钩子、不抽随机数，
 * 所以两组的差异是"这个扩展造成的"，而不是"这批图不一样"。这也是唯一能在
 * 120 局这个量级上看出 5~10 回合差别的做法——不配对的话，地图差异比效应本身还大。
 *
 * 输出：终端表格 + 同目录下 `dlc-compare.md`（可直接贴进报告）。
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const DIR = argOf('dir', 'results17');
const ERAS = argOf('eras', '1,2')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);
const ON_PREFIX = argOf('on', 'dlc-on-era');
const OFF_PREFIX = argOf('off', 'dlc-off-era');
const LABEL = argOf('label', 'DLC');

interface GameResult {
  era: number;
  size: number;
  seed: number;
  winner: 'A' | 'B' | null;
  turns: number;
}

interface Summary {
  aWins: number;
  bWins: number;
  draws: number;
  aRate: number;
  drawRate: number;
  turnsAvg: number;
  recruitsPerGame: number;
  spendPerGame: number;
}

interface Report {
  era: number;
  size: number;
  summary: Summary;
  results: GameResult[];
  cap: number;
}

const read = (file: string): Report => {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) throw new Error(`缺少结果文件：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((n, x) => n + (x - m) ** 2, 0) / (xs.length - 1));
};

/** 配对差值的 95% CI（正态近似，样本 120 足够） */
const ci95 = (deltas: number[]): [number, number] => {
  const m = mean(deltas);
  const se = sd(deltas) / Math.sqrt(Math.max(1, deltas.length));
  return [m - 1.96 * se, m + 1.96 * se];
};

/** 两个比例的差值 CI（胜率用） */
const diffCi95 = (x1: number, n1: number, x2: number, n2: number): [number, number] => {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [p1 - p2 - 1.96 * se, p1 - p2 + 1.96 * se];
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const sign = (x: number): string => (x > 0 ? `+${x.toFixed(1)}` : x.toFixed(1));

const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};

say(`# 「${LABEL}」对回合数与先后手的影响（同种子配对）`);
say();
say(`每个时代两组局数相同、种子完全一致（配对局数见各节标题）。回合上限两侧相同，未决局按 cap+1 记。`);
say();

for (const era of ERAS) {
  const on = read(`${ON_PREFIX}${era}.json`);
  const off = read(`${OFF_PREFIX}${era}.json`);
  const cap = on.cap;

  const bySeedOn = new Map(on.results.map((g) => [g.seed, g]));
  const paired = off.results.filter((g) => bySeedOn.has(g.seed));
  const deltas: number[] = [];
  let shorter = 0;
  let longer = 0;
  let same = 0;
  let flipped = 0;
  for (const g of paired) {
    const h = bySeedOn.get(g.seed)!;
    const d = h.turns - g.turns;
    deltas.push(d);
    if (d < 0) shorter += 1;
    else if (d > 0) longer += 1;
    else same += 1;
    if (g.winner !== h.winner) flipped += 1;
  }
  const [lo, hi] = ci95(deltas);
  const decidedOn = on.summary.aWins + on.summary.bWins;
  const decidedOff = off.summary.aWins + off.summary.bWins;
  const [alo, ahi] = diffCi95(on.summary.aWins, Math.max(1, decidedOn), off.summary.aWins, Math.max(1, decidedOff));

  say(`## 时代 ${era}（${on.size}×${on.size}，各组 ${on.results.length} 局，配对 ${paired.length} 局）`);
  say();
  say(`| 指标 | 关「${LABEL}」 | 开「${LABEL}」 | 差值 |`);
  say(`| --- | --- | --- | --- |`);
  say(
    `| 先手 A 胜 | ${off.summary.aWins} | ${on.summary.aWins} | ${on.summary.aWins - off.summary.aWins > 0 ? '+' : ''}${on.summary.aWins - off.summary.aWins} |`,
  );
  say(
    `| 后手 B 胜 | ${off.summary.bWins} | ${on.summary.bWins} | ${on.summary.bWins - off.summary.bWins > 0 ? '+' : ''}${on.summary.bWins - off.summary.bWins} |`,
  );
  say(
    `| 未决（打到 ${cap} 回合） | ${off.summary.draws} | ${on.summary.draws} | ${on.summary.draws - off.summary.draws > 0 ? '+' : ''}${on.summary.draws - off.summary.draws} |`,
  );
  say(
    `| 先手胜率（只算分出胜负的局） | ${pct(off.summary.aRate)} | ${pct(on.summary.aRate)} | ${sign((on.summary.aRate - off.summary.aRate) * 100)} 个百分点（95% CI ${sign(alo * 100)} ~ ${sign(ahi * 100)}） |`,
  );
  say(`| 未决率 | ${pct(off.summary.drawRate)} | ${pct(on.summary.drawRate)} | ${sign((on.summary.drawRate - off.summary.drawRate) * 100)} 个百分点 |`);
  say(
    `| 平均回合（未决记 ${cap + 1}） | ${off.summary.turnsAvg.toFixed(1)} | ${on.summary.turnsAvg.toFixed(1)} | ${sign(on.summary.turnsAvg - off.summary.turnsAvg)} |`,
  );
  say(
    `| 中位回合 | ${median(off.results.map((g) => g.turns)).toFixed(0)} | ${median(on.results.map((g) => g.turns)).toFixed(0)} | ${sign(median(on.results.map((g) => g.turns)) - median(off.results.map((g) => g.turns)))} |`,
  );
  say(`| 平均招兵 | ${off.summary.recruitsPerGame.toFixed(1)} | ${on.summary.recruitsPerGame.toFixed(1)} | ${sign(on.summary.recruitsPerGame - off.summary.recruitsPerGame)} |`);
  say();
  say(
    `配对回合差：均值 ${sign(mean(deltas))} 回合（95% CI ${sign(lo)} ~ ${sign(hi)}）；` +
      `缩短 ${shorter} 局 / 拉长 ${longer} 局 / 相同 ${same} 局；胜负被改写的 ${flipped} 局。`,
  );
  say();
}

const outFile = path.join(DIR, 'dlc-compare.md');
fs.writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
console.log(`\n已写出 ${outFile}`);

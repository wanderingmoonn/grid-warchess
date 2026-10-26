/**
 * 指挥官模式的影响：先后手胜率 + 兵种强度。
 *
 * 双 AI 跑批里，"指挥官模式"和普通模式的差别只有一条：**每回合只能产 1 个兵**
 * （界面层 runAiTurn 对双方都是这么给的，见 src/main.ts）。AI 本来就不排生产序列，
 * 所以这里测的是"产能砍半"本身，不是完整的指挥官体验。
 *
 * 两个变量各两档，正好做一个 2×2：
 *   ① 普通模式 · 不补        ② 普通模式 · 后手 +5%
 *   ③ 指挥官模式 · 不补      ④ 指挥官模式 · 后手 +5%
 * 每格 120 局（同种子 900~1019，两批各 60）。同种子配对，才能把差异归到模式上，
 * 而不是归到"这把图是河还是山岭"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/commander-report.ts --era 2 \
 *     --dir results21 --normal results20 --out results21/commander-report.md
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const ERA = Number(argOf('era', '2'));
const DIR = argOf('dir', 'results21');
const NORMAL = argOf('normal', 'results20');
const OUT = argOf('out', path.join(DIR, 'commander-report.md'));
/**
 * 四格各用哪两份 JSON（去掉 `-eraN.json` 的前缀，逗号分隔）。
 *
 * 之所以能配：这一格的数据可能跟对照组分在不同目录、不同批次命名。
 * 尤其是代码在两次跑批之间被改过的时候——那时候必须拿**新代码**重跑对照组，
 * 否则比出来的差异里混着"代码变了"这一项。
 */
const namesOf = (name: string, dflt: string): string[] => argOf(name, dflt).split(',').map((s) => s.trim()).filter(Boolean);

interface GameResult {
  seed: number;
  winner: 'A' | 'B' | null;
  turns: number;
  recruitsA?: number;
  recruitsB?: number;
}

interface TypeStat {
  type: string;
  name: string;
  era: number;
  category: string;
  cost: number;
  built: number;
  spend: number;
  dealt: number;
  taken: number;
  kills: number;
  initCount: number;
}

interface Report {
  era: number;
  size: number;
  commander?: boolean;
  expansions?: string[];
  summary: {
    aWins: number;
    bWins: number;
    draws: number;
    turnsAvg: number;
    recruitsPerGame: number;
    spendPerGame: number;
  };
  results: GameResult[];
  stats: TypeStat[];
}

const read = (dir: string, name: string): Report | null => {
  const p = path.join(dir, `${name}-era${ERA}.json`);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Report) : null;
};

/** 一格 = 两批同配置的 JSON 合并 */
interface Cell {
  key: string;
  label: string;
  reports: Report[];
  aWins: number;
  bWins: number;
  draws: number;
  games: number;
  turns: number;
  turnsAll: number;
  recruits: number;
  recA: number;
  recB: number;
  spend: number;
  bySeed: Map<number, GameResult>;
  stats: Map<string, TypeStat>;
}

function loadCell(key: string, label: string, dir: string, names: string[]): Cell | null {
  const reports = names.map((n) => read(dir, n)).filter((r): r is Report => r !== null);
  if (reports.length === 0) return null;

  const cell: Cell = {
    key,
    label,
    reports,
    aWins: 0,
    bWins: 0,
    draws: 0,
    games: 0,
    turns: 0,
    turnsAll: 0,
    recruits: 0,
    recA: 0,
    recB: 0,
    spend: 0,
    bySeed: new Map(),
    stats: new Map(),
  };

  for (const r of reports) {
    cell.aWins += r.summary.aWins;
    cell.bWins += r.summary.bWins;
    cell.draws += r.summary.draws;
    // 均回合只算打完的局：打满上限的局进平均数会把"没打完"算成"打得很长"
    const done = r.results.filter((g) => g.turns <= 200);
    cell.turns += done.reduce((n, g) => n + g.turns, 0);
    cell.games += done.length;
    cell.recruits += r.summary.recruitsPerGame * r.results.length;
    cell.spend += r.summary.spendPerGame * r.results.length;
    for (const g of r.results) {
      cell.bySeed.set(g.seed, g);
      cell.recA += g.recruitsA ?? 0;
      cell.recB += g.recruitsB ?? 0;
      cell.turnsAll += g.turns;
    }

    for (const s of r.stats) {
      const cur = cell.stats.get(s.type);
      if (cur) {
        cur.built += s.built;
        cur.spend += s.spend;
        cur.dealt += s.dealt;
        cur.taken += s.taken;
        cur.kills += s.kills;
        cur.initCount += s.initCount;
      } else {
        cell.stats.set(s.type, { ...s });
      }
    }
  }
  return cell;
}

const f1 = (x: number): string => (x > 0 ? `+${x.toFixed(1)}` : x.toFixed(1));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const aShare = (c: Cell): number => {
  const decided = c.aWins + c.bWins;
  return decided > 0 ? c.aWins / decided : 0;
};
const diffCi = (c: Cell, base: Cell): [number, number] => {
  const p1 = aShare(c);
  const p2 = aShare(base);
  const n1 = c.aWins + c.bWins;
  const n2 = base.aWins + base.bWins;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [p1 - p2 - 1.96 * se, p1 - p2 + 1.96 * se];
};

/** 同种子逐局相减的回合差 */
const pairedTurns = (c: Cell, base: Cell): { mean: number; lo: number; hi: number; n: number } => {
  const ds: number[] = [];
  for (const [seed, g] of c.bySeed) {
    const b = base.bySeed.get(seed);
    if (b) ds.push(g.turns - b.turns);
  }
  const n = ds.length;
  if (n < 2) return { mean: 0, lo: 0, hi: 0, n };
  const mean = ds.reduce((p, x) => p + x, 0) / n;
  const sd = Math.sqrt(ds.reduce((p, x) => p + (x - mean) ** 2, 0) / (n - 1));
  // n=120 时双侧 95% 的 t 临界值 1.980
  const half = 1.98 * (sd / Math.sqrt(n));
  return { mean, lo: mean - half, hi: mean + half, n };
};

const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};

const n0 = loadCell('N0', '普通 · 不补', NORMAL, namesOf('n0', 'base,chkbase'));
const n5 = loadCell('N5', '普通 · 后手 +5%', NORMAL, namesOf('n5', 'bonus5,chkbonus5'));
const c0 = loadCell('C0', '指挥官 · 不补', DIR, namesOf('c0', 'cmd,chkcmd'));
const c5 = loadCell('C5', '指挥官 · 后手 +5%', DIR, namesOf('c5', 'cmdcomp,chkcmdcomp'));

const cells = [n0, n5, c0, c5].filter((c): c is Cell => c !== null);
if (cells.length === 0) throw new Error('一份数据都没找到，先跑 balance-report');

const probe = cells[0]!.reports[0]!;
const size = probe.size;

say('# 指挥官模式：先后手与兵种强度');
say();
say(
  `口径：时代 ${ERA}、**${size}×${size}**、双方高级 AI、只开血战，「后手 +5%」= 先后手补偿扩展给的 16×16 档。`,
);
say(`每格 120 局（种子 900~1019，两批各 60），同种子配对。`);
say();
say('> 指挥官模式下 AI 自己排 5 格序列（`planOrders`），排产这件事本身进了博弈；');
say('> 双方都是「每回合 1 个兵」的节奏，所以这一栏既是产能限制，也是排产策略的效果。');
const NOTE = argOf('note', '');
if (NOTE) {
  say('>');
  say(`> ${NOTE}`);
}
say();

say('## 2×2 总表');
say();
say('| 格 | 先手胜/后手胜/未决 | 先手胜率 | 未决率 | 均回合 | 均产出 | 每局花钱 | 每方每局产兵 |');
say('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const c of cells) {
  const total = c.aWins + c.bWins + c.draws;
  say(
    `| ${c.label} | ${c.aWins} / ${c.bWins} / ${c.draws} | ${pct(aShare(c))} | ` +
      `${pct(c.draws / total)} | ${(c.turns / Math.max(1, c.games)).toFixed(1)} | ` +
      `${Math.round(c.recruits / total)} | ${Math.round(c.spend / total)} | ` +
      `${((c.recA + c.recB) / total / 2).toFixed(1)} |`,
  );
}
say();
say('「均产出」= 单位 + 建筑的总产出数；「每方每局产兵」只数招兵。指挥官模式下这个数贴着');
say('"每方回合数"走，说明 1 兵/回合的帽子确实卡死了产能，不是没生效。');
say();

say('## 指挥官模式 vs 普通模式（同种子配对）');
say();
say('| 补偿 | 普通先手胜率 | 指挥官先手胜率 | Δ胜率（95% CI） | Δ回合（95% CI） |');
say('| --- | --- | --- | --- | --- |');
for (const [base, cmd, name] of [
  [n0, c0, '不补'],
  [n5, c5, '+5%'],
] as Array<[Cell | null, Cell | null, string]>) {
  if (!base || !cmd) continue;
  const [lo, hi] = diffCi(cmd, base);
  const t = pairedTurns(cmd, base);
  say(
    `| ${name} | ${pct(aShare(base))} | ${pct(aShare(cmd))} | ` +
      `${f1((aShare(cmd) - aShare(base)) * 100)} pp（${f1(lo * 100)} ~ ${f1(hi * 100)}） | ` +
      `${f1(t.mean)}（${f1(t.lo)} ~ ${f1(t.hi)}） |`,
  );
}
say();

/** 兵种强度：两格都跑过的兵种，比"出兵占比"和"每百金输出" */
function unitTable(a: Cell, b: Cell, aName: string, bName: string): void {
  const rows: Array<{
    name: string;
    era: number;
    shareA: number;
    shareB: number;
    per100A: number;
    per100B: number;
    ratioA: number;
    ratioB: number;
    killsA: number;
    killsB: number;
    builtA: number;
    builtB: number;
  }> = [];

  const builtTotal = (c: Cell): number => {
    let n = 0;
    for (const s of c.stats.values()) n += s.built;
    return n;
  };
  const totA = Math.max(1, builtTotal(a));
  const totB = Math.max(1, builtTotal(b));
  const games = a.reports.reduce((n, r) => n + r.results.length, 0);

  for (const [type, sa] of a.stats) {
    const sb = b.stats.get(type);
    if (!sb) continue;
    if (sa.category === 'building' || sb.category === 'building') continue;
    if (sa.built + sb.built < 40) continue; // 太少的不参与排名，噪声比信号大
    rows.push({
      name: sa.name,
      era: sa.era,
      shareA: sa.built / totA,
      shareB: sb.built / totB,
      per100A: sa.spend > 0 ? (sa.dealt / (sa.built * sa.cost)) * 100 : 0,
      per100B: sb.spend > 0 ? (sb.dealt / (sb.built * sb.cost)) * 100 : 0,
      ratioA: sa.taken > 0 ? sa.dealt / sa.taken : 0,
      ratioB: sb.taken > 0 ? sb.dealt / sb.taken : 0,
      killsA: sa.kills / games,
      killsB: sb.kills / games,
      builtA: sa.built,
      builtB: sb.built,
    });
  }
  rows.sort((x, y) => Math.max(y.builtA, y.builtB) - Math.max(x.builtA, x.builtB));

  say(`## 兵种强度：${aName} vs ${bName}`);
  say();
  say(`| 兵种 | 时代 | 出兵占比 ${aName} → ${bName} | 每百金输出 | 交换比 | 每局击杀 |`);
  say('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    say(
      `| ${r.name} | ${r.era} | ${pct(r.shareA)} → ${pct(r.shareB)}（${f1((r.shareB - r.shareA) * 100)}pp） | ` +
        `${r.per100A.toFixed(1)} → ${r.per100B.toFixed(1)} | ` +
        `${r.ratioA.toFixed(2)} → ${r.ratioB.toFixed(2)} | ` +
        `${r.killsA.toFixed(2)} → ${r.killsB.toFixed(2)} |`,
    );
  }
  say();
}

if (n5 && c5) unitTable(n5, c5, '普通', '指挥官');

say('---');
say();
say('读法：');
say('- 先手胜率按「分出胜负的局」算，未决单列；Δ 的 CI 跨 0 就是这批局看不出差别。');
say('- 「每百金输出」= 该兵总杀伤 ÷（出兵数 × 原价）× 100，跟造价挂钩，跨兵种可比。');
say('- 「交换比」= 输出 ÷ 承伤，>1 说明这笔钱换得回来；承伤为 0 的样本不进表。');

fs.writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
console.log(`\n已写出 ${OUT}`);

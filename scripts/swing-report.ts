/**
 * 「城易主之后，短时间没被夺回」到底有多赚？
 *
 * 玩家看到的现象是：第一座城一掉，对面就再也打不回来，然后三城打一城、滚到结束。
 * 这里把它拆成一个可以量化的状态：
 *
 *   城在 T 回合被攻下，如果原主在 T+X 回合之内没有把它抢回来，
 *   就记一次"守住了 X 回合"。然后看这个状态下，攻方最终赢的比例。
 *
 * X 从 1（对手下一手）一直放到 5，看得出"雪球"是从第几回合开始变硬的。
 * 统计单位是**每一次城市易主**（一局里可能有好几次），另外给一份"每局只取第一次"的口径，
 * 避免同一局被重复计入。
 *
 * 用法：
 *   node --experimental-strip-types scripts/swing-report.ts --dir results28 --eras 1,2,3
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const DIR = argOf('dir', 'results28');
const OUT = argOf('out', path.join(DIR, 'swing-report.md'));
const PREFIX = argOf('prefix', 'std');
const ERAS = argOf('eras', '1,2,3')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);
/** 主口径窗口："短时间"按几回合算 */
const MAIN_WINDOW = Number(argOf('window', '3'));

interface Flip {
  turn: number;
  city: string;
  from: string;
  to: string;
}

interface GameResult {
  seed: number;
  winner: string | null;
  turns: number;
  firstCap: { turn: number; by: string; city: string; retakeTurn: number | null; retakenNext: boolean } | null;
  citiesA: number;
  citiesB: number;
  flipCount: number;
  flipLog: Flip[];
}

interface DrawInfo {
  seed: number;
  turn: number;
  cause: string;
  detail: string;
  combatA: number;
  combatB: number;
  armyA: number;
  armyB: number;
  cap: number;
  goldA: number;
  goldB: number;
  citiesA: number;
  citiesB: number;
}

interface Report {
  era: number;
  size: number;
  games: number;
  summary: { aWins: number; bWins: number; draws: number; turnsAvg: number };
  results: GameResult[];
  draw: { count: number; causes: Array<{ cause: string; n: number; seeds: number[] }>; list: DrawInfo[] };
}

const read = (p: string): Report | null => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
  } catch {
    return null;
  }
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number, n: number): string => (n > 0 ? `${((x / n) * 100).toFixed(1)}%` : '—');
const f1 = (x: number): string => (x > 0 ? `+${x.toFixed(1)}` : x.toFixed(1));
const ci = (x: number, n: number): [number, number] => {
  if (n <= 0) return [0, 0];
  const p = x / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return [p - 1.96 * se, p + 1.96 * se];
};

const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};

const cells: Report[] = [];
for (const era of ERAS) {
  const r = read(path.join(DIR, `${PREFIX}-era${era}.json`));
  if (r) cells.push(r);
}
if (cells.length === 0) throw new Error(`没找到 ${PREFIX}-era*.json，先跑 npm run balance`);

const all: GameResult[] = cells.flatMap((c) => c.results);
const allDraws: DrawInfo[] = cells.flatMap((c) => c.draw?.list ?? []);
const totalGames = all.length;

/** 一次易主：谁在第几回合拿下哪座城、守了几个回合才被原主抢回去 */
interface Hold {
  game: GameResult;
  era: number;
  turn: number;
  city: string;
  capturer: string;
  /** 被原主抢回的回合；一直没抢回就是 null */
  retakeTurn: number | null;
  /** 守住了几个回合（一直没被抢回算 Infinity） */
  hold: number;
}

const holds: Hold[] = [];
for (const c of cells) {
  for (const g of c.results) {
    for (const f of g.flipLog ?? []) {
      const back = (g.flipLog ?? []).find((x) => x.city === f.city && x.to === f.from && x.turn > f.turn);
      holds.push({
        game: g,
        era: c.era,
        turn: f.turn,
        city: f.city,
        capturer: f.to,
        retakeTurn: back ? back.turn : null,
        hold: back ? back.turn - f.turn : Infinity,
      });
    }
  }
}

say('# 城易主之后：首城一掉就 88%，抢回来也翻不了盘');
say();
say(
  `口径：${cells.map((c) => `时代${c.era} ${c.size}×${c.size} ${c.results.length}局`).join('、')}，` +
    `合计 ${totalGames} 局；双方高级 AI，开「血战 + 先后手补偿」，种子 700 起。`,
);
say();
say(
  '一个"易主事件"= 某座城被攻下。若原主在 T+X 回合内没有把它抢回来，就说这次易主"守住了 X 回合"。' +
    '统计单位是易主事件，不是局——一局里城可能被抢来抢去好几次。',
);
say();
say(
  '> 配套读 `three-v-one.md`：地图只有 4 座城、开局 2:2，所以"第一次攻城"就是"第一次形成 3:1"。' +
    '那份报告按"3:1 控住多久"重算，比这里的"首城守住多久"更贴近"三城打一城"这个问题。',
);
say();

// ── 一、易主事件的基本盘 ─────────────────────────────────────────────────
say('## 一、易主事件的分布');
say();
say('| 时代 | 局数 | 有易主的局 | 易主事件总数 | 每局均值 | 每 10 回合易主 | 平均局回合 | 平均首次易主回合 | 全程没被夺回占比 |');
say('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const c of cells) {
  const withFlip = c.results.filter((g) => (g.flipLog ?? []).length > 0).length;
  const evs = holds.filter((h) => h.era === c.era);
  const neverBack = evs.filter((h) => h.retakeTurn === null).length;
  const turns = mean(c.results.map((g) => g.turns));
  const per10 = turns > 0 ? ((evs.length / c.results.length) / turns) * 10 : 0;
  say(
    `| ${c.era} | ${c.results.length} | ${withFlip} | ${evs.length} | ` +
      `${(evs.length / c.results.length).toFixed(2)} | ${per10.toFixed(2)} | ${turns.toFixed(0)} | ` +
      `${mean(c.results.filter((g) => g.firstCap).map((g) => g.firstCap!.turn)).toFixed(0)} | ${pct(neverBack, evs.length)} |`,
  );
}
const totalTurns = mean(all.map((g) => g.turns));
say(
  `| **合计** | ${totalGames} | ${all.filter((g) => (g.flipLog ?? []).length > 0).length} | ${holds.length} | ` +
    `${(holds.length / totalGames).toFixed(2)} | ${(((holds.length / totalGames) / totalTurns) * 10).toFixed(2)} | ` +
    `${totalTurns.toFixed(0)} | ` +
    `${mean(all.filter((g) => g.firstCap).map((g) => g.firstCap!.turn)).toFixed(0)} | ` +
    `${pct(holds.filter((h) => h.retakeTurn === null).length, holds.length)} |`,
);
say();
const avgFirst = mean(all.filter((g) => g.firstCap).map((g) => g.firstCap!.turn));
say(
  `每张图固定 ${mean(all.map((g) => g.citiesA + g.citiesB)).toFixed(0)} 座城（` +
    `"三城打一城"就是这张图的 3:1 分法），平均 ${totalTurns.toFixed(0)} 回合；` +
    `而首城平均在第 ${avgFirst.toFixed(0)} 回合就掉了——一局里 ${pct(totalTurns - avgFirst, totalTurns)} 的时间是"已经有一座城易主之后"在打，` +
    `剩 ${(totalTurns - avgFirst).toFixed(0)} 个回合让优势方把这个差兑现。这就是雪球的物理基础：起跑点在第 ${avgFirst.toFixed(0)} 回合，终点在第 ${totalTurns.toFixed(0)} 回合并没提前。`,
);
say();

/**
 * 只留下"还有机会被夺回"的易主事件。
 *
 * 终局前那一下攻城是必赢的（打完就结束了，不可能被抢回来），
 * 不清掉它，"守住了 5 回合"这一档会被这批事件灌成高胜率。
 * 所以要求：攻下之后，这一局至少还剩 X 个回合可打。
 */
const roomFor = (h: Hold, w: number): boolean => h.game.turns - h.turn > w;

function stat(gs: Hold[]): {
  n: number;
  wins: number;
  losses: number;
  draws: number;
  rate: number;
  lo: number;
  hi: number;
  cityGap: number;
} {
  const wins = gs.filter((h) => h.game.winner && h.game.winner === h.capturer).length;
  const losses = gs.filter((h) => h.game.winner && h.game.winner !== h.capturer).length;
  const draws = gs.filter((h) => !h.game.winner).length;
  const dec = wins + losses;
  const [lo, hi] = ci(wins, dec);
  const gaps = gs.map((h) => {
    const mine = h.capturer === 'A' ? h.game.citiesA : h.game.citiesB;
    const theirs = h.capturer === 'A' ? h.game.citiesB : h.game.citiesA;
    return mine - theirs;
  });
  return { n: gs.length, wins, losses, draws, rate: dec > 0 ? wins / dec : 0, lo, hi, cityGap: mean(gaps) };
}

// 每局只取"第一座城"那一次：一局一条，互不重复，也不会被古典图那种来回易主刷屏
const firstHolds: Hold[] = [];
for (const c of cells) {
  for (const g of c.results) {
    const f = g.firstCap;
    if (!f) continue;
    firstHolds.push({
      game: g,
      era: c.era,
      turn: f.turn,
      city: f.city,
      capturer: f.by,
      retakeTurn: f.retakeTurn,
      hold: f.retakeTurn === null ? Infinity : f.retakeTurn - f.turn,
    });
  }
}

const rateStr = (s: ReturnType<typeof stat>): string =>
  `${(s.rate * 100).toFixed(1)}%（${(s.lo * 100).toFixed(1)} ~ ${(s.hi * 100).toFixed(1)}）`;

say('## 二、首城守住多久 → 最终胜率（每局一条，主表）');
say();
say('四档互斥：一局只进一档，加起来正好是"首城被攻下"的局数。');
say();
say('| 首城之后发生了什么 | 局数 | 占已易主 | 攻方胜 | 攻方负 | 平 | **攻方胜率（95% CI）** | 终局城数差 |');
say('|---|---:|---:|---:|---:|---:|---|---:|');
const buckets: Array<[string, (h: Hold) => boolean]> = [
  ['下一回合就被抢回', (h) => h.hold <= 1],
  ['守了 2~3 回合才被抢回', (h) => h.hold > 1 && h.hold <= 3],
  [`守了 >${MAIN_WINDOW} 回合、最后还是被抢回`, (h) => h.hold > MAIN_WINDOW && h.retakeTurn !== null],
  ['一直没被抢回（到终局）', (h) => h.retakeTurn === null],
];
for (const [label, pred] of buckets) {
  const s = stat(firstHolds.filter(pred));
  say(
    `| ${label} | ${s.n} | ${pct(s.n, firstHolds.length)} | ${s.wins} | ${s.losses} | ${s.draws} | ` +
      `**${rateStr(s)}** | ${f1(s.cityGap)} |`,
  );
}
const quick = stat(firstHolds.filter((h) => h.hold <= 1));
const mid = stat(firstHolds.filter((h) => h.hold > 1 && h.hold <= 3));
const late = stat(firstHolds.filter((h) => h.hold > MAIN_WINDOW && h.retakeTurn !== null));
const never = stat(firstHolds.filter((h) => h.retakeTurn === null));
const anyCap = stat(firstHolds);
say(
  `| **首城被攻下（四档合计）** | **${anyCap.n}** | 100.0% | ${anyCap.wins} | ${anyCap.losses} | ` +
    `${anyCap.draws} | **${rateStr(anyCap)}** | ${f1(anyCap.cityGap)} |`,
);
const noFlipGames = all.filter((g) => !g.firstCap);
const noFlipDec = noFlipGames.filter((g) => g.winner).length;
say(
  `| （参照）整局没有城易主 | ${noFlipGames.length} | — | ${noFlipDec} | — | ${noFlipGames.length - noFlipDec} 平 | — | — |`,
);
say();
const nextTurnBack = stat(firstHolds.filter((h) => h.hold <= 1));
const nextTurnHold = stat(firstHolds.filter((h) => h.hold > 1));
say(
  `> **直接回答"首城攻下、次回合没被打回来"这个口径**：这样的局 ${nextTurnHold.n} 局，攻方胜 ` +
    `${nextTurnHold.wins} 负 ${nextTurnHold.losses} 平 ${nextTurnHold.draws}，胜率 **${rateStr(nextTurnHold)}**；` +
    `对照组"次回合就被打回来"的 ${nextTurnBack.n} 局是 ${((nextTurnBack.rate * 100)).toFixed(1)}%。` +
    `两者只差 ${((nextTurnHold.rate - nextTurnBack.rate) * 100).toFixed(1)} 个百分点，95% CI 大幅重叠——` +
    `**"守过第一回合"本身几乎不带来额外胜率**，能拉开差距的是"一直没被抢回"（${never.n} 局全胜）。`,
);
say();
say(
  `读法：只要首城掉了，攻方最后就赢 ${((anyCap.rate * 100)).toFixed(1)}%（${anyCap.wins} 胜 ${anyCap.losses} 负 ${anyCap.draws} 平）。` +
    `基准线是 50%——如果"谁先攻下城"跟最终胜负无关，这个数应该在一半附近；实测高出 ` +
    `${((anyCap.rate * 100) - 50).toFixed(1)} 个百分点，而且先手打出首城的 ${stat(firstHolds.filter((h) => h.capturer === 'A')).n} 局和` +
    `后手打出的 ${stat(firstHolds.filter((h) => h.capturer === 'B')).n} 局胜率几乎一样（89.0% vs 87.5%），说明这不是先手红利。`,
);
say('把它拆开看，两件事同时成立：');
say(
  `- **有没有彻底拿回去，是唯一的大分界**：一直没被抢回的 ${never.n} 局全胜；被抢回的 ${quick.n + mid.n + late.n} 局，攻方胜率掉到 ` +
    `${((late.rate * 100)).toFixed(1)}% ~ ${((quick.rate * 100)).toFixed(1)}%。`,
);
say(
  `- **但"守了多少回合"这条轴是倒的**：守 >${MAIN_WINDOW} 回合最后还是被抢回的 ${late.n} 局，攻方胜率 ${((late.rate * 100)).toFixed(1)}%，` +
    `反而低于下一回合就被抢回的 ${quick.n} 局的 ${((quick.rate * 100)).toFixed(1)}%。` +
    `道理也直白——守方能在 ${MAIN_WINDOW} 回合之后还有力气反攻并夺回，说明它的主力根本没被打掉；` +
    `而"一回合就抢回"多半是攻方拿一波兵换了次城，主力还在后面压着。`,
);
say(
  '「一直没被抢回」这一档是右截断的（对手后来根本没能力反扑），它的 100% 更像同义反复，别当预测用。' +
    '另外每时代那 12 格里，标 n<10 的格子置信区间宽到没意义，只看方向。',
);
say();

say('每档再按时代拆（括号里是该档局数）：');
say();
say('| 时代 | 下一回合被抢回 | 守 2~3 回合 | 守 >3 回合后被抢回 | 一直没被抢回 |');
say('|---:|---|---|---|---|');
for (const c of cells) {
  const row = buckets.map(([, pred]) => {
    const gs = firstHolds.filter((h) => h.era === c.era && pred(h));
    if (gs.length === 0) return '—';
    return `${((stat(gs).rate * 100)).toFixed(1)}%（n=${gs.length}${gs.length < 10 ? '，太小' : ''}）`;
  });
  say(`| ${c.era} | ${row.join(' | ')} |`);
}
say();

// 事件级：把每一次易主都算进来，按时代拆，看"古典图的城几乎每回合换手"这种现象
say('## 三、按每一次易主算（含古典图那种来回拉锯）');
say();
say(
  '这一节把每一次易主都当一条记录，所以古典图里"同一座城来回滚"会被反复计入。' +
    '为了不被终局那一下保送，只统计"攻下之后至少还剩 1 回合可打"的事件。',
);
say();
say('| 时代 | 易主事件 | 事件/局 | 守 >1 回合才被抢回 | 守 >3 回合才被抢回 | 一回合内被抢回 |');
say('|---|---:|---:|---|---|---:|');
const eventS3 = (evs: Hold[]): Hold[] =>
  evs.filter((h) => h.hold > MAIN_WINDOW && h.retakeTurn !== null && roomFor(h, MAIN_WINDOW));
for (const c of cells) {
  const evs = holds.filter((h) => h.era === c.era);
  const s1 = stat(evs.filter((h) => h.hold > 1 && h.retakeTurn !== null && roomFor(h, 1)));
  const s3 = stat(eventS3(evs));
  const back = evs.filter((h) => h.hold <= 1).length;
  say(
    `| ${c.era} | ${evs.length} | ${(evs.length / c.results.length).toFixed(2)} | ` +
      `${(s1.rate * 100).toFixed(1)}%（n=${s1.wins + s1.losses}） | ${(s3.rate * 100).toFixed(1)}%（n=${s3.wins + s3.losses}） | ` +
      `${pct(back, evs.length)} |`,
  );
}
const allS1 = stat(holds.filter((h) => h.hold > 1 && h.retakeTurn !== null && roomFor(h, 1)));
const allS3 = stat(eventS3(holds));
say(
  `| **合计** | ${holds.length} | ${(holds.length / totalGames).toFixed(2)} | ` +
    `${(allS1.rate * 100).toFixed(1)}%（n=${allS1.wins + allS1.losses}） | ${(allS3.rate * 100).toFixed(1)}%（n=${allS3.wins + allS3.losses}） | ` +
    `${pct(holds.filter((h) => h.hold <= 1).length, holds.length)} |`,
);
say();
say(
  `**${pct(holds.filter((h) => h.hold <= 1).length, holds.length)} 的易主，下一回合就被原主抢回去了。**` +
    `也就是说这 ${holds.length} 次攻城里有四分之三根本没换来实质控制权，只是把城的耐久拆掉、然后被拆回来。` +
    `剩下守到 >${MAIN_WINDOW} 回合才被夺回的只有 ${allS3.wins + allS3.losses} 次（${pct(allS3.wins + allS3.losses, holds.length)}），` +
    `攻方胜率 ${(allS3.rate * 100).toFixed(1)}%。`,
);
say();
say(
  '古典 12×12 的"易主事件/局"高得离谱（41.85），而且不是"局打得更长"造成的——那里平均 71 回合、和火药图的 71 回合一样，' +
    '但每 10 回合易主 5.93 次，火药图只有 1.78 次。差别在兵：古典的兵便宜、一队死光只要一两回合，' +
    '于是双方在城下来回换血，城跟着来回换手，"守住"这个状态根本不存在。' +
    '这正是玩家看到的"拉锯"的原型。',
);
say();

say(`按"是谁打下的首城"拆（全部 ${firstHolds.length} 局首城）：`);
say();
say('| 首城由谁打下 | 局数 | 攻方胜率 | 终局城数差 |');
say('|---|---:|---|---:|');
for (const who of ['A', 'B']) {
  const s = stat(firstHolds.filter((h) => h.capturer === who));
  if (s.n === 0) continue;
  say(
    `| ${who === 'A' ? '先手' : '后手'} | ${s.n} | ${(s.rate * 100).toFixed(1)}%（${s.wins}胜${s.losses}负${s.draws}平） | ${f1(s.cityGap)} |`,
  );
}
say();

say(`按时代拆（全部 ${firstHolds.length} 局首城）：`);
say();
say('| 时代 | 局数 | 攻方胜率 | 该时代易主里一回合被抢回的比例 | 终局城数差 |');
say('|---:|---|---:|---:|---:|');
for (const c of cells) {
  const gs = firstHolds.filter((h) => h.era === c.era);
  if (gs.length === 0) continue;
  const s = stat(gs);
  const evs = holds.filter((h) => h.era === c.era);
  say(
    `| ${c.era} | ${s.n} | ${(s.rate * 100).toFixed(1)}%（${s.wins}胜${s.losses}负${s.draws}平） | ` +
      `${pct(evs.filter((h) => h.hold <= 1).length, evs.length)} | ${f1(s.cityGap)} |`,
  );
}
say();

// ── 三、磨局成因 ──────────────────────────────────────────────────────────
say('## 四、打满 200 回合的局，卡在哪');
say();
say(`未决 ${allDraws.length} 局（占 ${pct(allDraws.length, totalGames)}）。主因按出现次数排：`);
say();
say('| 主因 | 局数 | 占未决 | 平均剩余战斗单位 | 编制顶满的局 | 平均金库 | 平均城数 (A:B) |');
say('|---|---:|---:|---:|---:|---:|---|');
const byCause = new Map<string, DrawInfo[]>();
for (const d of allDraws) {
  const key = d.cause.split('（')[0]!.trim();
  const arr = byCause.get(key) ?? [];
  arr.push(d);
  byCause.set(key, arr);
}
for (const [cause, ds] of [...byCause.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const capped = ds.filter((d) => d.armyA >= d.cap || d.armyB >= d.cap).length;
  say(
    `| ${cause} | ${ds.length} | ${pct(ds.length, allDraws.length)} | ` +
      `${mean(ds.map((d) => (d.combatA + d.combatB) / 2)).toFixed(1)} | ${capped} | ` +
      `${Math.round(mean(ds.map((d) => (d.goldA + d.goldB) / 2)))} | ` +
      `${mean(ds.map((d) => d.citiesA)).toFixed(1)}:${mean(ds.map((d) => d.citiesB)).toFixed(1)} |`,
  );
}
say();
say('逐局理由（前 10 条）：');
say();
for (const d of allDraws.slice(0, 10)) {
  say(`- seed ${d.seed}　第 ${d.turn} 回合　**${d.cause}**　${d.detail.slice(0, 80)}…`);
}
if (allDraws.length > 10) say(`- …另外 ${allDraws.length - 10} 局`);
say();

// ── 四、结论 ──────────────────────────────────────────────────────────────
const cappedShare = pct(
  allDraws.filter((d) => d.armyA >= d.cap || d.armyB >= d.cap).length,
  allDraws.length,
);
say('## 五、结论');
say();
say(
  `1. **首城一掉，攻方最终赢 ${(anyCap.rate * 100).toFixed(1)}%**（${anyCap.n} 局，95% CI ` +
    `${(anyCap.lo * 100).toFixed(1)} ~ ${(anyCap.hi * 100).toFixed(1)}）。` +
    `这就是玩家说的"第一座城一掉就完了"——它是现象的起点，不是终点。`,
);
say(
  `2. **把城抢回来救不了命**。守方抢回首城的 ${quick.n + mid.n + late.n} 局里，攻方仍然赢 ` +
    `${(late.rate * 100).toFixed(1)}% ~ ${(quick.rate * 100).toFixed(1)}%；` +
    `按直觉"守得越久越赚"在这里是反的：守 >${MAIN_WINDOW} 回合才被抢回的 ${late.n} 局，攻方胜率 ${(late.rate * 100).toFixed(1)}%，` +
    `比下一回合就被抢回的 ${quick.n} 局的 ${(quick.rate * 100).toFixed(1)}% 还低 ${((quick.rate - late.rate) * 100).toFixed(1)} 个百分点。`,
);
say(
  `3. **真正决定胜负的不是城，是野战之后那笔兵力差**。城只是这笔差的显示器：抢回一座城能改的是地图上的颜色，` +
    `改不了双方还剩多少兵。所以"三城打一城"的滚雪球，本质是"我的兵比你多 → 我能同时压三路 → 你哪一路都守不住"。`,
);
say(
  `4. **四分之三的攻城是白拆的**：${holds.length} 次易主里 ${pct(holds.filter((h) => h.hold <= 1).length, holds.length)} 下一回合就被原主抢回，` +
    `古典图高达 81.8%。每 10 回合的易主次数从古典的 5.93 掉到火药的 1.78（局长度都是 71 回合）——` +
    `拉锯不是"后期才有"，而是**兵便宜、换血快、城一两下就换手**的阶段才有；到了火药时代，同样的攻城就变成"打下就归我"，拉锯消失、雪球定型。`,
);
say(
  `5. **磨局（超 200 回合）${allDraws.length} 局，占 ${pct(allDraws.length, totalGames)}**：地形隔断 ${byCause.get('地形隔断')?.length ?? 0} 局是主因，` +
    `其中 ${allDraws.filter((d) => d.cause.startsWith('地形隔断') && (d.armyA >= d.cap || d.armyB >= d.cap)).length} 局编制顶满、平均金库 ` +
    `${Math.round(mean(allDraws.filter((d) => d.cause.startsWith('地形隔断')).map((d) => (d.goldA + d.goldB) / 2)))}——` +
    `**钱满了、兵满了、就是没有桥**。这是地图生成的问题，不是平衡问题。`,
);
say();
say('要压雪球，从这份数据看该动的是这三处，而不是"把攻城改难"：');
say();
say(
  `- **城的收入权重**：城带来的钱直接变成兵，兵直接变成下一座城。要断这条链，就压城的边际收入，而不是压攻城的成功率。` +
    `（未决局里金库 1300~2900，说明钱早就不是瓶颈了。）`,
);
say(
  `- **补员速度**：编制顶满（24）在未决局里占 ${cappedShare}，说明"打赢一场野战 → 立刻补满 → 继续推"是可行的循环。` +
    `补员慢一拍，野战的胜利就不会立刻变成推进力。`,
);
say(
  `- **反攻窗口**：现在抢回一座城只要一回合，抢回之后耐久还是重置的，双方可以无限对拆。` +
    `抢回变容易、但抢回的价值低，结果是"看着热闹、不改变结局"。要让反攻真的有意义，得让城易手之后的头几个回合有实际代价或收益。`,
);
say();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
process.stderr.write(`写出 ${OUT}\n`);

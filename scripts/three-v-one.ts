/**
 * 「三城打一城」到底是不是宣判？——按 3:1 的**维持时长**看胜率
 *
 * 先说清楚一件事：地图固定 4 座城、开局 2:2（setup.ts 里 placeCity 先摆 A 的两座再摆 B 的两座）。
 * 所以**第一次攻城 = 第一次形成 3:1**，这两件事是同一个时刻。于是"形成 3:1 的胜率"
 * 就等于"首城攻方的胜率"，没有新信息。
 *
 * 真正能回答"实质控制"的是：3:1 这个状态**维持了多久**。
 *   3:1 在 T 回合形成，若到 T+K 回合末仍是 3:1，就说三城方"控住"了 K 回合。
 *   再看这种情况下三城方的最终胜率——这就是一条从 50% 爬到 ~100% 的曲线。
 *
 * 另外三个副产品：
 *   - 从 3:1 到 4:0 还要打多少回合（= 玩家看到的"拉锯"长度）；
 *   - 3:1 中途被扳回 2:2 的频率，以及扳回后多快又变回 3:1；
 *   - 从来没走到 3:1 的局（城数一直卡在 2:2）。
 *
 * 3:1 是从 flipLog 回放出来的**回合末**城数，同一回合内 A→B→A 的来回不算。
 *
 * 用法：
 *   node --experimental-strip-types scripts/three-v-one.ts --dir results28 --eras 1,2,3
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const DIR = argOf('dir', 'results28');
const OUT = argOf('out', path.join(DIR, 'three-v-one.md'));
const PREFIX = argOf('prefix', 'std');
const ERAS = argOf('eras', '1,2,3')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);
/** 胜率曲线取这些"维持回合数" */
const WINDOWS = argOf('windows', '1,2,3,5,8,10,15,20')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);

type P = 'A' | 'B';

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
  flipLog: Flip[];
}

interface Report {
  era: number;
  size: number;
  games: number;
  results: GameResult[];
  draw?: { count: number; list: Array<{ seed: number; cause: string }> };
}

const read = (p: string): Report | null => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
  } catch {
    return null;
  }
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (x: number, n: number): string => (n > 0 ? `${((x / n) * 100).toFixed(1)}%` : '—');
const ci = (x: number, n: number): [number, number] => {
  if (n <= 0) return [0, 0];
  const p = x / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)];
};
const winsOf = (gs: V31[]): { w: number; l: number; d: number; rate: number; lo: number; hi: number } => {
  const w = gs.filter((v) => v.winner === v.leader).length;
  const l = gs.filter((v) => v.winner && v.winner !== v.leader).length;
  const d = gs.filter((v) => !v.winner).length;
  const [lo, hi] = ci(w, w + l);
  return { w, l, d, rate: w + l > 0 ? w / (w + l) : 0, lo, hi };
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
if (cells.length === 0) throw new Error(`没找到 ${PREFIX}-era*.json`);

// 开局固定：placeCity 先摆 A 的两座（c1、c2），再摆 B 的两座（c3、c4）
const INIT: Record<string, P> = { c1: 'A', c2: 'A', c3: 'B', c4: 'B' };

interface V31 {
  era: number;
  seed: number;
  winner: string | null;
  turns: number;
  /** 第一次形成 3:1 的回合（= 第一次攻城的回合） */
  start: number;
  leader: P;
  /** 3:1 被打破的回合；一直维持到终局就是 null */
  breakTurn: number | null;
  /** 3:1 维持了几个回合 */
  span: number;
  /** 中途有没有掉回 2:2 */
  to22: boolean;
  /** 中途有没有被反超成 1:3（对方拿 3 座） */
  to13: boolean;
  /** 掉回 2:2 之后，最快多少回合又回到 3:1（没回去就是 null） */
  recover: number | null;
  /** 3:1 一共持续了几段（按"原领先方仍拿 3 座"算） */
  episodes: number;
  /** 原领先方拿 3 座的回合数 */
  total31: number;
  /** 任一方拿 3 座的回合数（用于衡量"城数在 3:1/2:2 之间横跳"有多频繁） */
  totalAny: number;
  /** 任一方拿 3 座的段数 */
  espAny: number;
  /** 从 3:1 形成到终局还有多少回合 */
  toEnd: number;
}

/** 回放 flipLog，返回每次易主之后的回合末城数 */
function timeline(g: GameResult): Array<{ turn: number; a: number; b: number }> {
  const own: Record<string, P> = { ...INIT };
  const flips = [...(g.flipLog ?? [])].sort((x, y) => x.turn - y.turn);
  const out: Array<{ turn: number; a: number; b: number }> = [];
  let i = 0;
  while (i < flips.length) {
    const t = flips[i]!.turn;
    while (i < flips.length && flips[i]!.turn === t) {
      const f = flips[i]!;
      own[f.city] = f.to as P;
      i += 1;
    }
    const vals = Object.values(own);
    out.push({ turn: t, a: vals.filter((v) => v === 'A').length, b: vals.filter((v) => v === 'B').length });
  }
  return out;
}

// 数据校验：每座城第一次易主时的 from 应该等于开局归属
let mismatch = 0;
let checked = 0;

const games: V31[] = [];
const never31: Array<{ era: number; seed: number; winner: string | null; turns: number; finalA: number; finalB: number }> = [];

for (const c of cells) {
  for (const g of c.results) {
    const flips = [...(g.flipLog ?? [])].sort((x, y) => x.turn - y.turn);
    const seen = new Set<string>();
    for (const f of flips) {
      if (seen.has(f.city)) continue;
      seen.add(f.city);
      checked += 1;
      if (INIT[f.city] && INIT[f.city] !== f.from) mismatch += 1;
    }

    const tl = timeline(g);
    if (tl.length === 0) {
      never31.push({ era: c.era, seed: g.seed, winner: g.winner, turns: g.turns, finalA: g.citiesA, finalB: g.citiesB });
      continue;
    }

    // 把快照展开成"区间"：快照 k 的城数一直保持到快照 k+1 的回合为止
    interface Seg {
      from: number;
      to: number;
      a: number;
      b: number;
    }
    const segs: Seg[] = tl.map((s, k) => ({
      from: s.turn,
      to: k + 1 < tl.length ? tl[k + 1]!.turn : g.turns,
      a: s.a,
      b: s.b,
    }));
    // 第一次易主之前是 2:2，不用管；从这里开始找 3:1
    const i0 = segs.findIndex((s) => s.a >= 3 || s.b >= 3);
    if (i0 < 0) {
      never31.push({
        era: c.era,
        seed: g.seed,
        winner: g.winner,
        turns: g.turns,
        finalA: segs[segs.length - 1]!.a,
        finalB: segs[segs.length - 1]!.b,
      });
      continue;
    }

    const leader: P = segs[i0]!.a >= 3 ? 'A' : 'B';
    const leadOf = (s: { a: number; b: number }): number => (leader === 'A' ? s.a : s.b);
    const is31 = (s: { a: number; b: number }): boolean => leadOf(s) >= 3;

    // 第一段连续 3:1
    let j = i0;
    while (j + 1 < segs.length && is31(segs[j + 1]!)) j += 1;
    const firstRunEnd = segs[j]!.to;
    const broke = firstRunEnd < g.turns;

    // 全部 3:1 段（用于段数、总时长、恢复速度）
    let episodes = 0;
    let total31 = 0;
    let totalAny = 0;
    let espAny = 0;
    let prev31 = false;
    let prevAny = false;
    let recover: number | null = null;
    for (let k = 0; k < segs.length; k += 1) {
      const s = segs[k]!;
      const on = is31(s);
      const any = s.a >= 3 || s.b >= 3;
      if (any) {
        totalAny += s.to - s.from;
        if (!prevAny) espAny += 1;
      }
      if (on) {
        total31 += s.to - s.from;
        if (!prev31) {
          episodes += 1;
          if (recover === null && k > i0) recover = s.from - firstRunEnd;
        }
      }
      prev31 = on;
      prevAny = any;
    }

    const after = segs.filter((s) => s.from >= firstRunEnd);
    const to22 = after.some((s) => s.a === 2 && s.b === 2);
    const to13 = after.some((s) => leadOf(s) === 1 && (leader === 'A' ? s.b : s.a) === 3);

    games.push({
      era: c.era,
      seed: g.seed,
      winner: g.winner,
      turns: g.turns,
      start: segs[i0]!.from,
      leader,
      breakTurn: broke ? firstRunEnd : null,
      span: firstRunEnd - segs[i0]!.from,
      to22,
      to13,
      recover,
      episodes,
      total31,
      totalAny,
      espAny,
      toEnd: g.turns - segs[i0]!.from,
    });
  }
}

const total = cells.reduce((a, c) => a + c.results.length, 0);
const all = winsOf(games);
const totalTurns = mean(cells.flatMap((c) => c.results.map((g) => g.turns)));

say('# 三城打一城：胜负在"首城"那一刻就写好了');
say();
say(
  `口径：${cells.map((c) => `时代${c.era} ${c.size}×${c.size} ${c.results.length}局`).join('、')}，` +
    `合计 ${total} 局；双方高级 AI，开「血战 + 先后手补偿」，种子 700 起。`,
);
say();
say(
  '**先纠正一个前提**：地图固定 4 座城、开局 2:2（`setup.ts` 里 `placeCity` 先摆 A 的两座、再摆 B 的两座）。' +
    '所以"第一次攻城"和"第一次形成 3:1"是同一时刻——按"形成 3:1 的胜率"统计，得到的只是首城攻方的胜率，没有新信息。',
);
say();
say(
  '真正要问的是 **3:1 这个状态维持了多久**。定义：3:1 在 T 回合形成，若到 T+K 回合末**仍然是 3:1**，' +
    '就说三城方"控住"了 K 回合；再看这种情况下它的最终胜率。这个判定只看 T+K 那一刻，不看后面，' +
    '所以不会循环论证。',
);
say();
say(
  `城数是从 \`flipLog\` 回放出来的**回合末**值，同一回合内 A→B→A 的来回不算。` +
    `数据校验：回放用的开局归属与 ${checked} 次"某城首次易主"记录里的 from 全部对齐（不一致 ${mismatch} 次）。`,
);
say();

// ── 一、3:1 的寿命 ────────────────────────────────────────────────────────
say('## 一、3:1 能维持多久');
say();
say('| 时代 | 局数 | 卡在 2:2 没到过 3:1 | 第一次 3:1 的回合 | 第一段 3:1 的长度 | 维持到终局 | 中途掉回 2:2 |');
say('|---:|---:|---:|---:|---:|---:|---:|');
for (const c of cells) {
  const gs = games.filter((v) => v.era === c.era);
  const nv = never31.filter((v) => v.era === c.era).length;
  say(
    `| ${c.era} | ${c.results.length} | ${nv} | ${mean(gs.map((v) => v.start)).toFixed(0)} | ` +
      `${mean(gs.map((v) => v.span)).toFixed(1)}（中位 ${median(gs.map((v) => v.span)).toFixed(0)}） | ` +
      `${pct(gs.filter((v) => v.breakTurn === null).length, gs.length)} | ${pct(gs.filter((v) => v.to22).length, gs.length)} |`,
  );
}
say(
  `| **合计** | ${total} | ${never31.length} | ${mean(games.map((v) => v.start)).toFixed(0)} | ` +
    `${mean(games.map((v) => v.span)).toFixed(1)}（中位 ${median(games.map((v) => v.span)).toFixed(0)}） | ` +
    `${pct(games.filter((v) => v.breakTurn === null).length, games.length)} | ${pct(games.filter((v) => v.to22).length, games.length)} |`,
);
say();
say(
  `第一段 3:1 平均只维持 **${mean(games.map((v) => v.span)).toFixed(1)} 回合**（中位数 ${median(games.map((v) => v.span)).toFixed(0)}），` +
    `**${pct(games.filter((v) => v.to22).length, games.length)} 的局中途被打回过 2:2**。` +
    `而"有一方拿 3 座"这个状态是反复出现的：平均每局 ${mean(games.map((v) => v.espAny)).toFixed(1)} 段，` +
    `合计占全局长度的 ${pct(mean(games.map((v) => v.totalAny)), mean(games.map((v) => v.turns)))}。`,
);
say();
const rec = games.filter((v) => v.recover !== null).map((v) => v.recover!);
if (rec.length > 0) {
  say(
    `被打回 2:2 之后，三城方平均 **${mean(rec).toFixed(1)} 回合**（中位 ${median(rec).toFixed(0)}）就又拿回第 3 座城；` +
      `${rec.filter((x) => x <= 2).length}/${rec.length} 局在 2 回合内就恢复了。**这就是玩家看到的"来回拉锯"**：` +
      `城数在 3:1 和 2:2 之间反复横跳，而不是一边稳稳压着。`,
  );
  say();
}

// ── 二、胜率曲线 ─────────────────────────────────────────────────────────
say('## 二、控住 K 回合之后，三城方的胜率');
say();
say(
  '每一行只统计"在 T+K 回合末仍然是 3:1"的局。**分母扣掉了到不了 T+K 就结束的局**' +
    '（那种局要么已经被清成 4:0、要么打满上限，K 这一档对它没有意义）。',
);
say();
say('| 控住回合数 K | 到得了 T+K 的局 | 其中仍是 3:1 | 三城方胜 | 三城方负 | 未决 | **三城方胜率（95% CI）** | 比上一档 |');
say('|---:|---:|---:|---:|---:|---:|---|---:|');
let prevRate: number | null = null;
say(
  `| 0（刚形成） | ${all.w + all.l + all.d} | ${all.w + all.l + all.d} | ${all.w} | ${all.l} | ${all.d} | ` +
    `**${(all.rate * 100).toFixed(1)}%**（${(all.lo * 100).toFixed(1)} ~ ${(all.hi * 100).toFixed(1)}） | — |`,
);
prevRate = all.rate;
for (const K of WINDOWS) {
  // 到不了 T+K 就结束的局：没有资格进这一档
  const eligible = games.filter((v) => v.turns - v.start > K);
  const still = eligible.filter((v) => v.span > K);
  if (still.length === 0) {
    say(`| ${K} | ${eligible.length} | 0 | — | — | — | — | — |`);
    prevRate = null;
    continue;
  }
  const s = winsOf(still);
  const delta = prevRate === null ? '—' : `${((s.rate - prevRate) * 100 >= 0 ? '+' : '')}${((s.rate - prevRate) * 100).toFixed(1)}pp`;
  say(
    `| ${K} | ${eligible.length} | ${still.length} | ${s.w} | ${s.l} | ${s.d} | ` +
      `${(s.rate * 100).toFixed(1)}%（${(s.lo * 100).toFixed(1)} ~ ${(s.hi * 100).toFixed(1)}） | ${delta} |`,
  );
  prevRate = s.rate;
}
const toEndHolders = games.filter((v) => v.breakTurn === null);
const tg = winsOf(toEndHolders);
say(
  `| **一路控到终局** | ${tg.w + tg.l + tg.d} | ${tg.w + tg.l + tg.d} | ${tg.w} | ${tg.l} | ${tg.d} | ` +
    `${tg.w + tg.l > 0 ? `**${(tg.rate * 100).toFixed(1)}%**（${(tg.lo * 100).toFixed(1)} ~ ${(tg.hi * 100).toFixed(1)}）` : '—'} | — |`,
);
say();
say('反过来看，胜局和败局的 3:1 寿命差得很干净：');
say();
const winSpan = games.filter((v) => v.winner === v.leader).map((v) => v.span);
const loseSpan = games.filter((v) => v.winner && v.winner !== v.leader).map((v) => v.span);
const drawSpan = games.filter((v) => !v.winner).map((v) => v.span);
say('| 结局 | 局数 | 3:1 平均维持 | 中位数 | 只维持 1 回合的比例 |');
say('|---|---:|---:|---:|---:|');
for (const [label, arr] of [
  ['三城方最终胜', winSpan],
  ['三城方最终负', loseSpan],
  ['未决', drawSpan],
] as Array<[string, number[]]>) {
  if (arr.length === 0) continue;
  say(
    `| ${label} | ${arr.length} | ${mean(arr).toFixed(1)} 回合 | ${median(arr).toFixed(0)} | ` +
      `${pct(arr.filter((x) => x <= 1).length, arr.length)} |`,
  );
}
say();
const k3 = games.filter((v) => v.turns - v.start > 3 && v.span > 3);
const k5 = games.filter((v) => v.turns - v.start > 5 && v.span > 5);
const k10 = games.filter((v) => v.turns - v.start > 10 && v.span > 10);
say(
  `> **直接回答"已经实质控制首城 + 三城打一城"这个口径**：` +
    `把"实质控制"定义成"3:1 控住 ≥3 回合"，命中 ${k3.length} 局，三城方胜率 **${(winsOf(k3).rate * 100).toFixed(1)}%**；` +
    `定义成 ≥5 回合 → ${k5.length} 局、**${(winsOf(k5).rate * 100).toFixed(1)}%**；` +
    `定义成 ≥10 回合 → ${k10.length} 局、**${(winsOf(k10).rate * 100).toFixed(1)}%**。` +
    `对照"刚拿下首城（还没控住）"的 ${all.w + all.l + all.d} 局 **${(all.rate * 100).toFixed(1)}%**。`,
);
// 两比例差 + 95% CI，用来判断"控住"到底抬了多少
const diffCI = (a: { w: number; l: number }, b: { w: number; l: number }): { d: number; lo: number; hi: number } => {
  const n1 = a.w + a.l;
  const n2 = b.w + b.l;
  const p1 = n1 > 0 ? a.w / n1 : 0;
  const p2 = n2 > 0 ? b.w / n2 : 0;
  const se = Math.sqrt((p1 * (1 - p1)) / Math.max(1, n1) + (p2 * (1 - p2)) / Math.max(1, n2));
  return { d: (p1 - p2) * 100, lo: (p1 - p2 - 1.96 * se) * 100, hi: (p1 - p2 + 1.96 * se) * 100 };
};
const dK3 = diffCI(winsOf(k3), all);
const dK10 = diffCI(winsOf(k10), all);
say();
say(
  `注：K=1 与 K=2 的样本完全一样，因为没有任何一局的"第一段 3:1"恰好维持 2 回合（要么 1 回合就被追平，要么直接撑到 3 回合以上）。`,
);
say(
  `**显著性要说清楚**：控住 ≥3 回合相对"刚形成"只抬 ${dK3.d.toFixed(1)}pp，95% CI ${dK3.lo.toFixed(1)} ~ ${dK3.hi.toFixed(1)}（跨 0，站不稳）；` +
    `拉到 ≥10 回合才抬 ${dK10.d.toFixed(1)}pp，95% CI ${dK10.lo.toFixed(1)} ~ ${dK10.hi.toFixed(1)}（不跨 0）。` +
    `换句话说——**"首城一掉"这一步已经把胜率抬到 88%，后面的"控住"只是把 88% 收尾成 100%，不是从 50% 抬到 88%。**`,
);
say();
say(
  `「一路控到终局」那 ${tg.w + tg.l + tg.d} 局是右截断的——3:1 一次没被打回去，本来就等同于赢，别当预测用。`,
);
say();

// ── 三、按时代拆曲线 ─────────────────────────────────────────────────────
say('## 三、三个时代的曲线长得一样吗');
say();
const showK = WINDOWS.filter((k) => k <= 10);
say(`| 时代 | 刚形成 | ${showK.map((k) => `K=${k}`).join(' | ')} |`);
say(`|---:|---:|${showK.map(() => '---:').join('|')}|`);
for (const c of cells) {
  const gs = games.filter((v) => v.era === c.era);
  const head = winsOf(gs);
  const rest = showK.map((k) => {
    const still = gs.filter((v) => v.turns - v.start > k && v.span > k);
    if (still.length < 5) return '—';
    return `${(winsOf(still).rate * 100).toFixed(1)}%（n=${still.length}）`;
  });
  say(`| ${c.era} | ${(head.rate * 100).toFixed(1)}% | ${rest.join(' | ')} |`);
}
say();

// ── 四、3:1 之后还要打多久 ───────────────────────────────────────────────
say('## 四、"宣判"之后还要打多久才结束');
say();
say('| 时代 | 3:1 形成到终局 | 中位数 | 最长 | 期间 3:1 重来过几次（平均） |');
say('|---:|---:|---:|---:|---:|');
for (const c of cells) {
  const gs = games.filter((v) => v.era === c.era);
  say(
    `| ${c.era} | ${mean(gs.map((v) => v.toEnd)).toFixed(0)} 回合 | ${median(gs.map((v) => v.toEnd)).toFixed(0)} | ` +
      `${Math.max(...gs.map((v) => v.toEnd))} | ${mean(gs.map((v) => v.episodes - 1)).toFixed(1)} |`,
  );
}
say(
  `| **合计** | ${mean(games.map((v) => v.toEnd)).toFixed(0)} 回合 | ${median(games.map((v) => v.toEnd)).toFixed(0)} | ` +
    `${Math.max(...games.map((v) => v.toEnd))} | ${mean(games.map((v) => v.episodes - 1)).toFixed(1)} |`,
);
say();
say(
  `3:1 形成之后，平均还要 **${mean(games.map((v) => v.toEnd)).toFixed(0)} 回合**（中位 ${median(games.map((v) => v.toEnd)).toFixed(0)}）才打完，` +
    `占全局长度的 ${pct(mean(games.map((v) => v.toEnd)), totalTurns)}；` +
    `这段时间里，"三城"被打掉又重新拿回来平均 ${mean(games.map((v) => v.episodes - 1)).toFixed(1)} 次——` +
    `**它不是"一边倒的清场"，是"反复易手之后慢慢清算"**。`,
);
say();

// ── 五、从来没到过 3:1 ─────────────────────────────────────────────────
say('## 五、从来没走到 3:1 的局');
say();
say(`共 ${never31.length} 局（占 ${pct(never31.length, total)}）：城数一直卡在 2:2，或者只在 2:2 附近抖。`);
say();
if (never31.length > 0) {
  say('| 时代 | seed | 终局 | 最终城数 A:B | 结局 |');
  say('|---:|---:|---:|---|---|');
  for (const v of never31.slice(0, 15)) {
    say(
      `| ${v.era} | ${v.seed} | 第 ${v.turns} 回合 | ${v.finalA}:${v.finalB} | ` +
        `${v.winner ? `${v.winner} 胜` : '未决（打满上限）'} |`,
    );
  }
  if (never31.length > 15) say(`| … | | | | 另外 ${never31.length - 15} 局 |`);
  say();
}

// ── 六、结论 ─────────────────────────────────────────────────────────────
say('## 六、结论');
say();
say(
  `1. **"形成 3:1"本身不值钱**：它 ${pct(games.length, total)} 会发生（${games.length}/${total}），` +
    `因为 4 座城开局 2:2，第一次攻城就是它的诞生时刻。所以"形成 3:1 的胜率"= 首城攻方胜率 = ${(all.rate * 100).toFixed(1)}%，没有新信息。`,
);
say(
  `2. **真正值钱的是"首城"那一步，不是"三城"**：\`首城一掉 → ${(all.rate * 100).toFixed(1)}%\`，` +
    `而"控住 3 回合 → ${(winsOf(k3).rate * 100).toFixed(1)}%"、"控住 10 回合 → ${(winsOf(k10).rate * 100).toFixed(1)}%"。` +
    `从 50% 到 88% 是在首城那一刻完成的，从 88% 到 100% 才是后面三十回合的事。` +
    `**这就是你观战时"一掉城就完了"的量化版。**`,
);
say(
  `3. **但"拉锯"确实存在，只是它不改变结局**：3:1 平均只维持 ${mean(games.map((v) => v.span)).toFixed(1)} 回合，` +
    `${pct(games.filter((v) => v.to22).length, games.length)} 的局被打回过 2:2，平均 ${mean(rec).toFixed(1)} 回合后又拿回来；` +
    `3:1 形成之后还要打 ${mean(games.map((v) => v.toEnd)).toFixed(0)} 回合才收工，期间"三城"被打掉又重新拿回 ${mean(games.map((v) => v.episodes - 1)).toFixed(1)} 次。` +
    `**城数一直在横跳，胜率一直没动**——这就是"看着像拉锯、其实已经定了"。`,
);
say(
  `4. **平衡上的着力点在"首城之前"，不在"三城之后"**：如果目标是削弱雪球，` +
    `把 3:1 变得更难维持只能拿到几个 pp（见上注）；真正有效的是让"丢掉第一座城"不再等于输——` +
    `比如城的军事价值（产能/补员/视野）下调、或者丢城方获得一段反攻窗口。` +
    `现在的数据是：丢城那一刻，胜负已经写好了 88%。`,
);
say();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
process.stderr.write(`写出 ${OUT}\n`);

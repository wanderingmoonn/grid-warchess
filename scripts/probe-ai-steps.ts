/**
 * 「一回合能走几步」测量脚本。
 *
 * ── 它回答什么 ──────────────────────────────────────────────────────
 *
 * 老代码里 AI 每回合最多走 `AI_MAX_STEPS = 50` 步。这个数是按"24 个兵各走一步"
 * 估的，但一个兵一回合能既走又打——后期满编局必然撞上限，被砍掉的是分最低的
 * 那几步，玩家看不出来，AI 却悄悄少打了几下。
 *
 * 拆掉它之前要先量：**到底有多少回合在撞、撞的是什么样的局面**。
 * 这个脚本就是那把尺子：同一批种子跑两遍，一遍用 50，一遍用按规模算的新式子，
 * 把「每回合动作数」的分布、撞上限的回合、以及各自的胜负并排打出来。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *
 *   npm run probe:ai-steps
 *   npm run probe:ai-steps -- --games 8 --turns 80 --caps 50,auto
 *   npm run probe:ai-steps -- --caps auto --games 20 --out results/ai-steps.json
 *
 * 参数：`--games`（每个 cap 跑几局，默认 6）、`--turns`（最多几回合，默认 80）、
 * `--caps`（逗号分隔，`auto` 表示 aiStepCap，也可以写数字）、
 * `--profile`（ancient / medieval / gunpowder / modern，默认 medieval）、
 * `--level`（basic / tactic / advanced，默认 advanced）、`--seed`（基种子，默认 700000）、
 * `--out`（存 JSON 的路径）。
 *
 * ── 它不回答什么 ────────────────────────────────────────────────────
 *
 * 6 局看得出的只是方向，不是结论。样本太小的时候，胜负那两列别当真；
 * 真正能看的是「动作数分布」和「撞上限的回合占比」——那两条和胜负无关，
 * 是机制本身的性质。
 */

import {
  DEFAULT_BUDGET,
  aiNextAction,
  aiStepCap,
  aiStallGuard,
  aiProgressFingerprint,
  AI_MAX_STEPS,
} from '../src/core/ai.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { AiLevel, GameState, MatchConfig } from '../src/core/types.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const GAMES = Math.max(1, Number(argOf('games', '6')));
const MAX_TURNS = Math.max(10, Number(argOf('turns', '80')));
const BASE_SEED = Number(argOf('seed', '700000'));
const LEVEL = argOf('level', 'advanced') as AiLevel;
const OUT = argOf('out', '');
const CAPS = argOf('caps', '50,auto')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

/** 地图/时代档：只留几个常用的，够看出规模差异就行 */
const PROFILES: Record<string, Partial<MatchConfig>> = {
  ancient: { size: 12, startEra: 1 },
  medieval: { size: 16, startEra: 2 },
  gunpowder: { size: 20, startEra: 3 },
  modern: { size: 20, startEra: 5 },
};
const PROFILE = argOf('profile', 'medieval');
const profile = PROFILES[PROFILE];
if (!profile) {
  console.error(`不认识的 profile：${PROFILE}（可选：${Object.keys(PROFILES).join(' / ')}）`);
  process.exit(1);
}

interface TurnRow {
  turn: number;
  side: string;
  /** 这一回合开始时本方的兵数 */
  units: number;
  /** 这一回合实际走了几步 */
  steps: number;
  /** 这一回合的名额 */
  cap: number;
  /** 是不是撞出名额才停的（false = AI 自己没招了，正常收手） */
  hitCap: boolean;
  /** 是不是被卡死检测掐断的 */
  stalled: boolean;
  seconds: number;
}

interface GameRow {
  seed: number;
  winner: string | null;
  turns: number;
  /** 撞上限的回合数 / 总回合数 */
  capHits: number;
  /** 被卡死检测掐断的回合数 */
  stalls: number;
  steps: number;
  seconds: number;
  rows: TurnRow[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i]!;
}

function playOne(seed: number, capSpec: string): GameRow {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, ...profile, aiLevel: LEVEL, aiAlly: true, aiOpponent: true },
    seed,
  );
  const t0 = performance.now();
  const rows: TurnRow[] = [];

  while (!s.winner && s.turn <= MAX_TURNS) {
    const side = s.current;
    const units = s.units.filter((u) => u.owner === side).length;
    const cap = capSpec === 'auto' ? aiStepCap(s) : Number(capSpec);
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    const tTurn = performance.now();

    let steps = 0;
    let stoppedByCap = false;
    let stalled = false;
    /*
     * 和 main.ts 用同一个卡死检测：同一个动作连续成功、局面却不动，就停手。
     * 放进来是为了让测量口径和实机一致——否则"实测从不卡死"是句空话。
     */
    const guard = aiStallGuard();
    /*
     * 被拒的动作也算一步（和 main.ts 一致）：它真的消耗了这一步的机会。
     * 但连续被拒太多次就收手——那不是"AI 在想",是"提了个必然非法的动作"，
     * 再转下去只会把测量结果搅浑。
     */
    let rejects = 0;
    for (; steps < cap; steps += 1) {
      const action = aiNextAction(s, budget, rejected);
      if (!action) break;
      const r = applyAction(s, action);
      if (!r.ok) {
        rejected.add(JSON.stringify(action));
        rejects += 1;
        if (rejects > 12) break;
        continue;
      }
      rejects = 0;
      rejected.clear();
      s = r.state;
      if (action.type === 'RECRUIT') budget.recruited += 1;
      if (action.type === 'UPGRADE') budget.upgraded += 1;
      if (s.winner) break;
      if (guard.note(JSON.stringify(action), aiProgressFingerprint(s))) {
        stalled = true;
        break;
      }
    }
    // "撞上限"= 名额用尽，且不是因为 AI 自己没招了
    stoppedByCap = steps >= cap && !s.winner;

    rows.push({
      turn: s.turn,
      side,
      units,
      steps,
      cap,
      hitCap: stoppedByCap,
      stalled,
      seconds: (performance.now() - tTurn) / 1000,
    });

    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) {
      console.error(`  ! END_TURN 失败：${end.reason}`);
      break;
    }
    s = end.state;
  }

  return {
    seed,
    winner: s.winner ?? null,
    turns: s.turn,
    capHits: rows.filter((r) => r.hitCap).length,
    stalls: rows.filter((r) => r.stalled).length,
    steps: rows.reduce((n, r) => n + r.steps, 0),
    seconds: (performance.now() - t0) / 1000,
    rows,
  };
}

function summarize(label: string, games: GameRow[]) {
  const rows = games.flatMap((g) => g.rows);
  const steps = rows.map((r) => r.steps).sort((a, b) => a - b);
  const hits = rows.filter((r) => r.hitCap).length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = steps.length ? sum(steps) / steps.length : 0;
  const wins = { A: 0, B: 0, draw: 0 };
  for (const g of games) {
    if (g.winner === 'A') wins.A += 1;
    else if (g.winner === 'B') wins.B += 1;
    else wins.draw += 1;
  }
  return {
    label,
    games: games.length,
    turns: rows.length,
    avg,
    p50: percentile(steps, 0.5),
    p90: percentile(steps, 0.9),
    p99: percentile(steps, 0.99),
    max: steps.length ? steps[steps.length - 1]! : 0,
    hits,
    hitRate: rows.length ? hits / rows.length : 0,
    stalls: games.reduce((n, g) => n + g.stalls, 0),
    wins,
    seconds: sum(games.map((g) => g.seconds)),
  };
}

/** 兵数分档：撞上限多半发生在兵多的回合，按档看看是不是这样 */
const BUCKETS: Array<[string, number, number]> = [
  ['1-5', 1, 5],
  ['6-10', 6, 10],
  ['11-15', 11, 15],
  ['16-20', 16, 20],
  ['21+', 21, 999],
];

function bucketTable(games: GameRow[]) {
  const rows = games.flatMap((g) => g.rows);
  return BUCKETS.map(([label, lo, hi]) => {
    const inBucket = rows.filter((r) => r.units >= lo && r.units <= hi);
    const steps = inBucket.map((r) => r.steps);
    const hits = inBucket.filter((r) => r.hitCap).length;
    return {
      label,
      turns: inBucket.length,
      avg: steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0,
      p90: percentile([...steps].sort((a, b) => a - b), 0.9),
      hits,
      hitRate: inBucket.length ? hits / inBucket.length : 0,
    };
  });
}

const fmt = (n: number, d = 1) => n.toFixed(d);
const pct = (n: number) => `${fmt(n * 100, 0)}%`;

console.log(
  `测量：${PROFILE}（${profile.size}×${profile.size}，时代 ${profile.startEra}）· ` +
    `${LEVEL} · 每档 ${GAMES} 局 · 最多 ${MAX_TURNS} 回合 · 基种子 ${BASE_SEED}`,
);
console.log(`  对照：50 = 老常量 AI_MAX_STEPS（当前值 ${AI_MAX_STEPS}）；auto = aiStepCap(s)\n`);

const results: Array<{ label: string; games: GameRow[] }> = [];
for (const capSpec of CAPS) {
  const games: GameRow[] = [];
  for (let i = 0; i < GAMES; i += 1) {
    const seed = BASE_SEED + i;
    const g = playOne(seed, capSpec);
    games.push(g);
    console.log(
      `  [${capSpec}] 种子 ${seed}：${g.winner ? `${g.winner} 胜` : '未决'} · ` +
        `${g.turns} 回合 · 共 ${g.steps} 步 · 撞上限 ${g.capHits} 次` +
        `${g.stalls > 0 ? ` · **卡死 ${g.stalls} 次**` : ''} · ${fmt(g.seconds)}s`,
    );
  }
  results.push({ label: capSpec, games });
  console.log('');
}

const sums = results.map((r) => summarize(r.label, r.games));

console.log('=== 每回合动作数 ===');
const head = ['名额', '局', '总回合', '平均', 'p50', 'p90', 'p99', '最大', '撞上限', '撞上限率', '卡死'];
console.log(head.map((h) => h.padEnd(8)).join(''));
for (const r of sums) {
  console.log(
    [
      r.label,
      String(r.games),
      String(r.turns),
      fmt(r.avg),
      String(r.p50),
      String(r.p90),
      String(r.p99),
      String(r.max),
      String(r.hits),
      pct(r.hitRate),
      String(r.stalls),
    ]
      .map((x) => String(x).padEnd(8))
      .join(''),
  );
}

console.log('\n=== 按开局兵数分档（平均动作数 / 撞上限率）===');
for (const r of results) {
  console.log(`  [${r.label}]`);
  for (const b of bucketTable(r.games)) {
    console.log(
      `    兵 ${b.label.padEnd(6)} 回合 ${String(b.turns).padEnd(4)} ` +
        `平均 ${fmt(b.avg)}  p90 ${String(b.p90).padEnd(4)} ` +
        `撞上限 ${String(b.hits).padEnd(3)}（${pct(b.hitRate)}）`,
    );
  }
}

console.log('\n=== 胜负（样本小，只看方向）===');
for (const r of sums) {
  console.log(
    `  [${r.label}] A ${r.wins.A} / B ${r.wins.B} / 未决 ${r.wins.draw}` +
      ` · 总耗时 ${fmt(r.seconds)}s`,
  );
}

const hitTurns = sums.map((r) => r.hits);
if (hitTurns.length === 2) {
  const [a, b] = hitTurns as [number, number];
  console.log(
    `\n结论提示：名额 50 时撞上限 ${a} 次；换式子后 ${b} 次。` +
      (a === 0 && b === 0
        ? ' 两档都没撞——这个样本里上限还没成为瓶颈，加局数或多打几回合再看。'
        : b < a
          ? ' 新式子确实解开了截断。下一步看胜负变化有多大。'
          : ' 撞上限没减少——式子给得太小，或者撞上限另有原因（比如空转动作）。'),
  );
}

if (OUT) {
  const fs = await import('node:fs');
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        profile: PROFILE,
        size: profile.size,
        startEra: profile.startEra,
        level: LEVEL,
        games: GAMES,
        maxTurns: MAX_TURNS,
        baseSeed: BASE_SEED,
        caps: CAPS,
        summary: sums,
        detail: results.map((r) => ({
          cap: r.label,
          buckets: bucketTable(r.games),
          games: r.games.map((g) => ({ ...g, rows: g.rows })),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n明细已写入 ${OUT}`);
}

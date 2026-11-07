/**
 * 分叉筛选 A/B：只跑"策略真的改了决策"的种子。
 *
 * 为什么需要：原来每次验证都是 800 局、22 分钟，其中大半种子在改动前后**走的是
 * 一模一样的一盘棋**——因为策略是确定性的，同一个种子、同一张图、同一串动作，
 * 结果必然相同。这些种子对"新的是不是更强"这个问题贡献的信息量是 0，只贡献噪声
 * 和一半的机时。
 *
 * 做法（每颗种子一个 worker）：
 *   1. 先跑一局"新先手"。全程在每个新方决策点比对**两套 mood 函数**在同一状态上
 *      的输出（权重 / 三套 drive / 弃城 / 主攻方向）。只要全程一致，就说明旧策略
 *      在这一局里会走出完全相同的棋——于是这一对种子直接记 0.5（两臂同分），
 *      第二局一局都不用跑。
 *   2. 真出现分叉的种子，才跑第二局（旧先手），给真正的配对结果。
 *
 * 前提：改动只动了 mood（战术倾向）。动了打分函数本身时，"mood 一样"不再等于
 * "决策一样"，这个台子就不适用——那种改动还是得走 ai-duel-batch。
 *
 * 顺带给出**决策变化率**：所有观测点上，旧公式判 harass 的比例 vs 新公式的比例。
 * 这才是"这一刀到底改了多少行为"的直接读数，胜率只是它的下游后果。
 *
 * 用法（项目根，`--old` 相对 scripts/）：
 *   node --experimental-strip-types scripts/ai-duel-changed.ts \
 *        --seeds 300 --era 1 --level tactic --parallel 28 --old ./baselines/ai-cef2888.ts
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SEEDS_TOTAL = Number(argOf('seeds', '300'));
const ERA = Number(argOf('era', '1'));
const BASE_SEED = Number(argOf('seed', '900'));
const LEVEL = argOf('level', 'tactic');
const CAP = Number(argOf('cap', '160'));
const OLD = argOf('old', './baselines/ai-cef2888.ts');
const PARALLEL = Number(argOf('parallel', String(Math.min(25, os.cpus().length))));
const WORKER = argOf('worker', '');

interface MoodLike {
  lead?: string;
  weight?: Record<string, number>;
  drive?: Record<string, number>;
  abandonedCityId?: string | null;
  focusCityId?: string | null;
}

/**
 * "这一局在改动前后会走出同一盘棋"的判据。
 *
 * 不能拿浮点数逐位比：harass 的系数一动，权重每回合都会差个千分之几，逐位比等于
 * 宣布"所有种子都分叉"，筛选就白做了。
 *
 * 也不能拿 weight 比——权重只在这三个地方进决策（`>= ABANDON_AT`、`> 0.45`、
 * `> 0.5`），差 5 个百分点多半不跨阈值。真正连续乘进打分的是 **drive**。
 * 所以判据是：三套 drive 任一项差超过 EPS，或者弃城 / 主攻方向换了
 * （这两个一换，整盘棋的走位都变）。
 */
const EPS = Number(argOf('eps', '0.02'));

function divergedAt(a: MoodLike, b: MoodLike): boolean {
  for (const d of ['rush', 'harass', 'boom'] as const) {
    if (Math.abs((a.drive?.[d] ?? 0) - (b.drive?.[d] ?? 0)) > EPS) return true;
  }
  if ((a.abandonedCityId ?? null) !== (b.abandonedCityId ?? null)) return true;
  if ((a.focusCityId ?? null) !== (b.focusCityId ?? null)) return true;
  return false;
}

/* ---------------- worker：跑一批种子，打印一行 JSON ---------------- */

async function runWorker(from: number, count: number): Promise<void> {
  const { applyAction } = await import('../src/core/rules.ts');
  const { DEFAULT_CONFIG, createMatch } = await import('../src/core/setup.ts');
  const { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction, aiActiveMood } = await import('../src/core/ai.ts');
  const oldMod = (await import(OLD)) as {
    aiNextAction: typeof aiNextAction;
    aiActiveMood: (s: never) => MoodLike;
  };
  type State = ReturnType<typeof createMatch>;

  const rows: {
    seed: number; score: number; diverged: boolean; firstTurn: number;
    oldHarass: number; newHarass: number; watched: number; turns: number;
  }[] = [];

  /** 跑一局；watch=true 时逐决策点比对两套 mood */
  const play = (seed: number, aIsNew: boolean, watch: boolean) => {
    let s: State = createMatch(
      { ...DEFAULT_CONFIG, startEra: ERA, aiLevel: LEVEL as never },
      seed,
    );
    let diverged = false;
    let firstTurn = -1;
    let oldHarass = 0;
    let newHarass = 0;
    let watched = 0;

    while (!s.winner && s.turn <= CAP) {
      const newSideNow = (s.current === 'A') === aIsNew;
      const budget = { ...DEFAULT_BUDGET };
      for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
        // 观测点一路上都记，不因为已经分叉就停：两边算的是同一个状态，
        // 这些点就是"旧公式判 harass 的比例 vs 新公式"的样本。
        if (watch && newSideNow) {
          const a = aiActiveMood(s);
          const b = oldMod.aiActiveMood(s as never);
          watched += 1;
          if ((a.lead ?? '') === 'harass') newHarass += 1;
          if ((b.lead ?? '') === 'harass') oldHarass += 1;
          if (!diverged && divergedAt(a, b)) {
            diverged = true;
            firstTurn = s.turn;
          }
        }
        const ai = (s.current === 'A') === aIsNew ? aiNextAction : oldMod.aiNextAction;
        const act = ai(s, budget as never);
        if (!act) break;
        const r = applyAction(s, act as never);
        if (!r.ok) break;
        s = r.state;
        if ((act as { type: string }).type === 'RECRUIT') budget.recruited += 1;
        if ((act as { type: string }).type === 'UPGRADE') budget.upgraded += 1;
      }
      if (s.winner) break;
      const r = applyAction(s, { type: 'END_TURN' } as never);
      if (!r.ok) break;
      s = r.state;
    }
    return { winner: s.winner ?? null, turns: s.turn, diverged, firstTurn, oldHarass, newHarass, watched };
  };

  for (let i = 0; i < count; i++) {
    const seed = from + i;
    const g1 = play(seed, true, true);
    const s1 = g1.winner === null ? 0.5 : (g1.winner === 'A' ? 1 : 0);
    if (!g1.diverged) {
      // 没分叉：旧策略会走出同一盘棋，把颜色对调过来就是第二局 → 一胜一负
      rows.push({ seed, score: 0.5, diverged: false, firstTurn: -1, oldHarass: 0, newHarass: 0, watched: g1.watched, turns: g1.turns });
      continue;
    }
    const g2 = play(seed, false, false);
    const s2 = g2.winner === null ? 0.5 : (g2.winner === 'B' ? 1 : 0);
    rows.push({
      seed, score: (s1 + s2) / 2, diverged: true, firstTurn: g1.firstTurn,
      oldHarass: g1.oldHarass, newHarass: g1.newHarass, watched: g1.watched,
      turns: (g1.turns + g2.turns) / 2,
    });
  }
  console.log(`RESULT ${JSON.stringify(rows)}`);
}

/* ---------------- 父进程：切片、汇总 ---------------- */

if (WORKER) {
  const [from, count] = WORKER.split(',').map(Number);
  await runWorker(from as number, count as number);
} else {
  const SLICES = Math.min(PARALLEL, SEEDS_TOTAL);
  const per = Math.ceil(SEEDS_TOTAL / SLICES);
  const jobs: { from: number; count: number }[] = [];
  for (let i = 0; i < SLICES; i++) {
    const from = BASE_SEED + i * per;
    const count = Math.min(per, BASE_SEED + SEEDS_TOTAL - from);
    if (count > 0) jobs.push({ from, count });
  }
  console.log(
    `${SEEDS_TOTAL} 颗种子（只跑真分叉的种子）· 时代 ${ERA} · 档位 ${LEVEL} · 对手 ${OLD} · ${jobs.length} 片并发`,
  );
  const t0 = Date.now();
  const all: { seed: number; score: number; diverged: boolean; firstTurn: number; oldHarass: number; newHarass: number; watched: number; turns: number }[] = [];
  let failed = 0;
  await Promise.all(
    jobs.map((j) => new Promise<void>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
          '--worker', `${j.from},${j.count}`,
          '--era', String(ERA), '--seed', String(BASE_SEED),
          '--level', LEVEL, '--cap', String(CAP), '--old', OLD, '--eps', String(EPS),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let buf = '';
      child.stdout.on('data', (d) => { buf += String(d); });
      child.stderr.on('data', () => { /* 子进程的告警不必转发 */ });
      child.on('close', (code) => {
        const line = buf.split('\n').find((l) => l.startsWith('RESULT '));
        if (code !== 0 || !line) { failed += 1; resolve(); return; }
        all.push(...(JSON.parse(line.slice(7)) as typeof all));
        resolve();
      });
    })),
  );
  all.sort((a, b) => a.seed - b.seed);
  const n = all.length;
  const div = all.filter((r) => r.diverged);
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const pooled = mean(all.map((r) => r.score));
  const z = (pooled - 0.5) / Math.sqrt(0.25 / Math.max(1, n));
  const divRate = div.length > 0 ? mean(div.map((r) => r.score)) : 0;
  const zDiv = div.length > 0 ? (divRate - 0.5) / Math.sqrt(0.25 / div.length) : 0;
  const watched = all.reduce((s, r) => s + r.watched, 0);
  const oldH = all.reduce((s, r) => s + r.oldHarass, 0);
  const newH = all.reduce((s, r) => s + r.newHarass, 0);

  console.log(`\n完成 ${n} 颗种子（${failed} 片失败）｜墙钟 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`分叉种子 ${div.length}/${n}（${((div.length / Math.max(1, n)) * 100).toFixed(1)}%）` +
    (div.length ? `，首次分叉平均第 ${mean(div.map((r) => r.firstTurn)).toFixed(0)} 回合 · 平均 ${mean(div.map((r) => r.turns)).toFixed(0)} 回合收局` : ''));
  console.log(`决策观测点 ${watched} 个：旧公式判 harass ${((oldH / Math.max(1, watched)) * 100).toFixed(1)}% → 新公式 ${((newH / Math.max(1, watched)) * 100).toFixed(1)}%`);
  console.log(`分叉种子配对胜率 ${(divRate * 100).toFixed(1)}%（n=${div.length}，z=${zDiv.toFixed(2)}）`);
  console.log(`全样本折算 ${(pooled * 100).toFixed(1)}%（未分叉的按 0.5，n=${n}，z=${z.toFixed(2)}）`);
}

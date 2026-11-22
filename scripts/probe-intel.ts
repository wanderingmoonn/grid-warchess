/**
 * 阶段 0：量"看不见"把决战判断歪曲了多少（只读，不改任何行为）。
 *
 * ── 为什么要先量这个 ────────────────────────────────────────────
 *
 * 侦查、记忆、置信度这一整套，只有在"信息差确实扭曲决策"时才值得做。
 * 上一项的教训：扫描 13 个采样点，判决一个字都没变——先测再动手。
 *
 * 这里对同一局面的**同一时刻**算两次 `decisiveOf`：
 *   · 迷雾视角：`playerView(s, me)`，AI 真实能看到的；
 *   · 全图视角：`playerView(s, me, true)`，什么都看得见的上界。
 * 两者的比值差（迷雾 − 全图）> 0 就是"看不见 → 以为对面没人 → 高估自己"。
 *
 * ── 用法 ───────────────────────────────────────────────────────
 *
 *   npm run probe:intel                 # 四条固定用例（约 2 分钟）
 *   npm run probe:intel -- --every 3    # 每 3 回合采一次（样本更密，更慢）
 *   npm run probe:intel -- --case Q2    # 只跑一条
 *   npm run probe:intel -- --verbose    # 打印每个样本
 *
 * ── 判读 ───────────────────────────────────────────────────────
 *
 *   中位差 ≥ 0.15 → 情报确实是瓶颈，继续阶段 1；
 *   中位差 < 0.05 → 停，去查采购/编队（侦查做了也没用）。
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { aiNextAction, decisiveViewGap } from '../src/core/ai-v3.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const EVERY = Math.max(1, Number(argOf('every', '5')));
const ONLY = argOf('case', '').toUpperCase();
const VERBOSE = process.argv.includes('--verbose');

/** 与 `bench-queue` 的固定队列同口径：尺寸 / 开局时代 / 回合上限 */
interface Case {
  id: string;
  size: number;
  era: number;
  cap: number;
  seeds: number[];
}
const CASES: Case[] = [
  { id: 'Q1', size: 12, era: 2, cap: 200, seeds: [30] },
  { id: 'Q2', size: 16, era: 3, cap: 220, seeds: [30, 31] },
  { id: 'Q3', size: 24, era: 2, cap: 260, seeds: [30] },
  { id: 'Q4', size: 24, era: 4, cap: 260, seeds: [30] },
];

interface Sample {
  caseId: string;
  seed: number;
  turn: number;
  me: PlayerId;
  marchTurns: number;
  ratioFog: number;
  ratioFull: number;
  /** 迷雾 − 全图：正数 = 高估自己（看不见对面） */
  diff: number;
  foeFog: number;
  foeFull: number;
  /** 全图视角下、迷雾完全看不到的敌方战力 */
  foeMissed: number;
}

/** 跑一局，按 `EVERY` 采样当前席位的两种视角 */
function playOne(c: Case, seed: number): { samples: Sample[]; winner: PlayerId | null; turn: number } {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, startEra: c.era, aiLevel: 'tactic', size: c.size, mapSymmetry: 'fair' },
    seed,
  );
  const samples: Sample[] = [];
  let lastTurn = -1;
  while (!s.winner && s.turn <= c.cap) {
    if (s.turn % EVERY === 0 && s.turn !== lastTurn) {
      const gap = decisiveViewGap(s, s.current);
      if (gap) {
        samples.push({
          caseId: c.id,
          seed,
          turn: s.turn,
          me: s.current,
          marchTurns: gap.fogged.marchTurns,
          ratioFog: gap.fogged.ratio,
          ratioFull: gap.full.ratio,
          diff: gap.fogged.ratio - gap.full.ratio,
          foeFog: gap.fogged.foePower,
          foeFull: gap.full.foePower,
          foeMissed: Math.max(0, gap.full.foePower - gap.fogged.foePower),
        });
      }
      lastTurn = s.turn;
    }
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = aiNextAction(s, budget, rejected);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        rejected.add(aiActionKey(a));
        continue;
      }
      rejected.clear();
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }
  return { samples, winner: s.winner ?? null, turn: s.turn };
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)));
  return a[i]!;
};
const median = (xs: number[]): number => quantile(xs, 0.5);
const fmt = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2);

const cases = CASES.filter((c) => !ONLY || c.id === ONLY);
const all: Sample[] = [];

for (const c of cases) {
  for (const seed of c.seeds) {
    const t0 = Date.now();
    const run = playOne(c, seed);
    all.push(...run.samples);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${c.id} ${c.size}×${c.size}/era${c.era} seed=${seed} → ` +
        `${run.winner ? '胜者 ' + run.winner : '平'} ${run.turn} 回合 · ` +
        `${run.samples.length} 样本 · ${secs}s`,
    );
    if (VERBOSE) {
      for (const x of run.samples) {
        console.log(
          `  T${String(x.turn).padStart(3)} ${x.me} 行军${String(x.marchTurns).padStart(2)} ` +
            `迷雾 ${x.ratioFog.toFixed(2)} / 全图 ${x.ratioFull.toFixed(2)} ` +
            `差 ${fmt(x.diff)} · 敌方战力 ${Math.round(x.foeFog)}→${Math.round(x.foeFull)}`,
        );
      }
    }
  }
}

/* ---------------- 汇总 ---------------- */

if (all.length === 0) {
  console.log('\n没有样本（局面里没有敌城？）');
  process.exit(0);
}

console.log('\n| 队列 | 样本 | 差的中位 | p25 | p75 | 最大 | 迷雾高估占比 | 敌方战力漏算中位 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const c of cases) {
  const rows = all.filter((x) => x.caseId === c.id);
  if (rows.length === 0) continue;
  const ds = rows.map((x) => x.diff);
  const up = rows.filter((x) => x.diff > 0.02).length;
  console.log(
    `| ${c.id} | ${rows.length} | ${fmt(median(ds))} | ${fmt(quantile(ds, 0.25))} | ` +
      `${fmt(quantile(ds, 0.75))} | ${fmt(Math.max(...ds))} | ` +
      `${((up / rows.length) * 100).toFixed(0)}% | ${Math.round(median(rows.map((x) => x.foeMissed)))} |`,
  );
}

const ds = all.map((x) => x.diff);
const med = median(ds);
console.log(
  `\n合计 ${all.length} 样本：中位差 ${fmt(med)}，` +
    `p25 ${fmt(quantile(ds, 0.25))}，p75 ${fmt(quantile(ds, 0.75))}，` +
    `均值 ${fmt(ds.reduce((a, b) => a + b, 0) / ds.length)}`,
);
console.log(
  med >= 0.15
    ? '判读：中位差 ≥ 0.15 —— 情报确实是瓶颈，可以进阶段 1。'
    : med >= 0.05
      ? '判读：中位差 0.05~0.15 —— 有影响但不是主因；建议先做阶段 1（记忆计入），暂缓 scout。'
      : '判读：中位差 < 0.05 —— 看不见不是瓶颈，侦查做了也没用；先查采购/编队。',
);

/**
 * 对决分片器：把 `ai-duel.ts` 的 N 颗种子拆到多个进程里跑，再合并计数。
 *
 * 为什么需要：`ai-duel` 自己是一颗种子一颗种子串行跑的（要保证配对结构），
 * 40 颗种子就要十分钟。而"新 AI 是不是更强"这个问题需要的样本量远不止 40，
 * 串行等于把每次验证都拖成一次长跑。
 *
 * 配对结构不会因为分片而破坏：**一颗种子的两局（新先手 / 新后手）永远在同一个进程里**，
 * 所以"先手优势"仍然被抵消掉，只是不同的种子被分到了不同的进程。
 *
 * 用法：
 *   npm run duel:batch -- --games 100 --era 3 --parallel 25 --old ./baselines/ai-76f49ed.ts
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const has = (name: string): boolean => args.includes(`--${name}`);

/** 总局数（含两颗种子的配对），必须偶数 */
const GAMES = Number(argOf('games', '100'));
const ERA = argOf('era', '3');
const SEED = Number(argOf('seed', '900'));
const PARALLEL = Number(argOf('parallel', String(Math.min(25, os.cpus().length))));
const OLD = argOf('old', './baselines/ai-76f49ed.ts');
const LEVEL = argOf('level', 'tactic');
const CAP = argOf('cap', '160');
/**
 * `--policy greedy|hold`：把"新"那一侧换成固定打法脚本。
 *
 * 以前这里没转发，于是"AI 打人类套路"只能串行跑（5 秒一局，200 局十七分钟），
 * 而串行正是每次验证都被拖成一次长跑的原因。加一行转发之后，
 * 同一个问题从"要不要测"变成了"顺手测一下"。
 */
const POLICY = argOf('policy', '');

/**
 * 冒烟闸：超过 40 局时，先拿 20 局看一眼方向。
 *
 * 为什么要有这一道：2026-11-07 试「承诺式战术」时，那一版只封锁了战斗兵、
 * 放行了经济单位，结果 400 局 0 胜 1 平（0.1%）——而**20 局里 0 胜**在
 * "其实五五开"的前提下概率是百万分之一量级。也就是说方向早在第 20 局就死了，
 * 我却把剩下的 380 局跑完才回来看。单进程 20 局约 15 秒，400 局约 4 分半，
 * 这道闸省的不是机器时间，是"拿最贵的方式买一个早就该看见的答案"。
 *
 * 判据故意放宽到 25%~75%（20 局下约 ±2.2σ）：只有"明显崩了"才拦，
 * 中性读数（40% 上下）照常放行——那不是事故，那是实验的正常结果。
 */
const GATE_GAMES = 20;
const GATE_LO = 0.25;
const GATE_HI = 0.75;
const NO_GATE = has('no-gate') || GAMES <= 40;

const SEEDS = Math.ceil(GAMES / 2);
/** 每片分几颗种子：尽量均分，末尾的片少一点 */
interface Slice {
  seed: number;
  seeds: number;
}

/** 把 games 局拆成尽量均分的片：一颗种子的两局永远在同一片里 */
function makeSlices(games: number): Slice[] {
  const seeds = Math.ceil(games / 2);
  const slices = Math.min(PARALLEL, seeds);
  const per = Math.ceil(seeds / slices);
  const out: Slice[] = [];
  for (let i = 0; i < slices; i++) {
    const start = SEED + i * per;
    const count = Math.min(per, SEED + seeds - start);
    if (count > 0) out.push({ seed: start, seeds: count });
  }
  return out;
}

const slices = makeSlices(GAMES);

/** 从子进程输出里抠出汇总（这条格式是 ai-duel 自己打的） */
function parseSummary(out: string): { win: number; lose: number; draw: number; turns: number } | null {
  const m = out.match(/新 AI (\d+) 胜 \/ 旧 AI (\d+) 胜 \/ 平 (\d+)/);
  if (!m) return null;
  const t = out.match(/均 (\d+(?:\.\d+)?) 回合/);
  return {
    win: Number(m[1]),
    lose: Number(m[2]),
    draw: Number(m[3]),
    turns: t ? Number(t[1]) : 0,
  };
}

function run(slice: Slice): Promise<{ ok: boolean; win: number; lose: number; draw: number; turns: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/ai-duel.ts',
        '--era', ERA,
        '--games', String(slice.seeds),
        '--seed', String(slice.seed),
        '--old', OLD,
        '--level', LEVEL,
        '--cap', CAP,
        ...(POLICY ? ['--policy', POLICY] : []),
        ...(has('bare') ? ['--bare'] : []),
        ...(has('vs-new') ? ['--vs-new'] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve({ ok: false, win: 0, lose: 0, draw: 0, turns: 0 }));
    child.on('close', (code) => {
      const s = parseSummary(out);
      if (code !== 0 || !s) {
        console.error(`  ✗ 片 seed=${slice.seed}×${slice.seeds} 失败：${out.split('\n').slice(-3).join(' | ')}`);
        resolve({ ok: false, win: 0, lose: 0, draw: 0, turns: 0 });
        return;
      }
      resolve({ ok: true, ...s });
    });
  });
}

interface Tally { played: number; win: number; lose: number; draw: number; turns: number; ok: number; failed: number; rate: number }

async function runBatch(games: number, label: string, quiet: boolean): Promise<Tally> {
  const t0 = Date.now();
  const sl = makeSlices(games);
  if (!quiet) {
    console.log(
      `${games} 局（${Math.ceil(games / 2)} 颗种子 × 新先手/新后手）· 时代 ${ERA} · 档位 ${LEVEL} · ` +
        `对手 ${OLD} · ${sl.length} 片并发${label ? ` · ${label}` : ''}`,
    );
  }
  const results = await Promise.all(sl.map(run));
  let win = 0, lose = 0, draw = 0, turns = 0, ok = 0, failed = 0;
  for (const r of results) {
    if (!r.ok) { failed++; continue; }
    ok++;
    win += r.win; lose += r.lose; draw += r.draw; turns += r.turns;
  }
  const played = win + lose + draw;
  const rate = played ? (win + draw * 0.5) / played : 0;
  if (!quiet) {
    console.log('');
    console.log(`完成 ${played} 局（${ok} 片成功，${failed} 片失败）｜墙钟 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  return { played, win, lose, draw, turns, ok, failed, rate };
}

// ── 冒烟闸 ──
if (!NO_GATE) {
  const t = await runBatch(GATE_GAMES, '冒烟闸', true);
  const pct = (t.rate * 100).toFixed(1);
  if (t.rate < GATE_LO || t.rate > GATE_HI) {
    console.log(`${GATE_GAMES} 局冒烟：${t.win} 胜 / ${t.lose} 负 / ${t.draw} 平 → **${pct}%**`);
    console.log(`✗ 方向已经明显不对（${pct}%，闸口 ${(GATE_LO * 100).toFixed(0)}~${(GATE_HI * 100).toFixed(0)}%），不跑后面那 ${GAMES} 局了。`);
    console.log('  先查机制：这么偏的读数通常是"新的一侧压根没出兵/没动作"，不是强弱问题。');
    console.log('  确认要继续：加 --no-gate');
    process.exit(1);
  }
  console.log(`${GATE_GAMES} 局冒烟：${t.win} 胜 / ${t.lose} 负 / ${t.draw} 平 → ${pct}%（闸口内）`);
}

const t0 = Date.now();
console.log(
  `${GAMES} 局（${SEEDS} 颗种子 × 新先手/新后手）· 时代 ${ERA} · 档位 ${LEVEL} · ` +
    `对手 ${OLD} · ${slices.length} 片并发`,
);

const results = await Promise.all(slices.map(run));
let win = 0, lose = 0, draw = 0, turns = 0, ok = 0, failed = 0;
for (const r of results) {
  if (!r.ok) { failed++; continue; }
  ok++;
  win += r.win; lose += r.lose; draw += r.draw; turns += r.turns;
}
const played = win + lose + draw;
const decisive = win + lose;
const rate = played ? (win + draw * 0.5) / played : 0;
// 二项检验（平局算半分，方差按 played/4 保守估）
const z = played ? (rate - 0.5) / Math.sqrt(0.25 / Math.max(1, played)) : 0;

console.log('');
console.log(`完成 ${played} 局（${ok} 片成功，${failed} 片失败）｜墙钟 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(
  `新 AI ${win} 胜 / 旧 AI ${lose} 胜 / 平 ${draw}　→ 计分胜率 **${(rate * 100).toFixed(1)}%**（z=${z.toFixed(2)}）` +
    `　均 ${played ? (turns / ok).toFixed(1) : '—'} 回合`,
);
console.log(
  decisive >= 30
    ? `决胜局 ${decisive} 场，95% 区间的胜负优势约 ${(z > 1.96 || z < -1.96 ? '已跨过显著线' : '未达显著')}`
    : `决胜局只有 ${decisive} 场，样本还不够判胜负`,
);
if (failed > 0) process.exitCode = 1;

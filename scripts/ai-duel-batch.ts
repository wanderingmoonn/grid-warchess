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

const SEEDS = Math.ceil(GAMES / 2);
/** 每片分几颗种子：尽量均分，末尾的片少一点 */
const SLICES = Math.min(PARALLEL, SEEDS);
const per = Math.ceil(SEEDS / SLICES);

interface Slice {
  seed: number;
  seeds: number;
}

const slices: Slice[] = [];
for (let i = 0; i < SLICES; i++) {
  const start = SEED + i * per;
  const count = Math.min(per, SEED + SEEDS - start);
  if (count > 0) slices.push({ seed: start, seeds: count });
}

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

/**
 * 全量测试的总入口（2026-11-20）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 *
 * 以前 `npm test` 是一串 `&&`：19 个步骤**串行**跑，其中单步就 20~35 秒
 * （probe:level、probe:unit-ai、test:ui、test:net、test:rules）。
 * 串起来两分多钟，改一行代码要等这么久，人就会开始不想跑测试。
 *
 * 这些步骤之间**没有依赖**（各自建局、各自退出），所以可以并行。
 * 唯一的例外是要占端口/要连后端的那两个（serve / room），它们留在最后串行。
 *
 * 用法：
 *   npm test              串行（默认，输出最清楚，CI 用这个）
 *   npm run test:fast     4 路并行（本地改代码时用）
 *   npm run test:fast -- --parallel 6    自己调并发
 */

import { spawn } from 'node:child_process';

/** 可以并行的步骤（互相不抢端口、不写同一份文件） */
const PARALLEL_STEPS = [
  'lint:boards',
  'test:css',
  'test:contrast',
  'test:rules',
  'probe:level',
  'probe:unit-ai',
  'probe:skill-ai',
  'probe:dark-turmoil',
  'probe:level-editor',
  'test:replay',
  'test:net',
  'test:ai-optimization',
  'test:ui',
  'probe:fold',
  'probe:ai-goal',
  'test:boot',
  'test:blackout',
  'test:marquee',
  'test:paint',
];

/**
 * 必须串行的：会起服务、会占端口。
 *
 * `test:room`（联机房间）**不在全量里**：它要连真实云端，而且线上库得先跑过
 * `sql/warchess_rooms_seats.sql`。本机跑它必然红（seat_b 那边不是本脚本写进去的
 * 那个 token，`claimSeat` 于是判 'taken'），把它挂在 `npm test` 上只会天天误报。
 * 要验联机就单独 `npm run test:room`。
 */
const SERIAL_STEPS = ['test:serve'];

const argv = process.argv.slice(2);
const argOf = (k: string, fallback: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const CONCURRENCY = Math.max(1, Number(argOf('parallel', '1')));

interface Result {
  step: string;
  ok: boolean;
  ms: number;
  out: string;
}

function runStep(step: string): Promise<Result> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', '-s', step], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    child.on('close', (code) => resolve({ step, ok: code === 0, ms: Date.now() - t0, out }));
  });
}

const results: Result[] = [];

/** 并发跑一批，最多 `CONCURRENCY` 个同时 */
async function runPool(steps: string[]): Promise<void> {
  const queue = [...steps];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const r = await runStep(next);
      results.push(r);
      console.log(`${r.ok ? '✓' : '✗'} ${r.step.padEnd(22)} ${(r.ms / 1000).toFixed(1)}s`);
      if (!r.ok) console.log(indent(r.out));
    }
  });
  await Promise.all(workers);
}

const indent = (text: string): string =>
  text
    .trim()
    .split('\n')
    .slice(-40)
    .map((l) => `    ${l}`)
    .join('\n');

const t0 = Date.now();
console.log(`全量测试（${CONCURRENCY === 1 ? '串行' : `${CONCURRENCY} 路并行`}）\n`);

await runPool(PARALLEL_STEPS);
// 服务类放在最后：前面跑完就没人抢端口了
for (const step of SERIAL_STEPS) {
  const r = await runStep(step);
  results.push(r);
  console.log(`${r.ok ? '✓' : '✗'} ${step.padEnd(22)} ${(r.ms / 1000).toFixed(1)}s`);
  if (!r.ok) console.log(indent(r.out));
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length} 个步骤，${results.length - bad.length} 通过，${bad.length} 失败 · 共 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (bad.length > 0) {
  console.log(`失败的：${bad.map((r) => r.step).join('、')}`);
  process.exit(1);
}

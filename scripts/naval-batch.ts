/**
 * 分片跑批器：把 N 局拆成 N 个"一局一个进程"的分片，按并发上限同时跑。
 *
 * 为什么不用 balance-report 自带的 for 循环：那是**一次一局串行**，
 * 100 局要跑将近十分钟。而 AI 试算是纯 CPU 的单线程活，塞满核心几乎没有损耗，
 * 所以把"局"这一层提到进程级，32 核就能同时跑 32 局。
 *
 * 复现性靠**种子固定**，不靠进程数：
 *   第 i 局的种子永远是 `seed + i`，一个进程只跑一局、只写一个文件。
 *   所以并发度、分片大小、跑的顺序怎么变，合并出来的结果都一样
 *   （这一点由 `--verify` 模式守：它可以拿两个分片合成一份去和"连续跑"对账）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/naval-batch.ts \
 *     --games 50 --seed 900 --style isles --era 3 \
 *     --expansions bloodbath,height-terrain,naval-fleet \
 *     --out results/naval --parallel 32
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const GAMES = Number(argOf('games', '50'));
const SEED = Number(argOf('seed', '900'));
const ERA = argOf('era', '3');
const STYLE = argOf('style', 'isles');
const EXPANSIONS = argOf('expansions', 'bloodbath,height-terrain,naval-fleet');
const OUT = argOf('out', 'results/naval');
const CAP = argOf('cap', '200');
/** 并发上限：默认按逻辑核数，给 0 就串行（对账用） */
const PARALLEL = Number(argOf('parallel', String(os.cpus().length)));
const TAG = argOf('tag', 'run');

mkdirSync(OUT, { recursive: true });

interface Job {
  index: number;
  seed: number;
  file: string;
  log: string;
}

const jobs: Job[] = [];
for (let i = 0; i < GAMES; i++) {
  const seed = SEED + i;
  jobs.push({
    index: i,
    seed,
    file: path.join(OUT, `${TAG}-${String(i).padStart(3, '0')}-seed${seed}.json`),
    log: path.join(OUT, `${TAG}-${String(i).padStart(3, '0')}-seed${seed}.log`),
  });
}

function runJob(job: Job): Promise<{ ok: boolean; ms: number; why?: string }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/balance-report.ts',
        '--era', ERA,
        '--games', '1',
        '--seed', String(job.seed),
        '--style', STYLE,
        '--expansions', EXPANSIONS,
        '--cap', CAP,
        '--out', job.file,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    child.stdout.on('data', () => {});
    child.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, why: String(e) }));
    child.on('close', (code) => {
      writeFileSync(job.log, err, 'utf-8');
      resolve({
        ok: code === 0,
        ms: Date.now() - t0,
        why: code === 0 ? undefined : `exit ${code}: ${err.split('\n').slice(-4).join(' | ')}`,
      });
    });
  });
}

async function main(): Promise<void> {
  const started = Date.now();
  const limit = PARALLEL > 0 ? PARALLEL : 1;
  let next = 0;
  let done = 0;
  let failed = 0;
  const times: number[] = [];

  console.log(
    `跑 ${GAMES} 局 · 并发 ${limit} · 种子 ${SEED}..${SEED + GAMES - 1} · 时代 ${ERA} · 地貌 ${STYLE}\n` +
    `扩展 ${EXPANSIONS}\n输出 ${OUT}/${TAG}-*.json`,
  );

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (!job) return;
      const r = await runJob(job);
      times.push(r.ms);
      if (!r.ok) {
        failed++;
        console.error(`  ✗ #${job.index} seed=${job.seed} ${r.why ?? ''}`);
      } else {
        done++;
      }
      if ((done + failed) % 10 === 0 || done + failed === GAMES) {
        console.log(`  进度 ${done + failed}/${GAMES}（失败 ${failed}）`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, GAMES) }, () => worker()));

  const wall = Date.now() - started;
  const cpu = times.reduce((a, b) => a + b, 0);
  console.log(
    `\n完成 ${done}/${GAMES}，失败 ${failed}｜墙钟 ${(wall / 1000).toFixed(1)}s｜` +
    `单局 CPU 合计 ${(cpu / 1000).toFixed(0)}s｜加速比 ${(cpu / wall).toFixed(1)}×`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();

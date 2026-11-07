/**
 * 龙骑兵流批量对局：每一局一个进程（`dragoon-game.ts`），按核数并行拉起来，
 * 跑完把 JSON 合并成一张表。
 *
 * 为什么一局一进程：AI 试算是纯单线程 CPU 活，进程级并行几乎线性。
 * 20 局在 32 核上就是"一轮跑完"，比串行快一个数量级。
 *
 * 设计上是**成对**的：同一颗种子跑两次，龙骑兵流分别坐 A 位和 B 位。
 * 这样"先手优势"和"地图对某一侧更友好"都会被抵消掉——20 局 = 10 颗种子 × 2 个座位。
 *
 * 用法：
 *   node --experimental-strip-types scripts/dragoon-batch.ts --seeds 10 --seed 9500 --parallel 32
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SEEDS = Number(argOf('seeds', '10'));
const BASE_SEED = Number(argOf('seed', '9500'));
const CAP = Number(argOf('cap', '200'));
const PARALLEL = Number(argOf('parallel', String(os.cpus().length)));
const OUT = argOf('out', 'results/dragoon');
/** 这一批"无脑堆"的是哪个兵（默认龙骑兵；蝙蝠用 poison-bat） */
const TYPE = argOf('type', 'dragoon-rider');
const ERA = Number(argOf('era', '3'));
const SIZE = Number(argOf('size', '20'));
const AI_PATH = argOf('ai', '');
const LABEL = argOf(
  'label',
  ({
    'poison-bat': '蝙蝠',
    'dragoon-rider': '龙骑兵',
    'griffin-rider': '狮鹫骑士',
    harpy: '鹰身女妖',
    'spider-rider': '蜘蛛骑士',
  } as Record<string, string>)[TYPE] ?? TYPE,
);

mkdirSync(OUT, { recursive: true });

interface Job {
  seed: number;
  seat: 'A' | 'B';
  file: string;
}
const jobs: Job[] = [];
for (let i = 0; i < SEEDS; i += 1) {
  const seed = BASE_SEED + i;
  for (const seat of ['A', 'B'] as const) {
    jobs.push({ seed, seat, file: path.join(OUT, `g-${seed}-${seat}.json`) });
  }
}

function runJob(job: Job): Promise<{ ok: boolean; ms: number; why?: string }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/dragoon-game.ts',
        '--seed', String(job.seed),
        '--seat', job.seat,
        '--cap', String(CAP),
        '--era', String(ERA),
        '--size', String(SIZE),
        '--type', TYPE,
        ...(AI_PATH ? ['--ai', AI_PATH] : []),
        '--out', job.file,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    child.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, why: String(e) }));
    child.on('close', (code) =>
      resolve({ ok: code === 0, ms: Date.now() - t0, why: code === 0 ? undefined : `exit ${code}: ${err.split('\n').slice(-3).join(' | ')}` }),
    );
  });
}

async function main(): Promise<void> {
  const started = Date.now();
  const limit = Math.max(1, Math.min(PARALLEL, jobs.length));
  let next = 0;
  let done = 0;
  let failed = 0;
  console.log(
    `${LABEL}流 vs 标准 AI：${jobs.length} 局（${SEEDS} 颗种子 × 2 个座位）· ${ERA} 代 ${SIZE}×${SIZE} · 并发 ${limit} · ` +
      `种子 ${BASE_SEED}..${BASE_SEED + SEEDS - 1} · 火器 20×20`,
  );

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (!job) return;
      const r = await runJob(job);
      if (r.ok) done += 1;
      else {
        failed += 1;
        console.error(`  ✗ seed=${job.seed} seat=${job.seat} ${r.why ?? ''}`);
      }
      if ((done + failed) % 5 === 0 || done + failed === jobs.length) {
        console.log(`  进度 ${done + failed}/${jobs.length}（失败 ${failed}）`);
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));

  const wall = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n完成 ${done}/${jobs.length}，失败 ${failed}｜墙钟 ${wall}s\n`);

  // ── 合并 ──
  interface Row {
    seed: number;
    seat: 'A' | 'B';
    winner: 'A' | 'B' | null;
    dragoonWon: boolean;
    turns: number;
    goldOnDragoons: number;
    dragoonsBuilt: number;
    dragoonsLost: number;
    dragoonsAlive: number;
    peakDragoons: number;
    dmgDealt: number;
    dmgTaken: number;
    kills: { economy: number; combat: number; other: number };
    enemyEconomyTotal: number;
    enemyEconomyKilled: number;
    enemyCombatKilled: number;
    cities: { mine: number; foe: number };
  }
  const rows: Row[] = [];
  for (const job of jobs) {
    try {
      rows.push(JSON.parse(readFileSync(job.file, 'utf-8')) as Row);
    } catch {
      /* 失败的那局已经报过，这里跳过 */
    }
  }
  if (rows.length === 0) {
    console.error('一局都没有成功');
    process.exit(1);
  }

  const sum = (f: (r: Row) => number): number => rows.reduce((n, r) => n + f(r), 0);
  const avg = (f: (r: Row) => number): number => sum(f) / rows.length;
  const wins = rows.filter((r) => r.dragoonWon).length;
  const losses = rows.filter((r) => !r.dragoonWon && r.winner !== null).length;
  const draws = rows.length - wins - losses;
  const seatRate = (seat: 'A' | 'B'): { w: number; n: number } => {
    const g = rows.filter((r) => r.seat === seat);
    return { w: g.filter((r) => r.dragoonWon).length, n: g.length };
  };

  const totDealt = sum((r) => r.dmgDealt);
  const totTaken = sum((r) => r.dmgTaken);
  const ecoTotal = sum((r) => r.enemyEconomyTotal);
  const ecoKilled = sum((r) => r.enemyEconomyKilled);

  const pct = (a: number, b: number): string => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`;
  const A = seatRate('A');
  const B = seatRate('B');

  const lines: string[] = [];
  lines.push(`# ${LABEL}速攻 · ${rows.length} 局结果`);
  lines.push('');
  lines.push(`> 打法：全力攒钱只买${LABEL}，直冲对面经济单位 → 战斗单位；`);
  lines.push('> 白送的战斗单位守家，白送的农民继续赚钱。对手是标准 AI（高级）。');
  lines.push(`> ${ERA} 代开局 ${SIZE}×${SIZE}，一颗种子跑两局（${LABEL}坐 A / 坐 B），抵消先手与地图偏好。`);
  lines.push('');
  lines.push('## 总体');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 对局 | ${rows.length} 局（${SEEDS} 颗种子 × 2 座位） |`);
  lines.push(`| ${LABEL}方胜 | **${wins} / ${rows.length}（${pct(wins, rows.length)}）** |`);
  lines.push(`| 负 | ${losses}（${pct(losses, rows.length)}） |`);
  lines.push(`| 未决（打满 ${CAP} 回合） | ${draws} |`);
  lines.push(`| 坐 A 时胜率 | ${A.w}/${A.n}（${pct(A.w, A.n)}） |`);
  lines.push(`| 坐 B 时胜率 | ${B.w}/${B.n}（${pct(B.w, B.n)}） |`);
  lines.push(`| 平均回合 | ${avg((r) => r.turns).toFixed(1)} |`);
  lines.push('');
  lines.push(`## ${LABEL}的账（每局平均）`);
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 造出 | ${avg((r) => r.dragoonsBuilt).toFixed(1)} 个（合计 ${sum((r) => r.dragoonsBuilt)}） |`);
  lines.push(`| 阵亡 | ${avg((r) => r.dragoonsLost).toFixed(1)} 个 |`);
  lines.push(`| 终局存活 | ${avg((r) => r.dragoonsAlive).toFixed(1)} 个（峰值 ${avg((r) => r.peakDragoons).toFixed(1)}） |`);
  lines.push(`| 花在${LABEL}上的金 | ${Math.round(avg((r) => r.goldOnDragoons)).toLocaleString('en-US')} |`);
  lines.push(`| 打出的伤害 | ${Math.round(avg((r) => r.dmgDealt))} |`);
  lines.push(`| 承受的伤害 | ${Math.round(avg((r) => r.dmgTaken))} |`);
  lines.push(`| 交换比（输出/承伤） | ${(totDealt / Math.max(1, totTaken)).toFixed(2)} |`);
  lines.push(`| 击杀：经济 / 战斗 / 其他 | ${sum((r) => r.kills.economy)} / ${sum((r) => r.kills.combat)} / ${sum((r) => r.kills.other)} |`);
  lines.push(`| 敌方经济单位被杀 | ${ecoKilled} / ${ecoTotal}（${pct(ecoKilled, ecoTotal)}） |`);
  lines.push('');
  lines.push('## 逐局');
  lines.push('');
  lines.push('| 种子 | 座位 | 胜方 | 回合 | 造 | 亡 | 存 | 输出 | 承伤 | 击杀经济 | 击杀战斗 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of [...rows].sort((a, b) => a.seed - b.seed || a.seat.localeCompare(b.seat))) {
    lines.push(
      `| ${r.seed} | ${r.seat} | ${r.winner ?? '未决'}${r.dragoonWon ? ' ✔' : ''} | ${r.turns} | ` +
        `${r.dragoonsBuilt} | ${r.dragoonsLost} | ${r.dragoonsAlive} | ${Math.round(r.dmgDealt)} | ${Math.round(r.dmgTaken)} | ` +
        `${r.kills.economy} | ${r.kills.combat} |`,
    );
  }
  lines.push('');

  writeFileSync(path.join(OUT, 'report.md'), `${lines.join('\n')}\n`, 'utf-8');
  writeFileSync(
    path.join(OUT, 'summary.json'),
    JSON.stringify(
      {
        games: rows.length,
        seeds: SEEDS,
        baseSeed: BASE_SEED,
        era: 3,
        size: 20,
        wins,
        losses,
        draws,
        winRate: wins / rows.length,
        bySeat: { A, B },
        avgTurns: avg((r) => r.turns),
        dragoons: {
          built: sum((r) => r.dragoonsBuilt),
          lost: sum((r) => r.dragoonsLost),
          alive: sum((r) => r.dragoonsAlive),
          gold: sum((r) => r.goldOnDragoons),
        },
        dealt: totDealt,
        taken: totTaken,
        exchange: totDealt / Math.max(1, totTaken),
        kills: {
          economy: sum((r) => r.kills.economy),
          combat: sum((r) => r.kills.combat),
          other: sum((r) => r.kills.other),
        },
        enemyEconomy: { total: ecoTotal, killed: ecoKilled },
        rows,
      },
      null,
      1,
    ),
    'utf-8',
  );

  console.log(lines.slice(0, 40).join('\n'));
  console.log(`\n→ ${path.join(OUT, 'report.md')}`);
}

await main();

/**
 * 反事实动作一致率：在**同一个局面**上，新旧两套策略会不会选同一个动作。
 *
 * 为什么需要这个：A/B 胜率只能回答"强不强"，回答不了"到底改没改到棋上"。
 * 一次改动可以是"行为明显变了但棋力没变"，也可以是"根本没改到动作上"——
 * 这两件事的解释完全不同，而胜率把它们糊成同一个 50%。
 *
 * 做法（每颗种子）：用**旧**策略走完整一局；在每个决策点，把同一个状态分别喂给
 * 旧策略和新策略，比较两者选出的动作是否相同。因为状态轨迹由旧策略决定，
 * 这就是"新策略在旧策略遇到的局面里会怎么做"的逐点对照。
 *
 * 读法：
 *   · 一致率 99% → 这一刀基本没落到动作上，胜率中性是**定义**上的必然；
 *   · 一致率 90% 但胜率仍中性 → 改到了动作，但改的那些动作对结果不重要；
 *   · 一致率 90% 且胜率高/低 → 改到了要紧的地方。
 *
 * 用法（项目根，`--old` 相对 scripts/）：
 *   node --experimental-strip-types scripts/probe-agreement.ts \
 *        --seeds 24 --era 1 --level tactic --parallel 24 --old ./baselines/ai-cef2888.ts
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SEEDS = Number(argOf('seeds', '24'));
const ERA = Number(argOf('era', '1'));
const BASE_SEED = Number(argOf('seed', '900'));
const LEVEL = argOf('level', 'tactic');
const CAP = Number(argOf('cap', '160'));
const OLD = argOf('old', './baselines/ai-cef2888.ts');
const PARALLEL = Number(argOf('parallel', String(Math.min(24, os.cpus().length))));
const WORKER = argOf('worker', '');
/** 战术层增益（0 = 摘掉；1 = 原样；>1 = 补量级） */
const GAIN = Number(argOf('gain', '1'));

interface Row {
  seed: number;
  /** 所有决策点 */
  all: number; agree: number;
  /** 旧策略此刻主导 harass 的决策点 */
  harass: number; harassAgree: number;
  /** 旧策略此刻主导 boom / rush 的点 */
  boom: number; boomAgree: number;
  rush: number; rushAgree: number;
  turns: number;
}

async function runWorker(from: number, count: number): Promise<void> {
  const { applyAction } = await import('../src/core/rules.ts');
  const { DEFAULT_CONFIG, createMatch } = await import('../src/core/setup.ts');
  const { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction, setDoctrineGain } = await import('../src/core/ai.ts');
  setDoctrineGain(GAIN);
  const oldMod = (await import(OLD)) as {
    aiNextAction: typeof aiNextAction;
    aiActiveMood: (s: never) => { lead?: string };
  };
  type State = ReturnType<typeof createMatch>;

  /** 动作指纹：类型 + 目标 + 落点（同类型不同落点算不同动作） */
  const key = (a: unknown): string => {
    if (!a) return 'null';
    const x = a as Record<string, unknown>;
    return [x.type, x.unitId ?? x.unit ?? '', x.targetId ?? x.target ?? '', x.x ?? '', x.y ?? '', x.typeId ?? x.unitType ?? ''].join('|');
  };

  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const seed = from + i;
    let s: State = createMatch({ ...DEFAULT_CONFIG, startEra: ERA, aiLevel: LEVEL as never }, seed);
    const row: Row = { seed, all: 0, agree: 0, harass: 0, harassAgree: 0, boom: 0, boomAgree: 0, rush: 0, rushAgree: 0, turns: 0 };

    while (!s.winner && s.turn <= CAP) {
      const budget = { ...DEFAULT_BUDGET };
      for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
        const oldAct = oldMod.aiNextAction(s as never, budget as never);
        if (!oldAct) break;
        // 同一个状态给新策略：它会不会选同一手
        const newAct = aiNextAction(s, { ...DEFAULT_BUDGET } as never);
        const lead = oldMod.aiActiveMood(s as never).lead ?? '';
        const same = key(newAct) === key(oldAct);
        row.all += 1;
        if (same) row.agree += 1;
        if (lead === 'harass') { row.harass += 1; if (same) row.harassAgree += 1; }
        else if (lead === 'boom') { row.boom += 1; if (same) row.boomAgree += 1; }
        else if (lead === 'rush') { row.rush += 1; if (same) row.rushAgree += 1; }

        const r = applyAction(s, oldAct as never);
        if (!r.ok) break;
        s = r.state;
      }
      if (s.winner) break;
      const e = applyAction(s, { type: 'END_TURN' } as never);
      if (!e.ok) break;
      s = e.state;
    }
    row.turns = s.turn;
    rows.push(row);
  }
  console.log(`RESULT ${JSON.stringify(rows)}`);
}

if (WORKER) {
  const [from, count] = WORKER.split(',').map(Number);
  await runWorker(from as number, count as number);
} else {
  const SLICES = Math.min(PARALLEL, SEEDS);
  const perSlice = Math.ceil(SEEDS / SLICES);
  const jobs: { from: number; count: number }[] = [];
  for (let i = 0; i < SLICES; i++) {
    const from = BASE_SEED + i * perSlice;
    const count = Math.min(perSlice, BASE_SEED + SEEDS - from);
    if (count > 0) jobs.push({ from, count });
  }
  console.log(`${SEEDS} 局 · 时代 ${ERA} · 档位 ${LEVEL} · 增益 ${GAIN} · 对手 ${OLD} · ${jobs.length} 片并发`);
  const t0 = Date.now();
  const all: Row[] = [];
  let failed = 0;
  await Promise.all(jobs.map((j) => new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      '--worker', `${j.from},${j.count}`,
      '--era', String(ERA), '--seed', String(BASE_SEED),
      '--level', LEVEL, '--cap', String(CAP), '--old', OLD, '--gain', String(GAIN),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += String(d); });
    child.stderr.on('data', () => { /* 忽略告警 */ });
    child.on('close', (code) => {
      const line = buf.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line) { failed += 1; resolve(); return; }
      all.push(...(JSON.parse(line.slice(7)) as Row[]));
      resolve();
    });
  })));

  const sum = (f: (r: Row) => number): number => all.reduce((s, r) => s + f(r), 0);
  const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
  const allN = sum((r) => r.all);
  const agree = sum((r) => r.agree);
  console.log(`\n完成 ${all.length} 局（${failed} 片失败）｜墙钟 ${((Date.now() - t0) / 1000).toFixed(0)}s · 动作数 ${allN}`);
  console.log(`同局面动作一致率 ${pct(agree, allN)}（分歧 ${allN - agree} 个决策点）`);
  console.log(`  旧判 harass 的点：${pct(sum((r) => r.harassAgree), sum((r) => r.harass))} 一致（n=${sum((r) => r.harass)}）`);
  console.log(`  旧判 boom 的点：${pct(sum((r) => r.boomAgree), sum((r) => r.boom))} 一致（n=${sum((r) => r.boom)}）`);
  console.log(`  旧判 rush 的点：${pct(sum((r) => r.rushAgree), sum((r) => r.rush))} 一致（n=${sum((r) => r.rush)}）`);
  const perGame: string[] = [];
  for (const r of all) perGame.push(`${((r.agree / Math.max(1, r.all)) * 100).toFixed(0)}%`);
  console.log(`逐局分布：${perGame.join(' ')}`);
}

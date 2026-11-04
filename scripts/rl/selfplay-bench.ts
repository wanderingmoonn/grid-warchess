/**
 * 训练吞吐的量尺：**随机合法策略**跑完整局，看每秒能推多少步。
 *
 * 这个数字决定 PPO 的预算（一轮采样要多久、一天能跑多少局），
 * 也是"要不要把网络写得更小"的唯一依据。策略故意用随机的——
 * 它不代表棋力，只代表"环境+枚举+一次决策"的固定开销。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/selfplay-bench.ts
 *   ... --games 40 --size 8 --workers 8      # 8 个 worker 并行，看总吞吐
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyAction } from '../../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../../src/core/setup.ts';
import type { GameState } from '../../src/core/types.ts';
import { legalActions } from './legal.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const GAMES = Number(argOf('games', '20'));
const SIZE = Number(argOf('size', '8'));
const CAP = Number(argOf('cap', '120'));
const WORKERS = Number(argOf('workers', '1'));
const CHILD = args.includes('--child');

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

interface Stats {
  games: number;
  steps: number;
  actions: number;
  enumMs: number;
  applyMs: number;
  turns: number;
}

function runGames(from: number, count: number): Stats {
  const st: Stats = { games: 0, steps: 0, actions: 0, enumMs: 0, applyMs: 0, turns: 0 };
  for (let k = 0; k < count; k++) {
    const seed = 50000 + from + k;
    let s: GameState = createMatch(
      { ...DEFAULT_CONFIG, size: SIZE, startEra: 1, draftMode: false },
      seed,
    );
    s.fog = false;
    const rand = rng(seed);
    while (!s.winner && s.turn <= CAP) {
      const t0 = performance.now();
      const actions = legalActions(s);
      st.enumMs += performance.now() - t0;
      if (actions.length === 0) break;
      st.actions += actions.length;
      const pick = actions[Math.floor(rand() * actions.length)]!;
      const t1 = performance.now();
      const r = applyAction(s, pick);
      st.applyMs += performance.now() - t1;
      if (!r.ok) break;
      s = r.state;
      st.steps += 1;
    }
    st.turns += s.turn;
    st.games += 1;
  }
  return st;
}

if (CHILD) {
  // worker 模式：跑一批，打印一行 JSON
  const st = runGames(Number(argOf('from', '0')), GAMES);
  process.stdout.write('STATS ' + JSON.stringify(st) + '\n');
} else {
  const t0 = performance.now();
  let total: Stats = { games: 0, steps: 0, actions: 0, enumMs: 0, applyMs: 0, turns: 0 };
  let elapsed = 0;

  if (WORKERS <= 1) {
    total = runGames(0, GAMES);
    elapsed = performance.now() - t0;
  } else {
    const per = Math.ceil(GAMES / WORKERS);
    const self = fileURLToPath(import.meta.url);
    const jobs = Array.from({ length: WORKERS }, (_, i) => i);
    const results = await Promise.all(
      jobs.map(
        (i) =>
          new Promise<Stats>((resolve) => {
            const p = spawn(process.execPath, [
              '--experimental-strip-types',
              self,
              '--child',
              '--games',
              String(per),
              '--from',
              String(i * per),
              '--size',
              String(SIZE),
              '--cap',
              String(CAP),
            ]);
            let out = '';
            p.stdout.on('data', (d) => (out += String(d)));
            p.on('close', () => {
              const line = out.split('\n').find((l) => l.startsWith('STATS '));
              resolve(line ? (JSON.parse(line.slice(6)) as Stats) : { games: 0, steps: 0, actions: 0, enumMs: 0, applyMs: 0, turns: 0 });
            });
          }),
      ),
    );
    for (const r of results) {
      total.games += r.games;
      total.steps += r.steps;
      total.actions += r.actions;
      total.enumMs += r.enumMs;
      total.applyMs += r.applyMs;
      total.turns += r.turns;
    }
    elapsed = performance.now() - t0;
  }

  const sec = elapsed / 1000;
  console.log(`\n随机合法策略 · ${total.games} 局 · ${SIZE}×${SIZE} · ${WORKERS} worker · 墙钟 ${sec.toFixed(1)}s`);
  console.log(`  局/秒 ${(total.games / sec).toFixed(2)} · 步/秒 ${(total.steps / sec).toFixed(0)} · 平均 ${(total.steps / Math.max(1, total.games)).toFixed(0)} 步/局 · ${(total.turns / Math.max(1, total.games)).toFixed(0)} 回合/局`);
  console.log(`  枚举 ${(total.enumMs / 1000).toFixed(1)}s（${((total.enumMs / 1000 / sec) * 100).toFixed(0)}% CPU）· 每步枚举 ${(total.enumMs / Math.max(1, total.steps)).toFixed(2)}ms · 平均 ${(total.actions / Math.max(1, total.steps)).toFixed(0)} 个合法动作/步`);
  console.log(`  引擎 applyAction ${(total.applyMs / 1000).toFixed(1)}s（每步 ${(total.applyMs / Math.max(1, total.steps)).toFixed(2)}ms）`);
  const perCore = total.steps / sec / WORKERS;
  const perHour32 = perCore * 32 * 3600;
  console.log(`  推算：单核 ${perCore.toFixed(0)} 步/秒 → 32 核 ${(perHour32 / 1e6).toFixed(1)}M 步/小时，1000 万步约 ${((1e7 / perHour32) * 60).toFixed(0)} 分钟`);
}

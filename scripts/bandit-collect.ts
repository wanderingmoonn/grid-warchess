/**
 * 窄决策数据采集：**同一批种子，换三种战术各打一遍**。
 *
 * ── 这一层要回答什么 ────────────────────────────────────────────────────
 *
 * AI 每回合会从三种战术里选一个主导（`rush / harass / boom`，见 `aiMood`）。
 * 现在的选择是"手写证据 + 种子底色"算出来的，那套公式是谁也没验证过的。
 * 这里换个问法：**如果这一局从一开始就指定某一种战术，胜率差多少？**
 *
 * 差得明显 → 说明选择器有价值：至少知道"哪套更强"，以及"什么局面用哪套"。
 * 差得不多 → 说明战术选择对胜负影响很小，那这一层可以不做（省一天）。
 *
 * 这正是"窄决策"该有的最小版本：动作空间只有 3 个，不是序列决策问题，
 * 用不着 PPO——跑一批配对局数一数就够了（contextual bandit 的 A/B）。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────
 *
 * · **被测席强制一种战术，对手用 auto**（`aiDoctrineSeat`）。反对称地跑：
 *   同一颗种子让被测席先手一次、后手一次，先手优势和地图不对称互相抵消。
 * · 平局（撞回合上限）按半分算，和 duel 的口径一致。
 * · 对手永远是"当前代码的 auto"，所以三族之间的差可以横向比。
 *
 * 用法（**项目根**）：
 *   node --experimental-strip-types scripts/bandit-collect.ts --seeds 100 --parallel 28 --size 12
 */

import { spawn } from 'node:child_process';
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const DOCTRINES = ['rush', 'harass', 'boom'] as const;
type Doctrine = (typeof DOCTRINES)[number];

const SEEDS = Number(argOf('seeds', '100'));
const SEED0 = Number(argOf('seed0', '7000'));
const SIZE = Number(argOf('size', '12'));
const ERA = Number(argOf('era', '1'));
const LEVEL = argOf('level', 'advanced');
const CAP = Number(argOf('cap', '160'));
const PARALLEL = Number(argOf('parallel', '28'));
const WORKER = has('worker');

/** 一局：被测席按 `doctrine` 打，另一席 auto */
function playOne(seed: number, doctrine: Doctrine, seat: PlayerId): {
  winner: PlayerId | null;
  turns: number;
} {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: SIZE,
      startEra: ERA,
      aiLevel: LEVEL as 'basic' | 'advanced' | 'tactic',
      aiDoctrine: doctrine,
      aiDoctrineSeat: seat,
      playerCount: 2,
      draftMode: false,
    },
    seed,
  );

  while (!s.winner && s.turn <= CAP) {
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }
  return { winner: s.winner ?? null, turns: s.turn };
}

if (WORKER) {
  // worker：stdin 每行一颗 "doctrine seed"，跑两局（被测席先手/后手），输出一行 JSON
  const rl = (await import('node:readline')).createInterface({ input: process.stdin });
  for await (const line of rl) {
    const [doc, seedStr] = line.trim().split(/\s+/);
    if (!doc || !seedStr) continue;
    const doctrine = doc as Doctrine;
    const seed = Number(seedStr);
    for (const seat of ['A', 'B'] as PlayerId[]) {
      const r = playOne(seed, doctrine, seat);
      process.stdout.write(
        JSON.stringify({ doctrine, seed, seat, winner: r.winner, turns: r.turns }) + '\n',
      );
    }
  }
  process.exit(0);
}

// ── 父进程：切任务、起 worker、汇总 ─────────────────────────────────────
const tasks: Array<{ doctrine: Doctrine; seed: number }> = [];
for (const d of DOCTRINES) {
  for (let i = 0; i < SEEDS; i++) tasks.push({ doctrine: d, seed: SEED0 + i });
}

const chunks: Array<typeof tasks> = [];
const per = Math.ceil(tasks.length / PARALLEL);
for (let i = 0; i < tasks.length; i += per) chunks.push(tasks.slice(i, i + per));

type Row = { doctrine: Doctrine; seed: number; seat: PlayerId; winner: PlayerId | null; turns: number };
const rows: Row[] = [];

console.log(
  `${DOCTRINES.length} 战术 × ${SEEDS} 颗种子 × 2 座位 = ${tasks.length * 2} 局` +
    ` · ${SIZE}×${SIZE} · era${ERA} · ${LEVEL} · ${chunks.length} 片并发`,
);

await Promise.all(
  chunks.map(
    (chunk) =>
      new Promise<void>((resolve) => {
        /*
         * 参数必须整份传给 worker。
         *
         * 2026-11-06 踩过一次：这里只传了脚本路径 + `--worker`，于是 worker
         * 全用默认值（size 12 / era 1 / level **advanced**）。后果是父进程
         * `--level tactic` 完全没生效，而 advanced 会把三套战术屏蔽掉
         * （见 ai.ts 的 moodFor），三组"不同战术"因此跑出了一模一样的 99:99。
         * 连跑两轮（advanced 和 tactic）都是同一批结果，才暴露出这里。
         */
        const passthrough = args.filter((a) => a !== '--worker');
        const child = spawn(
          process.execPath,
          ['--experimental-strip-types', process.argv[1] as string, '--worker', ...passthrough],
          { stdio: ['pipe', 'pipe', 'inherit'] },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', () => {
          for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            try {
              rows.push(JSON.parse(line) as Row);
            } catch {
              /* 半行/噪声，丢掉 */
            }
          }
          resolve();
        });
        child.stdin.write(chunk.map((t) => `${t.doctrine} ${t.seed}`).join('\n') + '\n');
        child.stdin.end();
      }),
  ),
);

// ── 汇总 ────────────────────────────────────────────────────────────────
const stat = (list: Row[]) => {
  let win = 0;
  let lose = 0;
  let draw = 0;
  let turns = 0;
  for (const r of list) {
    turns += r.turns;
    if (r.winner === null) draw += 1;
    else if (r.winner === r.seat) win += 1;
    else lose += 1;
  }
  const n = list.length;
  const score = n > 0 ? (win + draw * 0.5) / n : 0;
  // 二项近似：单臂 ±(0.5/√n) 是 1 倍标准误
  const se = n > 0 ? Math.sqrt(0.25 / n) : 0;
  return { n, win, lose, draw, score, se, turns: n > 0 ? turns / n : 0 };
};

console.log('\n| 战术 | 局数 | 胜 | 负 | 平 | 得分率 | 95% 区间 | 均回合 |');
console.log('|---|---:|---:|---:|---:|---:|---|---:|');
for (const d of DOCTRINES) {
  const s = stat(rows.filter((r) => r.doctrine === d));
  const lo = Math.max(0, s.score - 1.96 * s.se);
  const hi = Math.min(1, s.score + 1.96 * s.se);
  console.log(
    `| ${d} | ${s.n} | ${s.win} | ${s.lose} | ${s.draw} | **${(s.score * 100).toFixed(1)}%** | ` +
      `[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}] | ${s.turns.toFixed(0)} |`,
  );
}

const base = stat(rows.filter((r) => r.doctrine === 'boom')).score;
console.log(`\n（对手一律是当前代码的 auto；boom 作参照线 ${(base * 100).toFixed(1)}%）`);

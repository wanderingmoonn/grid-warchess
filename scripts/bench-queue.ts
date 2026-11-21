/**
 * 固定队列跑批：一条命令给出"这次改动到底有没有用"。
 *
 * 为什么要它：之前的结论都是 6 局、12 局，而**换一批种子的差异有 30 个百分点**，
 * 比改动本身大得多。于是每改一次都在噪声里找一个数字，谁也不敢下结论。
 *
 * 这个脚本做三件事：
 *   1. 固定四条队列（Q1~Q4，尺寸 × 开局时代，各 3 颗种子 × 两席）；
 *   2. 每局结果落盘成 JSON（种子、手、胜者、回合）——**同一条队列才能配对比较**；
 *   3. 汇总时给**胜率的 95% 区间**（Wilson），而不是一个点。区间宽就是在提醒：
 *      这点样本还判不出来。
 *
 * 用法：
 *   npm run bench:ai -- --new ../src/core/ai-v3.ts --old ./baselines/ai-9efb961.ts --tag v3
 *   npm run bench:ai -- --queue Q2,Q3 --tag 试跑          # 分批（24 局一次跑容易被系统杀）
 *   npm run bench:ai -- --new X --tag after --compare results/bench/before.json
 *
 * `--compare` 做**配对**比较：同队列、同种子、同席位，只看"这一局两版谁赢"。
 * 这才是能消掉地图差异的比法——跨批次比总胜率没有意义。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

interface Queue {
  id: string;
  size: number;
  era: number;
  cap: number;
  seeds: number[];
}

/**
 * 固定队列（口径 v2）。
 *
 * 开局时代按"这张图典型能打多少回合"定：12×12 打 30~70 回合，升不动两代；
 * 24×24 能打 90~150 回合，才留得出升级空间。era5 是没开扩展包时的封顶，
 * 开局就封顶等于没有升级动作，所以取 era4。
 */
const QUEUES: Queue[] = [
  { id: 'Q1', size: 12, era: 2, cap: 200, seeds: [30, 31, 32] },
  { id: 'Q2', size: 16, era: 3, cap: 220, seeds: [30, 31, 32] },
  { id: 'Q3', size: 24, era: 2, cap: 260, seeds: [30, 31, 32] },
  { id: 'Q4', size: 24, era: 4, cap: 260, seeds: [30, 31, 32] },
];

const pickArg = argOf('queue', '');
const WANT = pickArg ? new Set(pickArg.split(',').map((x) => x.trim().toUpperCase())) : null;
/** 路径都相对 `scripts/` 解析（和 ai-duel 的写法一致：`--new ../src/core/ai-v3.ts`） */
const HERE = dirname(fileURLToPath(import.meta.url));
const NEW_PATH = resolve(HERE, argOf('new', '../src/core/ai-v3.ts'));
const OLD_PATH = resolve(HERE, argOf('old', './baselines/ai-9efb961.ts'));
const TAG = argOf('tag', 'run');
const COMPARE = argOf('compare', '');

type Ai = (
  s: GameState,
  budget: typeof DEFAULT_BUDGET,
  rejected: ReadonlySet<string>,
) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;

interface Result {
  queue: string;
  seed: number;
  newSide: PlayerId;
  winner: PlayerId | null;
  turn: number;
  /** 新 AI 这一局的结果：1 胜 / 0 平 / -1 负 */
  score: 1 | 0 | -1;
}

/** 一局：aIsNew 决定 A 席用哪一版（同一颗种子两席各跑一次，抵掉先后手偏差） */
function playOne(aiNew: Ai, aiOld: Ai, q: Queue, seed: number, aIsNew: boolean): Result {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, startEra: q.era, aiLevel: 'tactic', size: q.size, mapSymmetry: 'fair' },
    seed,
  );
  const aiFor = (p: PlayerId): Ai => ((p === 'A') === aIsNew ? aiNew : aiOld);
  while (!s.winner && s.turn <= q.cap) {
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = aiFor(s.current)(s, budget, rejected);
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
  const newSide: PlayerId = aIsNew ? 'A' : 'B';
  const winner = s.winner ?? null;
  return {
    queue: q.id,
    seed,
    newSide,
    winner,
    turn: s.turn,
    score: winner === null ? 0 : winner === newSide ? 1 : -1,
  };
}

/** 胜率的 95% 区间（Wilson）：区间宽就是在说"这点样本还判不出来" */
function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  const modNew = (await import(NEW_PATH)) as { aiNextAction: Ai };
  const modOld = (await import(OLD_PATH)) as { aiNextAction: Ai };
  const aiNew = modNew.aiNextAction;
  const aiOld = modOld.aiNextAction;

  const queues = QUEUES.filter((q) => !WANT || WANT.has(q.id));
  const results: Result[] = [];

  for (const q of queues) {
    for (const seed of q.seeds) {
      for (const aIsNew of [true, false]) {
        const r = playOne(aiNew, aiOld, q, seed, aIsNew);
        results.push(r);
        const tag = r.score > 0 ? '新胜' : r.score < 0 ? '新负' : '平';
        process.stderr.write(
          `${q.id} seed=${seed} 新${aIsNew ? '先' : '后'} → ${tag} (${r.turn} 回合)\n`,
        );
      }
    }
  }

  // ── 汇总 ──
  const rows: string[] = [];
  rows.push('| 队列 | 局数 | 胜-负-平 | 胜率 [95% 区间] | 平局率 | 均回合 |');
  rows.push('|---|---|---|---|---|---|');
  let W = 0;
  let L = 0;
  let D = 0;
  let turns = 0;
  for (const q of queues) {
    const rs = results.filter((r) => r.queue === q.id);
    const w = rs.filter((r) => r.score > 0).length;
    const l = rs.filter((r) => r.score < 0).length;
    const d = rs.length - w - l;
    const [lo, hi] = wilson(w, rs.length);
    const avg = rs.reduce((n, r) => n + r.turn, 0) / Math.max(1, rs.length);
    rows.push(
      `| ${q.id} ${q.size}×${q.size}/era${q.era} | ${rs.length} | ${w}-${l}-${d} | ${pct(w / rs.length)} [${pct(lo)}, ${pct(hi)}] | ${pct(d / rs.length)} | ${avg.toFixed(0)} |`,
    );
    W += w;
    L += l;
    D += d;
    turns += rs.reduce((n, r) => n + r.turn, 0);
  }
  const n = results.length;
  const [lo, hi] = wilson(W, n);
  rows.push(
    `| **合计** | ${n} | **${W}-${L}-${D}** | **${pct(W / n)} [${pct(lo)}, ${pct(hi)}]** | ${pct(D / n)} | ${(turns / Math.max(1, n)).toFixed(0)} |`,
  );

  let verdict = '';
  if (COMPARE) {
    const before = JSON.parse(readFileSync(resolve(COMPARE), 'utf8')) as { results: Result[] };
    let up = 0;
    let down = 0;
    let same = 0;
    for (const now of results) {
      const was = before.results.find(
        (r) => r.queue === now.queue && r.seed === now.seed && r.newSide === now.newSide,
      );
      if (!was) continue;
      if (now.score > was.score) up += 1;
      else if (now.score < was.score) down += 1;
      else same += 1;
    }
    const paired = up + down + same;
    verdict =
      `\n**配对（同队列、同种子、同席位）**：改善 ${up}、变差 ${down}、相同 ${same}（共 ${paired} 局）` +
      `\n` +
      (up > down
        ? `→ 方向为正（+${up - down}）。样本 ${paired} 局，仍要看区间。`
        : up < down
          ? `→ 方向为负（${down - up}）。`
          : '→ 打平，看不出差别。');
  }

  const md = `${rows.join('\n')}\n${verdict}\n`;
  const outDir = resolve('results/bench');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, `${TAG}.json`),
    JSON.stringify({ tag: TAG, at: new Date().toISOString(), results }, null, 2),
  );
  writeFileSync(
    resolve(outDir, `${TAG}.md`),
    `# bench ${TAG}\n\n新：${NEW_PATH}\n旧：${OLD_PATH}\n\n${md}`,
  );
  console.log(md);
  console.log(`明细：results/bench/${TAG}.json`);
}

await main();

/**
 * 从跑批队列里复现**同一局**并导出回放。
 *
 * 为什么不用 `ai-duel --replay`：那个脚本有自己的一套参数（扩展、若干覆盖项），
 * 和 `bench-queue.ts` 的 `createMatch` 不完全相同。差一处，跑出来的就不是同一局棋，
 * 拿它解释跑批结果等于换了个对局。这里逐行复制跑批的 `playOne`，只多记 actions。
 *
 * 用法：
 *   node --experimental-strip-types scripts/export-bench-replay.ts \
 *     --queue Q4 --seed 30 --new-side B --out results/replays/draw-q4-30-b.json
 *
 * `--new-side` 指"新版 AI 坐哪一席"，和跑批里的 `newSide` 一致。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { buildMatchReport } from '../src/core/report.ts';
import type { LoggedAction } from '../src/core/report.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

/** 与 `bench-queue.ts` 的 QUEUES 逐字一致，改一边必须改另一边 */
const QUEUES: Array<{ id: string; size: number; era: number; cap: number; seeds: number[] }> = [
  { id: 'Q1', size: 12, era: 2, cap: 200, seeds: [30, 31, 32] },
  { id: 'Q2', size: 16, era: 3, cap: 220, seeds: [30, 31, 32] },
  { id: 'Q3', size: 24, era: 2, cap: 260, seeds: [30, 31, 32] },
  { id: 'Q4', size: 24, era: 4, cap: 260, seeds: [30, 31, 32] },
];

const QUEUE_ID = argOf('queue', 'Q4').toUpperCase();
const SEED = Number(argOf('seed', '30'));
const NEW_SIDE = (argOf('new-side', 'A').toUpperCase() === 'B' ? 'B' : 'A') as PlayerId;
const OUT = argOf('out', `results/replays/q-${QUEUE_ID}-${SEED}-${NEW_SIDE}.json`);

const queue = QUEUES.find((q) => q.id === QUEUE_ID);
if (!queue) throw new Error(`没有这条队列：${QUEUE_ID}（只有 ${QUEUES.map((q) => q.id).join('/')}）`);
if (!queue.seeds.includes(SEED)) throw new Error(`${QUEUE_ID} 没有种子 ${SEED}（有 ${queue.seeds.join('/')}）`);

type Ai = (
  s: GameState,
  budget: typeof DEFAULT_BUDGET,
  rejected: ReadonlySet<string>,
) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;

const modNew = (await import('../src/core/ai-v3.ts')) as { aiNextAction: Ai };
const modOld = (await import('./baselines/ai-9efb961.ts')) as { aiNextAction: Ai };
const aiNew = modNew.aiNextAction;
const aiOld = modOld.aiNextAction;

const aIsNew = NEW_SIDE === 'A';
/*
 * 开关必须和 `bench-queue.ts` 对齐：跑批带着 `--hub`/`--city-site` 跑的，
 * 导出时漏掉就只能得到另一局棋（这个脚本存在的全部理由就是"同一局"）。
 */
const HUB = process.argv.includes('--hub');
const CITY_SITE = process.argv.includes('--city-site');
const GARRISON = process.argv.includes('--garrison');
const RUIN_SAFE = process.argv.includes('--ruin-safe');
let s: GameState = createMatch(
  {
    ...DEFAULT_CONFIG,
    startEra: queue.era,
    aiLevel: 'tactic',
    size: queue.size,
    mapSymmetry: 'fair',
    ...(HUB ? { aiHub: true } : {}),
    ...(CITY_SITE ? { aiCitySite: true } : {}),
    ...(GARRISON ? { aiGarrison: true } : {}),
    ...(RUIN_SAFE ? { aiRuinSafe: true } : {}),
  },
  SEED,
);
const aiFor = (p: PlayerId): Ai => ((p === 'A') === aIsNew ? aiNew : aiOld);

const actions: LoggedAction[] = [];
while (!s.winner && s.turn <= queue.cap) {
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = aiFor(s.current)(s, budget, rejected);
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) {
      // 和跑批同一套：MOVE 目标被友军占是瞬时状态，同单位试 2 次再记
      if (a.type === 'MOVE' && 'unitId' in a) {
        const uid = String((a as { unitId?: string }).unitId ?? '');
        const n = (moveTries.get(uid) ?? 0) + 1;
        moveTries.set(uid, n);
        if (n < 2) continue;
      }
      rejected.add(aiActionKey(a));
      continue;
    }
    rejected.clear();
    actions.push({ ...a, by: s.current });
    s = r.state;
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
  }
  if (s.winner) break;
  const endTurn = { type: 'END_TURN' as const };
  const r = applyAction(s, endTurn);
  if (!r.ok) break;
  actions.push({ ...endTurn, by: s.current });
  s = r.state;
}

const report = buildMatchReport(s, new Date(), null, actions);
const out = resolve(OUT);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report));

const who = (p: PlayerId | null): string => (p === null ? '平' : p === NEW_SIDE ? '新版胜' : '基线胜');
console.log(
  `${QUEUE_ID} ${queue.size}×${queue.size}/era${queue.era} seed=${SEED} 新版坐 ${NEW_SIDE} 席 → ${who(s.winner ?? null)}（${s.turn} 回合，上限 ${queue.cap}）`,
);
console.log(`回放：${out}（${actions.length} 步）`);

// 终局快照：平局最需要这个——谁其实占优
const side = (p: PlayerId): string => {
  const cities = s.cities.filter((c) => c.owner === p && !c.ruined).length;
  const units = s.units.filter((u) => u.owner === p);
  const combat = units.filter((u) => s.unitTypes[u.type]?.category === 'combat').length;
  const econ = units.filter((u) => s.unitTypes[u.type]?.category === 'economy').length;
  return `${p}: 城 ${cities} · 兵 ${combat} · 经济 ${econ} · 金 ${s.players[p].gold}`;
};
for (const p of ['A', 'B'] as PlayerId[]) console.log(`  ${side(p)}`);

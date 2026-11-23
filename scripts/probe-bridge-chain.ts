/**
 * 探针：修桥链路——"有河却不修桥"断在哪一环？
 *
 * 用户 2026-11-23 的判断："大优势却平局，绝大多数是有河但没修桥。"
 * 这条链有六个环节，任何一环断掉都表现为"兵堆在河边":
 *
 *   ① 判要不要过河  canReachEnemyByLand（陆路 BFS，上限 min(w,h)）
 *   ② 计划当值      CROSSING_PLAN.value（army ≥ 3、aiCrossing 没关）
 *   ③ 选渡口        crossingPointOf（我方岸上、离对岸最近的水格）
 *   ④ 派工人        建造编队（buildPoint → 1~2 个 builder）
 *   ⑤ 走到能造的距离 工人走位 +42/step×6，`buildRange = 2`
 *   ⑥ 选址合法      buildSiteError（水面/有陆地邻/格空/时代/钱）
 *
 * 这个脚本每 N 回合打一行这些环节的状态，用来定位断点。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-bridge-chain.ts --queue Q4 --seed 30 --side B
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const QUEUES: Record<string, { size: number; era: number; cap: number }> = {
  Q1: { size: 12, era: 2, cap: 200 },
  Q2: { size: 16, era: 3, cap: 220 },
  Q3: { size: 24, era: 2, cap: 260 },
  Q4: { size: 24, era: 4, cap: 260 },
};
const QID = argOf('queue', 'Q4').toUpperCase();
const q = QUEUES[QID];
if (!q) throw new Error(`没有队列 ${QID}`);
const SEED = Number(argOf('seed', '30'));
const SIDE = (argOf('side', 'B').toUpperCase() === 'A' ? 'A' : 'B') as PlayerId;
const EVERY = Number(argOf('every', '10'));

type Ai = (
  s: GameState,
  budget: typeof DEFAULT_BUDGET,
  rejected: ReadonlySet<string>,
) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;
const modNew = (await import('../src/core/ai-v3.ts')) as { aiNextAction: Ai };
const modOld = (await import('./baselines/ai-9efb961.ts')) as { aiNextAction: Ai };
const aiFor = (p: PlayerId): Ai => (p === SIDE ? modNew.aiNextAction : modOld.aiNextAction);

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, startEra: q.era, aiLevel: 'tactic', size: q.size, mapSymmetry: 'fair' },
  SEED,
);

/* 地图本身：水有多少、有没有河 */
const water = s.tiles.filter((t) => t.terrain === 'water' || t.terrain === 'deep').length;
const marsh = s.tiles.filter((t) => t.terrain === 'marsh').length;
console.log(
  `${QID} ${q.size}×${q.size}/era${q.era} seed=${SEED} · 水面 ${water} 格 · 沼泽 ${marsh} 格 · 新版坐 ${SIDE}`,
);

const info = () => {
  const f = (s.aiFocus as Record<string, { squads?: Array<Record<string, unknown>>; plan?: { id?: string; keep?: Record<string, unknown> } }> | undefined)?.[SIDE];
  const keep = (f?.plan?.keep ?? {}) as Record<string, unknown>;
  const squads = f?.squads ?? [];
  const builders = s.units.filter((u) => u.owner === SIDE && s.unitTypes[u.type]?.category === 'builder');
  const bridges = s.units.filter((u) => u.owner === SIDE && u.type.startsWith('bridge'));
  const buildSquad = squads.filter((x) => x.role === 'build');
  const combat = s.units.filter((u) => u.owner === SIDE && s.unitTypes[u.type]?.category === 'combat').length;
  return {
    plan: f?.plan?.id ?? '-',
    crossing: keep.crossingSite as { x: number; y: number } | undefined,
    lost: Number(keep.lost ?? 0),
    bridges: keep.bridges,
    jam: keep.bridgeJam,
    builders: builders.length,
    bridgeUnits: bridges.length,
    buildSquad: buildSquad.length,
    buildPt: (buildSquad[0]?.targetPoint as { x: number; y: number } | null | undefined) ?? null,
    combat,
    gold: s.players[SIDE].gold,
  };
};

while (!s.winner && s.turn <= q.cap) {
  const turn = s.turn;
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = aiFor(s.current)(s, budget, rejected);
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) {
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
    s = r.state;
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
  }
  if (s.winner) break;

  if (turn % EVERY === 0) {
    const i = info();
    console.log(
      `T${String(turn).padStart(3)} 计划 ${i.plan} · 渡口 ${i.crossing ? `${i.crossing.x},${i.crossing.y}` : '无'}` +
        ` · 桥 ${i.bridgeUnits}/${i.bridges ?? '-'} · 拆 ${i.lost} · 堵 ${i.jam ?? 0}` +
        ` · 工人 ${i.builders} · 建队 ${i.buildSquad}${i.buildPt ? `→${i.buildPt.x},${i.buildPt.y}` : ''}` +
        ` · 兵 ${i.combat} · 金 ${i.gold}`,
    );
  }

  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}
const end = s.cities
  .filter((c) => c.owner === SIDE && !c.ruined)
  .map((c) => `${c.id}@${c.x},${c.y}`);
console.log(`终局 ${s.winner ?? '平'}（${s.turn} 回合）· ${SIDE} 剩下 ${end.join(' ') || '无城'}`);

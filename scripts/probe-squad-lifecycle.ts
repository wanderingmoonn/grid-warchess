/**
 * 探针：编队生命周期——工人/士兵死了，编队会不会跟着消失？
 *
 * 用户 2026-11-23 在 `draw-q4-30-b` 里观察到："建造工人都战死了，建造编队却没有解散，
 * v3 一直以为自己有个建造编队"。回放里**不存 `aiFocus`**（那是 AI 内部状态），
 * 所以只能重跑对局看——这个脚本按跑批口径复现一局，每回合打印编队与真实单位数。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-squad-lifecycle.ts --queue Q4 --seed 30 --side B --from 100
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import type { DEFAULT_BUDGET as Budget } from '../src/core/ai.ts';

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
const FROM = Number(argOf('from', '0'));
const TO = Number(argOf('to', '999'));
const EVERY = Number(argOf('every', '5'));

type Ai = (
  s: GameState,
  budget: typeof Budget,
  rejected: ReadonlySet<string>,
) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;
const modNew = (await import('../src/core/ai-v3.ts')) as { aiNextAction: Ai };
const modOld = (await import('./baselines/ai-9efb961.ts')) as { aiNextAction: Ai };
/* 对手席必须用老版：跑批里就是 `(p === 'A') === aIsNew ? aiNew : aiOld`，
   两边都用新版跑出来是另一局棋，观察到的现象对不上。 */
const aiFor = (p: PlayerId): Ai => (p === SIDE ? modNew.aiNextAction : modOld.aiNextAction);

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, startEra: q.era, aiLevel: 'tactic', size: q.size, mapSymmetry: 'fair' },
  SEED,
);

const squadOf = (): { squads: Array<Record<string, unknown>>; keep: Record<string, unknown> } => {
  const f = (s.aiFocus as Record<string, { squads?: Array<Record<string, unknown>>; plan?: { keep?: Record<string, unknown> } }> | undefined)?.[SIDE];
  return { squads: f?.squads ?? [], keep: f?.plan?.keep ?? {} };
};

const count = (p: PlayerId, cat: string): number =>
  s.units.filter((u) => u.owner === p && s.unitTypes[u.type]?.category === cat).length;

while (!s.winner && s.turn <= q.cap) {
  const turn = s.turn;
  /* 和跑批逐行一致：同回合内复用 rejected、MOVE 被拒同单位试两次 */
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

  /* 回合末看**我们的席位**（注意：AI 决策的是 `s.current`，所以只在轮到我方时统计） */
  if (turn >= FROM && turn <= TO && turn % EVERY === 0) {
    const { squads, keep } = squadOf();
    const builds = squads.filter((x) => x.role === 'build');
    const atks = squads.filter((x) => x.role === 'attack');
    const realBuilders = count(SIDE, 'builder');
    const desc = builds
      .map((b) => {
        const ids = (b.memberIds as string[]) ?? [];
        const aliveIds = ids.filter((id) => s.units.some((u) => u.id === id && u.owner === SIDE));
        return `[成员 ${ids.length}/活 ${aliveIds.length}]`;
      })
      .join(' ');
    /* 进攻编队：lead 是"最前的人到目标城"，stalled 是"连续几回合 lead 没减少" */
    const prev = (keep.squadPrev ?? {}) as Record<string, { count: number; lead: number; stalled: number }>;
    const atkDesc = atks
      .map((a) => {
        const p = prev[String(a.id)] ?? { lead: 0, stalled: 0, count: 0 };
        return `${a.id}(兵${p.count} 前${p.lead} 停${p.stalled})`;
      })
      .join(' ');
    console.log(
      `T${String(turn).padStart(3)} ${SIDE} 工人 ${realBuilders} · 缺工 ${keep.builderNeed ?? '-'} · ` +
        `build ${builds.length}${desc ? ' ' + desc : ''} · atk ${atks.length} ${atkDesc}`,
    );
  }

  /* 每回合都查一次（不受 --every 限制）：编队里有没有"成员全死却还挂着"的 */
  {
    const { squads } = squadOf();
    for (const sq of squads) {
      const ids = (sq.memberIds as string[]) ?? [];
      if (ids.length === 0) continue;
      const alive = ids.filter((id) => s.units.some((u) => u.id === id && u.owner === SIDE));
      if (alive.length < ids.length) {
        console.log(
          `  ⚠ T${s.turn} ${String(sq.role)} 编队 ${String(sq.id)}：成员 ${ids.length}，活着 ${alive.length}` +
            (alive.length === 0 ? '  ← 全死了但编队还在' : ''),
        );
      }
    }
  }
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}
console.log(`终局 ${s.winner ?? '平'}（${s.turn} 回合）`);

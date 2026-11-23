/**
 * 城视角的回放时间线：每 N 回合打一行，看**每座城**的时代/血量/这 N 回合被从它那儿造了几个兵。
 *
 * 为什么需要它：`analyze-replay.ts` 打的是"城数/兵力/经济/金"，
 * 看不出"升级投给了哪座城""兵从哪座城出来"。P1-3（升级选城）和
 * P0-4（采购选址）要看的就是这两件事——"前线城一直停在低一代"
 * 只有把每座城的 era 并排打出来才看得见。
 *
 * 用法：
 *   node --experimental-strip-types scripts/replay-city-timeline.ts results/replays/a.json --every 20
 *   ... --side A         只打某一席
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const flag = (n: string, d = ''): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const EVERY = Math.max(1, Number(flag('every', '20')));
const ONLY = flag('side', '').toUpperCase() as PlayerId | '';
const files = args.filter(
  (a, i) => !a.startsWith('--') && !['every', 'side'].includes((args[i - 1] ?? '').replace(/^--/, '')),
);
if (files.length === 0) {
  console.error('用法：replay-city-timeline.ts <回放.json> [更多…] [--every 20] [--side A]');
  process.exit(1);
}

interface ReplayAction {
  type: string;
  cityId?: string;
  unitType?: string;
  [k: string]: unknown;
}

for (const file of files) {
  const r = JSON.parse(readFileSync(resolve(file), 'utf8')) as {
    seed: number;
    config?: Record<string, unknown>;
    actions?: ReplayAction[];
  };
  const cfg = (r.config ?? {}) as Record<string, unknown>;
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: Number(cfg.size ?? DEFAULT_CONFIG.size),
      startEra: Number(cfg.startEra ?? DEFAULT_CONFIG.startEra),
      mapSymmetry: (cfg.mapSymmetry as typeof DEFAULT_CONFIG.mapSymmetry) ?? 'fair',
    },
    r.seed,
  );

  /** 本段累计：城 id → 从它产出的兵数（按兵种分开记） */
  const made = new Map<string, string[]>();
  /** 上一段结束时的时代快照，用来标 "↑" */
  const lastEra = new Map<string, number>();
  const rows: string[] = [];
  let nextSnap = 0;

  const sideIds = (): PlayerId[] => (ONLY ? [ONLY] : (Object.keys(s.players) as PlayerId[]).slice(0, 2));

  const snap = (): void => {
    const parts: string[] = [];
    for (const p of sideIds()) {
      const cities = s.cities.filter((c) => c.owner === p && !c.ruined);
      const combat = s.units.filter(
        (u) => u.owner === p && s.unitTypes[u.type]?.category === 'combat',
      ).length;
      const econ = s.units.filter(
        (u) => u.owner === p && s.unitTypes[u.type]?.category === 'economy',
      ).length;
      const cityTxt = cities
        .map((c) => {
          const prev = lastEra.get(c.id);
          const up = prev !== undefined && c.era > prev ? `↑${c.era}` : `${c.era}`;
          const n = made.get(c.id) ?? [];
          const spawned = n.length > 0 ? ` 产${n.length}(${n.join(',')})` : '';
          return `${c.id} e${up} hp${Math.round(c.hp)}${spawned}`;
        })
        .join(' · ');
      parts.push(`${p}: 兵${combat} 经${econ} 金${Math.round(s.players[p].gold)} | ${cityTxt}`);
    }
    rows.push(`T${String(s.turn).padStart(3)}  ${parts.join('   ‖   ')}`);
    for (const c of s.cities) lastEra.set(c.id, c.era);
    made.clear();
  };

  snap();
  nextSnap = s.turn + EVERY;
  for (const a of r.actions ?? []) {
    const res = applyAction(s, a as never);
    if (!res.ok) {
      rows.push(`  ! 第 ${s.turn} 回合的 ${a.type} 用不上了：${res.reason ?? ''}`);
      break;
    }
    s = res.state;
    if (a.type === 'RECRUIT' && a.cityId) {
      const list = made.get(a.cityId) ?? [];
      list.push(String(a.unitType ?? '?'));
      made.set(a.cityId, list);
    }
    if (s.turn >= nextSnap) {
      snap();
      nextSnap = s.turn + EVERY;
    }
  }

  console.log(`\n=== ${file} ===`);
  for (const row of rows) console.log(row);
  console.log(`终局：${s.winner ?? '平'}（${s.turn} 回合）`);
}

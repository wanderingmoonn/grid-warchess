/**
 * 重放一局回放，按固定间隔打快照——用来回答"这局为什么变成平局"。
 *
 * 回放只记"做了什么"，看不出"局面怎么走到这里的"。这个脚本从头 `applyAction`
 * 重放一遍，每 N 回合打一行：双方城数/兵力/经济单位/金，外加**经济单位累计移动次数**
 * （让位是否在把农民搬来搬去，一眼能看出来）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/analyze-replay.ts results/replays/a.json results/replays/b.json
 *   ... --every 20       快照间隔（默认 20）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const everyIdx = args.indexOf('--every');
const EVERY = everyIdx >= 0 ? Number(args[everyIdx + 1] ?? 20) : 20;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--every');
if (files.length === 0) {
  console.error('用法：analyze-replay.ts <回放.json> [更多回放…] [--every 20]');
  process.exit(1);
}

interface ReplayAction {
  type: string;
  unitId?: string;
  by?: PlayerId;
  [k: string]: unknown;
}

for (const file of files) {
  const r = JSON.parse(readFileSync(resolve(file), 'utf8')) as {
    seed: number;
    config?: Record<string, unknown>;
    actions?: ReplayAction[];
    winner?: PlayerId | null;
    turns?: number;
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

  /** 单位 → 类型（回放里只有 unitId，类型要在重放时抓） */
  const typeOf = new Map<string, string>();
  /** 每个席位的经济单位累计移动次数 */
  const econMoves: Record<string, number> = { A: 0, B: 0 };
  const rows: string[] = [];
  let nextSnap = 0;

  const snap = (): void => {
    const side = (p: PlayerId): string => {
      const cities = s.cities.filter((c) => c.owner === p && !c.ruined).length;
      const units = s.units.filter((u) => u.owner === p);
      const combat = units.filter((u) => s.unitTypes[u.type]?.category === 'combat').length;
      const econ = units.filter((u) => s.unitTypes[u.type]?.category === 'economy').length;
      return `城${cities}/兵${combat}/经${econ}/金${s.players[p].gold}`;
    };
    rows.push(
      `T${String(s.turn).padStart(3)}  A ${side('A')}   B ${side('B')}   经动 A${econMoves.A}/B${econMoves.B}`,
    );
  };

  snap();
  for (const a of r.actions ?? []) {
    const res = applyAction(s, a as never);
    if (!res.ok) {
      rows.push(`  ! 第 ${s.turn} 回合有个动作用不上了：${a.type}（${res.reason ?? ''}）`);
      break;
    }
    s = res.state;
    // 移动后抓类型：单位可能在这次之前从没出现过（新造的）
    if (a.unitId) {
      const u = s.units.find((z) => z.id === a.unitId);
      if (u) typeOf.set(u.id, u.type);
      if (a.type === 'MOVE' && u && s.unitTypes[u.type]?.category === 'economy') {
        econMoves[u.owner] += 1;
      }
    }
    if (s.turn >= nextSnap) {
      snap();
      nextSnap = s.turn + EVERY;
    }
  }

  console.log(`\n=== ${file} ===`);
  for (const row of rows) console.log(row);
  console.log(
    `终局：${s.winner ?? '平'}（${s.turn} 回合）· 经济单位累计移动 A ${econMoves.A} 次 / B ${econMoves.B} 次`,
  );
}

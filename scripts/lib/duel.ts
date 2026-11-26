/**
 * **兵种对打（标定台用）**——两边同一套打法，只比兵种。
 *
 * 打法：贴身就打（挑血最少的）→ 否则朝最近的敌人走一格 → 走不动就原地结束。
 * 城市在角落、双方 0 金、谁也不造兵（避免"城造兵"把水搅浑）。
 *
 * 为什么要有这个文件：`probe-duel-table`（出表）和 `fit-combat-formula`（拟合公式）都要用，
 * 一份实现两处读——不然"量的东西"和"拟合的东西"会悄悄分叉。
 */
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import { applyAction, attackableTargets, reachableTiles, utype } from '../../src/core/rules.ts';
import type { GameState, PlayerId } from '../../src/core/types.ts';

const man = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export interface FightResult {
  aLeft: number;
  bLeft: number;
  turns: number;
}

export function fight(a: string, b: string, n: number): FightResult {
  let s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 14, startEra: 1, mapStyle: 'open' }, 7);
  s = { ...s, units: s.units.filter((u) => s.unitTypes[u.type]?.category === 'building') };
  for (const [owner, type] of [['A', a], ['B', b]] as Array<[PlayerId, string]>) {
    for (let i = 0; i < n; i++) {
      s.units.push({
        id: `${owner}-${i}`,
        owner,
        type,
        x: owner === 'A' ? 3 + (i % 2) : 10 + (i % 2),
        y: 4 + Math.floor(i / 2),
        hp: utype(s, type).maxHp!,
        moved: false,
        acted: false,
      } as never);
    }
  }
  s = { ...s, current: 'A' as PlayerId };
  const combat = (o: PlayerId) => s.units.filter((u) => u.owner === o && s.unitTypes[u.type]?.category === 'combat');

  for (let turn = 0; turn < 30 && !s.winner; turn++) {
    for (const who of ['A', 'B'] as PlayerId[]) {
      if (s.winner) break;
      for (let step = 0; step < 120; step++) {
        const u = combat(who).find((x) => !x.acted);
        if (!u) break;
        const live = s.units.find((x) => x.id === u.id)!;
        const foes = combat(who === 'A' ? 'B' : 'A');
        if (foes.length === 0) break;
        const tg = attackableTargets(s, live).filter((t) => t.owner !== who);
        if (tg.length > 0) {
          const t = [...tg].sort((x, y) => x.hp - y.hp)[0]!;
          const r = applyAction(s, { type: 'ATTACK', unitId: live.id, targetId: t.id });
          if (r.ok) {
            s = r.state;
            continue;
          }
        }
        const goal = [...foes].sort((x, y) => man(live, x) - man(live, y))[0]!;
        const reach = reachableTiles(s, live);
        let best: { x: number; y: number } | null = null;
        let bd = man(live, goal);
        for (const k of reach.keys()) {
          const x = k % s.w;
          const y = (k - x) / s.w;
          const d = man({ x, y }, goal);
          if (d < bd) {
            bd = d;
            best = { x, y };
          }
        }
        if (best) {
          const r = applyAction(s, { type: 'MOVE', unitId: live.id, x: best.x, y: best.y });
          if (r.ok) {
            s = r.state;
            continue;
          }
        }
        const idx = s.units.findIndex((x) => x.id === live.id);
        if (idx >= 0) s.units[idx] = { ...s.units[idx]!, moved: true, acted: true } as never;
        else break;
      }
      if (!s.winner) {
        const r = applyAction(s, { type: 'END_TURN' });
        if (r.ok) s = r.state;
      }
      if (combat('A').length === 0 || combat('B').length === 0) break;
    }
  }
  return { aLeft: combat('A').length, bLeft: combat('B').length, turns: s.turn };
}

/** 同代陆军战斗单位 */
export function combatOfEra(s: GameState, era: number): string[] {
  return Object.values(s.unitTypes)
    .filter((d) => d.category === 'combat' && (d.domain ?? 'land') !== 'water' && (d.era ?? 1) === era)
    .map((d) => d.id);
}

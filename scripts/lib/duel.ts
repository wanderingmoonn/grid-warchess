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
        /*
         * **① 能白打的一方不冲锋**（2026-11-27 用户定，标定台是地基）。
         *
         * 原打法里所有人都朝最近的敌人冲，于是远程也自己走进贴身——等于把射程优势
         * 白扔掉（trace 实测：弓手第 1 手就"走 6"）。现在：
         *   · 射程 ≥ 2 的单位，先找一个"**还能打到人、但离敌人更远**"的落点，
         *     走上去再打（引擎允许"先走再打"，`doAttack` 才置 `moved`）；
         *   · 找不到就原地打；
         *   · 打不到人的才朝最近敌人走。
         * 这样"射程"才真的换成"白打几轮"，标定出来的数才是兵种强弱，而不是"谁更爱冲"。
         */
        const myRange = utype(s, live.type).range ?? 1;
        const reach = reachableTiles(s, live);
        const canHitFrom = (x: number, y: number): boolean =>
          foes.some((f) => Math.abs(f.x - x) + Math.abs(f.y - y) <= myRange);
        const nearDist = (x: number, y: number): number =>
          Math.min(...foes.map((f) => Math.abs(f.x - x) + Math.abs(f.y - y)));
        const nearest = [...foes].sort((a, b) => man(live, a) - man(live, b))[0]!;

        if (myRange > 1 && man(live, nearest) <= myRange) {
          /* 能打到了：找一个更远、但还能打到的点退过去 */
          let bestKite: { x: number; y: number } | null = null;
          let bestDist = nearDist(live.x, live.y);
          for (const k of reach.keys()) {
            const x = k % s.w;
            const y = (k - x) / s.w;
            const d = nearDist(x, y);
            if (d > bestDist && canHitFrom(x, y)) {
              bestDist = d;
              bestKite = { x, y };
            }
          }
          if (bestKite) {
            const mv = applyAction(s, { type: 'MOVE', unitId: live.id, x: bestKite.x, y: bestKite.y });
            if (mv.ok) {
              s = mv.state;
              continue; /* 走过去之后重新判定（下一步会打） */
            }
          }
        }

        const tg = attackableTargets(s, live).filter((t) => t.owner !== who);
        if (tg.length > 0) {
          const t = [...tg].sort((x, y) => x.hp - y.hp)[0]!;
          const r = applyAction(s, { type: 'ATTACK', unitId: live.id, targetId: t.id });
          if (r.ok) {
            s = r.state;
            continue;
          }
        }
        const goal = nearest;
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

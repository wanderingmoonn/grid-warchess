/**
 * **约束层**：把"要做什么"翻译成"哪几格必须空、哪几个兵归哪队、去打哪座城"。
 *
 * ── 这一层为什么在打分层之前 ────────────────────────────────
 *
 * 直觉是"打分层才是现成资产，先做它"。但 v3 的每一次翻车都在**分数表达不了的约束**上：
 * 桥头要让开、产兵格要让开、城门口要让开——这些"必须"被塞进分数里，于是
 * "让开"和"别送死"互相打折，最后谁也不让。
 *
 * 所以 v4 先把这个工具做对：**必须做的事不参与打分**。
 */
import { utype } from '../rules.ts';
import type { GameState, Unit } from '../types.ts';
import type { Constraints, Decision, Squad } from './types.ts';
import type { World } from './world.ts';

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** 集结点：自家城朝敌方向外挪两格，取一个能站人的空点 */
function assemblePoint(s: GameState, world: World, cityId: string): { x: number; y: number } | undefined {
  const city = s.cities.find((c) => c.id === cityId);
  if (!city) return undefined;
  const foe = world.foeCities[0];
  const dx = foe ? Math.sign(foe.x - city.x) : 1;
  const dy = foe ? Math.sign(foe.y - city.y) : 0;
  const cand = [
    { x: city.x + dx * 2, y: city.y + dy * 2 },
    { x: city.x + dx * 3, y: city.y },
    { x: city.x, y: city.y + dy * 3 },
  ];
  for (const p of cand) {
    if (p.x < 0 || p.y < 0 || p.x >= s.w || p.y >= s.h) continue;
    if (s.units.some((u) => u.x === p.x && u.y === p.y)) continue;
    return p;
  }
  return undefined;
}

/**
 * 把决定翻成约束。
 *
 * 三条铁律：
 *   1. **不把自己人排到 `keepClear` 上**——那是"必须空"的格子，排上去等于自相矛盾；
 *   2. **每个兵最多属于一支队**——v3 的"一兵多队"让两套指令互相覆盖；
 *   3. **守城的兵不出去**——`hold` 是约束，不是"倾向"。
 */
export function constrain(s: GameState, world: World, decision: Decision): Constraints {
  const city = decision.cityId ? s.cities.find((c) => c.id === decision.cityId) : undefined;
  const keepClear = [...world.keepClear];
  const keepSet = new Set(keepClear);

  const squads: Squad[] = [];

  /* 守军：每座受威胁的城留 2 个最近的兵，任务 hold。留谁按"离城近"排，不按分数 */
  const held = new Set<string>();
  for (const info of world.cities) {
    if (info.role !== 'threatened' && info.role !== 'home') continue;
    const guards = world.myCombat
      .filter((u) => !held.has(u.id))
      .sort((a, b) => cheb(a, info.city) - cheb(b, info.city))
      .slice(0, 2);
    for (const g of guards) held.add(g.id);
    if (guards.length > 0) {
      squads.push({
        id: `hold-${info.city.id}`,
        order: 'hold',
        unitIds: guards.map((g) => g.id),
        cityId: info.city.id,
      });
    }
  }

  const rest = world.myCombat.filter((u) => !held.has(u.id) && !keepSet.has(u.y * s.w + u.x));

  if (decision.kind === 'press' && city) {
    squads.push({ id: 'main', order: 'march', unitIds: rest.map((u) => u.id), cityId: city.id });
  } else if (decision.kind === 'defend' && city) {
    /* 守：把外面的兵收回城下（这条和 S-004 那道题是同一件事） */
    squads.push({
      id: 'recall',
      order: 'hold',
      unitIds: rest.map((u) => u.id),
      cityId: city.id,
    });
  } else {
    const at = assemblePoint(s, world, world.myCities[0]?.id ?? '');
    squads.push({ id: 'main', order: 'assemble', unitIds: rest.map((u) => u.id), at });
  }

  /* 造兵：不造经济兵以外的东西时，经济兵不设约束（它们自己站格子产金） */
  const forbid: string[] = [];
  if (decision.kind === 'press') forbid.push('DISBAND');

  return { keepClear, squads, forbid };
}

/** 这个单位属于哪支队（查表；没有任务 = undefined） */
export function taskOf(con: Constraints, unit: Unit): Squad | undefined {
  for (const sq of con.squads) if (sq.unitIds.includes(unit.id)) return sq;
  return undefined;
}

/** 站在 `keepClear` 上的自家单位（打分层要先把它们挪开） */
export function blockers(s: GameState, con: Constraints, world: World): Unit[] {
  const keep = new Set(con.keepClear);
  return s.units.filter(
    (u) => u.owner === world.me && keep.has(u.y * s.w + u.x) && utype(s, u.type).category !== undefined,
  );
}

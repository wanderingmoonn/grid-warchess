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
import { passable } from '../config.ts';
import { utype } from '../rules.ts';
import type { GameState, Unit } from '../types.ts';
import type { Constraints, Decision, Squad, V4Memory } from './types.ts';
import type { World } from './world.ts';

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** 一个单位值多少（身价）：atk + hp + 射程×4，按剩余血量打折。和决定层同一个口径 */
function unitWorth(s: GameState, u: Unit): number {
  const d = utype(s, u.type);
  return ((d.atk ?? 0) + (d.maxHp ?? 0) + (d.range ?? 1) * 4) * (u.hp / Math.max(1, d.maxHp ?? 1));
}

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
 * 让位搬迁计划（多源 BFS）——**思路抄 v3 的 `buildYieldPlan`，代码不抄**。
 *
 * 种子是**所有空格**（能站人的、非城格）。从它们向外扩，穿过自己人算一步
 * （那个人得先让开），敌人和不可通行直接挡死。于是每格都知道了"离最近的洞几步"。
 *
 * 然后对每个被占的关键格：沿 `prev` 倒着走到洞，这条链上的人各朝洞挪一格。
 * 好处是**一回合能清多格**——一个人挪开、后面的人依次递补，而不是一回合只挪一个。
 *
 * v3 那份还带着"谁更急"的分数（urgency）；这里不需要：关键格就是必须空，
 * 不存在"先让哪一格"的问题——链式搬迁天然按距离排好了。
 */
function planYield(
  s: GameState,
  world: World,
  keepClear: number[],
  squads: Squad[],
): Array<{ unitId: string; x: number; y: number }> {
  if (keepClear.length === 0) return [];
  const N = s.w * s.h;
  const dist = new Int32Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  const q: number[] = [];

  for (let k = 0; k < N; k++) {
    const t = s.tiles[k];
    if (!t || t.terrain === 'city') continue;
    if (s.units.some((u) => u.y * s.w + u.x === k)) continue;
    if (!passable(t.terrain)) continue;
    dist[k] = 0;
    q.push(k);
  }

  /* 只往 6 格内扩：洞太远的话，链上的人这一手也走不完，没必要算 */
  const MAX = 6;
  for (let i = 0; i < q.length; i++) {
    const k = q[i]!;
    if (dist[k]! >= MAX) continue;
    const x = k % s.w;
    const y = Math.floor(k / s.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const nk = ny * s.w + nx;
      if (dist[nk]! >= 0) continue;
      const t = s.tiles[nk];
      if (!t || !passable(t.terrain)) continue;
      const occ = s.units.find((u) => u.y * s.w + u.x === nk);
      if (occ && occ.owner !== world.me) continue;
      dist[nk] = dist[k]! + 1;
      prev[nk] = k;
      q.push(nk);
    }
  }

  /*
   * 推进/攻城的兵不算挡路：它们有理由待在那儿（正在过桥）。
   * 只让"没事待着"的单位（经济兵、驻守兵）让开——否则过桥的兵会被自己的规则赶回去，
   * 在桥上来回横跳。
   */
  const passing = new Set<string>();
  for (const sq of squads) {
    if (sq.order !== 'march' && sq.order !== 'siege') continue;
    for (const id of sq.unitIds) passing.add(id);
  }

  const out: Array<{ unitId: string; x: number; y: number }> = [];
  const usedCells = new Set<number>();
  const usedUnits = new Set<string>();

  for (const cell of keepClear) {
    /* 关键格自己得是被自己人占着的，否则没什么可让 */
    const blocker = s.units.find((u) => u.y * s.w + u.x === cell && u.owner === world.me);
    if (!blocker || usedUnits.has(blocker.id) || passing.has(blocker.id)) continue;
    let k = cell;
    /* 沿 prev 往洞的方向倒着走；到不了洞（-1）就算了，这一手不硬挪 */
    const chain: number[] = [];
    let guard = 0;
    while (dist[k]! > 0 && guard++ < 12) {
      k = prev[k]!;
      if (k < 0) break;
      chain.push(k);
    }
    if (chain.length === 0) continue;
    /* 链上第一个空位就是这一手的目标；链上每个单位挪到它前一个的位置（倒序） */
    for (let i = chain.length - 1; i >= 0; i--) {
      const to = chain[i]!;
      const from = i === 0 ? cell : chain[i - 1]!;
      const u = s.units.find((v) => v.y * s.w + v.x === from && v.owner === world.me);
      if (!u || usedUnits.has(u.id) || usedCells.has(to)) continue;
      usedUnits.add(u.id);
      usedCells.add(to);
      out.push({ unitId: u.id, x: to % s.w, y: Math.floor(to / s.w) });
    }
  }
  return out;
}

/**
 * 把决定翻成约束。
 *
 * 三条铁律：
 *   1. **不把自己人排到 `keepClear` 上**——那是"必须空"的格子，排上去等于自相矛盾；
 *   2. **每个兵最多属于一支队**——v3 的"一兵多队"让两套指令互相覆盖；
 *   3. **守城的兵不出去**——`hold` 是约束，不是"倾向"。
 */
export function constrain(s: GameState, world: World, decision: Decision, mem?: V4Memory): Constraints {
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
    const ids = rest.map((u) => u.id);
    /*
     * `want`：打这座城要几个人。
     *
     * 口径是"目标城的守军身价 ÷ 我方平均单位身价 × 1.5"，夹在 4~12。
     * 不按固定配额（v3 试过乘数，三次调参把胜局调成平局），也不按"总兵力比"
     * （v3 的注释：敌方一个兵都看不见时比值反而最大，越是空城越要凑满编）。
     */
    const guard = world.foeCombat.filter((u) => cheb(u, city) <= 6);
    const guardStr = guard.reduce((n, u) => n + unitWorth(s, u), 0);
    const avg = ids.length > 0
      ? ids.reduce((n, id) => {
          const u = s.units.find((x) => x.id === id);
          return n + (u ? unitWorth(s, u) : 0);
        }, 0) / ids.length
      : 1;
    const freshWant = Math.max(4, Math.min(12, Math.round((guardStr / Math.max(1, avg)) * 1.5)));

    /*
     * 成立时定下的 `want` **不因为伤亡而缩**（存进记忆）。
     * 不这样的话，人一死 want 跟着降，队伍就永远"刚好够"，越打越小。
     */
    const memo = mem?.squad;
    const keepWant = memo && memo.cityId === city.id && s.turn - memo.formedAt <= 12 ? memo.want : freshWant;

    /*
     * 出发条件：**两回合内能站到城下的人够不够**，不看"总人数够不够"。
     *
     * 一开始写的是 `人数 >= want`，结果 25 个兵一字长蛇阵也立刻开拔——
     * 人数够不等于队形到齐，先到的几个照样被各个击破（S-002：0 城伤、损失 22）。
     *
     * 现在看 eta80（八成人的行军回合）。这是纯几何判断，不需要记"我等了几回合"。
     */
    const etas = ids
      .map((id) => {
        const u = s.units.find((x) => x.id === id);
        return u ? world.marchTurns(u, city) : Infinity;
      })
      .sort((a, b) => a - b);
    const eta80 = etas[Math.min(etas.length - 1, Math.floor(etas.length * 0.8))] ?? Infinity;
    const eta = etas[etas.length - 1] ?? Infinity;
    /*
     * 够数就走；或者整队已经贴到城下（八成人一步能到）。
     *
     * 试过"两回合内到城下的人 ≥ want"，那样是循环条件：队伍在城外集结，
     * 到不了城下就永远凑不够人出发（S-000 从绿变红、S-005 过河 4→3）。
     */
    const ready = ids.length >= keepWant || eta80 <= 1;
    squads.push({
      id: 'main',
      order: ready ? 'march' : 'assemble',
      unitIds: ids,
      cityId: city.id,
      at: ready ? undefined : assemblePoint(s, world, city.id),
      want: keepWant,
      eta: Number.isFinite(eta) ? eta : 99,
    });
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

  return { keepClear, squads, yieldMoves: planYield(s, world, keepClear, squads), forbid };
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

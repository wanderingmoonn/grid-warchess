/**
 * 探针：经济单位到底有多少"空转"？
 *
 * 用户 2026-11-23 的要求——**空转要定义清楚，不能把"正确的不动"算进去**：
 *
 *   · 已经在最佳生产地形、也没有威胁 → **不动是对的，不算空转**；
 *   · 有威胁却不跑 → **算空转**（失职，可能白死）；
 *   · 不在最佳地形、也没有威胁，却不动 → **算空转**（该找没找）。
 *
 * 所以判据分三类，只有后两类计入空转。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-econ-idle.ts --queue Q3 --seed 30 --side A
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, unitYield, unitYieldAt } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { underConstruction } from '../src/core/query.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

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
const QID = argOf('queue', 'Q3').toUpperCase();
const q = QUEUES[QID];
if (!q) throw new Error(`没有队列 ${QID}`);
const SEED = Number(argOf('seed', '30'));
const SIDE = (argOf('side', 'A').toUpperCase() === 'A' ? 'A' : 'B') as PlayerId;

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

/** 产出的货币化：和 `resourceValue` 同口径（非金资源按库存稀缺加权） */
const valueOf = (yields: Record<string, number | undefined>, owner: PlayerId): number => {
  let sum = 0;
  for (const [id, n] of Object.entries(yields)) {
    const held = id === 'gold' ? s.players[owner].gold : (s.players[owner].res?.[id as 'wood'] ?? 0);
    const w = id === 'gold' ? 1 : 1 + 2 * Math.max(0, Math.min(1, 1 - held / 160));
    sum += (n ?? 0) * w;
  }
  return sum;
};

/** 有没有敌方战斗单位在"下一回合打得到"的范围里（和 AI 的 inDanger 同口径，简化版） */
const underThreat = (u: Unit): boolean => {
  for (const e of s.units) {
    if (e.owner === u.owner) continue;
    const d = s.unitTypes[e.type];
    if (!d || d.category !== 'combat') continue;
    const reach = Math.max(1, d.move ?? 1) + Math.max(0, (d.range ?? 1) - 1);
    if (Math.abs(e.x - u.x) + Math.abs(e.y - u.y) <= reach) return true;
  }
  return false;
};

/**
 * 半径 R 内**走路能到**的格子里，有没有明显更优的地块（+10% 以上）。
 *
 * 三个版本，前两个都错了：
 *   · 第一版只看"目标格空、半径 3 内更优" → 43.9%，把"目标格空但中间被堵"全算成空转；
 *   · 第二版换成 `reachableTiles`（一回合移动力 2 内）→ 2.2%，**又走向另一个极端**：
 *     经济单位要"跋涉"到 4 格外的丘陵，一回合走不到，就永远不算"该动"。
 *     而 `scoreMove` 只比相邻一格，中间几步产出相同（平原 7 vs 平原 7）就没有坡度 ——
 *     这正是用户看到的"长期待在非最佳位置"。
 *
 * 现在用多回合 BFS（不计移动力，只计步数，穿过己方单位，不穿敌人/墙）：
 * 半径 8 内只要有一块明显更好的地，就算"这单位该动"。
 */
const FIELD_R = 8;
const betterTileExists = (u: Unit): boolean => {
  const now = valueOf(unitYield(s, u), u.owner);
  const seen = new Set<number>([u.y * s.w + u.x]);
  let frontier: number[] = [u.y * s.w + u.x];
  for (let step = 0; step < FIELD_R && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const k of frontier) {
      const x = k % s.w;
      const y = Math.floor(k / s.w);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as Array<[number, number]>) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const nk = ny * s.w + nx;
        if (seen.has(nk)) continue;
        const t = s.tiles[nk]!;
        if (!['plain', 'forest', 'hill', 'marsh', 'valley', 'plateau', 'dune'].includes(t.terrain)) continue;
        const occ = s.units.find((z) => z.x === nx && z.y === ny);
        if (occ && occ.owner !== u.owner) continue; // 敌人挡路
        seen.add(nk);
        next.push(nk);
        if (occ) continue; // 己方单位占着的格能过不能站
        /*
         * 要扣掉"走路成本"才算"该动"。
         *
         * 只比产出（+10%）会把"6 格外的 +3 收益"也算成该动——但走 3 回合才回本，
         * 经济上是边际的。移动本身不损失产出（产出看回合开始的位置），
         * 但**路上要花回合**，所以每步按 0.5 金计（和 `ECON_FIELD_LAMBDA` 同口径）。
         */
        const net = valueOf(unitYieldAt(s, u, nx, ny), u.owner) - now - 0.5 * (step + 1);
        if (net > Math.max(0.5, now * 0.1)) return true;
      }
    }
    frontier = next;
  }
  return false;
};

let idleThreat = 0; // 有威胁却没跑
let idleSearch = 0; // 该找地却没找
let shouldMove = 0; // 应动（上面两类之和）
let okStill = 0; // 在最佳地形且无威胁、不动 —— 正确行为
let econTurns = 0; // 经济单位-回合总数
let moved = 0;
/* 这回合我方一共执行了多少动作、其中经济单位的 MOVE 有几个 —— 用来区分"没轮到" */
let totalActs = 0;
let econActs = 0;
let idleButNoAct = 0; // 该动、没动、而且这回合我方压根没给它任何动作
const samples: string[] = [];

while (!s.winner && s.turn <= q.cap) {
  const econAtStart = s.units
    .filter((u) => u.owner === SIDE && s.unitTypes[u.type]?.category === 'economy')
    /* 施工中的单位产出恒为 0（`unitYield` 直接返回空），不动是对的——不能算空转 */
    .filter((u) => !underConstruction(u))
    .map((u) => ({ id: u.id, x: u.x, y: u.y, threat: underThreat(u), better: betterTileExists(u) }));

  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  let econActsThisTurn = 0;
  let actsThisTurn = 0;
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = aiFor(s.current)(s, budget, rejected);
    if (!a) break;
    const r = applyAction(s, a);
    if (r.ok) {
      actsThisTurn += 1;
      if (a.type === 'MOVE' && 'unitId' in a) {
        const uid = String((a as { unitId?: string }).unitId ?? '');
        const z = s.units.find((q) => q.id === uid);
        if (z && z.owner === SIDE && s.unitTypes[z.type]?.category === 'economy') {
          econActsThisTurn += 1;
        }
      }
    }
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
  /*
   * 经济产出快照（每 20 回合）：总产出是"经济单位站得好不好"的**客观**度量，
   * 不依赖任何一版判据——空转率换了三次口径（43.9% / 2.2% / 21.7%），
   * 得出的方向互相矛盾，所以验收要看这个数。
   */
  if (s.turn % 20 === 0) {
    const econ = s.units.filter(
      (u) => u.owner === SIDE && s.unitTypes[u.type]?.category === 'economy' && !underConstruction(u),
    );
    const prod = econ.reduce((a, u) => a + valueOf(unitYield(s, u), SIDE), 0);
    console.log(`  T${String(s.turn).padStart(3)} 经济 ${econ.length} 个 · 总产出 ${prod.toFixed(1)} · 金 ${s.players[SIDE].gold}`);
  }
  totalActs += actsThisTurn;
  econActs += econActsThisTurn;

  for (const e of econAtStart) {
    const u = s.units.find((z) => z.id === e.id);
    if (!u) continue; // 这回合死了，不计
    econTurns += 1;
    const didMove = u.x !== e.x || u.y !== e.y;
    if (didMove) moved += 1;
    const need = e.threat || e.better;
    if (!need) {
      if (!didMove) okStill += 1;
      continue;
    }
    shouldMove += 1;
    if (!didMove && econActsThisTurn === 0) idleButNoAct += 1;
    if (!didMove) {
      if (e.threat) idleThreat += 1;
      else {
        idleSearch += 1;
        if (samples.length < 8) {
          const now = valueOf(unitYield(s, u), u.owner);
          let best = { gain: 0, x: 0, y: 0, d: 0 };
          for (let dy = -5; dy <= 5; dy++) {
            for (let dx = -5; dx <= 5; dx++) {
              if (dx === 0 && dy === 0) continue;
              const x = u.x + dx;
              const y = u.y + dy;
              if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
              const t = s.tiles[y * s.w + x]!;
              if (!['plain', 'forest', 'hill', 'marsh', 'valley', 'plateau', 'dune'].includes(t.terrain)) continue;
              if (s.units.some((z) => z.x === x && z.y === y)) continue;
              const d = Math.abs(dx) + Math.abs(dy);
              // 和判据同口径：扣掉走路成本后的净收益
              const gain = valueOf(unitYieldAt(s, u, x, y), u.owner) - now - 0.5 * d;
              if (gain > best.gain) best = { gain, x, y, d };
            }
          }
          samples.push(
            `T${s.turn} ${u.type}@${u.x},${u.y} 产出 ${now.toFixed(1)} · 最优 ${best.x},${best.y} 距 ${best.d} 增 ${best.gain.toFixed(1)} · 金 ${s.players[SIDE].gold}`,
          );
        }
      }
    }
  }

  const end = applyAction(s, { type: 'END_TURN' });
  if (!end.ok) break;
  s = end.state;
}

const pct = (n: number, d: number): string => (d === 0 ? '-' : `${((n / d) * 100).toFixed(1)}%`);
console.log(
  `${QID} seed=${SEED} 新版坐 ${SIDE} · 终局 ${s.winner ?? '平'}（${s.turn} 回合）`,
);
console.log(`经济单位-回合 ${econTurns} · 动了 ${moved}（${pct(moved, econTurns)}）`);
console.log(
  `应动 ${shouldMove} · 空转 ${idleThreat + idleSearch}（${pct(idleThreat + idleSearch, econTurns)}）` +
    ` = 有威胁没跑 ${idleThreat} + 该找地没找 ${idleSearch}`,
);
console.log(
  `我方动作总数 ${totalActs} · 其中经济单位 MOVE ${econActs}（${pct(econActs, totalActs)}）` +
    ` · 空转里"这回合我方一个经济单位动作都没有"的 ${idleButNoAct} 次`,
);
if (samples.length > 0) {
  console.log('—— 该找地却没找的样本 ——');
  for (const x of samples) console.log('  ' + x);
}
console.log(`不该动也不动 ${okStill}（${pct(okStill, econTurns)}）——这部分是正确行为，不算空转`);

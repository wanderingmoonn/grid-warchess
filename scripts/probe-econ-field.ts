/**
 * 探针：经济单位会不会为了更好的地「跋涉」？
 *
 * 产出距离场（`Fields.econField`）要解决的正是这件事：走位分只比相邻一格，
 * 平原上邻格还是平原 → `gain = 0` → 分数 −1.5 → 永远不入选。
 * 场把「离好地还有几步」折成分数，让中间几步也是正分。
 *
 * 这个探针丢掉整局噪声，只问一个问题：
 *   把一只牧民放在**产出 0 的平原**上、丘陵在几格之外，它会不会走过去？
 * 注意：产出距离场已于 2026-11-23 实测净负回退（见
 * `docs/ANALYSIS-ECON-FIELD-2026-11-23.md`）。这个探针留着，是因为它还能用来
 * 判断「某张图上经济单位到底会不会为了更好的地迁移」——换地图/改移动力时需要重新量。
 *
 * 顺带验证场的两个硬约束（用户 2026-11-23）：
 *   · 后方加成单调递增、有上界；
 *   · 上界小于最小产出差（不能为了「后方」选低产地块）。
 *
 *   node --experimental-strip-types scripts/probe-econ-field.ts [--seed 31] [--type herder]
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, unitYield } from '../src/core/rules.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { DEFAULT_BUDGET } from '../src/core/ai.ts';
import { aiNextAction } from '../src/core/ai-v3.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const SEED = Number(argOf('seed', '31'));
const TYPE = argOf('type', 'herder');
const ME: PlayerId = 'A';
const TURNS = Number(argOf('turns', '8'));

let s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 2, mapSymmetry: 'fair' }, SEED);

/** 产出总量（金当量，和 `resourceValue` 同口径：非金资源按稀缺加权） */
const prodOf = (st: GameState, u: Unit): number => {
  const y = unitYield(st, u);
  let sum = 0;
  for (const [id, n] of Object.entries(y)) {
    const held = id === 'gold' ? st.players[u.owner].gold : (st.players[u.owner].res?.[id as 'wood'] ?? 0);
    const w = id === 'gold' ? 1 : 1 + 2 * Math.max(0, Math.min(1, 1 - held / 160));
    sum += (n ?? 0) * w;
  }
  return sum;
};

s = structuredClone(s);
s.units = s.units.filter((u) => u.owner !== ME);
const city = s.cities.find((c) => c.owner === ME)!;
const W = s.w;
const isLand = (t: string): boolean => t !== 'water' && t !== 'deep' && t !== 'mountain';
/** 先放一只（位置待定）用来算「某个格子对这只兵值多少」 */
const stub = (() => {
  const r = placeUnit(s, ME, TYPE, city.x, city.y + 2);
  if (r.ok) s = r.state;
  const u = s.units.filter((z) => z.owner === ME && z.type === TYPE).at(-1);
  return u;
})();
const at = (): Unit => s.units.find((u) => u.id === stub!.id)!;

/*
 * 落点的三条要求（缺一条这个探针就测不出东西）：
 *
 *   1. **自己不是 0 产出**：0 产出时相邻格通常就有收益，走位分本来就会动
 *      ——第一版把牧民放在产出 2 的林子上，它在基线上也照样走到河边，
 *      测出来「有无距离场一个样」，白跑。
 *   2. **四邻都不比它好**：站在局部最优上，`gain` 恒为 0，基线的分数恒 −1.5。
 *   3. **3~6 格外有块明显更好的地**：这才是场要贡献的那段「看不到的坡度」。
 */
const prodAt = (x: number, y: number): number => {
  const tmp = { ...at(), x, y };
  return prodOf(s, tmp as Unit);
};

let spot: { x: number; y: number } | null = null;
let target: { x: number; y: number; p: number } | null = null;
const terrainAt = (x: number, y: number): number | string => s.tiles[y * W + x]!.terrain;
/** 只走陆地的 BFS：目标是不是走得到（敌人挡路不算，回合开始会挪） */
const pathExists = (sx: number, sy: number, tx: number, ty: number): boolean => {
  const seen = new Set<number>([sy * W + sx]);
  let front = [sy * W + sx];
  for (let step = 0; step < 12 && front.length; step++) {
    const next: number[] = [];
    for (const k of front) {
      const x = k % W;
      const y = Math.floor(k / W);
      if (x === tx && y === ty) return true;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as Array<[number, number]>) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= s.h) continue;
        const nk = ny * W + nx;
        if (seen.has(nk)) continue;
        if (!isLand(s.tiles[nk]!.terrain)) continue;
        seen.add(nk);
        next.push(nk);
      }
    }
    front = next;
  }
  return false;
};
const distToTarget = (x: number, y: number): number =>
  target ? Math.abs(x - target.x) + Math.abs(y - target.y) : -1;
for (let y = 0; y < s.h; y++) {
  for (let x = 0; x < W; x++) {
    const t = s.tiles[y * W + x]!;
    if (!isLand(t.terrain) || t.terrain === 'city') continue;
    if (s.units.some((u) => u.x === x && u.y === y)) continue;
    const here = prodAt(x, y);
    if (here < 3) continue;
    /*
     * 「一回合内够不到更好的地」才算局部最优——**半径用 `def.move`，不是 1**。
     *
     * 走位候选来自 `reachableTiles`，牧民移动力 3，所以 3 格内的好地它直接就能跳过去，
     * 根本不需要坡度。第一版只查了四邻，探针挑出来的「局部最优」里 2 格外的丘陵
     * 本来就被基线的候选覆盖了，于是有无距离场一样，白跑一次。
     */
    const MOVE = s.unitTypes[TYPE]?.move ?? 2;
    let plateau = true;
    for (let dy = -MOVE; dy <= MOVE && plateau; dy++) {
      for (let dx = -MOVE; dx <= MOVE; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > MOVE) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= s.h) continue;
        if (prodAt(nx, ny) > here + 0.5) {
          plateau = false;
          break;
        }
      }
    }
    if (!plateau) continue;
    // 3~6 格外找一块 +3 以上的地
    let best: { x: number; y: number; p: number } | null = null;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < MOVE + 1 || d > MOVE + 3) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= s.h) continue;
        const nt = s.tiles[ny * W + nx]!;
        if (!isLand(nt.terrain)) continue;
        if (s.units.some((u) => u.x === nx && u.y === ny)) continue;
        const p = prodAt(nx, ny);
        if (!best || p > best.p) best = { x: nx, y: ny, p };
      }
    }
    /*
     * 目标必须**走得到**。第一版没查这个：目标格是丘陵、但东边 (2,0) 是水，
     * 场只能把兵带到最近的河边平地——探针却报「离目标 3 格、产出差 6」，
     * 看着像「场没生效」，实际是探针自己找了个不可达的点。
     */
    const reachable = best ? pathExists(x, y, best.x, best.y) : false;
    if (best && reachable && best.p >= here + 3) {
      spot = { x, y };
      target = best;
      break;
    }
  }
  if (spot) break;
}
if (!spot) throw new Error('找不到合适的落点');
if (!spot) throw new Error('找不到合适的落点');

/* 摆到选定落点：直接改坐标（`placeUnit` 是纯函数，这里只需要一个单位） */
{
  const u = at();
  u.x = spot.x;
  u.y = spot.y;
}
console.log(
  `地图 ${s.w}×${s.h} · 城 (${city.x},${city.y}) · ${TYPE} 起点 (${spot.x},${spot.y})[${terrainAt(spot.x, spot.y)}]` +
    ` · 起点产出 ${prodOf(s, at()).toFixed(1)} · 离目标 ${distToTarget(spot.x, spot.y)} 格`,
);
{
  const occ = s.units.find((u) => u.x === target!.x && u.y === target!.y);
  console.log(
    `目标地块 (${target!.x},${target!.y})[${terrainAt(target!.x, target!.y)}] 产出 ${target!.p.toFixed(1)}` +
      `（比起点高 ${(target!.p - prodOf(s, at())).toFixed(1)}）· 占位 ${occ ? `${occ.owner}/${occ.type}` : '空'}`,
  );
}

// 每回合只驱动我方（对手清钱，别让它来打岔）
const drain = (): void => {
  for (const p of Object.keys(s.players) as PlayerId[]) if (p !== ME) s.players[p].gold = 0;
};
const rows: string[] = [];
for (let round = 1; round <= TURNS; round++) {
  while (!s.winner && s.current !== ME) {
    drain();
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  if (s.winner) break;
  const before = at();
  const b = { x: before.x, y: before.y, p: prodOf(s, before) };
  for (let i = 0; i < 40 && !s.winner && s.current === ME; i++) {
    const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set<string>());
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) break;
    s = r.state;
  }
  const now = at();
  rows.push(
    `T${String(round).padStart(2)} 位置 ${b.x},${b.y} → ${now.x},${now.y}` +
      ` · 产出 ${b.p.toFixed(1)} → ${prodOf(s, now).toFixed(1)} · 离目标 ${distToTarget(now.x, now.y)}`,
  );
  if (!s.winner && s.current === ME) {
    const e = applyAction(s, { type: 'END_TURN' });
    if (e.ok) s = e.state;
  }
}
for (const r of rows) console.log(r);

const fin = at();
const p0 = rows.length > 0 ? Number(rows[0]!.split('产出 ')[1]!.split(' →')[0]) : 0;
const p1 = prodOf(s, fin);
console.log('—— 判定 ——');
console.log(`${TYPE} 最终 (${fin.x},${fin.y})[${terrainAt(fin.x, fin.y)}] · 产出 ${p1.toFixed(1)}（起点 ${p0.toFixed(1)}）`);
console.log(
  p1 > p0 + 0.5
    ? `→ **会跋涉**：产出提高 ${(p1 - p0).toFixed(1)}，走了 ${Math.abs(fin.x - spot.x) + Math.abs(fin.y - spot.y)} 格`
    : '→ **停在原地**：产出没提高。这正是「走位分只看相邻一格」的典型形状——' +
      '一回合移动力够不到更好的地时，它没有理由迈第一步。',
);

// 顺带把「后方加成」的两条硬约束打出来（纯数值，不依赖对局）
{
  const rear = (d: number): number => 0.8 * d / (d + 4);
  const seq = [0, 1, 2, 3, 4, 6, 8, 12, 24].map((d) => `${d}格=${rear(d).toFixed(3)}`);
  const monotone = [1, 2, 3, 4, 6, 8, 12, 24].every((d, i, arr) => d === arr[0] || rear(d) >= rear(arr[i - 1]!));
  console.log(`后方加成 ${seq.join(' ')} · 单调递增 ${monotone ? '✓' : '✗'} · 上界 ${rear(1e6).toFixed(2)}（< 最小产出差 1）`);
}

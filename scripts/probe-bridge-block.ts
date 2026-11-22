/**
 * 探针：军队堵住桥点，工程队挤不挤得进去？
 *
 * 为什么要有它（`docs/PLAN-YIELD-2026-11-22.md` 第 0 步）：
 * `bridgeClear` 只罚"**走进**桥点 5×5"，注释里明写"已经在里面不罚"。
 * 所以它只能防新兵靠近，救不了"大军已经堆在桥头"的局——那正是当初
 * Q3/seed30 打 261 回合平的样子。这个探针把"只防不治"从推测变成数字。
 *
 * 构造要点（都要满足，否则测不到东西）：
 *   1. 河是**分段**的：x=5 的 y=3..8 是水，上下用山堵死，所以陆路真不通，
 *      而且桥点被逼落在中间（不会跑到地图角上）；
 *   2. 工人站在距桥点 **5 格**的岸上——造桥半径是 `buildRange(2) + 2 = 4`，
 *      差这一格就意味着"过不去就造不出来"；
 *   3. 我方岸上距桥点 ≤4 格的格子**全部塞满战斗单位**，把通道堵死；
 *   4. 跑 10 回合，看工人能不能挤进去、桥能不能造出来。
 *
 * 判据只看动作与距离。**不断言"必须失败"**——修好之后它应该变绿
 * （工人到位 + 有桥），所以这里只打印结论。
 *
 * 跑法：`npm run probe:bridge-block`
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { CONFIG } from '../src/core/config.ts';
const BUILD_RANGE = CONFIG.buildRange + 2;
import { applyAction } from '../src/core/rules.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { DEFAULT_BUDGET } from '../src/core/ai.ts';
import { aiNextAction } from '../src/core/ai-v3.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const me: PlayerId = 'A';
const W = 12;
const ROUNDS = 10;
const STEPS_PER_TURN = 60;
const WATER_COL = 5;
const WATER_FROM = 3;
const WATER_TO = 8;

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, size: W, startEra: 2, mapSymmetry: 'fair' },
  30,
);
s = structuredClone(s);
s.units = [];

const mine = s.cities.filter((c) => c.owner === me);
const foes = s.cities.filter((c) => c.owner !== me);
if (mine.length === 0 || foes.length === 0) throw new Error('这张图没有双方城市，换种子');
const foeSeat = foes[0]!.owner;

/** 重铺一块 2×2 城格，并把城挪过去 */
function repaintCity(c: (typeof s.cities)[number], x: number, y: number, owner: PlayerId): void {
  c.x = x;
  c.y = y;
  c.owner = owner;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const t = s.tiles[(y + dy) * W + (x + dx)];
      if (!t) continue;
      t.terrain = 'city';
      (t as { cityId?: string }).cityId = c.id;
    }
  }
}

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const t = s.tiles[y * W + x]!;
    t.terrain = 'plain';
    (t as { cityId?: string }).cityId = undefined;
  }
}

/*
 * 双方**各留一座城**，其余直接从 `s.cities` 删掉（连同城格地形）。
 *
 * 为什么不像别的探针那样"都改判给对手"：三座敌城各自产钱，对手会自己造工人、
 * 自己架桥过河（实测第 7 回合它就铺了一格桥面），把"工人被堵"这个观察搅浑。
 * 删到各剩一座是安全的——出局判据是"城全丢"，不是"城少"。
 */
const keepMine = mine[0]!;
const keepFoe = foes[0]!;
const dropped = [...mine.slice(1), ...foes.slice(1)];
for (const c of dropped) {
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const t = s.tiles[(c.y + dy) * W + (c.x + dx)];
      if (t && (t as { cityId?: string }).cityId === c.id) {
        t.terrain = 'plain';
        (t as { cityId?: string }).cityId = undefined;
      }
    }
  }
}
s.cities = s.cities.filter((c) => c.id === keepMine.id || c.id === keepFoe.id);
repaintCity(keepMine, 0, 0, me);
repaintCity(keepFoe, 9, 5, foeSeat);

/*
 * 分段河：中间 6 格是水，上下用山封死。
 * 为什么不用整列水：`crossingPointOf` 取"离对岸最近的水格"，敌城在上方时
 * 整列水会让桥点落到 (5,0) 这种角落，5×5 有一半在图外，摆不出"堵死"的局面。
 */
for (let y = 0; y < W; y++) {
  const t = s.tiles[y * W + WATER_COL]!;
  t.terrain = y >= WATER_FROM && y <= WATER_TO ? 'water' : 'mountain';
}

/*
 * 对手不能有钱。
 *
 * 它有城就有收入，攒到第 7 回合就自己造了工人、在水面铺了一格桥（实测），
 * 把"我方工人被堵"这个观察搅浑。围一圈山也不行——`crossingPointOf` 的
 * "从敌城穿水洪泛"会被山挡住，渡口直接判成不存在。
 * 所以每回合把它的钱清空：它留着一个兵不会出局，但什么也造不了。
 */
const drainFoe = (): void => {
  const p = s.players[foeSeat];
  p.gold = 0;
  if (p.res) for (const k of Object.keys(p.res) as Array<keyof typeof p.res>) p.res[k] = 0;
};

const put = (type: string, x: number, y: number): boolean => {
  const r = placeUnit(s, me, type, x, y);
  if (r.ok) s = r.state;
  return r.ok;
};
if (!put('laborer', 3, 5)) throw new Error('工人放不下，换种子');
/*
 * 计划层（`CROSSING_PLAN.value`）有 `army < 3 → 0` 的闸：兵没凑够就不考虑过河。
 * 这 3 个只为了让计划成立，桥点出来之后会被重新摆过。
 */
for (const [x, y] of [
  [2, 4],
  [2, 6],
  [3, 4],
] as Array<[number, number]>) {
  if (!put('militia', x, y)) throw new Error(`战斗单位放不下 ${x},${y}`);
}

/*
 * 预热阶段**不给钱**。
 *
 * 工人一开始站在 (3,5)，离桥点只有 2 格——有钱它第 1 回合就把桥造出来，
 * 计划随即 `done` 退场、建造编队不再生成，探针就拿不到桥点了（实测踩过：
 * 计划 id 一直是 decisive，渡口有值但没有 build 编队）。
 * 钱等摆好位置之后再给，见下面 `s.players[me].gold = 600`。
 */
s.players[me].gold = 0;
for (const p of Object.keys(s.players) as PlayerId[]) if (p !== me) s.players[p].gold = 0;
/*
 * 对手必须**留一个兵**：钱清零之后"没兵 + 造不起"就是出局条件（`checkWinner`），
 * 对局会在第 1 回合直接判 A 赢，后面什么也测不到。放右下角，10 回合过不来。
 */
const foeUnit = placeUnit(s, foeSeat, 'militia', 8, 11);
if (foeUnit.ok) s = foeUnit.state;

console.log(`地图 ${W}×${W} · 河 x=${WATER_COL}（y ${WATER_FROM}~${WATER_TO}）· 造桥半径 ${BUILD_RANGE}`);

function step(): string | null {
  const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
  if (!a) return null;
  const r = applyAction(s, a);
  if (!r.ok) return `非法:${a.type}:${r.reason ?? ''}`;
  s = r.state;
  const xy = 'x' in a ? `→${(a as { x: number }).x},${(a as { y: number }).y}` : '';
  return `${a.type}${xy}`;
}

/** 跑完一轮（每个席位各走一次，回到我方）。只看当前席位会误判成"我方没动作" */
function playRound(collect?: string[]): number {
  let moves = 0;
  let guard = 0;
  while (!s.winner && s.current !== me && guard++ < 6) {
    /*
     * 清账要放在**对手回合开始之前**。放在 END_TURN 之前没用：它在自己回合里
     * 拿到收入就当场花了（实测第 9 回合还是把桥铺到了桥点上）。
     */
    drainFoe();
    for (let i = 0; i < STEPS_PER_TURN; i++) {
      const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      if (a.type === 'MOVE') moves += 1;
    }
    drainFoe();
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  if (s.winner || s.current !== me) return moves;
  for (let i = 0; i < STEPS_PER_TURN && !s.winner; i++) {
    const a = step();
    if (!a) break;
    collect?.push(a);
    if (a.startsWith('MOVE')) moves += 1;
  }
  if (!s.winner) {
    drainFoe();
    const e = applyAction(s, { type: 'END_TURN' });
    if (e.ok) s = e.state;
  }
  return moves;
}

/** 从建造编队读桥点：不自己猜 `bestBridgeSite`，免得探针和 AI 口径不一致 */
function bridgePointOf(st: GameState): { x: number; y: number } | null {
  const focus = (st.aiFocus as Record<string, { squads?: Array<{ role?: string; targetPoint?: { x: number; y: number } | null }> } | undefined>)?.[me];
  const b = (focus?.squads ?? []).find((q) => q.role === 'build');
  return b?.targetPoint ?? null;
}

let site: { x: number; y: number } | null = null;
for (let round = 1; round <= 5 && !site; round++) {
  playRound();
  site = bridgePointOf(s);
  const f = (s.aiFocus as Record<string, { plan?: { id?: string; keep?: Record<string, unknown> }; squads?: Array<{ role?: string }> }> | undefined)?.[me];
  const keep = f?.plan?.keep ?? {};
  console.log(
    `  预热 ${round}：turn ${s.turn} · 计划 ${f?.plan?.id ?? '-'} · 渡口 ${JSON.stringify(keep.crossingSite ?? null)} · 编队 ${(f?.squads ?? []).map((q) => q.role).join(',') || '-'}`,
  );
}
if (!site) {
  console.log('✗ 计划层没给出桥点——探针前提（needBridge + army≥3）没成立，换种子/换图');
  process.exit(1);
}
console.log('桥点', site.x + ',' + site.y);

/*
 * 正式摆位：工人退到距桥点 5 格（差一步就够不到），战斗单位铺满我方岸上
 * 距桥点 ≤4 格的所有格子。这一步是**直接改坐标**，不是让 AI 走过去——
 * 要测的就是"已经堵住之后能不能解开"。
 */
s = structuredClone(s);
s.units = s.units.filter((u) => !(u.owner === me && s.unitTypes[u.type]?.category === 'combat'));
const worker = s.units.find((u) => u.owner === me && u.type === 'laborer');
if (!worker) throw new Error('工人没了');
worker.x = Math.max(0, site.x - 5);
worker.y = site.y;

const cells: Array<{ x: number; y: number; d: number }> = [];
for (let y = 1; y < W - 1; y++) {
  for (let x = 1; x < site.x; x++) {
    const t = s.tiles[y * W + x];
    if (!t || t.terrain !== 'plain') continue;
    if (x === worker.x && y === worker.y) continue;
    const d = Math.max(Math.abs(x - site.x), Math.abs(y - site.y));
    if (d > 4) continue;
    if (s.units.some((u) => u.x === x && u.y === y)) continue;
    cells.push({ x, y, d });
  }
}
cells.sort((a, b) => a.d - b.d);
/*
 * 全部塞满，不设上限：12 个时工人能从没堵到的 d=4 格（它身边那一格）直接跨过去，
 * 第 1 回合就走到 3 格内——那不叫"堵死"，只是"路上有点挤"。
 */
let placed = 0;
for (const c of cells) {
  if (put('militia', c.x, c.y)) placed += 1;
}
console.log(`工人 (${worker.x},${worker.y}) · 塞入战斗单位 ${placed} 个（我方岸上距桥点 ≤4 格）`);

/*
 * 摆好之后再给钱：要区分"挤不进去"和"挤进去了但没钱造桥"。
 * 预算给足（600），免得修好之后工人到位却造不出桥，被误判成"还是堵着"。
 * 兵已经 35 个，采购不会再造出什么来；对手每回合清零。
 */
s.players[me].gold = 600;

const inClear = (): number =>
  s.units.filter((u) => {
    if (u.owner !== me || s.unitTypes[u.type]?.category !== 'combat') return false;
    return Math.abs(u.x - site!.x) <= 2 && Math.abs(u.y - site!.y) <= 2;
  }).length;
const workerDist = (): number => {
  const b = s.units.find((u) => u.owner === me && u.type === 'laborer');
  return b ? Math.max(Math.abs(b.x - site!.x), Math.abs(b.y - site!.y)) : 999;
};
/*
 * 桥建筑按 type 名前缀认。不用 `s.unitTypes[u.type]?.bridges`：
 * `s.unitTypes` 是"这一局启用的兵种表"，桥这类建筑不在里面，
 * 查出来恒为 0——第一版就是这么把"造出桥了"漏成"没造出来"的。
 */
const bridgeCount = (): number =>
  s.units.filter((u) => u.owner === me && u.type.startsWith('bridge')).length;
const bridgeTiles = (): number => s.tiles.filter((t) => t.terrain === 'bridge').length;
/** 工人 8 邻格里能站的空格数：0 = 物理上寸步难行，而不是"它不想动" */
const freeAroundWorker = (): number => {
  const b = s.units.find((u) => u.owner === me && u.type === 'laborer');
  if (!b) return 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = b.x + dx;
      const y = b.y + dy;
      if (x < 0 || y < 0 || x >= W || y >= W) continue;
      const t = s.tiles[y * W + x]!;
      if (t.terrain === 'water' || t.terrain === 'mountain' || t.terrain === 'city') continue;
      if (s.units.some((z) => z.x === x && z.y === y)) continue;
      n += 1;
    }
  }
  return n;
};
const dist0 = workerDist();
const clear0 = inClear();

console.log(
  `起始：工人距桥点 ${dist0}（造桥需要 ≤${BUILD_RANGE}）· 5×5 内战斗单位 ${inClear()} · 桥 ${bridgeCount()} · 桥面 ${bridgeTiles()} · 工人身边空格 ${freeAroundWorker()}`,
);

const rows: string[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  const before = { dist: workerDist(), clear: inClear(), bridge: bridgeCount() };
  let moves = 0;
  let guard = 0;
  while (!s.winner && s.current !== me && guard++ < 6) {
    /*
     * 清账要放在**对手回合开始之前**。放在 END_TURN 之前没用：它在自己回合里
     * 拿到收入就当场花了（实测第 9 回合还是把桥铺到了桥点上）。
     */
    drainFoe();
    for (let i = 0; i < STEPS_PER_TURN; i++) {
      const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    drainFoe();
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  if (s.winner) {
    rows.push(`回合 ${round}：终局 ${s.winner} 胜（探针被对局结束打断，这一轮不算）`);
    break;
  }
  for (let i = 0; i < STEPS_PER_TURN; i++) {
    const a = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) break;
    s = r.state;
    if (a.type === 'MOVE') moves += 1;
  }
  rows.push(
    `回合 ${round}：MOVE ${moves} · 工人距 ${before.dist}→${workerDist()} · 身边空格 ${freeAroundWorker()} · 5×5 内 ${before.clear}→${inClear()} · 桥 ${before.bridge}→${bridgeCount()} · 桥面 ${bridgeTiles()} · 我方建筑 ${s.units
      .filter((u) => u.owner === me && s.unitTypes[u.type]?.category === 'building')
      .map((u) => `${u.type}@${u.x},${u.y}`)
      .join(' ') || '无'} · 场上桥 ${s.units.filter((u) => u.type.startsWith('bridge')).map((u) => `${u.owner}:${u.type}@${u.x},${u.y}`).join(' ') || '无'}`,
  );
  if (!s.winner) {
    drainFoe();
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
}
for (const r of rows) console.log(r);
const bridgeCells = s.tiles
  .map((t, i) => (t.terrain === 'bridge' ? `${i % W},${Math.floor(i / W)}` : null))
  .filter((z): z is string => z !== null);
if (bridgeCells.length > 0) console.log('桥面坐标:', bridgeCells.join(' '), '（我方桥建筑', bridgeCount(), '座）');

// ── 结论 ──
const finalDist = workerDist();
const reached = finalDist <= BUILD_RANGE;
/* 比"5×5 内还有几个"，不是比"塞了多少"——塞进去的 35 个里只有 10 个在 5×5 内 */
const cleared = inClear() < clear0;
const built = bridgeCount() > 0;
console.log('—— 判定 ——');
console.log(
  `工人靠近到能造桥的距离 ${reached ? '✓ 到了' : '✗ 没到'}（${dist0} → ${finalDist}，门槛 ≤${BUILD_RANGE}）`,
);
console.log(`军队让出 5×5 ${cleared ? '✓ 撤了' : '✗ 一个没走'}（${clear0} → ${inClear()}）`);
console.log(`桥 ${built ? '✓ 造出来了' : '✗ 一座没有'}`);
if (reached && built) {
  console.log('→ 这一局能自己解开（软惩罚/走位评分够用）');
} else if (!reached) {
  console.log('→ **堵死确认**：工人挤不进造桥半径，`bridgeClear` 只防"走进"，对"已在里面"无效');
} else {
  console.log('→ 工人到了但没造出来——钱/建筑前置的问题，不是让位问题');
}

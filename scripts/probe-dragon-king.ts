/**
 * 邪龙王行为实验（阶段 3）。
 *
 * ── 它回答什么 ──────────────────────────────────────────────────────
 *
 * 1. 不挂任何东西时，AI 手里的邪龙王怎么打？（基线）
 * 2. 挂上"先下蛋、在射程外游弋、魔龙够了再出击"之后，它变了吗？
 * 3. 卵孵出来的魔龙会不会主动往王身边靠？
 *
 * ── 为什么用受控小局面 ──────────────────────────────────────────────
 *
 * 第一版用的是真对局（两座城 + 完整军队），结果两档逐字相同。查下来发现
 * **不是机制没生效**（提案确实被采纳了，日志对得上），而是我写的规格有问题：
 * "贴着射程外 1~2 格"和全局 AI 的"推进"落在同一个位置，两种行为看起来一样。
 *
 * 所以换成一张空场：B 方只有一条邪龙王，A 方三个民兵在 11 格外。
 * "往前拱"和"停在射程外"是两条完全不同的轨迹，一眼能看出来。
 *
 * ── 怎么读结果 ──────────────────────────────────────────────────────
 *
 * · "最近敌" = 王到最近敌人的格数；"余量" = 最近敌 − 对方射程，
 *   > 0 表示对方这一回合打不到它。
 * · 基线应该把距离一路压到 4（它的射程）然后开打；
 *   挂行为的应该停在 7~9 格、反复下蛋，等魔龙够了才往前压。
 *
 * 用法：node --experimental-strip-types scripts/probe-dragon-king.ts [--turns 14]
 */

import { DEFAULT_BUDGET, aiNextAction, aiStallGuard, aiProgressFingerprint } from '../src/core/ai.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { registerUnitAiProfile } from '../src/core/unit-ai.ts';
import type { Action, GameState, PlayerId, Unit } from '../src/core/types.ts';
import type { UnitAiCtx, UnitAiCandidate, UnitAiResult } from '../src/core/expansions.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const TURNS = Math.max(4, Number(argOf('turns', '20')));
const KING = 'evil-dragon-king';
const DRAGON = 'magic-dragon';
const EGG = 'dragon-egg';
/** 几条魔龙才算"够了，可以出击" */
const NEED_DRAGONS = 2;
/**
 * 游弋带：想让王停在"离最近敌人 7~9 格"这一段。
 *
 * 为什么是 7~9：王的射程 4、视野 11、卵的射程 11。7~9 意味着
 * 它打不到人（4 < 7）、人也打不到它（民兵射程 1~3），但卵放得出去——
 * 这就是"躲在后面下蛋"的形状。**别写成 1~2**：那不是游弋，是贴着人家脸站着。
 */
const HOVER_NEAR = 7;
const HOVER_FAR = 9;

const CONFIG = {
  ...DEFAULT_CONFIG,
  size: 16,
  startEra: 3,
  aiLevel: 'advanced' as const,
  aiAlly: true,
  aiOpponent: true,
  expansionIds: [
    ...DEFAULT_CONFIG.expansionIds,
    'fantasy-core',
    'fantasy-heroes',
    'pack-contemporary',
  ],
};

/* ── 小工具（只读） ───────────────────────────────────────────────── */

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const foesOf = (s: GameState, owner: PlayerId): Unit[] =>
  s.units.filter((u) => u.owner !== owner && u.hp > 0);

const ownOf = (s: GameState, owner: PlayerId, type: string): Unit[] =>
  s.units.filter((u) => u.owner === owner && u.type === type && u.hp > 0);

/** 离最近敌人还有多少格（没有敌人时给 Infinity） */
function nearestFoe(s: GameState, owner: PlayerId, at: { x: number; y: number }): number {
  const foes = foesOf(s, owner);
  if (foes.length === 0) return Infinity;
  return Math.min(...foes.map((f) => dist(f, at)));
}

/** 余量 = 最近敌距 − 对方射程。>0 = 这一回合打不到它 */
function marginAt(s: GameState, owner: PlayerId, x: number, y: number): number {
  let best = Infinity;
  for (const f of foesOf(s, owner)) {
    const reach = s.unitTypes[f.type]?.range ?? 1;
    best = Math.min(best, dist({ x, y }, f) - reach);
  }
  return best;
}

/** 脚下出发、最多走 steps 步能到的格子（四向，含脚下） */
function reachable(c: UnitAiCtx, steps: number): Array<{ x: number; y: number; d: number }> {
  const start = { x: c.unit.x, y: c.unit.y, d: 0 };
  const seen = new Map<string, { x: number; y: number; d: number }>([[`${start.x},${start.y}`, start]]);
  let frontier = [start];
  for (let i = 0; i < steps; i += 1) {
    const next: typeof frontier = [];
    for (const p of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = p.x + dx;
        const y = p.y + dy;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        if (!c.api.canStandAt(c.state, x, y, c.unit.type)) continue;
        const node = { x, y, d: p.d + 1 };
        seen.set(key, node);
        next.push(node);
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}

/* ── 行为 A：邪龙王 ─────────────────────────────────────────────── */
registerUnitAiProfile({
  id: 'dragon-hover',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const foes = foesOf(c.state, c.unit.owner);
    const dragons = ownOf(c.state, c.unit.owner, DRAGON).length;

    /*
     * 下蛋排在最前：不看冷却（规则会拒，被拒后进 rejected，不会反复提），
     * 120 分压着"一记普攻 ≈ 89"给——蛋优先于普攻，但不至于抢掉补刀。
     */
    add.push({
      action: { type: 'HERO_SKILL', unitId: c.unit.id, skillId: 'dragon-egg' },
      score: 120,
    });

    if (foes.length === 0) return { add };
    // 魔龙够了 → 不再干预，让全局 AI 把它推上去（这就是"主动出击"）
    if (dragons >= NEED_DRAGONS) return { add };

    /*
     * 魔龙不够 → 拉到射程外游弋。
     *
     * 必须**主动提一个走位**：全局 AI 每一步都想往前拱，光是"不提意见"
     * 等于让它自己走上去。给 150 分才压得住那条约 6 分/步的推进。
     *
     * 选点口味：离最近敌人 7~9 格（见 HOVER_NEAR / HOVER_FAR），
     * 在带子里再挑"最靠近敌人"的那一格——贴着带子内侧，随时能补一发卵。
     */
    const here = nearestFoe(c.state, c.unit.owner, c.unit);
    if (here >= HOVER_NEAR && here <= HOVER_FAR) return { add }; // 已经在带子里，别动
    const tiles = reachable(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (const p of tiles) {
      const near = nearestFoe(c.state, c.unit.owner, p);
      // 不在带子里就扣分，越远扣越多；在带子里则越近越好
      const off = near < HOVER_NEAR ? HOVER_NEAR - near : near > HOVER_FAR ? near - HOVER_FAR : 0;
      const score = -off * 10 - near * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) {
      add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 150 });
    }
    return { add };
  },
});

/* ── 行为 B：魔龙。离王远了就回去，贴着王就替他挡 ───────────────── */
registerUnitAiProfile({
  id: 'dragon-guard',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const king = ownOf(c.state, c.unit.owner, KING)[0];
    if (!king) return {};
    const add: UnitAiCandidate[] = [];
    const toKing = dist(c.unit, king);

    if (toKing <= 3) {
      const range = c.def.range ?? 1;
      const kingRange = c.state.unitTypes[king.type]?.range ?? 1;
      const threat = foesOf(c.state, c.unit.owner)
        .filter((f) => dist(f, king) <= kingRange + 1)
        .filter((f) => dist(f, c.unit) <= range)
        .sort((a, b) => a.hp - b.hp)[0];
      if (threat) {
        add.push({
          action: { type: 'ATTACK', unitId: c.unit.id, targetId: threat.id },
          score: 150,
        });
      }
      return { add };
    }

    /*
     * 回去：120 分要**高于一记普攻（≈89）**，否则它会一直在前线打人、
     * 永远不回来——"默认保护邪龙王"就不成立了。
     */
    const tiles = reachable(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
    let best: { x: number; y: number } | null = null;
    let bestD = toKing;
    for (const p of tiles) {
      const d = dist(p, king);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) {
      add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 120 });
    }
    return { add };
  },
});

/* ── 一局 ─────────────────────────────────────────────────────────── */

interface Row {
  turn: number;
  pos: string;
  hp: number;
  minFoe: number;
  margin: number;
  eggs: number;
  dragons: number;
  dragonGap: number;
  acts: Record<string, number>;
}

interface Run {
  rows: Row[];
  eggsCast: number;
  dragonPeak: number;
  kingAlive: boolean;
  winner: PlayerId | null;
}

function play(arm: 'baseline' | 'hover'): Run {
  let s: GameState = createMatch(CONFIG, 4242);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.players.A.gold = 0;
  s.players.B.gold = 0;
  for (let y = 0; y < s.h; y += 1) {
    for (let x = 0; x < s.w; x += 1) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
  }
  /*
   * **不能把城清空**：没有城的席位在第一帧就被判出局（2026-11-15 踩过一次），
   * 那样整局立刻结束，一行数据都采不到。
   * 所以两家各留一座城，摆在对角——它们的"家"在，但战场在中间。
   */
  s.cities = [
    { id: 'ca', owner: 'A', x: 2, y: 2, size: 2, era: 3, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 12, y: 12, size: 2, era: 3, hp: 70, maxHp: 70, armor: 4 },
  ];
  for (const c of s.cities) {
    for (let dy = 0; dy < c.size; dy += 1) {
      for (let dx = 0; dx < c.size; dx += 1) {
        s.tiles[(c.y + dy) * s.w + (c.x + dx)] = { terrain: 'city', cityId: c.id };
      }
    }
  }
  const mk = (id: string, type: string, owner: PlayerId, x: number, y: number): void => {
    const u: Unit = {
      id,
      type,
      owner,
      x,
      y,
      hp: s.unitTypes[type]!.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    };
    s.units.push(u);
  };
  /*
   * 对手用"木桩"而不是真兵：这一局要看的是**邪龙王怎么动**，
   * 不是谁打死谁。真兵（民兵 28 血、骑士 60 血）会被一发陨卵（约 30 魔法伤害）
   * 打成灰，战斗 5 个回合就结束，魔龙还没来得及孵出来。
   *
   * 木桩：600 血、攻 2（打不动 8 甲的王）、移动 1，够它慢慢挪过来当靶子。
   */
  s.unitTypes['probe-dummy'] = {
    ...s.unitTypes['knight']!,
    id: 'probe-dummy',
    name: '木桩',
    maxHp: 600,
    atk: 2,
    armor: 10,
    move: 1,
    range: 1,
    vision: 4,
  };
  mk('king-0', KING, 'B', 8, 13);
  mk('foe-0', 'probe-dummy', 'A', 8, 2);
  mk('foe-1', 'probe-dummy', 'A', 7, 3);
  mk('foe-2', 'probe-dummy', 'A', 9, 3);
  s.current = 'A';
  s.turn = 1;

  if (arm === 'hover') {
    const k = s.unitTypes[KING]!;
    k.aiAutonomy = 1;
    k.aiProfile = 'dragon-hover';
    const d = s.unitTypes[DRAGON]!;
    d.aiAutonomy = 1;
    d.aiProfile = 'dragon-guard';
  }

  const rows: Row[] = [];
  let eggsCast = 0;
  let dragonPeak = 0;

  while (!s.winner && s.turn <= TURNS) {
    const side = s.current;
    /*
     * 每回合开账前把金币清零：这一局要看的是**这两个兵怎么动**，
     * 不是"谁先造出第三个兵"。有钱的话两家会各自补兵，兵线一乱，
     * 前面的轨迹就不可比了。
     */
    s.players.A.gold = 0;
    s.players.B.gold = 0;
    const acts: Record<string, number> = {};
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    const guard = aiStallGuard();
    const cap =
      8 +
      6 * s.units.filter((u) => u.owner === side).length +
      6 * s.cities.filter((c) => c.owner === side).length;
    let rejects = 0;

    for (let steps = 0; steps < cap; steps += 1) {
      const action: Action | null = aiNextAction(s, budget, rejected);
      if (!action) break;
      const r = applyAction(s, action);
      if (!r.ok) {
        rejected.add(JSON.stringify(action));
        rejects += 1;
        if (rejects > 12) break;
        continue;
      }
      rejects = 0;
      rejected.clear();
      if ((action as { unitId?: string }).unitId === 'king-0') {
        acts[action.type] = (acts[action.type] ?? 0) + 1;
        if (action.type === 'HERO_SKILL') eggsCast += 1;
      }
      s = r.state;
      if (s.winner) break;
      if (guard.note(JSON.stringify(action), aiProgressFingerprint(s))) break;
    }

    const king = s.units.find((u) => u.id === 'king-0');
    const eggs = ownOf(s, 'B', EGG).length;
    const dragons = ownOf(s, 'B', DRAGON).length;
    dragonPeak = Math.max(dragonPeak, dragons);
    const gap =
      dragons > 0 && king
        ? ownOf(s, 'B', DRAGON).reduce((n, d) => n + dist(d, king), 0) / dragons
        : NaN;

    if (process.env.DBG) {
      console.log('   [dbg] turn', s.turn, 'side', side, 'winner', s.winner,
        'units', s.units.map((u) => `${u.owner}:${u.type.split('-')[0]}:${u.hp}`).join(' '),
        'cities', s.cities.map((c) => `${c.id}:${c.owner}`).join(' '));
    }
    if (side === 'B') {
      rows.push({
        turn: s.turn,
        pos: king ? `${king.x},${king.y}` : '—',
        hp: king?.hp ?? 0,
        minFoe: king ? Math.round(nearestFoe(s, 'B', king) * 10) / 10 : NaN,
        margin: king ? Math.round(marginAt(s, 'B', king.x, king.y) * 10) / 10 : NaN,
        eggs,
        dragons,
        dragonGap: Math.round(gap * 10) / 10,
        acts,
      });
    }

    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
  }

  return {
    rows,
    eggsCast,
    dragonPeak,
    kingAlive: !!s.units.find((u) => u.id === 'king-0'),
    winner: s.winner ?? null,
  };
}

/* ── 打表 ─────────────────────────────────────────────────────────── */

const pad = (x: unknown, n = 6): string => String(x).padEnd(n);
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

console.log('邪龙王行为实验（空场：王在南、三个民兵在北）\n');
const runs: Record<string, Run> = { baseline: play('baseline'), hover: play('hover') };

for (const [name, run] of Object.entries(runs)) {
  console.log(`── ${name} ──────────────────────────────`);
  console.log(
    `  ${pad('回合')}${pad('位置', 8)}${pad('血', 6)}${pad('最近敌', 8)}${pad('余量', 7)}${pad('卵', 5)}${pad('魔龙', 6)}${pad('龙离王', 8)}动作`,
  );
  for (const r of run.rows) {
    const acts = Object.entries(r.acts).map(([k, v]) => `${k}×${v}`).join(' ') || '—';
    console.log(
      `  ${pad(r.turn)}${pad(r.pos, 8)}${pad(r.hp)}${pad(r.minFoe, 8)}${pad(r.margin, 7)}` +
        `${pad(r.eggs, 5)}${pad(r.dragons, 6)}${pad(r.dragonGap, 8)}${acts}`,
    );
  }
  console.log(
    `  小结：下蛋 ${run.eggsCast} 次 · 魔龙峰值 ${run.dragonPeak} · ` +
      `王${run.kingAlive ? '还活着' : '死了'} · 胜者 ${run.winner ?? '未决'}\n`,
  );
}

const b = runs.baseline!;
const h = runs.hover!;
const stat = (r: Run, f: (x: Row) => number): string => {
  const xs = r.rows.map(f).filter((x) => Number.isFinite(x));
  return xs.length ? avg(xs).toFixed(1) : '—';
};

console.log('── 对比 ──────────────────────────────');
console.log(`  王离最近敌人的平均距离：基线 ${stat(b, (r) => r.minFoe)} → 挂行为 ${stat(h, (r) => r.minFoe)} 格`);
console.log(`  平均"余量"（>0 表示对方打不到它）：基线 ${stat(b, (r) => r.margin)} → 挂行为 ${stat(h, (r) => r.margin)}`);
console.log(`  下蛋次数：基线 ${b.eggsCast} → 挂行为 ${h.eggsCast}`);
console.log(`  魔龙峰值：基线 ${b.dragonPeak} → 挂行为 ${h.dragonPeak}`);
console.log(`  魔龙离王的平均距离：基线 ${stat(b, (r) => r.dragonGap)} → 挂行为 ${stat(h, (r) => r.dragonGap)}`);

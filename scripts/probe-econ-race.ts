/**
 * 开局经济赛跑：v3 和 v1 在同一张图上，谁先把经济铺起来。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 *
 * 用户 2026-11-22 的观察：v3 经济只比 v1 强一点，而人类能强很多；
 * 回放里 v3 开局"判断对面没兵 → 全军出击"，直到看见敌军才转向发展。
 *
 * 光看胜率看不出这件事——胜负被后期决战盖住了。这个探针只量**前 40 回合**：
 *   · 收入曲线、经济单位数、兵力数；
 *   · 首次交战回合（谁先动手）；
 *   · "经济起飞"回合（经济单位第一次到 3 个）。
 *
 * A 席跑 v3（`src/core/ai-v3.ts`），B 席跑冻结基线（`baselines/ai-9efb961.ts`），
 * 和 `bench:ai` 同对手，数据才能和既有跑批对齐。
 *
 * 用法：
 *   npm run probe:econ-race                     # 四条用例
 *   npm run probe:econ-race -- --case Q2        # 只跑一条
 *   npm run probe:econ-race -- --every 1        # 每回合都采（默认 2）
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, incomeOf, unitsOf, utype } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { aiNextAction as v3 } from '../src/core/ai-v3.ts';
import { aiNextAction as v1 } from './baselines/ai-9efb961.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const EVERY = Math.max(1, Number(argOf('every', '2')));
const ONLY = argOf('case', '').toUpperCase();
/** `--econ-cap`：打开"经济上限按地块容量"，和经济铺满的局对照 */
const ECON_CAP = process.argv.includes('--econ-cap');
const THREAT = process.argv.includes('--threat');
const LIMIT = Number(argOf('turns', '40'));

interface Case {
  id: string;
  size: number;
  era: number;
  cap: number;
  seeds: number[];
}
const CASES: Case[] = [
  { id: 'Q1', size: 12, era: 2, cap: 200, seeds: [30] },
  { id: 'Q2', size: 16, era: 3, cap: 220, seeds: [30] },
  { id: 'Q3', size: 24, era: 2, cap: 260, seeds: [30] },
  { id: 'Q4', size: 24, era: 4, cap: 260, seeds: [30] },
];

interface Snap {
  turn: number;
  gold: number;
  income: number;
  econ: number;
  army: number;
  /** 战斗单位到最近自家城的平均距离：越大 = 越往前压 */
  push: number;
  /** 距家 ≤3 的战斗单位数（守家的） */
  home: number;
}
interface Side {
  snaps: Snap[];
  firstFight: number | null;
  econTakeoff: number | null;
}

const econCount = (s: GameState, p: PlayerId): number =>
  unitsOf(s, p).filter((u) => utype(s, u.type).category === 'economy').length;
const combatUnits = (s: GameState, p: PlayerId) =>
  unitsOf(s, p).filter((u) => {
    const d = utype(s, u.type);
    return d.category === 'combat' && d.domain !== 'water';
  });
const armyCount = (s: GameState, p: PlayerId): number => combatUnits(s, p).length;

/** 前压程度：战斗单位到最近自家城的平均切比雪夫距离 */
function pushOf(s: GameState, p: PlayerId): { push: number; home: number } {
  const own = s.cities.filter((c) => c.owner === p && !c.ruined);
  if (own.length === 0) return { push: 0, home: 0 };
  const list = combatUnits(s, p);
  if (list.length === 0) return { push: 0, home: 0 };
  let sum = 0;
  let home = 0;
  for (const u of list) {
    const d = Math.min(...own.map((c) => Math.max(Math.abs(u.x - c.x), Math.abs(u.y - c.y))));
    sum += d;
    if (d <= 3) home += 1;
  }
  return { push: sum / list.length, home };
}

function playOne(c: Case, seed: number): { A: Side; B: Side; winner: PlayerId | null; turn: number } {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      startEra: c.era,
      aiLevel: 'tactic',
      size: c.size,
      mapSymmetry: 'fair',
      ...(ECON_CAP ? { aiEconCap: true } : {}),
      ...(THREAT ? { aiThreatScale: true } : {}),
    },
    seed,
  );
  const mk = (): Side => ({ snaps: [], firstFight: null, econTakeoff: null });
  const A = mk();
  const B = mk();
  const of = (p: PlayerId): Side => (p === 'A' ? A : B);
  let lastTurn = -1;

  const sample = (): void => {
    for (const p of ['A', 'B'] as PlayerId[]) {
      const side = of(p);
      const econ = econCount(s, p);
      const { push, home } = pushOf(s, p);
      side.snaps.push({
        turn: s.turn,
        gold: s.players[p].gold,
        income: incomeOf(s, p),
        econ,
        army: armyCount(s, p),
        push,
        home,
      });
      if (side.econTakeoff === null && econ >= 3) side.econTakeoff = s.turn;
    }
  };

  while (!s.winner && s.turn <= c.cap) {
    if (s.turn <= LIMIT && s.turn % EVERY === 0 && s.turn !== lastTurn) {
      sample();
      lastTurn = s.turn;
    }
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const side = s.current;
      const a = (side === 'A' ? v3 : v1)(s, budget, rejected);
      if (!a) break;
      // 首次交战：谁先动手（不分攻击/攻城）
      if ((a.type === 'ATTACK' || a.type === 'SIEGE') && of(side).firstFight === null) {
        of(side).firstFight = s.turn;
      }
      const r = applyAction(s, a);
      if (!r.ok) {
        rejected.add(aiActionKey(a));
        continue;
      }
      rejected.clear();
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }
  return { A, B, winner: s.winner ?? null, turn: s.turn };
}

const cases = CASES.filter((c) => !ONLY || c.id === ONLY);
const rows: Array<{ id: string; seed: number; A: Side; B: Side; winner: PlayerId | null; turn: number }> = [];
for (const c of cases) {
  for (const seed of c.seeds) {
    const run = playOne(c, seed);
    rows.push({ id: c.id, seed, ...run });
    console.log(`${c.id} ${c.size}×${c.size}/era${c.era} seed=${seed} → ${run.winner ?? '平'} ${run.turn} 回合`);
  }
}

/* ---------------- 汇总 ---------------- */

const picks = [10, 20, 30, 40];
const at = (side: Side, turn: number): Snap | undefined =>
  side.snaps.find((x) => x.turn >= turn) ?? side.snaps[side.snaps.length - 1];
const med = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) / 2)]!;
};

console.log('\n收入（金币/回合，中位）');
console.log(`| 回合 | ${picks.map((t) => `T${t}`).join(' | ')} |`);
console.log(`|---|${picks.map(() => '---').join('|')}|`);
for (const [name, key] of [['v3', 'A'], ['v1', 'B']] as const) {
  const cells = picks.map((t) => {
    const vals = rows
      .map((r) => at(key === 'A' ? r.A : r.B, t))
      .filter((x): x is Snap => !!x)
      .map((x) => x.income);
    return String(Math.round(med(vals)));
  });
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

console.log('\n经济单位数（中位）');
console.log(`| 回合 | ${picks.map((t) => `T${t}`).join(' | ')} |`);
console.log(`|---|${picks.map(() => '---').join('|')}|`);
for (const [name, key] of [['v3', 'A'], ['v1', 'B']] as const) {
  const cells = picks.map((t) => {
    const vals = rows
      .map((r) => at(key === 'A' ? r.A : r.B, t))
      .filter((x): x is Snap => !!x)
      .map((x) => x.econ);
    return String(med(vals));
  });
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

console.log('\n兵力数（中位）');
console.log(`| 回合 | ${picks.map((t) => `T${t}`).join(' | ')} |`);
console.log(`|---|${picks.map(() => '---').join('|')}|`);
for (const [name, key] of [['v3', 'A'], ['v1', 'B']] as const) {
  const cells = picks.map((t) => {
    const vals = rows
      .map((r) => at(key === 'A' ? r.A : r.B, t))
      .filter((x): x is Snap => !!x)
      .map((x) => x.army);
    return String(med(vals));
  });
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

const fightsA = rows.map((r) => r.A.firstFight).filter((x): x is number => x !== null);
const fightsB = rows.map((r) => r.B.firstFight).filter((x): x is number => x !== null);
const takeA = rows.map((r) => r.A.econTakeoff).filter((x): x is number => x !== null);
const takeB = rows.map((r) => r.B.econTakeoff).filter((x): x is number => x !== null);

console.log('\n部队前压（战斗单位到最近自家城的平均距离，中位）');
console.log(`| 回合 | ${picks.map((t) => `T${t}`).join(' | ')} |`);
console.log(`|---|${picks.map(() => '---').join('|')}|`);
for (const [name, key] of [['v3', 'A'], ['v1', 'B']] as const) {
  const cells = picks.map((t) => {
    const vals = rows
      .map((r) => at(key === 'A' ? r.A : r.B, t))
      .filter((x): x is Snap => !!x)
      .map((x) => x.push);
    return med(vals).toFixed(1);
  });
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

console.log(
  `\n首次交战（中位）：v3 ${fightsA.length ? med(fightsA) : '—'} 回合 · v1 ${fightsB.length ? med(fightsB) : '—'} 回合`,
);
console.log(
  `经济起飞（经济单位到 3 个，中位）：v3 ${takeA.length ? med(takeA) : '—'} 回合 · v1 ${takeB.length ? med(takeB) : '—'} 回合`,
);

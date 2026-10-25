/**
 * AI 对战模拟器。
 *
 * 用来回答"AI 到底会不会进攻"这种只能靠跑出来看的问题：
 * 两边都交给 AI，跑 N 个回合，每回合记录战线位置、攻击次数、兵力。
 *
 * 注意它不经过 UI，也不写存档——就是纯粹的规则 + AI 循环，
 * 和 main.ts 里的 runAiLoop 同构（拿不到 action 就结束回合）。
 *
 * 运行：node --experimental-strip-types scripts/sim-ai.ts [回合数]
 */

import { AI_MAX_STEPS, aiActionKey, aiNextAction } from '../src/core/ai.ts';
import { applyAction, citiesOf, distToCity } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const TURNS = Number(process.argv[2] ?? 100);
const SEED = Number(process.env.SIM_SEED ?? 20260101);

let s: GameState = createMatch(
  {
    ...DEFAULT_CONFIG,
    aiOpponent: true,
    aiAlly: true,
    mapStyle: (process.env.SIM_STYLE as never) ?? 'random',
  },
  SEED,
);

// SIM_NO_WATER=1：把水填平，用来区分"AI 不会打仗"和"地图把路堵死了"
if (process.env.SIM_NO_WATER) {
  for (const t of s.tiles) if (t.terrain === 'water') t.terrain = 'plain';
}

/** 每方每回合允许的行动预算（和 main.ts 一致） */
const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };

function cityOf(p: PlayerId) {
  return citiesOf(s, p)[0];
}

/**
 * 战线位置：己方所有战斗单位里，离敌方城市最近的那个有多远。
 * 数字越小说明越往前推；一直等于"两城之间的距离"就是压根没出门。
 */
function frontOf(p: PlayerId): number {
  const enemyCity = citiesOf(s, p === 'A' ? 'B' : 'A')[0];
  const ownCity = cityOf(p);
  if (!enemyCity || !ownCity) return NaN;
  const combat = s.units.filter((u) => {
    const d = s.unitTypes[u.type];
    return u.owner === p && d?.category === 'combat';
  });
  if (combat.length === 0) return NaN;
  return Math.min(...combat.map((u) => distToCity(u, enemyCity)));
}

function startDistance(): number {
  const a = cityOf('A');
  const b = citiesOf(s, 'B')[0];
  if (!a || !b) return NaN;
  return distToCity(a, b);
}

interface TurnReport {
  turn: number;
  side: PlayerId;
  attacks: number;
  sieges: number;
  moves: number;
  recruits: number;
  units: number;
}

const reports: TurnReport[] = [];
const recruitByCat: Record<string, number> = {};
const buildByType: Record<string, number> = {};
/** 每方最后一次能算出来的战线（灭国后 frontOf 会给 NaN） */
const lastFront: Record<PlayerId, number> = { A: NaN, B: NaN };
let bridges = 0;
let bridgesOk = 0;
let campsOk = 0;
/** 从军营出的兵有几个 */
let campRecruits = 0;
const startD = startDistance();
console.log(`地图距离（两城）≈ ${startD} 格 · 共 ${TURNS} 回合`);

for (let turn = 1; turn <= TURNS; turn++) {
  const side = s.current;
  budget.recruited = 0;
  budget.upgraded = 0;

  const rep: TurnReport = { turn, side, attacks: 0, sieges: 0, moves: 0, recruits: 0, units: 0 };
  const rejected = new Set<string>();

  for (let step = 0; step < AI_MAX_STEPS; step++) {
    const action = aiNextAction(s, budget, rejected);
    if (!action) break;
    const r = applyAction(s, action);
    if (!r.ok) {
      console.log(`  ! 第 ${turn} 回合出现非法行动 ${JSON.stringify(action)}：${r.reason}`);
      rejected.add(aiActionKey(action));
      continue;
    }
    rejected.clear();
    s = r.state;
    if (action.type === 'ATTACK') rep.attacks += 1;
    if (action.type === 'SIEGE') rep.sieges += 1;
    if (action.type === 'MOVE') rep.moves += 1;
    if (action.type === 'RECRUIT') {
      rep.recruits += 1;
      budget.recruited += 1;
      const cat = s.unitTypes[action.unitType]?.category ?? '?';
      recruitByCat[cat] = (recruitByCat[cat] ?? 0) + 1;
      if (action.unitId) campRecruits += 1;
    }
    if (action.type === 'BUILD') {
      bridges += 1;
      buildByType[action.unitType] = (buildByType[action.unitType] ?? 0) + 1;
      const t = s.tiles[action.y * s.w + action.x];
      if (t && t.terrain === 'bridge') bridgesOk += 1;
      if (s.unitTypes[action.unitType]?.barracks) campsOk += 1;
    }
    if (action.type === 'UPGRADE') budget.upgraded += 1;
  }

  rep.units = s.units.filter((u) => u.owner === side).length;
  reports.push(rep);

  if (s.winner) {
    console.log(`\n第 ${turn} 次单方行动结束：${s.winner === 'draw' ? '平局' : `${s.winner} 胜`}`);
    break;
  }

  const end = applyAction(s, { type: 'END_TURN' });
  if (!end.ok) {
    console.log(`  ! END_TURN 失败：${end.reason}`);
    break;
  }
  s = end.state;

  for (const p of ['A', 'B'] as const) {
    const f = frontOf(p);
    if (Number.isFinite(f)) lastFront[p] = f;
  }

  if (turn % 10 === 0) {
    console.log(
      `  回合 ${String(turn).padStart(3)} · 战线 A=${frontOf('A')} B=${frontOf('B')}` +
        ` · 兵力 A=${s.units.filter((u) => u.owner === 'A').length}` +
        ` B=${s.units.filter((u) => u.owner === 'B').length}` +
        ` · 城耐久 ${s.cities.map((c) => `${c.owner}${c.hp}/${c.maxHp}`).join(' ')}` +
        ` · 金币 A=${s.players.A.gold} B=${s.players.B.gold}`,
    );
  }
}

const sum = (f: (r: TurnReport) => number) => reports.reduce((acc, r) => acc + f(r), 0);
const totalAttacks = sum((r) => r.attacks) + sum((r) => r.sieges);
const totalMoves = sum((r) => r.moves);

console.log('\n汇总');
console.log(`  回合数        ${reports.length}`);
console.log(`  移动 / 攻击   ${totalMoves} / ${totalAttacks}` +
  `（攻城 ${sum((r) => r.sieges)}）`);
console.log(
  `  招兵          ${sum((r) => r.recruits)}（${Object.entries(recruitByCat)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')}）· 其中从军营出 ${campRecruits}`,
);
console.log(
  `  建造          ${bridges}（${Object.entries(buildByType)
    .map(([k, v]) => `${s.unitTypes[k]?.name ?? k}:${v}`)
    .join(' ')}）`,
);
// 收尾时败方可能已经没有城市了，frontOf 会返回 NaN——那就报"上一回合的战线"
const frontText = (p: PlayerId): string => {
  const now = frontOf(p);
  if (Number.isFinite(now)) return String(now);
  const prev = lastFront[p];
  return Number.isFinite(prev) ? `${prev}（已灭国）` : '—';
};
console.log(`  A 战线        ${frontText('A')}（开局 ${startD}，越小越靠前）`);
console.log(`  B 战线        ${frontText('B')}`);
console.log(`  胜负          ${s.winner === 'draw' ? '平局' : s.winner ?? '未决'}`);

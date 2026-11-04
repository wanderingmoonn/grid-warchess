/**
 * 采购体检：一个兵种为什么"很强但没人造"。
 *
 * 这是上一轮龙骑兵问题的直接产物：龙骑兵流 20 局赢 19 局，可是在 100 局标准 AI
 * 对局里它只被造了 3 个（采用率 1%）。所以这里把 AI 的采购决策拆成两层问：
 *
 *   ① **买不起**（`钱不够`）：这一回合金库里到底有没有 265 金？
 *   ② **买得起但没选它**（`分数偏低` / `让位升级` / `攒钱冻结`）：输给了谁。
 *
 * 顺带把 AI 那把尺子（`combatPower` / `combatEfficiency`）抄一份摆出来——
 * 它是"为什么算分输"的答案，公式只读 `atk / maxHp / range / price`，
 * **不读移速、不读冲锋这类能力**。抄在这里是为了对比，改分请改 `src/core/ai.ts`。
 *
 * 运行：
 *   node --experimental-strip-types scripts/probe-adoption.ts --type dragoon-rider --games 4
 */
import { aiNextAction, aiRecruitTrace, AI_MAX_STEPS } from '../src/core/ai.ts';
import { DEFAULT_BUDGET } from '../src/core/ai-meta.ts';
import { applyAction, recruitPriceOf, recruitSpawnCells, unitsOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { unitEfficiency, unitPower, NEUTRAL_CONTEXT } from '../src/core/unit-value.ts';
import type { GameState, PlayerId, UnitTypeDef } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const TARGET = argOf('type', 'dragoon-rider');
const GAMES = Number(argOf('games', '4'));
const BASE_SEED = Number(argOf('seed', '9400'));
const CAP = Number(argOf('cap', '200'));
const EXPANSIONS = [
  'pack-contemporary',
  'fantasy-core',
  'fantasy-knights',
  'fantasy-beasts',
  'fantasy-arcane',
  'fantasy-heroes',
];

/**
 * AI 那把尺子：**直接 import，不再抄一份**。
 *
 * 原来这里是一份抄件（`攻 × √血 × 射程系数`）。抄件的下场和任何复制品一样：
 * 尺子换成兰彻斯特乘积之后，体检报告的 ④ 段还在用旧公式算"性价比 2.28"，
 * 而 AI 实际早就按新尺子打了 5.40——报告本身成了误导源。现在同源。
 */
const combatPower = (d: UnitTypeDef): number => unitPower(d, NEUTRAL_CONTEXT);
const combatEfficiency = (d: UnitTypeDef, price: number): number =>
  unitEfficiency(d, price, NEUTRAL_CONTEXT);

const reasons = new Map<string, number>();
const winnersBought = new Map<string, number>();
let bought = 0;
let turnsObserved = 0;
let turnsAffordable = 0;
let turnsNoSlot = 0;
let goldSum = 0;

for (let g = 0; g < GAMES; g += 1) {
  const seed = BASE_SEED + g;
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 20,
      startEra: 3,
      aiOpponent: true,
      aiAlly: true,
      aiLevel: 'advanced',
      mapStyle: 'random',
      expansionIds: EXPANSIONS,
    },
    seed,
  );
  aiRecruitTrace.on = true;
  aiRecruitTrace.detail = new Map();

  while (!s.winner && s.turn <= CAP) {
    // 每一方行动之前，先记一笔"这回合到底买不买得起"
    const me = s.current as PlayerId;
    const def = s.unitTypes[TARGET];
    if (def) {
      const price = recruitPriceOf(s, me, def).gold;
      const gold = s.players[me].gold;
      const slot = unitsOf(s, me).length > 0 && [...s.cities]
        .filter((c) => c.owner === me && !c.ruined)
        .some((c) => recruitSpawnCells(s, c.id, undefined, TARGET).length > 0);
      turnsObserved += 1;
      goldSum += gold;
      if (gold >= price) turnsAffordable += 1;
      if (!slot) turnsNoSlot += 1;
    }

    const budget = { ...DEFAULT_BUDGET };
    for (let k = 0; k < AI_MAX_STEPS && !s.winner; k += 1) {
      const action = aiNextAction(s, budget);
      if (!action) break;
      if (action.type === 'RECRUIT') {
        budget.recruited += 1;
        if (action.unitType === TARGET) bought += 1;
        else winnersBought.set(action.unitType, (winnersBought.get(action.unitType) ?? 0) + 1);
      }
      if (action.type === 'UPGRADE') budget.upgraded += 1;
      const r = applyAction(s, action);
      if (!r.ok) break;
      s = r.state;
    }
    if (s.winner) break;
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }

  for (const [type, bag] of aiRecruitTrace.detail ?? []) {
    if (type !== TARGET) continue;
    for (const [why, n] of bag) reasons.set(why, (reasons.get(why) ?? 0) + n);
  }
}

const def = createMatch({ ...DEFAULT_CONFIG, startEra: 3, expansionIds: EXPANSIONS }, BASE_SEED).unitTypes[TARGET];
const price = def ? recruitPriceOf(createMatch({ ...DEFAULT_CONFIG, startEra: 3, expansionIds: EXPANSIONS }, BASE_SEED), 'A', def).gold : 0;

console.log(`\n体检对象：${def?.name ?? TARGET}（${TARGET}）· ${GAMES} 局标准 AI 对局（火器 / 20×20）`);
console.log(`造价 ${def?.cost} · 攻 ${def?.atk} · 血 ${def?.maxHp} · 移 ${def?.move} · 射 ${def?.range} · 能力 ${(def?.abilities ?? []).join('/') || '—'}`);
console.log(`\n① 实际采购：${bought} 次（每局 ${(bought / GAMES).toFixed(2)}）`);
console.log(`   观察到的"一方一回合"共 ${turnsObserved} 次，其中金库 ≥ ${price} 的有 ${turnsAffordable} 次` +
  `（${((turnsAffordable / Math.max(1, turnsObserved)) * 100).toFixed(1)}%），平均金库 ${(goldSum / Math.max(1, turnsObserved)).toFixed(0)} 金`);
console.log(`   因为"没有出兵格"而根本轮不到评估：${turnsNoSlot} 次`);

console.log('\n② 被拒原因（逐兵种记账，来自 aiRecruitTrace）');
for (const [why, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${why.padEnd(14)} ${String(n).padStart(6)}`);
}

console.log('\n③ 同期真正被买走的（前 12 名）');
const top = [...winnersBought.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
const table = createMatch({ ...DEFAULT_CONFIG, startEra: 3, expansionIds: EXPANSIONS }, BASE_SEED);
for (const [type, n] of top) {
  const d = table.unitTypes[type];
  if (!d) continue;
  console.log(
    `   ${d.name.padEnd(8)} ${String(n).padStart(4)} 次 · ${String(d.cost).padStart(4)} 金 · ` +
      `攻 ${String(d.atk).padStart(2)} × 血 ${String(d.maxHp).padStart(3)} · 移 ${d.move} · ` +
      `战力 ${combatPower(d).toFixed(0).padStart(4)} · 性价比 ${combatEfficiency(d, d.cost).toFixed(2)}`,
  );
}

if (def) {
  console.log('\n④ AI 的尺子怎么算它（`combatPower = (输出×生存)^0.55 × 射程 × 移速 × 视野 × 能力`，`性价比 = 战力 / 价格^0.95`）');
  const peers = ['halberdier', 'druid', 'musketeer', 'rifleman', 'paladin', 'royal-cavalry', TARGET];
  const rows = peers
    .map((id) => table.unitTypes[id])
    .filter((d): d is UnitTypeDef => !!d)
    .map((d) => ({ d, power: combatPower(d), eff: combatEfficiency(d, d.cost) }))
    .sort((a, b) => b.eff - a.eff);
  for (const r of rows) {
    console.log(
      `   ${r.d.name.padEnd(8)} ${String(r.d.cost).padStart(4)} 金 · 战力 ${r.power.toFixed(0).padStart(4)} · ` +
        `性价比 ${r.eff.toFixed(2)} · 移 ${String(r.d.move).padStart(2)}${r.d.id === TARGET ? '   ← 体检对象' : ''}`,
    );
  }
}

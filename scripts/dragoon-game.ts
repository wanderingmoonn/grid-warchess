/**
 * 单局：龙骑兵流（`script-dragoon.ts`）对标准 AI。
 *
 * 一局一个进程，写完一个 JSON 就退出——`dragoon-batch.ts` 用 32 核并发去拉。
 * 记录的是这条打法**自己**的账：买了几个龙骑兵、打掉多少经济单位、换掉多少战斗单位、
 * 挨了多少伤害，以及最后谁赢。
 *
 * 用法（一般由 batch 调用）：
 *   node --experimental-strip-types scripts/dragoon-game.ts \
 *     --seed 9500 --seat A --out results/dragoon/g-9500-A.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { aiNextAction, AI_MAX_STEPS } from '../src/core/ai.ts';
import { DEFAULT_BUDGET } from '../src/core/ai-meta.ts';
import { applyAction, citiesOf, recruitPriceOf, unitsOf, utype } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { Action, GameState, PlayerId } from '../src/core/types.ts';
import { DRAGOON, dragoonNextAction } from './script-dragoon.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SEED = Number(argOf('seed', '9500'));
const SEAT = (argOf('seat', 'A') as PlayerId);
const CAP = Number(argOf('cap', '200'));
const ERA = Number(argOf('era', '3'));
const SIZE = Number(argOf('size', '20'));
const OUT = argOf('out', '');
const EXPANSIONS = [
  'pack-contemporary',
  'fantasy-core',
  'fantasy-knights',
  'fantasy-beasts',
  'fantasy-arcane',
  'fantasy-heroes',
];

const other = (p: PlayerId): PlayerId => (p === 'A' ? 'B' : 'A');

interface Snap {
  hp: number;
  type: string;
  owner: PlayerId;
}

let s: GameState = createMatch(
  {
    ...DEFAULT_CONFIG,
    size: SIZE,
    startEra: ERA,
    aiOpponent: true,
    aiAlly: true,
    aiLevel: 'advanced',
    mapStyle: 'random',
    expansionIds: EXPANSIONS,
  },
  SEED,
);

const foe: PlayerId = other(SEAT);
const stats = {
  seed: SEED,
  seat: SEAT,
  winner: null as PlayerId | null,
  dragoonWon: false,
  turns: 0,
  goldOnDragoons: 0,
  dragoonsBuilt: 0,
  dragoonsLost: 0,
  dragoonsAlive: 0,
  dmgDealt: 0,
  dmgTaken: 0,
  kills: { economy: 0, combat: 0, other: 0 },
  enemyEconomyTotal: 0,
  enemyEconomyKilled: 0,
  enemyCombatKilled: 0,
  peakDragoons: 0,
};

/** 敌方经济单位的"总产量"：新出现的每一个都记一笔（开局白送的也算） */
const seenEconomy = new Set<string>();
for (const u of unitsOf(s, foe)) {
  if (utype(s, u.type).category === 'economy') seenEconomy.add(u.id);
}

const snapOf = (st: GameState): Map<string, Snap> => {
  const m = new Map<string, Snap>();
  for (const u of st.units) m.set(u.id, { hp: u.hp, type: u.type, owner: u.owner });
  return m;
};

/** 打一步，顺手把这一下的账记掉 */
function step(action: Action): boolean {
  const before = snapOf(s);
  const actor = s.current;
  const r = applyAction(s, action);
  if (!r.ok) {
    console.error(`非法动作 ${JSON.stringify(action)}：${r.reason}`);
    return false;
  }
  s = r.state;

  // ① 龙骑兵挨的伤害：所有龙骑兵实例的血量下降（含阵亡的那一个）
  for (const [id, b] of before) {
    if (b.owner !== SEAT || b.type !== DRAGOON) continue;
    const now = s.units.find((u) => u.id === id);
    if (!now) {
      stats.dmgTaken += b.hp;
      stats.dragoonsLost += 1;
      continue;
    }
    if (now.hp < b.hp) stats.dmgTaken += b.hp - now.hp;
  }

  // ② 龙骑兵打出去的伤害与击杀（只算直接目标；溅射这类本兵种没有）
  if (action.type === 'ATTACK' && actor === SEAT) {
    const isDragoon = before.get(action.unitId)?.type === DRAGOON;
    const t = before.get(action.targetId);
    if (isDragoon && t) {
      const now = s.units.find((u) => u.id === action.targetId);
      const dealt = now ? Math.max(0, t.hp - now.hp) : t.hp;
      stats.dmgDealt += dealt;
      if (!now) {
        const cat = utype(s, t.type).category;
        if (cat === 'economy') {
          stats.kills.economy += 1;
          stats.enemyEconomyKilled += 1;
        } else if (cat === 'combat') {
          stats.kills.combat += 1;
          stats.enemyCombatKilled += 1;
        } else {
          stats.kills.other += 1;
        }
      }
    }
  }

  // ③ 招募记账
  if (action.type === 'RECRUIT' && action.unitType === DRAGOON) {
    stats.dragoonsBuilt += 1;
    const def = s.unitTypes[DRAGOON];
    if (def) stats.goldOnDragoons += recruitPriceOf(s, SEAT, def).gold;
  }

  // ④ 敌方新出现的经济单位
  for (const u of unitsOf(s, foe)) {
    if (utype(s, u.type).category === 'economy' && !seenEconomy.has(u.id)) seenEconomy.add(u.id);
  }
  stats.enemyEconomyTotal = seenEconomy.size;
  stats.peakDragoons = Math.max(stats.peakDragoons, unitsOf(s, SEAT).filter((u) => u.type === DRAGOON).length);
  return true;
}

while (!s.winner && s.turn <= CAP) {
  const budget = { ...DEFAULT_BUDGET };
  for (let k = 0; k < AI_MAX_STEPS && !s.winner; k += 1) {
    const action = s.current === SEAT ? dragoonNextAction(s, budget) : aiNextAction(s, budget);
    if (!action) break;
    if (!step(action)) break;
    if (action.type === 'RECRUIT') budget.recruited += 1;
    if (action.type === 'UPGRADE') budget.upgraded += 1;
  }
  if (s.winner) break;
  if (!step({ type: 'END_TURN' })) break;
}

stats.winner = s.winner ?? null;
stats.dragoonWon = s.winner === SEAT;
stats.turns = s.turn;
stats.dragoonsAlive = unitsOf(s, SEAT).filter((u) => u.type === DRAGOON).length;
(stats as unknown as { cities: { mine: number; foe: number } }).cities = {
  mine: citiesOf(s, SEAT).filter((c) => !c.ruined).length,
  foe: citiesOf(s, foe).filter((c) => !c.ruined).length,
};

if (OUT) {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(stats, null, 1), 'utf-8');
}
console.log(
  `seed=${SEED} seat=${SEAT} ${s.winner ?? '未决'} · ${stats.turns} 回合 · ` +
    `龙骑兵 ${stats.dragoonsBuilt} 造 / ${stats.dragoonsAlive} 存 · 输出 ${Math.round(stats.dmgDealt)} / 承伤 ${Math.round(stats.dmgTaken)} · ` +
    `击杀 经济 ${stats.kills.economy} / 战斗 ${stats.kills.combat}`,
);

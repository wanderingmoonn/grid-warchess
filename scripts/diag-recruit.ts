/**
 * 采购体检：AI 一局到底在买什么。
 *
 * 线上对局库（warchess_reports）里，AI 被打崩的那十几局终局阵容长这样：
 * `{anc_engineer:2, herder:1, laborer:5}`、`{herder:2}`、`{farmer:1, herder:4}`——
 * 一个战斗单位都没有。但报告只有终局快照，看不出"第一枪是什么时候打歪的"。
 *
 * 这个脚本补上过程：同样的配置跑 N 局双 AI，每 N 回合打一行
 * "金币 / 城 / 战斗·经济·建造单位数 / 合计"，再给出这一局累计买了什么。
 * 经济线和战斗线是从第几回合开始分叉的，一眼就能看出来。
 *
 *   node --experimental-strip-types scripts/diag-recruit.ts --size 12 --games 4
 *   node --experimental-strip-types scripts/diag-recruit.ts --exp bloodbath,turn-order-comp
 */

import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { applyAction, citiesOf, unitsOf } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SIZE = Number(argOf('size', '12'));
const GAMES = Number(argOf('games', '4'));
const CAP = Number(argOf('cap', '140'));
const EVERY = Number(argOf('every', '10'));
const EXP = argOf('exp', 'bloodbath,turn-order-comp').split(',').filter(Boolean);
const ERA = Number(argOf('era', '1'));

function snap(s: GameState, p: PlayerId) {
  const mine = unitsOf(s, p);
  const by = (cat: string) => mine.filter((u) => s.unitTypes[u.type]?.category === cat).length;
  return {
    gold: s.players[p].gold,
    cities: citiesOf(s, p).length,
    combat: by('combat'),
    economy: by('economy'),
    builder: by('builder'),
  };
}

for (let g = 0; g < GAMES; g += 1) {
  const seed = 7000 + g * 37;
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: SIZE,
      startEra: ERA,
      aiOpponent: true,
      aiAlly: true,
      expansionIds: EXP,
      aiLevel: 'advanced',
    } as never,
    seed,
  );

  const bought: Record<PlayerId, Record<string, number>> = { A: {}, B: {} };
  const rows: Array<{ turn: number } & ReturnType<typeof snap>> = [];

  let ended = false;
  let round = 0;
  while (!ended && round < CAP) {
    round += 1;
    for (let half = 0; half < 2 && !ended; half += 1) {
      const me: PlayerId = s.current;
      const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
      for (let step = 0; step < AI_MAX_STEPS; step += 1) {
        const action = aiNextAction(s, budget);
        if (!action) break;
        if (action.type === 'RECRUIT') {
          bought[me][action.unitType] = (bought[me][action.unitType] ?? 0) + 1;
          budget.recruited += 1;
        }
        if (action.type === 'UPGRADE') budget.upgraded += 1;
        const r = applyAction(s, action);
        if (!r.ok) {
          console.log(`  ! 回合 ${s.turn} 非法行动 ${JSON.stringify(action)}：${r.reason}`);
          break;
        }
        s = r.state;
        if (s.winner) {
          ended = true;
          break;
        }
      }
      if (ended) break;
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) {
        console.log(`  ! END_TURN 失败：${end.reason}`);
        ended = true;
        break;
      }
      s = end.state;
    }
    if (round % EVERY === 0 || ended) rows.push({ turn: round, ...snap(s, 'B') });
  }

  console.log(`\n=== 局 ${g + 1} / seed ${seed} / ${SIZE}×${SIZE} / [${EXP.join(' ')}] ===`);
  console.log('回合  金币  城  战斗  经济  建造');
  for (const r of rows) {
    console.log(
      `${String(r.turn).padStart(4)}  ${String(r.gold).padStart(4)}  ${String(r.cities).padStart(2)}  ` +
        `${String(r.combat).padStart(4)}  ${String(r.economy).padStart(4)}  ${String(r.builder).padStart(4)}`,
    );
  }

  const fin = snap(s, 'B');
  console.log(`终局：回合 ${s.turn} / ${s.winner ?? '未决'} 胜 / B 战斗 ${fin.combat} 经济 ${fin.economy} 建造 ${fin.builder}`);
  const fmt = (p: PlayerId) =>
    Object.entries(bought[p])
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${id}×${n}`)
      .join(' ') || '（无）';
  console.log(`B 买过：${fmt('B')}`);
  console.log(`A 买过：${fmt('A')}`);
}

/**
 * 机制探针：这条改动**到底有没有触发**。
 *
 * 上一轮（2026-11-02 的五条）栽在这里：换血机制在 AI 自对弈里从没触发过，
 * 于是"胜率没变"被读成"这个机制没用"，其实是"它一次都没上场"。
 *
 * 这里数的是最硬的东西：整局里每个兵种被 RECRUIT 了几次，以及"速攻倾向"出现过的
 * 回合数占比。攻城器（臼炮）如果从头到尾是 0，那么任何关于它的胜负结论都不成立。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-composition.ts --games 12 --era 3
 *   node --experimental-strip-types scripts/probe-composition.ts --games 12 --era 3 --old ./baselines/ai-8fc819d.ts
 */
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const GAMES = Number(argOf('games', '12'));
const ERA = Number(argOf('era', '3'));
const SEED = Number(argOf('seed', '900'));
const CAP = Number(argOf('cap', '160'));

const counts = new Map<string, number>();
let siegeGames = 0;
let games = 0;
let siegeAtTurn = new Map<number, number>();

for (let g = 0; g < GAMES; g += 1) {
  let s: GameState = createMatch(
    // 两边都交给 AI：只设 aiOpponent 的话 A 席仍算人类，AI 走到它那儿就返回 null，
    // 整局第一步就停了（第一版探针正是这么废掉的）。
    { ...DEFAULT_CONFIG, size: 16, startEra: ERA, aiOpponent: true, aiAlly: true, aiLevel: 'tactic' },
    SEED + g,
  );
  const bought = new Map<string, number>();
  /**
   * 一回合 = 「预算内的若干动作」+ 一个 END_TURN。
   *
   * 少了那个 END_TURN，`aiNextAction` 会在一回合预算用尽时返回 null——
   * 探针第一版就是这么"每局只走两步"的（我把它当成了整局的上限，其实那是**单回合**的）。
   * 结构和 `ai-duel.ts` 的 playOne 保持一致，别在这里另写一套。
   */
  while (!s.winner && s.turn <= CAP) {
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i += 1) {
      const a = aiNextAction(s, { ...DEFAULT_BUDGET });
      if (!a) break;
      if (a.type === 'RECRUIT') {
        const t = a.unitType;
        bought.set(t, (bought.get(t) ?? 0) + 1);
        counts.set(t, (counts.get(t) ?? 0) + 1);
        if (t === 'mortar' || t === 'artillery' || t === 'tank') {
          siegeAtTurn.set(s.turn, (siegeAtTurn.get(s.turn) ?? 0) + 1);
        }
      }
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    if (s.winner) break;
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  const hadSiege = [...bought.keys()].some((k) => ['mortar', 'artillery', 'tank'].includes(k));
  if (hadSiege) siegeGames += 1;
  games += 1;
  const top = [...bought.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(
    `第 ${g + 1} 局 seed=${SEED + g} 回合 ${s.turn} 造兵 ${[...bought.values()].reduce((x, y) => x + y, 0)}`
      + `　主力 ${top.map(([k, n]) => `${k}×${n}`).join(' ')}`
      + `${hadSiege ? '　[有攻城器]' : ''}`,
  );
}

console.log('');
console.log(`${games} 局（时代 ${ERA}）· 造兵总数 ${[...counts.values()].reduce((a, b) => a + b, 0)}`);
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(`兵种分布：${top.map(([k, n]) => `${k}×${n}`).join('  ')}`);
const siege = ['mortar', 'artillery', 'tank'].reduce((n, k) => n + (counts.get(k) ?? 0), 0);
console.log(`攻城器：${siege} 台，出现在 ${siegeGames}/${games} 局里`);
if (siege === 0) {
  console.log('⚠️ 一台都没造——关于攻城器采购的任何胜率结论都不成立');
}

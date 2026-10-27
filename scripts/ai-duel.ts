/**
 * 新旧 AI 对战台：同一张图、同一批种子，A 方用新版、B 方用冻结的旧版，
 * 同一颗种子两边各执一次先手——这样"图不对称"和"先手优势"都不会混进胜负差里。
 *
 * 为什么要专门写一个：balance-report 两边用的是同一个 AI，
 * 它只能测兵种平衡，测不出"新 AI 是不是更强"。而"更强"这件事必须有数，
 * 否则改完 AI 只是换了口味。
 *
 * 扩展默认跟着正式配置走（血战 + 先后手补偿）。别用空扩展：
 * 关掉血战之后城市永远回血，两边都推不动，实测未决率会从个位数涨到三成以上，
 * 剩下的样本根本不够判胜负——第一版就是栽在这上面。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ai-duel.ts --era 1 --games 40 --seed 900
 *   node --experimental-strip-types scripts/ai-duel.ts --era 2 --games 40 --no-swap
 * 输出：每个种子的胜负 + 汇总胜率（平局算半分）+ 二项检验的 z。
 */

import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction as newAi } from '../src/core/ai.ts';
import { aiNextAction as oldAi } from './baseline-ai.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const ERA = Number(argOf('era', '1'));
const GAMES = Number(argOf('games', '40'));
const BASE_SEED = Number(argOf('seed', '900'));
const CAP = Number(argOf('cap', '160'));
const LEVEL = argOf('level', 'advanced') as 'basic' | 'advanced';
/** 同一颗种子两边各打一局：paired，方差最小 */
const SWAP = !has('no-swap');
/** 空扩展开关：只在排查"是不是规则把对局拖进拉锯"时才用 */
const EXP = has('bare') ? [] : [...DEFAULT_CONFIG.expansionIds];

type Ai = typeof newAi;

function playOne(seed: number, aIsNew: boolean): { winner: PlayerId | null; turns: number } {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      startEra: ERA,
      aiLevel: LEVEL,
      expansionIds: EXP,
    },
    seed,
  );

  const aiFor = (p: PlayerId): Ai => (p === 'A') === aIsNew ? newAi : oldAi;

  while (!s.winner && s.turn <= CAP) {
    const ai = aiFor(s.current);
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = ai(s, budget);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }

  return { winner: s.winner ?? null, turns: s.turn };
}

let newWins = 0;
let oldWins = 0;
let draws = 0;
let turnsSum = 0;
let played = 0;

for (let i = 0; i < GAMES; i++) {
  const seed = BASE_SEED + i;
  // 有 swap 时，一颗种子打两局（新先 / 新后各一次），否则按奇偶分先手
  const layouts = SWAP ? [true, false] : [i % 2 === 0];

  for (const aIsNew of layouts) {
    const { winner, turns } = playOne(seed, aIsNew);
    turnsSum += turns;
    played += 1;

    let tag: string;
    if (winner === null) {
      draws += 1;
      tag = 'draw';
    } else {
      const winnerIsNew = (winner === 'A') === aIsNew;
      if (winnerIsNew) newWins += 1;
      else oldWins += 1;
      tag = winnerIsNew ? 'NEW' : 'old';
    }
    process.stderr.write(
      `era${ERA} seed=${seed} ${aIsNew ? '新先手' : '新后手'} → ${tag} (${turns} 回合)\n`,
    );
  }
}

const decided = newWins + oldWins;
const rate = decided > 0 ? newWins / decided : 0;
// 平局算半分：这是"这一局谁更有利"的标准口径，比"只数分出的局"稳
const score = played > 0 ? (newWins + draws * 0.5) / played : 0;
// 单尾二项检验的近似：z = (p̂ - 0.5) / (0.5 / sqrt(n))
const zDecided = decided > 0 ? (rate - 0.5) / Math.sqrt(0.25 / decided) : 0;
const zScore = played > 0 ? (score - 0.5) / Math.sqrt(0.25 / played) : 0;
console.log(
  `era${ERA} ${played} 局：新 AI ${newWins} 胜 / 旧 AI ${oldWins} 胜 / 平 ${draws}` +
    ` → 新胜率 ${(rate * 100).toFixed(1)}% (z=${zDecided.toFixed(2)})` +
    ` 计分 ${(score * 100).toFixed(1)}% (z=${zScore.toFixed(2)})` +
    ` 均 ${(turnsSum / Math.max(1, played)).toFixed(0)} 回合  exp=[${EXP.join(',')}]`,
);

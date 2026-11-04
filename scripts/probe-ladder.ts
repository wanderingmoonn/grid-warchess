/**
 * 两张梯子：**决策质量**能折多少胜率、**一代科技**能折多少胜率。
 *
 * 为什么要有这个：AI 打 AI 的胜率永远是 50% 上下（两边共用同一套判断），
 * 那个数字说明不了"它有多强"。能说明问题的是两条刻度：
 *
 *   1) **决策梯子**：同一张图、同一套规则，只把一方的档位调低（中级 vs 初级）。
 *      差距越大，说明"决策质量"这条轴上还有多少空间——人比这套 AI 强的地方，
 *      就在这条轴的更上面。
 *   2) **时代让子**：同一档位，一方开局就领先 N 个时代（城直接给，不花钱升级）。
 *      这一条量的是"抢时代"这个打法本身值多少胜率。人类认真打时最稳的一手
 *      就是集中升城换代，这张表给出的就是那一手的收益。
 *
 * 对局成对进行：同一颗种子两边各占一次"优势位"，把先手和地图不对称抵消掉。
 * 报的是**优势方胜率**——50% 表示这个优势一文不值。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-ladder.ts --mode level --high tactic --low basic --games 40
 *   node --experimental-strip-types scripts/probe-ladder.ts --mode era --give 1 --games 40
 * 输出：优势方战绩 + 胜率 + 二项检验的 z + 平均回合数。
 */

import { applyAction, citiesOf } from '../src/core/rules.ts';
import { eraCeilingOf } from '../src/core/expansions.ts';
import { eraDef } from '../src/core/config.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import type { AiLevel, GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const MODE = argOf('mode', 'level') === 'era' ? 'era' : 'level';
const GAMES = Number(argOf('games', '40'));
const SEED = Number(argOf('seed', '900'));
const START_ERA = Number(argOf('era', '3'));
const SIZE = Number(argOf('size', '20'));
const CAP = Number(argOf('cap', '160'));
/** 决策梯子的两档：high 是"优势"那一侧 */
const HIGH = argOf('high', 'tactic') as AiLevel;
const LOW = argOf('low', 'basic') as AiLevel;
/** 时代让子：优势方开局领先几个时代 */
const GIVE = Number(argOf('give', '1'));
const EXP = argOf('exp', DEFAULT_CONFIG.expansionIds.join(',')).split(',').filter(Boolean);

/**
 * 把某一家的城直接提到高 N 代——**不花钱**。
 *
 * 照抄 doUpgrade 的那几步（era / maxHp / armor / hp），不另写一套：
 * 让子的本质就是"这一次升级白送"，别的地方不该有任何差别。
 * 封顶按 eraCeilingOf 走，所以没开现代包时最多追到机械化。
 */
function giveEra(s: GameState, p: PlayerId, n: number): number {
  const cap = eraCeilingOf(s);
  let given = 0;
  for (const c of citiesOf(s, p)) {
    for (let k = 0; k < n; k++) {
      if (c.era >= cap) break;
      const from = eraDef(c.era);
      const to = eraDef(c.era + 1);
      c.era += 1;
      const hpGain = to.cityMaxHp - from.cityMaxHp;
      c.maxHp += hpGain;
      c.armor += to.cityArmor - from.cityArmor;
      c.hp = Math.min(c.maxHp, c.hp + hpGain);
      given += 1;
    }
  }
  return given;
}

function playOne(seed: number, hiSeat: PlayerId): { winner: PlayerId | null; turns: number } {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      startEra: START_ERA,
      size: SIZE,
      expansionIds: EXP,
      // 档位在每一回合开始前改（见下面的循环）：AI 每次决策都重读 config.aiLevel
      aiLevel: MODE === 'level' ? HIGH : 'tactic',
    },
    seed,
  );

  if (MODE === 'era') giveEra(s, hiSeat, GIVE);

  while (!s.winner && s.turn <= CAP) {
    // 决策梯子：轮到谁就把档位切到谁那一档
    s.config.aiLevel = MODE === 'level' ? (s.current === hiSeat ? HIGH : LOW) : 'tactic';
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = aiNextAction(s, budget);
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

let hiWins = 0;
let loWins = 0;
let draws = 0;
let turnsSum = 0;
let played = 0;

for (let i = 0; i < GAMES; i++) {
  const seed = SEED + i;
  // 同一颗种子打两局：优势方先手一次、后手一次
  for (const hiSeat of ['A', 'B'] as PlayerId[]) {
    const { winner, turns } = playOne(seed, hiSeat);
    played += 1;
    turnsSum += turns;
    if (winner === null) draws += 1;
    else if (winner === hiSeat) hiWins += 1;
    else loWins += 1;
    process.stderr.write(
      `${MODE} seed=${seed} 优势方=${hiSeat} → ${winner === null ? '未决' : winner === hiSeat ? '优势方胜' : '劣势方胜'} (${turns})\n`,
    );
  }
}

const decided = hiWins + loWins;
const rate = decided > 0 ? hiWins / decided : 0;
const score = played > 0 ? (hiWins + draws * 0.5) / played : 0;
const z = played > 0 ? (score - 0.5) / Math.sqrt(0.25 / played) : 0;
const tag =
  MODE === 'level'
    ? `决策梯子：${HIGH}（优势方）vs ${LOW}`
    : `时代让子：优势方开局 +${GIVE} 代（${START_ERA}→${START_ERA + GIVE}）`;
console.log(
  `${tag} · ${played} 局 · era${START_ERA} · ${SIZE}×${SIZE}\n` +
    `  优势方 ${hiWins} 胜 / 劣势方 ${loWins} 胜 / 未决 ${draws}` +
    ` → 优势方胜率 ${(rate * 100).toFixed(1)}%（计分 ${(score * 100).toFixed(1)}%，z=${z.toFixed(2)}）` +
    ` 均 ${(turnsSum / Math.max(1, played)).toFixed(0)} 回合`,
);

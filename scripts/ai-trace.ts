/**
 * 一局双 AI 对轰的"体检报告"：每 N 回合打一行，两边并排看。
 *
 * 为什么要这个：ai-duel 只给胜负。看到 50% 的时候，下一步到底是"经济输了"
 * 还是"兵力输了""不会收尾"，光看胜率永远猜不出来——猜一轮改一轮，一次二十局，
 * 一天就没了。把中间过程摊开，问题通常第二眼就能看出来。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ai-trace.ts --era 1 --seed 2000 --every 5
 *   node --experimental-strip-types scripts/ai-trace.ts --era 1 --seed 2000 --vs old
 */

import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { utype, citiesOf, unitsOf, incomeOf } from '../src/core/rules.ts';
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
const SEED = Number(argOf('seed', '2000'));
const EVERY = Number(argOf('every', '5'));
const CAP = Number(argOf('cap', '160'));
/** 对手用什么 AI：old = 冻结的旧版；new = 同一个新版（镜像，用来当基线） */
const VS = argOf('vs', 'old');
/** 新版执哪一方 */
const NEW_SIDE = argOf('newside', 'A') as PlayerId;

type Ai = typeof newAi;
const aiOf = (p: PlayerId): Ai => (p === NEW_SIDE ? newAi : VS === 'old' ? oldAi : newAi);

const snap = (s: GameState, p: PlayerId): string => {
  const cities = citiesOf(s, p);
  const us = unitsOf(s, p);
  const combat = us.filter((u) => utype(s, u.type).category === 'combat');
  const eco = us.filter((u) => utype(s, u.type).category === 'economy');
  const val = combat.reduce((n, u) => n + (utype(s, u.type).cost ?? 0), 0);
  const hp = combat.reduce((n, u) => n + u.hp, 0);
  const maxHp = combat.reduce((n, u) => n + utype(s, u.type).maxHp, 0);
  const cityTxt = cities
    .map((c) => `${c.ruined ? '废' : ''}${c.era}级 ${c.hp}/${c.maxHp}`)
    .join(' ');
  return (
    `${p}: 金${String(s.players[p].gold).padStart(4)} ` +
    `粮${String(s.players[p].res?.food ?? 0).padStart(3)} 材${String(s.players[p].res?.material ?? 0).padStart(3)} ` +
    `收${String(incomeOf(s, p)).padStart(3)} ` +
    `兵${String(combat.length).padStart(2)}(${val}金 ${Math.round((hp / Math.max(1, maxHp)) * 100)}%) ` +
    `民${String(eco.length).padStart(2)} 城[${cityTxt}]`
  );
};

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, startEra: ERA, aiLevel: 'advanced', expansionIds: [...DEFAULT_CONFIG.expansionIds] },
  SEED,
);

console.log(`# seed=${SEED} era=${ERA} 新AI=${NEW_SIDE} 对手=${VS}`);
while (!s.winner && s.turn <= CAP) {
  const ai = aiOf(s.current);
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

  if (!has('quiet') && (s.turn % EVERY === 0 || s.winner)) {
    console.log(`T${String(s.turn).padStart(3)} ${snap(s, 'A')}`);
    console.log(`     ${snap(s, 'B')}`);
  }
}

console.log(`# 结果：${s.winner ?? '平'} 于第 ${s.turn} 回合`);
if (has('log')) {
  for (const line of s.log.slice(-40)) console.log(`  ${line.text}`);
}

/**
 * **编队战力的自检**（只读）：拿缓存的"6 打 6"实测结果，检验 `world.squadDuel` 猜得准不准。
 *
 *   node --experimental-strip-types scripts/probe-squad.ts [--n 6]
 *
 * 为什么要有这一步：编队战力是先按几何/复利推出来的模型，**没对过引擎就不能进决策**。
 * 这里只做一件事：拿缓存里每一对的实测胜负，和模型算的胜负比，报每代正确率。
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { utype } from '../src/core/rules.ts';
import { squadDuel, unitWorthOfType } from '../src/core/v4/world.ts';
import { combatOfEra } from './lib/duel.ts';
import { duel, flushDuelCache } from './lib/duel-cache.ts';
import type { GameState } from '../src/core/types.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : dflt;
};
const N = Number(argOf('n', '6'));
const MODE = argOf('mode', 'duel');
const s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 1 }, 900);

let okAll = 0;
let totalAll = 0;
for (const era of [1, 2, 3, 4, 5]) {
  const ids = combatOfEra(s, era);
  if (ids.length < 2) continue;
  let ok = 0;
  let total = 0;
  const wrong: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      /* 实测：正反各打一次，按净胜人数定胜负 */
      const r1 = duel(a, b, N);
      const r2 = duel(b, a, N);
      const m = r1.aLeft - r1.bLeft + (r2.bLeft - r2.aLeft);
      if (m === 0) continue;
      const realWin = m > 0 ? a : b;
      /*
       * 两种预测：
       *  · `sum`（"干脆不建模"）：编队战力 = 每个人的身价之和 × 展开折扣（两边人数相同 → 折扣相消）
       *  · `duel`：`squadDuel` 的递推
       */
      let predWin: string | null = null;
      if (MODE === 'sum') {
        const wa = N * unitWorthOfType(s, a);
        const wb = N * unitWorthOfType(s, b);
        predWin = wa > wb ? a : wb > wa ? b : null;
      } else {
        const d1 = squadDuel(s, Array(N).fill(a), Array(N).fill(b));
        predWin = d1.mine > d1.foes ? a : d1.foes > d1.mine ? b : null;
      }
      total += 1;
      if (predWin === realWin) ok += 1;
      else wrong.push(`${utype(s, a).name} vs ${utype(s, b).name}（实测 ${utype(s, realWin).name} 赢，模型说 ${predWin ? utype(s, predWin).name : '平'}）`);
    }
  }
  okAll += ok;
  totalAll += total;
  console.log(`${ok === total ? '✅' : '⚠️'} ${era} 代  ${ok}/${total}` + (wrong.length ? `\n    ${wrong.join('\n    ')}` : ''));
}
console.log(`\n（模式 ${MODE}）合计 ${okAll}/${totalAll} = ${((okAll / Math.max(1, totalAll)) * 100).toFixed(0)}%`);
flushDuelCache();

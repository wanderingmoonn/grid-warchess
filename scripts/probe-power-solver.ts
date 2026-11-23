/**
 * 战力求解器探针：它算的数是不是"人会觉得对"的那几个。
 *
 * 只验机制，不跑对局。五个用例：
 *   1. 0 回合 → 0 战力；
 *   2. 有钱有格子 → 出满名额（线性）；
 *   3. 回合越久，允许先投经济 → 最终战力更高；
 *   4. 太短的窗口不该投经济（回不了本）；
 *   5. 没有经济可投时退化成纯暴兵，不会崩。
 */
import { solvePower } from '../src/core/power-solver.ts';
import type { PowerInput } from '../src/core/power-solver.ts';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
};

const base: PowerInput = {
  gold: 1000,
  income: 60,
  slots: 4,
  econRoom: 6,
  units: [{ id: 'tank', price: 300, power: 270 }],
  econ: [{ id: 'farmer', price: 50, income: 7 }],
};

console.log('1 0 回合');
{
  const p = solvePower(base, 0);
  ok(p.power === 0, '0 回合战力为 0');
}

console.log('2 出满名额');
{
  const p = solvePower({ ...base, gold: 5000, income: 0, econ: [] }, 3);
  // 钱给够：3 回合 × 4 名额 × 270 = 3240
  ok(p.power === 3 * 4 * 270, `3 回合 4 名额出满（${p.power}）`);
  ok(p.econUntil === 0, '没有经济可投时 econUntil = 0');
}

console.log('3 窗口越长，越值得先投经济');
{
  const short = solvePower(base, 4);
  const long = solvePower(base, 20);
  ok(long.power > short.power, `20 回合战力高于 4 回合（${short.power} → ${long.power}）`);
}

console.log('4 短窗口不投经济');
{
  const p = solvePower({ ...base, income: 20 }, 2);
  ok(p.econUntil === 0, `2 回合窗口不投经济（econUntil=${p.econUntil}）`);
}

console.log('5 没有经济可投也不崩');
{
  const p = solvePower({ ...base, econ: [] }, 5);
  ok(Number.isFinite(p.power) && p.power >= 0, '经济表为空时结果仍是有限数');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);

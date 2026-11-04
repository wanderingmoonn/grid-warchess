/** 克隆/落子成本：深推的宽度必须由这个数决定，不能凭感觉 */
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import type { GameState } from '../src/core/types.ts';

let s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 3, aiOpponent: true, aiAlly: true, aiLevel: 'advanced' }, 900);
// 先打到中局：兵力多、状态大，克隆最贵
for (let turn = 0; turn < 24 && !s.winner; turn += 1) {
  for (let i = 0; i < AI_MAX_STEPS; i += 1) {
    const a = aiNextAction(s, { ...DEFAULT_BUDGET });
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) break;
    s = r.state;
  }
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}
console.log(`中局：${s.units.length} 个单位 / ${s.tiles.length} 格 / 行动 ${s.turn}`);

const N = 200;
let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) applyAction(s, { type: 'END_TURN' });
let ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
console.log(`一次 applyAction（含深拷贝）：${ms.toFixed(2)} ms  → 100 次 ${(ms * 100).toFixed(0)} ms`);

t0 = process.hrtime.bigint();
for (let i = 0; i < 5; i += 1) aiNextAction(s, { ...DEFAULT_BUDGET });
console.log(`一次 aiNextAction（现有浅评估）：${(Number(process.hrtime.bigint() - t0) / 1e6 / 5).toFixed(1)} ms`);

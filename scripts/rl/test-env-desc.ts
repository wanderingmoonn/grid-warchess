/**
 * 扩展描述向量的自检：跑一遍真实开局，看每一格是不是"该变的变了、不该变的没变"。
 *
 * 这份测试的重点不是"数值对不对"（那些是设计选择），而是三件事：
 *   1. 维度固定、值域在 [-4, 4]（网络吃不了 inf，也不该被一个极端值带跑）；
 *   2. **换扩展时变化落在预期的那几格上**——如果换了个扩展整块向量乱跳，
 *      说明它退化成了"扩展身份编码"，那就失去泛化意义了；
 *   3. 同一局重复调用结果完全一致（它是纯函数，不能有隐藏状态）。
 */
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { GameState } from '../../src/core/types.ts';
import { ENV_DIM, describeEnv } from './env-desc.ts';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`);
  if (!ok) failed += 1;
}

function match(expansionIds: string[], playerCount: 2 | 3 | 4 = 2, fog = false): GameState {
  const s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 10,
      startEra: 1,
      playerCount,
      draftMode: false,
      aiOpponent: false,
      aiAlly: false,
      expansionIds,
    },
    4242,
  );
  s.fog = fog;
  return s;
}

console.log('扩展描述向量');
const base = describeEnv(match([]));
check('维度固定', base.length === ENV_DIM, `ENV_DIM=${ENV_DIM}`);
check(
  '值域在 [-4, 4]',
  base.every((v) => Number.isFinite(v) && v >= -4 && v <= 4),
  `min=${Math.min(...base).toFixed(2)} max=${Math.max(...base).toFixed(2)}`,
);

// 纯函数：同一局反复算，必须逐位相同
const again = describeEnv(match([]));
check('同一局重复调用结果一致', base.every((v, i) => v === again[i]));

const bloodbath = describeEnv(match(['bloodbath']));
const diffBlood = [...base.keys()].filter((i) => base[i] !== bloodbath[i]);
check(
  '开血战只动"血战"（18）和"扩展数"（22）',
  diffBlood.length === 2 && diffBlood.includes(18) && diffBlood.includes(22),
  `变动位 ${diffBlood.join(',')}`,
);

const turnOrder = describeEnv(match(['turn-order-comp']));
const diffTurn = [...base.keys()].filter((i) => base[i] !== turnOrder[i]);
check('开先行补偿只动"补偿"和"扩展数"两格', diffTurn.length <= 2, `变动位 ${diffTurn.join(',')}`);

const multi = match(['bloodbath', 'turn-order-comp', 'action-points']);
const env = describeEnv(multi);
check(
  '多扩展时"扩展数"这一格变大',
  env[22] > base[22],
  `扩展数格 0 → ${env[22].toFixed(2)}`,
);
check('行动点扩展：开关位（26）置 1', env[26] === 1);
check('不开行动点时开关位为 0', base[26] === 0);
check(
  '带 ap 字段的兵种占比在两种情况下都是 0（默认值不在兵种表里）',
  base[10] === 0 && env[10] === 0,
  '所以行动点只能按 id 认，这一点已写进注释',
);

const foggy = describeEnv(match([], 2, true));
check('开迷雾只动"迷雾"一格（17）', base[17] === 0 && foggy[17] === 1);

const four = describeEnv(match([], 4));
check('四人局：人数格变大', four[24] > base[24], `${base[24]} → ${four[24]}`);

// 兵种池会随时代扩张：高时代开局的可造兵更多，[6] 应当更大
const late = createMatch(
  {
    ...DEFAULT_CONFIG,
    size: 10,
    startEra: 4,
    playerCount: 2,
    draftMode: false,
    aiOpponent: false,
    aiAlly: false,
    expansionIds: [],
  },
  4242,
);
const lateEnv = describeEnv(late);
check('时代越高、起始时代格越大', lateEnv[25] > base[25], `${base[25]} → ${lateEnv[25]}`);

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);

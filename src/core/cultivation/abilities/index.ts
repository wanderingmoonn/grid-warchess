// src/cultivation/abilities/index.ts
// 能力总入口：import 每个能力文件，再汇总成 CULTIVATION_ABILITIES 交给扩展包。
// `unlocks.ts` 也在这里 import —— 它靠模块加载时的副作用注册 onRankUp，
// 不 import 就静默失效（和 skills/index.ts 同一个道理）。
import type { AbilityDef } from '../../abilities.ts';

import { ANOMALY } from './anomaly.ts';
import { BODY_WARD } from './body-ward.ts';
import { FORMATION_GUARDIAN } from './formation-guardian.ts';
import { FORMATION_KILL } from './formation-kill.ts';
import { FORMATION_SEAL } from './formation-seal.ts';
import { QI_TRUE_DAMAGE } from './qi-true-damage.ts';
import { SPIRIT_ASCENSION } from './spirit-ascension.ts';
import { SPIRIT_AURA } from './spirit-aura.ts';

export * from './anomaly.ts';
export * from './body-ward.ts';
export * from './formation-guardian.ts';
export * from './formation-kill.ts';
export * from './formation-seal.ts';
export * from './qi-true-damage.ts';
export * from './spirit-ascension.ts';
export * from './spirit-aura.ts';
export * from './unlocks.ts';

export const CULTIVATION_ABILITIES: AbilityDef[] = [
  ANOMALY,
  BODY_WARD,
  FORMATION_KILL,
  FORMATION_SEAL,
  FORMATION_GUARDIAN,
  QI_TRUE_DAMAGE,
  SPIRIT_ASCENSION,
  SPIRIT_AURA,
];

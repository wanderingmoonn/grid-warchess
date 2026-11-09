// src/cultivation/abilities/index.ts
// 能力总入口：import 每个能力文件，再汇总成 CULTIVATION_ABILITIES 交给扩展包。
// `unlocks.ts` 也在这里 import —— 它靠模块加载时的副作用注册 onRankUp，
// 不 import 就静默失效（和 skills/index.ts 同一个道理）。
import type { AbilityDef } from '../../abilities.ts';

import { ARTIFACT_SPIRIT, WARM_NOURISH } from '../artifacts.ts';
import { FIRE_QI, STONE_WARD, SWORD_QI } from './artifact-auras.ts';
import { CHILL_HIT, SUNDER_HIT } from './artifact-effects.ts';

import { ANOMALY } from './anomaly.ts';
import { BODY_WARD } from './body-ward.ts';
import { FORMATION_GUARDIAN } from './formation-guardian.ts';
import { FORMATION_KILL } from './formation-kill.ts';
import { FORMATION_SEAL } from './formation-seal.ts';
import { QI_TRUE_DAMAGE } from './qi-true-damage.ts';
import { SPIRIT_ASCENSION } from './spirit-ascension.ts';
import { SPIRIT_AURA } from './spirit-aura.ts';

export * from './anomaly.ts';
export * from './artifact-auras.ts';
export * from './artifact-effects.ts';
export * from './body-ward.ts';
export * from './formation-guardian.ts';
export * from './formation-kill.ts';
export * from './formation-seal.ts';
export * from './qi-true-damage.ts';
export * from './spirit-ascension.ts';
export * from './spirit-aura.ts';
export * from './unlocks.ts';
// 法器的两条公共能力：定义在 cultivation/artifacts.ts（那里还有身份判定与查询），
// 这里只把它们汇进能力表，好让面板/词条/悬停都能看到。
export { ARTIFACT_SPIRIT, WARM_NOURISH } from '../artifacts.ts';

export const CULTIVATION_ABILITIES: AbilityDef[] = [
  ANOMALY,
  ARTIFACT_SPIRIT,
  BODY_WARD,
  CHILL_HIT,
  FORMATION_KILL,
  FORMATION_SEAL,
  FORMATION_GUARDIAN,
  QI_TRUE_DAMAGE,
  SPIRIT_ASCENSION,
  SPIRIT_AURA,
  STONE_WARD,
  SUNDER_HIT,
  SWORD_QI,
  WARM_NOURISH,
  FIRE_QI,
];

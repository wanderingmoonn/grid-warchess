// src/cultivation/abilities/index.ts
import type { AbilityDef } from '../../abilities.ts';

import { QI_TRUE_DAMAGE } from './qi-true-damage.ts';
import { SPIRIT_ASCENSION } from './spirit-ascension.ts';
import { SPIRIT_AURA } from './spirit-aura.ts';

export * from './qi-true-damage.ts';
export * from './spirit-ascension.ts';
export * from './spirit-aura.ts';

export const CULTIVATION_ABILITIES: AbilityDef[] = [
  QI_TRUE_DAMAGE,
  SPIRIT_ASCENSION,
  SPIRIT_AURA,
];
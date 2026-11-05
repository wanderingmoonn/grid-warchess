/**
 * ── 修真扩展包入口（组装车间） ──────────────────────────────
 * 注意：本文件只负责把各个零件拼装成最终的 Expansion 对象。
 * 业务逻辑已经被拆分到了 cultivation/ 目录下，详见 cultivation/README.md。
 * 
 * 架构核心原则：
 * 1. 升级发技能 -> 走 onRankUp 事件广播，绝不反向 import。
 * 2. 技能数据 -> skills.ts；技能执行 -> skill-effects.ts。
 * 3. 如果外部模块 import 本文件报错，请检查底部的 re-export 桥接。
 */

import type { Expansion } from './expansions.ts';

import { getSwordSweepReach } from './cultivation/skills.ts';
import { 
  SPIRIT_CULTIVATOR, 
  CULTIVATOR, 
  SWORD_CULTIVATOR,
  SERVANT,
  SPIRIT_FIELD,
  SPIRIT_MINE,
  SPIRIT_TOWER
} from './cultivation/units.ts';
import { QI_TRUE_DAMAGE, SPIRIT_ASCENSION } from './cultivation/abilities.ts';
import { cultivationRank, setCultivationExp } from './cultivation/progression.ts';
import { SPIRIT_STONE_DEF } from './cultivation/resources.ts';
import { CULTIVATION_HOOKS } from './cultivation/hooks.ts';

// 副作用注册：import 一次即触发模块内的注册逻辑
import './cultivation/skill-effects.ts';
import './cultivation/unlocks.ts';

export const CULTIVATION_PACK: Expansion = {
  id: 'cultivation',
  name: '修真',
  blurb: '会修炼、能长境界的修士。',
  summary: '带来了会修炼成长的各种修士。',
  scale: 'large',
  hooks: CULTIVATION_HOOKS,
  abilities: [QI_TRUE_DAMAGE, SPIRIT_ASCENSION],
  units: [
    CULTIVATOR, 
    SWORD_CULTIVATOR, 
    SPIRIT_CULTIVATOR,
    SERVANT, 
    SPIRIT_FIELD, 
    SPIRIT_MINE,
    SPIRIT_TOWER
  ],
  resources: [SPIRIT_STONE_DEF],
};

export { cultivationRank, setCultivationExp, getSwordSweepReach };

export {
  getAgingYears,
} from './cultivation/progression.ts';
/**
 * ── 修真扩展包入口（组装车间） ──────────────────────────────
 * 注意：本文件只负责把各个零件拼装成最终的 Expansion 对象。
 * 业务逻辑已经被拆分到了 cultivation/ 目录下，详见 cultivation/README.md。
 * 
 * 架构核心原则：
 * 1. 升级发技能 -> 走 onRankUp 事件广播，绝不反向 import。
 * 2. 一个技能一个文件，数据 + 数值 + 实现在一起（见 cultivation/skills/）。
 * 3. 如果外部模块 import 本文件报错，请检查底部的 re-export 桥接。
 */

import type { Expansion } from './expansions.ts';

import { 
  SPIRIT_CULTIVATOR, 
  CULTIVATOR, 
  SWORD_CULTIVATOR,
  BODY_CULTIVATOR,
  BLOOD_CULTIVATOR,
  SERVANT,
  DEACON,
  SPIRIT_FIELD,
  SPIRIT_MINE,
  SPIRIT_TOWER,
  FORMATION_MASTER,
  FORMATION_MASTER_2,
  FORMATION_MASTER_3,
  KILL_FORMATION,
  SEAL_FORMATION,
  TELEPORT_FORMATION,
  GUARD_FORMATION,
  MINE_MOUNTAIN_STONE_BONUS,
} from './cultivation/units.ts';
import { CULTIVATION_ABILITIES } from './cultivation/abilities/index.ts';
import { cultivationRank, setCultivationExp } from './cultivation/progression.ts';
import { SPIRIT_STONE_DEF } from './cultivation/resources.ts';
import { CULTIVATION_HOOKS } from './cultivation/hooks.ts';
import { TOWER_CHARGE_COST, TOWER_BURST_CHARGES } from './cultivation/skills/index.ts';

// 副作用注册：技能/解锁都是模块加载时自注册，必须 import 一次。
// 技能那一侧由 skills/index.ts 统一拉起（每个技能文件 + unlocks），
// 能力解锁已经在 abilities/index.ts 里带进来了。
import './cultivation/skills/index.ts';

export const CULTIVATION_PACK: Expansion = {
  id: 'cultivation',
  name: '修真',
  blurb: '会修炼、能长境界的修士。',
  summary: '带来了会修炼成长的各种修士。',
  scale: 'large',
  hooks: CULTIVATION_HOOKS,
  abilities: CULTIVATION_ABILITIES,
  units: [
    CULTIVATOR, 
    SWORD_CULTIVATOR, 
    // 体修：第二个"能修炼的战斗流派"，靠金刚不坏硬抗（见 abilities/body-ward.ts）
    BODY_CULTIVATOR,
    // 魔修：靠「血祭」炼化生灵升级，打坐与击杀历练都不给它（见 skills/blood-rite.ts）
    BLOOD_CULTIVATOR,
    SPIRIT_CULTIVATOR,
    SERVANT, 
    // 执事是灵矿唯一的建造者：漏登记它就等于灵矿永远造不出来。
    DEACON,
    SPIRIT_FIELD, 
    SPIRIT_MINE,
    SPIRIT_TOWER,
    // 阵法：阵师是唯一建造者，三个时代的白名单递增（见 units.ts）
    FORMATION_MASTER,
    FORMATION_MASTER_2,
    FORMATION_MASTER_3,
    KILL_FORMATION,
    SEAL_FORMATION,
    TELEPORT_FORMATION,
    GUARD_FORMATION,
  ],
  resources: [SPIRIT_STONE_DEF],
  // 下面几条都只活在钩子里（配置表没有对应字段），规则书靠这里才能印全。
  manualNotes: [
    `灵矿每相邻一座高山，额外产出 ${MINE_MOUNTAIN_STONE_BONUS} 灵石（四方向，不含斜角）。`,
    `散灵台基础攻击次数为 0：必须先花 ${TOWER_CHARGE_COST} 灵石「释放灵气」，才有 ${TOWER_BURST_CHARGES} 次开火机会，` +
      `而且那几发是在**对手回合开始、建筑自动开火**时打出去的，不是在自己回合里点。`,
  ],
};

export { cultivationRank, setCultivationExp };

export {
  getAgingYears,
} from './cultivation/progression.ts';
/**
 * 航天员 —— 唯一能在真空里正常干活的人。
 *
 * 他和其他兵的区别只有一条：**不受「恶劣外空环境」影响**。
 * 别人在月面上护甲 ÷5、移动减半，他按原值算。这一条就够让他成为
 * 登月和守站的必需品——而不是靠"攻击力更高"这种数值差。
 *
 * 未来「有些舱段需要航天员在旁边才能工作」，那套判定等舱段做出来再接；
 * 这一版只做单位本身。
 *
 * 为什么放在基础包：登月本来就要有人去守，只开「太空时代」的局也需要他。
 * 维生仓才是太空战争的东西（那是空间站舱段）。
 */

import type { UnitTypeDef } from '../types.ts';
import { registerHazardExempt } from '../hazard.ts';
import { SPACE_HAZARD } from './space-hazard.ts';

export const ASTRONAUT_ID = 'astronaut';

export const ASTRONAUT: UnitTypeDef = {
  id: ASTRONAUT_ID,
  name: '航天员',
  short: '航',
  era: 5,
  category: 'combat',
  cost: 220,
  move: 2,
  atk: 3,
  armor: 2,
  maxHp: 24,
  range: 1,
  vision: 2,
  /*
   * 不写 `campOnly`：军营的白名单是空的（=不设限），所以它会自动出现在
   * 兵营的产品线上，和民兵、建筑队一个路子，不用另外挂产兵点。
   */
};

// 豁免：只对「恶劣外空环境」这条生效——以后别的环境（辐射、毒雾）不该被宇航服一起免掉
registerHazardExempt((_s, unit, h) => h.id === SPACE_HAZARD.id && unit.type === ASTRONAUT_ID);

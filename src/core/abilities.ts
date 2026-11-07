/**
 * 特殊能力。
 *
 * 数值能调的是"多强"，能力决定的是"怎么打"。这两件事分开，
 * 才能让编辑器从"改数字"变成"造兵种"。
 *
 * 每条能力 = 一条元数据 + 一组钩子（见 ability-hooks.ts）。
 * 元数据是给玩家看的（名字、说明、分组），钩子是引擎在正确时机调用的那段代码。
 *
 * ── 这个文件只放"公共词汇" ──────────────────────────────────────────────
 *
 * 判据只有两条，都很好查：
 *   1. 本体兵种表（config.ts）用到的 → 这里；
 *   2. 两个以上扩展都要用的（先手、自爆、指挥光环）→ 这里；
 *   3. 其余：谁家的兵谁家管。「淬毒」「筑墙」「振奋」全在 fantasy-packs.ts
 *      的 FANTASY_ABILITIES 里，一条都不许留在这儿。
 *
 * 为什么要立这条规矩：能力是兵种怎么打，属于兵种设计，不属于引擎。
 * 混在一起写过一次，结果是加一个扩展兵种要改本体、删扩展时要回本体
 * 一行行找哪几段是谁的，而这一层也会慢慢长成一张兵种清单。
 *
 * 例外只有一类：**编辑器词汇**。`heal`（休整）、`fly`（飞行）、`versatile`
 * （长短皆可）、`fly-over`（掠空）现在没有任何内置兵种在挂，但玩家自己捏兵种时
 * 会勾它们，所以它们留在本体，不跟着哪个包走。
 */

import { ARMOR_STAGE, DAMAGE_STAGE, TURN_START } from './ability-hooks.ts';
import type { AbilityHooks } from './ability-hooks.ts';
import type { UnitTypeDef } from './types.ts';

export type AbilityGroup = 'attack' | 'defense' | 'move' | 'support';

export interface AbilityDef {
  id: string;
  name: string;
  summary: string;
  group: AbilityGroup;
  /** 引擎在哪些时机问它。没有钩子的能力只是个标签（留给将来的机制用） */
  hooks?: AbilityHooks;
}

export const ABILITY_GROUP_NAME: Record<AbilityGroup, string> = {
  attack: '进攻',
  defense: '防御',
  move: '机动',
  support: '支援',
};

/**
 * 公共能力表（11 条）。
 *
 * 只有本体兵种在用的四条（潜行、盾墙、破甲、破城）、两个包都要用的三条
 * （先手、自爆、指挥光环），加上留给编辑器的四个词汇（休整、飞行、掠空、长短皆可）。
 * 奇想包那 40 条不在这里，在 fantasy-packs.ts 的 FANTASY_ABILITIES 里。
 *
 * 顺序 = 规则书和编辑器里的显示顺序，也是同 stage 钩子的执行顺序，
 * 所以别为了"好看"随便重排（要排就重排分组内的，且跑一遍快照）。
 */
export const CORE_ABILITIES: AbilityDef[] = [
  {
    id: 'first-strike',
    name: '先手',
    summary: '攻击后不会被反击。远程狙击手的核心。',
    group: 'attack',
    hooks: { noCounter: true },
  },
  {
    id: 'armor-pierce',
    name: '破甲',
    summary: '无视目标一半护甲。对付重甲和城池的解法。',
    group: 'attack',
    // 破甲排在护甲阶段的最后：先让穿隙、林地之主、扩展改甲把护甲累出来，
    // 再一刀砍半——反过来的话，"多 3 点甲"和"少一半甲"会互相吃掉。
    hooks: {
      armorPhase: [
        {
          stage: ARMOR_STAGE.pierce,
          apply: (c) => {
            // 只有"我打你"才削甲。挨打时不能把自己的甲砍一半
            if (c.side !== 'attacker') return;
            c.armor = Math.floor(c.armor / 2);
          },
        },
      ],
    },
  },
  {
    id: 'siege-master',
    name: '破城',
    summary: '攻城伤害 ×1.5。',
    group: 'attack',
    hooks: {
      siegeDamage: [
        {
          stage: 1,
          apply: (c) => {
            c.damage = Math.round(c.damage * 1.5);
          },
        },
      ],
    },
  },
  {
    id: 'kamikaze',
    name: '自爆',
    summary: '阵亡时对四周相邻的地面单位各造成自身攻击一半的伤害——打不到空中的东西。',
    group: 'attack',
    hooks: {
      onDeath: (c) => {
        const def = c.api.utype(c.state, c.victim.type);
        const blast = Math.max(1, Math.round(def.atk / 2));
        let hit = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          // 一格可以同时站着地面和空中各一个，所以这里要找"邻近的所有单位"，
          // 只取四邻那一格的 find 会漏掉叠在上面的那个。
          for (const near of c.state.units) {
            if (near.x !== c.victim.x + dx || near.y !== c.victim.y + dy) continue;
            // 自爆是贴地的冲击波：掠空的东西飞在上面，扫不到。
            // 判据用 layer === 'air'，和「区域防空」同一个口径（见 air-packs）。
            if (c.api.utype(c.state, near.type).layer === 'air') continue;
            // 自爆也是直接伤害，走唯一出口：转移、受伤钩子、致死清场一个不少。
            // 清场本身仍由主流程按 result.blasts 统一 sweepDead。
            c.api.hurt(c.state, near, blast, { source: c.victim });
            hit += 1;
          }
        }
        if (hit > 0) {
          c.api.pushLog(c.state, c.victim.owner, `${def.name} 自爆，波及 ${hit} 个单位`);
          c.result.blasts = hit;
        }
      },
    },
  },
  {
    id: 'shield-wall',
    name: '盾墙',
    summary: '本回合没有移动过时，受到的伤害 −2。站住才硬。',
    group: 'defense',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.defenderFlat,
          apply: (c) => {
            if (c.side !== 'defender') return;
            if (!c.self.moved) c.damage -= 2;
          },
        },
      ],
    },
  },
  {
    id: 'stealth',
    name: '潜行',
    summary: '站在森林或丘陵上时，敌人要贴到相邻格才发现它。开阔地上无效。',
    group: 'move',
    hooks: {
      hidden: (c) => {
        const tile = c.api.tileAt(c.state, c.self.x, c.self.y);
        return !!tile && (tile.terrain === 'forest' || tile.terrain === 'hill');
      },
    },
  },
  {
    id: 'heal',
    name: '休整',
    summary: '上回合没有移动也没有攻击时，回合开始恢复 15% 生命上限。想回血就得让出这一拍。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.self,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            if (!c.rested || !c.healable || c.self.hp >= def.maxHp) return;
            c.self.hp = Math.min(def.maxHp, c.self.hp + Math.ceil(def.maxHp * 0.15));
          },
        },
      ],
    },
  },
  {
    id: 'aura-command',
    name: '指挥光环',
    summary: '2 格内的友军攻击 +4。',
    group: 'support',
    // 2026-11-03：相邻 +2 → 2 格 +4。原来必须贴着才吃得到，等于逼着"光环兵"
    // 站到最前面去送；而 +2 在 3 代之后连"隔一层护甲的差别"都补不回来。
    hooks: { aura: { allyAtk: 4, radius: 2 } },
  },
  {
    id: 'fly',
    name: '飞行',
    summary: '可以飞越水面（但不能停在水上），森林和丘陵按 1 步算。河防对它不成立。',
    group: 'move',
    hooks: { crossesWater: true },
  },
  // 跳跃：机制上和飞行同一套（掠水、林丘按 1 步），区别只在**是谁在动**。
  // 蜘蛛骑士原来挂着「飞行」，玩家第一反应是"蜘蛛怎么会飞"——
  // 名字和画面打架比数值不准更伤。给它单独一条，规则一条没改。
  {
    id: 'fly-over',
    name: '掠空',
    summary:
      '飞行，而且**可以和地面单位站在同一格**：它在你头顶，不在你身边。可以掠水、森林丘陵按 1 步算。',
    group: 'move',
    hooks: { crossesWater: true, airLayer: true },
  },
  {
    id: 'versatile',
    name: '长短皆可',
    summary: '射程 3，但隔着一格以上打时伤害只有六成。近身是本职，远程是技能。',
    group: 'attack',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.rangeMul,
          apply: (c) => {
            if (c.side !== 'attacker') return;
            if (c.distance >= 2) c.damage = Math.round(c.damage * 0.6);
          },
        },
      ],
    },
  },
];

/** 这个兵种有没有某个能力 */
export function hasAbility(def: UnitTypeDef | undefined, id: string): boolean {
  return !!def?.abilities?.includes(id);
}

// 能力的查询（abilityById / abilityNames / hooksFor）在 ability-registry.ts：
// 那里要把核心表和各扩展贡献的条目合并起来，而这份文件是纯数据、不引任何人。


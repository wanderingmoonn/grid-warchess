/**
 * 特殊能力表。
 *
 * 数值能调的是"多强"，能力决定的是"怎么打"。这两件事分开，
 * 才能让编辑器从"改数字"变成"造兵种"。
 *
 * 每个能力都是纯标记 + rules.ts 里的一段分支：
 *   · 往这里加一条定义
 *   · 在 rules.ts 对应位置加一个 if
 * 不需要改数据模型，也不需要动存档格式（abilities 只是字符串数组）。
 */

import type { UnitTypeDef } from './types.ts';

export type AbilityGroup = 'attack' | 'defense' | 'move' | 'support';

export interface AbilityDef {
  id: string;
  name: string;
  summary: string;
  group: AbilityGroup;
}

export const ABILITY_GROUP_NAME: Record<AbilityGroup, string> = {
  attack: '进攻',
  defense: '防御',
  move: '机动',
  support: '支援',
};

export const ABILITIES: AbilityDef[] = [
  {
    id: 'first-strike',
    name: '先手',
    summary: '攻击后不会被反击。远程狙击手的核心。',
    group: 'attack',
  },
  {
    id: 'armor-pierce',
    name: '破甲',
    summary: '无视目标一半护甲。对付重甲和城池的解法。',
    group: 'attack',
  },
  {
    id: 'siege-master',
    name: '破城',
    summary: '攻城伤害 ×1.5。',
    group: 'attack',
  },
  {
    id: 'kamikaze',
    name: '自爆',
    summary: '阵亡时对四周相邻单位各造成自身攻击一半的伤害。',
    group: 'attack',
  },
  {
    id: 'shield-wall',
    name: '盾墙',
    summary: '本回合没有移动过时，受到的伤害 −2。站住才硬。',
    group: 'defense',
  },
  {
    id: 'forest-walk',
    name: '穿林',
    summary: '森林和丘陵的移动消耗按 1 算。',
    group: 'move',
  },
  {
    id: 'stealth',
    name: '潜行',
    summary: '站在森林或丘陵上时，敌人要贴到相邻格才发现它。开阔地上无效。',
    group: 'move',
  },
  {
    id: 'heal',
    name: '休整',
    summary: '上回合没有移动也没有攻击时，回合开始恢复 15% 生命上限。想回血就得让出这一拍。',
    group: 'support',
  },
  {
    id: 'aura-armor',
    name: '守护光环',
    summary: '相邻的友军护甲 +2。',
    group: 'support',
  },
  {
    id: 'aura-command',
    name: '指挥光环',
    summary: '相邻的友军攻击 +2。',
    group: 'support',
  },
  // ── 奇想兵种包带来的五条 ───────────────────────────────────────────────
  // 这五条都刻意做成"有代价/有前提"的机制，而不是纯数值加成：
  // 飞行要算落点、冲锋要先动过、吸血要真打疼人、威吓要贴上去、再生换的是慢。
  {
    id: 'fly',
    name: '飞行',
    summary: '可以飞越水面（但不能停在水上），森林和丘陵按 1 步算。河防对它不成立。',
    group: 'move',
  },
  {
    id: 'charge',
    name: '冲锋',
    summary: '本回合移动过时，攻击 +5（反击不算）。站着不动就没有这份加成。',
    group: 'attack',
  },
  {
    id: 'lifesteal',
    name: '吸血',
    summary: '造成伤害的 40% 转成自己的生命，上限不超过生命上限。',
    group: 'attack',
  },
  {
    id: 'fear',
    name: '威吓',
    summary: '相邻的敌军攻击 −2，最多叠两层。破解办法是拉开距离，或者先把它射掉。',
    group: 'support',
  },
  {
    id: 'regenerate',
    name: '再生',
    summary: '每回合开始恢复 10% 生命上限，不需要站桩——代价是这种兵通常很慢。',
    group: 'defense',
  },
];

export function abilityById(id: string): AbilityDef | undefined {
  return ABILITIES.find((a) => a.id === id);
}

/** 这个兵种有没有某个能力 */
export function hasAbility(def: UnitTypeDef | undefined, id: string): boolean {
  return !!def?.abilities?.includes(id);
}

/** 把能力 id 列表翻成人话，给面板用 */
export function abilityNames(def: UnitTypeDef): string[] {
  return (def.abilities ?? []).map((id) => abilityById(id)?.name ?? id);
}

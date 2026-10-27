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
  {
    id: 'kill-rush',
    name: '收割',
    summary:
      '亲手斩杀一个单位后，立刻恢复本回合的移动力（攻击次数不恢复）。杀完能走，但走完还是要等下回合才能再出手。',
    group: 'move',
  },
  {
    id: 'element-ward',
    name: '同源护壁',
    summary:
      '受到与自身**当前属性**相同的伤害减半。火打火、水打水都只吃一半——但换个属性打它就照常疼。',
    group: 'defense',
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
  // 跳跃：机制上和飞行同一套（掠水、林丘按 1 步），区别只在**是谁在动**。
  // 蜘蛛骑士原来挂着「飞行」，玩家第一反应是"蜘蛛怎么会飞"——
  // 名字和画面打架比数值不准更伤。给它单独一条，规则一条没改。
  {
    id: 'leap',
    name: '跳跃',
    summary: '一跃过水：水面、森林、丘陵都按 1 步算，河防对它不成立。',
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
  // ── 奇想兵种包带来的机制 ────────────────────────────────────────────────
  //
  // 这一批的共同写法：能力只管"多一种打法"，数值一律往下压。
  // 一个带三条能力的兵如果数值还和同代白板一样，它就不是"有趣"而是"必选"。
  {
    id: 'fly-over',
    name: '掠空',
    summary:
      '飞行，而且**可以和地面单位站在同一格**：它在你头顶，不在你身边。可以掠水、森林丘陵按 1 步算。',
    group: 'move',
  },
  {
    id: 'vanish',
    name: '隐匿',
    summary:
      '不挑地形：只要这一回合还没动过、没出过手，敌人就得贴到相邻格才看得见它。一出手就现形。',
    group: 'move',
  },
  {
    id: 'phase',
    name: '穿行',
    summary: '可以穿过敌军（但不能停在敌军身上）。堵枪眼对它没用，它本来就是穿过去的。',
    group: 'move',
  },
  {
    id: 'slow-offroad',
    name: '重甲难行',
    summary: '森林、丘陵、城市的进入消耗翻倍。铁罐头在平地上是墙，在树林里是靶子。',
    group: 'move',
  },
  {
    id: 'woodland',
    name: '林地之主',
    summary: '站在森林或丘陵上时护甲 +3。把它赶出林子，它就没那么难打了。',
    group: 'defense',
  },
  {
    id: 'berserk',
    name: '狂暴',
    summary: '生命降到一半以下时攻击 +50%。半血之前它只是个普通兵，半血之后才是麻烦。',
    group: 'attack',
  },
  {
    id: 'bloodlust',
    name: '嗜血',
    summary: '回合开始时如果生命低于一半，恢复 15% 生命上限；否则什么也不发生。',
    group: 'defense',
  },
  {
    id: 'regenerate-plus',
    name: '强再生',
    summary: '再生翻倍：每回合开始恢复 20% 生命上限。',
    group: 'defense',
  },
  {
    id: 'tracker',
    name: '追猎',
    summary: '和目标每拉开 1 格攻击 +2（最多 +6）。它擅长的是追杀，不是站桩对捅。',
    group: 'attack',
  },
  {
    id: 'herd',
    name: '群势',
    summary: '每个相邻友军 +2 攻击（最多 +6）。落单的牛头人只是个大个子。',
    group: 'attack',
  },
  {
    id: 'versatile',
    name: '长短皆可',
    summary: '射程 3，但隔着一格以上打时伤害只有六成。近身是本职，远程是技能。',
    group: 'attack',
  },
  {
    id: 'kite',
    name: '游骑',
    summary: '远程射击时，身边没有敌人 +3 攻击；被贴住 −3。它要的是距离，不是对捅。',
    group: 'attack',
  },
  {
    id: 'elf-shot',
    name: '穿隙',
    summary: '攻击无视目标脚下的地形加成（森林、丘陵、城头都不顶用）。它不是破甲，重甲照旧是重甲。',
    group: 'attack',
  },
  {
    id: 'knockback',
    name: '击退',
    summary: '攻击后把目标推开 1 格（后方可站且没人时）。推不动就只是普通一击。',
    group: 'attack',
  },
  {
    id: 'poison-hit',
    name: '淬毒',
    summary: '打中活人就让其中毒 3 回合，每回合掉 6% 生命上限。打不死人，但会让它不敢站着。',
    group: 'attack',
  },
  {
    id: 'burn-hit',
    name: '燃焰',
    summary: '打中就让其点燃 3 回合，每回合掉 8% 生命上限——怕火的兵翻倍。',
    group: 'attack',
  },
  {
    id: 'slow-hit',
    name: '霜缚',
    summary: '打中就让其减速 2 回合，移动力 −1（最少 1）。',
    group: 'attack',
  },
  {
    id: 'curse-hit',
    name: '咒缚',
    summary: '打中就让其被诅咒 3 回合，护甲 −2。',
    group: 'attack',
  },
  {
    id: 'aoe-immune',
    name: '阵列',
    summary: '免疫溅射伤害：炮火、法术溅射、亡语爆炸都伤不到它。但主目标那一下照吃。',
    group: 'defense',
  },
  {
    id: 'steal-gold',
    name: '窃掠',
    summary: '攻城时额外偷走"伤害 × 2"的金币（不超过对方金库）。砸墙还能顺手捞一笔。',
    group: 'attack',
  },
  {
    id: 'machine',
    name: '机械',
    summary: '无法被治疗：休整、再生、治疗光环、净化对它的生命值都不生效。它只能靠修。',
    group: 'defense',
  },
  {
    id: 'rebirth',
    name: '重生',
    summary: '阵亡时不立刻倒下，而是留下一枚蛋，由玩家在自己回合选一格孵化（一半生命）。每局一次。',
    group: 'defense',
  },
  {
    id: 'split',
    name: '分裂',
    summary: '阵亡时分裂成两只小史莱姆（有空地才分裂）。所以"打死它"不等于"解决它"。',
    group: 'defense',
  },
  {
    id: 'aura-speed',
    name: '疾行光环',
    summary: '相邻友军移动力 +1。',
    group: 'support',
  },
  {
    id: 'curse-aura',
    name: '咒域',
    summary: '相邻敌军护甲 −2。和威吓是同一类：贴上去让对面变弱，破解办法都是拉开。',
    group: 'support',
  },
  {
    id: 'heal-aura',
    name: '治疗光环',
    summary: '回合开始时，自己和相邻友军各恢复 10% 生命上限（机械单位除外）。',
    group: 'support',
  },
  {
    id: 'purge',
    name: '净化',
    summary: '回合开始时，自己和相邻友军各移除**一层**负面状态（中毒→点燃→减速→诅咒的顺序）。',
    group: 'support',
  },
  {
    id: 'purge-greater',
    name: '大净化',
    summary: '回合开始时，半径 2 内友军的负面状态**全部**清空（小净化只解一层，它全解）。',
    group: 'support',
  },
  {
    id: 'repair',
    name: '修缮',
    summary: '回合开始时，修复相邻的己方城市 6 点耐久。城下挨打的时候它是第二根血条。',
    group: 'support',
  },
  {
    id: 'build-wall',
    name: '筑墙',
    summary: '回合开始时，在相邻空格立一道土墙（耐久 20，四回合后自己塌）。用来堵路，或者挡一下冲锋。',
    group: 'support',
  },
  {
    id: 'trap',
    name: '布雷',
    summary: '回合开始时，对贴身的敌军造成 6 点伤害并让其减速 1 回合。走着走着就踩上了。',
    group: 'support',
  },
  {
    id: 'summoner',
    name: '召唤',
    summary: '每隔几个自己的回合，在相邻空格召唤一个随从（有数量上限）。召唤物不占编制。',
    group: 'support',
  },
  {
    id: 'element-mastery',
    name: '属性精研',
    summary:
      '攻击按**当前属性**附带效果：火再点一层、水挂霜缚（移动 −1）、自然攻击时回自己 10% 生命、暗让魔法段 ×1.5。',
    group: 'attack',
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

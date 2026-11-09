/**
 * 奇想兵种包：五个扩展规则，一套法则。
 *
 * 拆成五个而不是一个大包，理由不是"文件太长"，是**玩家的选择粒度**：
 *   · 法则（fantasy-core）  只有机制，没有兵。它是另外四个的前置。
 *   · 骑士团（knights）     人类阵营：前排、骑兵、圣职、刺客。
 *   · 荒兽（beasts）        兽群、飞行、蛮荒、元素之外的野性。
 *   · 秘法（arcane）        法术、亡者、召唤、属性元素。
 *   · 英雄（heroes）        五个全场唯一、首次招募要解锁的大家伙。
 *
 * 为什么要有前置包：魔法攻击、魔法抗性、属性伤害、负面状态、空中层
 * 这五条是**规则**不是兵种。单开一个兵种包，玩家会以为自己买到的是一堆
 * 数值更高的兵，实际上拿到的是半套规则（有魔攻、没魔抗；能飞、不能叠）。
 * 把法则做成一个显式的、必须勾选的前置，成本几乎为零，语义却干净了。
 *
 * 数值口径（和内置兵种对照，别拿"感觉"当平衡）：
 *   用一个粗糙的价值模型 V = 攻 + 0.45×血 + 5×甲 + 3×射程 + 2.5×移 + 1.5×视野
 *   （多动按 攻×(1+0.5×(次数−1))、溅射 +4 计），再看 V/造价：
 *     青铜民兵 1.86、铁器长枪 0.91、火器戟兵 0.81、火枪 0.58、蒸汽步枪 0.45。
 *   便宜兵天然更"值"，这是被 24 人编制上限压着的设计，不是漏洞。
 *   所以这里每个兵只跟**同代**比：铁器 0.55~0.75、火器 0.45~0.65、
 *   蒸汽 0.40~0.50、现代 0.30~0.40。带强机制的再往下压一档，
 *   因为机制的价值不进这个模型。
 *
 * 换来的机制必须是"有代价的"：
 *   掠空要算落点、飞行会和地面叠在一格（被打时也一样）、
 *   冲锋要先动过、狂暴要掉到半血、撕咬要目标残血、重甲难行怕林子、
 *   召唤物占不了编制却也不能当主力、英雄贵在解锁而不是贵在面板。
 */

import {
  ARMOR_STAGE,
  DAMAGE_STAGE,
  HIT_STAGE,
  STAT_STAGE,
  STRIKE_STAGE,
  TURN_START,
  auraTargets,
} from './ability-hooks.ts';
import type { AbilityDef } from './abilities.ts';
import type { Expansion } from './expansions.ts';
import { addMark, markCountOf, marksAt } from './marks.ts';
import type { MarkKindDef } from './marks.ts';
import type { UnitTypeDef } from './types.ts';

/**
 * 林地之主的护甲加成。
 *
 * 定义成常量是因为它有两个消费者：能力自己（statArmor 算实际护甲）和
 * AI 的地形估价（terrainArmor 声明 → terrainArmorOf）。以前两边各写一个 3，
 * 改一处就会悄悄不一致。
 */
const WOODLAND_ARMOR = 3;

/** 召唤物与临时建筑。它们不进产线、不占编制，所以单独放一个数组。 */
export const SUMMONED_UNITS: UnitTypeDef[] = [
  {
    id: 'skeleton',
    name: '骷髅',
    short: '骷',
    era: 2,
    category: 'combat',
    cost: 45,
    move: 3,
    atk: 9,
    armor: 1,
    maxHp: 14,
    range: 1,
    vision: 3,
    summonedOnly: true,
  },
  {
    id: 'slimelet',
    name: '小史莱姆',
    short: '滴',
    era: 2,
    category: 'combat',
    cost: 20,
    move: 2,
    atk: 6,
    armor: 0,
    maxHp: 12,
    range: 1,
    vision: 2,
    summonedOnly: true,
    weak: { fire: 2 },
  },
  {
    id: 'imp',
    name: '小恶魔',
    short: '魔',
    era: 3,
    category: 'combat',
    cost: 55,
    move: 5,
    atk: 12,
    armor: 1,
    maxHp: 16,
    range: 1,
    vision: 4,
    summonedOnly: true,
    flight: true,
    layer: 'air',
  },
  {
    id: 'phantom',
    name: '幻象',
    short: '幻',
    era: 2,
    category: 'combat',
    cost: 40,
    move: 3,
    atk: 14,
    armor: 0,
    maxHp: 18,
    range: 1,
    vision: 3,
    summonedOnly: true,
  },
  // 土墙：土元素每回合立一道。障碍 + 自损，四回合后自己塌，
  // 所以它是"临时封路"而不是"永久改建地图"。
  {
    id: 'earth-wall',
    name: '土墙',
    short: '墙',
    era: 2,
    category: 'building',
    cost: 40,
    move: 0,
    atk: 0,
    armor: 8,
    maxHp: 20,
    range: 1,
    vision: 1,
    summonedOnly: true,
    obstacle: true,
    decays: 5,
  },
];

/**
 * 奇想兵种包的**能力表**：这些兵种的特殊能力，连同实现一起放在这里。
 *
 * 为什么能力不放在本体的 abilities.ts：能力是"这个兵种怎么打"，属于兵种设计。
 * 摆在扩展文件里，删掉「奇想」这套包，它带来的一切（兵、机制、能力）就一起没了；
 * 摆在本体里，删的时候要回本体一行行找哪几段是谁的，而本体也会慢慢变成
 * 一张兵种清单——这正是它以前的样子。
 *
 * 挂在哪一册上：`fantasy-core`（法则）。四个兵种包都要先开它，能力又是
 * 五个包共用的词汇（骑士团有冲锋、荒兽也有），挂在这条公共前置上才对得上语义。
 * 合并由 ability-registry.ts 做，不看本局勾了哪些包——自定义兵种勾了「淬毒」，
 * 在没开奇想的局里也该照样生效。
 *
 * 顺序有意义：它同时是规则书、编辑器里的显示顺序，也是同一个 stage 上
 * 几条钩子的执行顺序。要重排就整块重排，然后跑一遍行为快照。
 */
const FANTASY_ABILITIES: AbilityDef[] = [
  {
    id: 'forest-walk',
    name: '穿林',
    summary: '森林和丘陵的移动消耗按 1 算。',
    group: 'move',
    hooks: {
      moveCost: (c) => (c.terrain === 'forest' || c.terrain === 'hill' ? 1 : undefined),
    },
  },
  {
    id: 'aura-armor',
    name: '守护光环',
    summary: '2 格内的友军护甲 +2。',
    group: 'support',
    // 2026-11-03：相邻 → 2 格。国王这类"阵眼"不该为了发光环而挤进一线，
    // 2 格刚好是"后排压阵、前排吃满"的距离。
    hooks: { aura: { allyArmor: 2, radius: 2 } },
  },
  {
    id: 'kill-rush',
    name: '收割',
    summary:
      '亲手斩杀一个单位后，立刻恢复本回合的移动力（攻击次数不恢复）。杀完能走，但走完还是要等下回合才能再出手。',
    group: 'move',
    hooks: {
      onKill: (c) => {
        c.result.moveBack = true;
      },
    },
  },
  {
    id: 'element-ward',
    name: '同源护壁',
    summary:
      '受到与自身**当前属性**相同的伤害减半。火打火、水打水都只吃一半——但换个属性打它就照常疼。',
    group: 'defense',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.elementMul,
          apply: (c) => {
            if (c.side !== 'defender') return;
            const self = c.api.utype(c.state, c.self.type);
            const own = c.self.element ?? self.element;
            const foe = c.foe ? c.api.utype(c.state, c.foe.type) : undefined;
            const incoming = c.foe?.element ?? foe?.element;
            if (!incoming || !own || incoming !== own) return;
            c.damage = Math.round(c.damage * 0.5);
          },
        },
      ],
    },
  },
  {
    id: 'leap',
    name: '跳跃',
    summary: '一跃过水：水面、森林、丘陵都按 1 步算，河防对它不成立。',
    group: 'move',
    hooks: { crossesWater: true },
  },
  {
    id: 'charge',
    name: '冲锋',
    summary: '本回合移动过时，攻击 +5。',
    group: 'attack',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.attackFlat,
          apply: (c) => {
            if (c.side !== 'attacker') return;
            if (!c.isCounter && c.self.moved) c.damage += 5;
          },
        },
      ],
    },
  },
  {
    id: 'royal-decree',
    name: '王命',
    summary:
      '回合开始时，半径 2 内所有「精英骑兵」晋升为「皇家骑兵」（按血量比例换装，上限不超过新兵种的生命）。每名骑兵只会晋升一次。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.aura,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            // 新兵种直接从兵种表里取：把它写死在能力里，等于以后改 id 要改两处
            const upgraded = 'royal-cavalry';
            if (!c.state.unitTypes[upgraded]) return;
            const to = c.api.utype(c.state, upgraded);
            let n = 0;
            for (const t of c.state.units) {
              if (t.owner !== c.self.owner || t.type !== 'elite-cavalry' || t.hp <= 0) continue;
              if (c.api.distance(t, c.self) > 2) continue;
              const from = c.api.utype(c.state, t.type);
              // 按**比例**换血：一个残血的精英骑兵不该换出一匹满血皇家骑兵，
              // 否则"先打残再晋升"就成了白送的补血手段。
              const ratio = from.maxHp > 0 ? Math.min(1, t.hp / from.maxHp) : 1;
              t.type = upgraded;
              t.hp = Math.max(1, Math.round(to.maxHp * ratio));
              // 不写 moved/acted：晋升发生在自己的回合开始，这两个标记刚被重置过。
              // 在这里把它们置 true，等于"被国王看中的骑兵这一回合原地罚站"。
              n += 1;
            }
            if (n > 0) c.api.pushLog(c.state, c.self.owner, `${def.name}：${n} 名精英骑兵晋升为皇家骑兵`);
          },
        },
      ],
    },
  },
  {
    id: 'lifesteal',
    name: '吸血',
    summary: '造成伤害的 40% 转成自己的生命，上限不超过生命上限。',
    group: 'attack',
    hooks: {
      onStrike: [
        {
          stage: STRIKE_STAGE.afterDamage,
          apply: (c) => {
            if (c.damage <= 0 || c.self.hp <= 0) return;
            const def = c.api.utype(c.state, c.self.type);
            const room = def.maxHp - c.self.hp;
            const healed = Math.min(room, Math.round(c.damage * 0.4));
            if (healed > 0) {
              c.self.hp += healed;
              c.result.healed = healed;
            }
          },
        },
      ],
    },
  },
  {
    id: 'fear',
    name: '威吓',
    summary: '相邻的敌军攻击 −2，最多叠两层。破解办法是拉开距离，或者先把它射掉。',
    group: 'support',
    hooks: { aura: { foeAtk: -2, maxLayers: 2 } },
  },
  {
    id: 'regenerate',
    name: '再生',
    summary: '每回合开始恢复 10% 生命上限，不需要站桩——代价是这种兵通常很慢。',
    group: 'defense',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.self,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            if (!c.healable || c.self.hp >= def.maxHp) return;
            // 「强再生」不是另一条回血，而是把这条翻倍——所以它自己不挂钩子，
            // 由这里读一眼。两条同时挂会变成 10%+20%，那不是设计意图。
            const ratio = c.api.hasAbility(c.state, c.self, 'regenerate-plus') ? 0.2 : 0.1;
            c.self.hp = Math.min(def.maxHp, c.self.hp + Math.ceil(def.maxHp * ratio));
          },
        },
      ],
    },
  },
  // ── 奇想兵种包带来的五条 ───────────────────────────────────────────────
  // 这五条都刻意做成"有代价/有前提"的机制，而不是纯数值加成：
  // 飞行要算落点、冲锋要先动过、吸血要真打疼人、威吓要贴上去、再生换的是慢。
  {
    /*
     * 石化：血量过半之后的另一副身子。
     *
     * 这里**不写任何钩子**，因为它的三件事（护甲翻倍、魔抗 +4、移动减半）
     * 不是"结算时改一个数"，而是要同时影响面板、伤害、走位和 AI 的估算。
     * 做成钩子只能在伤害公式里生效一半，面板和移动力会各说各话。
     *
     * 实际实现放在 `rules.ts` 的 `isPetrified()`，由三个取值口统一读取
     * （ownArmorOf / magicResOf / movePower）。好处是**没有状态**：
     * 血量过线的那一刻它就成立，回到一半以上立刻消失，
     * 不存在"叠了两层只撤一层"或者"血回来了甲还在"这种残留。
     *
     * 判据是严格低于一半（`hp × 2 < maxHp`）。正好半血不触发——
     * 用户给的两条规矩（低于 50% 触发、回到 50% 及以上解除）在 50% 这一点上
     * 是重叠的，取"低于"才不会自相矛盾。
     */
    id: 'stone-skin',
    name: '石化',
    summary:
      '生命低于一半时护甲翻倍、魔法抗性 +4、移动力减半；回到一半以上立刻恢复。血越少越硬，也越走不动。',
    group: 'defense',
    hooks: {},
  },
  {
    id: 'vanish',
    name: '隐匿',
    summary:
      '不挑地形：只要这一回合还没动过、没出过手，敌人就得贴到相邻格才看得见它。一出手就现形。',
    group: 'move',
    hooks: {
      hidden: (c) => !c.self.moved && !c.self.acted,
    },
  },
  {
    id: 'phase',
    name: '穿行',
    summary: '可以穿过敌军（但不能停在敌军身上）。堵枪眼对它没用，它本来就是穿过去的。',
    group: 'move',
    hooks: { passThrough: true },
  },
  {
    id: 'slow-offroad',
    name: '重甲难行',
    summary: '森林、丘陵、城市的进入消耗翻倍。铁罐头在平地上是墙，在树林里是靶子。',
    group: 'move',
    hooks: {
      moveCostMul: (c) =>
        c.terrain === 'forest' || c.terrain === 'hill' || c.terrain === 'city' ? 2 : 1,
    },
  },
  {
    id: 'woodland',
    name: '林地之主',
    summary: '站在森林或丘陵上时护甲 +3。把它赶出林子，它就没那么难打了。',
    group: 'defense',
    hooks: {
      // AI 读这一条来给地形估价（terrainArmorOf），statArmor 读同一个常量来算实际护甲。
      // 两处必须同源，否则"AI 以为值 3、结算只给 1"这种事会静悄悄地发生。
      terrainArmor: [{ terrains: ['forest', 'hill'], bonus: WOODLAND_ARMOR }],
      statArmor: [
        {
          stage: STAT_STAGE.base,
          apply: (c) => {
            const tile = c.api.tileAt(c.state, c.self.x, c.self.y);
            if (!tile || (tile.terrain !== 'forest' && tile.terrain !== 'hill')) return;
            c.armor += WOODLAND_ARMOR;
            c.items.push({ label: '林地之主', delta: WOODLAND_ARMOR });
          },
        },
      ],
      armorPhase: [
        {
          stage: ARMOR_STAGE.woodland,
          apply: (c) => {
            // 只有"我挨打"才给自己加甲。出手时加的是对手的甲，那是反向的
            if (c.side !== 'defender') return;
            const tile = c.api.tileAt(c.state, c.self.x, c.self.y);
            if (!tile || (tile.terrain !== 'forest' && tile.terrain !== 'hill')) return;
            if (!c.ignoreCover) c.armor += 3;
          },
        },
      ],
    },
  },
  {
    id: 'berserk',
    name: '狂暴',
    summary: '生命降到一半以下时攻击 +50%。半血之前它只是个普通兵，半血之后才是麻烦。',
    group: 'attack',
    hooks: {
      statAttack: [
        {
          stage: STAT_STAGE.base,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            if (c.self.hp * 2 > def.maxHp) return;
            const after = Math.round(c.atk * 1.5);
            c.items.push({ label: '狂暴 ×1.5', delta: after - c.atk });
            c.atk = after;
          },
        },
      ],
      damage: [
        {
          stage: DAMAGE_STAGE.attackMul,
          apply: (c) => {
            // 狂暴是"我打人更疼"，不是"我挨打更疼"
            if (c.side !== 'attacker') return;
            const def = c.api.utype(c.state, c.self.type);
            if (c.self.hp * 2 <= def.maxHp) c.damage = Math.round(c.damage * 1.5);
          },
        },
      ],
    },
  },
  {
    id: 'bloodlust',
    name: '嗜血',
    summary: '回合开始时如果生命低于一半，恢复 15% 生命上限；否则什么也不发生。',
    group: 'defense',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.self,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            if (!c.healable || c.self.hp * 2 >= def.maxHp) return;
            c.self.hp = Math.min(def.maxHp, c.self.hp + Math.ceil(def.maxHp * 0.15));
          },
        },
      ],
    },
  },
  {
    id: 'regenerate-plus',
    name: '强再生',
    summary: '再生翻倍：每回合开始恢复 20% 生命上限。',
    group: 'defense',
    // 不挂钩子：它读的是「再生」那条（见上面 regenerate 的注释）。
    // 单独存在时没有效果，和以前的实现一致。
  },
  {
    id: 'tracker',
    name: '追猎',
    summary: '和目标每拉开 1 格攻击 +2（最多 +6）。它擅长的是追杀，不是站桩对捅。',
    group: 'attack',
    // 只对**远程**有意义：射程 1 的兵只有贴身才打得到，"拉开一格"永远不成立，
    // 加成恒为 0（地狱犬挂在它身上好几年，等于白带一个技能——2026-11-04 换掉）。
    // 现在没有兵种挂它了；以后要再给，挂给射程 ≥2 的远程。
    // （规则书里"风帆巡航舰带追猎"那句是旧的，那条船其实没有这个能力。）
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.attackFlat,
          apply: (c) => {
            if (c.side !== 'attacker' || c.isCounter) return;
            c.damage += Math.min(6, Math.max(0, (c.distance - 1) * 2));
          },
        },
      ],
    },
  },
  {
    id: 'maul',
    name: '撕咬',
    summary: '对生命已不足一半的目标攻击 +8。它追的是掉队的残兵，不是排好的方阵。',
    group: 'attack',
    /*
     * 2026-11-04：换掉地狱犬的「追猎」。
     *
     * 追猎按"和目标每拉开一格 +2"结算，而地狱犬射程 1——只有贴脸才打得到，
     * 那个加成在真实对局里**恒为 0**。它能通过用例只是因为用例把两只兵摆在
     * 3 格外强行算了一次伤害，正常走位根本摆不出那个局面。
     *
     * 换成"打残血更疼"，正好接住这只兵本来的定位（7 视野、5 移速、
     * 155 金换 20 攻）：它的活儿是追上去收掉已经掉血的散兵，
     * 而不是跟满编方阵对捅——对捅它 40 血 3 甲顶不住。
     */
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.attackFlat,
          apply: (c) => {
            if (c.side !== 'attacker' || c.isCounter) return;
            if (!c.foe) return;
            const def = c.api.utype(c.state, c.foe.type);
            if (c.foe.hp * 2 < def.maxHp) c.damage += 8;
          },
        },
      ],
    },
  },
  {
    id: 'herd',
    name: '群势',
    summary: '每个相邻友军 +2 攻击（最多 +6）。落单的牛头人只是个大个子。',
    group: 'attack',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.attackFlat,
          apply: (c) => {
            if (c.side !== 'attacker' || c.isCounter) return;
            let allies = 0;
            for (const a of c.state.units) {
              if (a.id === c.self.id || a.owner !== c.self.owner) continue;
              if (c.api.distance(a, c.self) === 1) allies += 1;
              if (allies >= 3) break;
            }
            c.damage += allies * 2;
          },
        },
      ],
    },
  },
  {
    id: 'kite',
    name: '游骑',
    summary: '远程射击时，身边没有敌人 +3 攻击；被贴住 −3。它要的是距离，不是对捅。',
    group: 'attack',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.rangeFlat,
          apply: (c) => {
            if (c.side !== 'attacker' || c.distance < 2) return;
            const pinned = c.state.units.some(
              (u) =>
                u.id !== c.self.id &&
                u.owner !== c.self.owner &&
                u.hp > 0 &&
                c.api.distance(u, c.self) === 1,
            );
            c.damage += pinned ? -3 : 3;
          },
        },
      ],
    },
  },
  {
    id: 'elf-shot',
    name: '穿隙',
    summary:
      '攻击无视目标脚下的地形加成（森林、丘陵、城头都不顶用）。它不是破甲，重甲照旧是重甲。',
    group: 'attack',
    hooks: {
      armorPhase: [
        {
          stage: ARMOR_STAGE.ignoreCover,
          apply: (c) => {
            if (c.side !== 'attacker') return;
            c.armor -= c.terrainBonus;
            c.ignoreCover = true;
          },
        },
      ],
    },
  },
  {
    id: 'knockback',
    name: '击退',
    summary: '攻击后把目标推开 1 格（后方可站且没人时）。推不动就只是普通一击。',
    group: 'attack',
    hooks: {
      onStrike: [
        {
          stage: STRIKE_STAGE.afterStatus,
          apply: (c) => {
            if (c.target.hp <= 0) return;
            const dx = Math.sign(c.target.x - c.self.x);
            const dy = Math.sign(c.target.y - c.self.y);
            if (dx === 0 && dy === 0) return;
            const nx = c.target.x + dx;
            const ny = c.target.y + dy;
            if (!c.api.canStandAt(c.state, nx, ny, c.target.type)) return;
            c.target.x = nx;
            c.target.y = ny;
            c.result.pushed = true;
          },
        },
      ],
    },
  },
  {
    id: 'poison-hit',
    name: '淬毒',
    summary: '打中活人就让其中毒 3 回合，每回合掉 6% 生命上限。打不死人，但会让它不敢站着。',
    group: 'attack',
    hooks: {
      onHit: [
        {
          stage: HIT_STAGE.status,
          apply: (c) => {
            if (c.api.putStatus(c.target, 'poison', 3)) c.touched.push('中毒');
          },
        },
      ],
    },
  },
  {
    id: 'burn-hit',
    name: '燃焰',
    summary: '打中就让其点燃 3 回合，每回合掉 8% 生命上限——怕火的兵翻倍。',
    group: 'attack',
    hooks: {
      onHit: [
        {
          stage: HIT_STAGE.status,
          apply: (c) => {
            const n = c.api.addBurnLayer(c.target);
            if (n > 0) c.touched.push(n === 1 ? '点燃' : `点燃 ${n} 层`);
          },
        },
      ],
    },
  },
  {
    id: 'slow-hit',
    name: '霜缚',
    summary: '打中就让其减速 2 回合，移动力 −1（最少 1）。',
    group: 'attack',
    hooks: {
      onHit: [
        {
          stage: HIT_STAGE.status,
          apply: (c) => {
            if (c.api.putStatus(c.target, 'slow', 2)) c.touched.push('减速');
          },
        },
      ],
    },
  },
  {
    id: 'curse-hit',
    name: '咒缚',
    summary: '打中就让其被咒缚 3 回合，护甲 −4。和普通诅咒不叠加，取强的那一个。',
    group: 'attack',
    hooks: {
      onHit: [
        {
          stage: HIT_STAGE.status,
          apply: (c) => {
            if (c.api.putStatus(c.target, 'curse-deep', 3)) c.touched.push('咒缚');
          },
        },
      ],
    },
  },
  {
    /*
     * 虚咒：3 格内敌军攻击力 −25%。
     *
     * 和「咒域」（相邻护甲 −2）、「威吓」（相邻攻击 −2）是同一族，但两点不同：
     *   · 半径 3，不是贴脸——它是"站远了也能用"的光环，配女巫 3 射程刚好；
     *   · 按**比例**而不是按点数。点数对高攻单位近乎无效（−2 打 40 攻等于没削），
     *     而女巫要压的恰恰是"对面那一下最狠的"。
     *
     * 取强不叠乘：两个女巫不会变成 −50%。
     */
    id: 'hex-weak',
    name: '虚咒',
    summary: '3 格内的敌军攻击力 −25%（多道虚咒取最强的一条，不叠乘）。',
    group: 'support',
    hooks: { aura: { foeAtkPct: 0.25, radius: 3 } },
  },
  {
    id: 'aoe-immune',
    name: '阵列',
    summary: '免疫溅射伤害：炮火、法术溅射、亡语爆炸都伤不到它。但主目标那一下照吃。',
    group: 'defense',
    hooks: { immuneSplash: true },
  },
  {
    id: 'steal-gold',
    name: '窃掠',
    summary: '攻城时额外偷走"伤害 × 2"的金币（不超过对方金库）。砸墙还能顺手捞一笔。',
    group: 'attack',
    hooks: {
      siegeLoot: (c) => {
        if (c.damage <= 0) return;
        const loot = Math.min(c.state.players[c.city.owner].gold, c.damage * 2);
        if (loot > 0) c.result.loot = loot;
      },
    },
  },
  {
    id: 'machine',
    name: '机械',
    summary: '无法被治疗：休整、再生、治疗光环、净化对它的生命值都不生效。它只能靠修。',
    group: 'defense',
    hooks: { healable: false },
  },
  {
    id: 'rebirth',
    name: '重生',
    summary: '阵亡时不立刻倒下，而是留下一枚蛋，由玩家在自己回合选一格孵化（一半生命）。每局一次。',
    group: 'defense',
    hooks: {
      onDeath: (c) => {
        if (c.victim.reborn) return;
        const def = c.api.utype(c.state, c.victim.type);
        // 同一方本来就只该有一个不死鸟，重复登记没有意义；后到的覆盖先到的
        c.state.pendingEgg = {
          owner: c.victim.owner,
          type: c.victim.type,
          x: c.victim.x,
          y: c.victim.y,
          radius: 2,
          // 重生回一半血：从蛋里爬出来只有三成的话，它只是"再死一次"，
          // 而且还得玩家花一次选位的机会去救。一半才算真的站起来。
          hpRatio: 0.5,
        };
        c.api.pushLog(
          c.state,
          c.victim.owner,
          `${def.name} 倒下了，留下一枚蛋——轮到你时选个地方孵化`,
          true,
        );
      },
    },
  },
  {
    id: 'split',
    name: '分裂',
    summary: '阵亡时分裂成两只小史莱姆（有空地才分裂）。所以"打死它"不等于"解决它"。',
    group: 'defense',
    hooks: {
      onDeath: (c) => {
        const def = c.api.utype(c.state, c.victim.type);
        const kid = def.splitInto ?? 'slimelet';
        let born = 0;
        for (let k = 0; k < 2; k += 1) {
          const spot = c.api.freeNeighbor(c.state, c.victim, kid);
          if (!spot) break;
          c.api.spawn(c.state, c.victim.owner, kid, spot.x, spot.y);
          born += 1;
        }
        if (born > 0) c.api.pushLog(c.state, c.victim.owner, `${def.name} 分裂出 ${born} 只小史莱姆`, true);
      },
    },
  },
  {
    id: 'aura-speed',
    name: '疾行光环',
    summary: '相邻友军移动力 +1。',
    group: 'support',
    hooks: { aura: { allyMove: 1 } },
  },
  {
    id: 'curse-aura',
    name: '咒域',
    summary: '相邻敌军护甲 −2。和威吓是同一类：贴上去让对面变弱，破解办法都是拉开。',
    group: 'support',
    hooks: { aura: { foeArmor: -2, maxLayers: 2 } },
  },
  {
    id: 'heal-aura',
    name: '治疗光环',
    summary: '回合开始时，自己和相邻友军各恢复 10% 生命上限（机械单位除外）。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.aura,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            let healed = 0;
            for (const t of auraTargets(c, 1)) {
              const td = c.api.utype(c.state, t.type);
              if (!c.api.canBeHealed(c.state, t) || t.hp >= td.maxHp) continue;
              t.hp = Math.min(td.maxHp, t.hp + Math.ceil(td.maxHp * 0.1));
              healed += 1;
            }
            if (healed > 0) c.api.pushLog(c.state, c.owner, `${def.name} 治愈了 ${healed} 个单位`);
          },
        },
      ],
    },
  },
  {
    id: 'purge',
    name: '净化',
    summary: '回合开始时，自己和相邻友军各移除**一层**负面状态（中毒→点燃→减速→诅咒的顺序）。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.aura,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            let cleansed = 0;
            for (const t of auraTargets(c, 1)) {
              if (!t.status) continue;
              for (const k of ['poison', 'burn', 'slow', 'curse'] as const) {
                if ((t.status[k] ?? 0) > 0) {
                  delete t.status[k];
                  cleansed += 1;
                  break;
                }
              }
            }
            if (cleansed > 0) c.api.pushLog(c.state, c.owner, `${def.name} 净化了 ${cleansed} 个单位的负面状态`);
          },
        },
      ],
    },
  },
  {
    id: 'purge-greater',
    name: '大净化',
    summary: '回合开始时，半径 2 内友军的负面状态**全部**清空（小净化只解一层，它全解）。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.aura,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            let cleansed = 0;
            for (const t of auraTargets(c, 2)) {
              if (!t.status || Object.keys(t.status).length === 0) continue;
              t.status = {};
              cleansed += 1;
            }
            if (cleansed > 0) c.api.pushLog(c.state, c.owner, `${def.name} 净化了 ${cleansed} 个单位的负面状态`);
          },
        },
      ],
    },
  },
  {
    id: 'repair',
    name: '修缮',
    summary: '回合开始时，修复相邻的己方城市 10 点耐久。城下挨打的时候它是第二根血条。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.support,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            for (const city of c.api.citiesOf(c.state, c.owner)) {
              if (c.api.distToCity(c.self, city) > 1 || city.ruined || city.hp >= city.maxHp) continue;
              // 2026-11-07：6 → 10。符文守卫 165 金、只能修 6 点，在同样价钱上
              // 不如多买一个兵——修城这条线本来就只有这一个兵在走，修得不够狠
              // 就等于不存在（400 局里符文守卫 0 次建造）。
              city.hp = Math.min(city.maxHp, city.hp + 10);
              c.api.pushLog(c.state, c.owner, `${def.name} 修缮 ${c.api.cityName(city)}，+10 耐久`);
            }
          },
        },
      ],
    },
  },
  {
    id: 'build-wall',
    name: '筑墙',
    summary: '回合开始时，在相邻空格立一道土墙（耐久 20，四回合后自己塌）。用来堵路，或者挡一下冲锋。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.support,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            const wall = def.builds?.[0] ?? 'earth-wall';
            if (!c.state.unitTypes[wall]) return;
            const spot = c.api.freeNeighbor(c.state, c.self, wall);
            if (!spot) return;
            c.api.spawn(c.state, c.owner, wall, spot.x, spot.y);
            c.api.pushLog(c.state, c.owner, `${def.name} 立起一道土墙`);
          },
        },
      ],
    },
  },
  {
    /*
     * 布雷：回合开始时，在自己**相邻的一圈**陆地上埋一枚哥布林陷阱。
     *
     * 2026-11-03 之前它不是"布雷"，是"贴着就每回合扣 6 血"——那和"埋了一枚雷"
     * 是两件事：它跟人走、跟着人一起动、还永远只作用在贴脸的那一个身上。
     * 真正的雷应该是**留在格子上**的：埋完你可以走，敌人自己踩上去。
     *
     * 现在走的是 `core/marks.ts` 那层留痕（水雷已经用同一套，见 naval-packs 的
     * `nv-mine`）：引擎负责"什么时候触发、扣不扣次数"，这里只负责"埋在哪"。
     *
     * 上限 6 枚（按布设者算）：不封顶的话，一个陷阱师蹲在原地二十回合，
     * 半张地图都会变成雷区。
     */
    id: 'trap',
    name: '布雷',
    summary: '自己回合开始时，在相邻一圈的陆地上埋一枚哥布林陷阱（全场最多 6 枚，只炸敌人）。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.support,
          apply: (c) => {
            const CAP = 6;
            if (markCountOf(c.state, 'gb-mine', c.owner) >= CAP) return;
            const s = c.state;
            const spots: Array<{ x: number; y: number }> = [];
            for (let dy = -1; dy <= 1; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                if (dx === 0 && dy === 0) continue;
                const x = c.self.x + dx;
                const y = c.self.y + dy;
                if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
                const tile = s.tiles[y * s.w + x];
                if (!tile || !LAND_MINE.on!.includes(tile.terrain)) continue;
                if (tile.cityId) continue; // 城里不埋：那是别人的地板
                if (marksAt(s, x, y).length > 0) continue; // 一格只放一件
                // 已经站人的格子也能埋（"脚下有雷"是最自然的一种），
                // 但埋伏在友军脚下永远炸不到人，所以跳过自己人站着的那格。
                if (s.units.some((u) => u.x === x && u.y === y && u.owner === c.owner)) continue;
                spots.push({ x, y });
              }
            }
            if (spots.length === 0) return;
            // 轮转着挑：永远挑第一个的话，蹲在原地会把雷全堆在同一格
            const pick = spots[(s.turn + c.self.x + c.self.y) % spots.length]!;
            addMark(s, {
              kind: 'gb-mine',
              owner: c.owner,
              x: pick.x,
              y: pick.y,
              charges: 1,
              hidden: true,
            });
            c.api.pushLog(
              s,
              c.owner,
              `${c.api.utype(s, c.self.type).name} 在 ${String.fromCharCode(65 + pick.x)}${pick.y + 1} 埋下一枚哥布林陷阱`,
            );
          },
        },
      ],
    },
  },
  {
    id: 'summoner',
    name: '召唤',
    summary: '每隔几个自己的回合，在相邻空格召唤一个随从（有数量上限）。',
    group: 'support',
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.summon,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            const spec = def.summon;
            if (!spec) return;
            if ((c.self.age ?? 0) % Math.max(1, spec.every) !== 0) return;
            const type =
              spec.random && spec.random.length > 0
                ? spec.random[c.api.hashPick(c.state, c.self.x * 37 + c.self.y * 7, spec.random.length)]
                : spec.type;
            if (!type || !c.state.unitTypes[type]) return;
            /*
             * 上限按"这个召唤者产出的所有类型合起来"算，不是按每一种分开算。
             *
             * 2026-11-02 修：原来只数这一次随机抽中的那种，于是「元素召唤师」
             * （random 四种、max 2）实际能养到 4×2=8 只，而它的说明写的是
             * "同时最多 2"。四元素还都不是 summonedOnly，等于把 24 编制吃掉三分之一。
             */
            const outputs = spec.random && spec.random.length > 0 ? spec.random : [type];
            const alive = c.state.units.filter(
              (u) => u.owner === c.owner && outputs.includes(u.type),
            ).length;
            if (alive >= spec.max) return;
            const spot = c.api.freeNeighbor(c.state, c.self, type);
            if (!spot) return;
            c.api.spawn(c.state, c.owner, type, spot.x, spot.y);
            c.api.pushLog(c.state, c.owner, `${def.name} 召唤出 ${c.api.utype(c.state, type).name}`);
          },
        },
      ],
    },
  },
  {
    id: 'element-mastery',
    name: '属性精研',
    summary:
      '攻击按**当前属性**附带效果：火再点一层、水挂霜缚（移动 −1）、自然攻击时回自己 10% 生命、暗让魔法段 ×1.5。',
    group: 'attack',
    hooks: {
      onHit: [
        {
          stage: HIT_STAGE.element,
          apply: (c) => {
            const def = c.api.utype(c.state, c.self.type);
            const own = c.self.element ?? def.element;
            if (own === 'fire') {
              const n = c.api.addBurnLayer(c.target);
              if (n > 0) c.touched.push(n === 1 ? '点燃' : `点燃 ${n} 层`);
            } else if (own === 'water') {
              if (c.api.putStatus(c.target, 'slow', 2)) c.touched.push('霜缚');
            } else if (own === 'nature') {
              const cap = def.maxHp;
              const heal = Math.min(cap - c.self.hp, Math.max(1, Math.round(cap * 0.1)));
              if (heal > 0) {
                c.self.hp += heal;
                c.touched.push(`自然回血 ${heal}`);
              }
            }
            // 暗的那一条在伤害侧（magicMul），这里只管状态和回血
          },
        },
      ],
      magicMul: (c) => {
        const def = c.api.utype(c.state, c.self.type);
        const own = c.self.element ?? def.element;
        return own === 'dark' ? Math.round(c.magic * 1.5) : c.magic;
      },
    },
  },
];

const CORE: Expansion = {
  id: 'fantasy-core',
  scale: 'large',
  name: '奇想·法则',
  // 五个奇想包共用的能力词汇，全在这张表里（实现在上面）
  abilities: FANTASY_ABILITIES,
  summary:
    '奇想兵种的前置基础包：开启「魔法攻击 / 魔法抗性」「属性伤害与弱点」「中毒·点燃·减速·诅咒」四类负面状态，以及「空中层」——飞行单位可以和地面单位站在同一格。',
  hooks: {
    onMatchStart: ({ state }) => {
      // 法则包自己不需要改任何数值，它只是"允许这些字段生效"。
      // 留一条开局战报，是为了让玩家在战报里能确认自己确实开了它。
      state.log.push({
        turn: 1,
        player: 'A',
        text: '奇想法则生效：魔法攻击/魔抗、属性伤害、负面状态、空中层',
      });
    },
  },
};

const KNIGHTS: Expansion = {
  id: 'fantasy-knights',
  scale: 'large',
  name: '奇想·骑士团',
  summary:
    '人类的十七个兵种：剑士、精英骑兵、皇家骑兵、国王、游侠、牧师、法师、刺客、狂战士、圣骑士、超级重骑、皇家守卫、符文守卫、盗贼，以及并入本团的狮鹫骑士、龙骑兵、炼金术士。有魔法、有治疗、有隐身，也有最硬的一块肉；骑兵走"精英升皇家"这条线，国王负责把前者变成后者。',
  requires: ['fantasy-core'],
  hooks: {},
  units: [
    // ── 2 级：四种完全不同的"怎么站住" ────────────────────────────────────
    // 剑士是这一档的尺子：便宜、能顶、没有花招。别的兵和它比价格。
    {
      id: 'swordsman',
      name: '剑士',
      short: '剑',
      era: 2,
      category: 'combat',
      cost: 70,
      move: 2,
      atk: 14,
      armor: 4,
      maxHp: 40,
      range: 1,
      vision: 2,
      abilities: ['shield-wall'],
    },
    // 精英骑兵：原「皇家骑兵」降格而来。4 移动 + 冲锋，价值不在面板，
    // 在"能挑最软的那一格下手"。仍是最便宜的一档骑兵。
    {
      id: 'elite-cavalry',
      name: '精英骑兵',
      short: '精',
      era: 2,
      category: 'combat',
      cost: 125,
      move: 4,
      atk: 16,
      armor: 4,
      maxHp: 40,
      range: 1,
      vision: 3,
      abilities: ['charge'],
    },
    // 皇家骑兵：从 2 代挪到**火器时代**，面板整体抬一档。
    //
    // 挪时代的理由不是"它太强"，而是它原来和精英骑兵挤在同一代同一价位：
    // 两匹马挨着站，贵的那个永远没人买。现在分工清楚了——精英骑兵是
    // 铁器就能买到的机动部队，皇家骑兵是火器时代用钱换的"一锤子"：
    // 38 攻配冲锋，冲开一条线的能力比同价步兵强一截。
    //
    // 数值口径：V = 38 + 0.45×96 + 5×8 + 3 + 2.5×4 + 1.5×4 ≈ 140，V/造价 ≈ 0.60，
    // 落在火器档（0.45~0.65）的上沿——它是这一档最贵的骑兵，值这个位。
    {
      id: 'royal-cavalry',
      name: '皇家骑兵',
      short: '皇',
      era: 3,
      category: 'combat',
      cost: 235,
      move: 4,
      atk: 38,
      armor: 8,
      maxHp: 96,
      range: 1,
      vision: 4,
      abilities: ['charge'],
    },
    // 国王：不靠打，靠"把骑兵变成更好的骑兵"。
    //
    // 王命是**被动**（回合开始自动结算），所以它的价值不取决于玩家点得准不准，
    // 而取决于这一局你带了多少精英骑兵——买它之前先看一眼自己的产线，
    // 这就是它和别的英雄最不一样的地方。
    // 声望光环（守护光环）是配套：国王站的这一片，本来就该比别处难啃。
    {
      id: 'royal-king',
      name: '国王',
      short: '君',
      era: 4,
      category: 'combat',
      cost: 330,
      move: 2,
      atk: 26,
      armor: 10,
      maxHp: 120,
      range: 1,
      vision: 5,
      abilities: ['royal-decree', 'aura-armor'],
    },
    // 游侠：唯一一个"进了林子变强"的远程。走位就是它的护甲。
    {
      id: 'ranger',
      name: '游侠',
      short: '侠',
      era: 2,
      category: 'combat',
      cost: 95,
      move: 3,
      atk: 13,
      armor: 2,
      maxHp: 26,
      range: 3,
      vision: 4,
      abilities: ['forest-walk', 'woodland'],
    },
    // 牧师：不打人，管两件事——回血、洗状态。这两个动作在后期都很贵。
    {
      id: 'priest',
      name: '牧师',
      short: '牧',
      era: 2,
      category: 'combat',
      cost: 105,
      move: 2,
      atk: 9,
      armor: 2,
      maxHp: 30,
      range: 2,
      vision: 4,
      magicAtk: 6,
      magicRes: 3,
      element: 'light',
      abilities: ['heal-aura', 'purge'],
    },
    // 盗贼：攻城顺手捞钱。它存在的意义是让"打不动城墙"也有一点回报。
    {
      id: 'thief',
      name: '盗贼',
      short: '贼',
      era: 2,
      category: 'combat',
      cost: 85,
      move: 3,
      atk: 13,
      armor: 2,
      maxHp: 26,
      range: 1,
      vision: 4,
      abilities: ['stealth', 'steal-gold'],
    },
    // ── 3 级 ──────────────────────────────────────────────────────────────
    // 超级重骑：9 甲 67 血，还能冲锋。代价是森林/丘陵/城市的进入消耗翻倍——
    // 平地上它是墙，进了林子它是靶子。这条地形代价比削数值更能定性。
    // 2026-11-07：8 甲 62 血 → 9 甲 67 血。同代的皇家骑兵（235 金）把这一档吃干了，
    // 它 205 金却只多 3 甲、少 34 血——加一档甲不是为了让它变强，是为了让"最硬的一块铁"
    // 这个说法站得住（9 甲是全包最高，和神圣骑士长同档）。
    {
      id: 'cataphract',
      name: '超级重骑',
      short: '重',
      era: 3,
      category: 'combat',
      cost: 205,
      move: 4,
      atk: 24,
      armor: 9,
      maxHp: 67,
      range: 1,
      vision: 3,
      abilities: ['charge', 'slow-offroad'],
    },
    // 法师：魔攻 18 不吃护甲。打重甲是主力，被骑兵贴上是提款机。
    {
      id: 'mage',
      name: '法师',
      short: '法',
      era: 3,
      category: 'combat',
      cost: 150,
      move: 2,
      atk: 7,
      armor: 1,
      maxHp: 24,
      range: 3,
      vision: 4,
      magicAtk: 18,
      element: 'arcane',
      splash: 1,
    },
    // 刺客：隐匿 + 26 攻。它的强不在换血，在"先手选一个软的打掉"。
    {
      id: 'assassin',
      name: '刺客',
      short: '刺',
      era: 3,
      category: 'combat',
      cost: 135,
      move: 4,
      atk: 26,
      armor: 2,
      maxHp: 28,
      range: 1,
      vision: 3,
      abilities: ['vanish'],
    },
    // 狂战士：半血之后才是它。逼对手在"打死它"和"被它多换一个"之间选。
    {
      id: 'berserker',
      name: '狂战士',
      short: '狂',
      era: 3,
      category: 'combat',
      cost: 120,
      move: 3,
      /*
       * 2026-11-03（三）：改成**连击 2 段、每段 15**（`burst: 2`）。
       *
       * 一次出手打两下，每一下各自减一次护甲——这是连击真正的味道：
       * 对 0~5 甲的兵是加强（两段加起来比一刀多打一截），对重甲反而更钝
       * （15−护甲 再乘 2，护甲越高亏得越多）。半血狂暴对两段各自 ×1.5，
       * 总量仍是一刀时的 1.5 倍，不会因为分段而吃掉加成。
       *
       * 36 血以上的老数据（atk 24 单发）在这里不留兼容：这个兵种只在
       * 「奇想·骑士团」包里，别的单位和扩展一行都没动。
       */
      atk: 15,
      burst: 2,
      armor: 2,
      maxHp: 44,
      range: 1,
      vision: 3,
      abilities: ['berserk'],
    },
    // 圣骑士：全游戏唯一"边挡边奶"的兵。数值不高，但一条线有它就是另一条线。
    {
      id: 'paladin',
      name: '圣骑士',
      short: '圣',
      era: 3,
      category: 'combat',
      cost: 215,
      move: 3,
      atk: 24,
      armor: 7,
      maxHp: 58,
      range: 1,
      vision: 3,
      magicAtk: 5,
      magicRes: 4,
      element: 'light',
      abilities: ['aura-armor', 'heal-aura'],
    },
    // 符文守卫：不打架，修城。城被打到 5 点耐久的时候，它一人顶一次防守。
    {
      id: 'rune-guardian',
      name: '符文守卫',
      short: '符',
      era: 3,
      category: 'combat',
      cost: 165,
      move: 2,
      atk: 18,
      armor: 6,
      maxHp: 50,
      range: 1,
      vision: 3,
      magicRes: 5,
      abilities: ['repair', 'shield-wall'],
    },
    // ── 4 级 ──────────────────────────────────────────────────────────────
    // 皇家守卫：唯一一个"炮打不动"的兵。它针对的就是溅射体系。
    {
      id: 'royal-guard',
      name: '皇家守卫',
      short: '卫',
      era: 4,
      category: 'combat',
      cost: 255,
      move: 2,
      atk: 26,
      armor: 10,
      maxHp: 66,
      range: 1,
      vision: 2,
      abilities: ['aoe-immune', 'shield-wall'],
    },
    // ── 并入骑士团的三位 ──────────────────────────────────────────────────
    // 这三个原本挂在「荒兽」和「秘法」上，现在收进骑士团：它们的用法
    // 都是"跟着阵线走"，而不是荒兽那种"散开咬人"、秘法那种"站在后面放"。
    // 数值一个没动——这次只换归属，不动平衡，免得以后分不清
    // "是搬家改弱的"还是"本来就弱"。
    //
    // 狮鹫骑士：骑士团唯一的空中单位。五速、六视野，抓后排和探路都靠它。
    {
      id: 'griffin-rider',
      name: '狮鹫骑士',
      short: '鹫',
      era: 3,
      category: 'combat',
      cost: 190,
      move: 5,
      atk: 22,
      armor: 4,
      maxHp: 44,
      range: 1,
      vision: 6,
      flight: true,
      layer: 'air',
    },
    // 龙骑兵：飞行 + 冲锋 + 溅射。三条机制叠在一个兵上，所以面板压得低。
    //
    // 2026-11-07 升到 4 代。原因是它在 3 代的标准池里是首签最强的一张：
    // 时代 3 / 20×20 的 200 局里，"首签摸到龙骑兵"的那一侧胜率 83%（18 局），
    // 和火枪手（92%）、迫击炮（67%）一起构成了 3 代选卡的固定答案。
    // 数值一个不动——升代之后时代谱更硬，等效血被压低，战力自己从 152.7
    // 掉到 132.6，265 金的性价比 6.16 仍在 4 代中位（5.60）之上，
    // 它本来就该是"贵而强"的那张，不需要再补一刀。
    {
      id: 'dragoon-rider',
      name: '龙骑兵',
      short: '龙',
      era: 4,
      category: 'combat',
      cost: 265,
      move: 5,
      atk: 26,
      armor: 6,
      maxHp: 58,
      range: 1,
      vision: 6,
      splash: 1,
      flight: true,
      layer: 'air',
      abilities: ['charge'],
    },
    // 炼金术士：六发。前三发改变战场，后三发是余量，打光就退回近战。
    //
    // 2026-11-07 整体上调一档：代 3 → 4，射程 +1、视野 +1、护甲 +1、血 +10、
    // 魔法 +8（15 → 23），价格 165 → 240。
    //
    // 价格是照"代 4 中位性价比"定的，不是拍脑袋：这套面板把战力从 67.8
    // 推到 114.1（×1.68）。留在 165 金，它的性价比会是 6.88——正好是 4 代
    // 35 个战斗兵里最高的一档（中位 5.60），等于换了个更强的身体还降了价。
    // 240 金把它压回 5.60，即"在 4 代当个标准远程"，这也和它 240 金
    // 落在吸血鬼 / 狼人（235）同一档的事实对得上。
    //
    // 魔攻只给 +8 而不是按血/甲同比例加：它的伤害结构是"六发里前三发改变
    // 战场"，弹药是硬上限，加魔攻的边际收益比加血更陡——+8 已经把一发
    // 对轻甲的期望从 12 抬到 20，再往上就该改弹药数了。
    {
      id: 'alchemist',
      name: '炼金术士',
      short: '炼',
      era: 4,
      category: 'combat',
      cost: 240,
      move: 2,
      atk: 9,
      armor: 3,
      maxHp: 40,
      range: 4,
      vision: 5,
      magicAtk: 23,
      element: 'fire',
      splash: 1,
      ammo: 6,
      abilities: ['burn-hit'],
    },
  ],
};

/**
 * 哥布林陷阱：哥布林陷阱师埋下的东西（留痕层，不是单位）。
 *
 * 三条刻意的选择：
 *   · **只认陆地**：水面/浅滩/桥都不埋。桥面是最想埋的地方，但那会让
 *     "过桥"变成一个纯掷骰子行为，而且桥本身会被踩塌——两件事叠在一起太吵。
 *   · **只炸敌人**：自己的雷区自己人走过去天经地义，这也是 `trigger: 'enemy'`
 *     存在的原因（水雷同理）。
 *   · **伤害不走进攻公式**：不加护甲、不算地形、不触发反击。雷不跟你讲武德。
 *     10 点：4 代之前一个兵 24~40 血，一枚雷约等于三成血，踩两枚就得回城。
 */
const LAND_MINE: MarkKindDef = {
  // id 仍叫 `gb-mine`：它已经进了存档与战报，改名会让老存档里的陷阱查不到种类。
  // 改的只是显示名——玩家看到的是"哥布林陷阱"。
  id: 'gb-mine',
  name: '哥布林陷阱',
  summary: '敌人踩上来就炸 10 点（无视护甲）并减速 1 回合，炸完就没。自己人踩不到。',
  tags: ['mine', 'land'],
  hidden: true,
  on: ['plain', 'forest', 'hill', 'mountain', 'plateau', 'valley', 'marsh', 'dune'],
  trigger: 'enemy',
  detect: 1,
  onEnter: (c) => {
    if (!c.unit) return;
    const def = c.api.utype(c.unit.type);
    c.api.hurt(c.unit, 10, `${def.name} 踩响哥布林陷阱，损失 10 点生命`);
    const st = (c.unit.status ??= {});
    st.slow = Math.max(st.slow ?? 0, 1);
    c.api.log(c.mark.owner, `哥布林陷阱命中 ${def.name}`);
  },
};

const BEASTS: Expansion = {
  id: 'fantasy-beasts',
  scale: 'large',
  name: '奇想·荒兽',
  summary:
    '十六个野性单位：狼骑士、蜘蛛骑士、蛇人、蝙蝠、树人、食人魔、双头巨人、半人马、牛头人、巨魔、狼人、史莱姆、哥布林陷阱师、石像鬼、鹰身女妖、骷髅飞龙。便宜的快、贵的硬，怕火的特别多。',
  requires: ['fantasy-core'],
  hooks: {},
  units: [
    // ── 1 级：蛇人当前排、蝙蝠当骚扰（2026-11-07 蝙蝠从二代 90 金压到一代 35 金）
    {
      // 蛇人：2026-11-02 护甲 3→6。它只有一个中毒、没有任何减伤手段，
      // 95 金这个价位上原本被 65 金的长枪兵全面压住。
      // 2026-11-03 平衡调整：护甲 6→8、生命 34→30。往"硬而薄"的方向掰——
      // 同样的有效血量，吃物理更省、吃魔法和穿透更亏，让它和"堆血"的兵分开。
      // 2026-11-04：整兵下放到第 1 代（95 金 / 15 攻 / 34 血 → 72 金 / 12 攻 / 26 血）。
      // 二代那个价位上它是个"贵而慢"的怪，第 1 代拿它当"高甲前排"才有位置——
      // 一级兵全是 2~3 甲的裸身，8 甲在这一档是唯一的卖点。
      id: 'serpent-man',
      name: '蛇人',
      short: '蛇',
      era: 1,
      category: 'combat',
      cost: 72,
      move: 3,
      atk: 12,
      armor: 8,
      // 2026-11-03 数值复核：30 → 34。8 甲挡物理很硬，但 30 血在魔法和
      // 穿透面前一触即溃，100 局零建造。加血是它唯一不会破坏"高甲低血"定位的改法。
      // 2026-11-04 下放到一代后压回 26：一代的对手输出只有 11~13，26 血已经够扛。
      maxHp: 26,
      range: 1,
      vision: 3,
      abilities: ['poison-hit'],
    },
    // ── 2 级：便宜、快、脆，靠数量和时间差 ────────────────────────────────
    {
      id: 'wolf-rider',
      name: '狼骑士',
      short: '狼',
      era: 2,
      category: 'combat',
      cost: 55,
      move: 4,
      atk: 11,
      armor: 1,
      // 2026-11-03 数值复核：24 → 30。采用率 66%、交换比 0.21——
      // 造得多、死得也多。加血不加攻：它的问题是"冲过去就没了"，
      // 不是"打不动人"。30 血能让它多扛一次普攻，活着回来才有下一次骚扰。
      maxHp: 30,
      range: 1,
      vision: 4,
      // 便宜、快、不值钱：它不靠打架赢，靠"林子拦不住它"赢。
      abilities: ['forest-walk'],
    },
    // 蜘蛛骑士：无视地形（能掠水、林子丘陵按 1 步）。追不上的侦察。
    // 挂的是「跳跃」不是「飞行」——蜘蛛是跳过去，不是飞过去，名字得跟画面一致。
    {
      id: 'spider-rider',
      name: '蜘蛛骑士',
      short: '蛛',
      era: 2,
      category: 'combat',
      cost: 78,
      move: 4,
      // 2026-11-03 数值复核：13 → 16。每百金输出 6.6、交换比 0.28，
      // 比 55 金的狼骑士还低——同样是"快而脆"，它连骚扰都算不上。
      atk: 16,
      armor: 2,
      maxHp: 28,
      range: 1,
      vision: 6,
      abilities: ['leap'],
    },
    /*
     * 蝙蝠：三段连击，飞着走，脆得像纸。
     *
     * 2026-11-07 整兵重做（原来叫"毒蝙蝠"，90 金 / 22 血 / 带淬毒 / 二代）：
     * 它当时的位置很尴尬——同代有狼骑士（55 金、30 血）、蜘蛛骑士（78 金、4 移 6 视），
     * 90 金买一个 22 血的脆皮，谁都不会买（400 局只出场 14 次）。
     * 现在往下压到**青铜**，35 金 / 10 血，去掉淬毒：它变成"最便宜的三段连击"，
     * 用来补刀和骚扰，而不是站场。id 保持不变（存档、战报、跑批脚本都认它）。
     */
    {
      id: 'poison-bat',
      name: '蝙蝠',
      short: '蝠',
      era: 1,
      category: 'combat',
      cost: 35,
      move: 5,
      atk: 7,
      armor: 1,
      maxHp: 10,
      range: 1,
      vision: 5,
      burst: 3,
      flight: true,
      layer: 'air',
      abilities: [],
    },
    {
      id: 'centaur',
      name: '半人马',
      short: '人',
      era: 2,
      category: 'combat',
      cost: 105,
      move: 4,
      atk: 13,
      armor: 2,
      maxHp: 30,
      range: 3,
      vision: 4,
      // 机动射手：会跑还要会站。身边干净时那一箭才准。
      abilities: ['kite'],
    },
    // 史莱姆：打死它要花两下，因为第一下只把它变成两只小的。
    {
      // 史莱姆：2026-11-02 生命 36→50。它是"打死要花两下"的单位，
      // 但 36 血连第一下都扛不住——两只小史莱姆还没落地就先没了一个。
      id: 'slime',
      name: '史莱姆',
      short: '史',
      era: 2,
      category: 'combat',
      cost: 60,
      move: 2,
      atk: 9,
      armor: 1,
      maxHp: 50,
      range: 1,
      vision: 2,
      abilities: ['split'],
      splitInto: 'slimelet',
      weak: { fire: 2 },
    },
    // 哥布林陷阱师：不靠数值，靠"你敢不敢贴上来"。
    {
      id: 'goblin-trapper',
      name: '哥布林陷阱师',
      short: '陷',
      era: 2,
      category: 'combat',
      cost: 80,
      move: 3,
      atk: 12,
      armor: 1,
      maxHp: 24,
      range: 1,
      vision: 4,
      abilities: ['trap'],
    },
    // ── 3 级 ──────────────────────────────────────────────────────────────
    // 树人：林子里是墙，平地上是木头。怕火，被点着要掉双倍。
    {
      id: 'treant',
      name: '树人',
      short: '树',
      era: 3,
      category: 'combat',
      cost: 175,
      move: 2,
      // 2026-11-03 数值复核：23 → 26。
      // 100 局：每百金输出 12.8、每百金承伤 37.6、交换比 0.34——挨得最多、打得最少。
      // 它的定位是"能扛能砸墙的慢树"，那就该在"扛住之后打得出伤害"上补一点。
      atk: 26,
      armor: 6,
      maxHp: 70,
      range: 1,
      vision: 3,
      abilities: ['regenerate', 'woodland', 'siege-master'],
      weak: { fire: 1.5 },
    },
    {
      id: 'ogre',
      name: '食人魔',
      short: '魔',
      era: 3,
      category: 'combat',
      cost: 190,
      move: 2,
      atk: 27,
      armor: 5,
      maxHp: 72,
      range: 1,
      vision: 2,
      abilities: ['lifesteal'],
    },
    {
      id: 'minotaur',
      name: '牛头人',
      short: '牛',
      era: 3,
      category: 'combat',
      // 2026-11-07：165 → 155。同代的巨魔 170、食人魔 190 都比它厚，
      // 它唯一的卖点是冲锋 + 群势（身边友军越多越硬），而那要先买得起才行。
      cost: 155,
      move: 3,
      atk: 21,
      armor: 4,
      maxHp: 58,
      range: 1,
      vision: 3,
      abilities: ['charge', 'herd'],
    },
    {
      // 巨魔：怕火（×2）换来的是一身再生 + 石化。
      // 石化让它变成"打不死的两段式"：前半条血是 4 甲 2 移的普通怪，
      // 后半条血变 8 甲 1 移——你越打它越难打，但同时也越追不上你。
      id: 'troll',
      name: '巨魔',
      short: '巨',
      era: 3,
      category: 'combat',
      cost: 170,
      move: 2,
      atk: 24,
      armor: 4,
      maxHp: 68,
      range: 1,
      vision: 3,
      abilities: ['regenerate', 'stone-skin'],
      weak: { fire: 2 },
    },
    // 石像鬼：半血从"会飞的石头"变成"会飞的疯子"。
    {
      id: 'gargoyle',
      name: '石像鬼',
      short: '石',
      era: 3,
      category: 'combat',
      cost: 150,
      move: 4,
      // 同上：狂暴变强之后，石像鬼满血时更像个"会飞的石头"，半血才变疯子
      atk: 17,
      armor: 5,
      maxHp: 40,
      range: 1,
      vision: 5,
      magicRes: 3,
      flight: true,
      layer: 'air',
      abilities: ['berserk'],
    },
    {
      id: 'harpy',
      name: '鹰身女妖',
      short: '鹰',
      era: 3,
      category: 'combat',
      cost: 120,
      move: 6,
      atk: 15,
      armor: 1,
      maxHp: 24,
      range: 2,
      vision: 6,
      flight: true,
      layer: 'air',
    },
    // ── 4 级 ──────────────────────────────────────────────────────────────
    {
      id: 'werewolf',
      name: '狼人',
      short: '狼',
      era: 4,
      category: 'combat',
      cost: 235,
      move: 3,
      // 攻击 25 配 50% 狂暴等于半血 37.5，一台 235 金的绞肉机。压到 22：
      // 满血它只是个厚实的肉盾，掉到一半才变成需要优先处理的麻烦。
      atk: 22,
      armor: 5,
      maxHp: 70,
      range: 1,
      vision: 4,
      abilities: ['berserk', 'bloodlust'],
    },
    // 双头巨人：两段攻击 + 破城。打重甲亏，拆城墙赚。
    {
      id: 'two-head-giant',
      name: '双头巨人',
      short: '双',
      era: 4,
      category: 'combat',
      cost: 300,
      move: 2,
      atk: 27,
      armor: 6,
      maxHp: 88,
      range: 1,
      vision: 3,
      burst: 2,
      abilities: ['siege-master'],
    },
    // ── 5 级：飞行的攻坚 ──────────────────────────────────────────────────
    {
      id: 'bone-dragon',
      name: '骷髅飞龙',
      short: '骸',
      era: 5,
      category: 'combat',
      cost: 430,
      move: 5,
      atk: 42,
      armor: 8,
      maxHp: 92,
      range: 1,
      vision: 6,
      flight: true,
      layer: 'air',
      abilities: ['siege-master'],
    },
  ],
  // 哥布林陷阱是"荒兽"这一家带来的格子上的东西（陷阱师埋的）
  marks: [LAND_MINE],
};

const ARCANE: Expansion = {
  id: 'fantasy-arcane',
  scale: 'large',
  name: '奇想·秘法',
  summary:
    '法术与亡者：德鲁伊、死灵法师、吟游诗人、巫医、女巫、诅咒骑士、诅咒师、幻术师、元素召唤师、四种元素、幽灵、吸血鬼、僵尸、恶魔、地狱犬、机关傀儡、精灵弓手，以及被召唤的骷髅、小恶魔、幻象、土墙。',
  requires: ['fantasy-core'],
  hooks: {},
  units: [
    // ── 1 级：一具会走路的掩体。全包唯一的一级兵 ──────────────────────────
    {
      // 僵尸：一回合只能走一格。它存在的意义是挡在门口，不是输出。
      // 2026-11-04：下放到第 1 代，跟着把价和数值一起压下来
      // （70 金 / 13 攻 / 52 血 → 45 金 / 9 攻 / 42 血）。
      // 一代的兵都在 25~50 金、11~14 攻这个区间，52 血 70 金的僵尸
      // 在这一档是"谁也打不死、谁也追不上"，放在一代只能当纯沙包，
      // 所以血量必须跟着降——不然它会变成一道 45 金的门。
      id: 'zombie',
      name: '僵尸',
      short: '僵',
      era: 1,
      category: 'combat',
      cost: 45,
      move: 1,
      atk: 9,
      armor: 3,
      maxHp: 42,
      range: 1,
      vision: 2,
      // 它一回合只能走一格，所以"没挪窝就减伤"对它来说几乎是常驻的——
      // 这不是白送：想吃到它就得放弃推进，一座会走路的掩体换不来一座城。
      abilities: ['shield-wall'],
      weak: { fire: 2 },
    },
    // ── 2 级 ──────────────────────────────────────────────────────────────
    // 吟游诗人：两个光环。它自己不打，但它让三条线同时变快、变狠。
    {
      id: 'bard',
      name: '吟游诗人',
      short: '吟',
      era: 2,
      category: 'combat',
      cost: 115,
      move: 3,
      atk: 10,
      armor: 2,
      maxHp: 28,
      range: 2,
      vision: 4,
      abilities: ['aura-command', 'aura-speed'],
    },
    // ── 3 级：法术一档，全部脆、全部靠射程活 ───────────────────────────────
    {
      id: 'druid',
      name: '德鲁伊',
      short: '德',
      era: 3,
      category: 'combat',
      cost: 155,
      move: 2,
      atk: 8,
      armor: 2,
      maxHp: 30,
      range: 3,
      vision: 4,
      magicAtk: 15,
      element: 'nature',
      abilities: ['woodland', 'forest-walk'],
    },
    // 死灵法师：每 2 回合一个骷髅，最多 4 个。它转变的是"时间"，不是伤害。
    {
      id: 'necromancer',
      name: '死灵法师',
      short: '灵',
      era: 3,
      category: 'combat',
      cost: 175,
      move: 2,
      atk: 8,
      armor: 1,
      maxHp: 28,
      range: 3,
      vision: 4,
      magicAtk: 12,
      element: 'dark',
      abilities: ['summoner'],
      summon: { type: 'skeleton', every: 2, max: 4 },
    },
    {
      id: 'witch-doctor',
      name: '巫医',
      short: '巫',
      era: 3,
      category: 'combat',
      cost: 185,
      move: 2,
      atk: 10,
      armor: 2,
      maxHp: 32,
      range: 3,
      vision: 4,
      magicAtk: 10,
      element: 'nature',
      splash: 1,
      abilities: ['heal-aura'],
    },
    // 女巫：一片伤害 + 诅咒 + 一点魔攻。三种频率压在同一格上。
    {
      // 女巫：2026-11-02 护甲 1→2、生命 26→30（之前是所有法师里最脆的一个，
      // 而她的价值要靠"贴上去打三格"才能兑现，站不住就什么都做不了）。
      //
      // 2026-11-07 整兵下放到第 2 代，数值与造价一起降：
      //   160 金 / 攻 7 魔 13 / 血 30  →  120 金 / 攻 5 魔 9 / 血 24
      // 依据不是"看着贵"，是同一把尺子量出来的：改之前她新尺子 4.76、旧尺子 4.06，
      // 是三代远程里最划算的一档；而三代真正的毛病是**九个远程挤在 120~175 金**
      // （见 docs/FANTASY-OVERLAP.md 的 G10）。把她挪到二代，那个坑位少一个，
      // 二代多一个"带溅射的法师"——二代原来只有游侠和半人马两个远程，
      // 都是单体。
      // 降完之后：新 3.87 / 旧 3.19，落在这代的 2.34~4.66 / 1.72~3.30 区间里偏上，
      // 位置在游侠（4.10 / 3.30）之下——她多出溅射、掠空、虚咒三样，值这个差。
      //
      // 2026-11-07 三次调整（当天，推翻上面那次）：删掉「掠空」、血 19 → 25。
      //
      // 选卡体检 100 局（docs/DRAFT-STATS-2026-11-07.md）量出来的：她在时代 1
      // 胜率 87.2%（n=86，z=+10.3），进池 87%、被选率 100%，抢不到就输。
      // 查下来跟血量无关——「掠空」带 airLayer，她在**空中层**，而时代 1 的
      // 地面近战射程全是 1，canStrike 对空中单位要求射程 ≥ 2，根本打不到她；
      // 唯一能对空的弓手每局都被 AI 禁掉。于是 115 金的 3 射程法师在青铜局无解，
      // 19 血一点不重要——上一刀砍在了不需要砍的地方。
      //
      // 现在：删掉掠空，她重新变成"能被近战围死的远程"，血回调到 25
      // （比原来的 30 少一点、比 19 像个活人）；115 金的价位不动。
      // 代价要认：她不能再掠水，森林丘陵也不再按 1 步算，移速仍是 2。
      id: 'witch',
      name: '女巫',
      short: '女',
      era: 2,
      category: 'combat',
      cost: 115,
      move: 2,
      atk: 5,
      armor: 2,
      maxHp: 25,
      range: 3,
      vision: 5,
      magicAtk: 9,
      element: 'dark',
      splash: 1,
      // 「咒缚」换成「虚咒」（3 格内敌军攻击力 −25%）：原来那套"打中才贴护甲 −4"
      // 要靠她站到射程里才有用，而她是全场最脆的法师——换成常驻光环之后，
      // 她的价值从"敢不敢贴"变成"站在哪"，这才是这个兵种该有的问题。
      // 「掠空」见上面那段：它是"打不到"的根源，不是"站得住"的补丁。
      abilities: ['hex-weak'],
    },
    {
      id: 'cursed-knight',
      name: '诅咒骑士',
      short: '咒',
      era: 3,
      category: 'combat',
      cost: 195,
      move: 4,
      atk: 22,
      armor: 6,
      maxHp: 54,
      range: 1,
      vision: 3,
      abilities: ['charge', 'curse-aura'],
    },
    {
      id: 'curser',
      name: '诅咒师',
      short: '诅',
      era: 3,
      category: 'combat',
      cost: 145,
      move: 2,
      atk: 8,
      armor: 1,
      maxHp: 28,
      range: 3,
      vision: 4,
      magicAtk: 12,
      element: 'dark',
      abilities: ['curse-hit', 'fear'],
    },
    // 幻术师：召唤"幻象"——攻击力是真的，血是假的。诱它来打你。
    {
      id: 'illusionist',
      name: '幻术师',
      short: '幻',
      era: 3,
      category: 'combat',
      cost: 160,
      move: 2,
      atk: 8,
      armor: 1,
      maxHp: 26,
      range: 3,
      vision: 5,
      magicAtk: 10,
      abilities: ['summoner'],
      summon: { type: 'phantom', every: 3, max: 2 },
    },
    {
      id: 'fire-elemental',
      name: '火元素',
      short: '火',
      era: 3,
      category: 'combat',
      cost: 170,
      move: 3,
      atk: 21,
      armor: 4,
      maxHp: 48,
      range: 1,
      vision: 4,
      magicAtk: 8,
      element: 'fire',
      abilities: ['burn-hit'],
      weak: { water: 2 },
    },
    {
      id: 'water-elemental',
      name: '水元素',
      short: '水',
      era: 3,
      category: 'combat',
      cost: 160,
      move: 3,
      atk: 17,
      armor: 4,
      maxHp: 52,
      range: 1,
      vision: 4,
      magicAtk: 6,
      element: 'water',
      abilities: ['slow-hit'],
      weak: { fire: 1.5 },
      // 抗性按倍率算：这里是"水伤打七折"，不是"少挨 4 点"
      resist: { water: 0.7 },
    },
    // 土元素：10 甲 + 每回合立一道墙。它的作用是"把路堵住"，不是"打死谁"。
    {
      id: 'earth-elemental',
      name: '土元素',
      short: '土',
      era: 3,
      category: 'combat',
      cost: 190,
      move: 2,
      atk: 20,
      armor: 9,
      maxHp: 66,
      range: 1,
      vision: 2,
      magicRes: 4,
      abilities: ['build-wall'],
      builds: ['earth-wall'],
    },
    {
      id: 'air-elemental',
      name: '风元素',
      short: '风',
      era: 3,
      category: 'combat',
      cost: 165,
      move: 5,
      atk: 19,
      armor: 3,
      maxHp: 42,
      range: 1,
      vision: 5,
      flight: true,
      layer: 'air',
      abilities: ['knockback'],
    },
    // 幽灵：穿行 + 5 魔抗。堵枪眼对它无效；怕光，天使和圣骑士能治它。
    {
      id: 'ghost',
      name: '幽灵',
      short: '魂',
      era: 3,
      category: 'combat',
      cost: 130,
      move: 4,
      atk: 18,
      armor: 2,
      maxHp: 30,
      range: 1,
      vision: 4,
      magicRes: 5,
      abilities: ['phase'],
      weak: { light: 2 },
    },
    // 地狱犬：7 视野 + 撕咬。它专杀撤退的残兵，正面顶不住。
    {
      id: 'hellhound',
      name: '地狱犬',
      short: '犬',
      era: 3,
      category: 'combat',
      cost: 155,
      move: 5,
      atk: 20,
      armor: 3,
      maxHp: 40,
      range: 1,
      vision: 7,
      // 2026-11-04：追猎 → 撕咬。射程 1 的兵吃不到"拉开距离"的加成，
      // 见 maul 那段注释。
      abilities: ['maul'],
    },
    // 精灵弓手：射程 5、视野 7。它的工作是在对面还没看清它的时候先开火。
    {
      id: 'elf-archer',
      name: '精灵弓手',
      short: '精',
      era: 3,
      category: 'combat',
      cost: 175,
      move: 3,
      atk: 22,
      armor: 2,
      maxHp: 30,
      range: 5,
      vision: 7,
      // 5 格射程 + 7 格视野 + 无视掩护：它是全场唯一"先看见、先开枪"的兵。
      // 代价是 30 血 2 甲，被任何骑兵摸到就没了。
      abilities: ['elf-shot'],
    },
    // ── 4 级 ──────────────────────────────────────────────────────────────
    {
      id: 'elementalist',
      name: '元素召唤师',
      short: '召',
      era: 4,
      category: 'combat',
      cost: 280,
      move: 2,
      atk: 10,
      armor: 3,
      maxHp: 34,
      range: 3,
      vision: 5,
      magicAtk: 14,
      abilities: ['summoner'],
      // 随机召唤：种子决定，回放对得上
      summon: {
        random: ['fire-elemental', 'water-elemental', 'earth-elemental', 'air-elemental'],
        every: 3,
        max: 2,
      },
    },
    {
      id: 'vampire',
      name: '吸血鬼',
      short: '血',
      era: 4,
      category: 'combat',
      cost: 235,
      move: 5,
      atk: 28,
      armor: 5,
      maxHp: 56,
      range: 1,
      vision: 5,
      flight: true,
      layer: 'air',
      abilities: ['lifesteal'],
      weak: { fire: 2, light: 2 },
    },
    // 机关傀儡：不会好起来的兵。能一直打，但不能一直撑。
    {
      id: 'clockwork-golem',
      name: '机关傀儡',
      short: '械',
      era: 4,
      category: 'combat',
      cost: 245,
      move: 2,
      atk: 30,
      armor: 9,
      maxHp: 72,
      range: 1,
      vision: 3,
      abilities: ['machine', 'shield-wall'],
    },
    // ── 5 级 ──────────────────────────────────────────────────────────────
    // 恶魔：飞行 + 亡语爆炸 + 每 3 回合一个小恶魔。三条都是"死了也不亏"。
    {
      id: 'demon',
      name: '恶魔',
      short: '恶',
      era: 5,
      category: 'combat',
      cost: 400,
      move: 5,
      atk: 42,
      armor: 7,
      maxHp: 78,
      range: 2,
      vision: 6,
      magicAtk: 10,
      element: 'fire',
      flight: true,
      layer: 'air',
      abilities: ['kamikaze', 'summoner'],
      summon: { type: 'imp', every: 3, max: 2 },
    },
    // ── 被召唤的（不进产线、不占编制） ────────────────────────────────────
    ...SUMMONED_UNITS,
  ],
};

/**
 * 英雄包：五个全场唯一、首次招募要付解锁费的大家伙。
 *
 * 为什么单独成包而不是混进上面三个：有人就是想打一场没有 560 金大件的仗。
 * 英雄对局节奏的影响是质变级的（一个九头蛇能顶半支部队），所以它必须
 * 是一个可以被整体关掉的选择，而不是藏在兽群里的一行数据。
 */
// 九个英雄的 id。原先只列了最早那五个，后来加的刺客大师、史莱姆牢大
// 和这次的两个都没跟上——这张表是"英雄包里有谁"的唯一清单，
// 漏一个，界面按它筛兵就会少一个能买的英雄。
const HERO_IDS = [
  'dwarf-king',
  'hydra',
  'phoenix',
  'archmage',
  'angel',
  'assassin-master',
  'slime-boss',
  'night-necromancer',
  'holy-knight-lord',
  'sword-saint',
  'evil-dragon-king',
];

// 英雄数值在技能化之后整体上调过一档（攻/血各 +5% 上下）。
//
// 原因不是"英雄不够强"，是"英雄不够值"：技能化之后每回合多了一次要做的决定，
// 但面板没动，等于同样的钱买到了更多操作负担。护甲/魔抗/射程/移动一律不动——
// 那几项每加一档就是换一个量级（护甲尤其非线性），跟"略微提升"不是一回事。
//
// 第二次上调：血量整体 ×1.2，造价跟着涨半成（+20~30 金）。
//
// 只动血，不动攻。英雄的问题从来不是"打不死人"，是"太容易先死"：
// 一个 520 金的单位被对面两轮集火就没了，玩家下次就不敢买了，买了也只敢
// 缩在城后——英雄一旦不能上前线，技能里那些"贴上去才值"的效果（投斧、
// 烈焰俯冲、降临）就全废了。血量是唯一能把"敢不敢上"改过来的那一项。
//
// 加血必然要抬价，否则英雄在性价比上直接压死同费普通兵；但**只能略微涨**：
// 涨到 600 以上，五个英雄就变成"解锁费之后再交一道钱墙"，节奏被拖垮的是
// 玩家自己。所以按 +半成 走，谁的血涨得多谁多掏一点，最终都还落在原档位里。
const HERO_UNITS: UnitTypeDef[] = [
  // 矮人王：近战是本职（atk 32，射程 1），投斧是**技能**（开一回合，射程 3 但只有六成）。
  //
  // 改动前它是"射程 3 的兵，贴身打不打折"，等于永远在远程位。现在默认只能近身，
  // 想投斧得自己开——这样"贴上去还是站远点"才是每回合真要做的一个决定。
  // 造价 300 → 340：多了一个可选技能，价格得跟着走一点。
  {
    id: 'dwarf-king',
    name: '矮人王',
    short: '王',
    era: 3,
    category: 'combat',
    cost: 360,
    move: 2,
    atk: 34,
    armor: 8,
    maxHp: 101,
    range: 1,
    vision: 4,
    hero: true,
    unlockCost: 150,
    abilities: ['aura-armor', 'shield-wall'],
    skills: [
      {
        id: 'throw-axe',
        name: '投斧',
        summary:
          '投出一斧：射程 3、隔着一格以上只有六成伤害。',
        effect: 'throw-axe',
        cooldown: 1,
        power: 0.6,
      },
    ],
  },
  // 九头蛇：145 血 + 每回合两成回复。解法只有一个——火。
  {
    id: 'hydra',
    name: '九头蛇',
    short: '九',
    era: 4,
    category: 'combat',
    cost: 490,
    move: 3,
    atk: 36,
    armor: 7,
    maxHp: 145,
    range: 1,
    vision: 4,
    hero: true,
    unlockCost: 200,
    abilities: ['regenerate-plus', 'siege-master'],
    weak: { fire: 2 },
    skills: [
      {
        id: 'regrow',
        name: '再生',
        summary: '立刻回复 40% 生命。',
        effect: 'regenerate',
        cooldown: 2,
        power: 0.4,
      },
    ],
  },
  // 不死鸟：每局从灰烬里站起来一次。它不硬，但它死不完。
  {
    id: 'phoenix',
    name: '不死鸟',
    short: '凤',
    era: 4,
    category: 'combat',
    cost: 480,
    move: 6,
    atk: 38,
    armor: 4,
    maxHp: 89,
    range: 2,
    vision: 7,
    magicAtk: 10,
    element: 'fire',
    hero: true,
    unlockCost: 220,
    flight: true,
    layer: 'air',
    abilities: ['rebirth'],
    skills: [
      {
        id: 'dive',
        name: '烈焰俯冲',
        summary: '本回合移动 +2，攻击额外点燃两层。',
        effect: 'dive',
        cooldown: 2,
        power: 2,
      },
    ],
  },
  // 至尊法师：溅射 2 格加 36 点魔攻。打的是"一片阵型"，不是一个兵。
  // 属性不再自动轮换，改成每回合自己切一次（见 skills）：自动轮换等于
  // "你只有四分之一的回合是火属性"，而火要烧谁是你自己该判断的事。
  {
    id: 'archmage',
    name: '至尊法师',
    short: '尊',
    era: 5,
    category: 'combat',
    cost: 640,
    move: 2,
    // 攻 0：它的伤害**全部**来自魔法段（36 点，只被魔抗挡）。
    // 以前给 10 点物理是为了"至少能敲一下"，代价是每一下都要先减对方护甲，
    // 打重甲兵时这 10 点永远是 0——留着只会让人以为它能肉搏。
    // 现在的分工很清楚：物理归零、魔法拉满，护甲再高也躲不掉那 36 点。
    atk: 0,
    // 护甲 6 → 10、魔抗 10 → 14、射程 5 → 6、视野 8 → 9：
    // 这一档换的是"站得住、看得远、够得着"。它不是靠血厚活下来的兵，
    // 而是靠"对面还没走到就已经挨了两轮"。
    armor: 10,
    maxHp: 72,
    range: 6,
    vision: 9,
    magicAtk: 36,
    // 法抗 14 让它不至于被对面一发法师打回原形：至尊法师该是"法师里的法师"，
    // 对轰的时候不能比对面脆。
    magicRes: 14,
    element: 'fire',
    splash: 2,
    hero: true,
    unlockCost: 350,
    cycle: ['fire', 'water', 'nature', 'dark'],
    // 属性不再只是"这一回合上什么状态"，而是四种形态：
    // 火/水继续压状态，自然变成自愈，暗变成纯粹的伤害放大（见 element-mastery）。
    // 「同源护壁」是这次加的：火属性的至尊法师被火打只吃一半——
    // 它自己的属性就是它的护甲，切属性同时在换"怕什么、不怕什么"。
    abilities: ['element-mastery', 'element-ward'],
    skills: [
      {
        id: 'shift',
        name: '转属性',
        summary: '切到下一种属性（火→水→自然→暗）。火=点燃、水=霜缚、自然=攻击时自愈、暗=魔法段 ×1.5。',
        effect: 'cycle',
        cooldown: 1,
      },
    ],
  },
  // 天使：高甲 + 6 魔抗 + 群体治愈 + 一次大范围「降临」。
  //
  // 大净化从被动改成技能，并且半径从 1 拉到 3：被动版只够得着贴身的三个兵，
  // 而"清掉一条线上的中毒和诅咒"本来就该是一个主动决定——净化什么时候放，
  // 取决于对面法师什么时候出手，而不是取决于天使站在哪。
  {
    id: 'angel',
    name: '天使',
    short: '使',
    era: 5,
    category: 'combat',
    cost: 550,
    move: 5,
    atk: 42,
    armor: 10,
    maxHp: 121,
    range: 1,
    vision: 7,
    magicAtk: 12,
    magicRes: 6,
    element: 'light',
    hero: true,
    unlockCost: 250,
    flight: true,
    layer: 'air',
    abilities: ['heal-aura'],
    skills: [
      {
        id: 'descend',
        name: '降临',
        summary: '半径 3 内友军回复 20% 生命，并清空全部负面状态。',
        effect: 'descend',
        cooldown: 2,
        radius: 3,
        power: 0.2,
      },
    ],
  },
  // 刺客大师：全场最会挑时机的一个。
  //
  // 它面板不吓人（30 攻、78 血），但两条机制叠起来是另一种强度：
  //   · 收割——亲手斩掉一个，脚下又有路了。杀完能换个位置躲开围上来的援兵，
  //     但攻击次数不还，所以它永远做不到"一回合砍两个"。
  //   · 隐匿——主动藏起来，藏到你的下个回合开始。对面要么放弃追击，
  //     要么把兵铺开、贴到相邻格才抓得住它。
  // 这两条合起来，让它成为"补刀 + 脱战"的兵，而不是一个能正面站住的英雄。
  {
    id: 'assassin-master',
    name: '刺客大师',
    short: '刺',
    era: 4,
    category: 'combat',
    cost: 430,
    move: 3,
    atk: 30,
    armor: 3,
    maxHp: 78,
    range: 1,
    // 视野 5 → 7：刺客要挑"从哪边绕过去"，看不清两格外的援兵就挑不了
    vision: 7,
    hero: true,
    unlockCost: 180,
    abilities: ['kill-rush'],
    skills: [
      {
        id: 'vanish',
        name: '隐匿',
        summary:
          '隐去身形：直到你下个回合开始，敌人只有贴到相邻格才发现它。出手或挨打会立刻暴露。最多攒 3 发，每 2 回合回一发。',
        effect: 'vanish',
        // 从"冷却 2"改成"一池 3 发、每 2 回合回 1 发"：
        // 冷却逼你按节拍用（能放就放，放着就是浪费），而刺客要的是
        // "攒着，等一个值得用的时机"——连开两回合是它唯一能主动制造的机会窗口。
        charges: 3,
        regen: 2,
      },
    ],
  },
  // 史莱姆牢大：血厚甲低的近战肉块，真正的价值在"打不死"。
  //
  // 200 血配 2 甲，看着像一堵墙，其实是四团血：一刀砍下去裂成四只，
  // 每只跑得都比它快。对面要么把四只全清掉（清的时候还要吃四次攻击），
  // 要么被它们跑回去重新合体——这一来一回，才是它值 200 解锁费的地方。
  {
    id: 'slime-boss',
    name: '史莱姆牢大',
    short: '牢',
    era: 3,
    category: 'combat',
    cost: 520,
    move: 3,
    atk: 32,
    // 甲 2 → 3、射程 1 → 2、视野 3 → 4：血厚甲薄的肉块太容易被"隔着打"白嫖，
    // 射程 2 让它能回手（也意味着它能打到飞行单位了，见 rules 的 strikeDistance）
    armor: 3,
    // 200 → 222（2026-10-31）：它是"靠血换时间"的兵，而现在的集火能力比它上线时更强，
    // 200 血在蒸汽时代经常撑不过两轮。加两成半的一档，仍是全场最厚的肉。
    maxHp: 222,
    range: 2,
    vision: 4,
    hero: true,
    unlockCost: 200,
    weak: { fire: 1.5 },
    // 和「分裂」能力共用这一个字段：牢大没有 split 能力，所以阵亡时不会自动裂；
    // 「裂殖」技能读它来决定裂成什么（见 rules 的 doHeroSkill）。
    splitInto: 'slime-giant',
    skills: [
      {
        id: 'mitosis',
        name: '裂殖',
        summary:
          '裂成四只大史莱姆：每只生命为牢大当前生命的四分之一。分裂体当回合不能行动。',
        effect: 'mitosis',
        cooldown: 3,
      },
    ],
  },
  // 大史莱姆：牢大的碎片，也带着合体的钥匙。
  //
  // 单独给它一条产线会让"牢大"变成一个可以刷的兵，所以它是 summonedOnly：
  // 只能从裂殖里出来。血刚好是牢大的四分之一（50），移速反而更快——
  // 碎开之后它们该做的事是跑，不是站。
  {
    id: 'slime-giant',
    name: '大史莱姆',
    short: '巨',
    era: 3,
    category: 'combat',
    // 造价不会出现在产线上（summonedOnly），只影响"满血解散能退多少"——
    // 按牢大的四分之一写，退了也不至于变成"裂开再解散"的刷钱路子。
    cost: 130,
    move: 5,
    atk: 14,
    // 甲 1 → 2：碎片本来靠数量活着，但 1 甲连民兵都能两下清掉，
    // 裂开等于把血直接送出去
    armor: 2,
    maxHp: 50,
    range: 1,
    vision: 3,
    summonedOnly: true,
    weak: { fire: 1.5 },
    mergeInto: 'slime-boss',
    skills: [
      {
        id: 'fuse',
        name: '聚合',
        summary:
          '和场上至少2只其它大史莱姆合体成史莱姆牢大：生命相加，上限按牢大算。合体后当回合不能行动。',
        effect: 'fuse',
        cooldown: 1,
      },
    ],
  },
  // 暗夜死灵法师：全场唯一一个"把队友拉回来"的英雄。
  //
  // 它的面板刻意压得低（22 攻、88 血、3 速），因为技能的价值不在这一回合，
  // 而在"对面刚用一次漂亮的交换打掉你一个主力，你把它原价买回来"。
  // 三速是"中速"：跑不过骑兵，但跟得上步兵线，能站在后排够得着的地方。
  //
  // 为什么复活要按生产价格收钱：白拉等于让对面所有击杀都失去意义。
  // 收原价则是"用钱把时间买回来"——它救的是节奏，不是金币。
  {
    id: 'night-necromancer',
    name: '暗夜死灵法师',
    short: '冥',
    // 4 代 → 3 代（火器）：招魂的价值随"兵的造价"走，而火器时代正好是
    // 第一个"每个兵都值一笔钱"的时代。放在蒸汽它永远晚一步，放在铁器又太早。
    era: 3,
    category: 'combat',
    // 420 → 320，各项面板同步下调：换时代就得换价位，否则火器时代没人买得起它，
    // 而它又不是那种"贵一点也值得攒"的兵——它的强度来自把队友买回来，不是自己打。
    cost: 320,
    move: 3,
    atk: 18,
    armor: 3,
    maxHp: 76,
    range: 3,
    vision: 4,
    magicAtk: 14,
    magicRes: 3,
    element: 'dark',
    hero: true,
    unlockCost: 160,
    abilities: ['element-ward'],
    skills: [
      {
        id: 'raise-dead',
        name: '招魂',
        summary:
          '支付该兵种的生产价格，把**本轮**倒下的一名友军在自己身边复活（对手刚过去的回合与本回合都算；同时倒下好几个时救造价最高的那个）。复活的单位当回合不能行动；同一具遗体只能招一次，**英雄不在其列**。',
        effect: 'raise-dead',
        cooldown: 2,
      },
    ],
  },
  // 神圣骑士长：慢、厚、硬，本团唯一"站在最前面却不靠输出说话"的英雄。
  //
  // 2 速让它天然落在阵线中间，而圣旗要的就是"身边有人"——这不是巧合，
  // 是它和刺客大师（3 速、要绕后）的对照：一个往前挤，一个往外绕。
  // 护甲 12 配盾墙，让对面必须用破甲或魔法来解它，而它恰好把魔抗发给全队。
  {
    id: 'holy-knight-lord',
    name: '神圣骑士长',
    short: '骑',
    era: 4,
    category: 'combat',
    cost: 470,
    move: 2,
    atk: 36,
    // 12 → 14（2026-10-31）：它是"站在最前面替全队吃伤害"的定位，
    // 而 12 甲在蒸汽时代挡不住主流破甲；多这两点，才配得上它 2 速的代价。
    armor: 14,
    // 150 → 170（2026-11-07）：它的血量是"替别人挨打"的额度，不是自己的生存力。
    // 470 金 + 2 速 + 圣旗要贴到半径 2，实战里它几乎每回合都在吃两份伤害；
    // 150 血撑不到第二次开旗，这条英雄就退化成"开一次旗然后死"。
    // 拉高的是**耐久上限**，攻防一条没动——它更耐打，但仍然不靠输出说话。
    maxHp: 170,
    range: 1,
    vision: 4,
    magicRes: 5,
    element: 'light',
    hero: true,
    unlockCost: 220,
    abilities: ['shield-wall'],
    skills: [
      {
        id: 'holy-banner',
        name: '圣旗',
        summary:
          '半径 2 内所有友军（含自己）护甲 +3、魔抗 +4，并获得**阵列**（免疫溅射）；持续到自己的下个回合开始。',
        effect: 'holy-banner',
        cooldown: 2,
        radius: 2,
        armorUp: 3,
        magicResUp: 4,
      },
    ],
  },
  // 圣剑勇者：信息化时代的光属性大剑。直线溅射 + 越打越强。
  //
  // 为什么挂在「信息化」上（requiresPack）：它的整套数值是按第六时代定的——
  // 46 攻、11 甲、140 血在火器时代是碾压，在蒸汽时代也无对手。
  // 没有现代那一套兵种做参照，它只会变成一个"开了就能赢"的单件。
  //
  // 直线溅射（splash + splashLine）：剑气只扫"从它指向目标"的那一条线，
  // 所以站位从"贴着一堆人"变成"对准一列人"——这是它和炮的差别，
  // 也是它值得 620 金的理由之一（一列三个重甲，比一圈杂兵更值）。
  //
  // 觉醒是**永久**加成：它没有位移、没有控场，全部价值压在"给它两三个回合"。
  {
    id: 'sword-saint',
    name: '圣剑勇者',
    short: '圣',
    era: 6,
    category: 'combat',
    cost: 620,
    move: 4,
    atk: 46,
    armor: 11,
    maxHp: 140,
    range: 3,
    vision: 6,
    magicAtk: 12,
    magicRes: 6,
    element: 'light',
    splash: 1,
    splashLine: true,
    hero: true,
    unlockCost: 260,
    requiresPack: 'pack-contemporary',
    abilities: ['shield-wall'],
    skills: [
      {
        id: 'ascend',
        name: '圣剑觉醒',
        summary:
          '永久强化自身：攻击 +8、护甲 +2、魔法攻击 +8、魔法抗性 +2、生命上限 +30，并按新上限回复 30% 生命。可反复叠加，越打越硬。',
        effect: 'ascend',
        cooldown: 3,
        power: 0.3,
        atkUp: 8,
        armorUp: 2,
        magicAtkUp: 8,
        magicResUp: 2,
        hpUp: 30,
      },
    ],
  },
  // 邪龙王：慢、厚、魔抗极高，怕光。技能是"隔空落一颗会孵化的卵"。
  //
  // 属性表就是它的性格：风火水土四系各减半（龙鳞），光系翻倍（它的逆鳞）。
  // 这两条走的都是既有的 weak/resist 倍率，没有为它新开一条结算。
  {
    id: 'evil-dragon-king',
    name: '邪龙王',
    short: '邪',
    era: 6,
    category: 'combat',
    // 700：2026-11-09 由 640 上调。它是全场最贵的英雄，且刚吃到"信息化射程 +1"
    // （4 → 5）与陨卵的选点自由——两条叠起来，640 那个价已经压不住它。
    cost: 700,
    // 2 速：它是阵地单位，不是追人的龙。想让它上场，阵线得围着它摆。
    move: 2,
    atk: 40,
    armor: 8,
    maxHp: 190,
    range: 4,
    // 视野 9：它落在哪儿，方圆九格就该是它的疆域——陨卵的射程也是 9，
    // 两者对齐，玩家看到"能砸到的地方"和"能看见的地方"是同一片。
    vision: 9,
    magicAtk: 30,
    magicRes: 12,
    element: 'dark',
    // 飞行：它飞在王座之上，不和地面单位抢格子（见 layer 的说明）。
    // 代价是地形护甲对它不再生效——这是空中层本来就有的交易。
    flight: true,
    layer: 'air',
    hero: true,
    unlockCost: 300,
    requiresPack: 'pack-contemporary',
    weak: { light: 2 },
    resist: { fire: 0.5, water: 0.5, earth: 0.5, wind: 0.5 },
    skills: [
      {
        id: 'dragon-egg',
        name: '陨卵',
        summary:
          '在 9 格内**自己挑一格**落下魔龙卵：落点周围 1 格内的敌人各吃一发暗属性魔法（不吃护甲、只被魔抗挡）。魔龙卵 2 回合后孵化为魔龙。',
        effect: 'dragon-egg',
        // 落点由玩家点，不再由引擎替他想。地图上高亮的格子＝"能落蛋、且砸得到人"，
        // 点空地会被拒绝（这条技能的身份是"陨石砸人"，不是"随地放蛋"）。
        targeting: 'point',
        cooldown: 3,
        radius: 9,
        power: 1,
      },
    ],
  },
  // 魔龙卵：邪龙王的技能产物。不产线、不占编制，只负责"倒计时"。
  //
  // 它**现在是个硬目标**（护甲 25 / 魔抗 12 / 生命 140），而不是一枚随手能戳破的蛋。
  // 原来那是 1 甲 30 血：对面一个民兵走过去一刀就清掉了，"先清卵还是先打龙"
  // 这个问题根本轮不到他思考——清卵不花任何代价。现在清一枚卵要真的调人过来：
  // 物理要 25 甲以上的破甲量，法术要 12 魔抗以上的穿透，两边都得付出一整个回合。
  // 它仍然不动、不还手、两回合后自己变成魔龙，所以这不是"加强邪龙王"，
  // 是把一次空投变成一道真的选择题。
  {
    id: 'dragon-egg',
    name: '魔龙卵',
    short: '卵',
    era: 6,
    category: 'combat',
    cost: 60,
    move: 0,
    atk: 0,
    armor: 25,
    maxHp: 140,
    range: 0,
    vision: 2,
    magicRes: 12,
    element: 'dark',
    summonedOnly: true,
    hatch: { into: 'magic-dragon', turns: 2 },
  },
  // 魔龙：卵孵出来的东西。面板比邪龙王低一档，但会飞、跑得快。
  {
    id: 'magic-dragon',
    name: '魔龙',
    short: '魔',
    era: 6,
    category: 'combat',
    cost: 300,
    move: 5,
    atk: 44,
    armor: 10,
    maxHp: 150,
    range: 3,
    vision: 6,
    magicAtk: 22,
    magicRes: 8,
    element: 'dark',
    flight: true,
    layer: 'air',
    summonedOnly: true,
    weak: { light: 2 },
    resist: { fire: 0.5, water: 0.5, earth: 0.5, wind: 0.5 },
  },
];

const HEROES: Expansion = {
  id: 'fantasy-heroes',
  scale: 'large',
  name: '奇想·英雄',
  summary:
    '十一个全场唯一的英雄，每人每回合有一个主动技能：矮人王（投斧：白送一次三格远程攻击）、九头蛇（再生：回 40% 生命）、不死鸟（烈焰俯冲：加速并点燃两层；阵亡后留下一枚蛋，孵化带一半生命）、至尊法师（转属性：火/水/自然/暗四种形态，护甲 6、射程 5、同属性伤害减半）、天使（降临：半径 3 回 20% 并清空负面状态）、刺客大师（隐匿：藏到你的下个回合，斩杀后还能再走一次）、史莱姆牢大（裂殖：裂成四只大史莱姆，它们能再聚合回来）、暗夜死灵法师（招魂：付生产价格把本轮倒下的一名友军拉回来）、神圣骑士长（圣旗：半径 2 内友军护甲 +3、魔抗 +4、获得阵列）、圣剑勇者（圣剑觉醒：永久 +8 攻 / +2 甲 / +8 魔攻 / +2 魔抗 / +30 生命上限并回血，剑气直线溅射）、邪龙王（陨卵：9 格内落下魔龙卵，落点周围吃暗属性魔法，两回合后孵出魔龙；本体飞行）。第一次招募要额外付解锁费，解锁后永久开放。后两位需要同时开启「信息化」扩展。',
  requires: ['fantasy-core'],
  hooks: {},
  units: HERO_UNITS,
};

/**
 * 「奇想」：把原来五个包并成一个（2026-11-04）。
 *
 * 以前是「法则 / 骑士团 / 荒兽 / 秘法 / 英雄」五包，靠 `requires: ['fantasy-core']`
 * 串成一串——勾一个兵种包，开局面板会自动把法则包补上。那套机制本身没问题，
 * 问题是**它把这个体系切成了五道选择题**：玩家想玩奇想，得先看懂"法则"是什么、
 * 再决定要不要骑士团/荒兽/秘法/英雄，而其中四个都依赖第一个。
 * 结果就是"我勾了奇想啊，怎么没有龙？"——这种问题在群里出现过不止一次。
 *
 * 现在一个包、一个勾，四个兵种组按 骑士团 → 荒兽 → 秘法 → 英雄 的顺序并进兵种表
 * （和原来的注册顺序一致，所以面板里的排列、选卡池的分层都没变）。
 *
 * 下面这五个对象现在只是**内容切片**，不再各自注册成扩展：
 * 法则包贡献能力表与那条开局战报，其余四个只贡献 units。
 */
export const FANTASY: Expansion = {
  id: 'fantasy',
  scale: 'large',
  name: '奇想',
  blurb: '魔法、荒兽与英雄，一整套奇幻军备。',
  summary:
    '一整套奇想军备：法则（魔法攻击/魔抗、属性克制、负面状态、空中层）+ 人类的骑士团 + ' +
    '荒兽 + 秘法 + 十一个全场唯一的英雄。开这一个包就有全部 72 个兵种，不再分五个勾。' +
    '英雄第一次招募要额外付解锁费，解锁后永久开放；圣剑勇者与邪龙王需要同时开「信息化」。',
  // 只有法则包有钩子（开局写一条战报，让玩家确认法则生效）。
  // 合并之后它就是整包的钩子——四组兵种本来就没有钩子。
  hooks: CORE.hooks,
  abilities: CORE.abilities,
  // 留痕种类也必须一起并进来：哥布林陷阱（gb-mine）原来挂在荒兽包上。
  // 漏了它不会报错，只会"陷阱师埋了雷、敌人踩上去什么也不发生"——
  // 因为 mark-registry 是从各扩展的 marks 里合并的，没登记就等于这个 kind 不存在。
  marks: BEASTS.marks,
  units: [...(KNIGHTS.units ?? []), ...(BEASTS.units ?? []), ...(ARCANE.units ?? []), ...(HEROES.units ?? [])],
};

/** 英雄 id 列表，给"英雄包只装英雄"这条测试用 */
export const FANTASY_HERO_IDS: readonly string[] = HERO_IDS;

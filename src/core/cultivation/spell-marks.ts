/**
 * 法术留下的「场」：火海与刀山。
 *
 * ── 为什么用 marks，而不是自己另造一套 ──────────────────────────
 *
 * `core/marks.ts` 本来就是"格子上留下的东西"那一层：不占地、不行动、没有回合，
 * 有人走上来就按种类结算，引擎负责可见性、次数递减、越界与地形判定。
 * 三样我们正好都要：火海要"谁踩进来谁烧"、刀山要"双方都看得见"、
 * 两者都要在几回合后自己消失。所以这一层是**接线**，不是新建。
 *
 * ── 两种场的差别 ────────────────────────────────────────────────
 *
 *   · **火海**（`spell-fire`）：不消耗，靠 `charges` 数回合；
 *     每个回合只在**布设者的回合开始**结算一次（`player === owner` 才返回 true），
 *     否则两人局里一回合会烧两遍，伤害直接翻倍。
 *   · **刀山**（`spell-blade`）：踩一次就炸一次、炸完就没了（`charges: 1`），
 *     而且**双方都能看见**——它是明面上的封锁，不是暗雷。
 *
 * ── 数据只能放数字 ──────────────────────────────────────────────
 *
 * `Mark.data` 的类型是 `Record<string, number>`，所以伤害在**施法时**就算好
 * 存进去，不在这里按境界现算（这里也拿不到施法者）。`physical` 用 0/1 表示。
 *
 * ⚠️ 留痕目前只活在地球这张图上（`boardState` 给别的图返回 `marks: []`）。
 * 月面/空间站上放不出场，这是既有边界，不是这次新加的。
 */
import type { MarkKindDef } from '../marks.ts';
import { coversTile } from '../query.ts';
import { raiseQiAt } from './qi-field.ts';

/** 从 mark.data 里取一个数，缺省 0 */
function num(v: number | undefined): number {
  return typeof v === 'number' ? v : 0;
}

/**
 * 火海只烧**敌方**单位。
 *
 * 为什么不烧自己人：这门法术是以施法者自己为圆心放的（十方火海），
 * 不豁免就是"放完当场把自己烤死"。`Mark.data` 只收数字、存不下施法者 id，
 * 没法只豁免"放火的那个人"，所以退一步豁免整方。
 * 以后真要做"连自己人一起烧"，得先让 mark 能记住施法者。
 */
export const SPELL_FIRE_MARK: MarkKindDef = {
  id: 'spell-fire',
  name: '火海',
  summary: '范围内的格子燃着火，进入的敌方单位被灼烧，并在每一轮布设者的回合开始再烧一次。',
  // 双方都看得见：火不是暗器，玩家该能绕着走
  hidden: false,
  trigger: 'any',
  onEnter: (c) => {
    if (!c.unit) return;
    if (c.unit.owner === c.mark.owner) return false;
    const name = c.api.utype(c.unit.type).name;
    const dmg = num(c.mark.data?.['dmg']);
    if (dmg <= 0) return;
    // `MarkApi.hurt` 只收字符串（它不减甲，所以"实际掉了多少"就是 dmg 本身）
    c.api.hurt(c.unit, dmg, `${name}踏入火海，被灼伤 ${dmg} 点`);
    // 进入不消耗回合数：火要烧满规定的回合
    return false;
  },
  onTurnStart: (c) => {
    // 只在布设者自己的回合结算：两人局里一回合会 tick 两次，
    // 不判这一下，同一片火一回合烧两遍。
    if (c.player !== c.mark.owner) return false;
    const dmg = num(c.mark.data?.['dmg']);
    if (dmg <= 0) return true;
    const here = c.state.units.filter(
      (u) => u.hp > 0 && u.owner !== c.mark.owner && coversTile(c.state, u, c.mark.x, c.mark.y),
    );
    for (const u of here) {
      const name = c.api.utype(u.type).name;
      c.api.hurt(u, dmg, `${name}在火海中损失 ${dmg} 点生命`);
    }
    return true; // 消耗一个回合数
  },
};

export const SPELL_BLADE_MARK: MarkKindDef = {
  id: 'spell-blade',
  name: '刀山',
  summary: '明面上的刀丛：走上去就被割一刀，割完就没了。双方都看得见。',
  tags: ['trap'],
  hidden: false,
  trigger: 'any',
  onEnter: (c) => {
    if (!c.unit) return;
    const name = c.api.utype(c.unit.type).name;
    const dmg = num(c.mark.data?.['dmg']);
    const physical = num(c.mark.data?.['physical']) > 0;
    if (dmg <= 0) return;
    if (physical) {
      // 刀是物理伤害：先减甲。走 hurtPhysical 才是这个包的口径（见 MarkApi 注释）
      c.api.hurtPhysical(c.unit, dmg, (dealt: number) => `${name}踩进刀山，被割 ${dealt} 点`);
    } else {
      c.api.hurt(c.unit, dmg, `${name}踩进刀山，被割 ${dmg} 点`);
    }
    c.api.log(c.mark.owner, `刀山割伤 ${name}`);
    // 默认消耗：一片刀只割一次
  },
};

/**
 * 山河敕令：一片被"敕令"压住的地。
 *
 * 有效性的判据是**施法者还站着没动**，所以每条 mark 的 `custom` 里记了
 * `{ caster, cx, cy }`（这就是给 `Mark` 开 `custom` 的第一个理由：
 * `data` 只收数字，装不下单位 id）。
 *
 * 三条实现上的选择：
 *   · 只在**布设者自己的回合**结算（和火海同一个理由：两人局一回合 tick 两次）；
 *   · 不按次数消耗，撤场靠 `c.remove()`——"人走了"不是"次数用完了"；
 *   · 只打**敌方建筑**：这门法术的意象是"压住这片地"，不是清兵。
 */
export const SPELL_EDICT_MARK: MarkKindDef = {
  id: 'spell-edict',
  name: '山河敕令',
  summary: '敌方建筑每轮受真实伤害，且这片区域无法兴建；施法者移动或阵亡后失效。',
  tags: ['field'],
  hidden: false,
  onTurnStart: (c) => {
    if (c.player !== c.mark.owner) return false;
    const cust = (c.mark.custom ?? {}) as { caster?: string; cx?: number; cy?: number };
    const caster = cust.caster ? c.state.units.find((u) => u.id === cust.caster) : undefined;
    // 人没了、或者离开原位：整片敕令同时散掉（每条 mark 各撤各的，同一拍走完）
    if (!caster || caster.x !== cust.cx || caster.y !== cust.cy) {
      c.remove?.();
      return false;
    }
    const dmg = num(c.mark.data?.['dmg']);
    if (dmg <= 0) return false;
    for (const u of c.state.units) {
      if (u.hp <= 0 || u.owner === c.mark.owner) continue;
      if (c.state.unitTypes[u.type]?.category !== 'building') continue;
      if (!coversTile(c.state, u, c.mark.x, c.mark.y)) continue;
      const name = c.api.utype(u.type).name;
      c.api.hurt(u, dmg, `${name}在山河敕令下损失 ${dmg} 点`);
    }
    return false;
  },
};

/**
 * 灵雨（春风化雨留下的临时灵气源）。
 *
 * 每轮往自己这一格补一次灵气，烧完 `charges` 就散。写灵气必须走 `raiseQiAt`
 * ——那是唯一入口，负责夹到 0~QI_MAX（见 qi-field.ts 里那段"为什么开口"）。
 */
export const SPELL_QI_SPRING_MARK: MarkKindDef = {
  id: 'spell-qi-spring',
  name: '灵雨',
  summary: '这一格的灵气每轮被补充，持续若干轮。',
  hidden: false,
  onTurnStart: (c) => {
    if (c.player !== c.mark.owner) return false;
    const amount = num(c.mark.data?.['qi']);
    if (amount > 0) raiseQiAt(c.state, c.mark.x, c.mark.y, amount);
    return true; // 消耗一轮
  },
};

/** 这个包贡献的全部留痕种类（在 `cultivation-packs.ts` 里挂到 Expansion 上） */
export const CULTIVATION_MARK_KINDS: MarkKindDef[] = [
  SPELL_FIRE_MARK,
  SPELL_BLADE_MARK,
  SPELL_EDICT_MARK,
  SPELL_QI_SPRING_MARK,
];

import type { 
  Expansion
 } from './expansions.ts';
import type { 
  GameState,
  UnitTypeDef,
  Unit
} from './types.ts';
import type { AbilityDef } from './abilities.ts';
import { DAMAGE_STAGE } from './ability-hooks.ts';

// 境界名称
const _REAMLS: string[] = ["凡人","炼气","筑基","金丹","元婴","化神","返虚","合体","大乘","渡劫"];

// ── 修士身份判定 ────────────────────────────────────────────
//
// 这是本扩展里**唯一**"认识具体兵种"的地方。以前每个钩子里都写了一遍
// `type === 'qi-cultivator'`，十二处硬编码：加一个流派要回来改十二次，
// 漏一次就是"这个流派能修炼但不涨攻击"或"所有兵种都能修炼但不涨数值"。
//
// 判据用 id 集合，不用"带某条能力"：能力是机制（剑气、金身各有各的），
// 身份只是"这个兵种吃修炼规则"。两者今天一致，明天就不一定了。
//
// 加新流派 → 在 CULTIVATOR_IDS 里加一行 id；**别的钩子一个字都不用改**。
const CULTIVATOR_IDS = new Set(['qi-cultivator']);

/** 从兵种定义查。给"手里只有 def"的场合用。 */
export function isCultivatorDef(def: UnitTypeDef | undefined | null): boolean {
  return !!def && CULTIVATOR_IDS.has(def.id);
}

/** 从单位查。给钩子用——钩子里拿到的几乎都是 Unit。 */
export function isCultivatorUnit(s: GameState, u: Unit): boolean {
  return isCultivatorDef(s.unitTypes[u.type]);
}

// 炼气士
const CULTIVATOR: UnitTypeDef = {
  id: 'qi-cultivator',
  name: '炼气士',
  short: '炼',
  era: 1,
  category: 'combat',
  cost: 200,
  move: 2,
  atk: 10,
  armor: 0,
  maxHp: 20,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage'], 
};

/**
 * 真元：真实伤害
 */
const QI_TRUE_DAMAGE: AbilityDef = {
  id: 'qi-true-damage',
  name: '真元',
  summary: '每次攻击附带随境界提升的、无视护甲的真实伤害。',
  group: 'attack',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.trueDamage,
        apply: (c) => {
          if (c.side !== 'attacker') return;
          if (!isCultivatorUnit(c.state, c.self)) return;
          const trueDmg = trueDamageOf(c.self);
          if (trueDmg > 0) c.damage += trueDmg;
        },
      },
    ],
  },
};

// ── 经验与境界 ───────────────────────
// 读取当前经验，如果没有初始化就返回 0
function getExp(u: Unit): number {
  return (u.custom?.exp as number) ?? 0;
}
// 根据经验算等级
const MAX_RANK = 9;
function getRank(u: Unit): number {
  const exp = getExp(u);
  let rank = 0;
  while (rank < MAX_RANK && exp >= Math.floor(10 + 10 * rank * (rank+1) + 0.05 * 4 ** rank)) {
    rank++;
  }
  return rank;
}
/** 导出给测试用 */
export function cultivationRank(u: Unit): number {
  return getRank(u);
}

// 本地算最大血量的函数（核心规则里的 maxHpOf 也是这么写的）
function getMaxHp(s: GameState, u: Unit): number {
  // 从本局兵种表里取基础血量，然后加上单位自己积累的额外血量
  return (s.unitTypes[u.type]?.maxHp ?? 0) + (u.maxHpBonus ?? 0);
}

// 增加经验并即时判断升级
function addExp(u: Unit, s: GameState, amount: number): void {
  u.custom ??= {}; 
  const rank = getRank(u);
  u.custom.exp = ((u.custom.exp as number) ?? 0) + amount;
  const newRank = getRank(u);
  
  // 如果升级了，立刻结算加成并写战报
  // 用公开信息模拟升级时的天地异象，给对手及时出击打断成长的反应时间
  if (newRank > rank) {
    const deltaMaxHp = Math.floor(8.5*(newRank-rank)+0.0685*(newRank**3 * 1.8**newRank - rank**3 * 1.8**rank));
    // 升级瞬间按照比例回血
    const r = u.hp / getMaxHp(s,u);
    u.maxHpBonus = (u.maxHpBonus ?? 0) + deltaMaxHp;
    u.hp += Math.floor(deltaMaxHp * r); 
    
    s.log.push({
      turn: s.turn,
      player: u.owner, 
      text: `炼气士 突破至 ${_REAMLS[newRank]} 期！`,
      open: true,
    });
  }
}
// 自然经验增长
function getExpGrowth(u: Unit): number {
  return getRank(u) + 2;
}

// ── 寿元与衰老 ─────────────────────────────────────
// 规则：age > lifespan 开始减益，age - lifespan >= AGING_DEATH_AGE 才老死。
/** 寿元耗尽后还能撑几年才真正老死 */
const AGING_DEATH_AGE = 3;
function getLifespan(u: Unit): number {
  // 允许外部或测试强行指定寿元
  if (u.custom?.lifespan !== undefined) return u.custom.lifespan as number; 
  
  const rank = getRank(u);
  if (rank >= MAX_RANK) return Infinity;
  return 10 + rank * 9;
}
/**
 * 超出寿元多少岁。
 * 必须有 Math.max(0, ...)，否则负的“超龄”会变成攻击力加成，导致伤害爆炸。
 */
export function getAgingYears(u: Unit): number {
  return Math.max(0, (u.age ?? 0) - getLifespan(u));
}

/** 超出 AGING_DEATH_AGE 岁就坐化 */
function isDoomed(u: Unit): boolean {
  return getAgingYears(u) >= AGING_DEATH_AGE;
}

// ── 属性修正 ───────────────────────
// 返回的是增量
/** 攻击力修正：境界，衰老 −2/岁 */
// 由于攻击次数和溅射太强，这里的基础数值略为削弱
function atkModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (5 * rank + 2**(rank-0.5))/((rank+1)**0.2);
  return Math.floor(realmsModifier - getAgingYears(u) * 2);
}
/** 真伤修正 */
function trueDamageOf(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (rank*rank)/4+rank*(1.2**rank);
  return Math.floor(realmsModifier);
}
/** 攻击次数修正 */
// x=0~2 -> 1次，x=3~4 -> 2次，x=5~6 -> 3次，x=7~8 -> 4次，x=9 -> 5次。
function attTimesModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (rank + 1) / 2;
  return Math.max(1, Math.floor(realmsModifier));
}
/** 生命修正 */
/** 护甲修正：境界，衰老 −1/岁 */
function armorModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = -1 + rank * rank + 1.5**rank;
  return Math.floor(realmsModifier - getAgingYears(u));
}
/** 移动修正 */
function moveModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = rank/3;
  return Math.floor(realmsModifier);
}
/** 溅射范围修正 */
function SplashModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = rank/4;
  return Math.floor(realmsModifier);
}
/** 射程修正 */
function RangeModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = rank/2;
  return Math.floor(realmsModifier);
}
/** 视野修正 */
function VisionModifier(u: Unit): number {
  const rank = getRank(u);
  const aging = getAgingYears(u);
  const realmsModifier = rank;
  return Math.floor(realmsModifier-aging);
}


export const CULTIVATION_PACK: Expansion = {
  id: 'cultivation',
  name: '修真',
  summary: '带来了会修炼成长的炼气士。',
  scale: 'large',  
  hooks: {
    //升级逻辑
    // 1. 击杀敌人获得经验
    onUnitKilled: (c) => {
      if (c.killer && isCultivatorUnit(c.state, c.killer)) {
        addExp(c.killer, c.state, 10); 
      }
    },
    modifyDamage: ({ state, attacker, damage }) => {
      if (!isCultivatorUnit(state, attacker)) return damage;
      return damage + atkModifier(attacker);
    },
    // 攻城加成
    modifySiegeDamage: ({ state, attacker, damage }) => {
      if (!isCultivatorUnit(state, attacker)) return damage;
      return Math.max(0, damage + atkModifier(attacker));
    },
    // 面板修正
    modifyStatAtk: ({ state, unit, atk }) => {
      if (!isCultivatorUnit(state, unit)) return atk;
      return atk + atkModifier(unit);
    },
    // 护甲修正
    modifyArmor: ({ state, defender, armor }) => {
      if (!isCultivatorUnit(state, defender)) return armor;
      return Math.max(0, armor + armorModifier(defender));
    },
    // 射程修正
    modifyRange: ({ state, unit, range }) => {
      if (!isCultivatorUnit(state, unit)) return range;
      return range + RangeModifier(unit);
    },
    // 视野修正
    modifyVision: ({ state, unit, base }) => {
      if (!unit || !isCultivatorUnit(state, unit)) return base;
      return Math.max(1, base + VisionModifier(unit));
    },
    // 攻击次数
    modifyAttacks: ({ state, unit, attacks }) => {
      if (!isCultivatorUnit(state, unit)) return attacks;
      return attTimesModifier(unit);
    },
    // 溅射半径
    modifySplash: ({ state, attacker, splash }) => {
      if (!isCultivatorUnit(state, attacker)) return splash;
      return splash+SplashModifier(attacker);
    },
    // 移动修正
    modifyMove: ({ state, unit, move }) => {
      if (!isCultivatorUnit(state, unit)) return move;
      return move + moveModifier(unit);
    },
    // ── 回合开始：寿元判定 + 打坐 ──────────────────
    onTurnStart: ({ state, player }) => {
      for (const u of state.units) {
        if (u.owner !== player || !isCultivatorUnit(state, u)) continue;
        const age = u.age ?? 0;
        const lifespan = getLifespan(u);

        if (isDoomed(u)) {
          if (u.hp > 0) {
            u.hp = 0;
            state.log.push({
              turn: state.turn,
              player,
              text: `${state.unitTypes[u.type].name}寿元耗尽，油尽灯枯，只待最后一丝生机散去。`,
            });
          }
          // 把清场交给核心的 sweepDead。
          // 玩家可以在清场前打出最后一击或者寻找保命手段。
          continue;
        }

        // 刚跨过寿元：写一次警告
        if (age === lifespan + 1) {
          state.log.push({
            turn: state.turn,
            player,
            text: `炼气士 寿元将尽，身体每况愈下。`,
          });
        }

        // 打坐：老死前照常修炼
        addExp(u, state, getExpGrowth(u));
      }
    },
    
    // ── 面板信息 ───────────────────────────────────
    getUnitPanelLines: ({ state, unit }) => {
      if (!isCultivatorUnit(state, unit)) return [];
      const rank = getRank(unit);
      const exp = getExp(unit);
      const age = unit.age ?? 0;
      const lifespan = getLifespan(unit);
      const aging = getAgingYears(unit);
      
      // 升级所需总经验
      const nextExp = rank < MAX_RANK ? Math.floor(10 + 10 * rank * (rank+1) + 0.05 * 4 ** rank) : null;

      const lines = [
        `当前境界：第 ${rank} / ${MAX_RANK} 层   ${_REAMLS[rank]}期`,
        nextExp !== null
          ? `修为经验：${exp} / ${nextExp}`
          : `修为经验：${exp}（已臻化境）`,
        `寿元：${age} / ${Number.isFinite(lifespan) ? lifespan : '∞'}`,
      ];

      if (rank > 0) {
        const trueDmg = trueDamageOf(unit);
        lines.push(
          `境界加成：攻击 +${Math.floor(5 * rank + 2**(rank-0.5))} · 护甲 +${Math.floor(-1 + rank * rank + 1.5**rank)} · 射程 +${Math.floor(rank/2)} · 神识 +${Math.floor(rank)} · 攻击次数 ${Math.max(1, Math.floor((rank + 1) / 2))}`,
        );
        if (trueDmg > 0) lines.push(`真元：每次攻击附带 ${trueDmg} 点无视护甲的真实伤害`);
      }

      if (aging > 0) {
        lines.push(
          `油尽灯枯：攻击 -${aging * 2} · 护甲 -${aging} · 神识 -${aging}`,
        );
        const remaining = lifespan + AGING_DEATH_AGE - age;
        if (remaining > 0) lines.push(`坐化倒计时：${remaining} 年`);
      }

      return lines;
    },
  },
  units: [CULTIVATOR],
  abilities: [QI_TRUE_DAMAGE], 
};


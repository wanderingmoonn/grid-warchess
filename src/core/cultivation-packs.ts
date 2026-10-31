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
const _REAMS: string[] = ["凡人","炼气","筑基","金丹","元婴","化神","返虚","合体","大乘","渡劫"];

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
          const x = getRank(c.self)
          const trueDmg = Math.floor((x*x)/2+x*(1.2**x));
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
    u.maxHpBonus = (u.maxHpBonus ?? 0) + deltaMaxHp;
    u.hp += deltaMaxHp; // 升级瞬间回血
    
    s.log.push({
      turn: s.turn,
      player: u.owner, 
      text: `炼气士 突破至 ${_REAMS[newRank]} 期！`,
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
  return 10 + rank * 10;
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
function atkModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = 5 * rank + 2**(rank-0.5);
  return Math.floor(realmsModifier - getAgingYears(u) * 2);
}
/** 真伤修正：用能力实现，不用在这里写 */
/** 攻击次数修正 */
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
/** 射程修正 */
function RangeModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = rank/2;
  return Math.floor(realmsModifier);
}
/** 视野修正 */


export const CULTIVATION_PACK: Expansion = {
  id: 'cultivation',
  name: '修真',
  summary: '带来了会修炼成长的炼气士。',
  scale: 'large',  
  hooks: {
    //升级逻辑
    // 1. 击杀敌人获得经验
    onUnitKilled: (c) => {
      if (c.killer && c.killer.type === 'qi-cultivator') {
        addExp(c.killer, c.state, 10); 
      }
    },
    modifyDamage: ({ attacker, damage }) => {
      if (attacker.type !== 'qi-cultivator') return damage;
      return damage + atkModifier(attacker);
    },
    // 攻城加成
    modifySiegeDamage: ({ attacker, damage }) => {
      if (attacker.type !== 'qi-cultivator') return damage;
      return Math.max(0, damage + atkModifier(attacker));
    },
    // 面板修正
    modifyStatAtk: ({ unit, atk }) => {
      if (unit.type !== 'qi-cultivator') return atk;
      return atk + atkModifier(unit);
    },
    // 2. 护甲加成（每级 +1 护甲）
    modifyArmor: ({ defender, armor }) => {
      if (defender.type !== 'qi-cultivator') return armor;
      return Math.max(0, armor + armorModifier(defender));
    },
    // 3. 射程加成（假设等级 2 以上，射程变远）
    modifyRange: ({ unit, range }) => {
      if (unit.type === 'qi-cultivator') {
        return range + RangeModifier(unit);
      }
      return range;
    },
    // ── 视野（神识）：随境界提升，随衰老枯竭 ─────────
    modifyVision: ({ unit, base }) => {
      if (!unit || unit.type !== 'qi-cultivator') return base;
      const rank = getRank(unit);
      const aging = getAgingYears(unit);
      // 神识：随境界每级 +1 格；衰老：每超龄 1 岁 -1 格。
      return Math.max(1, base + rank - aging);
    },
    // 一回合攻击次数：(x+1)/2 向下取整，至少 1。
    // x=0~2 -> 1次，x=3~4 -> 2次，x=5~6 -> 3次，x=7~8 -> 4次，x=9 -> 5次。
    modifyAttacks: ({ unit, attacks }) => {
      if (unit.type !== 'qi-cultivator') return attacks;
      return Math.max(1, Math.floor((getRank(unit) + 1) / 2));
    },
    // ── 溅射半径：floor(x/4) ────────────────────────
    // x=0~3 -> 0，x=4~7 -> 1，x=8~9 -> 2
    modifySplash: ({ attacker, splash }) => {
      if (attacker.type !== 'qi-cultivator') return splash;
      return Math.floor(getRank(attacker) / 4);
    },
    // ── 移动 ─────────────────────
    modifyMove: ({ unit, move }) => {
      if (unit.type !== 'qi-cultivator') return move;
      return move + moveModifier(unit);
    },
    // ── 回合开始：寿元判定 + 打坐 ──────────────────
    onTurnStart: ({ state, player }) => {
      for (const u of state.units) {
        if (u.owner !== player || u.type !== 'qi-cultivator') continue;
        const age = u.age ?? 0;
        const lifespan = getLifespan(u);

        if (isDoomed(u)) {
          if (u.hp > 0) {
            u.hp = 0;
            state.log.push({
              turn: state.turn,
              player,
              text: `炼气士 寿元耗尽，油尽灯枯，只待最后一丝生机散去。`,
            });
          }
          // 把清场交给核心的 sweepDead。
          // 玩家可以在清场前打出最后一击或者寻找保命手段。
          continue;
        }

        // 2. 刚跨过寿元：写一次警告
        if (age === lifespan + 1) {
          state.log.push({
            turn: state.turn,
            player,
            text: `炼气士 寿元将尽，身体每况愈下。`,
          });
        }

        // 3. 打坐：老死前照常修炼
        addExp(u, state, getExpGrowth(u));
      }
    },
    
    // ── 面板信息 ───────────────────────────────────
    getUnitPanelLines: ({ unit }) => {
      if (unit.type !== 'qi-cultivator') return [];
      const rank = getRank(unit);
      const exp = getExp(unit);
      const age = unit.age ?? 0;
      const lifespan = getLifespan(unit);
      const aging = getAgingYears(unit);
      
      // 升级所需总经验
      const nextExp = rank < MAX_RANK ? Math.floor(10 + 10 * rank * (rank+1) + 0.05 * 4 ** rank) : null;

      const lines = [
        `当前境界：第 ${rank} / ${MAX_RANK} 层   ${_REAMS[rank]} 期`,
        nextExp !== null
          ? `修为经验：${exp} / ${nextExp}`
          : `修为经验：${exp}（已臻化境）`,
        `寿元：${age} / ${Number.isFinite(lifespan) ? lifespan : '∞'}`,
      ];

      if (rank > 0) {
        const trueDmg = Math.floor((rank*rank)/2+rank*(1.2**rank));
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


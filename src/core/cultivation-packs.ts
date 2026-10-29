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

// 炼气士
const CULTIVATOR: UnitTypeDef = {
  id: 'qi-cultivator',
  name: '炼气士',
  short: '炼',
  era: 1,
  category: 'combat',
  cost: 100,
  move: 3,
  atk: 1,
  armor: 0,
  maxHp: 2,
  range: 2,
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
          const trueDmg = Math.floor(getRank(c.self) / 2);
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
  while (rank < MAX_RANK && exp >= 2 ** (rank + 1)) {
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
  if (newRank > rank) {
    u.maxHpBonus = (u.maxHpBonus ?? 0) + 5;
    u.hp += 5; // 升级瞬间回 5 血
    
    s.log.push({
      turn: s.turn,
      player: u.owner, 
      text: `炼气士 突破至 ${newRank} 层！`,
      open: true,
    });
  }
}
// 自然经验增长
function getExpGrowth(u: Unit): number {
  return getRank(u)*2+2;
}

// ── 寿元与衰老 ─────────────────────────────────────
// 规则：age > lifespan 开始减益，age - lifespan >= AGING_DEATH_AGE 才老死。
/** 寿元耗尽后还能撑几年才真正老死 */
const AGING_DEATH_AGE = 3;
function getLifespan(u: Unit): number {
  const rank = getRank(u);
  if (rank >= MAX_RANK) return Infinity;
  return 5 + rank * 5;
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
// 返回的是增量，

/** 攻击力修正：境界 +2/级，衰老 −2/岁 */
function atkModifier(u: Unit): number {
  return getRank(u) * 2 - getAgingYears(u) * 2;
}

/** 炼气士的护甲修正：境界 +1/级，衰老 −1/岁 */
function armorModifier(u: Unit): number {
  return getRank(u) - getAgingYears(u);
}

export const CULTIVATION_PACK: Expansion = {
  id: 'cultivation',
  name: '修真·炼气',
  summary: '带来了会修炼成长的炼气士。',
  hooks: {
    //升级逻辑
    // 1. 击杀敌人获得经验
    onUnitKilled: (c) => {
      if (c.killer && c.killer.type === 'qi-cultivator') {
        addExp(c.killer, c.state, 15); 
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
      if (unit.type === 'qi-cultivator' && getRank(unit) >= 2) {
        return range + 1;
      }
      return range;
    },
    // 一回合攻击次数：(x+1)/2 向下取整，至少 1。
    // x=0~2 -> 1次，x=3~4 -> 2次，x=5~6 -> 3次，x=7~8 -> 4次，x=9 -> 5次。
    modifyAttacks: ({ unit, attacks }) => {
      if (unit.type !== 'qi-cultivator') return attacks;
      return Math.max(1, Math.floor((getRank(unit) + 1) / 2));
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
              open: true,
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
            open: true,
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
      
      // 升级所需总经验：2^(rank+1)
      const nextExp = rank < MAX_RANK ? 2 ** (rank + 1) : null;

      const lines = [
        `当前境界：第 ${rank} 层 / ${MAX_RANK}`,
        nextExp !== null
          ? `修为经验：${exp} / ${nextExp}`
          : `修为经验：${exp}（已臻化境）`,
        `寿元：${age} / ${Number.isFinite(lifespan) ? lifespan : '∞'}`,
      ];

      if (rank > 0) {
        const trueDmg = Math.floor(rank / 2);
        const splash = Math.floor(rank / 4);
        lines.push(
          `境界加成：攻击 +${rank} · 护甲 +${rank} · 射程 +${rank} · 攻击次数 ${Math.max(1, Math.floor((rank + 1) / 2))}`,
        );
        if (trueDmg > 0) lines.push(`真元：每次攻击附带 ${trueDmg} 点无视护甲的真实伤害`);
        if (splash > 0) lines.push(`溅射半径：${splash}`);
      }

      if (aging > 0) {
        lines.push(
          `油尽灯枯：攻击 -${aging * 2} · 护甲 -${aging} · 视野 -${aging}`,
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


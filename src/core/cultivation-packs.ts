import type { 
  Expansion
 } from './expansions.ts';
import type { 
  GameState,
  Unit,
  City,
  SkillDef
} from './types.ts';
import type { AbilityApi } from './ability-hooks.ts';
import { registerSkillEffect, registerSkillReadyCheck, registerSkillPreview} from './skill-hooks.ts';
import {
  isCultivatorUnit,
} from './cultivation/identity.ts';
import { 
  REALMS,  getExp, getRank, getMaxHp, expForRank,ensureLifespan,isDoomed, sumDeltaMaxHpUpTo,  addExp, 
  onRankUp
} from './cultivation/progression.ts';

import { 
  atkModifier,attTimesModifier, armorModifier, 
  moveModifier, SplashModifier, RangeModifier, VisionModifier 
} from './cultivation/stats.ts';

import { SKY_STEP_SKILL, getSwordSweepReach } from './cultivation/skills.ts';
import { SPIRIT_CULTIVATOR, CULTIVATOR, SWORD_CULTIVATOR } from './cultivation/units.ts';
import { QI_TRUE_DAMAGE, SPIRIT_ASCENSION } from './cultivation/abilities.ts';

import { getCultivationPanelLines } from './cultivation/panel.ts';

export { 
  getAgingYears 
} from './cultivation/progression.ts';


function canSkyStep(s: GameState, u: Unit, api: AbilityApi): string | null {
  if (!isCultivatorUnit(s, u)) return '只有修士才能御空';
  if (getRank(u) < 2) return '境界不足（需要 2 级）';
  if ((u.custom?.skyStepTurn as number) === s.turn) return '御空每回合只能一次';
  if (api.movePower(s, u) <= 0) return '剩余移动力不足';
  return null;
}

registerSkillReadyCheck('sky-step', (s, u, api) => canSkyStep(s, u, api!) ?? true);

registerSkillEffect('sky-step', (c) => {
  const why = canSkyStep(c.state, c.self, c.api);
  if (why) { c.result.ok = false; c.result.reason = why; return; }

  const targetAir = !c.api.isAirborne(c.state, c.self);
  const blockers = c.api
    .unitsAt(c.state, c.self.x, c.self.y)
    .filter((u) => u.id !== c.self.id && c.api.isAirborne(c.state, u) === targetAir);
  if (blockers.length > 0) {
    c.result.ok = false;
    c.result.reason = targetAir ? '同一格已有其他空中单位' : '同一格已有其他地面单位';
    return;
  }

  if (targetAir) c.self.layer = 'air';
  else delete c.self.layer;

  c.self.moveSpent = (c.self.moveSpent ?? 0) + 1;
  c.self.custom = { ...(c.self.custom ?? {}), skyStepTurn: c.state.turn };
  c.result.log = `${c.api.utype(c.state, c.self.type).name} ${targetAir ? '升空' : '落地'}`;
});

registerSkillReadyCheck('sword-sweep', (s, u) => {
  const left = u.attacksLeft ?? (s.unitTypes[u.type].burst ?? 1);
  return left > 0;
});

/** 算出剑气打向 (targetX, targetY) 时，覆盖的所有格子坐标 */
function getSwordSweepCells(
  s: GameState, 
  self: Unit, 
  targetX: number, 
  targetY: number
): Array<{ x: number; y: number }> {
  const reach = getSwordSweepReach(s, self);
  let dx = 0;
  let dy = 0;

  const distX = targetX - self.x;
  const distY = targetY - self.y;
  dx = Math.sign(distX);
  dy = Math.sign(distY);

  // 四方向吸附
  if (Math.abs(distX) > Math.abs(distY)) dy = 0;
  else if (Math.abs(distY) > Math.abs(distX)) dx = 0;
  if (dx === 0 && dy === 0) dx = 1;

  const cells: Array<{ x: number; y: number }> = []; // 👈 这里也要是对象数组
  for (let i = 1; i <= reach; i++) {
    const tx = self.x + dx * i;
    const ty = self.y + dy * i;
    if (tx >= 0 && ty >= 0 && tx < s.w && ty < s.h) {
      cells.push({ x: tx, y: ty }); // 👈 推入对象，而不是数字
    }
  }
  return cells;
}
registerSkillEffect('sword-sweep', (c) => {
  // 1. 扣除攻击次数
  if (c.self.attacksLeft === undefined) {
    c.self.attacksLeft = c.api.attacksPerTurn(c.state, c.self);
  }
  if (c.self.attacksLeft <= 0) {
    c.result.ok = false;
    c.result.reason = '本回合的攻击次数已经用光了，无法再挥剑';
    return;
  }
  c.self.attacksLeft -= 1;
  if (c.self.attacksLeft <= 0) {
    c.self.acted = true;
  }
  c.self.moved = true;

  // 2. 算路径
  const tx = c.target?.x ?? c.self.x + 1;
  const ty = c.target?.y ?? c.self.y;
  const hitCells = getSwordSweepCells(c.state, c.self, tx, ty);

  // 战况烈度：剑气扫过的每一格都记，含空格——这才是"范围"的完整口径。
  // noteHeatCell 默认记到"当前行动方的对手"账上，正好是"对方阵地上的弹坑"。
  for (const cell of hitCells) {
    c.api.noteHeat(c.state, cell.x, cell.y);
  }

  // 3. 找受害者
  const victims = c.state.units.filter(u =>
    u.owner !== c.self.owner &&
    u.hp > 0 &&
    hitCells.some(cell => cell.x === u.x && cell.y === u.y)
  );

  const cityVictims: City[] = [];
  for (const cell of hitCells) {
    const city = c.state.cities.find(ct =>
      ct.owner !== c.self.owner &&
      !ct.ruined &&
      cell.x >= ct.x && cell.x < ct.x + ct.size &&
      cell.y >= ct.y && cell.y < ct.y + ct.size
    );
    if (city && !cityVictims.includes(city)) {
      cityVictims.push(city);
    }
  }

  // 4. 记起始修为：用来在战报里报本次总增长（命中基础 + onUnitKilled 给的斩杀经验）
  const expBefore = getExp(c.self);

  // 5. 伤害结算
  let expGain = 1;
  let logExtra = '';
  let deadCount = 0;

  if (victims.length > 0 || cityVictims.length > 0) {
    expGain += victims.length * 5 + cityVictims.length * 5;
    let totalDmg = 0;

    // 剑修技能模式：境界加成从普攻 ×0.8 切到 ×1.2
    c.self.custom ??= {};
    c.self.custom.swordSweepActive = true;
    try {
      for (const v of victims) {
        const dmg = c.api.computeDamage(c.state, c.self, v);
        v.hp -= dmg;
        totalDmg += dmg;
      }
      for (const ct of cityVictims) {
        const fakeCity = {
          type: '__city__',
          __isCity: true,
          __city: ct,
          x: ct.x, y: ct.y,
          status: {},
        } as any;
        const dmg = c.api.computeDamage(c.state, c.self, fakeCity);
        ct.hp -= dmg;
        totalDmg += dmg;
        if (ct.hp <= 0) {
          // 调用核心统一接口：处理变废墟、挤人、写战报
          c.api.destroyCity(c.state, ct, c.self.owner);
        }
      }
    } finally {
      delete c.self.custom.swordSweepActive;
    }

    // 命中基础经验（可能触发突破）
    addExp(c.self, c.state, expGain);

    // 逐人走完整死亡流程：onDeath、onUnitKilled 会依次触发。
    // 剑修的斩杀经验（20/人）由 onUnitKilled 给，这里不重复加。
    for (const v of victims) {
      if (v.hp > 0) continue;
      c.api.killUnit(c.state, v, c.self, `${c.api.utype(c.state, v.type).name} 被剑气斩杀`);
      deadCount++;
    }

    // 组装战报
    const hitTexts: string[] = [];
    if (victims.length > 0) hitTexts.push(`${victims.length} 人`);
    if (cityVictims.length > 0) hitTexts.push(`${cityVictims.length} 城`);

    const parts: string[] = [];
    if (hitTexts.length > 0) parts.push(`命中 ${hitTexts.join('、')}`);
    if (deadCount > 0) parts.push(`斩杀 ${deadCount} 人`);
    parts.push(totalDmg > 0 ? `造成 ${totalDmg} 伤害` : `未造成伤害`);
    logExtra = `，${parts.join('，')}`;
  } else {
    // 落空也给一点基础修为（原有设计：练剑一轮）
    addExp(c.self, c.state, expGain);
    logExtra = `，剑气落空`;
  }

  // 6. 战报：修为报本次总增长（命中基础 + onUnitKilled 给的斩杀经验）
  const totalExp = getExp(c.self) - expBefore;
  c.result.log = `剑气纵横${logExtra}，修为 +${totalExp}`;
});
registerSkillPreview('sword-sweep', (c) => {
  const cells = getSwordSweepCells(c.state, c.self, c.target.x, c.target.y);
  return cells.map(cell => cell.y * c.state.w + cell.x);
});

registerSkillReadyCheck('spirit-rebirth', (_s, u) => {
  if (u.type !== 'cultivator-spirit') return '只有灵体能重生';
  if (!u.custom?.originType) return '本源已散失，无法重生';
  return true;
});

registerSkillEffect('spirit-rebirth', (c) => {
  const { self, state } = c;
  if (self.type !== 'cultivator-spirit') {
    c.result.ok = false;
    c.result.reason = '只有灵体能重生';
    return;
  }
  // 这里先判 originType
  const originType = self.custom?.originType as string | undefined;
  if (!originType) {
    c.result.ok = false;
    c.result.reason = '本源已散失，无法重生';
    return;
  }

  // 此时 TS 已经知道 originType 是 string
  const originDef = state.unitTypes[originType];
  if (!originDef) {
    c.result.ok = false;
    c.result.reason = '本源已散失，无法重生';
    return;
  }

  const oldRank = getRank(self);
  const newRank = Math.max(0, oldRank - 1);
  // 新经验：原 "x-1 升 x 门槛" 的一半（绝对量）
  const newExp = Math.floor(expForRank(newRank) / 2);

  // 合并技能（saved ∪ current，按 id 去重）
  const savedExtraSkills = (self.custom?.savedExtraSkills as SkillDef[]) ?? [];
  const currentExtraSkills = self.extraSkills ?? [];
  const mergedExtraSkills = [...savedExtraSkills];
  for (const k of currentExtraSkills) {
    if (!mergedExtraSkills.some((m) => m.id === k.id)) mergedExtraSkills.push(k);
  }
  // 合并能力
  const savedExtraAbilities = (self.custom?.savedExtraAbilities as string[]) ?? [];
  const currentExtraAbilities = self.extraAbilities ?? [];
  const mergedExtraAbilities = [...savedExtraAbilities];
  for (const id of currentExtraAbilities) {
    if (!mergedExtraAbilities.includes(id)) mergedExtraAbilities.push(id);
  }

  // 清 custom 上的灵体暂存字段，保留 rank / lifespan / exp
  const cachedLifespan = self.custom?.lifespan;
  self.custom = { rank: newRank, exp: newExp };
  if (typeof cachedLifespan === 'number') (self.custom as any).lifespan = cachedLifespan;

  self.type = originType;
  self.extraSkills = mergedExtraSkills;
  self.extraAbilities = mergedExtraAbilities;
  // maxHpBonus 按降级后 rank 重算（当前包内唯一来源是升级，安全）
  self.maxHpBonus = sumDeltaMaxHpUpTo(newRank);

  // 血量 10% 上限
  self.hp = Math.max(1, Math.ceil(getMaxHp(state, self) * 0.1));
  // 行动状态：本回合不能再行动
  self.moved = true;
  self.acted = true;
  // 清技能状态
  delete self.skillCd;
  delete self.skillCharge;
  delete self.skillTurn;

  // 降级清理（掉 < 4 时移除 spirit-ascension）
  cleanupAfterRankDrop(self, newRank);

  c.result.log = `${originDef.name} 从灵体重塑肉身（降为 ${REALMS[newRank]} 期，恢复 ${self.hp} 点生命）`;
});

/**
 * 让单位学会一个后天技能。如果已经学过，什么都不做。
 * 返回 true 表示这是一次「新学会」，方便调用方写战报。
 */
export function learnSkill(u: Unit, skill: SkillDef): boolean {
  u.extraSkills ??= [];
  if (u.extraSkills.some((k) => k.id === skill.id)) return false;
  u.extraSkills.push(skill);
  return true;
}

/** 境界达到对应等级时自动领悟的技能 */
const CULTIVATOR_SKILL_UNLOCKS: Array<{ rank: number; skill: SkillDef }> = [
  { rank: 2, skill: SKY_STEP_SKILL },
];

/** 检查并领悟所有达标的新技能 */
function checkSkillUnlocks(u: Unit, s: GameState): void {
  for (const { rank, skill } of CULTIVATOR_SKILL_UNLOCKS) {
    if (getRank(u) >= rank) {
      if (learnSkill(u, skill)) {
        s.log.push({
          turn: s.turn,
          player: u.owner,
          text: `${s.unitTypes[u.type]?.name ?? u.type} 领悟了「${skill.name}」`,
          open: true,
        });
      }
    }
  }
}

/**
 * 降级后清理：删掉所有"需要更高境界才能维持"的能力和技能。
 *
 * 目前唯一的一条：掉到 rank < 4 后不再拥有「灵体道果」——再死就真死。
 * 未来若有其它 rank 门槛的能力/技能，在这里按同一条规则追加。
 */
function cleanupAfterRankDrop(u: Unit, newRank: number): void {
  if (newRank < 4 && u.extraAbilities?.includes('spirit-ascension')) {
    u.extraAbilities = u.extraAbilities.filter((id) => id !== 'spirit-ascension');
  }
}



const CULTIVATOR_ABILITY_UNLOCKS: Array<{ rank: number; abilityId: string; name: string }> = [
  { rank: 4, abilityId: 'spirit-ascension', name: '灵体道果' },
];

/**
 * 检查并挂上所有达标的新能力。
 *
 * 和 `checkSkillUnlocks` 的区别：技能学一次就不再补（`learnSkill` 有幂等），
 * 能力则可能**被清理**——比如灵体重生降级后 `spirit-ascension` 被移除，
 * 如果这个修士之后又修炼回 rank 4，这里要能把它重新挂上。
 * 所以没有"学过就不动"的标记，每次调用都检查 id 是否在 `extraAbilities` 里。
 */
function checkAbilityUnlocks(u: Unit, s: GameState): void {
  u.extraAbilities ??= [];
  for (const { rank, abilityId, name } of CULTIVATOR_ABILITY_UNLOCKS) {
    if (getRank(u) < rank) continue;
    if (u.extraAbilities.includes(abilityId)) continue;
    u.extraAbilities.push(abilityId);
    s.log.push({
      turn: s.turn,
      player: u.owner,
      text: `${s.unitTypes[u.type]?.name ?? u.type} 感悟「${name}」`,
      open: true,
    });
  }
}

onRankUp((u, s) => {
  checkSkillUnlocks(u, s);
  checkAbilityUnlocks(u, s);
});

/** 导出给测试用 */
export function cultivationRank(u: Unit): number {
  return getRank(u);
}

/**
 * 设置经验并重算等级。
 *
 * 用于"扮演特定等级"的场景：测试、调试、未来的读档导入/回合回放。
 * 和 `addExp` 的差别：
 *   · `addExp` 走升级流程（回血、战报、技能领悟），只能升不降；
 *   · 这里**只设置数值**，不触发任何副作用——正是"我想让这个单位处于
 *     rank=x、exp=y 的状态"该用的入口。
 *
 * 不重置 `custom.rank` 的话，`getRank` 会继续读旧缓存。这是 2026-11-04
 * 等级显式化之后的设计：exp 和 rank 解耦，改 exp 不代表改 rank。
 * 想"按 exp 反推等级"就调这个函数；想"只减经验不掉级"就只改 `custom.exp`。
 */
export function setCultivationExp(u: Unit, exp: number): void {
  u.custom = { ...(u.custom ?? {}), exp };
  delete u.custom.rank;
  getRank(u);   // 触发反推并写回
}

// 自然经验增长
function getExpGrowth(u: Unit): number {
  // 剑修注重实战，打坐只能获得一半经验（向下取整，最少 1）
  if (u.type === 'sword-cultivator') {
    return Math.max(1, Math.floor((getRank(u) + 2) / 2));
  }
  return getRank(u) + 2;
}

export const CULTIVATION_PACK: Expansion = {
  id: 'cultivation',
  name: '修真',
  summary: '带来了会修炼成长的各种修士。',
  scale: 'large',  
  hooks: {
    //升级逻辑
    // 1. 击杀敌人获得经验
    onUnitKilled: (c) => {
      if (c.killer && isCultivatorUnit(c.state, c.killer)) {
        let killexp=10;
        if (c.killer.type === 'sword-cultivator'){
          killexp = killexp * 2;
        }
        addExp(c.killer, c.state, killexp); 
      }
    },
    modifyDamage: ({ state, attacker, damage }) => {
      if (!isCultivatorUnit(state, attacker)) return damage;
      // 剑修：境界加成按模式缩放（普攻 ×0.8 / 剑气纵横 ×1.2）
      const mul = attacker.type === 'sword-cultivator'
        ? (attacker.custom?.swordSweepActive === true ? 1.2 : 0.8)
        : 1.0;
      return damage + Math.floor(atkModifier(attacker) * mul);
    },
    // 攻城加成
    modifySiegeDamage: ({ state, attacker, damage }) => {
      if (!isCultivatorUnit(state, attacker)) return damage;
      const mul = attacker.type === 'sword-cultivator'
        ? (attacker.custom?.swordSweepActive === true ? 1.2 : 0.8)
        : 1.0;
      return Math.max(0, damage + Math.floor(atkModifier(attacker) * mul));
    },
    // 面板修正
    modifyStatAtk: ({ state, unit, atk }) => {
      if (!isCultivatorUnit(state, unit)) return atk;
      const mul = unit.type === 'sword-cultivator' ? 0.8 : 1.0;
      return atk + Math.floor(atkModifier(unit) * mul);
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
        // 首次访问（老存档）时把寿元落库，之后降级不会让寿命跟着回退
        const lifespan = ensureLifespan(u);

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
    getUnitPanelLines: ({ state, unit }) => getCultivationPanelLines(state, unit),
  },
  abilities: [QI_TRUE_DAMAGE, SPIRIT_ASCENSION],
  units: [CULTIVATOR, SWORD_CULTIVATOR, SPIRIT_CULTIVATOR],
};


import type { 
  Expansion
 } from './expansions.ts';
import type { 
  GameState,
  UnitTypeDef,
  Unit,
  City,
  SkillDef
} from './types.ts';
import type { AbilityDef } from './abilities.ts';
import type { AbilityApi } from './ability-hooks.ts';
import { skillsOf } from './types.ts';
import { DAMAGE_STAGE } from './ability-hooks.ts';
import { registerSkillEffect, registerSkillReadyCheck, registerSkillPreview} from './skill-hooks.ts';

// 境界名称
const _REALMS: string[] = ["凡人","炼气","筑基","金丹","元婴","化神","返虚","合体","大乘","渡劫"];

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
const CULTIVATOR_IDS = new Set([
  'qi-cultivator', 
  'sword-cultivator'
]);

/** 从兵种定义查。给"手里只有 def"的场合用。 */
export function isCultivatorDef(def: UnitTypeDef | undefined | null): boolean {
  return !!def && CULTIVATOR_IDS.has(def.id);
}

/** 从单位查。给钩子用——钩子里拿到的几乎都是 Unit。 */
export function isCultivatorUnit(s: GameState, u: Unit): boolean {
  return isCultivatorDef(s.unitTypes[u.type]);
}

const SKY_STEP_SKILL: SkillDef = {
  id: 'sky-step',
  name: '御空',
  summary: '在低空与地面之间切换。消耗 1 点移动力，每回合一次。',
  effect: 'sky-step',
  cooldown: 0,
  multiCast: true,
};

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

const SWORD_SWEEP_SKILL:SkillDef = {
  id: 'sword-sweep',
  name: '剑气纵横',
  summary: '向指定方向挥出剑气，穿透路径上的敌人，释放与命中均可增加修为。',
  effect: 'sword-sweep',
  cooldown: 0,
  multiCast: true,
  targeting: 'direction', // 声明它需要选方向
  notReadyReason: '攻击次数不足',
};
registerSkillReadyCheck('sword-sweep', (s, u) => {
  const left = u.attacksLeft ?? (s.unitTypes[u.type].burst ?? 1);
  return left > 0;
});
/** 计算剑气纵横的直线长度（距离） */
export function getSwordSweepReach(s: GameState, u: Unit): number {
  // 如果它是修士，就按境界加成算
  if (isCultivatorUnit(s, u)) {
    const rank = getRank(u);
    return 3 + Math.ceil(rank / 3);
  }
  // 如果是别的兵种（未来扩展）借用了这个技能，默认给个基础值 3
  return 3; 
}
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

const SPIRIT_REBIRTH_SKILL: SkillDef = {
  id: 'spirit-rebirth',
  name: '重生',
  summary: '重塑肉身：失去一半修为并强制降一境，恢复 10% 最大生命。',
  effect: 'spirit-rebirth',
  cooldown: 0,
  multiCast: false,
};

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

  c.result.log = `${originDef.name} 从灵体重塑肉身（降为 ${_REALMS[newRank]} 期，恢复 ${self.hp} 点生命）`;
});
function isSpirit(u: Unit): boolean {
  return u.type === 'cultivator-spirit';
}
/** 未来魂修集合：化灵后不吃削弱 */
const SOUL_MASTER_IDS = new Set<string>();
function isSoulMasterSpirit(u: Unit): boolean {
  if (!isSpirit(u)) return false;
  const origin = u.custom?.originType as string | undefined;
  return !!origin && SOUL_MASTER_IDS.has(origin);
}

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

//各种单位
//灵体
const SPIRIT_CULTIVATOR: UnitTypeDef = {
  id: 'cultivator-spirit',
  name: '灵体',
  short: '灵',
  era: 1,
  category: 'combat',
  cost: 0,
  move: 3,
  atk: 0,
  armor: 0,
  maxHp: 1,
  range: 1,
  vision: 3,
  layer: 'air',
  flight: true, 
  summonedOnly: true,
  abilities: ['qi-true-damage'],
  skills: [SPIRIT_REBIRTH_SKILL],
};
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
// 剑修
const SWORD_CULTIVATOR: UnitTypeDef = {
  id: 'sword-cultivator',
  name: '剑修',
  short: '剑',
  era: 2,
  category: 'combat',
  cost: 350, 
  move: 3,
  atk: 8,
  armor: 1,
  maxHp: 20,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage'], 
  skills: [SWORD_SWEEP_SKILL],
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

const SPIRIT_ASCENSION: AbilityDef = {
  id: 'spirit-ascension',
  name: '灵体道果',
  summary: '境界达到炼气期（≥ 4 级）时，肉身死亡会化作灵体，可主动重生。',
  group: 'defense',
  hooks: {
    onDeath: (c) => {
      const { state, victim, api } = c;
      if (!isCultivatorUnit(state, victim)) return;
      if (victim.type === 'cultivator-spirit') return;// 灵体死了就真死
      if (victim.custom?.spiritForm === true) return;
      if (isDoomed(victim)) return;// 老死 → 真死
      if (getRank(victim) < 4) return;
      const spiritDef = state.unitTypes['cultivator-spirit'];
      if (!spiritDef) return;

      // 落脚点：原地优先，若 air 层同格冲突则找相邻空格
      let x = victim.x, y = victim.y;
      if (!api.canStandAt(state, x, y, 'cultivator-spirit')) {
        const spot = api.freeNeighbor(state, victim, 'cultivator-spirit');
        if (!spot) return;// 无处落脚，真死
        x = spot.x; y = spot.y;
      }

      // 暂存与过滤
      const savedExtraSkills = victim.extraSkills ?? [];
      const savedExtraAbilities = victim.extraAbilities ?? [];
      const soulBound = savedExtraSkills.filter((k) => k.custom?.soulBound === true);
      const otherAbilities = savedExtraAbilities.filter((id) => id !== 'spirit-ascension');

      const originMaxHpBonus = victim.maxHpBonus ?? 0;
      const originType = victim.type;
      const originName = state.unitTypes[originType]?.name ?? originType;
      const rankNow = getRank(victim);

      victim.custom = {
        ...(victim.custom ?? {}),
        spiritForm: true,
        originType,
        savedExtraSkills,
        savedExtraAbilities,
        originMaxHpBonus,
      };
      victim.type = 'cultivator-spirit';
      victim.x = x; victim.y = y;
      victim.maxHpBonus = Math.floor(originMaxHpBonus * 0.3);
      victim.hp = 1 + victim.maxHpBonus;
      victim.moved = true;
      victim.acted = true;
      victim.status = {};
      delete victim.heroBuff;
      delete victim.countersLeft;
      victim.extraSkills = soulBound;
      victim.extraAbilities = otherAbilities;

      state.units.push(victim);
      api.pushLog(state, victim.owner,
        `${originName} 肉身崩碎，化作灵体（境界 ${_REALMS[rankNow]} 期）`, true);
    },
  },
};

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

// ── 经验与境界 ───────────────────────
// 读取当前经验，如果没有初始化就返回 0
function getExp(u: Unit): number {
  return (u.custom?.exp as number) ?? 0;
}

/**
 * 从 `rank` 级升到 `rank + 1` 级所需的总经验门槛。
 *
 * 语义直接来自旧 `getRank` 的 while 循环在 `rank = r` 时的检查
 * `exp >= expForRank(r)`，所以它天然是"从 r 升到 r+1 的门槛"：
 *   expForRank(0) = 10  → 0 级升 1 级
 *   expForRank(1) = 30  → 1 级升 2 级（累计）
 *   expForRank(2) = 70  → 2 级升 3 级（累计）
 */
function expForRank(rank: number): number {
  return Math.floor(10 + 10 * rank * (rank + 1) + 0.05 * 4 ** rank);
}

/**
 * 从 `fromRank` 升到 `toRank` 一次性加多少生命上限。
 *
 * 用 `to³ - from³` 的**差**而不是逐级累加：两者数值等价（telescoping sum），
 * 但写成一跳的形态和 `addExp` 原有的"跨级只回一次血"保持完全一致——
 * 改写成逐级的话，`Math.floor` 在每级都会丢一次精度，回血量会和以前不同。
 */
function maxHpDeltaBetween(fromRank: number, toRank: number): number {
  return Math.floor(
    8.5 * (toRank - fromRank) +
    0.0685 * (toRank ** 3 * 1.8 ** toRank - fromRank ** 3 * 1.8 ** fromRank),
  );
}
function sumDeltaMaxHpUpTo(rank: number): number {
  let total = 0;
  for (let r = 1; r <= rank; r++) total += maxHpDeltaBetween(r - 1, r);
  return total;
}

/** 等级上限 */
const MAX_RANK = 9;
/**
 * 读境界等级。
 *
 * 2026-11-04 起，等级是**存在 `custom.rank` 上的显式字段**，不再每次
 * 现场反推。理由有三个：
 *   1. 「灵体重生」要强制降 1 级，而经验是被减半的——两者不联动，
 *      用 while 反推做不到"exp 掉一半但等级只掉一级"；
 *   2. 未来的「燃烧修为」要"消耗经验但不掉级"，同样要求解耦；
 *   3. `addExp` 的升级判定需要知道"当前是不是真的升了级"，
 *      反推版本里 `newRank > rank` 的比较口径和 exp 减少后的反推混在一起，
 *      一旦 exp 能被外部减少就会误判。
 *
 * 老存档没有这个字段：反推一次并写回。反推是确定性的，写回不改变任何
 * 面板可见数字，所以即使被 UI 的 `effectiveStats` 触发（它承诺纯查询）
 * 也不会出现"看一眼面板规则就变了"。
 *
 * 反推后，如果外部只改 `custom.exp` 而不改 `custom.rank`，下次读仍是
 * 反推那一次的值——这正是"经验和等级解耦"的语义。
 */
function getRank(u: Unit): number {
  const cached = u.custom?.rank;
  if (typeof cached === 'number') return cached;
  const exp = getExp(u);
  let rank = 0;
  while (rank < MAX_RANK && exp >= expForRank(rank)) rank++;
  u.custom = { ...(u.custom ?? {}), rank };
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

/**
 * 增加经验并即时判断升级。
 *
 * **只升不降**：exp 减少时 `custom.rank` 不动。这是 2026-11-04 的语义变更——
 * 以前等级是 exp 的纯函数，"exp 掉一半"就等于"掉级"。现在两者解耦：
 *    · 「灵体重生」会**显式**写回降一级的 rank（见未来的 spirit-rebirth）；
 *    · 「燃烧修为」只减 exp，不动 rank。
 * `addExp` 本身只负责"加经验、判定升级"，不再承担"降级"职责——
 * 这件事由调用方按各自的语义处理，正是这次重构的核心目的。
 */
function addExp(u: Unit, s: GameState, amount: number): void {
  u.custom ??= {};
  const oldRank = getRank(u);   // 触发反推（老存档）或读字段
  u.custom.exp = ((u.custom.exp as number) ?? 0) + amount;

  // 只升不降：从 oldRank 往上走
  let newRank = oldRank;
  while (newRank < MAX_RANK && (u.custom.exp as number) >= expForRank(newRank)) {
    newRank++;
  }

  if (newRank > oldRank) {
    // 跨级只回一次血，delta 用两端差（和旧版 addExp 完全一致）
    const deltaMaxHp = maxHpDeltaBetween(oldRank, newRank);
    // 升级瞬间按照比例回血
    const r = u.hp / getMaxHp(s, u);
    u.maxHpBonus = (u.maxHpBonus ?? 0) + deltaMaxHp;
    u.hp += Math.floor(deltaMaxHp * r);

    // 显式写回新等级：这一步取代了旧版 `const newRank = getRank(u)`
    // 的反推结果，也是"等级不再由 exp 自动推出"的落点
    u.custom.rank = newRank;

    // 寿元增量：只加"该加的那一段"，不重设整个值。
    //
    // 为什么不用 `u.custom.lifespan = baseLifespanOf(newRank)`：
    // 未来的「燃烧寿元」要让寿元**永久**减少（暗伤、透支）。若升级时重设，
    // 减掉的那几年会在下一次升级被洗掉，"永久损失"就只是"延迟损失"。
    // 用增量则与"燃烧"天然共存：升级加 base 增量，燃烧减 N，两者叠加。
    //
    // oldBase 必为有限值：addExp 只升不降，oldRank < newRank ≤ MAX_RANK，
    // 所以 oldRank < MAX_RANK，baseLifespanOf(oldRank) 有限。
    const oldBase = baseLifespanOf(oldRank);
    const newBase = baseLifespanOf(newRank);
    if (!Number.isFinite(newBase)) {
      // rank 9：Infinity 不落库，见 baseLifespanOf
      delete u.custom.lifespan;
    } else {
      const cached = u.custom.lifespan;
      if (typeof cached === 'number' && Number.isFinite(cached)) {
        // 已落库：只加增量，燃烧掉的不会回来
        u.custom.lifespan = cached + (newBase - oldBase);
      } else {
        // 老存档（没有 custom.lifespan）：等价于 base(oldRank)，升到 newRank 即 newBase
        u.custom.lifespan = newBase;
      }
    }

    s.log.push({
      turn: s.turn,
      player: u.owner,
      text: `${s.unitTypes[u.type]?.name ?? u.type} 突破至 ${_REALMS[newRank]} 期！`,
      open: true,
    });
    checkSkillUnlocks(u, s);
    checkAbilityUnlocks(u, s); 

    // 寿元随等级上涨：显式落库，让降级时不回退（见 getLifespan 的说明）。
    // rank 9 是 Infinity，不落库（见 baseLifespanOf 的说明）。
    // 注意：外部若强行指定过 custom.lifespan（测试场景），这里会覆盖它——
    // 若需固定寿元同时又要触发升级，请直接操纵 custom 而不要走 addExp。
    const newLifespan = baseLifespanOf(newRank);
    if (Number.isFinite(newLifespan)) {
      u.custom.lifespan = newLifespan;
    } else {
      delete u.custom.lifespan;
    }
  }
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

// ── 寿元与衰老 ─────────────────────────────────────
// 规则：age > lifespan 开始减益，age - lifespan >= AGING_DEATH_AGE 才老死。
/** 寿元耗尽后还能撑几年才真正老死 */
const AGING_DEATH_AGE = 3;

/**
 * 从 rank 推出的基础寿元。rank 9（渡劫）是 Infinity——渡劫成功后寿元不再
 * 约束你，这是既定的设计。
 *
 * Infinity **不能**写进 `custom.lifespan`：JSON 序列化会把它变成 null，
 * 存档读回来就成了"没有字段"，又要走 fallback，来回折腾只是噪音。
 * 所以 rank 9 一律走"没有 custom.lifespan → 按 rank 反推 Infinity"这条路，
 * 不落库。
 */
function baseLifespanOf(rank: number): number {
  if (rank >= MAX_RANK) return Infinity;
  return 10 + rank * 9;
}

/**
 * 读寿元（纯查询，不写 state）。
 *
 * 优先级：`custom.lifespan`（显式落库值，降级时不随之回退）→ 按 rank 反推。
 *
 * 老存档没有 `custom.lifespan` 时按 rank 反推，读到的数和写回后一致，
 * 所以"看一眼面板"不会改变可观察的数值。
 */
function getLifespan(u: Unit): number {
  const cached = u.custom?.lifespan;
  if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
  return baseLifespanOf(getRank(u));
}

/**
 * 确保寿元已经落库，返回当前值。
 *
 * 和 `getLifespan` 的差别只在于**写回**：老存档第一次被回合开始触碰时，
 * 把反推值写进 `custom.lifespan`，之后降级就不会回退了。
 * UI 面板走 `getLifespan`，读到的数字和写回后完全一致——"看一眼面板"
 * 不改状态。
 *
 * rank 9 不落库（Infinity 无法 JSON 序列化），走 rank 反推兜底，
 * 行为与 getLifespan 在该分支下等价。
 *
 * 顺带：`getRank` 在这里被调用时，若 `custom.rank` 也是 undefined 会一并落库，
 * 所以老存档第一次回合开始会把 rank 和 lifespan 一起初始化。
 */
function ensureLifespan(u: Unit): number {
  const cached = u.custom?.lifespan;
  if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
  const rank = getRank(u);
  const value = baseLifespanOf(rank);
  if (Number.isFinite(value)) {
    u.custom = { ...(u.custom ?? {}), lifespan: value };
  }
  return value;
}

/**
 * 超出寿元多少岁。
 * 必须有 Math.max(0, ...)，否则负的"超龄"会变成攻击力加成，导致伤害爆炸。
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
  const realmsModifier = (5 * rank + 2 ** (rank - 0.5)) / ((rank + 1) ** 0.2);
  const aging = getAgingYears(u) * 2;
  let scaled = realmsModifier;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) scaled *= 0.1;
  return Math.ceil(scaled) - aging;
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
  const realm = -1 + rank * rank + 1.5 ** rank;
  const aging = getAgingYears(u);
  let scaled = realm;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) scaled *= 10;
  return Math.ceil(scaled) - aging;
}
/** 移动修正 */
function moveModifier(u: Unit): number {
  const realm = getRank(u) / 3;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) return Math.ceil(realm * 1.2);
  return Math.floor(realm);
}
/** 溅射范围修正 */
function SplashModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = rank/4;
  return Math.floor(realmsModifier);
}
/** 射程修正 */
function RangeModifier(u: Unit): number {
  const realm = getRank(u) / 2;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) return Math.ceil(realm * 0.5);
  return Math.floor(realm);
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
        `当前境界：第 ${rank} / ${MAX_RANK} 层   ${_REALMS[rank]}期`,
        nextExp !== null
          ? `修为经验：${exp} / ${nextExp}`
          : `修为经验：${exp}（已臻化境）`,
        `寿元：${age} / ${Number.isFinite(lifespan) ? lifespan : '∞'}`,
      ];

      if (unit.type === 'sword-cultivator') {
        lines.push(`剑修：境界加成在普攻时 ×0.8，剑气纵横时 ×1.2`);
      }

      const hasSwordSweep = skillsOf(state, unit).some((sk) => sk.id === 'sword-sweep');
      if (hasSwordSweep) {
        const reach = getSwordSweepReach(state, unit);
        lines.push(`剑气纵横：向指定方向挥出 ${reach} 格直线剑气，伤害受境界加成`);
      }

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
  abilities: [QI_TRUE_DAMAGE, SPIRIT_ASCENSION],
  units: [CULTIVATOR, SWORD_CULTIVATOR, SPIRIT_CULTIVATOR],
};


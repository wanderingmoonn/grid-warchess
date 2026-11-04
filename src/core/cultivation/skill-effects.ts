import type { GameState, Unit, City, SkillDef } from '../types.ts';
import type {
  AbilityApi,
} from '../ability-hooks.ts';
import { registerSkillEffect, registerSkillReadyCheck, registerSkillPreview } from '../skill-hooks.ts';
import { isCultivatorUnit } from './identity.ts';
import { getExp, getRank, expForRank, getMaxHp, sumDeltaMaxHpUpTo, addExp, cleanupAfterRankDrop, REALMS } from './progression.ts';
import { getSwordSweepReach } from './skills.ts';
import { resOf, addRes } from '../resources.ts';
import { SPIRIT_STONE } from './resources.ts';

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

registerSkillReadyCheck('spirit-tower-shot', (s, u) => {
  const p = s.players[u.owner];
  if (resOf(p, SPIRIT_STONE) < 5) {
    return '灵石不足（需要 5 灵石）';
  }
  return true;
});

registerSkillEffect('spirit-tower-shot', (c) => {
  const cost = 5;
  const p = c.state.players[c.self.owner];
  if (resOf(p, SPIRIT_STONE) < cost) {
    c.result.ok = false;
    c.result.reason = `需要 ${cost} 灵石才能释放灵气`;
    return;
  }
  
  addRes(p, SPIRIT_STONE, -cost);
  // 用 custom 存一个本回合的标记，过了这回合 state.turn 变了，条件自然失效
  c.self.custom = { ...(c.self.custom ?? {}), burstBuffTurn: c.state.turn };
  
  const name = c.api.utype(c.state, c.self.type).name;
  c.result.log = `${name} 消耗 ${cost} 灵石，灵气激荡，本回合获得 +3 次攻击次数`;
});
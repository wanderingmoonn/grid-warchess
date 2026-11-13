/**
 * 剑气纵横：向指定方向挥出一道穿透剑气。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（原因见 sky-step.ts 顶部）。
 */
import type { GameState, Unit, City, SkillDef } from '../../types.ts';
import { registerSkillEffect, registerSkillReadyCheck, registerSkillPreview } from '../../skill-hooks.ts';
import { getExp, getRank, addExp } from '../progression.ts';
import { boardIdOf } from '../../board.ts';

// ── 数值 ──────────────────────────────────────────
/** 基础射程（格） */
export const SWEEP_BASE_REACH = 3;
/** 境界每提高这么多级，射程再 +1 格（向上取整） */
export const SWEEP_REACH_STEP = 3;
/** 挥出一剑本身给多少修为（落空也给） */
export const SWEEP_EXP_CAST = 1;
/** 每命中一个目标（人或城）额外给多少修为 */
export const SWEEP_EXP_PER_HIT = 5;

/**
 * 某个境界的剑气射程。
 *
 * 只吃境界，所以规则书那张表直接调它——不必伪造一个 Unit 出来。
 * 向上的取整意味着 1 级就已经是 4 格，9 级 6 格。
 */
export function sweepReachForRank(rank: number): number {
  return SWEEP_BASE_REACH + Math.ceil(rank / SWEEP_REACH_STEP);
}

// ── 数据 ──────────────────────────────────────────
export const SWORD_SWEEP_SKILL: SkillDef = {
  id: 'sword-sweep',
  name: '剑气纵横',
  summary: '向指定方向挥出剑气，穿透路径上的敌人，释放与命中均可增加修为。',
  effect: 'sword-sweep',
  cooldown: 0,
  multiCast: true,
  targeting: 'direction', // 声明它需要选方向
  notReadyReason: '攻击次数不足',
};

// ── 实现 ──────────────────────────────────────────
registerSkillReadyCheck('sword-sweep', (s, u) => {
  const left = u.attacksLeft ?? (s.unitTypes[u.type].burst ?? 1);
  return left > 0;
});

/** 算出剑气打向 (targetX, targetY) 时，覆盖的所有格子坐标 */
function getSwordSweepCells(
  s: GameState,
  self: Unit,
  targetX: number,
  targetY: number,
): Array<{ x: number; y: number }> {
  const reach = sweepReachForRank(getRank(self));

  const distX = targetX - self.x;
  const distY = targetY - self.y;
  let dx = Math.sign(distX);
  let dy = Math.sign(distY);

  // 四方向吸附：斜着点也归到最近的正方向
  if (Math.abs(distX) > Math.abs(distY)) dy = 0;
  else if (Math.abs(distY) > Math.abs(distX)) dx = 0;
  if (dx === 0 && dy === 0) dx = 1;

  const cells: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= reach; i++) {
    const tx = self.x + dx * i;
    const ty = self.y + dy * i;
    if (tx >= 0 && ty >= 0 && tx < s.w && ty < s.h) {
      cells.push({ x: tx, y: ty });
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
  // 照抄普攻的收尾：出手即定身（设计如此，不是遗漏）
  c.self.moved = true;

  // 2. 算路径
  const tx = c.target?.x ?? c.self.x + 1;
  const ty = c.target?.y ?? c.self.y;
  // 路径按施法者那张图算：月球上的剑气不该扫到地球同坐标的人
  const hitCells = getSwordSweepCells(c.view, c.self, tx, ty);

  // 战况烈度：剑气扫过的每一格都记，含空格——这才是"范围"的完整口径。
  // noteHeatCell 默认记到"当前行动方的对手"账上，正好是"对方阵地上的弹坑"。
  for (const cell of hitCells) {
    c.api.noteHeat(c.state, cell.x, cell.y, boardIdOf(c.self));
  }

  // 3. 找受害者
  const victims = c.view.units.filter(u =>
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
  let expGain = SWEEP_EXP_CAST;
  let logExtra = '';
  let deadCount = 0;

  if (victims.length > 0 || cityVictims.length > 0) {
    expGain += (victims.length + cityVictims.length) * SWEEP_EXP_PER_HIT;
    let totalDmg = 0;

    // 剑修技能模式：境界加成从普攻 ×0.8 切到 ×1.2
    c.self.custom ??= {};
    c.self.custom.swordSweepActive = true;
    try {
      for (const v of victims) {
        const dmg = c.api.computeDamage(c.state, c.self, v);
        // 走唯一出口：剑气也是直接伤害，守御阵该能替友军接下这一道。
        // 城池不在此列——它是 City，不是 Unit，转移钩子只认单位。
        c.api.hurt(c.state, v, dmg, { source: c.self });
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
        ct.hp -= dmg; // hp-exempt: 城市不是 Unit，hurtUnit 收不了它
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
  const cells = getSwordSweepCells(c.view, c.self, c.target.x, c.target.y);
  return cells.map(cell => cell.y * c.view.w + cell.x);
});

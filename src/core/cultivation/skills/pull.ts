/**
 * 族 4 · 拉拽（`effect: 'pull'`）：把敌人朝自己（或落点）拖过来。
 *
 * ── 这一族唯一的真难点 ────────────────────────────────────────────
 *
 * 不是伤害，是**落点**：拖过来的路上如果撞到别人、或者格子根本站不住
 * （水、山、城墙），该停在哪？这里的口径是**一格一格拖、撞住就停在上一格**，
 * 而不是"算完目标格再回退"。理由：后者会让单位穿墙落到一个本来进不去的位置，
 * 而玩家只看到结果，会以为是被传送了。
 *
 * 另外两条刻意的选择：
 *   · **不会把人拖进施法者所在的格子**（停在相邻一格）——不然两个单位会重叠；
 *   · 每拖一步都要重新判一次占位，因为被拖的人自己也是障碍物。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import type { Unit } from '../../types.ts';
import { coversTile } from '../../query.ts';
import { getRank } from '../progression.ts';
import { rootFor } from '../spell-statuses.ts';
import {
  defineSpellSkill,
  registerManaReady,
  registerPreview,
  resolveCast,
  spellCustom,
  strike,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 参数 ──────────────────────────────────────────
export interface PullParams extends Record<string, unknown> {
  /** 最多拖几格 */
  steps: number;
  /** 基础伤害（不写 = 纯控制） */
  dmg?: number;
  /** 每层境界加多少伤害 */
  perRank?: number;
  /** 拖到位后定身几回合 */
  root?: number;
  /** 按护甲结算 */
  physical?: boolean;
}

// ── 数据行 ────────────────────────────────────────
export const QIAN_YIN_SHU_COST = 55;
export const QIAN_YIN_SHU_MIN_RANK = 2;
export const QIAN_YIN_SHU_STEPS = 3;
const QIAN_YIN_SHU: SpellRow = {
  id: 'qian-yin-shu',
  name: '牵引术',
  summary: `射程 5 格，把一名敌人朝自己拖 ${QIAN_YIN_SHU_STEPS} 格（撞到人或站不住就停）；耗 ${QIAN_YIN_SHU_COST} 灵力。`,
  effect: 'pull',
  cost: QIAN_YIN_SHU_COST,
  range: 5,
  preview: 'ring',
  custom: { steps: QIAN_YIN_SHU_STEPS } satisfies PullParams,
};

export const FU_ZHI_DAO_COST = 70;
export const FU_ZHI_DAO_MIN_RANK = 3;
export const FU_ZHI_DAO_STEPS = 2;
export const FU_ZHI_DAO_RADIUS = 2;
const FU_ZHI_DAO: SpellRow = {
  id: 'fu-zhi-dao',
  name: '缚之道',
  summary:
    `射程 5 格、半径 ${FU_ZHI_DAO_RADIUS} 格：把范围内所有敌人朝落点拖 ${FU_ZHI_DAO_STEPS} 格，并定身 1 回合；` +
    `耗 ${FU_ZHI_DAO_COST} 灵力。`,
  effect: 'pull',
  cost: FU_ZHI_DAO_COST,
  range: 5,
  preview: 'blast',
  radius: FU_ZHI_DAO_RADIUS,
  custom: { steps: FU_ZHI_DAO_STEPS, root: 1 } satisfies PullParams,
};

export const JU_HUN_SUO_MING_COST = 80;
export const JU_HUN_SUO_MING_MIN_RANK = 4;
export const JU_HUN_SUO_MING_STEPS = 2;
const JU_HUN_SUO_MING: SpellRow = {
  id: 'ju-hun-suo-ming',
  name: '拘魂索命',
  summary:
    `射程 6 格，把一名敌人拖近 ${JU_HUN_SUO_MING_STEPS} 格并造成 15 + 境界×5 点伤害；` +
    `耗 ${JU_HUN_SUO_MING_COST} 灵力。`,
  effect: 'pull',
  cost: JU_HUN_SUO_MING_COST,
  range: 6,
  preview: 'ring',
  custom: { steps: JU_HUN_SUO_MING_STEPS, dmg: 15, perRank: 5 } satisfies PullParams,
};

export const PULL_ROWS: readonly SpellRow[] = [QIAN_YIN_SHU, FU_ZHI_DAO, JU_HUN_SUO_MING];
export const QIAN_YIN_SHU_SKILL = defineSpellSkill(QIAN_YIN_SHU);
export const FU_ZHI_DAO_SKILL = defineSpellSkill(FU_ZHI_DAO);
export const JU_HUN_SUO_MING_SKILL = defineSpellSkill(JU_HUN_SUO_MING);

registerManaReady(PULL_ROWS);
registerPreview(PULL_ROWS);

// ── 拉拽 ──────────────────────────────────────────
/**
 * 把 `victim` 朝 `toward` 拖最多 `steps` 格。返回实际拖了几格。
 *
 * 每一步都重新算方向（不是"一次性算斜线"），这样被拖的人和障碍物怎么摆都会
 * 走出最短的直线逼近；撞住就停，不会绕路——绕路会让"拉"变成"自动寻路"。
 */
function pullVictim(c: SkillCtx, victim: Unit, toward: { x: number; y: number }, steps: number): number {
  let moved = 0;
  for (let i = 0; i < steps; i++) {
    const dx = Math.sign(toward.x - victim.x);
    const dy = Math.sign(toward.y - victim.y);
    if (dx === 0 && dy === 0) break;
    const nx = victim.x + dx;
    const ny = victim.y + dy;
    // 不拖进施法者/落点所在的那一格：两个单位不能叠在一起
    if (nx === toward.x && ny === toward.y) break;
    if (!c.api.canStandAt(c.view, nx, ny, victim.type, { ignoreUnits: true })) break;
    const occupied = c.view.units.some(
      (o) => o !== victim && o.hp > 0 && coversTile(c.view, o, nx, ny),
    );
    if (occupied) break;
    victim.x = nx;
    victim.y = ny;
    moved += 1;
  }
  return moved;
}

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('pull', (c: SkillCtx) => {
  const p = spellCustom<PullParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const radius = Number(p.spellRadius ?? 0);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  const area = radius > 0;
  const cast = resolveCast(c, {
    cost,
    range,
    mode: area ? 'area' : 'single',
    radius,
    rangeFrom: area ? 'point' : 'victim',
    noTargetReason: () => (area ? '选一个落点' : '选一个目标'),
    noUnitReason: () => '那一格没有单位',
    emptyReason: () => '那里没有敌人',
    allyReason: (ctx, victim) => `不能拉自己的${ctx.api.utype(ctx.state, victim.type).name}`,
    tooFarReason: () => `太远了（${skillName}射程 ${range} 格）`,
  });
  if (!cast.ok) {
    c.result.ok = false;
    c.result.reason = cast.reason;
    return;
  }

  const dmg = p.dmg ? p.dmg + (p.perRank ?? 0) * getRank(self) : 0;
  /*
   * 拖向哪儿：单体法术**拖向施法者自己**，群体法术拖向落点。
   *
   * 单体的 `cast.point` 就是目标脚下那格——拿它当"朝向"等于原地不动
   * （第一次写就栽在这里，测试直接报"拖了 0 格"）。
   */
  const toward = area ? cast.point : { x: self.x, y: self.y };
  let dragged = 0;
  let total = 0;
  let killed = 0;
  const notes: string[] = [];

  for (const v of cast.victims) {
    const steps = pullVictim(c, v, toward, p.steps);
    dragged += steps;
    if (p.root) rootFor(v, p.root);
    if (dmg > 0) {
      const r = strike(
        c,
        v,
        dmg,
        {
          hurt: (x) => `${c.api.utype(s, x.type).name}被${skillName}拖近 ${steps} 格，受到 ${dmg} 点伤害`,
          kill: (x) => `${c.api.utype(s, x.type).name}被${skillName}拖散`,
        },
        { physical: p.physical },
      );
      total += r.dealt;
      if (r.killed) killed += 1;
    }
  }
  if (dragged === 0) notes.push('但一格都没拖动（被挡住或本来就贴着）');

  const bits: string[] = [`拖动 ${cast.victims.length} 人共 ${dragged} 格`];
  if (p.root) bits.push('定身');
  if (total > 0) bits.push(`造成 ${total} 点伤害`);
  if (killed > 0) bits.push(`${killed} 人殒命`);
  if (notes.length > 0) bits.push(...notes);
  c.result.log = `${name}施放${skillName}：${bits.join('，')}（耗 ${cost} 灵力）`;
});

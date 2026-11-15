/**
 * 簇 E · 绝学（`effect: 'legacy'`）——三条各自"不按常规套路"的法术。
 *
 *   不周山断   击退 + **沉默**（封嘴不封手）
 *   以气御剑   从**自己那把飞剑的位置**发出，不是从人身上
 *   虚无生道   灵力见底时自动回满（一口气吊着不散）
 *
 * 三条都没有共用一套参数，所以这里按 `mode` 分支，而不是硬塞进同一张表。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import type { Unit } from '../../types.ts';
import { coversTile } from '../../query.ts';
import { getRank } from '../progression.ts';
import { SILENCE_STATUS, VOID_STATUS } from '../legacy-status.ts';
import { UNIT_IDS } from '../identity.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  strike,
  type SpellRow,
} from '../spell-kernel.ts';


export interface LegacyParams extends Record<string, unknown> {
  mode: 'mountain' | 'sword' | 'void';
  base?: number;
  perRank?: number;
  knockback?: number;
  silence?: number;
  rounds?: number;
}

// ── 数据行 ────────────────────────────────────────
export const BU_ZHOU_SHAN_DUAN_COST = 95;
export const BU_ZHOU_SHAN_DUAN_MIN_RANK = 5;
export const BU_ZHOU_SHAN_DUAN_BASE = 18;
export const BU_ZHOU_SHAN_DUAN_PER_RANK = 8;
const BU_ZHOU_SHAN_DUAN: SpellRow = {
  id: 'bu-zhou-shan-duan',
  name: '不周山断',
  summary:
    `射程 4 格：对一名敌人造成 ${BU_ZHOU_SHAN_DUAN_BASE} + 境界×${BU_ZHOU_SHAN_DUAN_PER_RANK} 点真伤，` +
    `并把他击退 2 格、**沉默 2 回合**（能走能打，念不出法术）；耗 ${BU_ZHOU_SHAN_DUAN_COST} 灵力。`,
  effect: 'legacy',
  cost: BU_ZHOU_SHAN_DUAN_COST,
  range: 4,
  preview: 'ring',
  custom: {
    mode: 'mountain',
    base: BU_ZHOU_SHAN_DUAN_BASE,
    perRank: BU_ZHOU_SHAN_DUAN_PER_RANK,
    knockback: 2,
    silence: 2,
  } satisfies LegacyParams,
};

export const YI_QI_YU_JIAN_COST = 85;
export const YI_QI_YU_JIAN_MIN_RANK = 4;
export const YI_QI_YU_JIAN_BASE = 16;
export const YI_QI_YU_JIAN_PER_RANK = 7;
/** 剑离得太远就御不动了：射程按"剑到目标的距离"算，超出这个数就打不到 */
export const YI_QI_YU_JIAN_RANGE = 5;
const YI_QI_YU_JIAN: SpellRow = {
  id: 'yi-qi-yu-jian',
  name: '以气御剑',
  summary:
    `**从你那把青木剑的位置**发一剑：射程按"剑到目标的距离"算（${YI_QI_YU_JIAN_RANGE} 格），` +
    `造成 ${YI_QI_YU_JIAN_BASE} + 境界×${YI_QI_YU_JIAN_PER_RANK} 点真伤；` +
    `青木剑不在场就放不出来；耗 ${YI_QI_YU_JIAN_COST} 灵力。`,
  effect: 'legacy',
  cost: YI_QI_YU_JIAN_COST,
  range: YI_QI_YU_JIAN_RANGE,
  preview: 'ring',
  custom: {
    mode: 'sword',
    base: YI_QI_YU_JIAN_BASE,
    perRank: YI_QI_YU_JIAN_PER_RANK,
  } satisfies LegacyParams,
};

export const XU_WU_SHENG_DAO_COST = 70;
export const XU_WU_SHENG_DAO_MIN_RANK = 5;
export const XU_WU_SHENG_DAO_ROUNDS = 3;
const XU_WU_SHENG_DAO: SpellRow = {
  id: 'xu-wu-sheng-dao',
  name: '虚无生道',
  summary: `接下来 ${XU_WU_SHENG_DAO_ROUNDS} 回合，灵力见底的那一刻会自动回满（每回合一次）；耗 ${XU_WU_SHENG_DAO_COST} 灵力。`,
  effect: 'legacy',
  cost: XU_WU_SHENG_DAO_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'void', rounds: XU_WU_SHENG_DAO_ROUNDS } satisfies LegacyParams,
};

export const LEGACY_ROWS: readonly SpellRow[] = [BU_ZHOU_SHAN_DUAN, YI_QI_YU_JIAN, XU_WU_SHENG_DAO];
export const BU_ZHOU_SHAN_DUAN_SKILL = defineSpellSkill(BU_ZHOU_SHAN_DUAN);
export const YI_QI_YU_JIAN_SKILL = defineSpellSkill(YI_QI_YU_JIAN);
export const XU_WU_SHENG_DAO_SKILL = defineSpellSkill(XU_WU_SHENG_DAO);

registerManaReady(LEGACY_ROWS);
registerPreview(LEGACY_ROWS);

/** 把目标朝"背离施法者"的方向推 `steps` 格；撞墙撞人就停 */
function pushAway(c: Parameters<typeof strike>[0], victim: Unit, steps: number): number {
  let moved = 0;
  for (let i = 0; i < steps; i++) {
    const dx = Math.sign(victim.x - c.self.x);
    const dy = Math.sign(victim.y - c.self.y);
    if (dx === 0 && dy === 0) break;
    const nx = victim.x + dx;
    const ny = victim.y + dy;
    if (!c.api.canStandAt(c.view, nx, ny, victim.type, { ignoreUnits: true })) break;
    const taken = c.view.units.some((o) => o.id !== victim.id && o.hp > 0 && coversTile(c.view, o, nx, ny));
    if (taken) break;
    victim.x = nx;
    victim.y = ny;
    moved += 1;
  }
  return moved;
}

registerSkillEffect('legacy', (c) => {
  const p = spellCustom<LegacyParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  // ① 虚无生道：挂状态，真正的回灵力在 `paySpellCost` 里
  if (p.mode === 'void') {
    if (!paySpellCost(c, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }
    self.status = { ...(self.status ?? {}), [VOID_STATUS]: Number(p.rounds ?? 3) };
    c.result.log = `${name}施放${skillName}：灵力见底时会自己续上，持续 ${p.rounds} 回合`;
    return;
  }

  // ② 以气御剑：射程从剑算起
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '选一个目标';
    return;
  }
  const victim = c.view.units.find((u) => u.hp > 0 && coversTile(c.view, u, t.x, t.y));
  if (!victim) {
    c.result.ok = false;
    c.result.reason = '那一格没有单位';
    return;
  }
  if (victim.owner === self.owner) {
    c.result.ok = false;
    c.result.reason = '不能打自己人';
    return;
  }

  const sword = p.mode === 'sword'
    ? s.units.find((u) => u.type === UNIT_IDS.ARTIFACT_WOOD && u.owner === self.owner && u.hp > 0)
    : undefined;
  if (p.mode === 'sword' && !sword) {
    c.result.ok = false;
    c.result.reason = '青木剑不在场，御不动';
    return;
  }

  const originX = sword ? sword.x : self.x;
  const originY = sword ? sword.y : self.y;
  const dist = Math.abs(originX - victim.x) + Math.abs(originY - victim.y);
  if (dist > Number(p.spellRange)) {
    c.result.ok = false;
    c.result.reason = `剑够不着（${dist} 格，${skillName}只有 ${p.spellRange} 格）`;
    return;
  }

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  const dmg = Number(p.base ?? 0) + Number(p.perRank ?? 0) * getRank(self);
  const r = strike(c, victim, dmg, {
    hurt: (x) => `${c.api.utype(s, x.type).name}被${skillName}击中，受到 ${dmg} 点伤害`,
    kill: (x) => `${c.api.utype(s, x.type).name}被${skillName}斩落`,
  });

  // ③ 不周山断的附赠：击退 + 沉默
  let pushed = 0;
  if (p.mode === 'mountain') {
    if (!r.killed && Number(p.knockback ?? 0) > 0) pushed = pushAway(c, victim, Number(p.knockback));
    if (!r.killed && Number(p.silence ?? 0) > 0) {
      victim.status = { ...(victim.status ?? {}), [SILENCE_STATUS]: Number(p.silence) };
    }
  }

  const bits = [`造成 ${r.dealt} 点伤害`];
  if (pushed > 0) bits.push(`击退 ${pushed} 格`);
  if (p.mode === 'mountain' && !r.killed) bits.push(`沉默 ${p.silence} 回合`);
  if (sword) bits.push('自飞剑发出');
  c.result.log = `${name}施放${skillName}：${c.api.utype(s, victim.type).name} ${bits.join('，')}（耗 ${cost} 灵力）`;
});


/**
 * 复活（G6）+ 族 11（死亡触发，`effect: 'revive'`）。
 *
 * ── 两种"复活"，别混成一件事 ────────────────────────────────────
 *
 *   · **免死**（主角光环、替死转生）：死的是**同一个人**，只是没死成。
 *     走的是"把那个 Unit 原样放回场上"，所以**境界、经验、寿元、学过的技能
 *     全都保留**——因为对象根本没换。这是 G6 要守的那条线。
 *   · **招魂式群体复活**（忘川逆流）：从 `s.fallen` 的记录里把**形体**唤回来，
 *     用 `api.spawnNear` 造一个新单位。修为带不回来——这和核心里已有的
 *     「招魂」（`raise-dead`）是同一个口径：救回来的是兵，不是老兵。
 *
 * 把这两件事写成两种口径，是因为它们本来就不一样：前者是"这条命没断"，
 * 后者是"再叫一个来"。混着做容易出现"复活之后变成满级"的漏洞。
 *
 * ── 免死为什么能在 `onUnitKilled` 里做 ────────────────────────────
 *
 * `killUnit` 的顺序是：**先从 `s.units` 里摘掉**，再通知钩子。所以钩子里
 * 把同一个对象 push 回去就是"复活"，而且 `killUnit` 开头的幂等判断
 * （`some(id)`）会认这个 id——同一具不会再被重复结算。
 *
 * 代价是：钩子里复活的人**这一回合不能再动**（`moved/acted` 置真），
 * 否则等于凭空送一个回合。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { Unit } from '../../types.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 免死标记 ──────────────────────────────────────
export interface ReviveMark {
  /** 复活后保留多少比例的生命上限 */
  ratio: number;
  /** true = 在凶手的位置站起来（替死转生）；false = 原地 */
  atKiller: boolean;
  /** 已经用掉了。写在同一个对象上，所以"整局只能免一次"是天然的 */
  used?: boolean;
}

/** 读一个单位身上的免死标记（`hooks.onUnitKilled` 用） */
export function reviveMarkOf(u: Unit): ReviveMark | undefined {
  return u.custom?.['revive'] as ReviveMark | undefined;
}

/** 挂上免死标记 */
export function putReviveMark(u: Unit, mark: ReviveMark): void {
  u.custom = { ...(u.custom ?? {}), revive: { ...mark } };
}

// ── 参数与数据行 ──────────────────────────────────
export interface ReviveParams extends Record<string, unknown> {
  /** `self` = 给自己挂免死；`mass` = 立刻招魂式群活 */
  mode: 'self' | 'mass';
  /** 复活后的血量比例 */
  ratio?: number;
  /** 免死时是否在凶手位置站起来 */
  atKiller?: boolean;
  /** 群体复活最多拉几个 */
  maxCount?: number;
}

export const ZHU_JIAO_GUANG_HUAN_COST = 100;
export const ZHU_JIAO_GUANG_HUAN_MIN_RANK = 5;
export const ZHU_JIAO_GUANG_HUAN_RATIO = 0.5;
const ZHU_JIAO_GUANG_HUAN: SpellRow = {
  id: 'zhu-jiao-guang-huan',
  name: '主角光环',
  summary:
    `给自己挂一道护命符：下一次阵亡时**原位**复活并保留 ${Math.round(ZHU_JIAO_GUANG_HUAN_RATIO * 100)}% 生命；` +
    `境界、经验、寿元一概不掉（整局只生效一次）；耗 ${ZHU_JIAO_GUANG_HUAN_COST} 灵力。`,
  effect: 'revive',
  cost: ZHU_JIAO_GUANG_HUAN_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'self', ratio: ZHU_JIAO_GUANG_HUAN_RATIO, atKiller: false } satisfies ReviveParams,
};

export const TI_SI_ZHUAN_SHENG_COST = 85;
export const TI_SI_ZHUAN_SHENG_MIN_RANK = 4;
export const TI_SI_ZHUAN_SHENG_RATIO = 0.3;
const TI_SI_ZHUAN_SHENG: SpellRow = {
  id: 'ti-si-zhuan-sheng',
  name: '替死转生',
  summary:
    `给自己挂一道替死符：下一次阵亡时在**凶手所在的位置**重新站起，保留 ${Math.round(TI_SI_ZHUAN_SHENG_RATIO * 100)}% 生命；` +
    `境界、经验、寿元一概不掉（整局只生效一次）；耗 ${TI_SI_ZHUAN_SHENG_COST} 灵力。`,
  effect: 'revive',
  cost: TI_SI_ZHUAN_SHENG_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'self', ratio: TI_SI_ZHUAN_SHENG_RATIO, atKiller: true } satisfies ReviveParams,
};

export const WANG_CHUAN_NI_LIU_COST = 110;
export const WANG_CHUAN_NI_LIU_MIN_RANK = 6;
export const WANG_CHUAN_NI_LIU_MAX = 2;
const WANG_CHUAN_NI_LIU: SpellRow = {
  id: 'wang-chuan-ni-liu',
  name: '忘川逆流',
  summary:
    `把本阵营最近阵亡的最多 ${WANG_CHUAN_NI_LIU_MAX} 个单位以半血唤回身边（**修为不随形体回来**）；` +
    `耗 ${WANG_CHUAN_NI_LIU_COST} 灵力。`,
  effect: 'revive',
  cost: WANG_CHUAN_NI_LIU_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: { mode: 'mass', ratio: 0.5, maxCount: WANG_CHUAN_NI_LIU_MAX } satisfies ReviveParams,
};

export const REVIVE_ROWS: readonly SpellRow[] = [ZHU_JIAO_GUANG_HUAN, TI_SI_ZHUAN_SHENG, WANG_CHUAN_NI_LIU];
export const ZHU_JIAO_GUANG_HUAN_SKILL = defineSpellSkill(ZHU_JIAO_GUANG_HUAN);
export const TI_SI_ZHUAN_SHENG_SKILL = defineSpellSkill(TI_SI_ZHUAN_SHENG);
export const WANG_CHUAN_NI_LIU_SKILL = defineSpellSkill(WANG_CHUAN_NI_LIU);

registerManaReady(REVIVE_ROWS);
registerPreview(REVIVE_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('revive', (c) => {
  const p = spellCustom<ReviveParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  // 群活先看"有没有可唤的人"，没有就别扣灵力
  if (p.mode === 'mass') {
    const pool = (s.fallen ?? []).filter(
      (r) => r.owner === self.owner && !r.revived && !!s.unitTypes[r.type],
    );
    if (pool.length === 0) {
      c.result.ok = false;
      c.result.reason = '忘川里没有可以唤回的同伴';
      return;
    }
    if (!paySpellCost(c, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }

    /*
     * 从最近的开始（`turn` 大的优先）。**一条记录只能唤一次**：`revived`
     * 标记和核心的招魂共用，避免同一具形体被两个技能反复拉起——那就不是
     * 复活，而是"无限兵源"。
     */
    const picked = [...pool].sort((a, b) => b.turn - a.turn).slice(0, p.maxCount ?? 1);
    const spots: string[] = [];
    for (const rec of picked) {
      const spot = c.api.spawnNear(s, self.owner, rec.type, self);
      if (!spot) break;
      const ratio = p.ratio ?? 0.5;
      spot.hp = Math.max(1, Math.round(c.api.maxHpOf(s, spot) * ratio));
      rec.revived = true;
      spots.push(c.api.utype(s, rec.type).name);
    }
    if (spots.length === 0) {
      c.result.ok = false;
      c.result.reason = '身边没有能站起来的位置';
      return;
    }
    c.result.log = `${name}施放${skillName}：${spots.join('、')} 从忘川归来（耗 ${cost} 灵力）`;
    return;
  }

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }
  putReviveMark(self, { ratio: p.ratio ?? 0.5, atKiller: p.atKiller === true });
  c.result.log =
    `${name}施放${skillName}：下一次阵亡时会${p.atKiller ? '在凶手处' : '原地'}复活` +
    `（保留 ${Math.round((p.ratio ?? 0.5) * 100)}% 生命，耗 ${cost} 灵力）`;
});

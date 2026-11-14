/**
 * 族 5 · 五行免耗（`effect: 'wuxing'`）：把"连着放按五行走"变成不花灵力。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────
 *
 * 七条法术只差两个参数：**免几次**、**按什么关系算**。
 * 施放之后，接下来 N 次"五行与上一次相合"的法术**不扣灵力**。
 * 这就是"背五行"的收益：会排顺序的人，一回合能多打两三发。
 *
 * ── 为什么它必须挂在骨架的"付灵力"那一层 ──────────────────────────
 *
 * 免耗要发生在**扣灵力之前**，而扣灵力是骨架做的（`resolveCast` / 各族 handler）。
 * 法术自己没法插手那一步，所以内核留了 `registerCostWaiver`：
 * 这一族注册一个判定，命中就免掉，顺手把"剩几次"减一。
 *
 * ── 关系怎么算 ────────────────────────────────────────────────────
 *
 * 以**这个单位上一次施放的五行法术**为起点：
 *   相生 · 木→火→土→金→水→木
 *   相克 · 木克土、土克水、水克火、火克金、金克木
 *
 * 还没有起点时（这一局第一发五行法术）**直接算合**——否则"小五行相生"要先花
 * 一发才有用，玩家会觉得这门法术在骗人，而它本来就是起手牌。
 *
 * ── 与"法术自带的 element"的关系 ─────────────────────────────────
 *
 * 元素写在技能的 `custom.element` 上（族 2 的焱垚鑫淼森已经标好了）。
 * 注意它不是核心的 `Element`（那是伤害属性，没有金木），是五行自己的一套值。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import type { Unit } from '../../types.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerCostWaiver,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 五行 ──────────────────────────────────────────
export type WuXing = 'metal' | 'wood' | 'water' | 'fire' | 'earth';

/** 相生：木生火、火生土、土生金、金生水、水生木 */
const SHENG_NEXT: Record<WuXing, WuXing> = {
  wood: 'fire',
  fire: 'earth',
  earth: 'metal',
  metal: 'water',
  water: 'wood',
};

/** 相克：木克土、土克水、水克火、火克金、金克木 */
const KE_NEXT: Record<WuXing, WuXing> = {
  wood: 'earth',
  earth: 'water',
  water: 'fire',
  fire: 'metal',
  metal: 'wood',
};

/** 关系类型。`any` = 不判关系，只看次数（五行真解） */
export type WuXingRelation = 'sheng' | 'ke' | 'shengOrKe' | 'diff' | 'any';

/** 两次施放之间是否满足关系：`prev` 是上一次的五行，`next` 是这一发的 */
export function relationHolds(relation: WuXingRelation, prev: WuXing, next: WuXing): boolean {
  switch (relation) {
    case 'sheng':
      return SHENG_NEXT[prev] === next;
    case 'ke':
      return KE_NEXT[prev] === next;
    case 'shengOrKe':
      return SHENG_NEXT[prev] === next || KE_NEXT[prev] === next;
    case 'diff':
      return prev !== next;
    case 'any':
      return true;
  }
}

/** 技能自带的五行（读 `custom.element`） */
export function elementOfSkill(skill: unknown): WuXing | undefined {
  const el = (skill as { custom?: { element?: unknown } } | undefined)?.custom?.element;
  return typeof el === 'string' ? (el as WuXing) : undefined;
}

/** 单位身上的五行状态（都放 `custom`，不新开字段） */
interface WuXingState {
  /** 上一次施放的五行法术 */
  lastElement?: WuXing;
  /** 剩下的免耗次数 + 关系 */
  credit?: { left: number; relation: WuXingRelation };
}

function stateOf(u: Unit): WuXingState {
  return (u.custom?.['wuxing'] as WuXingState | undefined) ?? {};
}

// ── 参数与数据行 ──────────────────────────────────
export interface WuXingParams extends Record<string, unknown> {
  /** 免几次 */
  left: number;
  relation: WuXingRelation;
}

/**
 * 七条法术 = 两个参数的排列。
 *
 * 小五行（2 次）是起手牌；五行相生/相克（3 次）是主力；
 * 有缺五行（4 次、只要不同）不挑顺序，谁都能接；
 * 无缺五行（5 次、相生或相克）和五行真解（5 次、不判关系）是终局的两张。
 */
const ROWS_DEF: Array<{ id: string; name: string; left: number; relation: WuXingRelation; cost: number; minRank: number }> = [
  { id: 'xiao-wuxing-sheng', name: '小五行相生', left: 2, relation: 'sheng', cost: 30, minRank: 2 },
  { id: 'xiao-wuxing-ke', name: '小五行相克', left: 2, relation: 'ke', cost: 30, minRank: 2 },
  { id: 'wuxing-sheng', name: '五行相生', left: 3, relation: 'sheng', cost: 45, minRank: 3 },
  { id: 'wuxing-ke', name: '五行相克', left: 3, relation: 'ke', cost: 45, minRank: 3 },
  { id: 'you-que-wuxing', name: '有缺五行', left: 4, relation: 'diff', cost: 55, minRank: 4 },
  { id: 'wu-que-wuxing', name: '无缺五行', left: 5, relation: 'shengOrKe', cost: 60, minRank: 5 },
  { id: 'wuxing-zhen-jie', name: '五行真解', left: 5, relation: 'any', cost: 65, minRank: 6 },
];

const RELATION_TEXT: Record<WuXingRelation, string> = {
  sheng: '与上一次**相生**',
  ke: '与上一次**相克**',
  shengOrKe: '与上一次**相生或相克**',
  diff: '与上一次**不同**',
  any: '（不判关系）',
};

function rowOf(def: (typeof ROWS_DEF)[number]): SpellRow {
  return {
    id: def.id,
    name: def.name,
    summary: `接下来 ${def.left} 次${RELATION_TEXT[def.relation]}的五行法术不耗灵力；耗 ${def.cost} 灵力。`,
    effect: 'wuxing',
    cost: def.cost,
    range: 0,
    preview: 'ring',
    targeting: 'none',
    custom: { left: def.left, relation: def.relation } satisfies WuXingParams,
  };
}

const ROWS = ROWS_DEF.map(rowOf);

export const WUXING_ROWS: readonly SpellRow[] = ROWS;
export const WUXING_SKILLS = ROWS.map((r) => defineSpellSkill(r));

/** 直接给 `spells.ts` 用的条目（技能 + 灵力 + 门槛，三者本来就该一起定义） */
export const WUXING_SPELLS = ROWS_DEF.map((d, i) => ({
  skill: WUXING_SKILLS[i]!,
  cost: d.cost,
  minRank: d.minRank,
}));

registerManaReady(WUXING_ROWS);
registerPreview(WUXING_ROWS);

// ── 免耗判定 ──────────────────────────────────────
/**
 * 每一发法术付灵力之前问一次。
 *
 * 顺序很要紧：**先判这一发有没有五行**，没有就直接放行（返回 false，照常扣）。
 * 七条五行法术自己没有 element——它们是"信用凭证"，不该把自己也免掉。
 */
registerCostWaiver((c) => {
  const el = elementOfSkill(c.skill);
  if (!el) return false;

  const self = c.self;
  const s = stateOf(self);
  const prev = s.lastElement;
  const credit = s.credit;

  // 这一发无论免不免，都是"上一次施放的五行"
  const next: WuXingState = { ...s, lastElement: el };

  // 没有起点时算合：这门法术本来就该是起手牌
  const ok = !!credit && credit.left > 0 && (!prev || relationHolds(credit.relation, prev, el));
  if (!ok) {
    self.custom = { ...(self.custom ?? {}), wuxing: next };
    return false;
  }

  next.credit = { left: credit!.left - 1, relation: credit!.relation };
  self.custom = { ...(self.custom ?? {}), wuxing: next };
  return true;
});

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('wuxing', (c: SkillCtx) => {
  const p = spellCustom<WuXingParams>(c);
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(c.state, self.type).name;

  // 注意：**先扣费，再记账**。这一发本身不在免耗范围内（它没有五行），
  // 但它会把旧的信用置换掉——这正是"重新起手"的意思。
  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  const s = stateOf(self);
  self.custom = {
    ...(self.custom ?? {}),
    wuxing: { ...s, credit: { left: p.left, relation: p.relation } },
  };

  c.result.log = `${name}施放${skillName}：接下来 ${p.left} 次${RELATION_TEXT[p.relation]}的五行法术免耗（耗 ${cost} 灵力）`;
});

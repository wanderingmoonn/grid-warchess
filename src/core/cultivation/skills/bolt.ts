/**
 * 族 1 · 直伤（`effect: 'bolt'`）：把伤害准确地送到一个（或一条线、一串）目标身上。
 *
 * ── 这一族管的是什么 ──────────────────────────────────────────────
 *
 * 不涉及场地、召唤、转化，只管"打中谁、打多少"。成员：掌心雷（补刀）、
 * 灭神枪（直线贯穿）、元磁神光（单点 + 麻痹）、五雷正法（链式扩散）。
 *
 * 四条法术**共用这一份实现**，差别全在数据行的 `custom` 里：
 *
 *   base / perRank   伤害 = base + perRank × 境界
 *   trueMul          改用「真元 × 倍率」当伤害（灭神枪）；写了就忽略上面两个
 *   line             直线：命中自己到落点这条线上的所有敌人
 *   chain            连锁：第一次命中后再跳几次（五雷正法 5 次）
 *   chainRadius      每一跳的搜索半径
 *   stun             命中后麻痹几回合
 *   physical         true = 按护甲结算（走 hurtPhysical），不写 = 无视护甲
 *   soulBound        魂法
 *
 * 再加一门同族法术＝在这里加一行 `ROW`，别处不用改。这一族的验收标准就是这个：
 * 掌心雷从"自己一个文件"变成"族里的一行"，而它的行为一条断言都没变。
 *
 * ── 直线的口径 ──────────────────────────────────────────────────
 *
 * 和剑气纵横**完全一致**：四方向吸附（斜着点归到最近的正方向）+ 定长射线，
 * 长度由射程决定、不看点击距离。几何在 `spell-kernel.ts` 的 `rayCells` 里，
 * 两处共用一份——直线攻击只该有一种画法。
 *
 * 这个游戏里移动不走斜线，所以"斜着的直线攻击"本来就不该存在，
 * 2026-11-14 按作者的原话改掉了最初那版 45° 折线实现。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 sky-step.ts 顶部）。
 */
import type { SkillCtx } from '../../skill-hooks.ts';
import type { Unit } from '../../types.ts';
import { registerSkillEffect } from '../../skill-hooks.ts';
import { coversTile, distBetweenUnits } from '../../query.ts';
import { boardIdOf } from '../../board.ts';
import { getRank } from '../progression.ts';
import { trueDamageOf } from '../stats.ts';
import { spendMana } from '../mana.ts';
import { stunFor } from '../spell-statuses.ts';
import {
  defineSpellSkill,
  rayCells,
  registerManaReady,
  registerPreview,
  resolveCast,
  spellCustom,
  strikeAll,
  type SpellRow,
} from '../spell-kernel.ts';

// ── 族的参数 ──────────────────────────────────────
export interface BoltParams extends Record<string, unknown> {
  base: number;
  perRank: number;
  /** 改用「真元 × 倍率」；写了就忽略 base/perRank（灭神枪） */
  trueMul?: number;
  /** 直线贯穿 */
  line?: boolean;
  /** 连锁次数（第一次命中之后再跳几次） */
  chain?: number;
  /** 每一跳的搜索半径 */
  chainRadius?: number;
  /** 命中后麻痹几回合 */
  stun?: number;
  /** 按护甲结算（不写 = 无视护甲） */
  physical?: boolean;
  /** 魂法：修士化作灵体时不被清掉 */
  soulBound?: boolean;
}

/** 这一发打多少。面板、按钮、结算共用这一份算式 */
export function boltDamage(p: BoltParams, self: Unit, rank: number): number {
  if (typeof p.trueMul === 'number') return Math.round(trueDamageOf(self) * p.trueMul);
  return p.base + p.perRank * Math.max(0, rank);
}

// ── 数据行 ────────────────────────────────────────
/**
 * 掌心雷：族里的样板法术（补刀）。
 *
 * 它要验证四件事，也是整个法术系统的地基：
 *   1. **法术 ≠ 技能**：不在兵种表上、不随境界领悟，只能去藏经阁学；
 *   2. **吃灵力**：每一发都从自己的灵力池里扣，扣不起按钮就是灰的；
 *   3. **无视护甲**：走 `api.hurt`，不经过 `computeDamage` 的护甲段；
 *   4. **不限每回合一次**：节拍交给灵力池（9 期一回合能放两发，0 期一发都攒不齐）。
 *
 * 伤害 `6 + 3 × 境界`：低境界是"一发换掉半个兵"，高境界反而被普攻追上——
 * 这是有意的：法术的价值在"无视护甲 + 不还手"，不在数值膨胀。
 */
export const PALM_THUNDER_COST = 50;
export const PALM_THUNDER_BASE = 6;
export const PALM_THUNDER_PER_RANK = 3;
export const PALM_THUNDER_RANGE = 3;

/** 这一发打多少（面板和规则共用同一份算式） */
export function palmThunderDamage(rank: number): number {
  return PALM_THUNDER_BASE + PALM_THUNDER_PER_RANK * Math.max(0, rank);
}

const PALM_THUNDER: SpellRow = {
  id: 'palm-thunder',
  name: '掌心雷',
  summary:
    `射程 ${PALM_THUNDER_RANGE} 格，对一名敌人造成 ${PALM_THUNDER_BASE} + 境界×${PALM_THUNDER_PER_RANK} 点伤害（无视护甲）；` +
    `耗 ${PALM_THUNDER_COST} 灵力。`,
  effect: 'bolt',
  cost: PALM_THUNDER_COST,
  range: PALM_THUNDER_RANGE,
  // 单体法术亮"我够得着哪一圈"；不按落点算，否则鼠标一动高亮就碎
  preview: 'ring',
  multiCast: true,
  custom: {
    base: PALM_THUNDER_BASE,
    perRank: PALM_THUNDER_PER_RANK,
  } satisfies BoltParams,
};

export const PALM_THUNDER_SKILL = defineSpellSkill(PALM_THUNDER);

/** 灭神枪：70 灵力，3 期起可学（真元×2 在低境界太容易一发带走） */
export const MIE_SHEN_QIANG_COST = 70;
export const MIE_SHEN_QIANG_MIN_RANK = 3;
/** 元磁神光：60 灵力，2 期起可学（麻痹的强度靠境界抬伤害来换） */
export const YUAN_CI_SHEN_GUANG_COST = 60;
export const YUAN_CI_SHEN_GUANG_MIN_RANK = 2;
/** 五雷正法：80 灵力，4 期起可学（连锁在兵多时才值钱，早期用不上） */
export const WU_LEI_ZHENG_FA_COST = 80;
export const WU_LEI_ZHENG_FA_MIN_RANK = 4;

/**
 * 灭神枪：真元 ×2 的直线贯穿，无视护甲。魂法。
 *
 * 数值是占位：真元在 4 期约 20 点，一发 40——比掌心雷高一档，
 * 代价是它要求目标在自己和落点的连线上，站位对了才吃满。
 */
const MIE_SHEN_QIANG: SpellRow = {
  id: 'mie-shen-qiang',
  name: '灭神枪',
  summary:
    '射程 6 格，沿直线贯穿并命中线上所有敌人，造成「真元 ×2」点伤害（无视护甲）；耗 70 灵力。魂法。',
  effect: 'bolt',
  cost: MIE_SHEN_QIANG_COST,
  range: 6,
  preview: 'ring',
  custom: { base: 0, perRank: 0, trueMul: 2, line: true, soulBound: true } satisfies BoltParams,
};

/**
 * 元磁神光：单点无视护甲 + 麻痹一回合。
 *
 * "让对方少一个回合"在数值上比多点伤害值钱，所以伤害压得比掌心雷低。
 */
const YUAN_CI_SHEN_GUANG: SpellRow = {
  id: 'yuan-ci-shen-guang',
  name: '元磁神光',
  summary: '射程 4 格，对一名敌人造成 8 + 境界×4 点伤害（无视护甲），并使其麻痹 1 回合；耗 60 灵力。',
  effect: 'bolt',
  cost: YUAN_CI_SHEN_GUANG_COST,
  range: 4,
  preview: 'ring',
  custom: { base: 8, perRank: 4, stun: 1 } satisfies BoltParams,
};

/**
 * 五雷正法：一次普通攻击，目标身边还有别人时雷会跳过去，最多再跳 5 次。
 *
 * 它是这一族里唯一 `physical: true` 的——"普攻"就该被护甲挡，
 * 不然它会变成"射程更远的罡风"，两者就没有性格差别了。
 */
const WU_LEI_ZHENG_FA: SpellRow = {
  id: 'wu-lei-zheng-fa',
  name: '五雷正法',
  summary:
    '射程 5 格，对一名敌人造成 10 + 境界×5 点伤害（按护甲结算）；' +
    '若目标 2 格内还有别的敌人，雷会继续跳过去，最多再跳 5 次；耗 80 灵力。',
  effect: 'bolt',
  cost: WU_LEI_ZHENG_FA_COST,
  range: 5,
  preview: 'ring',
  custom: { base: 10, perRank: 5, chain: 5, chainRadius: 2, physical: true } satisfies BoltParams,
};

/** 这一族的全部数据行（批量挂检查与高亮用） */
export const BOLT_ROWS: readonly SpellRow[] = [
  PALM_THUNDER,
  MIE_SHEN_QIANG,
  YUAN_CI_SHEN_GUANG,
  WU_LEI_ZHENG_FA,
];

export const MIE_SHEN_QIANG_SKILL = defineSpellSkill(MIE_SHEN_QIANG);
export const YUAN_CI_SHEN_GUANG_SKILL = defineSpellSkill(YUAN_CI_SHEN_GUANG);
export const WU_LEI_ZHENG_FA_SKILL = defineSpellSkill(WU_LEI_ZHENG_FA);

registerManaReady(BOLT_ROWS);
registerPreview(BOLT_ROWS);

// ── 实现 ──────────────────────────────────────────
/**
 * 沿直线收集受害者：几何来自 `rayCells`（和剑气纵横同一份）。
 *
 * 四方向吸附、定长射线，**不看点击距离**——点 2 格远和点 10 格远打出的是同一条线。
 * 用 `coversTile` 判"这一格站着谁"，而不是比对锚点坐标：2×2 的大单位
 * 占四格，按锚点判会在它身上漏掉两个身位。
 */
function lineVictims(c: SkillCtx, range: number): Unit[] {
  const self = c.self;
  const cells = rayCells(c.view, self, c.target!, range);
  return c.view.units.filter(
    (u) =>
      u.hp > 0 &&
      u.owner !== self.owner &&
      cells.some((cell) => coversTile(c.view, u, cell.x, cell.y)),
  );
}

/**
 * 连锁：从命中的人出发，把**半径内的所有**未命中敌人一起带下去，最多 `jumps` 层。
 *
 * 两个刻意的地方：
 *   1. **不是"找最近的一个"**。一层里半径内的所有人同时挨打，雷是散开去的，
 *      不是挑一个接着跳——后者在人群里只会打到一个，和"五雷正法"的意象不符。
 *   2. **穿迷雾**：用的是 `c.state.units` 而不是 `c.view.units`。
 *      雷一旦炸开就往四周窜，看不见的地方也会被连到，这是这门法术的卖点。
 *      但仍然**不跨图**：月面上的雷不会连到地球同坐标的人。
 */
function chainVictims(c: SkillCtx, first: Unit, jumps: number, radius: number): Unit[] {
  const s = c.state;
  const board = boardIdOf(c.self);
  const hit = new Set<Unit>([first]);
  let frontier: Unit[] = [first];

  for (let layer = 0; layer < jumps && frontier.length > 0; layer++) {
    const next: Unit[] = [];
    for (const u of s.units) {
      if (u.hp <= 0 || u.owner === c.self.owner || hit.has(u)) continue;
      if (boardIdOf(u) !== board) continue;
      if (!frontier.some((f) => distBetweenUnits(s, f, u) <= radius)) continue;
      hit.add(u);
      next.push(u);
    }
    frontier = next;
  }
  return [...hit];
}

registerSkillEffect('bolt', (c) => {
  const p = spellCustom<BoltParams>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const range = Number(p.spellRange);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  const tooFar = () => `太远了（${skillName}射程 ${range} 格）`;

  /*
   * 直线是**唯一**不走 `resolveCast` 的分支：它不要求落点上站着人
   * （枪打出去是一条线，不是"选中一个人"），也不看点击距离——
   * 只认方向，长度由射程决定（和剑气纵横完全一致）。
   */
  if (p.line) {
    const t = c.target;
    if (!t) {
      c.result.ok = false;
      c.result.reason = '选一个方向';
      return;
    }
    const victims = lineVictims(c, range);
    if (victims.length === 0) {
      c.result.ok = false;
      c.result.reason = '这条线上没有敌人';
      return;
    }
    if (!spendMana(self, cost)) {
      c.result.ok = false;
      c.result.reason = `灵力不足（需要 ${cost} 点）`;
      return;
    }
    const dmg = boltDamage(p, self, getRank(self));
    const { total, killed } = strikeAll(
      c,
      victims,
      dmg,
      {
        hurt: (v) => `${name}的${skillName}贯穿${c.api.utype(s, v.type).name}，造成 ${dmg} 点伤害`,
        kill: (v) => `${c.api.utype(s, v.type).name}被${skillName}钉在地上`,
      },
      { physical: p.physical },
    );
    c.result.log =
      `${name}施放${skillName}，贯穿 ${victims.length} 名敌人，共造成 ${total} 点伤害` +
      (killed > 0 ? `，${killed} 名当场殒命` : '') +
      `（耗 ${cost} 灵力）`;
    // 战况烈度：这一枪打到过哪儿，对面下一回合看得见
    c.api.noteHeat(s, t.x, t.y, boardIdOf(self));
    return;
  }

  const cast = resolveCast(c, {
    cost,
    range,
    mode: 'single',
    rangeFrom: 'victim',
    noTargetReason: () => '选一个目标',
    noUnitReason: () => '那一格没有单位（法术打不了城池）',
    allyReason: (ctx, victim) =>
      `不能对自己的${ctx.api.utype(ctx.state, victim.type).name}放${skillName}`,
    tooFarReason: tooFar,
  });
  if (!cast.ok) {
    c.result.ok = false;
    c.result.reason = cast.reason;
    return;
  }

  const first = cast.victims[0]!;
  const victims = p.chain ? chainVictims(c, first, p.chain, p.chainRadius ?? 2) : [first];
  const dmg = boltDamage(p, self, getRank(self));

  // 麻痹挂在命中之前也行，但挂在伤害之后更符合"先挨打、再失灵"的读感；
  // 且伤害不致死时它才是这发法术真正的价值。
  const { total, killed } = strikeAll(
    c,
    victims,
    dmg,
    {
      hurt: (v) => `${name}以${skillName}击中${c.api.utype(s, v.type).name}，造成 ${dmg} 点伤害`,
      kill: (v) => `${c.api.utype(s, v.type).name}被${skillName}击穿`,
    },
    { physical: p.physical },
  );
  // 只给活着的挂状态：给刚打死的尸体挂麻痹毫无意义，而且会让战报解释不通
  if (p.stun) {
    for (const v of victims) {
      if (v.hp > 0) stunFor(v, p.stun);
    }
  }

  const armorNote = p.physical ? '（按护甲结算）' : '（无视护甲）';
  const vName = c.api.utype(s, first.type).name;
  // 战况烈度：雷落到过哪儿，对面下一回合看得见（和掌心雷改造前一致）
  c.api.noteHeat(s, first.x, first.y, boardIdOf(self));
  if (victims.length > 1) {
    c.result.log =
      `${name}施放${skillName}，雷光连锁 ${victims.length} 名敌人，共造成 ${total} 点伤害` +
      (killed > 0 ? `，${killed} 名当场殒命` : '') +
      `（耗 ${cost} 灵力）`;
    return;
  }
  if (killed > 0) {
    c.result.log = `${name}${skillName}一击，${vName}当场殒命（耗 ${cost} 灵力）`;
    return;
  }
  c.result.log = `${name}施放${skillName}，${vName} 受到 ${dmg} 点伤害${armorNote}`;
});

/**
 * 虚空放逐（簇 A）——把敌人丢进**世界阴面**。
 *
 * 阴面是一张真图（见 `../shadow-world.ts`），所以这里要做的只有三件事：
 * 建图、换图、记一条"怎么回来"。
 *
 * ── 为什么记得"怎么回来" ────────────────────────────────────────
 *
 * 不放回来的话，这一发就是"点名删除一个敌人"——强到没有对手戏。
 * 所以读作：**放逐 3 回合**，第 4 个自己的回合开始，人从阴面爬回来
 * （回原位；原位被占就在阳面找一格空地）。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { BANISH_KEY, SHADOW_BOARD, freeShadowSpot, type BanishMark } from '../shadow-world.ts';
import {
  defineSpellSkill,
  registerManaReady,
  registerPreview,
  resolveCast,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export const XU_KONG_FANG_ZHU_COST = 100;
export const XU_KONG_FANG_ZHU_MIN_RANK = 6;
export const XU_KONG_FANG_ZHU_TURNS = 3;

const XU_KONG_FANG_ZHU: SpellRow = {
  id: 'xu-kong-fang-zhu',
  name: '虚空放逐',
  summary:
    `射程 5 格：把一名敌人丢进**世界阴面**（阴面是另一张同尺寸的图，全境阴影乱流，每回合真伤），` +
    `${XU_KONG_FANG_ZHU_TURNS} 回合后自己爬回来；耗 ${XU_KONG_FANG_ZHU_COST} 灵力。`,
  effect: 'banish',
  cost: XU_KONG_FANG_ZHU_COST,
  range: 5,
  preview: 'ring',
  custom: { turns: XU_KONG_FANG_ZHU_TURNS } satisfies Record<string, unknown>,
};

export const BANISH_ROWS: readonly SpellRow[] = [XU_KONG_FANG_ZHU];
export const XU_KONG_FANG_ZHU_SKILL = defineSpellSkill(XU_KONG_FANG_ZHU);

registerManaReady(BANISH_ROWS);
registerPreview(BANISH_ROWS);

registerSkillEffect('banish', (c) => {
  const p = spellCustom<Record<string, unknown>>(c);
  const s = c.state;
  const self = c.self;
  const range = Number(p.spellRange);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  const cast = resolveCast(c, {
    cost: Number(p.spellCost),
    range,
    mode: 'single',
    rangeFrom: 'victim',
    noTargetReason: () => '选一个目标',
    noUnitReason: () => '那一格没有单位',
    allyReason: (ctx, victim) => `不能放逐自己人（${ctx.api.utype(ctx.state, victim.type).name}）`,
    tooFarReason: () => `太远了（${skillName}射程 ${range} 格）`,
  });
  if (!cast.ok) {
    c.result.ok = false;
    c.result.reason = cast.reason;
    return;
  }

  const victim = cast.victims[0]!;
  const spot = freeShadowSpot(s);
  if (!spot) {
    c.result.ok = false;
    c.result.reason = '阴面已经挤满了';
    return;
  }

  // 记下"从哪来"——回来时用得上
  victim.custom = {
    ...(victim.custom ?? {}),
    [BANISH_KEY]: {
      turns: Number(p.turns ?? 3),
      board: victim.board ?? 'earth',
      x: victim.x,
      y: victim.y,
    } satisfies BanishMark,
  };
  victim.board = SHADOW_BOARD;
  victim.x = spot.x;
  victim.y = spot.y;
  // 落地就这一回合了：阴面不是刚被扔过去还能马上行动的地方
  victim.moved = true;
  victim.acted = true;

  c.result.log = `${name}施放${skillName}：${
    c.api.utype(s, victim.type).name
  } 被放逐到世界阴面（${p.turns} 回合后自行回来，耗 ${p.spellCost} 灵力）`;
});

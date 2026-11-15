/**
 * 天衍四九（簇 A）——回档。
 *
 * ── 一句话 ──────────────────────────────────────────────────────
 *
 * 第一次施放：**存一个棋盘快照**（"大道五十，天衍四九，人遁其一"——留一条退路）。
 * 之后再施放：**回到那个快照**。
 *
 * ── 回滚的范围（作者 2026-11-15 选的第 3 种口径）────────────────
 *
 * "只回滚棋盘，账目留下并标注：此三回合已被天衍四九抹去。"
 *
 * 所以：
 *   · **回滚**：单位花名册、每个单位的血/坐标/状态/`custom`（连人带修为都回到那一刻）；
 *   · **不回滚**：城市与建筑、金币灵石、击杀数、`s.turn`、战报本身。
 *     新召唤出来的单位会消失，这几回合死掉的人会回来——但"死过几个人"这笔账照算。
 *
 * 为什么不做"全量回滚"：那会让战报突然短一截，看起来像回放丢帧；
 * 为什么不做"都不回滚"：那这个法术就只剩下一句空话。
 *
 * ── 两个触发点 ──────────────────────────────────────────────────
 *
 *   · 主动：再放一次；
 *   · 被动：施法者倒下——存档点还在就自动回档（这才是"遁其一"的本意）。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import type { GameState, Unit } from '../../types.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export const TIAN_YAN_SI_JIU_COST = 120;
export const TIAN_YAN_SI_JIU_MIN_RANK = 8;

const TIAN_YAN_SI_JIU: SpellRow = {
  id: 'tian-yan-si-jiu',
  name: '天衍四九',
  summary:
    '第一次施放：**存一个棋盘快照**（五十之数，人遁其一）。之后再施放一次，全盘回到那一刻；' +
    '你倒下时若存档点还在，也会自动回档。**只回滚棋盘**——城市、灵石、击杀数与回合数照旧，' +
    `战报会写明这几回合被抹去；耗 ${TIAN_YAN_SI_JIU_COST} 灵力。`,
  effect: 'tianyan',
  cost: TIAN_YAN_SI_JIU_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {} satisfies Record<string, unknown>,
};

export const TIAN_YAN_ROWS: readonly SpellRow[] = [TIAN_YAN_SI_JIU];
export const TIAN_YAN_SI_JIU_SKILL = defineSpellSkill(TIAN_YAN_SI_JIU);

registerManaReady(TIAN_YAN_ROWS);
registerPreview(TIAN_YAN_ROWS);

function snapshotUnits(s: GameState): Unit[] {
  return JSON.parse(JSON.stringify(s.units)) as Unit[];
}

/**
 * 回到存档点。返回"抹去了几个回合"（0 = 没有存档点）。
 *
 * 这是**唯一**的回档实现：主动再放一次、以及施法者倒下时的自动回档，都走它。
 * 两处各写一遍的话，迟早出现"手动回档会保留 buff、自动回档不会"这种差异。
 */
export function restoreFromTianyan(
  s: GameState,
  log: (player: string, text: string) => void,
): number {
  const save = s.tianyan;
  if (!save) return 0;
  const wiped = Math.max(0, s.turn - save.turn);

  // 只换棋盘：账目（`s.fallen`、击杀、金币、turn）原样留着
  s.units = JSON.parse(JSON.stringify(save.units)) as Unit[];
  s.tianyan = undefined;
  // 回来的人这一回合不能再动：回档不该白送一个回合的行动
  for (const u of s.units) {
    if (u.owner !== save.owner) continue;
    u.moved = true;
    u.acted = true;
  }

  log(
    save.owner,
    wiped > 0
      ? `天衍四九：此后 ${wiped} 回合里棋盘上的事被抹去了（账目照旧）`
      : '天衍四九：棋盘回到存点那一刻',
  );
  return wiped;
}

registerSkillEffect('tianyan', (c) => {
  const p = spellCustom<Record<string, unknown>>(c);
  const s = c.state;
  const self = c.self;
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  if (!paySpellCost(c, Number(p.spellCost))) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${p.spellCost} 点）`;
    return;
  }

  if (s.tianyan) {
    const wiped = restoreFromTianyan(s, (owner, text) =>
      c.api.pushLog(s, owner as never, text, true),
    );
    c.result.log = `${name}施放${skillName}：回到存点（抹去 ${wiped} 回合的棋盘变化）`;
    return;
  }

  s.tianyan = { owner: self.owner, caster: self.id, turn: s.turn, units: snapshotUnits(s) };
  c.result.log = `${name}施放${skillName}：留了一条退路（存点于第 ${s.turn} 回合，耗 ${p.spellCost} 灵力）`;
});

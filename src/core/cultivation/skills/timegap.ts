/**
 * 烂柯棋局（簇 A）——**时间层面**的消失，不是空间层面。
 *
 * ── 作者的定义（2026-11-14 / 11-15）────────────────────────────
 *
 * "从当前回合消失的是时间层面的消失，不是空间层面，所以不是一种东西。"
 * 所以它不是隐藏、不是换图、也不是阴面：这个单位**在这一刻根本不存在**——
 * 不挡路、不挨打、不被判定，别人可以从它原来的格子走过去。
 *
 * ── 做法（作者给的方案，照办）─────────────────────────────────
 *
 *   1. 施放时**直接从 `s.units` 里删掉**，整个单位存进 `s.timeGap` 当快照；
 *   2. 数满回合后**把快照复制回来**；
 *   3. 回来那一刻格子被占了：**把占格子的挤开**；挤不开就直接删掉那个单位，
 *      战报写"因无法逃脱突然出现的时间乱流而迷失了"。
 *
 * 为什么快照放在**局**上而不是施法者身上：施法者自己也可能被棋局吞掉
 * （它本来就是最该躲进去的那个人），挂在身上会跟着一起消失。
 *
 * ⚠️ 一个要记住的边界：如果这是某一方**最后一个**单位，删掉它的那一下
 * 可能会让 `checkWinner` 判他出局。想彻底安全得在胜负判定里也算上 `timeGap`，
 * 那是另一件事（要改 `checkWinner`），这一版先不做，注释留在这里。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import type { GameState, TimeGapRecord, Unit } from '../../types.ts';
import { coversTile } from '../../query.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export const LAN_KE_QI_JU_COST = 85;
export const LAN_KE_QI_JU_MIN_RANK = 4;
export const LAN_KE_QI_JU_TURNS = 3;

const LAN_KE_QI_JU: SpellRow = {
  id: 'lan-ke-qi-ju',
  name: '烂柯棋局',
  summary:
    `让一名**友军**（含自己）从当前回合里消失 ${LAN_KE_QI_JU_TURNS} 回合：不挡路、不挨打、不被判定；` +
    `到期原样回来（若原位被占，会挤开对方；挤不开的那个人会被时间乱流卷走）；耗 ${LAN_KE_QI_JU_COST} 灵力。`,
  effect: 'timegap',
  cost: LAN_KE_QI_JU_COST,
  range: 5,
  preview: 'ring',
  custom: { turns: LAN_KE_QI_JU_TURNS } satisfies Record<string, unknown>,
};

export const TIME_GAP_ROWS: readonly SpellRow[] = [LAN_KE_QI_JU];
export const LAN_KE_QI_JU_SKILL = defineSpellSkill(LAN_KE_QI_JU);

registerManaReady(TIME_GAP_ROWS);
registerPreview(TIME_GAP_ROWS);

/** 深拷贝一个单位（快照用）。单位是纯数据，JSON 足够，也顺便断了引用 */
function snapshotOf(u: Unit): Unit {
  return JSON.parse(JSON.stringify(u)) as Unit;
}

registerSkillEffect('timegap', (c) => {
  const p = spellCustom<Record<string, unknown>>(c);
  const s = c.state;
  const self = c.self;
  const range = Number(p.spellRange);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;

  /*
   * 这里**不走 `resolveCast`**：它把"目标是自己人"当成错误（那是绝大多数攻击
   * 法术的默认口径），而棋局恰恰只能对友军用。与其给它加一个 `allowAlly`
   * 开关（会让那条通用路径多一种模式），不如在这条法术里自己判——三步而已。
   */
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '选一个自己人';
    return;
  }
  const victim = c.view.units.find((u) => u.hp > 0 && coversTile(c.view, u, t.x, t.y));
  if (!victim) {
    c.result.ok = false;
    c.result.reason = '那一格没有单位';
    return;
  }
  if (victim.owner !== self.owner) {
    c.result.ok = false;
    c.result.reason = `只能把自己人送进棋局（${c.api.utype(s, victim.type).name} 是敌人）`;
    return;
  }
  if (Math.abs(self.x - victim.x) + Math.abs(self.y - victim.y) > range) {
    c.result.ok = false;
    c.result.reason = `太远了（${skillName}射程 ${range} 格）`;
    return;
  }
  if (!paySpellCost(c, Number(p.spellCost))) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${p.spellCost} 点）`;
    return;
  }

  const gap: TimeGapRecord = {
    unit: snapshotOf(victim),
    left: Number(p.turns ?? 3),
    x: victim.x,
    y: victim.y,
    board: victim.board,
  };
  s.timeGap = [...(s.timeGap ?? []), gap];
  // 直接从盘上抹掉：不挡路、不挨打、不参与任何判定
  s.units = s.units.filter((u) => u.id !== victim.id);

  c.result.log = `${name}施放${skillName}：${c.api.utype(s, victim.type).name} 落进棋局，${p.turns} 回合后再现`;
});

/**
 * 把快照复制回场上。
 *
 * 落点被占时的顺序（作者定的）：**先挤开，挤不开就抹掉**。
 * 挤开的方向从四个正方向里挑第一个空位——不绕圈、不挑"最合适"，
 * 因为玩家只需要一个能讲清楚的结果："它被推开了"或"它没了"。
 */
export function returnFromTimeGap(s: GameState, rec: TimeGapRecord, log: (player: string, text: string) => void): void {
  const u = snapshotOf(rec.unit);
  u.x = rec.x;
  u.y = rec.y;
  u.board = rec.board;

  const blockers = s.units.filter((o) => o.hp > 0 && (o.board ?? 'earth') === (u.board ?? 'earth') && coversTile(s, o, u.x, u.y));
  for (const b of blockers) {
    const pushed = pushAside(s, b);
    if (!pushed) {
      // 挤不开：时间乱流把他卷走
      s.units = s.units.filter((x) => x.id !== b.id);
      log(b.owner, `${name(s, b.type)} 因无法逃脱突然出现的时间乱流而迷失了`);
    }
  }

  s.units = [...s.units, u];
  log(u.owner, `${name(s, u.type)} 从棋局中归来（${u.x},${u.y}）`);
}

function name(s: GameState, type: string): string {
  return s.unitTypes[type]?.name ?? type;
}

/** 往最近的一圈里找一格空位推开；找不到就返回 false（由调用方抹掉它） */
function pushAside(s: GameState, u: Unit): boolean {
  const dirs: Array<[number, number]> = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (let r = 1; r <= 2; r++) {
    for (const [dx, dy] of dirs) {
      const x = u.x + dx * r;
      const y = u.y + dy * r;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      const taken = s.units.some(
        (o) => o.id !== u.id && o.hp > 0 && (o.board ?? 'earth') === (u.board ?? 'earth') && coversTile(s, o, x, y),
      );
      if (taken) continue;
      u.x = x;
      u.y = y;
      return true;
    }
  }
  return false;
}

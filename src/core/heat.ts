/**
 * 战况烈度：上一回合里，这一格挨了多少下。
 *
 * ── 它回答的问题 ───────────────────────────────────────────────────────
 *
 * 轮到你了，但上一回合对面到底打了哪儿？——是试探性地碰了一下左翼，
 * 还是把整条中路犁了一遍？这个问题在战报里翻起来很累，在看棋盘时却应该一眼可见。
 * 所以这里按"格"记账：**每块格子上，我方单位上一次被打了多少次**。
 *
 * ── 为什么不按"谁能打到这一格"算 ──────────────────────────────────────
 *
 * 那算的是"未来的威胁"，是预测：射程覆盖不等于真的开火。而玩家真正需要复盘的是
 * **已经发生过的事**——哪儿被打得最狠，就该往哪儿补人、修工事、或者干脆放弃。
 * 预测会把整条战线都标红（敌人射程本来就很长），反而什么都看不出来。
 *
 * ── 记账口径 ───────────────────────────────────────────────────────────
 *
 *   · 一次伤害 = 一次计数（溅射打到三个人 = 三格各 +1，多动连打三次 = 那格 +3）；
 *   · 记的是**挨打那一刻**的格子，不是现在的格子——兵被打退、被打死后位置会变，
 *     复盘要看的是"当时在哪儿挨的打"；
 *   · 按回合分开存：`heat[玩家][回合][格] = 次数`。界面取 `s.turn - 1` 那一份，
 *     也就是"上一次敌方回合"。自己回合里吃到的反击记在自己这一回合的账上，
 *     不会污染上一回合的复盘；
 *   · 只留最近两回合，多的删掉——存档不该为一份提示无限长大。
 *
 * 不计入的：中毒/灼烧这类回合开始的持续伤害、天气钩子在回合末扣的血。
 * 它们是"环境"，不是"对面打了你"，混进来会让"哪里打得最狠"失真。
 */

import type { GameState, PlayerId, Unit } from './types.ts';

/**
 * 一次攻击"几何上覆盖到的所有格子"。
 *
 * 圆心就是**主命中格**（鼠标点的那一格），不是目标矩形。上一版按矩形
 * 往外扩是错的：那会把"打城的右下角"扩散成"围绕整座城一圈"。
 *
 *   · 主命中格无条件记录——"这一下确实贴上了"；
 *   · 溅射 = 以主命中格为中心、曼哈顿半径 <= radius 的所有格
 *     （和 splashTilesOf 的距离度量保持一致，视觉上才是"半径"）；
 *   · 主命中格与溅射格去重（一次攻击计一次）。
 *
 * `line=true`：溅射只取"攻击者 → 主命中格"这条直线上
 * 的格。方向由鼠标点的那一格决定，不由矩形锚点决定——点城的右侧，
 * 剑气就往右侧穿过去。
 */
/**
 * 只取"宽高"是有意的：覆盖格是一串**格号**，而格号只在某一张图里成立
 * （地球 20 宽的 `i=45` 和月球 9 宽的 `i=45` 是两个位置）。
 * 所以调用方传的是"这张图"的 `{ w, h }`，不是整个 state——
 * 传 state 就会不自觉地按地球算，月面战斗第一次接上时这里正好是最容易漏的一处。
 */
export function strikeCoverCells(
  s: { w: number; h: number },
  attacker: { x: number; y: number },
  hit: { x: number; y: number },
  radius: number,
  line: boolean,
): number[] {
  if (hit.x < 0 || hit.y < 0 || hit.x >= s.w || hit.y >= s.h) return [];
  const out: number[] = [hit.y * s.w + hit.x];
  if (radius <= 0) return out;

  const seen = new Set<number>(out);
  for (let ty = hit.y - radius; ty <= hit.y + radius; ty++) {
    for (let tx = hit.x - radius; tx <= hit.x + radius; tx++) {
      if (tx < 0 || ty < 0 || tx >= s.w || ty >= s.h) continue;
      const d = Math.abs(tx - hit.x) + Math.abs(ty - hit.y);
      if (d > radius) continue;
      if (line && !onStrikeRay(attacker, hit, tx, ty)) continue;
      const i = ty * s.w + tx;
      if (seen.has(i)) continue;
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

/** 直线判定：从攻击者到主命中格这条线上（含对角） */
function onStrikeRay(
  a: { x: number; y: number },
  hit: { x: number; y: number },
  vx: number,
  vy: number,
): boolean {
  const dx = Math.sign(hit.x - a.x);
  const dy = Math.sign(hit.y - a.y);
  if (dx === 0 && dy === 0) return true;
  const x = vx - a.x;
  const y = vy - a.y;
  if (dx === 0) return x === 0 && Math.sign(y) === dy;
  if (dy === 0) return y === 0 && Math.sign(x) === dx;
  return x * dy === y * dx && Math.sign(x) === dx && Math.sign(y) === dy;
}

/** 在某一格上给某个玩家记一次挨打 */
export function noteHeatAt(
  s: GameState,
  owner: PlayerId,   // 这一格算谁的账（挨打方）
  turn: number,      // 落在哪一轮（大多数时候就是 s.turn）
  x: number,
  y: number,
): void {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return;
  const perPlayer = ((s.heat ??= {})[owner] ??= {});
  const key = String(turn);
  const cells = (perPlayer[key] ??= {});
  const i = y * s.w + x;
  cells[i] = (cells[i] ?? 0) + 1;

  for (const k of Object.keys(perPlayer)) {
    if (Number(k) < s.turn - 1) delete perPlayer[k];
  }
}

/** 兼容旧签名：把一个单位的锚点记一次（内部走 noteHeatAt） */
export function noteHeat(s: GameState, victim: Unit): void {
  noteHeatAt(s, victim.owner, s.turn, victim.x, victim.y);
}

/**
 * 便捷版：默认"当前行动方打到对手"——记到对手账上、当前回合。
 * 攻击流程、技能、扩展能力实现默认走这条。
 */
export function noteHeatCell(s: GameState, x: number, y: number): void {
  const victim: PlayerId = s.current === 'A' ? 'B' : 'A';
  noteHeatAt(s, victim, s.turn, x, y);
}

/**
 * 上一次敌方回合里，这个玩家的哪些格子挨了打（格索引 → 次数）。
 *
 * `s.turn - 1` 就是"上一次敌方回合"：回合是逐方推进的，轮到你时，
 * 上一个回合必然是敌方那一次。
 */
export function heatCells(s: GameState, player: PlayerId): Map<number, number> {
  const out = new Map<number, number>();
  const cells = s.heat?.[player]?.[String(s.turn - 1)];
  if (!cells) return out;
  for (const [k, v] of Object.entries(cells)) {
    const i = Number(k);
    if (v > 0) out.set(i, v);
  }
  return out;
}

/**
 * 把次数折成闪烁档位（1~5）。
 *
 * 3 次和 4 次的差别玩家看得出来，7 次和 8 次看不出来——五档封顶是为了
 * 让"最激烈的那几格"保持醒目，而不是让整张图一起乱闪。
 */
export function heatStep(count: number): number {
  if (count <= 0) return 0;
  return Math.min(5, Math.max(1, Math.trunc(count)));
}

/**
 * 把"所有玩家、所有回合"的记账摊平成「格索引 → 次数」。
 *
 * 记账是按 (玩家, 回合) 分层的，而这个函数只关心"整盘棋一共记了多少"，
 * 用来给两个状态做差。分层信息在差里没有意义——一层一层比会漏掉
 * "回合推进导致记账从上一层挪到下一层"的情况。
 */
function heatTally(s: GameState): Map<number, number> {
  const out = new Map<number, number>();
  for (const perPlayer of Object.values(s.heat ?? {})) {
    for (const perTurn of Object.values(perPlayer ?? {})) {
      for (const [k, v] of Object.entries(perTurn ?? {})) {
        const i = Number(k);
        if (!(v > 0)) continue;
        out.set(i, (out.get(i) ?? 0) + v);
      }
    }
  }
  return out;
}

/**
 * 这一步比上一步**多记了**哪些格子（格索引 → 新增次数）。
 *
 * 出手闪烁就靠它：动作前后各拍一张记账快照，差出来的就是"这一下覆盖到哪"。
 * 好处是不必按动作类型逐个特判——普攻、溅射、反击、攻城、技能直伤走的都是
 * `noteHeatCell`，谁记了账谁就浮出来。
 *
 * 只看"增加"：`noteHeatAt` 会顺手删掉过期回合的记账，那种减少和开火无关。
 * 移动、建造、招募都不会记账，所以返回空表，界面自然不闪。
 */
export function newHeatCells(before: GameState, after: GameState): Map<number, number> {
  const was = heatTally(before);
  const now = heatTally(after);
  const out = new Map<number, number>();
  for (const [i, n] of now) {
    const delta = n - (was.get(i) ?? 0);
    if (delta > 0) out.set(i, delta);
  }
  return out;
}

/** 什么时候该把红格画出来 */
export interface HeatViewOpts {
  /** 此刻看得见的格子（雾）。不传 = 全图可见 */
  visible?: ReadonlySet<number>;
  /** 这一回合已经出过手了：红格只留到第一次行动，之后收起来 */
  dismissed?: boolean;
  /** 现在是不是轮到"自己这一方"看（观战、对方回合都不算） */
  active?: boolean;
}

/**
 * 交给界面的那一份烈度表：没东西可显示时返回 undefined。
 *
 * 三条规则都在这里落地，界面只管画：
 *   · 不是自己的回合 / 观战中 → 不显示；
 *   · 这一回合已经出手 → 收起（红格是"上回合的答卷"，看完就该让位）；
 *   · 视野外的格子 → 不显示，连坐标都不给。
 */
export function visibleHeat(
  s: GameState,
  player: PlayerId,
  opts: HeatViewOpts = {},
): Map<number, number> | undefined {
  if (opts.active === false) return undefined;
  if (opts.dismissed) return undefined;
  const out = new Map<number, number>();
  for (const [i, n] of heatCells(s, player)) {
    if (opts.visible && !opts.visible.has(i)) continue;
    out.set(i, n);
  }
  return out.size > 0 ? out : undefined;
}

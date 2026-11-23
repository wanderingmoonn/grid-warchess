/**
 * **打分层**：给定约束，产出一个引擎认的动作。
 *
 * ── 第一版故意写得笨 ────────────────────────────────────────
 *
 * 只会三件事：**让开、走、打**（造兵在入口里）。计划里明说了：头两周它会比 v1 还蠢，
 * 这是代价，不是 bug。v3 那六千行系数不抄——那些系数正是"改一处不知动到哪"的来源。
 *
 * ── 它不许自己发明目标 ──────────────────────────────────────
 *
 * v3 有一半的翻车是"编队自己挑了目标"（配对 4↑8↓）。这里目标的唯一来源是约束层：
 * 单位查不到任务，就什么都不做。
 */
import { applyAction, attackableTargets, effectiveStats, reachableTiles, siegeTargets, utype } from '../rules.ts';
import type { Action, GameState, Unit } from '../types.ts';
import type { Constraints, Squad } from './types.ts';
import type { World } from './world.ts';

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function squadOf(con: Constraints, u: Unit): Squad | undefined {
  for (const sq of con.squads) if (sq.unitIds.includes(u.id)) return sq;
  return undefined;
}

/** 目标格：任务指向哪儿（没有目标的 hold 返回 undefined） */
/**
 * 目标格：任务指向哪儿。
 *
 * 城要取**最近的一格**，不是左上角。城占 2×2（开了城郭是 3×3），
 * 拿左上角当目标会让"贴着城下"的兵被判成还差 2 格——戟兵射程只有 2，
 * 于是就永远够不着（S-000 上实测：推到 3 格、全体干站着）。
 */
function targetOf(s: GameState, sq: Squad): { x: number; y: number } | undefined {
  if (sq.at) return sq.at;
  if (!sq.cityId) return undefined;
  const c = s.cities.find((x) => x.id === sq.cityId);
  return c ? { x: c.x + Math.floor((c.size ?? 2) / 2), y: c.y + Math.floor((c.size ?? 2) / 2) } : undefined;
}



/**
 * 给一个单位挑一步。
 *
 * 优先级是**硬的**，不是分数：
 *   ① 站着挡路的，先让开（约束层的 keepClear）
 *   ② 射程内能打的，就打（不权衡"值不值"）
 *   ③ 有任务的，朝目标走
 *   ④ 没任务的，不动
 */
export function actFor(
  s: GameState,
  world: World,
  con: Constraints,
  u: Unit,
): Action | null {
  const keep = new Set(con.keepClear);

  /*
   * ① 让开：站在"必须空"的格子上。
   *
   * **只约束没有理由待在那儿的单位**（经济兵、驻守兵）。正在推进的战斗单位要过桥，
   * 让它"让开"就等于不许过河——桥面那一格本来就是临时占用。
   */
  const squadNow = squadOf(con, u);
  const mustClearOnBridge = utype(s, u.type).category === 'economy' || squadNow?.order === 'hold';
  if (keep.has(u.y * s.w + u.x) && mustClearOnBridge) {
    const spot = stepToward(s, u, awayPoint(s, u, keep), keep);
    if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
  }

  /*
   * ①.5 召回：`hold` 队离城还远，就先走回去——**这一步排在打人之前**。
   *
   * S-004 上实测：撤退的兵只要射程内出现敌人就会停下来打（v3 同一个病），
   * 结果 12 个兵只有 4 个回到城下、还丢了 12 个。
   * 约束说"回城"，那就先回城；路上能顺手打的，等站好位再说。
   */
  const sqNow = squadOf(con, u);
  if (sqNow?.order === 'hold' && sqNow.cityId) {
    const home = s.cities.find((c) => c.id === sqNow.cityId);
    if (home && cheb(u, home) > 2) {
      const to = { x: home.x, y: home.y };
      const spot = stepToward(s, u, to, keep);
      if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
    }
  }

  /*
   * ② 攻城：**排在打人之前**。
   *
   * 一开始把"能打就打"排在前面，结果 S-000 上 30 手打掉 0 城血：敌人一直站在城格上，
   * 于是永远有目标可打，永远轮不到攻城。
   * 这里的取舍是**约束优先**：约束层说了"去打这座城"，那到了就打城；
   * 打人只是路上的事，不是目的。
   */
  const sq = squadOf(con, u);

  if (sq && (sq.order === 'march' || sq.order === 'siege') && sq.cityId) {
    /* 同样问引擎：`siegeTargets` 已经含射程、高度、有没有武器 */
    const canHit = siegeTargets(s, u).find((c) => c.id === sq.cityId);
    if (canHit) return { type: 'SIEGE', unitId: u.id, cityId: canHit.id };
  }


  /* ③ 打人：能打谁由**引擎**回答，不自己算距离。
   *
   * 这里踩过一次：我自己按切比雪夫距离判"射程内"，而引擎按 `strikeDistance`（含高度差、
   * 空中 +1）算，于是 v4 每回合都提一个必被拒的攻击（"目标超出射程"），
   * 整整 30 手一次都没打出去。**一份真相：能打谁只问引擎。** */
  const st = effectiveStats(s, u);
  const foes = attackableTargets(s, u).filter((v) => v.owner !== world.me).sort((a, b) => a.hp - b.hp);
  if (foes[0] && (st.atk ?? 0) > 0) {
    return { type: 'ATTACK', unitId: u.id, targetId: foes[0].id, x: foes[0].x, y: foes[0].y };
  }


  /* ④ 走：朝任务目标。`hold` 也不是"钉在原地"——离城还远就先走回去 */
  if (!sq) return null;
  const to = targetOf(s, sq);
  if (sq.order === 'hold' && to && cheb(u, to) <= 2) return null;
  if (!to) return null;
  const spot = stepToward(s, u, to, keep);
  if (spot) return { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y };
  return null;
}

/**
 * 挑一个可达格：离 `to` 更近、且**不踩 keepClear** 的那一格里最好的。
 *
 * 为什么禁止踩 keepClear：那是约束层说"必须空"的格子。让单位为了走近路踩上去，
 * 等于把约束当参考——v3 就是这么把桥堵住的。
 */
function stepToward(
  s: GameState,
  u: Unit,
  to: { x: number; y: number },
  keep: Set<number>,
): { x: number; y: number } | null {
  const cur = cheb(u, to);
  let best: { x: number; y: number } | null = null;
  let bestD = cur;
  for (const [key] of reachableTiles(s, u)) {
    const x = key % s.w;
    const y = Math.floor(key / s.w);
    if (keep.has(key) && !(x === to.x && y === to.y)) continue;
    if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
    const d = cheb({ x, y }, to);
    if (d < bestD) {
      bestD = d;
      best = { x, y };
    }
  }
  return best;
}

/** 让开时往哪儿走：离 `from` 远一点、不在 keepClear 上的空格 */
function awayPoint(
  s: GameState,
  u: Unit,
  keep: Set<number>,
): { x: number; y: number } {
  let best: { x: number; y: number } = { x: u.x, y: u.y };
  let bestScore = -Infinity;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = u.x + dx;
      const y = u.y + dy;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      const k = y * s.w + x;
      if (keep.has(k)) continue;
      if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
      const t = s.tiles[k]?.terrain;
      if (!t || t === 'water' || t === 'deep' || t === 'mountain') continue;
      const score = Math.abs(dx) + Math.abs(dy);
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

/** 造兵：钱够就在最近的一座城里造最便宜的兵。**不挑兵种**，先保证有兵 */
export function recruitAction(s: GameState, world: World): Action | null {
  const gold = s.players[world.me]?.gold ?? 0;
  for (const info of world.cities) {
    if (info.role === 'threatened') continue; // 被压着的城造不出来
    for (const opt of world.affordableCombat(info.city, gold)) {
      const a: Action = { type: 'RECRUIT', cityId: info.city.id, unitType: opt.type };
      const r = applyAction(s, a);
      if (r.ok) return a;
    }
  }
  return null;
}

/** 这个单位是不是住在"必须空"的格子上 */
export function isBlocker(s: GameState, con: Constraints, u: Unit): boolean {
  return con.keepClear.includes(u.y * s.w + u.x);
}

/** 一个单位当前的类别（战斗/经济），上层要按这个分队 */
export function categoryOf(s: GameState, u: Unit): string {
  return utype(s, u.type).category ?? 'other';
}

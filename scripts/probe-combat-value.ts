/**
 * **相对战力探针**（只读，不参与任何判断）。
 *
 *   node --experimental-strip-types scripts/probe-combat-value.ts [--era 3] [--gold 400]
 *
 * 目的：在把旧身价（`攻 + 血 + 射程×4`）换成"相对战力"之前，先把数打出来。
 *
 * ── 相对战力是什么（2026-11-27 用户定）────────────────────────────
 *
 * **对着一个具体敌人算**，单位是"伤害"：
 *
 *   每回合伤害 = 单发伤害（`previewAttack`，带护甲/破甲）× 一回合几发（`attacksPerTurn`）
 *   射程先手 = 我射程比它远时，它要走过来才能还手 → 我白打 ceil((我射程 − 它射程) / 它移动力) 回合
 *   战力     = 每回合伤害 × (我能活几回合 + 白打几回合)
 *                 其中"活几回合" = 我的血 ÷ 它每回合伤害
 *
 * 这个式子里，**射程**和**多段**都进了分子（它们本来就是"能打出多少"的一部分），
 * 而不是像旧身价那样"射程 × 4"拍一个系数。
 *
 * ── 参照敌人（不找"最强"，避免石头剪刀布）──────────────────────
 *
 * 用**一组参照**（同代陆军里：最贵 / 最厚 / 射程最远），战力取三者里的**最小值**：
 * 含义 = "对最难缠的那个假想敌，能打出多少"。三个参照都是设计数据选出来的，
 * 不需要任何战力排序，所以不会循环。
 *
 * ── 另外打三张表 ──────────────────────────────────────────
 *
 *   ① 旧身价 vs 新战力 的排名差（看谁被高估/低估）
 *   ② 有没有环：两两单挑的胜负关系（3 元环 / 4 元环）
 *   ③ 等金群战：同样的钱买一群，按"集火"打完谁赢（回答"一群斥候 vs 等量弓手"）
 */

import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { attacksPerTurn, previewAttack, utype } from '../src/core/rules.ts';
import { unitWorthOfType } from '../src/core/v4/world.ts';
import type { GameState, Unit } from '../src/core/types.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : dflt;
};
const ERA = Number(argOf('era', '3'));
const GOLD = Number(argOf('gold', '400'));
/**
 * **前线上限**（S0，2026-11-27）：一回合里"最多几个人能打到同一个目标"。
 *
 * 用户的经验值：**野战 4~6**；守城看地形（有时更小，被包围时说不清）——所以这里做成参数，
 * 默认 6。近战按这个数排队；**远程不排队**（射程内都打得到）——射程的价值就在这里，
 * 上一版探针没有这一条，所以"等量斥候 vs 等量弓手"算出来是斥候赢。
 */
const FRONTAGE = Number(argOf('frontage', '6'));

const s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 1 }, 900);
const probe = (type: string): Unit =>
  ({ id: `__p_${type}`, owner: 'A', type, x: 8, y: 8, hp: utype(s, type).maxHp }) as Unit;

/** 每回合伤害（单发 × 一回合几发） */
const dps = (a: string, b: string): number => {
  const one = previewAttack(s, probe(a), probe(b)).toDefender;
  return Math.max(0, one) * attacksPerTurn(s, probe(a));
};

/** 我射程比它远 → 它得走过来；白打几回合（按它的移动力算） */
const freeRounds = (a: string, b: string): number => {
  const gap = (utype(s, a).range ?? 1) - (utype(s, b).range ?? 1);
  if (gap <= 0) return 0;
  return Math.ceil(gap / Math.max(1, utype(s, b).move ?? 1));
};

/**
 * 战力：**死之前能打出多少伤害**。
 *
 *   myDps × (我的血 ÷ 它每回合伤害 + 白打回合)
 *
 * 它打不动我（伤害 0）→ 我能一直打，按 99 回合算（封顶，防止 Infinity）。
 */
const power = (a: string, b: string): number => {
  const mine = dps(a, b);
  if (mine <= 0) return 0;
  const theirs = dps(b, a);
  const alive = theirs <= 0 ? 99 : (utype(s, a).maxHp ?? 1) / theirs;
  return mine * (alive + freeRounds(a, b));
};

/** 单挑谁先打死谁（给"有没有环"用） */
const duelWin = (a: string, b: string): boolean => {
  const mine = dps(a, b);
  const theirs = dps(b, a);
  if (mine <= 0) return false;
  if (theirs <= 0) return true;
  const tMine = (utype(s, b).maxHp ?? 1) / mine;
  const tTheirs = (utype(s, a).maxHp ?? 1) / theirs - freeRounds(a, b);
  return tMine < tTheirs;
};

/**
 * 等金群战（集火模型）：两边各买满预算，每回合把伤害砸在对面一个人身上。
 * 只是数，不是引擎模拟——用来回答"人多但弱"和"人少但强"谁赢。
 */
/** 这一回合这一方能有几个人输出：近战排队，远程不排 */
const attackers = (alive: number, type: string): number =>
  (utype(s, type).range ?? 1) >= 2 ? alive : Math.min(alive, FRONTAGE);

const squadFight = (
  a: string,
  b: string,
  na0: number,
  nb0: number,
): { na: number; nb: number; win: 'A' | 'B'; rounds: number } => {
  const hpA = utype(s, a).maxHp ?? 1;
  const hpB = utype(s, b).maxHp ?? 1;
  let aPool = na0 * hpA;
  let bPool = nb0 * hpB;
  let na = na0;
  let nb = nb0;
  let free = freeRounds(a, b);
  const da = dps(a, b);
  const db = dps(b, a);
  for (let round = 1; round <= 400; round++) {
    /* A 先手（射程远的白打），每回合把伤害全砸在 B 身上（集火） */
    bPool -= attackers(na, a) * da;
    if (bPool <= 0) return { na: Math.ceil(aPool / hpA), nb: 0, win: 'A', rounds: round };
    nb = Math.ceil(bPool / hpB);
    if (free > 0) {
      free -= 1;
      continue;
    }
    aPool -= attackers(nb, b) * db;
    if (aPool <= 0) return { na: 0, nb: Math.ceil(bPool / hpB), win: 'B', rounds: round };
    na = Math.ceil(aPool / hpA);
  }
  return { na, nb, win: 'B', rounds: 400 };
};

/* ── 参照组：同代陆军里 最贵 / 最厚 / 射程最远 ────────────────── */
const landCombat = (era: number): string[] =>
  Object.values(s.unitTypes)
    .filter((d) => d.category === 'combat' && (d.domain ?? 'land') !== 'water' && (d.era ?? 1) === era)
    .map((d) => d.id);

const refsOf = (era: number): string[] => {
  const ids = landCombat(era);
  if (ids.length === 0) return [];
  const pick = (key: (t: string) => number): string =>
    [...ids].sort((a, b) => key(b) - key(a) || (a < b ? -1 : 1))[0]!;
  return [...new Set([
    pick((t) => utype(s, t).cost ?? 0),
    pick((t) => utype(s, t).maxHp ?? 0),
    pick((t) => utype(s, t).range ?? 1),
  ])];
};

const refs = refsOf(ERA);
const refName = refs.map((t) => utype(s, t).name ?? t).join(' / ');
console.log(`\n=== ${ERA} 代 · 参照组：${refName} ===\n`);
console.log('兵种      价   攻  血  甲 移 射 段 | 旧身价 /100金 | 新战力 /100金 | 对参照（逐个）');
const rows = landCombat(ERA).map((t) => {
  const st = utype(s, t);
  const cost = st.cost ?? 1;
  const worth = unitWorthOfType(s, t);
  const per = refs.map((r) => power(t, r));
  /* 参照组取最小：对最难缠的那个假想敌能打出多少 */
  const p = Math.min(...per);
  return { t, cost, worth, p, per };
});
for (const r of rows.sort((a, b) => b.p / b.cost - a.p / a.cost)) {
  const st = utype(s, r.t);
  console.log(
    `${(st.name ?? r.t).padEnd(7)} ${String(r.cost).padStart(4)} ${String(st.atk).padStart(3)} ${String(st.maxHp).padStart(3)} ` +
      `${String(st.armor).padStart(3)} ${String(st.move).padStart(2)} ${String(st.range).padStart(2)} ${String(st.burst ?? 1).padStart(2)} | ` +
      `${String(r.worth).padStart(5)} ${(r.worth / (r.cost / 100)).toFixed(0).padStart(5)} | ` +
      `${r.p.toFixed(0).padStart(6)} ${(r.p / (r.cost / 100)).toFixed(0).padStart(5)} | ${r.per.map((x) => x.toFixed(0)).join(' / ')}`,
  );
}

/* ── ② 有没有环 ─────────────────────────────────────────── */
const ids = landCombat(ERA);
const cycles3: string[] = [];
for (const a of ids) for (const b of ids) for (const c of ids) {
  if (new Set([a, b, c]).size < 3) continue;
  if (duelWin(a, b) && duelWin(b, c) && duelWin(c, a)) {
    const key = [a, b, c].sort().join('+');
    if (!cycles3.includes(key)) cycles3.push(key);
  }
}
console.log(`\n单挑胜负的三元环：${cycles3.length === 0 ? '无' : cycles3.join(' , ')}`);
const rank = [...ids].sort((a, b) => ids.filter((c) => duelWin(b, c)).length - ids.filter((c) => duelWin(a, c)).length);
console.log('单挑胜场排名：' + rank.map((t) => `${utype(s, t).name}(${ids.filter((c) => duelWin(t, c)).length})`).join(' > '));

/* ── ③ 群战（集火）：等金 和 等量 两种 ───────────────────── */
const names = (t: string) => utype(s, t).name ?? t;
console.log(`\n等金群战（${GOLD} 金，集火模型，前线上限 ${FRONTAGE}）：`);
const pairs: Array<[string, string]> = [];
for (const x of rows) for (const y of rows) if (x.t !== y.t) pairs.push([x.t, y.t]);
let mismatch = 0;
const lines: string[] = [];
for (const [a, b] of pairs) {
  const na = Math.floor(GOLD / (utype(s, a).cost ?? 1));
  const nb = Math.floor(GOLD / (utype(s, b).cost ?? 1));
  const r = squadFight(a, b, na, nb);
  const perA = rows.find((x) => x.t === a)!.p / (utype(s, a).cost ?? 1);
  const perB = rows.find((x) => x.t === b)!.p / (utype(s, b).cost ?? 1);
  const predicted = perA >= perB ? 'A' : 'B';
  if (r.win !== predicted) {
    mismatch += 1;
    if (lines.length < 8) lines.push(`    ${names(a)}×${na} vs ${names(b)}×${nb} → ${names(r.win === 'A' ? a : b)} 赢`);
  }
}
console.log(`  与"新战力/金"不一致的场次：${mismatch} / ${pairs.length}`);
console.log(lines.join('\n'));

console.log(`\n等量群战（集火 + 前线上限 ${FRONTAGE}）：`);
for (const [a, b] of [['scout', 'archer'], ['militia', 'archer'], ['scout', 'militia']] as Array<[string, string]>) {
  if (!rows.some((x) => x.t === a) || !rows.some((x) => x.t === b)) continue;
  for (const n of [6, 12, 20]) {
    const r = squadFight(a, b, n, n);
    console.log(
      `  ${names(a)}×${n} vs ${names(b)}×${n} → ${names(r.win === 'A' ? a : b)} 赢，剩 ${r.win === 'A' ? r.na : r.nb} 个（${r.rounds} 回合）`,
    );
  }
}

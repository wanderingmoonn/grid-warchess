/**
 * **拟合公式到标定表**（S1 的前一步，只读）。
 *
 *   node --experimental-strip-types scripts/fit-combat-formula.ts [--n 6]
 *
 * 做什么：
 *   ① 用 `scripts/lib/duel.ts` 把每一代"每对兵打两次"跑出来，得到**实测净胜人数**；
 *   ② 拿一个**带参数的公式**给每个兵算"战力"，参数用网格搜；
 *   ③ 打分 = 这个公式"两两强弱的方向"和实测有没有对上（对得上几分）；
 *   ④ 打印最优参数 + 每一代的"实测 vs 公式"排名对照。
 *
 * 公式（对着参照兵 r 算，四代同一套）：
 *
 *   每回合伤害 dmg(u→r) = 单发伤害（previewAttack，带护甲/破甲）× 一回合几发
 *   能活几回合  tank(u,r) = 我的血 ÷ r 每回合伤害            （r 打不动我 → 99）
 *   白打回合    stand(u,r) = max(0, 我射程 − r 射程) ÷ r 移动力
 *   战力        power = dmg × (wHp × tank + wStand × stand) × (射程比 r 远 ? kRange : 1)
 *
 *   wHp / wStand / kRange 三个参数由网格搜出来——**这就是"射程到底值多少"的标定**。
 * 参照兵：同代陆军里 最贵 / 最厚 / 射程最远 三个，power 取**最小值**（对最难缠的能打出多少）。
 */
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { attacksPerTurn, previewAttack, utype } from '../src/core/rules.ts';
import { combatOfEra } from './lib/duel.ts';
import { duel, flushDuelCache } from './lib/duel-cache.ts';
import type { GameState, Unit } from '../src/core/types.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : dflt;
};
const N = Number(argOf('n', '6'));

const s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 1 }, 900);
const P = (t: string) => ({ id: `__${t}`, owner: 'A', type: t, x: 8, y: 8, hp: utype(s, t).maxHp }) as Unit;
const dpsCache = new Map<string, number>();
const dps = (a: string, b: string): number => {
  const k = `${a}|${b}`;
  const hit = dpsCache.get(k);
  if (hit !== undefined) return hit;
  const v = Math.max(0, previewAttack(s, P(a), P(b)).toDefender) * attacksPerTurn(s, P(a));
  dpsCache.set(k, v);
  return v;
};

/** 实测：每一代每个兵赢了几个对手 + 净胜人数合计 */
interface Measured {
  era: number;
  ids: string[];
  /** 赢了几场（净胜人数 > 0 算赢） */
  score: Record<string, number>;
  /** 净胜人数合计（用来排"谁更一边倒"） */
  margin: Record<string, number>;
}
const measured: Measured[] = [];
for (const era of [1, 2, 3, 4, 5]) {
  const ids = combatOfEra(s, era);
  if (ids.length < 2) continue;
  const score: Record<string, number> = {};
  const margin: Record<string, number> = {};
  for (const id of ids) {
    score[id] = 0;
    margin[id] = 0;
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      const r1 = duel(a, b, N);
      const r2 = duel(b, a, N);
      const m = r1.aLeft - r1.bLeft + (r2.bLeft - r2.aLeft);
      margin[a] = (margin[a] ?? 0) + m;
      margin[b] = (margin[b] ?? 0) - m;
      if (m > 0) score[a] = (score[a] ?? 0) + 1;
      else if (m < 0) score[b] = (score[b] ?? 0) + 1;
    }
  }
  measured.push({ era, ids, score, margin });
}

/*
 * **加一批"跨代"样本**（2026-11-27）：只拟合"同代内"的话，参数会把"活多久"压得很低
 * （同代里大家都差不多厚），结果**装甲车/坦克这类厚甲兵被系统性低估**——
 * 实测：火枪×6 打装甲车×6 是 **-10**（装甲车赢），公式却把火枪排在装甲车前面。
 * 这里让每一代每个兵和**上一代最强的两个**也打一场，把"升代到底换来了什么"变成拟合样本。
 */
/* ⚠️ 这里必须锁住**原来的长度**：循环里会往 `measured` 里 push，
 * 用 `k < measured.length` 会永远追不上自己（第一版就这么挂过 10 分钟）。 */
const baseLen = measured.length;
if (process.argv.includes('--cross')) for (let k = 1; k < baseLen; k++) {
  const prev = measured[k - 1]!;
  const cur = measured[k]!;
  const tops = [...prev.ids].sort((a, b) => prev.score[b]! - prev.score[a]! || (a < b ? -1 : 1)).slice(0, 1);
  const ids = [...cur.ids, ...tops];
  if (ids.length < 2) continue;
  const score: Record<string, number> = {};
  const margin: Record<string, number> = {};
  for (const id of ids) { score[id] = 0; margin[id] = 0; }
  for (const a of cur.ids) {
    for (const b of tops) {
      const r1 = duel(a, b, N);
      const r2 = duel(b, a, N);
      const m = r1.aLeft - r1.bLeft + (r2.bLeft - r2.aLeft);
      margin[a] = (margin[a] ?? 0) + m;
      margin[b] = (margin[b] ?? 0) - m;
      if (m > 0) score[a] = (score[a] ?? 0) + 1;
      else if (m < 0) score[b] = (score[b] ?? 0) + 1;
    }
  }
  /* 参照组仍按**这一代**取（跨代样本只是多了几对对手，不该换尺子） */
  measured.push({ era: cur.era, ids, score, margin });
}

/** 参照组：最贵 / 最厚 / 射程最远（不用战力排序，所以不会循环） */
const refsOf = (era: number): string[] => {
  const ids = combatOfEra(s, era);
  const pick = (key: (t: string) => number): string => [...ids].sort((a, b) => key(b) - key(a) || (a < b ? -1 : 1))[0]!;
  return [...new Set([pick((t) => utype(s, t).cost ?? 0), pick((t) => utype(s, t).maxHp ?? 0), pick((t) => utype(s, t).range ?? 1)])];
};

const power = (u: string, r: string, wHp: number, wStand: number, _kRange: number, _GAP: number, _wArmor = 0): number => {
  const mine = dps(u, r);
  if (mine <= 0) return 0;
  /*
   * **能活几回合 = 要挨几发才死 ÷ 对面每回合几发**（2026-11-27 修）。
   *
   * 旧写法是 `血 ÷ 对面每回合伤害`，那已经把护甲算进去了（`previewAttack` 按发减护甲）；
   * 再叠一项 `护甲 × 发数` 就是**同一件事算两次**，而且量纲也不对（那是"每回合少吃的伤害"，
   * 不是"多活几回合"）。
   * 改成"整数发数"：护甲只在 `perHit` 里出现一次，同时**过杀浪费**自动被表达出来
   * （少发大伤害打厚血兵会溢出，多发小伤害不会）。
   */
  const perHit = previewAttack(s, P(r), P(u)).toDefender;
  const perTurn = Math.max(1, attacksPerTurn(s, P(r)));
  const tank = perHit <= 0 ? 99 : Math.ceil((utype(s, u).maxHp ?? 1) / perHit) / perTurn;
  /*
   * **白打几轮 = 射程差 ÷ 走过来的那个人每回合走几格**（2026-11-27 用户改）。
   *
   * 不再有 GAP：只要两边都在朝对方走，"谁先进入自己的射程"只差一个**射程差**，与初始距离无关：
   *   · 我射程远 → 它要多走 `range(u) − range(r)` 格才还得了手 → 我白打 差 ÷ 它移动力 轮；
   *   · 它射程远 → 反过来，**我少活这么多轮**（这一半以前漏了，只算了自己占便宜的那一半）。
   */
  const delta = (utype(s, u).range ?? 1) - (utype(s, r).range ?? 1);
  const freeRounds =
    delta > 0
      ? delta / Math.max(1, utype(s, r).move ?? 2)
      : delta < 0
        ? delta / Math.max(1, utype(s, u).move ?? 2)
        : 0;
  const far = 1;
  return mine * (wHp * tank + wStand * freeRounds) * far;
};
/**
 * 对参照组怎么汇总：`min`（最怕的那个）/ `mean`（平均）。
 *
 * 第一版用 min，结果**远程兵被自己拖死**：参照组里"射程最远"那个就是它自己，
 * 对着自己算没有白打回合，战力被压到最低（1 代弓手排最后）。所以拿平均也试一遍。
 */
let AGG: 'min' | 'mean' = 'min';
const powerOf = (t: string, era: number, p: [number, number, number, number, number]): number => {
  const vals = refsOf(era).map((r) => power(t, r, p[0], p[1], p[2], p[3], p[4]));
  return AGG === 'min' ? Math.min(...vals) : vals.reduce((n, x) => n + x, 0) / Math.max(1, vals.length);
};

/** 打分：每一代里，两两比较"公式说谁强"和"实测谁净胜多"，方向对上得 1 分 */
const agree = (p: [number, number, number, number, number]): number => {
  let ok = 0;
  let total = 0;
  for (const m of measured) {
    for (let i = 0; i < m.ids.length; i++) {
      for (let j = i + 1; j < m.ids.length; j++) {
        const a = m.ids[i]!;
        const b = m.ids[j]!;
        const pa = powerOf(a, m.era, p);
        const pb = powerOf(b, m.era, p);
        const da = Math.sign(pa - pb);
        const db = Math.sign(m.margin[a]! - m.margin[b]!);
        if (db === 0) continue;
        total += 1;
        if (da === db) ok += 1;
      }
    }
  }
  return total === 0 ? 0 : ok / total;
};

/* ── 网格搜索 ─────────────────────────────────────────────── */
let best = { p: [1, 1, 1, 6, 0] as [number, number, number, number, number], score: -1, agg: 'min' as 'min' | 'mean' };
for (const agg of ['min', 'mean'] as Array<'min' | 'mean'>) {
  AGG = agg;
for (const wHp of [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5]) {
  for (const wStand of [0.5, 1, 1.5, 2, 3, 4]) {
    for (const kRange of [1, 1.1, 1.25, 1.5]) {
      for (const GAP of [0]) {
        for (const wArmor of [0, 0.5, 1, 2, 3]) {
        const sc = agree([wHp, wStand, kRange, GAP, wArmor]);
        if (sc > best.score) best = { p: [wHp, wStand, kRange, GAP, wArmor], score: sc, agg };
        }
        }
      }
    }
  }
}
AGG = best.agg;
console.log(`\n最优参数：wHp=${best.p[0]}  wStand=${best.p[1]}  kRange=${best.p[2]}  GAP=${best.p[3]}  参照汇总=${best.agg}  护甲权重=${best.p[4]}  → 方向一致率 ${(best.score * 100).toFixed(0)}%`);
console.log(`（旧身价作为对照的一致率：${(agree([1, 0, 1, 6, 0]) * 100).toFixed(0)}%，但旧公式不是这个形状，仅供参照）\n`);

for (const m of measured) {
  const pred = [...m.ids].sort((a, b) => powerOf(b, m.era, best.p) - powerOf(a, m.era, best.p));
  const real = [...m.ids].sort((a, b) => m.margin[b]! - m.margin[a]!);
  console.log(
    `${m.era} 代  实测：${real.map((t) => `${utype(s, t).name}(${m.score[t] ?? 0}分/净${m.margin[t]})`).join(' > ')}\n` +
      `      公式：${pred.map((t) => `${utype(s, t).name}(${Math.round(powerOf(t, m.era, best.p))})`).join(' > ')}`,
  );
}

flushDuelCache();

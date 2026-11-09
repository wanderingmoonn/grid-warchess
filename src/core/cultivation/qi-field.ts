/**
 * 灵气浓度：格子上的一个标量场，修士从里面吸灵力。
 *
 * ── 模型（2026-11-09 敲定）──────────────────────────────────
 *
 * 一条扩散方程，离散成四个步骤，每方回合跑一次：
 *
 *   ∂q/∂t = D∇²q + S − kq
 *
 *   · `D∇²q` 扩散：从高往低流，流多少看**梯度**（邻居减自己）
 *   · `S`    源汇：地形与建筑每回合注入（灵矿是**汇**，负的）
 *   · `kq`   损耗：浓度越高散得越快，这是唯一防止全场爆表的闸门
 *
 * ── 三个必须守住的数值条件 ─────────────────────────────────
 *
 * 1. **稳定性 `D ≤ 0.25`**。显式欧拉解扩散方程，超过这个值会开始震荡
 *    （浓度左右横跳甚至变负）。取 0.12，一格的影响约 8 回合传到 3 格之外。
 * 2. **边界零通量**。边缘只对**界内**邻居求和，没有任何"流出地图"的路。
 *    否则边缘一圈会无限失血，玩家看到的是"边上的地越打越荒"——那是 bug。
 * 3. **双重缓冲**。必须用旧值算出一整张新表再写回。原地更新会让扩散带
 *    方向偏置：先遍历到的格子先拿走灵气，图像上表现为"灵气往左上角漂"。
 *
 * ── 为什么存 `Tile.custom.qi` ───────────────────────────────
 *
 * 核心不认识灵气（见 types.ts 的 `Tile.custom`）。这个文件是唯一的写入口，
 * 缺省值按地形给——所以老存档、新开的地图都不需要初始化，读出来就是
 * "这块地本来该有多少"。
 *
 * ⚠️ 红线：本文件不许 import `../rules.ts`（初始化链会成环，见 skills/sky-step.ts）。
 * 需要的东西全在 query / progression / mana / identity 里。
 */
import type { GameState, Terrain, Tile, Unit } from '../types.ts';
import { CONFIG } from '../config.ts';
import { idx, underConstruction } from '../query.ts';
import { getRank } from './progression.ts';
import { manaOf, maxManaOf, setMana } from './mana.ts';
import { UNIT_IDS } from './identity.ts';

// ── 数值 ──────────────────────────────────────────

/** 浓度域的上限。下限永远是 0 */
export const QI_MAX = 100;

/** 扩散系数。显式欧拉的稳定上限是 1/4，这里取一半留余量 */
export const QI_DIFFUSE = 0.12;

/** 每回合的损耗比例。`S / k` 就是一个孤立源格的平衡浓度 */
export const QI_DECAY = 0.1;

/** 灵力缺口里，每回合能从环境补回来的比例（缺口越大吸得越多） */
export const QI_ABSORB = 0.25;

/** 单次最多抽走脚下格子浓度的这个比例，防止一个修士路过把泉眼抽干 */
export const QI_TAKE_CAP = 0.5;

/** 低于这个浓度，修士开始把灵力漏回环境 */
export const QI_LEAK_THRESHOLD = 20;

/** 0 期修士站在 0 浓度格上，每回合最多漏这么多 */
export const QI_LEAK_MAX = 10;

/** 漏出去的灵力有一半真的回到格子里，另一半算散了 */
export const QI_LEAK_BACK = 0.5;

/** 境界每高一层，"往环境漏"这件事就少一成。9 期基本不漏 */
export const QI_LEAK_RANK_SHIELD = 10;

/**
 * 地形源汇（每回合注入多少）。
 *
 * 数值是设计者定的：自然源很弱（森林/水 5、高山 10），人工源才像样
 * （灵田 15、灵泉 20）。灵矿是**负的**——"吸天地灵气凝结成灵石"。
 */
export const QI_TERRAIN_SOURCE: Partial<Record<Terrain, number>> = {
  mountain: 10,
  forest: 5,
  water: 5,
  shallow: 5,
  deep: 5,
  // 桥下面还是那条河，灵气不会因为铺了木板就断掉
  bridge: 5,
};

/** 建筑源汇。负数是汇 */
export const QI_BUILDING_SOURCE: Record<string, number> = {
  [UNIT_IDS.SPIRIT_FIELD]: 15,
  [UNIT_IDS.SPIRIT_SPRING]: 20,
  [UNIT_IDS.SPIRIT_MINE]: -5,
};

/**
 * 地形缺省浓度 = 一个孤立源格的平衡浓度 `S / k`。
 *
 * 为什么要有它：不设的话开局全图是 0，要二十多回合才靠扩散涨到平衡，
 * 开局那段"修士站在森林里一点灵气都吸不到"的体验是坏的。
 * 设成平衡值等于**地图一生成就是稳定态**，玩家不用等。
 *
 * 它不是"持续注入"：一旦格子里写入了实际值（扩散第一回合就会写），
 * 这份缺省就再也不参与计算。
 */
export const QI_TERRAIN_BASE: Partial<Record<Terrain, number>> = {
  mountain: 100,
  forest: 50,
  water: 50,
  shallow: 50,
  deep: 50,
  bridge: 50,
};

// ── 读写 ──────────────────────────────────────────

function clampQi(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(QI_MAX, v));
}

/** 存档里保留两位小数：够用，又不至于把整张图写成 62.3847293 那种 */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 这一格现在有多少灵气。
 *
 * 没有落库值时按地形取缺省（见 `QI_TERRAIN_BASE`）——这就是老存档
 * 不需要迁移的原因，也是"地图一生成就是稳定态"的实现方式。
 */
export function qiOfTile(tile: Tile | undefined): number {
  if (!tile) return 0;
  const v = tile.custom?.qi;
  if (typeof v === 'number' && Number.isFinite(v)) return clampQi(v);
  return QI_TERRAIN_BASE[tile.terrain] ?? 0;
}

export function qiAt(s: GameState, x: number, y: number): number {
  return qiOfTile(s.tiles[idx(s, x, y)]);
}

function writeQi(tile: Tile, v: number): void {
  tile.custom = { ...(tile.custom ?? {}), qi: round2(clampQi(v)) };
}

// ── 源汇 ──────────────────────────────────────────

/** 这一格的建筑源汇表：格子索引 → 每回合注入量（负数 = 汇） */
function buildingSources(s: GameState): Map<number, number> {
  const out = new Map<number, number>();
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    // 工地还没成形，不该开始吐纳
    if (underConstruction(u)) continue;
    const d = QI_BUILDING_SOURCE[u.type];
    if (!d) continue;
    const i = idx(s, u.x, u.y);
    out.set(i, (out.get(i) ?? 0) + d);
  }
  return out;
}

/**
 * 这一格的源汇说明，给面板用（`高山 +10 · 灵矿 −5`）。
 * 没有源汇就返回空串。
 *
 * 只在"选中一格"时调用，所以里面现扫一遍 `s.units` 是可以的；
 * 别把这个函数放进逐格循环——那个位置请用 `stepQiField` 里的预建表。
 */
export function qiSourceLabel(s: GameState, x: number, y: number): string {
  const tile = s.tiles[idx(s, x, y)];
  if (!tile) return '';
  const parts: string[] = [];
  // 用数学减号（−）而不是连字符：源是 +、汇是 −，并排时数字才对得齐
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;
  const terrainSrc = QI_TERRAIN_SOURCE[tile.terrain] ?? 0;
  if (terrainSrc) {
    const name = CONFIG.terrainName[tile.terrain] ?? tile.terrain;
    parts.push(`${name} ${signed(terrainSrc)}`);
  }
  for (const u of s.units) {
    if (u.hp <= 0 || underConstruction(u)) continue;
    if (u.x !== x || u.y !== y) continue;
    const d = QI_BUILDING_SOURCE[u.type];
    if (!d) continue;
    parts.push(`${s.unitTypes[u.type]?.name ?? u.type} ${signed(d)}`);
  }
  return parts.join(' · ');
}

// ── 场演化 ────────────────────────────────────────

/**
 * 跑一步：源注入 → 扩散 → 损耗 → 截断。
 *
 * 调用方在**每个玩家回合开始**调用一次（一轮跑两次，相当于时间在流动）。
 * 注意它改的是 `s` 本身——上层传进来的已经是可写的那一份（回放/联机都靠
 * `applyAction` 的克隆），别在外面再包一层克隆。
 */
export function stepQiField(s: GameState): void {
  const w = s.w;
  const h = s.h;
  if (w <= 0 || h <= 0) return;
  const n = w * h;
  if (s.tiles.length < n) return;

  // 0) 快照：后面所有计算都基于这一刻的值
  const q = new Float64Array(n);
  for (let i = 0; i < n; i++) q[i] = qiOfTile(s.tiles[i]);

  // 1) 源 / 汇
  const built = buildingSources(s);
  for (let i = 0; i < n; i++) {
    const tile = s.tiles[i];
    if (!tile) continue;
    const src = (QI_TERRAIN_SOURCE[tile.terrain] ?? 0) + (built.get(i) ?? 0);
    if (src) q[i] = clampQi(q[i] + src);
  }

  // 2~4) 扩散 + 损耗 + 截断，写进新表（双重缓冲）
  const next = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const self = q[i];
      // 只对界内邻居求和 = 零通量边界：边缘不失血，也不会凭空多出来
      let flux = 0;
      if (x > 0) flux += q[i - 1] - self;
      if (x < w - 1) flux += q[i + 1] - self;
      if (y > 0) flux += q[i - w] - self;
      if (y < h - 1) flux += q[i + w] - self;
      next[i] = clampQi((self + QI_DIFFUSE * flux) * (1 - QI_DECAY));
    }
  }

  for (let i = 0; i < n; i++) {
    const tile = s.tiles[i];
    if (tile) writeQi(tile, next[i]);
  }
}

// ── 个体交换 ──────────────────────────────────────

export interface ManaExchange {
  /** 正数 = 从环境吸到这么多；负数 = 漏给环境这么多；0 = 没动 */
  delta: number;
  /** 交换之后脚下格子的浓度 */
  tile: number;
}

/**
 * 一个修士和脚下这一格做一次交换。
 *
 * 两条路，互斥：
 *   · **灵力没满** → 吸。缺口越大吸得越多（`缺口 × QI_ABSORB`），
 *     但一次最多抽走格子的一半，也不能超过缺口。
 *   · **灵力是满的，而脚下很贫瘠** → 漏。境界越高漏得越少
 *     （`1 − 境界/10`），9 期基本不漏。
 *
 * 为什么不用"灵力满也继续吸、吸到上限为止"的写法：那会让修士变成
 * 无底的灵气黑洞，站在森林里把周围抽干——他明明不需要。
 */
export function exchangeMana(s: GameState, u: Unit): ManaExchange {
  const tile = s.tiles[idx(s, u.x, u.y)];
  if (!tile) return { delta: 0, tile: 0 };

  let q = qiOfTile(tile);
  const cur = manaOf(u);
  const max = maxManaOf(u);
  let delta = 0;

  if (cur < max) {
    const deficit = max - cur;
    const want = Math.ceil(deficit * QI_ABSORB);
    const take = Math.min(want, Math.floor(q * QI_TAKE_CAP), deficit);
    if (take > 0) {
      setMana(u, cur + take);
      q -= take;
      delta = take;
    }
  } else if (q < QI_LEAK_THRESHOLD && cur > 0) {
    const shield = Math.max(0, 1 - getRank(u) / QI_LEAK_RANK_SHIELD);
    const leak = Math.ceil(((QI_LEAK_THRESHOLD - q) / QI_LEAK_THRESHOLD) * QI_LEAK_MAX * shield);
    const real = Math.min(leak, cur);
    if (real > 0) {
      setMana(u, cur - real);
      q += real * QI_LEAK_BACK;
      delta = -real;
    }
  }

  if (delta !== 0) writeQi(tile, q);
  return { delta, tile: clampQi(q) };
}

/**
 * 只看不动：这个修士**如果**现在结算，会吸到 / 漏掉多少。
 *
 * 面板要写"每回合从环境吸 8"，但面板不能改状态。所以和 `exchangeMana`
 * 保持同一套式子，只是不落库。两处一旦不一致，玩家就会看到"写着 +8，
 * 实际没涨"——所以这个函数是拿 `exchangeMana` 的同一组常量写的。
 */
export function previewExchange(s: GameState, u: Unit): ManaExchange {
  const tile = s.tiles[idx(s, u.x, u.y)];
  if (!tile) return { delta: 0, tile: 0 };
  const q = qiOfTile(tile);
  const cur = manaOf(u);
  const max = maxManaOf(u);
  if (cur < max) {
    const deficit = max - cur;
    const want = Math.ceil(deficit * QI_ABSORB);
    const take = Math.min(want, Math.floor(q * QI_TAKE_CAP), deficit);
    return { delta: take, tile: clampQi(q - take) };
  }
  if (q < QI_LEAK_THRESHOLD && cur > 0) {
    const shield = Math.max(0, 1 - getRank(u) / QI_LEAK_RANK_SHIELD);
    const leak = Math.ceil(((QI_LEAK_THRESHOLD - q) / QI_LEAK_THRESHOLD) * QI_LEAK_MAX * shield);
    const real = Math.min(leak, cur);
    return { delta: -real, tile: clampQi(q + real * QI_LEAK_BACK) };
  }
  return { delta: 0, tile: q };
}

// ── 棋盘视图 ──────────────────────────────────────

/** 浓度分几档。离散分档比连续渐变好读——玩家要答的是"这格浓不浓" */
export const QI_VIEW_TIERS = 5;

/**
 * 五档的颜色：**同一支绿、逐级加浓**。
 *
 * 第 0 档也给一层极淡的底色、不跳过：跳过的话"稀"和"没有数据"看起来
 * 一模一样，玩家会以为那片格子没算进视图。
 */
const QI_VIEW_COLORS: readonly string[] = [
  'rgba(64, 160, 120, 0.07)',
  'rgba(64, 160, 120, 0.16)',
  'rgba(64, 160, 120, 0.28)',
  'rgba(52, 150, 110, 0.42)',
  'rgba(40, 140, 100, 0.58)',
];

/** 这一格属于第几档（0 ~ 4） */
export function qiTierOf(q: number): number {
  const t = Math.floor((clampQi(q) / QI_MAX) * QI_VIEW_TIERS);
  return Math.max(0, Math.min(QI_VIEW_TIERS - 1, t));
}

/**
 * 灵气视图：整张图的染色。
 *
 * **全图，不按视野裁**。灵气是"天地之气"，不是谁藏起来的底牌——
 * 和丹药刚好相反（那个要 `redactUnit` 抹掉）。这两件事别混：
 * 环境是公开的，底牌才是秘密。
 *
 * 每格都返回，包括浓度接近 0 的：视图要回答"整张图的分布"，
 * 空白格本身也是信息（"这一带是死地"）。
 */
export function qiOverlayCells(
  s: GameState,
): Array<{ x: number; y: number; color: string }> {
  const out: Array<{ x: number; y: number; color: string }> = [];
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      out.push({ x, y, color: QI_VIEW_COLORS[qiTierOf(qiAt(s, x, y))]! });
    }
  }
  return out;
}

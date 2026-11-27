/**
 * **需求表**（批 1，2026-11-27）：让位要回答的那张表。
 *
 * ── 它替掉的是什么 ────────────────────────────────────────────
 *
 * 以前只有一张 `keepClear`（"必须空出来的格子"）：一张**几何常数**名单，城格永远在上面、
 * 城的外一圈永远在上面、桥头永远在上面。于是"要不要让"这个问题被答成了
 * "你站在那张名单上吗"——**格的事，站上去就有罪**。
 *
 * 需求表把它换成**两个人的事**：一格之所以要空，是因为**这一手有人要它**。
 * 每条需求带着"谁要（`by`）、要几格（`want`）、多急（`rank`）"。
 *
 * ── 批 1 只搬位置，不改行为 ──────────────────────────────────
 *
 * 这一批的唯一目标是**语义等价**：`keepClear` 从"手写几何循环"变成"需求表的并集"，
 * 但产出的格子、顺序、数量都必须和改之前一模一样（39 题逐字节一致，让位探针读数不变）。
 *
 * 所以现在：
 *   · `want` 一律 = `cells.length`（等于旧的"整圈都要空"）；
 *   · `mode` 一律 = `'keepEmpty'`（`'holdHere'` 是批 3 的守军站位，这里先不产生）；
 *   · `rank` 只是**标注**，还没有人读它（批 3 的座位分配才读）。
 *
 * 只有数量不变，后面的批 2（引入名额）、批 3（座位分配）才有资格说"变的只是判断"。
 *
 * ── 顺着这张表能看见的三个毛病（都已在 §4.22 记下）──────────────
 *
 *   ① `exit` 那条**没有"谁要"**：它的触发是一个全局布尔（"任何一队要出门"），
 *      不是"某个人这一手要经过这一格"。所以前线在十格以外走，后方城门也清；
 *   ② `want` 现在是"全部"，而真实需求是"留出够用的几格"（产兵只要留 1~2 格）；
 *   ③ 守军站位根本没有登记——守军站在自己的岗位上，在表里却是"没有任何人要"，
 *      于是它成了唯一可以被赶走的人。
 *
 * 三条都在批 2 / 批 3 修，不在这里。
 */

import { passable } from '../config.ts';
import type { City, GameState } from '../types.ts';

/** 需求有多硬：硬（不腾出功能就废）> 停驻（站那儿就是它的任务）> 路过（只是途经） */
export type NeedRank = 'hard' | 'post' | 'pass';

export type NeedKind =
  /** 产兵口：城格（挨打时不进表，见下） */
  | 'spawn'
  /** 出门通道：城的外一圈 */
  | 'exit'
  /** 过河的唯一通道：桥头（邻格 ≥2 片水） */
  | 'cross'
  /** 守军站位（批 3 才产生） */
  | 'post'
  /** 经济岗位（批 3 才产生） */
  | 'econ';

export interface Need {
  /** 谁要用：`spawn:c1` / `exit:c1` / `cross`。归因和回放读它 */
  by: string;
  /**
   * 归组：同一组的格在拼 `keepClear` 时**一起按格号升序**。
   *
   * 为什么要这个字段：旧的构造是"每座城里按行主序遍历一圈"，城格和外圈是**交错**push 的
   * （同一行里先外圈、再城格、再外圈）。拆成两条需求之后必须按格号合并才能复现那个顺序。
   * `keepClear` 的顺序会决定让位链的先后（`planYield` 按顺序占用 `usedCells`），
   * 所以批 1 不能让它变——这是"语义等价"的一部分，不是洁癖。
   */
  group: string;
  kind: NeedKind;
  /** `keepEmpty` = 要空出来；`holdHere` = 要占住（批 3） */
  mode: 'keepEmpty' | 'holdHere';
  /** 这一手要几格。批 1 全部 = `cells.length`（= 旧的"整圈都空"） */
  want: number;
  rank: NeedRank;
  /** 涉及的格（下标，升序） */
  cells: number[];
}

/**
 * **几何需求**：不依赖编队就能算出来的那几类（产兵口 / 出门通道 / 桥头）。
 *
 * 另一半是"路径需求"（某支队的下一步落点），它要等编队算完才知道，
 * 由计划层在 `constrain` 里补（批 3）。这个切法是**为了断开循环依赖**：
 * 编队要读需求（不许把人排到"要空"的格上），而路径需求要读编队。
 *
 * `cities` 传的是 world 已经算好的那一份（带 `foeEta`，敌人最快几手能摸到这座城），
 * 不在这里重算威胁——那会变成第二个答案。
 */
export function geometricNeeds(
  s: GameState,
  cities: ReadonlyArray<{ city: City; foeEta: number }>,
): Need[] {
  const out: Need[] = [];

  for (const info of cities) {
    const city = info.city;
    const n = city.size ?? 2;
    /** 城格（产兵口） */
    const inner: number[] = [];
    /** 城的外一圈（出城通道） */
    const ring: number[] = [];
    /*
     * **城格 + 外一圈都保**（2026-11-24 试过只保城格，回退了）。
     *
     * 试的理由：产兵口就是城格本身，外圈挡住的是城边的好地形（S-015 那 2 格森林正好贴着城）。
     * 回退的理由：**外圈是军队出城的通道**——只保城格之后 S-001（必赢题）从"胜"变成"未分胜负"，
     * 兵挤在城墙外，主力出不来。
     *
     * 结论：城边的高产地在这个口径下吃不到。要吃得改地图（把高产地形挪出外圈），
     * 不是改这张表。
     *
     * **城格为什么单独一条**（2026-11-24 修正）：兵站在城里，产兵口就被堵住，
     * `recruitSpawnCells` 直接返回 0（S-009：守军退回城下之后金 190 一分都花不出去）。
     *
     * **例外只有一个**：挨打的时候（`foeEta <= 1`，敌人下一手就能摸到城），城格是可以站的——
     * 地形防御表 `city = +3 护甲`，守军站进城里比站在平原上多 3 点。而 v4 原来把城格和外圈
     * 一律算成"必须空"，于是守军永远站在平原上挨打（实测 D-1-01：v1 站 2 个进城里、城血 18；
     * v4 一个都不进、城血 11）。
     *
     * 为什么只在 `foeEta <= 1` 时放开：这是**同一个数**（威胁场）的第三个读者，
     * 不另起一个"我在防守"的判断。不在威胁下的城仍然按"产兵口"处理——那时候挡住产兵口
     * 是真的会造不出兵。
     */
    for (let dy = -1; dy <= n; dy++) {
      for (let dx = -1; dx <= n; dx++) {
        const inside = dx >= 0 && dy >= 0 && dx < n && dy < n;
        if (inside && info.foeEta <= 1) continue;
        const x = city.x + dx;
        const y = city.y + dy;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const t = s.tiles[y * s.w + x]?.terrain;
        if (!t || !passable(t)) continue;
        (inside ? inner : ring).push(y * s.w + x);
      }
    }

    /*
     * 两条需求的 `group` 相同：拼回 `keepClear` 时按格号合并，
     * 复现"每座城按行主序走一圈"的旧顺序（见 `keepClearOf`）。
     */
    out.push({
      by: `spawn:${city.id}`,
      group: city.id,
      kind: 'spawn',
      mode: 'keepEmpty',
      want: inner.length,
      rank: 'hard',
      cells: inner,
    });
    out.push({
      by: `exit:${city.id}`,
      group: city.id,
      kind: 'exit',
      mode: 'keepEmpty',
      want: ring.length,
      rank: 'pass',
      cells: ring,
    });
  }

  /*
   * **桥头**：邻格有 ≥2 片水的桥面格 = 过河的唯一通道，停在那儿就是把全军的门堵死（S-005）。
   *
   * 注意这里**不查边界**（`(y+dy)*s.w+(x+dx)` 在地图边上会绕到邻行）。这是旧代码的原样，
   * 批 1 不改行为；要修是另一件事（会改判据，得单独立题）。
   */
  const bridges: number[] = [];
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.tiles[y * s.w + x]?.terrain !== 'bridge') continue;
      let water = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const t = s.tiles[(y + dy) * s.w + (x + dx)]?.terrain;
        if (t === 'water' || t === 'deep') water += 1;
      }
      if (water >= 2) bridges.push(y * s.w + x);
    }
  }
  if (bridges.length > 0) {
    out.push({
      by: 'cross',
      group: 'cross',
      kind: 'cross',
      mode: 'keepEmpty',
      want: bridges.length,
      rank: 'hard',
      cells: bridges,
    });
  }

  return out;
}

/**
 * 把需求表拼成 `keepClear`（"必须空"的格子，按旧顺序）。
 *
 * 按 `group` 的**首次出现顺序**输出，组内按格号升序。两个细节都是为了和旧构造逐字节一致：
 *   · 旧构造里，一座城的城格和外圈是**交错** push 的（同一行里 外圈→城格→外圈）；
 *     按格号升序合并，正好等于那个顺序；
 *   · 桥头在旧构造里排在所有城之后，这里靠"最后才 push 那条需求"保住。
 *
 * `want` 还没有被读（批 1 全是"全部"）；批 2 会按名额裁，那时这个函数要跟着改。
 */
export function keepClearOf(needs: readonly Need[]): number[] {
  const byGroup = new Map<string, number[]>();
  for (const n of needs) {
    if (n.mode !== 'keepEmpty') continue;
    const arr = byGroup.get(n.group) ?? [];
    arr.push(...n.cells);
    byGroup.set(n.group, arr);
  }
  const out: number[] = [];
  for (const arr of byGroup.values()) {
    arr.sort((a, b) => a - b);
    out.push(...arr);
  }
  return out;
}

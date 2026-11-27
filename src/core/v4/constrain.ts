/**
 * **约束层**：把"要做什么"翻译成"哪几格必须空、哪几个兵归哪队、去打哪座城"。
 *
 * ── 这一层为什么在打分层之前 ────────────────────────────────
 *
 * 直觉是"打分层才是现成资产，先做它"。但 v3 的每一次翻车都在**分数表达不了的约束**上：
 * 桥头要让开、产兵格要让开、城门口要让开——这些"必须"被塞进分数里，于是
 * "让开"和"别送死"互相打折，最后谁也不让。
 *
 * 所以 v4 先把这个工具做对：**必须做的事不参与打分**。
 */
import { EARTH, boardIdOf, boardOf, tileOn } from '../board.ts';
import { passable } from '../config.ts';
import { attackableTargets, cityTiles, effectiveStats, previewAttack, produceAt, reachableTiles, rebuildCost, recruitCost, recruitSpawnCells, threatTiles } from '../rules.ts';
import { occupantAt, utype } from '../rules.ts';
import { eraDef } from '../config.ts';
import { upgradeTargetOf } from '../era-routes.ts';
import type { City } from '../types.ts';
import type { GameState, Unit } from '../types.ts';
import { DECIDE_HORIZON } from './decide.ts';
import { bestEraBy, bestProjection, incomeNow, projectEconUntil, projectWithEra, solveEconAll, unitWorth, unitWorthOfType } from './project.ts';
import type { EraTable } from './project.ts';
import type { Band, Constraints, Decision, Squad, SquadTactics, V4Memory } from './types.ts';
import { CITY_POST } from './needs.ts';
import { buildWorld, upgradedCity } from './world.ts';
import type { World } from './world.ts';

/**
 * **所有距离用曼哈顿距离**（`|dx| + |dy|`）：游戏里移动是四邻，斜着走一步要花两步，
 * 所以斜向的格子不能算"更近"。
 *
 * 判"要走几步"时不要用这个——那是距离场的事（`world.stepsFrom`，绕水绕山）。
 * 这里只用于"粗比远近"和"半径内有没有人"。
 */
const manhattan = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * 本回合的集火点：**一张尺子，只算一次**。
 *
 * 候选 = 全队能打到的敌方单位（引擎的 `attackableTargets`，含射程/高度/视野）。
 * 排序只有一条：**这一手能不能打死它**——
 *   · 能打死的里面挑血最少的（打死了就少一个输出源，而且下回合不用再挨）；
 *   · 都打不死就挑"总伤害 / 血量"最高的（下回合最可能收掉）。
 *
 * 不做"威胁权重""价值系数"那种东西：那正是 v3 那张必须调参的表。
 */
function planTactics(s: GameState, ids: string[], canMove: boolean): SquadTactics | undefined {
  /*
   * **战术模式**（2026-11-25）：只有"这一手有一个值得全队一起办的目标"才打开。
   *
   * 打开之后打分层才被允许做两件事：全队打同一个（`focusId`）、为它挪一步（`converge`）。
   * 关着 = 行为与没有这个开关时一字不差（照约束执行、打射程内的）。
   * 这就是"不退回 v1/v3 那种任何时候都在打分"的那道闸。
   *
   * `canMove` 决定"走一步再打"算不算进伤害：进攻队算，守队不算（它不许离开城）。
   */
  const mine = ids
    .map((id) => s.units.find((u) => u.id === id))
    .filter((u): u is Unit => !!u && u.owner === s.current && (effectiveStats(s, u).atk ?? 0) > 0);
  if (mine.length < 2) return undefined;

  /** 每个兵这一手的两笔账：能打到的敌人（含走一步）、以及现在就能不能打到人 */
  const perUnit = mine.map((u) => {
    const spots: Unit[] = [u];
    if (canMove) {
      for (const [k] of reachableTiles(s, u)) {
        if (k === u.y * s.w + u.x) continue;
        spots.push({ ...u, x: k % s.w, y: Math.floor(k / s.w), moved: true } as Unit);
      }
    }
    /* 同一个敌人，这个兵最多能打出多少（多格取最大，不累加） */
    const hits = new Map<string, number>();
    for (const from of spots) {
      for (const foe of attackableTargets(s, from)) {
        if (foe.owner === u.owner) continue;
        const dmg = previewAttack(s, from, foe).toDefender;
        if (dmg <= 0) continue;
        hits.set(foe.id, Math.max(hits.get(foe.id) ?? 0, dmg));
      }
    }
    /* 原地能打到谁（不只是能打多少）——"这个兵这一手有没有别的仗打" */
    const nowFoes = new Map<string, number>();
    for (const foe of attackableTargets(s, u)) {
      if (foe.owner === u.owner) continue;
      const dmg = previewAttack(s, u, foe).toDefender;
      if (dmg > 0) nowFoes.set(foe.id, dmg);
    }
    return { id: u.id, hits, nowFoes };
  });

  /*
   * 汇总成"每个敌人"的账：
   *   `n`      —— 有几个兵够得着它（含走一步）
   *   `dmg`    —— 这些人合计能打多少
   *   `dmgNow` —— **原地不动**就能打多少
   *   `dmgIdle`—— 只算"这一手本来就没仗可打"的兵能补多少（见 `converge`）
   */
  const reach = new Map<string, { n: number; dmg: number; dmgNow: number; dmgIdle: number; dmgIdleMax: number; hp: number }>();
  for (const p of perUnit) {
    const idle = p.nowFoes.size === 0;
    for (const [fid, dmg] of p.hits) {
      const foe = s.units.find((x) => x.id === fid);
      if (!foe) continue;
      const rec = reach.get(fid) ?? { n: 0, dmg: 0, dmgNow: 0, dmgIdle: 0, dmgIdleMax: 0, hp: foe.hp };
      rec.n += 1;
      rec.dmg += dmg;
      rec.dmgNow += p.nowFoes.get(fid) ?? 0;
      if (idle) {
        rec.dmgIdle += dmg;
        rec.dmgIdleMax = Math.max(rec.dmgIdleMax, dmg);
      }
      reach.set(fid, rec);
    }
  }

  /* 至少两个兵能打到同一个，才谈得上"合打" */
  const rows = [...reach.entries()].filter(([, r]) => r.n >= 2);
  if (rows.length === 0) return undefined;

  /* ① 这一手能收掉的 → 挑血最少的（省手）；② 否则挑"伤害/血量"最高的 */
  const killable = rows.filter(([, r]) => r.dmg >= r.hp);
  const pick = killable.length > 0
    ? killable.sort((a, b) => a[1].hp - b[1].hp)[0]!
    : [...rows].sort((a, b) => b[1].dmg / b[1].hp - a[1].dmg / a[1].hp)[0]!;

  /*
   * 门槛：打不死、又打不掉一半的，**别为它改变动作**。
   * 没有这一条，只要场上有人就永远"有战术模式"，等于开关常开。
   */
  if (pick[1].dmg < pick[1].hp * 0.5) return undefined;

  /*
   * **要不要为这个目标挪一步**（2026-11-25，第 4 步）。两条同时成立才开：
   *
   * ① **已经在打它了，但原地打不死**（`0 < dmgNow < hp`）；
   * ② **再补一个闲人那一下就收**（`dmgNow + dmgIdleMax ≥ hp`，只算"本来没仗可打"的兵，
   *    而且只算**一个人**的量）。
   *
   * ② 的"一个人"很关键：写成"闲着的都算"会变成"从零开始集火"——
   * S-017 第 1 手就是这样：没人够得着那个目标（`dmgNow = 0`）、七个闲人合计 73 够
   * 24 血，于是全军被拽过去，清场反而慢了一手。
   *
   * ② 是 S-017 逼出来的。只写①的时候它从绿变红（6 手清场 4 → 3）：那一局里"补一刀"的兵
   * 手上明明还有别的守军可打，把它拽过来等于让另一个敌人多活一轮。
   * 清场要的是散开、一人盯一个；只有**闲着的人**去补刀才不亏。
   *
   * 判据放在约束层、和 `focusId` 同一个开关里，打分层只执行不判断——
   * 和"是否集火"一个道理：条件不满足就不开，不在执行层加例外。
   */
  const converge =
    canMove &&
    pick[1].dmgNow > 0 &&
    pick[1].dmgNow < pick[1].hp &&
    pick[1].dmgNow + pick[1].dmgIdleMax >= pick[1].hp;

  return {
    focusId: pick[0],
    converge,
    why: converge
      ? `补一刀就收：原地 ${Math.round(pick[1].dmgNow)} + 一个闲人 ${Math.round(pick[1].dmgIdleMax)} ≥ 它 ${Math.round(pick[1].hp)} 血`
      : `${pick[1].n} 个兵能打到 ${pick[0]}：合计 ${Math.round(pick[1].dmg)} / 它 ${Math.round(pick[1].hp)} 血${canMove ? '' : '（守队不挪位）'}`,
  };
}

export { unitWorth };

/** 集结点：自家城朝敌方向外挪两格，取一个能站人的空点 */
function assemblePoint(s: GameState, world: World, cityId: string): { x: number; y: number } | undefined {
  const city = s.cities.find((c) => c.id === cityId);
  if (!city) return undefined;
  const foe = world.foeCities[0];
  const dx = foe ? Math.sign(foe.x - city.x) : 1;
  const dy = foe ? Math.sign(foe.y - city.y) : 0;
  const cand = [
    { x: city.x + dx * 2, y: city.y + dy * 2 },
    { x: city.x + dx * 3, y: city.y },
    { x: city.x, y: city.y + dy * 3 },
  ];
  for (const p of cand) {
    if (p.x < 0 || p.y < 0 || p.x >= s.w || p.y >= s.h) continue;
    if (s.units.some((u) => u.x === p.x && u.y === p.y)) continue;
    return p;
  }
  return undefined;
}

/**
 * **产兵名额**（批 2，2026-11-27）：挨打时城格不再"整块豁免"，而是"留够这一手要用的那几格"。
 *
 * ── 它替掉的是什么 ────────────────────────────────────────────
 *
 * 原来挨打时（`foeEta <= 1`）城格**整块**从"必须空"里消失（守军要吃 +3 护甲，这没错），
 * 然后在 `planYield` 里有一条补丁：**城格站满 + 里面有非战斗单位 → 把那格加进赶人名单**。
 *
 * 那条补丁有三个毛病（批 0 的账里都能看见）：
 *   ① 只在"站满"时才动手——3 格占着、手上有 238 金，照样一格都腾不出来；
 *   ② 只赶**非战斗**单位——守军把城格站满时就彻底造不出兵；
 *   ③ 名额写死是 1 格，和"这一手要造几个"没有关系。
 *
 * 现在换成一句：**留够这一手真能造的兵数**，其余城格随便站。
 *
 * ── 名额从哪来（两个都是现成的数，不许新拍）────────────────────
 *
 *   · **守军名额** `CITY_POST`：城格一共 n×n 格，先扣掉守军那几格（他们拿护甲换的）；
 *   · **产兵名额** = `min(剩几格, 这一手买得起几个)`；买得起几个 = `floor(金币 ÷ 最便宜单价)`，
 *     单价取战斗兵和经济兵里更便宜的那个（这一手造哪种都算腾地方）。
 *
 * 三条闸把"不该腾"挡在外面：
 *   ① 没挨打（`foeEta > 1`）→ 城格本来全在表里，不用补；
 *   ② 这一手是**攒钱模式**（`spend.mode === 'save'`）→ 一个兵都不造，腾了也是白腾；
 *   ③ 买不起（名额 0）→ 不腾（这就是"有钱才清产兵口"，和 `need.spawn` 同一个意思）。
 *
 * ── 挑哪几格（只影响"赶谁"，不影响"腾几格"）───────────────────
 *
 * 空的先挑（不用赶人）→ 非战斗单位（不靠护甲活）→ 战斗兵（最后才动，那一格是他们拿护甲换的）。
 * 同类按格号，保证同一个局面每次挑同几格（不许有随机）。
 */
function applySpawnQuota(
  s: GameState,
  world: World,
  decision: Decision,
  keepClear: number[],
  keepSet: Set<number>,
): NonNullable<Constraints['spawnQuota']> {
  const out: NonNullable<Constraints['spawnQuota']> = [];
  /* ② 攒钱模式：这一手不造兵，腾产兵口是白腾 */
  if (decision.spend?.mode === 'save') return out;
  const gold = s.players[world.me]?.gold ?? 0;

  /*
   * **这一手买得起几个 = 名额的上限**。单价取战斗兵和经济兵里更便宜的那个
   * （这一手造哪种兵都要腾地方），都是现成的数，没有新系数。
   *
   * ── 为什么不"固定留 2 格"（2026-11-27 实测否掉的版本）──────────
   *
   * 试过不看钱、按"城格数 − 守军名额"直接留 2 格。6 颗种子的对照（对手 = 冻结基线，
   * 12×12·3 代）里 seed 902 从"41 手抢下 3 城"变成"64 手丢两城"：
   * 挨打时把守军赶出城去腾产兵口，而**那一手根本没造兵**，白少了两个 +3 护甲的位置。
   *
   * 所以名额只回答一件事：**这一手真会造出几个兵**。买不起就一格都不腾——
   * 这和 `need.spawn`（"有钱才谈得上腾产兵口"）是同一个意思，不是新判断。
   */
  const prices: number[] = [];
  for (const info of world.cities) {
    for (const o of world.affordableCombat(info.city, gold)) prices.push(o.gold);
  }
  const econPrices = world.econSpots().map((p) => p.gold).filter((g) => g > 0 && g <= gold);
  if (econPrices.length > 0) prices.push(Math.min(...econPrices));
  const cheapest = prices.length > 0 ? Math.min(...prices) : 0;
  const afford = cheapest > 0 ? Math.floor(gold / cheapest) : 0;
  if (afford <= 0) return out;

  for (const info of world.cities) {
    /* ① 没挨打 → 城格本来就在表里（产兵口是全清的），不用补 */
    if (info.foeEta > 1) continue;
    const cells = cityTiles(info.city).map((t) => t.y * s.w + t.x);
    /*
     * **名额 = 1 格，不是"这一手买得起几个"**（2026-11-27 实测定的）。
     *
     * 试过留 2 格（城格 4 − 守军 2）。6 颗种子对照：seed 902 从"41 手抢下 3 城"
     * 翻成"64 手丢两城"，而且那 15 手里**只有 1 次赶人**——亏的不是赶人，是"预留"：
     * 那两格一直不许站，等于让两个守军丢掉 +3 护甲，换来的只是多造 4 个兵。
     *
     * 所以挨打时的真需求只有一条：**补兵这条路不能断**。那是个布尔，就是个 1 格。
     * 写"买得起几个"是把采购的账搬到这儿再算一遍——同一件事两个答案，必然打架。
     */
    const want = Math.min(1, Math.max(0, cells.length - CITY_POST), afford);
    if (want <= 0) continue;

    /* 挑 want 格：空 → 非战斗 → 战斗；同类按格号 */
    const rankOf = (k: number): number => {
      const u = occupantAt(s, k % s.w, Math.floor(k / s.w));
      if (!u || u.owner !== world.me) return u ? 3 : 0;
      return utype(s, u.type).category === 'combat' ? 2 : 1;
    };
    const pick = [...cells]
      .filter((k) => !keepSet.has(k))
      .sort((a, b) => rankOf(a) - rankOf(b) || a - b)
      .slice(0, want);
    if (pick.length === 0) continue;
    const freed: number[] = [];
    for (const k of pick) {
      keepClear.push(k);
      keepSet.add(k);
      const u = occupantAt(s, k % s.w, Math.floor(k / s.w));
      if (u && u.owner === world.me) freed.push(k);
    }
    out.push({ cityId: info.city.id, want, cells: pick, evict: freed });
  }
  return out;
}

/**
 * 让位搬迁计划（多源 BFS）——**思路抄 v3 的 `buildYieldPlan`，代码不抄**。
 *
 * 种子是**所有空格**（能站人的、非城格）。从它们向外扩，穿过自己人算一步
 * （那个人得先让开），敌人和不可通行直接挡死。于是每格都知道了"离最近的洞几步"。
 *
 * 然后对每个被占的关键格：沿 `prev` 倒着走到洞，这条链上的人各朝洞挪一格。
 * 好处是**一回合能清多格**——一个人挪开、后面的人依次递补，而不是一回合只挪一个。
 *
 * v3 那份还带着"谁更急"的分数（urgency）；这里不需要：关键格就是必须空，
 * 不存在"先让哪一格"的问题——链式搬迁天然按距离排好了。
 */
function planYield(
  s: GameState,
  world: World,
  keepClear: number[],
  squads: Squad[],
  need: { spawn: boolean; exit: boolean },
  /**
   * 额外的"正在动、不算挡路"名单（临时调令里的兵）。
   *
   * 他们这一手有明确的方向（朝主队的目标走），再被这条链推去"最近的空格"
   * 就是两个方向打架：链把它往西、调令把它往东，最后它一步也不走。
   */
  alsoPassing: string[] = [],
): Array<{ unitId: string; x: number; y: number }> {
  /*
   * ════════════════════════════════════════════════════════════════
   * **【距离场 D】多源、从"所有空格"出发，用来"把人从关键格上搬开"。**
   *
   * 它和 world 里那张 C（`flowFrom`）用的是同一套算法（多源 + 前驱指针），
   * 但**种子的定义完全相反**，这是最容易看错的一处：
   *
   *   · C 的种子 = **洞**（该被占的空岗）→ 人顺着 prev 走，就是在"上岗"；
   *   · D 的种子 = **所有空格**（包括根本不该站人的空地）→ 人顺着 prev 走，是在"让开"。
   *
   * 为什么 D 不能复用 C：D 要回答的是"从这一格往哪个方向最近能腾出位置"，
   * 所以起点必须是"空"；C 要回答的是"往哪个方向最近的岗位"。
   * 两个问题的答案经常方向相反，混用会让人往反方向跑。
   *
   * ── 下面分成五段，按顺序读 ──────────────────────────────────
   *
   *   ① 决定这一手要赶哪些格（不是整圈都赶，见下）
   *   ② 播种：把所有空格当成"洞"
   *   ③ 扩散：算出每格"离最近的空位几步"，并记下"下一步往哪走"
   *   ④ 排除"正在执行任务的兵"（过桥/推进的不算挡路）
   *   ⑤ 沿前驱把链上的人依次挪一格
   * ════════════════════════════════════════════════════════════════
   */

  /*
   * ① **只在"这一手真有人要用这格"时才赶人**（用户 2026-11-24 定）。
   *
   * 原来是对 `keepClear` 一刀切：只要站在城圈（城格 + 城墙外一圈）上就赶。
   * 实测两个毛病：
   *   ① 这一手根本不造兵、军队也不出城，赶它纯属白费一步；
   *   ② 被赶的人本来就要往岗位走（方向正好是离开城圈），等于重复下命令，
   *      而且落点是"最近的空格"——大概率在反方向。一步能干两件事，被拆成两步、而且第二步是错的。
   *      实测 S-015：伐木工进森林又被甩出来，再走回去。
   *
   * 判据换成两类需求：
   *   · 产兵口 = **城格**（引擎的产兵落点就是 `cityTiles`，外圈不是）；要造兵时只赶城格上的人。
   *   · 出门通道 = 城圈 + 桥头；有队伍要出去/要过桥时，才赶挡路的。
   */
  const cityCells = new Set<number>();
  for (const c of world.myCities) {
    const n = c.size ?? 2;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cityCells.add((c.y + dy) * s.w + (c.x + dx));
  }
  const targets = keepClear.filter(
    (k) => (need.spawn && cityCells.has(k)) || (need.exit && !cityCells.has(k)),
  );
  /*
   * **"挨打时腾一格"那条补丁已经删了**（批 2，2026-11-27）。
   *
   * 它当时做的是"挨打 + 城格站满 + 里面有非战斗单位 → 赶走那一格"。
   * 现在由 `applySpawnQuota` 统一回答：挨打时按名额留够产兵格（名额 = 这一手买得起几个），
   * 挑格顺序是"空 → 非战斗 → 战斗"。所以这里只剩一句类型筛选，
   * 城格要不要赶人**不在这里判断**——它在建 `keepClear` 的时候就定完了。
   */
  if (targets.length === 0) return [];
  const N = s.w * s.h;

  /*
   * ② 播种：**所有能站的空格**都是种子（距离 0）。
   *    三条排除：
   *      · 城格不算洞（它是"要空出来的地方"，不是"能塞人的地方"）；
   *      · 有人站着的格不算；
   *      · 水/高山不算。
   */
  const seeds: number[] = [];
  for (let k = 0; k < N; k++) {
    const t = s.tiles[k];
    if (!t || t.terrain === 'city') continue;
    if (s.units.some((u) => u.y * s.w + u.x === k)) continue;
    if (!passable(t.terrain)) continue;
    seeds.push(k);
  }

  /*
   * ③ 扩散：交给**世界层那张唯一的距离场**（多源、自己人可穿、只算 6 步、要前驱）。
   *
   *    以前这里是一段内联的 BFS，和 `world.flowFrom` 一个算法抄两份，
   *    只有种子定义不同（这里种子 = 所有空格；那边 = 空岗）。现在合成一次调用，
   *    区别只在"传哪些种子进来"。
   */
  const { dist, prev } = world.field(seeds, { through: 'units', maxDist: 6, prev: true });

  /*
   * ④ 推进/攻城的兵不算挡路：它们有理由待在那儿（正在过桥）。
   * 只让"没事待着"的单位（经济兵、驻守兵）让开——否则过桥的兵会被自己的规则赶回去，
   * 在桥上来回横跳。
   */
  const passing = new Set<string>();
  for (const sq of squads) {
    if (sq.order !== 'march' && sq.order !== 'siege') continue;
    for (const id of sq.unitIds) passing.add(id);
  }
  /* 有临时调令的兵也在动（见 `alsoPassing` 的注释），别再给他们派搬迁落点 */
  for (const id of alsoPassing) passing.add(id);

  /*
   * ⑤ 沿前驱把链上的人依次挪一格。
   *
   *    对每一个"要腾出来的格"：从它出发顺着 prev 一直走到某个空格，得到一条链
   *    `关键格 → … → 空格`。然后**从空格那一头开始**，每个人挪到前一个人的位置。
   *    之所以要从那一头开始，是因为每一次移动都必须落在一个"刚刚被腾出来的格"上
   *    （引擎不允许两个人占同一格，也没有"交换位置"这个动作）。
   *
   *    `usedCells` / `usedUnits` 是**链与链之间**的去重：两条链不能用同一格、
   *    也不能重复派同一个人。**链内部不能用它判**——那样每条链只会走一格，
   *    整列纹丝不动（v3 在这里踩过，注释写在下面）。
   */
  const out: Array<{ unitId: string; x: number; y: number }> = [];
  const usedCells = new Set<number>();
  const usedUnits = new Set<string>();

  for (const cell of targets) {
    /*
     * 关键格自己得是被自己人占着的，否则没什么可让。
     * **桥不算占位者**：桥和兵可以同格（引擎 `blockedAnchor` 对桥返回 false），
     * 把桥当成"要挪开的人"会白派一条永远被拒的 MOVE（W4，2026-11-26）。
     */
    const occupant = occupantAt(s, cell % s.w, Math.floor(cell / s.w));
    const blocker = occupant && occupant.owner === world.me ? occupant : undefined;
    if (!blocker || usedUnits.has(blocker.id) || passing.has(blocker.id)) continue;

    /*
     * 沿 prev 一路走到"最近的空位"，得到一条链：
     *
     *     关键格（被占） → 中间若干格（也可能被占） → 空位（dist = 0）
     *
     * `guard` 只是防死循环的保险（prev 是一棵树，理论上不会绕圈）。
     * 走不到空位（prev = -1，也就是 6 格内没有洞）就放弃：这一手不硬挪，
     * 因为"没有落点"时挪等于让人凭空消失。
     */
    let k = cell;
    const chain: number[] = [];
    let guard = 0;
    while (dist[k]! > 0 && guard++ < 12) {
      k = prev[k]!;
      if (k < 0) break;
      chain.push(k);
    }
    if (chain.length === 0) continue;

    /*
     * **从空位那一头开始倒着派**（`i` 从链尾往链头走）。
     *
     * 链 = [关键格, c1, c2, …, 空位]（空位在最后）。
     *   i = 最后 → `to` = 空位，`from` = 空位前面那格 → 那个人先挪进空位；
     *   i 往前 → 每个人的目标都是"后一个人刚刚腾出来的格"。
     * 所以每一次移动都落在空出来的格上——引擎没有"两个人交换位置"这个动作，
     * 只能靠这个顺序。
     *
     * 顺序反过来的话（从关键格那端先派），第一个人的目标格还被人占着，必被引擎拒，
     * 整条链就白算了。
     */
    for (let i = chain.length - 1; i >= 0; i--) {
      const to = chain[i]!;
      const from = i === 0 ? cell : chain[i - 1]!;
      const nu = occupantAt(s, from % s.w, Math.floor(from / s.w));
      const u = nu && nu.owner === world.me ? nu : undefined;
      if (!u || usedUnits.has(u.id) || usedCells.has(to)) continue;
      usedUnits.add(u.id);
      usedCells.add(to);
      out.push({ unitId: u.id, x: to % s.w, y: Math.floor(to / s.w) });
    }
  }
  return out;
}

/**
 * **临时调令**（2026-11-25，清 9.18）：站在关键格上、但本来有任务的兵，这一手往哪走。
 *
 * ── 它修的是什么 ─────────────────────────────────────────────
 *
 * 一个刚造出来的兵出生在**产兵格**（城格）上。城格在 `keepClear` 里，于是 `rest` 把它
 * 摘出所有队伍（下面 `constrain` 里那行 `rest = ... && !keepSet.has(...)`）。
 * 结果：`actFor` 拿到 `sq === undefined`，只能"能打就打"，一步都不能走——
 * 直到敌人贴脸（`foeEta <= 1` 时城格不再是关键格），它才突然又开始动。
 *
 * 过桥是同一个病：站在桥面上的兵也被摘出去，然后 `planYield` 把它推往
 * **最近的空格**——方向常常是往回（西岸），于是"过了半步又被弹回来"。
 *
 * ── 它怎么修 ─────────────────────────────────────────────────
 *
 * 给这些兵一张**带方向的调令**：目的地 = 它本来该去的那支队的终点，不是最近的空格。
 * 走一步离开关键格之后，下一回合编队重算，它自然回到 `rest` → 回主队。
 * 所以这里**不需要记任何状态**（"临时编队"能成立全靠 v4 的编队是每手重算的）。
 *
 * ── 边界（都踩过）─────────────────────────────────────────────
 *
 *   · **`hold` 队不当目的地**：召回队的终点就是城，调过去等于让它留在原地，
 *     而且可能把它从外圈拽进城格（反而堵产兵口）；
 *   · **已经在目的地上的不发调令**：那不是"被卡住"，那就是它要站的地方。
 */
function planTransit(
  s: GameState,
  world: World,
  decision: Decision,
  squads: Squad[],
  blockers: Unit[],
  captureTarget: { x: number; y: number } | undefined,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  if (blockers.length === 0) return out;

  /*
   * **只管城格上的挡路兵**（2026-11-25，实测定下来的边界）。
   *
   * 第一版对**所有**关键格上的兵发调令，S-001（地板题）从绿变红：20 个兵挤在
   * 一格宽的桥头时，"各自朝对岸走一步"是贪心的，会把人顶成一横排堵死入口；
   * 而 `planYield` 的搬迁链是**从空位那头倒着派**的（一次只挪一格、不抢格），
   * 在窄道上反而是一台好机器。所以窄道（桥头、城圈）继续交给那条链，
   * 调令只负责"**城格上的新兵**"——那才是 9.18，也正是贪心不会出错的地方（开阔地）。
   *
   * 过桥要的是"排队"，那是 P4 投送要单独做的事（见 `docs/PLAN-V4-PHASE2-2026-11-25.md`），
   * 不该顺手塞进这条调令里。
   */
  const spawnCells = new Set<number>();
  for (const c of world.myCities) {
    for (const t of cityTiles(c)) spawnCells.add(t.y * s.w + t.x);
  }

  /* 目的地：接管废墟时就是废墟格；否则跟"正在往外走的队"走 */
  const dests: Array<{ id: string; at: { x: number; y: number } }> = [];
  if (decision.kind === 'takeover' && captureTarget) {
    dests.push({ id: 'takeover', at: captureTarget });
  } else {
    for (const q of squads) {
      if (q.order === 'hold') continue;
      if (q.unitIds.length === 0) continue; /* 空队没有方向可言 */
      const at =
        q.at ??
        (() => {
          const c = q.cityId ? s.cities.find((x) => x.id === q.cityId) : undefined;
          if (!c) return undefined;
          const n = c.size ?? 2;
          return { x: c.x + Math.floor(n / 2), y: c.y + Math.floor(n / 2) };
        })();
      if (at) dests.push({ id: q.id, at });
    }
  }
  if (dests.length === 0) return out;

  for (const u of blockers) {
    if (!spawnCells.has(u.y * s.w + u.x)) continue; /* 窄道/城圈交给搬迁链（见上） */
    /*
     * 多城分兵时挑**离自己最近**的那支（`marchTurns`，不是直线距离）。
     * 这不是新口径：`planMains` 的"剩下的人补到最近的那座城"用的就是这一条
     * （`constrain.ts` 里 `picked` 那段），这里只是把同一句话用在"临时队"上。
     */
    const pick =
      dests.length === 1
        ? dests[0]!
        : [...dests].sort(
            (a, b) =>
              world.marchTurns(u, a.at) - world.marchTurns(u, b.at) || (a.id < b.id ? -1 : 1),
          )[0]!;
    if (pick.at.x === u.x && pick.at.y === u.y) continue;
    out[u.id] = pick.at;
  }
  return out;
}

/**
 * **升级的可行性**（D4a 之后只剩这一件事）。
 *
 * ── 谁决定"要不要"，谁决定"能不能" ──────────────────────────
 *
 * "要不要升"现在在决定层（`decide.ts` 的 `upgradeOf`：救不救得了 / 钱是不是花不完）。
 * 这里只回答"这个决定这一手执行得了吗"，三条，全是可行性：
 *
 *   ① **路线通不通**：`upgradeTargetOf` 有目标、没封路、没到顶；
 *   ② **钱够不够**：这一级的价 ≤ 现有金币；
 *   ③ **救城的最后一道门槛**：升完剩下的钱，还得买得起一个**打得穿又活得到**的兵。
 *      没有这一条，"全升墙、一个兵不造"会被判成好棋——D-2-02 实测就是这样：
 *      400 − 360 = 40，民兵买得起但过不了闸，等于把钱变成了墙。
 *
 * ③ 为什么留在这里而不是决定层：它要读采购门槛（`need.usable` / `need.survivable`），
 * 那是计划层用 `previewAttack` 算出来的东西。决定层答不了这个问。
 *
 * ── 为什么是"候选列表" ──────────────────────────────────────
 *
 * 多城同时告急时，决定层给的是**优先序列**（撑得最少的那座在前）。
 * 这里顺次验证，取第一个通过的——这样"第一座因为买不起兵被否"时，
 * 还会去试第二座，行为和搬家之前一致。
 */
function planUpgrade(
  s: GameState,
  world: World,
  need: Constraints['need'],
  gold: number,
  plan: Decision['upgrade'],
): { upgrade?: NonNullable<Constraints['upgrade']>; blocked?: string } {
  if (!plan) return {};
  /*
   * **被否的时候要留下一句话**（D6）。
   *
   * 以前这里每个 `continue` 都不说话，于是"决定层说要升、这一手却没升"在回放里
   * 完全看不见——只能去读代码。现在每个出口都写原因，`upgradeBlocked` 一路传到面板和回放。
   */
  let blocked: string | undefined;
  for (const cand of plan.candidates) {
    const city = s.cities.find((c) => c.id === cand.cityId);
    if (!city) {
      blocked = `找不到城 ${cand.cityId}`;
      continue;
    }
    /* ① 路线通不通（决定层查过一次，这里再查是为了不信任上游：状态可能已经变了） */
    const tgt = upgradeTargetOf(s, city);
    if (!tgt || tgt.cost === null || tgt.blocked) {
      blocked = `${city.id} 这条路现在升不了（${tgt?.blocked ?? '没有下一级' }）`;
      continue;
    }
    /* ② 钱够不够 */
    if (gold < cand.cost) {
      blocked = `${city.id} 要 ${cand.cost} 金，手上只有 ${gold}`;
      continue;
    }

    /* ③ 救城才要"别把造兵的路堵死"；升代那条本来就是因为钱花不完才升的 */
    if (plan.kind === 'rescue') {
      const rest = gold - tgt.cost;
      const after = upgradedCity(s, city);
      if (!after) {
        blocked = `${city.id} 升级后的状态算不出来`;
        continue;
      }
      const pool = world
        .affordableCombat(after, rest)
        .filter((o) => !need || (need.usable.includes(o.type) && need.survivable.includes(o.type)));
      if (pool.length === 0) {
        blocked = `升完只剩 ${rest} 金，造不出打得穿又活得到的兵（会把造兵的路堵死）`;
        continue;
      }
      return {
        upgrade: {
          cityId: city.id,
          cost: tgt.cost,
          rounds: cand.rounds.now,
          why: `城 ${cand.rounds.now} 轮内会塌，升到${tgt.label}后能撑 ${cand.rounds.after} 轮，且还剩 ${rest} 金造得了${utype(s, pool[0]!.type).name}`,
        },
      };
    }
    return { upgrade: { cityId: city.id, cost: tgt.cost, rounds: 0, why: cand.why } };
  }
  return { blocked };
}

function horizonOfSquad(
  s: GameState,
  world: World,
  squads: Squad[],
): { left: number; squadId: string; cityId: string; n: number } | undefined {
  const main = squads.find(
    (q) =>
      q.id === 'main' &&
      !!q.cityId &&
      world.foeCities.some((c) => c.id === q.cityId) &&
      (q.order === 'march' || q.order === 'siege' || q.order === 'assemble'),
  );
  if (!main) return undefined;
  const city = s.cities.find((c) => c.id === main.cityId);
  if (!city) return undefined;
  const units = main.unitIds
    .map((id) => s.units.find((u) => u.id === id))
    .filter((u): u is NonNullable<typeof u> => !!u);
  if (units.length === 0) return undefined;
  /* 整队速度 = 最慢的那个兵 */
  const slowest = Math.max(1, Math.min(...units.map((u) => effectiveStats(s, u).move ?? 1)));
  const each = units
    .map((u) => world.marchTurnsOf(u, city, slowest))
    .filter((t) => Number.isFinite(t));
  if (each.length === 0) return undefined;
  return { left: Math.max(...each), squadId: main.id, cityId: city.id, n: each.length };
}

function planHorizon(
  s: GameState,
  world: World,
  squads: Squad[],
): Constraints['horizon'] {
  const sq = horizonOfSquad(s, world, squads);
  if (sq) return { source: 'squad', ...sq };
  /* 地图兜底那一路和 `world.developLeft()` 是同一个数（决定层也是读它） */
  const mp = world.developLeft();
  if (mp) return { source: 'map', ...mp };
  return undefined;
}

/**
 * 把决定翻成约束。
 *
 * 三条铁律：
 *   1. **不把自己人排到 `keepClear` 上**——那是"必须空"的格子，排上去等于自相矛盾；
 *   2. **每个兵最多属于一支队**——v3 的"一兵多队"让两套指令互相覆盖；
 *   3. **守城的兵不出去**——`hold` 是约束，不是"倾向"。
 */
/**
 * 分**列**：**展开宽度由地形决定**（2026-11-24）。
 *
 * 判据是地形事实：`world.corridorWidth()` 数"横向能并排站几格"。
 * 宽 ≥5 走三列、≥3 走两列、**窄道（桥/关隘）退回单列**——单列就是原来的行为。
 *
 * 上一版不看地形、一律分三路，结果 S-005（桥）过河 4→0、S-000/S-011 一起红。
 * 同一个"展开"，开阔地是对的，窄道是灾难，差别就在宽度。
 *
 * 引导点是**滚动航点**（前沿 + 沿轴 3 格 + 法向偏移），不是城边的固定点——
 * 固定点会让侧翼单位为了"先到点"而绕远（用户原话：绕太远耽误时间）。
 *
 * ⚠️ 这是**队形**（一队人分几股并排走），不是战略上的"兵线"。
 * 2026-11-26 之前它叫 `planLanes`，和"线"撞名，W1.5 改成"列"。
 */
function planColumns(
  s: GameState,
  world: World,
  ids: string[],
  city: { x: number; y: number },
): { columns: Array<{ x: number; y: number }>; columnOf: Record<string, number> } | null {
  const us = ids.map((id) => s.units.find((u) => u.id === id)).filter((u): u is NonNullable<typeof u> => !!u);
  if (us.length < 6) return null;

  const front = [...us].sort((a, b) => manhattan(a, city) - manhattan(b, city))[0]!;
  const width = world.corridorWidth(front, city);
  const k = width >= 5 ? 3 : width >= 3 ? 2 : 1;
  if (k === 1) return null;

  const dx = city.x - front.x;
  const dy = city.y - front.y;
  const len = Math.hypot(dx, dy) || 1;
  const ax = dx / len;
  const ay = dy / len;
  const nx = -ay;
  const ny = ax;

  const offsets = k === 3 ? [-2, 0, 2] : [-1.5, 1.5];
  /*
   * 引导点必须**落在能站的格子上**。
   *
   * 算出来落在森林/水上时，引擎的 BFS 距离场在那儿是 Infinity，
   * 于是"离目标更近"的比较全失效，兵会绕着障碍打转（S-011 实测：全队漂到西北角）。
   */
  const snap = (p: { x: number; y: number }): { x: number; y: number } => {
    if (passable(s.tiles[p.y * s.w + p.x]?.terrain ?? 'wall')) return p;
    for (let r = 1; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = p.x + dx;
          const y = p.y + dy;
          if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
          if (passable(s.tiles[y * s.w + x]?.terrain ?? 'wall')) return { x, y };
        }
      }
    }
    return p;
  };
  const columns = offsets.map((off) =>
    snap({
      x: Math.round(front.x + ax * 3 + nx * off),
      y: Math.round(front.y + ay * 3 + ny * off),
    }),
  );

  const sorted = [...us].sort(
    (a, b) => (a.x - front.x) * nx + (a.y - front.y) * ny - ((b.x - front.x) * nx + (b.y - front.y) * ny),
  );
  const columnOf: Record<string, number> = {};
  sorted.forEach((u, i) => {
    columnOf[u.id] = Math.min(columns.length - 1, Math.floor((i * columns.length) / sorted.length));
  });
  return { columns, columnOf };
}

/**
 * 经济兵的岗位（2026-11-24 重写）：**认领表**，一人一格。
 *
 * ── 它解决的是什么 ──────────────────────────────────────────
 *
 * 原来这里是"给每个经济兵挑一格产出最高的空位"，而服务层另外有一个 `econPost()`
 * 每回合重新问"现在哪格最肥"。两个口径都不记得"这块地已经许给谁了"：
 * S-015 实测，同一格森林被连着承诺给 5 个伐木工（新兵出生在城里、旧兵还在路上，
 * 那格一直是"空闲"）。所以要做的不是"挑得更聪明"，是**一张认领表**。
 *
 * ── 三条规矩（都是"算账"，没有拍的数）──────────────────────────
 *
 * ① **兵种是格子的属性**（`world.econSpots()` 已经算好）：森林→伐木工、丘陵→牧民、
 *    平原→农民。所以"5 个伐木工抢 2 格森林"这种错误根本表达不出来。
 * ② **搬不搬算净收益**：`新岗产出 × 还能产几手 > 现岗产出 × 还能产几手` 才搬。
 *    相等就不动（净收益 0）——这一条天然防抖，不需要"迟滞"那套。
 *    产出是**回合末按脚下地形结算**的（`settleIncome`），所以走路那几手照样产金，
 *    搬家的代价只有"路上落点比现在少产的那点"，这里按 0 保守处理。
 * ③ **期限**用决定层已经必须写的 `untilTurn`：到那之前一手都产不了的岗不参与。
 *    远近不用半径挡——远处的岗"期限内产出"自己会变小。
 */
function planEconPosts(
  s: GameState,
  world: World,
  mem?: V4Memory,
): {
  posts?: Record<string, { x: number; y: number }>;
  next?: { type: string; x: number; y: number };
  order?: string[];
} {
  const econ = world.myEcon;
  const spots = world.econSpots();
  if (spots.length === 0) return {};

  /*
   * 盘子有多大：用**决定层的名义期限**，不用"这个决定还剩几手"。
   *
   * 后者在每个周期最后几手会塌到 1 → 岗表全空 → 经济兵集体停手、钱堆着不花
   * （实测 S-015 第 7 手：可用岗从 171 掉到 0）。
   * 战略上"决定快到期"不等于"这块地不值得占"，下个决定大概率还是同一件事。
   */
  const horizon = DECIDE_HORIZON;
  const avail = (p: { turns: number }): number => Math.max(0, horizon - p.turns);
  /* 期限内一手都产不了的岗不算（等它到了，这个决定已经作废了） */
  const usable = spots.filter((p) => avail(p) > 0);
  if (usable.length === 0) return {};

  const posts: Record<string, { x: number; y: number }> = {};
  const claimed = new Set<number>();
  const keepSet = new Set(world.keepClear);
  /*
   * 站在"必须空"的格子上的人，当前产出按 **0** 算。
   *
   * 那几格（城格 + 城墙外一圈）不是能待的地方，是产兵口和出城通道——岗表里根本没有它们。
   * 不算 0 的话会出两个错（都实测到了）：经济兵路过城圈里的森林时"脚下 12 金"，
   * 于是判定"搬走不划算"，钉在过道上不走；同时真正属于它的森林岗一直空着，
   * 上层的造兵又照着那个空岗造了第三个伐木工。
   */

  /*
   * ① 已经站人的格先算被占：**脚下的格就是他的岗**。
   *    不先占的话，两个同产出的人会互相"看见对方的格更肥"（其实同分），来回换。
   */
  for (const u of econ) claimed.add(u.y * s.w + u.x);

  /*
   * ② **按出生顺序配岗：先出生的去远的，后出生的拿近的。**
   *
   * 这是用户 2026-11-24 看回放时纠正的，也是人手答案的走法（action.json 里有据）：
   * u3 是第 1 手造的，它一路往东挪（9,6 → 9,7 → 9,8 → 9,9），
   * 新造的 u5/u7 填它让出来的格。**老的往外顶，新的从近处上来。**
   *
   * ── 为什么不能"谁近谁先挑"（前两版都这么写，结果都错）──
   *
   * 新兵出生在城里，近处的岗一定离它最近 → 近岗永远被新兵拿走，老兵被挤去远岗，
   * 或者新兵自己走远路。看上去总产出没少（同产出的岗互换是等价的），但行为是错的：
   *   ① 新兵走到一半遇到期限/威胁，这一手就白费了；老兵本来就在稳定产出，却被赶走；
   *   ② 老兵剩余回合多，走远路"摊得开"；新兵剩余回合少，走远路就是纯亏。
   * 所以配对的目标不是"当前产出最大"，是**让每个单位的到岗回合尽量一致**。
   *
   * ── 规矩 ──
   *
   * 同兵种的岗产出相同（森林给伐木工、丘陵给牧民、平原给农民），所以同兵种内
   * "远的给老的"不损失任何产出，只是把路程摊平。
   */
  const seniority = (u: Unit): number => mem?.econSince?.[u.id] ?? 0;
  /*
   * 分组键 = **最近的那座城 + 兵种**。
   *
   * 只按兵种分会出事：两座城的经济兵会抢同一批岗，A 城出生的兵被派到 B 城去
   * （实测长局：两个牧民的岗在 30 格外，走一辈子到不了）。
   */
  const nearestCity = (u: Unit): string => {
    const home = mem?.econHome?.[u.id];
    if (home) return home; /* 出生城是钉住的，不随走动变 */
    let bestId = world.myCities[0]?.id ?? '';
    let bestD = Infinity;
    for (const c of world.myCities) {
      const d = Math.abs(u.x - c.x) + Math.abs(u.y - c.y);
      if (d < bestD) {
        bestD = d;
        bestId = c.id;
      }
    }
    return bestId;
  };
  const byType = new Map<string, Unit[]>();
  for (const u of econ) {
    const key = `${nearestCity(u)}|${u.type}`;
    const arr = byType.get(key) ?? [];
    arr.push(u);
    byType.set(key, arr);
  }
  for (const [key, units] of byType) {
    const [cityId, type] = key.split('|') as [string, string];
    /*
     * 单位：出生早的排前面（同一手出生的按 id 排，保证同一个局面每次算出来一样）。
     * 岗位：走得远到近排（`turns` 是"从城走到那儿"，也就是这个岗要花多少路程）。
     */
    /*
     * ════════════════════════════════════════════════════════════════
     * **配岗：按"真实路程"最少来配，不按出生序排位。**
     *
     * 旧写法是"单位按出生序排、岗位按离城远近排、序号对序号"。
     * 那条规则的动机是"老的走远、新的走近"，但它只用了一条排序轴（出生序），
     * 而远近是另一条轴——两条轴排出来的配对会**交叉**，交叉就是互相挡路。
     *
     * 现在改成真正的最小总路程：
     *   代价 = 这个兵走到这个岗的**真实步数**（距离场算的，绕水绕山，不算人），
     *   然后从最便宜的那一对开始配，配过的兵和岗都划掉。
     *
     * 三个好处：
     *   ① 已经在岗上的人代价是 0，天然会被配回原地 → **不会来回挪**；
     *   ② 隔着水的"看着近"的岗，代价是 Infinity/很大 → 不会被选中（这就是用户问的
     *      "不可通行怎么处理"：不用处理，距离场本来就不穿水和山）；
     *   ③ 同代价时按单位 id、格号定序，保证同一个局面每次算出来一样。
     *
     * 出生序没有删掉，只降级成**同代价时的并列判据**（`seniority`）。
     * ════════════════════════════════════════════════════════════════
     */
    /* 候选岗：同城同兵种，取"离城最近"的前 N+2 个（留两个余量给配对挑） */
    const cands = usable
      .filter((p) => p.type === type && p.cityId === cityId)
      .sort((a, b) => a.turns - b.turns || (a.y * s.w + a.x) - (b.y * s.w + b.x))
      .slice(0, units.length);
    if (cands.length === 0) {
      for (const u of units) {
        if (!keepSet.has(u.y * s.w + u.x)) posts[u.id] = { x: u.x, y: u.y };
      }
      continue;
    }

    /* 代价表：每个候选岗一张"从它出发的步数图"，读这个兵脚下那格 */
    const fields = cands.map((p) => world.stepsFrom({ x: p.x, y: p.y }));
    const pairs: Array<{ u: Unit; i: number; d: number }> = [];
    for (const u of units) {
      const here = u.y * s.w + u.x;
      for (let i = 0; i < cands.length; i++) {
        const d = fields[i]![here] ?? Infinity;
        if (Number.isFinite(d)) pairs.push({ u, i, d });
      }
    }
    /* 便宜的先配；同代价时老的先挑，再按格号定序（纯粹为了结果确定） */
    pairs.sort((a, b) => a.d - b.d || seniority(a.u) - seniority(b.u) || a.i - b.i);

    const takenPost = new Set<number>();
    const assigned = new Set<string>();
    for (const pr of pairs) {
      if (assigned.has(pr.u.id) || takenPost.has(pr.i)) continue;
      assigned.add(pr.u.id);
      takenPost.add(pr.i);
      const p = cands[pr.i]!;
      posts[pr.u.id] = { x: p.x, y: p.y };
      claimed.add(p.y * s.w + p.x);
    }
    /* 一个岗都到不了的：原地不动（交给后面的"换空岗"兜底） */
    for (const u of units) {
      if (assigned.has(u.id) || posts[u.id]) continue;
      if (!keepSet.has(u.y * s.w + u.x)) posts[u.id] = { x: u.x, y: u.y };
    }

    /*
     * ════════════════════════════════════════════════════════════════
     * **建链搬运：一张反向场 + 一条链，从洞那一端依次递补。**
     *
     * ── 为什么是"反向" ──────────────────────────────────────────
     *
     * 起点是**洞（空岗）**，波**穿过人群**往外扩。于是每一格的"距离"读作
     * "这格离最近的洞隔着几个人"，"前驱"读作"往洞那边退一格"。
     * 这个方向天然就是"让人群朝洞塌陷"——一次能整列一起挪。
     *
     * 反过来用（起点是人、只走空格）算出来的是"这些人自己能走到哪"，
     * 那是行军用的，搬不动人。
     *
     * ── 链怎么用 ────────────────────────────────────────────────
     *
     * 对一个"这一手走不动"的兵，从它脚下顺着前驱往洞走：
     *
     *     洞 ← c1 ← c2 ← … ← 这个兵
     *
     * 中间每一格都站着人（空的格本来就是洞，不会出现在中间）。然后**从洞那一端开始**
     * 依次递补：c1 进洞、c2 进 c1、……、这个兵进前一格。
     * 每次落点都是上一个人刚腾出来的格——引擎没有"交换两人位置"，只能这样。
     *
     * ── 三条边界 ────────────────────────────────────────────────
     *
     * · 只搬经济兵（战斗兵有自己的任务）；
     * · 链上一格一人（`usedCells`），一个人一回合只被搬一次（`movedUnits`）；
     * · **没有洞就什么都不做**——那不是"再想想办法"，是"真满了"。
     * ════════════════════════════════════════════════════════════════
     */
    const holeCells = cands
      .filter((p) => !s.units.some((v) => v.y * s.w + v.x === p.y * s.w + p.x))
      .map((p) => p.y * s.w + p.x);
    if (holeCells.length > 0) {
      /* 唯一的场：多源（所有洞）、穿过人群、带前驱 */
      const flow = world.field(holeCells, { through: 'units', prev: true });
      const queued = [...units].filter(
        (u) => posts[u.id] && !(posts[u.id]!.x === u.x && posts[u.id]!.y === u.y),
      );

      /*
       * ── 第一步：**先把所有链建出来**，一条都先不执行 ──────────────
       *
       * 以前是"边建边执行"，于是先建的那条把格子占了，后面的链走到一半发现
       * 目标被占，在中途 `break` —— 结果是**半条链**：前面几个人挪了，后面没挪，
       * 空出来的格反而被别的链占了，越搞越乱。
       */
      const chains: Array<{ u: Unit; from: number; cells: number[] }> = [];
      for (const u of queued) {
        const from0 = u.y * s.w + u.x;
        /* 这一手走得动吗？走得动就自己走，不建链 */
        const own = world.stepsFrom(posts[u.id]!);
        const here = own[from0] ?? Infinity;
        let canWalk = false;
        for (const [k] of reachableTiles(s, u)) {
          const x = k % s.w;
          const y = (k - x) / s.w;
          if (s.units.some((v) => v.id !== u.id && v.x === x && v.y === y)) continue;
          if ((own[k] ?? Infinity) < here) {
            canWalk = true;
            break;
          }
        }
        if (canWalk) continue;

        /* 顺着前驱往洞走，走到**第一个空格**为止（不必正好是空岗） */
        const cells: number[] = [];
        let k = from0;
        let sink = false;
        for (let guard = 0; guard < 12; guard++) {
          const p = flow.prev[k]!;
          if (p < 0) break;
          cells.push(p);
          k = p;
          if (!s.units.some((v) => v.y * s.w + v.x === k)) {
            sink = true;
            break;
          }
        }
        if (!sink || cells.length === 0) continue;
        chains.push({ u, from: from0, cells });
      }

      /*
       * ── 第二步：**短的先成立，抢不到就整条放弃** ──────────────────
       *
       * 短链先占位，长链让路——短链通常贴着洞，挪得动；长链横跨人群，
       * 一旦和已成立的链撞格，就说明这一手它过不去。
       * 这时**整条放弃**（而不是中途截断）：截断会留下"半条链"，
       * 前面的人挪了、后面的人没挪，空出来的格又被别人占掉。
       */
      chains.sort((a, b) => a.cells.length - b.cells.length || (a.u.id < b.u.id ? -1 : 1));
      const usedCells = new Set<number>();
      const movedUnits = new Set<string>();
      for (const ch of chains) {
        /* 冲突检查（先看，不动手）：链上每一格是否还能用 */
        let ok = true;
        for (let idx = 0; idx < ch.cells.length; idx++) {
          const cell = ch.cells[idx]!;
          if (usedCells.has(cell)) {
            ok = false;
            break;
          }
          const isSink = idx === ch.cells.length - 1;
          const occ = s.units.find((v) => v.y * s.w + v.x === cell);
          if (isSink) {
            if (occ) {
              ok = false;
              break;
            }
          } else {
            if (!occ || occ.owner !== world.me) {
              ok = false;
              break;
            }
            if (utype(s, occ.type).category !== 'economy') {
              ok = false;
              break;
            }
            if (movedUnits.has(occ.id)) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue; /* 整条放弃，这一手它不动 */
        if (usedCells.has(ch.from)) continue;

        /* 执行：从洞那一端往人这一端递补 */
        for (let idx = ch.cells.length - 1; idx >= 1; idx--) {
          const to = ch.cells[idx]!;
          const mover = s.units.find((v) => v.y * s.w + v.x === ch.cells[idx - 1]!);
          if (!mover || mover.owner !== world.me) continue;
          posts[mover.id] = { x: to % s.w, y: Math.floor(to / s.w) };
          movedUnits.add(mover.id);
        }
        /* 最后是这个兵自己走进链头 */
        posts[ch.u.id] = {
          x: ch.cells[0]! % s.w,
          y: Math.floor(ch.cells[0]! / s.w),
        };
        movedUnits.add(ch.u.id);
        for (const cell of ch.cells) usedCells.add(cell);
        usedCells.add(ch.from);
      }
    }
  }

  /*
   * ③ 下一个该造谁：表里还没人认领的格里，**产出最高的那一个；产出相同取近的**。
   *
   * 为什么不是"赚回几倍造价"（试过，卡住过）：那个口径偏爱便宜兵——
   * 牧民 8 金 ÷ 45 比伐木工 12 金 ÷ 70 略好，于是永远先买牧民，
   * 两格森林一次都没用上，总产反而低。
   * 钱的问题交给"买不起就跳过"，不掺进排序。
   */
  const gold = s.players[world.me]?.gold ?? 0;
  let next: { type: string; x: number; y: number } | undefined;
  for (const p of usable) {
    const k = p.y * s.w + p.x;
    if (claimed.has(k)) continue;
    if (s.units.some((v) => v.y * s.w + v.x === k)) continue;
    if (p.gold > gold) continue; /* 买不起就跳过，换下一个岗 */
    if (!next) {
      next = { type: p.type, x: p.x, y: p.y };
      continue;
    }
    const cur = spots.find((q) => q.x === next!.x && q.y === next!.y)!;
    if (p.yield > cur.yield || (p.yield === cur.yield && p.turns < cur.turns)) {
      next = { type: p.type, x: p.x, y: p.y };
    }
  }

  /*
   * **行动顺序：靠自己岗位近的排在前面（链条末端先动）。**
   *
   * 这里给的"远近"是**真实步数**（`stepsFrom`，绕水绕山、不算人），不是直线距离。
   * 直线距离会把"看着近、其实要绕一大圈"的人排到前面，他先动反而把路堵住。
   *
   * 只在有岗的人之间排序；没岗的排在最后（它们这一手本来就不该动）。
   */
  const order = [...econ]
    .map((u) => {
      const p = posts[u.id];
      if (!p) return { id: u.id, d: Infinity };
      const d = p.x === u.x && p.y === u.y ? 0 : (world.stepsFrom(p)[u.y * s.w + u.x] ?? Infinity);
      return { id: u.id, d };
    })
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
    .map((x) => x.id);

  return { posts, next, order };
}

/**
 * **出城迎击站哪儿**：离这座城最近的敌人旁边、且不在城格里的一格（2026-11-27）。
 *
 * 判据全是几何：敌人按 `marchTurns` 挑最近的，站它身边（曼哈顿 1），
 * 排除城格（城里那 2 个另有其人）、排除站了人的格、只留能走的格。
 * 多个候选里挑**离城最远**的那个——在城外接火，不把战场摆在城门口。
 */
function interceptAt(
  s: GameState,
  world: World,
  city: City,
): { x: number; y: number } | undefined {
  const foe = [...world.foeCombat].sort(
    (a, b) => world.marchTurns(a, city) - world.marchTurns(b, city) || (a.id < b.id ? -1 : 1),
  )[0];
  if (!foe) return undefined;
  const cityCells = new Set(cityTiles(city).map((p) => p.y * s.w + p.x));
  const cands = [
    { x: foe.x + 1, y: foe.y },
    { x: foe.x - 1, y: foe.y },
    { x: foe.x, y: foe.y + 1 },
    { x: foe.x, y: foe.y - 1 },
  ].filter(
    (p) =>
      p.x >= 0 &&
      p.y >= 0 &&
      p.x < s.w &&
      p.y < s.h &&
      !cityCells.has(p.y * s.w + p.x) &&
      passable(s.tiles[p.y * s.w + p.x]?.terrain ?? 'water') &&
      !s.units.some((u) => u.x === p.x && u.y === p.y),
  );
  if (cands.length === 0) return undefined;
  const dist = (p: { x: number; y: number }): number =>
    Math.abs(p.x - city.x) + Math.abs(p.y - city.y);
  return [...cands].sort((a, b) => dist(b) - dist(a) || b.y - a.y || b.x - a.x)[0];
}

/**
 * **守一座城的兵力怎么分：城里留几个、谁出城迎击**（2026-11-27，用户定的"适当主动防御"）。
 *
 * 原来的守 = 全部钉在城格上等敌人来打。城格只有 n×n 个（2×2 = 4），站不下的人也
 * 只是挤在门口挨城破的连带伤害，一分输出都没有——`D-3-01` 实测：3 个人站在离敌人
 * 两格的地方，一整场没出过一拳，城就这么被拆了。
 *
 * 三条判据，全是数：
 *   ① **城撑不满 4 轮就不出城**：出城一趟来回要 4 手（出去 2、回来 2），
 *      撑不到就是白送（`D-1-01`/`D-1-03` 城只能撑 3 轮、`D-2-02` 只能撑 2 轮，
 *      分兵会让它们直接翻红）；
 *   ② **城里留 2 个**：城格吃 +3 护甲，而且城格得有人站着才不会被"抢走"；
 *   ③ **出去的人要赶得上**：`marchTurns(到迎击位) ≤ 敌人开打的手数`，赶不上的留在城里。
 *
 * 三条任一不成立就退回"全员进城"（行为与改动前逐字一致）。
 */
function guardSplit(
  s: GameState,
  world: World,
  city: City,
  ids: string[],
): { inside: string[]; field: string[]; at?: { x: number; y: number } } {
  if (ids.length <= CITY_POST) return { inside: ids, field: [] };
  const out = world.defensible(city);
  if (!Number.isFinite(out.rounds) || out.rounds < 4) return { inside: ids, field: [] };
  /* 敌人 2 手内就要开打才谈得上"迎击"；更远的话先按原来的走位（`S-013` 实测：那时分兵会丢城） */
  if (out.firstAt > 2) return { inside: ids, field: [] };
  const at = interceptAt(s, world, city);
  if (!at) return { inside: ids, field: [] };
  const units = ids
    .map((id) => s.units.find((u) => u.id === id))
    .filter((u): u is Unit => !!u)
    .sort((a, b) => world.marchTurns(a, city) - world.marchTurns(b, city) || (a.id < b.id ? -1 : 1));
  const deadline = Math.max(1, out.firstAt);
  const field = units.slice(CITY_POST).filter((u) => world.marchTurns(u, at) <= deadline);
  if (field.length === 0) return { inside: ids, field: [] };
  const fieldIds = new Set(field.map((u) => u.id));
  return { inside: ids.filter((id) => !fieldIds.has(id)), field: [...fieldIds], at };
}

/**
 * **每座城要几个守军**（名额）——从 `planMains` 里拆出来的一半（§4.23 步骤 1a）。
 *
 * ── 为什么要拆 ────────────────────────────────────────────────
 *
 * 批 3 的"归属"（谁归守、谁归攻）需要一个数：**这座城到底要几个人**。
 * 可是 `planMains` 原来是"名额 + 分配"焊在一起的，而且第 ② 趟写着
 * "剩下的补到最近的那座城"——**问它要名额，它会把整个池子吃干净**。
 * 所以先把"要几个"单独拿出来，`planMains` 只负责按这个数发人。
 *
 * ── 口径一个字没改 ────────────────────────────────────────────
 *
 * ① 每座城：`守军身价 ÷ 我方均价 × 1.5`，夹在 2~12；
 * ② 需求总和超过手头兵力时**按比例摊**（不是先到先得，`S-013` 实测 4:4 才守得住两城）。
 *
 * 注意 ① 里的均价取的是**这一手候选池**的均价（`units`），所以名额和"池子里有谁"有关——
 * 这也是它必须在这里算、不能提前到世界层的原因。
 */
function defenderQuota(
  s: GameState,
  world: World,
  cities: City[],
  units: Unit[],
): Map<string, number> {
  if (units.length === 0 || cities.length === 0) return new Map();
  const avg = units.reduce((n, u) => n + unitWorth(s, u), 0) / units.length || 1;
  const needs = cities.map((c) => {
    const guard = world.foeCombat.filter((u) => manhattan(u, c) <= 6);
    const guardStr = guard.reduce((n, u) => n + unitWorth(s, u), 0);
    return { city: c, want: Math.max(2, Math.min(12, Math.round((guardStr / avg) * 1.5))) };
  });
  const totalWant = needs.reduce((n, x) => n + x.want, 0);
  if (totalWant > units.length) {
    for (const n of needs) n.want = Math.max(2, Math.floor((n.want * units.length) / totalWant));
  }
  return new Map(needs.map((n) => [n.city.id, n.want]));
}

/**
 * 多城分兵（2026-11-24）：**每座受威胁的城一支队**。
 *
 * 为什么必须分：只有一支 `main` 时，所有兵都去最近那座城，另一座直接丢
 * （S-013 实测 v4 = 0/2，分兵脚本 = 2/2）。
 *
 * 分配是两趟纯几何，不打分：
 *   ① 每座城按"守军身价 ÷ 我方均价 × 1.5"算出需要几个人（和单城时同一个口径）；
 *   ② 先按需求从近到远取人（谁离这座城近就归谁），剩下的兵补到最近的那座城。
 *
 * 不做"哪个城更重要"的判断——那是决定层的事，而决定层现在只挑一座城。
 */
function planMains(s: GameState, world: World, cities: City[], ids: string[]): Squad[] {
  const units = ids.map((id) => s.units.find((u) => u.id === id)).filter((u): u is NonNullable<typeof u> => !!u);
  if (units.length === 0 || cities.length === 0) return [];

  /* 名额（每座城要几个）和分配（谁去哪座）分开——名额单独成函数，见 `defenderQuota` */
  const quota = defenderQuota(s, world, cities, units);
  const needs = cities.map((c) => ({ city: c, want: quota.get(c.id) ?? 0 }));

  /* ① 按需求从大到小，各自从近到远取人 */
  const left = new Set(units.map((u) => u.id));
  const picked = new Map<string, string[]>();
  for (const n of [...needs].sort((a, b) => b.want - a.want)) {
    const cands = [...left]
      .map((id) => s.units.find((u) => u.id === id)!)
      .sort((a, b) => world.marchTurns(a, n.city) - world.marchTurns(b, n.city));
    const take = cands.slice(0, n.want);
    picked.set(n.city.id, take.map((u) => u.id));
    for (const u of take) left.delete(u.id);
  }

  /* ② 剩下的补到最近的那座城 */
  for (const id of left) {
    const u = s.units.find((x) => x.id === id);
    if (!u) continue;
    const near = [...cities].sort((a, b) => world.marchTurns(u, a) - world.marchTurns(u, b))[0]!;
    picked.get(near.id)?.push(id) ?? picked.set(near.id, [id]);
  }

  const out: Squad[] = [];
  for (const n of needs) {
    const squadIds = picked.get(n.city.id) ?? [];
    if (squadIds.length === 0) continue;
    /*
     * **分两拨：城里留 2 个，其余出城迎击**（2026-11-27，`guardSplit`）。
     * 不满足它的三条判据时 `field` 是空的，走的是原来那支 `main`（逐字不变）。
     */
    const split = guardSplit(s, world, n.city, squadIds);
    if (split.field.length > 0 && split.at) {
      out.push({
        id: `hold-${n.city.id}`,
        order: 'hold',
        unitIds: split.inside,
        cityId: n.city.id,
        tactics: planTactics(s, split.inside, false),
      });
      out.push({
        id: `main-${n.city.id}`,
        order: 'march',
        unitIds: split.field,
        cityId: n.city.id,
        at: split.at,
        want: split.field.length,
        tactics: planTactics(s, split.field, true),
        ...(planColumns(s, world, split.field, n.city) ?? {}),
      });
      continue;
    }
    out.push({
      id: `main-${n.city.id}`,
      order: 'march',
      unitIds: squadIds,
      cityId: n.city.id,
      want: n.want,
      tactics: planTactics(s, squadIds, true),
      ...(planColumns(s, world, squadIds, n.city) ?? {}),
    });
  }
  return out;
}

/**
 * 一支队伍"这一手该站哪些格"——终点集合。
 *
 * 目标是城时，终点是**城外可站的格**（城格站不上）；目标是集结点时，终点是它周围。
 * 半径 2 是"城下那一圈"：射程 1~2 的兵都能从这儿够到城。
 */
/** 一支队伍"该往哪个点聚"：集结点，或目标城的中心。 */
function squadBase(s: GameState, sq: Squad): { x: number; y: number } | undefined {
  if (sq.at) return sq.at;
  const city = sq.cityId ? s.cities.find((c) => c.id === sq.cityId) : undefined;
  return city
    ? { x: city.x + Math.floor((city.size ?? 2) / 2), y: city.y + Math.floor((city.size ?? 2) / 2) }
    : undefined;
}

/**
 * **战斗单位这一手走哪一格：多起点 → 多终点，一次排定。**
 *
 * ── 为什么不是每人自己 `stepToward` ────────────────────────────
 *
 * 每个兵只看自己：我离目标更近的那格站着人 → 我不动；他也这么想 → 谁也不动。
 * 30 个兵挤成一条线时，整条线只会在原地互相等。
 *
 * ── 这一版怎么排 ──────────────────────────────────────────────
 *
 * 1. 终点 = 目标城外**面向我们**的那一圈（见 `targetCells`）；
 * 2. 人和终点都按"到目标城的真实步数"排一遍，**同序配对**：
 *    离城近的兵配离城近的格，离城远的配远处的格。
 *
 *    这一步同时管两件事：
 *      · **不交叉**——两边同一条轴排序后配对，任何两条线交换都会让总路程变大，
 *        所以同序就是最优且不自交的那一组；
 *      · **链长接近**——每人要走的路约等于"两列分布之差"，是一条几乎等长的横队，
 *        整体平移过去，而不是"最近的先冲、远的干等"（那种会一个一个送）。
 *
 * 3. **离城近的先走**（前排先挪开，后排才有位置），落点去重。
 */
function planMarch(
  s: GameState,
  world: World,
  squads: Squad[],
): { steps: Record<string, { x: number; y: number }>; order: string[] } {
  const out: Record<string, { x: number; y: number }> = {};
  const order: string[] = [];
  for (const sq of squads) {
    /*
     * `hold` 不动；`build` 也不走方阵——工兵通常只有 1~2 人，按方块排队会一直在
     * "收拢"、绕着渡口转（4d-2 实测）。它们由打分层朝岸边一步一格走。
     */
    if (sq.order === 'hold' || sq.order === 'build') continue;
    const base = squadBase(s, sq);
    if (!base) continue;
    const units = sq.unitIds
      .map((id) => s.units.find((u) => u.id === id))
      .filter((u): u is Unit => !!u && u.owner === world.me);
    if (units.length === 0) continue;

    /* 这一队所在的图（多图下别拿地球的格表去查月球的兵） */
    const tiles = boardOf(s, boardIdOf(units[0]!)).tiles;
    const toBase = world.stepsFrom(base);
    const axisOf = (u: Unit): number => toBase[u.y * s.w + u.x] ?? Infinity;
    const pending = units.filter((u) => axisOf(u) > 0);
    if (pending.length === 0) continue;

    /*
     * **按"这一排干什么活"分排，不按兵种。**
     *
     * 判据是**射程**：射程 1 的顶上去、射程 2 的跟在中排、射程 3 以上在后排打输出。
     * 同一排里的人移动力天然接近（骑兵 4 / 步兵 2），所以排内不会出现"快的等慢的"。
     *
     * 这样也不会"所有兵聚成一团"：每排有**自己的**紧凑阵位，排与排的阵位互不重叠。
     */
    /*
     * **窄道（桥、关隘）不收拢，排队走。**
     *
     * 收拢的前提是"并排站得下"。桥面只有一格宽，硬排方块等于把人摊在桥头，
     * 整队卡死（S-005 实测：收拢版从绿变红）。宽度用现成的 `corridorWidth`，
     * 不是拍的数字。
     */
    const front = [...pending].sort((a, b) => axisOf(a) - axisOf(b) || (a.id < b.id ? -1 : 1))[0]!;
    /*
     * 路上有没有桥/窄口：从前锋顺着"到城的步数"往下走，遇到桥就是窄道。
     * 只看终点附近的宽度测不到——城门口是开阔的，窄的是半路上的桥。
     */
    let narrow = world.corridorWidth({ x: front.x, y: front.y }, base) <= 2;
    for (let k = front.y * s.w + front.x, guard = 0; !narrow && guard < 40; guard += 1) {
      if (tiles[k]?.terrain === 'bridge') {
        narrow = true;
        break;
      }
      if ((toBase[k] ?? 0) <= 0) break;
      let next = k;
      let bestD = toBase[k] ?? Infinity;
      const x0 = k % s.w;
      const y0 = (k - x0) / s.w;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x0 + ox;
        const ny = y0 + oy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const nk = ny * s.w + nx;
        const d = toBase[nk] ?? Infinity;
        if (d < bestD) {
          bestD = d;
          next = nk;
        }
      }
      if (next === k) break;
      k = next;
    }
    if (narrow) {
      /*
       * 窄道**整队交给打分层**（`stepToward`）：桥面一次过一个人，
       * 排队的事它本来就比自己再实现一遍做得好（S-005 的过河数就是这么保住的）。
       *
       * 试过在这里"按离城近的先动"定排队顺序（W4-4c，2026-11-26）：**净负**——
       * S-001 从 25 手拖到 33 手、S-011 从 11 手变未分胜负。原因是打分层本来就按
       * "离目标近的在前"派动作（`myCombat` 的排序），再插一层顺序反而打乱了它。
       * 所以**这一层不排序**，只保留"桥上的人不算挡路"（见 `blockers`）。
       */
      continue;
    }

    /*
     * **这一手能打到人，就不排阵型了。**
     *
     * 队形是为了"走路时不被各个击破"；一旦能开火，按阵位走反而会错过攻击位
     * （前排被要求站到方块里，而它本来站的地方就能打到人）。
     * `threatTiles` 给的是"这个兵这一手能打到的所有格"（可达格 + 每个落点的射程），
     * 所以拿它跟敌人位置一比，就是"移动之后能不能打到"。
     */
    const engaged = units.some((u) => {
      const t = threatTiles(s, u);
      return world.foeCombat.some((f) => t.has(f.y * s.w + f.x));
    });
    if (engaged) {
      /* 接敌：各自找最靠近敌人的位置，不排阵型 */
      const usedF = new Set<number>();
      for (const u of [...pending].sort((a, b) => axisOf(a) - axisOf(b) || (a.id < b.id ? -1 : 1))) {
        const here = toBase[u.y * s.w + u.x] ?? Infinity;
        let best: number | null = null;
        let bestD = here;
        for (const [k] of reachableTiles(s, u)) {
          if (s.units.some((v) => v.id !== u.id && v.y * s.w + v.x === k)) continue;
          if (usedF.has(k)) continue;
          const d = toBase[k] ?? Infinity;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        if (best === null) continue;
        out[u.id] = { x: best % s.w, y: Math.floor(best / s.w) };
        usedF.add(best);
        order.push(u.id);
      }
      continue;
    }

    /*
     * **分排：先把射程排成前后，同一射程里速度快的在前**（用户 2026-11-26 定的口径）。
     *
     * 排与排：**实际射程值**（近战 1 在最前，远程 4 在最后）。
     * 以前只分三档（≤1 / 2 / ≥3），射程 3 和 5 挤在同一排，
     * 同排里谁靠前就看谁离城近——那会让射程远的抢到前排，和"远的在后"相反。
     *
     * 排内：**移动力大的在前**，同速度才按离城远近。理由和用户说的一样——
     * 快的本来就该先顶上去、先到先等，慢的按自己的节奏跟上；
     * 反过来（按离城远近排）会让已经跑到前面的慢兵被配回后排，队伍来回抖。
     * 顺带说明：分排**全程做**，不等到城下才排——人对这个场面也是"边出发边变阵"，
     * 只在近处才排就来不及了。
     */
    const rows = new Map<number, Unit[]>();
    for (const u of pending) {
      const r = effectiveStats(s, u).range ?? 1;
      const k = Math.max(0, r);
      const arr = rows.get(k) ?? [];
      arr.push(u);
      rows.set(k, arr);
    }

    const used = new Set<number>();
    /* 落点也要去重：两个人算到同一格时，后一个执行会"不可达"，就退回乱走了 */
    const taken = new Set<number>();
    for (const [, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const n = row.length;
      const cx = Math.round(row.reduce((a, u) => a + u.x, 0) / n);
      const cy = Math.round(row.reduce((a, u) => a + u.y, 0) / n);
      const moves = row.map((u) => effectiveStats(s, u).move ?? 2);
      const maxMove = Math.max(...moves);
      /* 方块边长：这一排挤成正方形要几格宽（由人数决定，不是拍的） */
      const side = Math.max(1, Math.ceil(Math.sqrt(n)));
      /*
       * 现在是不是已经是一团：谁离排中心超过"方块半径"，就说明还散着。
       * 散着 → 这一手只前移一格（把边缘的人吸回来）；成型了 → 走满推进。
       */
      const spread = Math.max(
        ...row.map((u) => Math.abs(u.x - cx) + Math.abs(u.y - cy)),
      );
      const formed = spread <= side;

      const dx = base.x - cx;
      const dy = base.y - cy;
      const dir =
        Math.abs(dx) >= Math.abs(dy)
          ? { x: Math.sign(dx) || 1, y: 0 }
          : { x: 0, y: Math.sign(dy) || -1 };
      const ahead = formed ? maxMove : 1;
      const aim = { x: cx + dir.x * ahead, y: cy + dir.y * ahead };

      /* 阵位 = 离"新中心"最近的 n 个可站格（这一排的紧凑方块） */
      const slots: number[] = [];
      for (let r = 0; r <= 8 && slots.length < n; r += 1) {
        for (let oy = -r; oy <= r; oy += 1) {
          for (let ox = -r; ox <= r; ox += 1) {
            if (Math.abs(ox) + Math.abs(oy) !== r) continue;
            const x = aim.x + ox;
            const y = aim.y + oy;
            if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
            const k = y * s.w + x;
            if (used.has(k)) continue;
            const t = tiles[k];
            if (!t || !passable(t.terrain) || t.terrain === 'city') continue;
            /* 敌人占着的格不能当阵位（那是要打的地方，不是要站的地方） */
            if (s.units.some((v) => v.owner !== world.me && v.y * s.w + v.x === k)) continue;
            slots.push(k);
            if (slots.length >= n) break;
          }
        }
      }
      if (slots.length === 0) continue;

      /*
       * **同序配对**：人按"离城远近"排，阵位也按"离城远近"排，序号对序号。
       * 两边都是同一条轴上单调的，所以路线不会交叉；散开的一排会被吸成方块。
       */
      const moveOf = (u: Unit): number => effectiveStats(s, u).move ?? 2;
      const rowSorted = [...row].sort(
        (a, b) => moveOf(b) - moveOf(a) || axisOf(a) - axisOf(b) || (a.id < b.id ? -1 : 1),
      );
      const slotSorted = [...slots].sort((a, b) => {
        const da = toBase[a] ?? Infinity;
        const db = toBase[b] ?? Infinity;
        return da - db || a - b;
      });

      for (let idx = 0; idx < rowSorted.length && idx < slotSorted.length; idx += 1) {
        const u = rowSorted[idx]!;
        const slot = slotSorted[idx]!;
        used.add(slot);
        const field = world.stepsFrom({ x: slot % s.w, y: Math.floor(slot / s.w) });
        const here = field[u.y * s.w + u.x] ?? Infinity;
        let best: number | null = null;
        let bestD = here;
        for (const [k] of reachableTiles(s, u)) {
          if (s.units.some((v) => v.id !== u.id && v.y * s.w + v.x === k)) continue;
          if (taken.has(k)) continue;
          const d = field[k] ?? Infinity;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        if (best === null) continue;
        out[u.id] = { x: best % s.w, y: Math.floor(best / s.w) };
        taken.add(best);
        order.push(u.id);
      }
    }
  }
  return { steps: out, order };
}

/**
 * **在编的编队**（W3.6 第 2 步）：名册只因为"人死了"缩小，**不因为站错格子被踢出去**。
 *
 * 以前的写法是"名册 ∩ 这一手能派的人"，而那份名单里没有两种人：
 *   · 站在关键格上的（产兵格、城门口、桥头）——新兵出生就在产兵格上，
 *     于是"刚编进队的兵下一手就消失了"；队里的人走过关键格也会被静默删掉。
 * "这一手能派谁"和"这队还剩下谁"是两件事，以前被混成了一个。
 *
 * 撤编只有三种（第 2 步定的）：全灭 / **已出发**且存活不到编制四成 / 没有敌城可打。
 * "四成"只对已出发的队生效——收拢中的队本来就小，按四成判会把刚成军的两三个人
 * 立刻判死，于是每手重建一支新队（编号一直变）。
 */
function liveBandsOf(
  mem: V4Memory | undefined,
  cityId: string | null,
  aliveIds: Set<string>,
): Band[] {
  return (mem?.bands ?? [])
    .filter((b) => cityId === null || b.cityId === cityId)
    .map((b) => ({ ...b, unitIds: b.unitIds.filter((id) => aliveIds.has(id)) }))
    .filter((b) => b.unitIds.length > 0)
    .filter(
      (b) =>
        (b.state ?? 'forming') === 'forming' ||
        b.unitIds.length / Math.max(1, b.want ?? b.unitIds.length) >= 0.4,
    );
}

export function constrain(s: GameState, world: World, decision: Decision, mem?: V4Memory): Constraints {
  const city = decision.cityId ? s.cities.find((c) => c.id === decision.cityId) : undefined;
  const keepClear = [...world.keepClear];
  const keepSet = new Set(keepClear);
  /*
   * **批 2：产兵名额先算**（见 `applySpawnQuota`）。
   *
   * 必须排在下面所有读者之前——`rest`（编队池）、`blockers`（临时调令）、
   * `planYield`（搬迁链）读的都是这一份 `keepClear`。
   * 排在架桥那条之前：架桥加的是"走廊"，两边不重叠；顺序只影响 `keepClear` 的先后，
   * 而先后会决定让位链的占用顺序（批 1 已经踩过这个坑），所以**放在最前面**最省事。
   */
  const spawnQuota = applySpawnQuota(s, world, decision, keepClear, keepSet);
  /*
   * **架桥时先把工兵要站的那一格空出来**（W4-4d-2，2026-11-26）。
   *
   * 用户指出的"让路"：过河部队很可能正好堵在造桥点上（一格桥旁边就那么几格）。
   * 把那一格列进 `keepClear`，现有的让位机制（`yield`）会把人挪开，工兵才有地方站。
   * **只加这一格，不加桥面**——桥面要能走（4c 刚放开）。
   */
  if (decision.kind === 'bridge' && decision.bridge) {
    /*
     * **给工兵腾一条走廊，不是一格**（W4-4d-3，2026-11-26）。
     *
     * 只留落脚点不够：岸上十几个人挤在桥头，工兵（移动力 2）走到离桥头 2 格就没地方落脚，
     * 每一手都在原地抖（实测：桥停在第二格，工兵在 (6,7)/(7,8) 抖了 20 手）。
     * 所以把**从岸到桥头这一条**（沿铺桥方向）每格的八邻都列进关键格，
     * 让位机制会把整条通道清出来。
     *
     * 只在架桥期间生效；水面/山本来就站不上，多列没有副作用。
     */
    const b0 = decision.bridge.bank;
    const s0 = decision.bridge.stand;
    const dx = Math.sign(s0.x - b0.x);
    const dy = Math.sign(s0.y - b0.y);
    let cx = b0.x;
    let cy = b0.y;
    for (let i = 0; i < 10; i += 1) {
      for (const [ox, oy] of [
        [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ] as const) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const k = y * s.w + x;
        if (!keepSet.has(k)) {
          keepClear.push(k);
          keepSet.add(k);
        }
      }
      if (cx === s0.x && cy === s0.y) break;
      if (dx === 0 && dy === 0) break;
      cx += dx;
      cy += dy;
    }
  }

  const squads: Squad[] = [];
  /** 这一手在编的进攻编队（要写回记忆，见 `Band`） */
  let outBands: Band[] | undefined;
  /** 采购要造到多少人（编制之和 + 一批）；没有编队时不设上限 */
  let outBandNeed: Constraints['bandNeed'];
  /** 在编的工兵队（架桥用；桥通了就不写，等于撤编） */
  let outBuildBand: Constraints['buildBand'];
  /** 这一手去造一个能铺桥的人（架桥那条决定落到采购上；见 `Constraints.recruitBuilder`） */
  let outRecruitBuilder: Constraints['recruitBuilder'];
  /** 决定层给这支编队的任务（W3.6 第 3c 步）：意图在这儿，走不走得通由下面判 */
  const taskOf = (bandId: string) => (decision.bandTasks ?? []).find((t) => t.bandId === bandId);

  /*
   * 守军：每座**真的会被摸到**的城留 2 个最近的兵，任务 hold。留谁按"离城近"排，不按分数。
   *
   * **2026-11-25 改（修 9.7）：先问一句"敌人来不来得及"，再来不及就不留人。**
   *
   * 原来这里是 `role === 'home'` 无条件 `slice(0, 2)`——只要我只有一座城，就永远留 2 个，
   * 不管敌人离城 7 回合还是场上一个敌兵都没有。于是：
   *   · S-016（空城、无敌人）8 个兵被扣 2 个，第 4 手城伤只有 33（v1/v3 是 69）；
   *   · T-1（接管废墟）1 个兵时唯一的兵被扣走，`captureId` 为空，接管根本发不出去。
   *
   * 现在读 `foeEta`（敌人最快几回合摸到城）：**下一手就能摸到**才留。
   * 不留人不是"不设防"——兵本来就在场，该回防的回合 `defend` 会把他们叫回来；
   * 提前两个回合钉住 2 个人，只是让主力少两个人。
   */
  /*
   * **"每城留 2 个守军"这个补丁撤了**（W3.6 第 4 步，2026-11-26）。
   *
   * 它治的是"主力全出去、老家没人看"，但代价是**提前两个回合钉住 2 个人**：
   *   · S-016（空城、无敌人）8 个兵被扣 2 个，第 4 手城伤只有 33（v1/v3 是 69）；
   *   · T-1（接管废墟）1 个兵时唯一的兵被扣走，接管根本发不出去；
   *   · 更要命的是它**不认编队**，却决定编队能拿到谁——编队人数莫名少两个。
   *
   * 现在守城由决定层负责：`world.defensible` 判"这座城挡不住"，
   * 约束层把**回得去的编队**整队改成守（走不回去的继续打），不需要在每座城提前钉人。
   * 换句话说：不是"永远留两个人"，而是"该回防的时候整队回防"。
   */

  /*
   * **站在关键格上的兵：不在主队里，但有一个任务叫"让开"**（2026-11-25，清 9.14）。
   *
   * 它们原来是被**摘出所有队伍**：这一手"没有任何任务"，不报错、不复盘、日志里看不见，
   * 回放里就是"它突然不动了"。现在改成给一个明确的 `yield` 任务（见下面 push 的那支队），
   * 行为不变（它们本来也不跟着主队走），但看得见、说得清。
   *
   * **为什么不让它们直接留在主队里**：试过，S-001（该赢的必须赢）从绿变红——
   * 它们一进主队，就成了 `march` 的一员，`planYield` 的"正在执行的兵不算挡路"会把它们保护起来，
   * 于是谁都不去腾格子；而且主队人数虚高，`ready`（`ids.length >= want`）提前成立，队伍早发。
   * 这两个副作用都比"多一个任务名"贵。
   */
  /*
   * **正在过桥的人不算"挡路"**（W4-4c，2026-11-26；用户的想法）。
   *
   * 关键格驱离（`yield`）的本意是"别把产兵口/桥头堵死"。但它把**正在过桥的人**
   * 也一起赶下来了：一个兵踩上桥面 → 下一手它在关键格上 → 被摘出队伍去"让开"，
   * 走一步下桥；再下一手又从头排队。过桥因此被拖慢（`P-4-01` 实测：v1 11 手打空，
   * v4 41 手还没打空）。
   *
   * 现在只驱离**不准备过桥的**：已经在某支进攻编队名册里、且目标还是敌城的人，
   * 允许它站在桥上继续走；其余（守家的、让位的、散兵）照旧驱离。
   * 只对**桥面**放宽，城格（产兵口）不动——堵产兵口是真的不出兵。
   */
  const onBridge = (u: Unit): boolean => tileOn(s, boardIdOf(u), u.x, u.y)?.terrain === 'bridge';
  /*
   * **桥面和桥头都算"在过桥"**（W4-4d-3，2026-11-26）。
   *
   * 关键格里包含桥头那一格陆地，于是兵走到桥头就被"让开"赶下来，永远上不了桥
   * （实测：桥通 20 手，12 个兵一个都没上桥）。
   * 判据不再要求"人在编队名册里"：新造的兵一脚踩上桥头同样会卡住。
   */
  const nearBridge = (u: Unit): boolean => {
    const b = boardIdOf(u);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (tileOn(s, b, u.x + dx, u.y + dy)?.terrain === 'bridge') return true;
    }
    return false;
  };
  const passing = (u: Unit): boolean => onBridge(u) || nearBridge(u);
  /*
   * **工兵也要让路**（W4-4d-3，2026-11-26）。
   *
   * 只数战斗兵时，桥铺通、工兵撤编之后它们就"没有任务"，站在桥头/桥面上一动不动，
   * 把唯一的过道堵死（实测：桥通了 20 手，12 个兵一个都没上桥）。
   * 把工兵也算进"挡路的人"，搬迁计划会把它们挪到旁边去。
   */
  const blockers = [...world.myCombat, ...world.myBuilders].filter(
    (u) => keepSet.has(u.y * s.w + u.x) && !passing(u),
  );
  /*
   * **桥面上的人一律有任务**（W4-4d-3，2026-11-26）。
   *
   * 关键格的本意是"不许停"，桥面也在里面（保护过道）。但兵一旦踩上桥面，
   * 下一手就被 `rest` 排除 → 不再出队 → 站在桥上原地不动，把唯一的通道堵死
   * （实测：桥通 20 手，12 个兵一个都没上桥）。
   * 桥面是**过道**不是停留点：站在上面的人照常出队、继续走，走完自然离开。
   * （`passing` 那个版本还要求"人在编队名册里"，新造的兵一脚踩上去就卡住了。）
   */
  /*
   * **站在关键格上，不等于"没有任务"**（§4.23 步骤 1b，2026-11-27）。
   *
   * 原来这一行按位置过滤：人一站到城圈/桥头/产兵格，就被从所有编队里摘出去。
   * 实测（`probe-yield4 --seat`，全册 39 题）：站在"必须空"格子上的战斗兵 637 人次里
   * **576 是"闲人"**（没落点、没岗位、不在守/工队、打不到人）——他们不是"在集结"，
   * 是**根本不在编队池里**，而让位链是唯一会碰他们的机制（方向随机，89% 离自城更远）。
   *
   * 但只放开池子会让进攻编队把城边的守家兵当新兵吸走（实测 `S-004` 12 兵剩 4）。
   * 所以进门之前先按**名额**判归属，见下面 `reserved`。
   */
  const rest = world.myCombat;

  /*
   * 两座以上城同时受威胁 → 分兵，每城一支队。
   * 只有一座时走原来的单队路径（行为完全不变）。
   */
  /*
   * 被压的城 = 附近有敌军的城。**不看决定类型**：
   * S-013 第一手 decided=expand（不占优，先攒兵），如果只在 press 时才分兵，
   * 八个人会一起在中间集结，两座城一起丢（实测 0/2）。
   */
  const threatened = world.cities.filter((info) =>
    world.foeCombat.some((u) => manhattan(u, info.city) <= 8),
  );
  /*
   * **接管废墟**（`decision.kind === 'takeover'`）：三件事一起定。
   *
   *   · clear：主力照打（走 march，路上遇敌就打），不攒钱——清场要花钱；
   *   · save ：主力守住废墟附近（hold），采购上限压到"金币 − 重建费"；
   *   · enter：从主力里挑**一个**兵走进城格，其余继续守。
   */
  let captureId: string | undefined;
  let captureTarget: { x: number; y: number } | undefined;
  /*
   * 采购上限**由决定层给**（D1，2026-11-25）：这里只往下传，不再自己算"金币 − 重建费"。
   *
   * 为什么挪走：那个数原来是这里算的，而"这一手一分不花"又在入口判了一次，
   * 同一句话两个读者——改一处忘了另一处，就是"不知道哪层错"的来源。
   * 现在决定层一次算完（`decision.spend`），这里和打分层都只是转发。
   */
  /*
   * **有过桥计划才攒修桥钱**（W4-4d-3，2026-11-26；条件按用户口径收窄）。
   *
   * 不预留的话，钱会在"打得顺"的那几手全变成兵，桥一塌一分钱拿不出来
   * （`P-2-03` 实测：900 金在桥通后的 10 手里造了 8 个兵，桥被打掉后修不起）。
   * 但也不能只要"这座城隔着河"就永远扣着一格桥钱——**守城、发展期没有过桥的打算**，
   * 扣着只是让兵造不出来。所以预留要求两件事同时成立：
   *
   *   1. 这条路**真的依赖桥**（`needsBridge`：忽略桥面就走不到）；
   *   2. 这一手的决定**正在过桥**：`bridge`（占岸/架桥）或者 `press`（桥已通、正在推）。
   */
  const bridgePrice = utype(s, 'bridge').cost ?? 45;
  const bridgePlan =
    !!city && (decision.kind === 'bridge' || decision.kind === 'press');
  const reserveGold = bridgePlan && city && world.needsBridge(city) ? bridgePrice : 0;
  const spendCap =
    decision.spend.mode === 'save'
      ? decision.spend.cap
      : reserveGold > 0
        ? Math.max(0, (s.players[world.me]?.gold ?? 0) - reserveGold)
        : undefined;
  /*
   * ════════════════════════════════════════════════════════════════
   * **接管废墟：队伍停在城外，进城只是一件事**（2026-11-27，被拒 422 次的根因）
   *
   * 攒钱链本来就有（`clear` → `save` → `enter`，`spendCap` 压住重建费）。
   * 漏的是**队伍的落脚点**：这些队只有 `cityId = 废墟`，于是 `squadBase`/`targetOf`
   * 都取**城中心**，走到城下就往城格里踩——而进废墟要付重建费，引擎在 MOVE 那一刻才拒。
   * 实测：`S-000` 14 手里被拒 **298 次**、`D-3-01` 30 手里 **112 次**，全册 713 次里 84% 是这一条。
   *
   * 两条修法：
   *   ① **集结点放在城外**（`at` = 离城中心最近的、非城格的可站格）——
   *      城队围着它站，`targetOf` 不再指城中心，最后一步就不会踩进格子里；
   *   ② **钱不够就不指城格**：`captureTarget` 只在付得起重建费时才给。
   *      这是项目自己的分工（"价格与可行性属于计划层"）——引擎那道检查是兜底，不是判据。
   * ════════════════════════════════════════════════════════════════
   */
  if (decision.kind === 'takeover' && city) {
    const center = {
      x: city.x + Math.floor((city.size ?? 2) / 2),
      y: city.y + Math.floor((city.size ?? 2) / 2),
    };
    /* 付得起重建费吗（和引擎同一个函数、同一个 `freeRebuild` 开关） */
    const rebuildPrice = rebuildCost(city, s.config.freeRebuild === true);
    const canEnter = (s.players[world.me]?.gold ?? 0) >= rebuildPrice;
    /* 城外的集结点：离城中心最近、非城格、可站。同一距离取格号小的（可复现） */
    let staging: { x: number; y: number } | undefined;
    {
      const n = city.size ?? 2;
      let bestD = Infinity;
      let bestK = Infinity;
      for (let dy = -1; dy <= n; dy += 1) {
        for (let dx = -1; dx <= n; dx += 1) {
          const x = city.x + dx;
          const y = city.y + dy;
          if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
          const tile = s.tiles[y * s.w + x];
          if (!tile || !passable(tile.terrain)) continue;
          /*
           * **"城格"要按 `cityId` 判，不能按地形判**（2026-11-27 踩的）：
           * 废墟的格子地形已经不是 `city`，只看地形会把集结点选到废墟格上，
           * 队伍照样往城里踩（`D-3-01` 实测：改完还剩 94 次被拒）。
           */
          if (tile.cityId !== null) continue;
          const d = Math.abs(x - center.x) + Math.abs(y - center.y);
          const k = y * s.w + x;
          if (d < bestD || (d === bestD && k < bestK)) {
            bestD = d;
            bestK = k;
            staging = { x, y };
          }
        }
      }
    }
    /*
     * ② **只有 `enter` 段才允许"往城格里走"，而且钱要够**。
     *
     * 清场（`clear`）和攒钱（`save`）段一律不指城格——`clear` 段这一手是要打仗的，
     * 计划时看着够、打起来钱花掉了，最后一步走进废墟就被引擎拒（实测 `S-000`：
     * 光这一条 14 手被拒 298 次）。`enter` 段因为 `spend.mode = 'save'`
     * （上限压到"金币 − 重建费"），钱一定还在，所以那一段才安全。
     */
    captureTarget = decision.stage === 'enter' && canEnter ? center : undefined;
    if (decision.stage === 'enter' && canEnter) {
      /*
       * 派**离废墟最近的那个**去，不派"最强/最贵"的。
       * 走进废墟只看"能不能站进去 + 付不付得起"，谁去都一样；
       * 最近的那个少走两步，被路上的炮打的机会也最少。
       */
      const field = world.stepsFrom(center);
      const pick = [...rest].sort(
        (a, b) =>
          (field[a.y * s.w + a.x] ?? Infinity) - (field[b.y * s.w + b.x] ?? Infinity) ||
          (a.id < b.id ? -1 : 1),
      )[0];
      if (pick) captureId = pick.id;
    }
    /*
     * **打空了就原地转任务：整队保留，只换任务名**（W3.6 第 3a 步，2026-11-26）。
     *
     * 以前这里无条件新建一支 `main`：记忆里的编队名册还在，但没有任何队伍对应它们，
     * 成了孤儿——下一手按目标城一对就全被丢掉（用户看到的"攻城之后编队全部消失"）。
     *
     * 现在：目标城没变（还是这座城，只是从敌城变成废墟），所以
     *   · 任务从"攻城"改成"清场推进"（`march`），清干净后改"守"（`hold`）；
     *   · **名册、编号、人数都不动**，只是这一手的任务换了。
     * 这是所有转换里最便宜的一种：城没变，站位不用重排。
     */
    const restIds = new Set(rest.map((u) => u.id));
    const aliveIds = new Set(world.myCombat.map((u) => u.id));
    const bands = liveBandsOf(mem, city.id, aliveIds);
    const inBand = new Set(bands.flatMap((b) => b.unitIds));
    for (const b of bands) {
      const ids = b.unitIds.filter((id) => restIds.has(id) && id !== captureId);
      if (ids.length === 0) continue;
      const task = taskOf(b.id);
      squads.push({
        id: b.id,
        order: task?.order ?? (decision.stage === 'clear' ? 'march' : 'hold'),
        unitIds: ids,
        cityId: task?.cityId ?? city.id,
        /* 落脚点在城外：城队围着它站，不会往城格里踩（见上面那段注释） */
        at: staging,
        want: b.want ?? ids.length,
      });
    }
    /*
     * 不在编队里的兵（刚造的、原本守城的、被留下让位的）照旧编一支 `main`——
     * 少这一条，接管期就会有一批人站着不动（旧行为是"所有人都在 main 里"）。
     */
    const restMain = rest.filter((u) => !inBand.has(u.id) && u.id !== captureId).map((u) => u.id);
    if (restMain.length > 0) {
      squads.push({
        id: 'main',
        order: decision.stage === 'clear' ? 'march' : 'hold',
        unitIds: restMain,
        cityId: city.id,
        at: staging,
      });
    }
  } else if (threatened.length >= 2 && rest.length >= threatened.length * 2) {
    squads.push(...planMains(s, world, threatened.map((i) => i.city), rest.map((u) => u.id)));
  } else if (decision.kind === 'press' && city) {
    /*
     * **进攻 = 编队**（W3.5，2026-11-26；学 v3 的做法）。
     *
     * 三条硬规矩（用户定）：
     *   ① 编队**出发后不改人数**——名册定下来就不再往里塞人；
     *   ② **全战死才撤编**——还剩一个活着就继续打；
     *   ③ 要补人，就**新组织一队**沿同一条线出发。
     *
     * 为什么不能"一条线一个大队"：那样分不清这一队在不在接敌、该不该开战术模式，
     * 也很容易退化成 v1 那种"全军朝一个地方动"。
     */
    const restIds = new Set(rest.map((u) => u.id));
    const aliveIds = new Set(world.myCombat.map((u) => u.id));
    /** ① **在编的编队**（口径见 `liveBandsOf`）：名册只因为人死了缩小 */
    const live: Band[] = liveBandsOf(mem, city.id, aliveIds);
    const inBand = new Set(live.flatMap((b) => b.unitIds));
    /*
     * ════════════════════════════════════════════════════════════════
     * **归属：先按名额留守军，剩下的才归进攻**（§4.23 步骤 1b）
     *
     * 试过"回自城比去敌城近就归守"（纯几何比较，不要名额）：多的两道红是
     * `X-1-01`/`X-1-02`（打分层地板题）——只要老家有一座 `role==='threatened'` 的城
     * （它的定义含"离敌城 ≤6 且守军 <3"，不一定真挨打），就把人扣下来，进攻队凑不齐。
     *
     * 现在改成**按名额**：用 `defenderQuota`（1a 从 `planMains` 拆出来的那个数）
     * 算出每座被威胁的城要几个，从近到远取够就停；多出来的人照样能去进攻。
     *
     * 而且**留下来的人必须进 hold 队**——只标记"不归进攻"而不给他们队，
     * 他们就又变成闲人（批 0 的账里 96% 让位对象就是这么来的）。
     * ════════════════════════════════════════════════════════════════
     */
    const homePending = world.cities.filter((i) => i.role === 'threatened' && i.city.id !== city.id);
    const reserved = new Set<string>();
    if (homePending.length > 0) {
      const pool = rest.filter((u) => !inBand.has(u.id));
      const quota = defenderQuota(
        s,
        world,
        homePending.map((i) => i.city),
        pool,
      );
      for (const info of homePending) {
        const want = quota.get(info.city.id) ?? 0;
        if (want <= 0) continue;
        const cands = pool
          .filter((u) => !reserved.has(u.id))
          .sort(
            (a, b) =>
              world.marchTurns(a, info.city) - world.marchTurns(b, info.city) || (a.id < b.id ? -1 : 1),
          );
        for (const u of cands.slice(0, want)) reserved.add(u.id);
      }
      /* 留下来的人要有队（`hold`），否则等于把"闲人"从一个池子搬到另一个池子 */
      if (reserved.size > 0) {
        squads.push(...planMains(s, world, homePending.map((i) => i.city), [...reserved]));
      }
    }
    let free = rest.filter((u) => !inBand.has(u.id) && !reserved.has(u.id));
    const minSize = Math.max(1, decision.menMin ?? 1);
    const FORM_TIMEOUT = 10;

    /**
     * ② **收拢中的队伍继续吸收新兵**（学 v3 的 `squadTick`）。
     *
     * 不吸收的话会出现"走 2 人"：编成时手头只有 2 个兵，之后就再也补不进来，
     * 队伍一直是残的，永远凑不够、永远不走。只补到 `want`，不许吸成巨型编队。
     */
    /*
     * **所有收拢中的队伍一起吸收新兵/散兵**（2026-11-26，用户："直接允许任意支队伍同时接收"）。
     *
     * 以前只让"第一支还在收拢的队"吃人（`live.find(...)`），于是第二、第三支队
     * 只能干等——S-001 实测：20 个人被切成 9+9+2，后面两队一直补不上来。
     * v3 那边不限支数，几支队可以同时在路上，这也是它快的原因之一。
     *
     * 每支队仍然只补到自己的 `want`：不封顶会吸成巨型编队（v3 的 `Q2 seed32` 实测）。
     * 顺序按"离城近的队先补"，避免远处的队把近处的人抢走。
     */
    const formingAll = live.filter((b) => (b.state ?? 'forming') === 'forming');
    for (const f of formingAll) {
      if (free.length === 0) break;
      const room = Math.max(0, (f.want ?? f.unitIds.length) - f.unitIds.length);
      if (room === 0) continue;
      const pick = [...free]
        .sort((a, b) => world.marchTurns(a, city) - world.marchTurns(b, city) || (a.id < b.id ? -1 : 1))
        .slice(0, room);
      if (pick.length === 0) continue;
      f.unitIds.push(...pick.map((u) => u.id));
      f.men = (f.men ?? f.unitIds.length - pick.length) + pick.length;
      const taken = new Set(pick.map((u) => u.id));
      free = free.filter((u) => !taken.has(u.id));
    }

    /**
     * ③ **新组一队**：不再"同一时刻只许一支收拢"（2026-11-26）。
     *
     * 前方一支都没有 → 剩几个编几个（不是滴灌，是只剩这些）；
     * 已经有队伍 → 要凑够最小规模才开新队（`menMin` = 打死一个守军），
     * 所以**不会出现"一人一批"**：一个人凑不出最小规模，就不会单独成队。
     *
     * 每手最多新建一支（`free` 是这一手能派的人，建完就没了）。
     */
    const bands: Band[] = [...live];
    if (free.length >= (bands.length === 0 ? 1 : minSize)) {
      const pick = [...free]
        .sort((a, b) => world.marchTurns(a, city) - world.marchTurns(b, city) || (a.id < b.id ? -1 : 1))
        .slice(0, Math.max(1, decision.men ?? free.length));
      /* 这一手能补几个兵：0 = 后面不会有人来，编制就不能写得比手上多 */
      const canFill = world.laneStats(
        world.myCombat.map((u) => u.id),
        world.myCities[0] ?? city,
      ).make;
      bands.push({
        id: `${city.id}#${s.turn}`,
        cityId: city.id,
        formedAt: s.turn,
        /*
         * 编制人数：**前线一支队伍都没有时，编多少就是多少**（这一手就是全部家当，
         * 没有等的理由，等下去只是让敌人先到）；已经有队在打时，才按决定层的目标
         * 慢慢收拢（后面补上来的小队不该一个一个上）。
         *
         * **补不上人时，编制就等于手上这几个**（2026-11-26）。不这么判会死等：
         * S-001 金 0、一个兵也补不出来，可编制写 9，于是一支队 5 个人在集结点
         * 等到 10 手超时才走（40 手只砸掉 25 血）。判据用产兵格的实数，不是猜。
         */
        want:
          canFill > 0 && bands.length > 0
            ? Math.max(pick.length, decision.men ?? pick.length)
            : pick.length,
        state: 'forming',
        men: pick.length,
        unitIds: pick.map((u) => u.id),
      });
    }

    /*
     * ④ 状态推进：凑够编制就走；凑不够等满 `FORM_TIMEOUT` 也走（有多少走多少）。
     * 只等"凑够"的话，钱不够时会永远不出兵——那和"没有编队"一样（v3 的 10 手超时）。
     */
    for (const b of bands) {
      if ((b.state ?? 'forming') !== 'forming') continue;
      if (b.unitIds.length >= (b.want ?? b.unitIds.length) || s.turn - b.formedAt >= FORM_TIMEOUT) {
        b.state = 'marching';
      }
    }

    for (const b of bands) {
      /*
       * 这一手**能派出去的**只是名册里不在关键格上、也没被留作守城的人；
       * 名册本身不变——站错格子的兵下一手还会回来（它只是这一手去让开）。
       */
      const ids = b.unitIds.filter((id) => restIds.has(id));
      const us = ids
        .map((id) => s.units.find((u) => u.id === id))
        .filter((u): u is Unit => !!u);
      /*
       * 全队这一手都站在关键格上（产兵格/城门口）：不撤编，但**得给个任务**。
       *
       * 以前这里直接 `continue`，于是这支队这一手"没有任何任务"——不打架也不动。
       * P-1-02 实测：两个兵站在产兵格上，从第 6 手站到第 10 手，敌人就在城下，
       * 一次攻击都没出，`foeLost` 判红。
       * 现在给一条"回集结点"的任务：既离开了关键格（把产兵口让出来），
       * 下一手也自然回到 `rest`、恢复正常任务。
       */
      if (us.length === 0) {
        squads.push({
          id: b.id,
          order: 'assemble',
          unitIds: b.unitIds,
          at: assemblePoint(s, world, city.id),
        });
        continue;
      }
      const etas = us.map((u) => world.marchTurns(u, city)).sort((a, b2) => a - b2);
      const eta = etas[etas.length - 1] ?? Infinity;
      const lead = [...us].sort((a, b2) => world.marchTurns(a, city) - world.marchTurns(b2, city))[0];
      const detour = lead ? world.marchTurns(lead, city) > manhattan(lead, city) + 2 : false;
      /*
       * **没到齐先收拢**：编队是"一批人一起上去"，散着走会被各个击破。
       * 两回合内八成人能到城下就走（不让慢的拖住全队），否则先去集结点集合。
       */
      /* 能走不能走，看编队自己的状态（W3.6）；不再拿"新队的目标人数"去卡老兵 */
      const ready = (b.state ?? 'forming') === 'marching';
      const task = taskOf(b.id);
      squads.push({
        id: b.id,
        /* 任务由决定层给（清场 march / 攻城 siege）；没到齐先去集结点 */
        order: ready ? (task?.order ?? (decision.stage === 'clear' ? 'march' : 'siege')) : 'assemble',
        at: ready ? undefined : assemblePoint(s, world, city.id),
        unitIds: ids,
        cityId: task?.cityId ?? city.id,
        want: ids.length,
        eta: Number.isFinite(eta) ? eta : 99,
        /* 战术开关**按编队各自判**：一队在接敌、另一队还在路上，不该互相带开关 */
        tactics: planTactics(s, ids, decision.stage === 'clear'),
        detour,
        ...(planColumns(s, world, ids, city) ?? {}),
      });
    }
    outBands = bands;
    /*
     * **缺口回传采购**（W3.6 第 5 步）：在编队的编制之和 + 一支预备队。
     * 采购按这个数发单：补满编制、再留一批，不再"能造就一直造"。
     */
    if (bands.length > 0) {
      outBandNeed = {
        keep: bands.reduce((n, b) => n + (b.want ?? b.unitIds.length), 0),
        men: decision.men ?? 0,
      };
    }
  } else if (decision.kind === 'bridge' && decision.bridge) {
    /*
     * **架桥：先头部队占岸，工兵后到**（W4-4d-2，2026-11-26）。
     *
     * 用户定的顺序：工兵先跑到河边会被守军打死，所以
     *   · `seize`：只有战斗兵动——按现有的编队名册去渡口的岸上列阵；
     *   · `build`：岸上有自己人、敌人两回合摸不到，才把工兵放出去。
     *
     * 战斗兵的目标是一个**点**（`at`），不是城——城在河对岸，走不过去。
     * 所以这一支的 `cityId` 留空、只给 `at`，`squadBase` 会优先用它。
     */
    const st = decision.bridge.stand;
    const stage = decision.bridge.stage;
    const restIds = new Set(rest.map((u) => u.id));
    const aliveIds = new Set(world.myCombat.map((u) => u.id));
    const bands = liveBandsOf(mem, null, aliveIds);
    const inBand = new Set(bands.flatMap((b) => b.unitIds));

    /** 一支队去渡口：任务 march、目标点 = 给的点（战斗兵用陆地岸，工兵用桥头） */
    const pushToBank = (
      id: string,
      ids: string[],
      want?: number,
      to: { x: number; y: number } = decision.bridge!.bank,
    ): void => {
      if (ids.length === 0) return;
      const us = ids
        .map((uid) => s.units.find((u) => u.id === uid))
        .filter((u): u is Unit => !!u);
      if (us.length === 0) return;
      const eta = us.reduce((n, u) => Math.max(n, world.marchTurns(u, to)), 0);
      squads.push({
        id,
        order: 'march',
        unitIds: ids,
        at: to,
        want: want ?? ids.length,
        eta: Number.isFinite(eta) ? eta : 99,
        tactics: planTactics(s, ids, true),
      });
    };

    if (bands.length === 0) {
      /*
       * 还没编过队：现成的战斗兵一起过去（开局第一波）。
       * 同时**把这批人记成一支编队**——不记的话，桥没架好之前 `[band]` 一直是空的，
       * 回放里看不出"哪批人在河边站着"，下一手也只能当"没编过队"重新来一遍。
       */
      const ids = rest.map((u) => u.id);
      pushToBank('main', ids);
      if (ids.length > 0) {
        outBands = [
          {
            id: 'main',
            cityId: decision.bridge.cityId,
            formedAt: s.turn,
            unitIds: ids,
            state: 'marching',
            want: ids.length,
            men: ids.length,
          },
        ];
      }
    } else {
      /*
       * 名册里的队去岸边；不在名册里的兵并进同一支（**不能另建一支同名的 `main`**——
       * 上一版就撞了：`main:11` 和 `main:2` 两支同 id 的队在场上，谁也不知道谁是谁）。
       */
      const leftover = rest.filter((u) => !inBand.has(u.id)).map((u) => u.id);
      const hasMain = bands.some((b) => b.id === 'main');
      for (const b of bands) {
        const own = b.unitIds.filter((id) => restIds.has(id));
        pushToBank(b.id, b.id === 'main' ? [...own, ...leftover] : own, b.want);
      }
      if (!hasMain && leftover.length > 0) pushToBank('main', leftover);
      outBands = bands;
    }

    /*
     * 工兵：**只在 `build` 阶段放出去**，而且最多 2 个、按离渡口近的挑。
     * 它们不进 `bands`（那是战斗编队），单独记在 `buildBand` 里，桥通了就撤。
     */
    if (stage === 'build' && world.myBuilders.length > 0) {
      const prev = mem?.buildBand;
      const alive = (prev?.unitIds ?? []).filter((id) => world.myBuilders.some((b) => b.id === id));
      const pick =
        alive.length > 0
          ? alive
          : [...world.myBuilders]
              .sort((a, b) => world.marchTurns(a, st) - world.marchTurns(b, st) || (a.id < b.id ? -1 : 1))
              .slice(0, 2)
              .map((b) => b.id);
      if (pick.length > 0) {
        outBuildBand = {
          id: prev?.id ?? `build-${s.turn}`,
          unitIds: pick,
          cityId: decision.bridge.cityId,
          formedAt: prev?.formedAt ?? s.turn,
        };
        /*
         * 工兵的任务是 `build`，不是 `march`：目标点 = 岸（可站），
         * 要修的那一格单独给（水面，站不上去）。**它不走方阵**——`planMarch` 跳过 build 队，
         * 由打分层一步一格朝岸边走，到建造距离内就 `BUILD`。
         */
        const eta = pick.reduce((n, id) => {
          const b = s.units.find((x) => x.id === id);
          return b ? Math.max(n, world.marchTurns(b, st)) : n;
        }, 0);
        squads.push({
          id: outBuildBand.id,
          order: 'build',
          unitIds: pick,
          at: st,
          buildAt: decision.bridge.at,
          want: 2,
          eta: Number.isFinite(eta) ? eta : 99,
          tactics: planTactics(s, pick, false),
        });
      }
    }

    /*
     * **架桥要有人铺**（W4-5a，2026-11-26）：这条决定得落到"买一个能铺桥的人"上。
     *
     * 计划层只问三件能数的事，不问"值不值"：
     *   · 城里造不造得出来 —— 引擎的 `produceAt`（时代/白名单/选卡）+ 出兵格有没有空；
     *   · 钱够不够 —— `recruitCost`；
     *   · 手上有没有 —— `world.myBuilders`。
     *
     * **有工兵就不下单**：否则每一手都买一个，钱全变成工兵。
     * **挑最便宜的**：一架桥只要 8 点工，谁铺都是铺；钱省下来才是桥钱
     * （同价再挑离渡口近的，少走几手、少挨几炮）。
     *
     * 排在这里（而不是 `stage === 'build'` 里面）：`build` 段的意思是"岸边有人了、
     * 该工兵上了"，可**工兵得先有**。等岸边站满人才开始造，等于把整条链拖后 3~5 手；
     * 而且 v4 原来就是在这里空转——22 手连着判"要架桥"，一个工兵都没造。
     */
    if (world.myBuilders.length === 0) {
      const gold = s.players[world.me]?.gold ?? 0;
      const pick = world.myCities
        .filter((c) => !c.ruined)
        .flatMap((c) =>
          Object.values(s.unitTypes)
            .filter((d) => d.category === 'builder' && (d.builds ?? []).includes('bridge'))
            .filter((d) => produceAt(s, { kind: 'city', city: c }, d).ok)
            .filter((d) => recruitSpawnCells(s, c.id, undefined, d.id).length > 0)
            .map((d) => ({ cityId: c.id, unitType: d.id, cost: recruitCost(s, world.me, d) }))
            .filter((x) => x.cost <= gold)
            .map((x) => ({ ...x, turns: world.marchTurns({ x: c.x, y: c.y }, st) })),
        )
        .sort(
          (a, b) =>
            a.cost - b.cost ||
            a.turns - b.turns ||
            (a.cityId < b.cityId ? -1 : a.cityId > b.cityId ? 1 : 0),
        )[0];
      if (pick) outRecruitBuilder = { cityId: pick.cityId, unitType: pick.unitType };
    }
  } else if (decision.kind === 'defend' && city) {
    /*
     * **守：编队整队召回；太远的继续打**（W3.6 第 3b 步，2026-11-26）。
     *
     * 以前这里无条件把 `rest` 全部收成一支 `recall`——正在攻城的编队被顶掉，
     * 名册成孤儿（和"攻城后编队消失"是同一个病）。
     *
     * 现在按编队处理，判据只有一条：**回得去吗**。
     *   · 回得去 → 这支队任务改"守"，目标改自家城，名册不动；
     *   · 回不去 → 不切任务，继续打它原来的城。
     * "回得去"用距离场算（`marchTurns`），期限用"城还能撑几轮"（`defensible.rounds`）——
     * 没有"8 格以内"这种死数字。用户 2026-11-26：队伍太远就不必切换任务。
     */
    const restIds = new Set(rest.map((u) => u.id));
    const aliveIds = new Set(world.myCombat.map((u) => u.id));
    /*
     * **要守的城可能不止一座**（2026-11-26 23:00，分兵）。
     *
     * `decision.cityId` 是最急的那座，`holdAlso` 是同一手也要人的其余几座。
     * 单城局面下 `guards` 只有一座，下面的分支和以前逐字节一样。
     */
    const guards = [city, ...(decision.holdAlso ?? [])]
      .map((c) => (typeof c === 'string' ? s.cities.find((x) => x.id === c) : c))
      .filter((c): c is City => !!c && c.ruined !== true);
    /** 这个人离哪座要守的城最近（按真实步数，不是直线） */
    const guardOf = (u: Unit): City =>
      guards.reduce(
        (best, c) => (world.marchTurns(u, c) < world.marchTurns(u, best) ? c : best),
        guards[0]!,
      );
    const bands = liveBandsOf(mem, null, aliveIds);
    for (const b of bands) {
      const target = s.cities.find((c) => c.id === b.cityId);
      /* 只处理"正在打敌城"的队：守家的、接管的、目标已不属于敌人的都不谈转守 */
      if (!target || target.ruined === true || (target.owner && target.owner === world.me)) continue;
      const ids = b.unitIds.filter((id) => restIds.has(id));
      if (ids.length === 0) continue;
      const us = ids
        .map((id) => s.units.find((u) => u.id === id))
        .filter((u): u is Unit => !!u);
      /* 整队回**离它最近的那座**要守的城（分兵时不再一律回 `city`） */
      const dest = guards.length > 1 ? guardOf(us[0]!) : city;
      const destOut = world.defensible(dest);
      const destDeadline = Number.isFinite(destOut.rounds) ? Math.max(1, destOut.rounds) : Infinity;
      /* 全队一起走：取最慢的那个（骑兵不能把步兵丢在后面） */
      const eta = us.reduce((n, u) => Math.max(n, world.marchTurns(u, dest)), 0);
      const task = taskOf(b.id);
      if (eta <= destDeadline) {
        squads.push({
          id: b.id,
          order: task?.order ?? 'hold',
          unitIds: ids,
          cityId: task?.cityId ?? dest.id,
          /* 召回：先回城（S-004 的规矩），所以只给集火、不给挪位 */
          tactics: planTactics(s, ids, false),
        });
      } else {
        squads.push({
          id: b.id,
          order: 'march',
          unitIds: ids,
          cityId: b.cityId,
          want: b.want ?? ids.length,
          tactics: planTactics(s, ids, true),
        });
      }
    }
    /* 不在编队里的兵（刚造的、守家的）收回城下；分兵时各回各的近的那座 */
    const inBand = new Set(bands.flatMap((b) => b.unitIds));
    const loose = rest.filter((u) => !inBand.has(u.id));
    if (guards.length > 1) {
      for (const g of guards) {
        const ids = loose.filter((u) => guardOf(u).id === g.id).map((u) => u.id);
        if (ids.length === 0) continue;
        squads.push({
          id: `hold-${g.id}`,
          order: 'hold',
          unitIds: ids,
          cityId: g.id,
          tactics: planTactics(s, ids, false),
        });
      }
    } else if (loose.length > 0) {
      /*
       * **适当主动防御**（2026-11-26 23:40，用户定）。
       *
       * 原来的守 = 全钉在城格上等敌人来打。城格只有 n×n 个，站进去的人还得跟产兵格抢地方，
       * 而且"站着挨打"本身不产生任何输出（`D-3-01` 实测：10 个人全在城里，8 个敌人
       * 一个一个把城打穿；人手答案是迎上去在城外打）。
       *
       * 现在分两拨：**城里留 2 个**（吃 +3 护甲、占住城格），其余站到城与敌人之间迎击。
       * 只有 `loose` 的人数超过 2 才分——人不够时行为一个字不变。
       */
      const insideMax = 2;
      /*
       * **只在敌人还没贴脸时才出城迎击**（2026-11-26 23:45）。
       *
       * 敌人已经站在城下时，城格的 +3 护甲就是唯一的便宜，这时候分人出去等于白送
       * （实测 `D-1-01`/`D-1-03`：4 个人守城，分成 2 里 2 外之后两道题一起翻红）。
       * 判据用的还是那个数：城的 `foeEta <= 1` = 敌人下一手就能摸到。
       */
      const atGate = (world.cities.find((c) => c.city.id === city.id)?.foeEta ?? Infinity) <= 1;
      const sortedLoose = [...loose].sort(
        (a, b) => world.marchTurns(a, city) - world.marchTurns(b, city) || (a.id < b.id ? -1 : 1),
      );
      if (atGate || sortedLoose.length <= insideMax) {
        const recallIds = sortedLoose.map((u) => u.id);
        squads.push({
          id: 'recall',
          order: 'hold',
          unitIds: recallIds,
          cityId: city.id,
          tactics: planTactics(s, recallIds, false),
        });
      } else {
        const stay = sortedLoose.slice(0, insideMax).map((u) => u.id);
        const outIds = sortedLoose.slice(insideMax).map((u) => u.id);
        squads.push({
          id: 'hold',
          order: 'hold',
          unitIds: stay,
          cityId: city.id,
          tactics: planTactics(s, stay, false),
        });
        /*
         * 迎击位：城心朝最近敌人的方向退 2 格（走不过去就退 1 格）。
         * 站那儿的意义是"敌人到城下之前先接火"，不是"多走两步好看"。
         */
        const foe = [...world.foeCombat].sort(
          (a, b) => world.marchTurns(a, city) - world.marchTurns(b, city) || (a.id < b.id ? -1 : 1),
        )[0];
        const n = city.size ?? 2;
        const cx = city.x + Math.floor(n / 2);
        const cy = city.y + Math.floor(n / 2);
        const dx = foe ? Math.sign(foe.x - cx) : 0;
        const dy = foe ? Math.sign(foe.y - cy) : 0;
        const far = { x: cx + dx * 2, y: cy + dy * 2 };
        const near = { x: cx + dx, y: cy + dy };
        const okFar = passable(tileOn(s, EARTH, far.x, far.y)?.terrain ?? 'water');
        const at = foe && okFar ? far : foe ? near : undefined;
        squads.push({
          id: 'guard',
          order: at ? 'march' : 'hold',
          unitIds: outIds,
          cityId: city.id,
          ...(at ? { at } : {}),
          want: outIds.length,
          tactics: planTactics(s, outIds, true),
        });
      }
    }
  } else {
    /*
     * **发展只管钱和后方，不改前线的任务**（W3.6 第 3c 步，2026-11-26）。
     *
     * 以前这里无条件 `main: assemble`（所有人回城集合），于是"打 → 发展 → 打"每次翻一次，
     * 正在攻城的编队就要走一趟回头路——S-001 第 8/10/18 手就是这么来回走的，
     * 40 手打不完不是打不动，是走掉了。
     *
     * 现在：有任务的编队照旧打它自己的城；没有任务的兵（新造的、守家的）才回城集合。
     */
    const restIds = new Set(rest.map((u) => u.id));
    const aliveIds = new Set(world.myCombat.map((u) => u.id));
    const bands = liveBandsOf(mem, null, aliveIds);
    const inBand = new Set(bands.flatMap((b) => b.unitIds));
    for (const b of bands) {
      const task = taskOf(b.id);
      if (!task) continue;
      const ids = b.unitIds.filter((id) => restIds.has(id));
      if (ids.length === 0) continue;
      const target = s.cities.find((c) => c.id === task.cityId);
      if (!target) continue;
      const us = ids
        .map((id) => s.units.find((u) => u.id === id))
        .filter((u): u is Unit => !!u);
      if (us.length === 0) continue;
      const etas = us.map((u) => world.marchTurns(u, target)).sort((a, b2) => a - b2);
      const eta = etas[etas.length - 1] ?? Infinity;
      const lead = [...us].sort((a, b2) => world.marchTurns(a, target) - world.marchTurns(b2, target))[0];
      const detour = lead ? world.marchTurns(lead, target) > manhattan(lead, target) + 2 : false;
      squads.push({
        id: b.id,
        order: task.order,
        unitIds: ids,
        cityId: task.cityId,
        want: b.want ?? ids.length,
        eta: Number.isFinite(eta) ? eta : 99,
        tactics: planTactics(s, ids, task.order !== 'hold'),
        detour,
        ...(planColumns(s, world, ids, target) ?? {}),
      });
    }
    const at = assemblePoint(s, world, world.myCities[0]?.id ?? '');
    const freeIds = rest.filter((u) => !inBand.has(u.id)).map((u) => u.id);
    squads.push({ id: 'main', order: 'assemble', unitIds: freeIds, at });
  }

  /* 造兵：不造经济兵以外的东西时，经济兵不设约束（它们自己站格子产金） */
  const forbid: string[] = [];
  if (decision.kind === 'press') forbid.push('DISBAND');

  /*
   * 采购门槛：从**看得见的敌军**里读（不限于某一座城的守军）。
   *
   * 两条不等式：挨得住一发（hp > 对面最高单发）、三发能打穿（3×atk ≥ 对面最厚血）。
   * 守城时也要用它——而守城时没有 `main` 队，所以这条挂在约束层、不挂在某支队上。
   */
  const foes = world.foeCombat;
  /*
   * **有敌人就按"够用"筛，不再看人数。**（2026-11-25，P1）
   *
   * 原来这里有一道 `outnumbered = myCombat.length <= foes.length`——只有"人数不占优"
   * 才启用质量门槛。那是个正反馈陷阱：**买便宜兵 → 人数上去了 → 门槛关掉 → 继续买便宜兵**。
   * 实测 S-001 造 21 个 1 代民兵、S-002 造 45 个、S-011 造 8 个（`V4-CODE-MAP` 9.17）。
   *
   * 用户 2026-11-25 的判断："人数明显占优时仍允许堆量"这句话本身有问题——
   * 人类会去**基建出最强的单位来堆**，不会靠"血少攻低的单位"堆：
   * 血少的会被带溅射的一次清掉，攻低的完全打不动高护甲。
   * 所以人数不再参与"要不要讲质量"的判断；"堆不堆量"是**数量够不够**的问题，
   * 由需求（`planMains` 的 want）管，不该混进采购。
   *
   * ⚠️ S-002 当年正是因为这条门槛从绿变红，才写下"数量就是答案"。用户 2026-11-25 澄清：
   * 那道题太综合、他打都不需要造新兵，所以那个结论不成立，**不要为它保留例外**。
   */
  /*
   * **闸 1：打得穿吗**（2026-11-25，P2-2a）
   *
   * 判据：拿这个兵种打**多数决目标**（数量最多的那一类敌人），
   * `previewAttack` 的伤害 ×3 ≥ 目标的血——**三发能打穿它**。
   *
   * 为什么不是"伤害 ≥1"：那太松，民兵对 4 代戟兵一发 8、46 血要 6 发才倒，
   * 实测就是"造了一堆打不动的"（S-001 一度从绿变红）。
   *
   * 为什么沿用 3 而不是 4 或 6：P1 已经用"三发打穿"验证过整套行为（S-012 转绿、
   * S-001 损 13）。2a 只换**算法**（`atk−armor` → `previewAttack`，让破甲算进来），
   * 不动阈值——一次只改一件事，否则读数变了不知道是哪个造成的。
   *
   * 为什么用 `previewAttack` 而不是 `atk − armor`：引擎的能力（破甲 7 个兵有、
   * 盾墙）都在它里面。实测火枪打坦克：23−10=13，但 `previewAttack` 给 16（破甲生效）。
   *
   * 为什么对"多数决"而不是"最硬"：混编里放一个坦克，按最硬判会把所有候选都否掉，
   * 结果是一手不造、被杂兵推平。**打不动硬点不等于没输出**，硬点交给破甲兵或绕开。
   *
   * 伤害与攻方位置无关（实测四个位置结果一致），所以这里用模板单位算，不需要真单位。
   */
  const mainFoe = (() => {
    const byType = new Map<string, { n: number; u: (typeof foes)[number] }>();
    for (const u of foes) {
      const rec = byType.get(u.type) ?? { n: 0, u };
      rec.n += 1;
      /* 同类型里取血最厚的那个当代表（同一兵种血量可能不同） */
      if (u.hp > rec.u.hp) rec.u = u;
      byType.set(u.type, rec);
    }
    return [...byType.values()].sort((a, b) => b.n - a.n || b.u.hp - a.u.hp)[0]?.u;
  })();
  const usable = mainFoe
    ? Object.values(s.unitTypes)
        .filter((d) => d.category === 'combat')
        .filter((d) => {
          const probe = {
            id: '__probe',
            owner: s.current,
            type: d.id,
            x: mainFoe.x,
            y: mainFoe.y,
            hp: d.maxHp,
          } as Unit;
          return previewAttack(s, probe, mainFoe).toDefender * 3 >= mainFoe.hp;
        })
        .map((d) => d.id)
    : [];
  /*
   * **闸 2：活得到吗**（2026-11-25，P2-2b；用户给的口径）
   *
   * 只算**在敌方射程内走的那一段**：
   *   暴露距离 = 敌方射程 − 我的射程        （≥0 才有意义；我的射程更长就不用走进来）
   *   暴露手数 = ceil(暴露距离 / 我的移动力)
   *   挨打     = 暴露手数 × 敌方单发 × burst
   *   活得到   = 挨打 < 我的血
   *
   * 为什么不从"城"算起：从城到战场那段在敌方射程外，**不挨打**，计进去等于把
   * "路远"当成"会死"，会把所有兵都否掉。用户的原话是"从敌方射程外的一格走到敌人位置"。
   *
   * 为什么这个口径能复用到进攻：进攻时同样是"穿过对面的射程去够它"，同一个式子。
   *
   * 移动力在这里才是真的有用：骑手（移动 3）穿过 3 格暴露区只要 1 手，
   * 长枪（移动 2）要 2 手——同样的距离，一个活一个死。这正是"移动快"的价值。
   */
  const survivable = mainFoe
    ? Object.values(s.unitTypes)
        .filter((d) => d.category === 'combat')
        .filter((d) => {
          const mine = {
            id: '__probe2',
            owner: s.current,
            type: d.id,
            x: mainFoe.x,
            y: mainFoe.y,
            hp: d.maxHp,
          } as Unit;
          /* 敌方打我一发多少（注意方向：攻方是敌人，守方是我） */
          const hit = previewAttack(s, mainFoe, mine).toDefender;
          if (hit <= 0) return true;
          const gap = Math.max(0, (utype(s, mainFoe.type).range ?? 1) - (d.range ?? 1));
          const steps = Math.ceil(gap / Math.max(1, d.move ?? 1));
          const burst = utype(s, mainFoe.type).burst ?? 1;
          return steps * hit * burst < d.maxHp;
        })
        .map((d) => d.id)
    : [];
  /*
   * **每格输出**（2026-11-25，P2-2c）：池内按哪个数比，由"瓶颈"决定。
   *
   * 守城时能站人的地方就是城的格子（2×2 只有 4 格）——钱再多也放不下第五个。
   * 所以这时候要比的是"**这一格能打出多少**"，不是"每一金能打出多少"：
   *
   *     每格输出 = 我对多数决目标的伤害 × 它要挨几下才倒
   *
   * 为什么"挨几下"要进乘法：一个兵站在城里，它的贡献是"能开火几轮"。
   * 血厚 = 多站几轮 = 更多发。这也是血在这个游戏里唯一的意义（护甲已经算进伤害）。
   *
   * 为什么不除价格（和 `DESIGN-PURCHASE-CRITERIA` 的"每金"不同）：
   * P1 实测过——价格一做分母就选回 1 代民兵（S-001 造 21 个、S-002 造 45 个）。
   * 钱是瓶颈的时候，正确做法是"**买得起的最强**"，不是"性价比最高"。见 `V4-CODE-MAP` 9.19。
   */
  /*
   * 瓶颈只有两种，**由"钱够不够填满格子"判**，不是打分：
   *
   *   · 守（`defend`）**且**这笔钱能把城格全填上最强的兵 → `cell`（每格）；
   *   · 其余 → `gold`（买得起的最强，价格只在同分时做最后一档）。
   *
   * ── 为什么"守城"还不够（2026-11-25 实测踩出来的）──
   *
   * 第一版是"只要决定是守就按每格"，结果 **S-012 / P-1-01 / P-1-02 三道一起红**：
   * 每格口径会挑**最贵的强兵**（骠骑兵 150），300 金只买得起 2 个 —— 城格的 4 个只填了 2 个，
   * 而 3 个戟兵（300）能填 3 个。**"每格"的前提是钱能把格子填满**；填不满的时候，
   * 真正的瓶颈还是钱（这是一个背包问题，贪心解就是"每金最划算"，而 P1 已经证过那条路
   * 会选回民兵）。所以只在"钱够填满"时才换成每格口径。
   *
   * 也**不做**"能站的格子数 < 想造的兵数"那条更泛的判据：现在只有城格会紧，
   * 别的场景没有题能证明它需要区分（宁可少一条没有读数的规则）。
   */
  const cityCells = city ? cityTiles(city).length : 0;
  const bestPrice = usable
    .filter((t) => survivable.includes(t))
    .reduce((n, t) => Math.max(n, utype(s, t).cost ?? 0), 0);
  /*
   * **瓶颈只看"钱够不够把空着的产兵格填满"，与决定类型无关**（S2，2026-11-27）。
   *
   * 原来是 `decision.kind === 'defend' && 钱 ≥ 城格数 × 最强兵价`，于是"4000 金 + 4 格"
   * 的进攻局面被判成钱紧、按每金买便宜的，战力被摊薄（`E-2-03`/`E-2-05` 实测翻红）。
   * 现在按用户原话判：**钱买得起的东西装不进空着的格子 = 格子紧**。
   */
  const freeCells = city
    ? cityTiles(city).filter((p) => !s.units.some((u) => u.x === p.x && u.y === p.y)).length
    : cityCells;
  const bottleneck: 'cell' | 'gold' =
    freeCells > 0 && bestPrice > 0 && (s.players[world.me]?.gold ?? 0) >= freeCells * bestPrice
      ? 'cell'
      : 'gold';

  const need =
    foes.length > 0
      ? {
          /** 对多数决目标"三发能解决"的兵种（闸 1 的唯一口径） */
          usable,
          /** 穿过敌方射程时活不下来的兵种（闸 2：见上面的 `survivable`） */
          survivable,
          /*
           * **能不能"充数"**（2026-11-25，用户原话）：
           * "敌方射程大但无溅射无多段 → 最后才是用许多不符合要求的兵充数、以伤换伤；
           *  但敌方有多段或溅射，连这条也要排除，得尽量散开。"
           *
           * 所以"买一堆打不动的便宜兵"不是无条件的兜底：
           * 敌方有**溅射**（一发清一片）或**多段**（一回合多次）时，充数是负资产。
           * 这条只影响"没有候选时要不要凑数"，不影响正常挑选。
           */
          canPad:
            !foes.some((u) => {
              /* 溅射/多段是兵种自身属性，`effectiveStats` 不带它们，直接读定义 */
              const d = utype(s, u.type);
              return (d.splash ?? 0) > 0 || (d.burst ?? 1) > 1;
            }) &&
            /*
             * **但要"值得凑"才凑**（2026-11-25 23:05）。
             *
             * 上面那条只排除"凑了也是送"（溅射/多段）。实际还有一类"凑了没用"：
             * 敌人远在 20 手外、我方还在发展期——这时候买一堆打不动的便宜兵
             * 既走不到战场、又挤掉经济兵。E-2-02 实测：允许凑数之后经济产出 107→95。
             *
             * 所以凑数只在这种时候成立：
             *   · 决定层要打（`press`）——凑数是为了**堆量**（S-001 的 18 个人过河、S-009 补损耗）；
             *   · 或者敌人 4 手内能摸到城——凑数是为了**顶住**（D 轨那些贴脸的局）。
             * 两条都不满足，就是"没仗可打"，钱该留给经济或攒着。
             */
            (decision.kind === 'press' ||
              world.myCities.some((c) => world.foeEta({ x: c.x, y: c.y }) <= 8)),
          /* 对面最大射程：压不过它就没有"先手"，排序要改比血（见 tactics 的 byRange） */
          range: foes.reduce((n, u) => Math.max(n, effectiveStats(s, u).range ?? 1), 0),
          bottleneck,
        }
      : undefined;

  const econPlan = planEconPosts(s, world, mem);
  /*
   * 这一手"有没有人真要用关键格"——决定要不要赶人（见 `planYield` 顶部）。
   *
   * · 产兵口：这城现在买得起至少一个兵（战斗或经济），说明接下来可能要造。
   *   **挨打的城也算**（2026-11-25 清 9.13）：原来这里写的是 `info.role !== 'threatened'`，
   *   理由是"被压着的城造不出来"——引擎里没有这条，被围的城照样能造兵（见 9.13）。
   * · 出门通道：有队伍**有兵**且任务是出去（收拢/推进/攻城）。空队伍（0 人）不算——
   *   S-015 那种一条人烟的题里，"main 收拢 0 人"会让城圈一直被赶。
   */
  const gold = s.players[world.me]?.gold ?? 0;
  const spawn = world.cities.some(
    (info) => world.affordableCombat(info.city, gold).length > 0 || !!econPlan.next,
  );
  const exit = squads.some(
    (q) => q.unitIds.length > 0 && (q.order === 'march' || q.order === 'siege' || q.order === 'assemble'),
  );

  /*
   * **临时调令**：挡路兵自己该往哪走（见 `planTransit` 顶部）。
   *
   * 排在 `planYield` 之前：它要进 `planYield` 的"正在动"名单，
   * 否则同一只手会既给它一个"朝前线"的落点、又给它一个"去最近空格"的落点，
   * 两个方向打架，最后一步也不走（那正是 9.18 之前的症状）。
   */
  const transit = planTransit(s, world, decision, squads, blockers, captureTarget);

  const marched = planMarch(s, world, squads);
  const yieldMoves = planYield(s, world, keepClear, squads, { spawn, exit }, Object.keys(transit));
  /* 发展期 T（C1）：只算 + 打印，不接判断。见 `planHorizon` */
  const horizon = planHorizon(s, world, squads);
  if (process.env.V4_HORIZON_LOG && s.turn === 1) {
    const md = Math.min(
      ...world.myCities.flatMap((a) => world.foeCities.map((b) => manhattan({ x: a.x, y: a.y }, { x: b.x, y: b.y }))),
    );
    const ms = Math.min(
      ...world.myCities.flatMap((a) => world.foeCities.map((b) => world.marchTurns({ x: a.x, y: a.y }, { x: b.x, y: b.y }))),
    );
    const t =
      horizon === undefined
        ? 'T=无'
        : horizon.source === 'squad'
          ? `left=${horizon.left}（看到第 ${s.turn + horizon.left} 手，编队 ${horizon.n}人）`
          : `left=${horizon.left}（看到第 ${s.turn + horizon.left} 手，地图 ${horizon.steps}步/${horizon.move}速）`;
    console.error(
      `[horizon] ${s.w}x${s.h} 城距=${Number.isFinite(md) ? md : '-'}(曼)/${Number.isFinite(ms) ? ms : '-'}(步) ${t} 决定=${decision.kind}`,
    );
  }
  /*
   * **发展期投影**（C2）：扫 k = 0..T，看"经济投到第 k 手"在 T 时刻的战力/收入。
   * 只打印，不接动作——验收是"人工手算能对上"。见 `docs/PLAN-V4-PHASE2` 的 C2。
   */
  if (process.env.V4_PROJECT_LOG && s.turn === 1 && horizon) {
    const spots = world.econSpots().map((x) => ({ type: x.type, yield: x.yield, turns: x.turns, gold: x.gold }));
    const picks: Array<{ type: string; gold: number; worth: number }> = [];
    const seenType = new Set<string>();
    for (const c of world.myCities) {
      for (const o of world.affordableCombat(c, Number.MAX_SAFE_INTEGER)) {
        if (seenType.has(o.type)) continue;
        seenType.add(o.type);
        picks.push({ type: o.type, gold: o.gold, worth: unitWorthOfType(s, o.type) });
      }
    }
    const pts = projectEconUntil({
      T: horizon.left,
      gold: s.players[world.me].gold,
      income: incomeNow(s, world),
      spots,
      combat: picks,
      soldierSlots: world.myCities.reduce(
        (n, c) => n + cityTiles(c).filter((p) => !s.units.some((u) => u.x === p.x && u.y === p.y)).length,
        0,
      ),
    });
    const best = bestProjection(pts);
    console.error(
      `[project] T=${horizon.left} 金=${s.players[world.me].gold} 收入=${incomeNow(s, world)} 在场战力=${Math.round(
        world.myCombat.reduce((n, u) => n + unitWorth(s, u), 0),
      )} 岗=${spots.length} 兵种=${picks.map((p) => `${p.type}:${p.gold}`).join(',')} 最优k=${best?.k ?? '-'}`,
    );
    for (const p of pts) {
      console.error(
        `[project]   k=${p.k} 经济${p.econN} 兵${p.armyN} 末金${Math.round(p.gold)} 收入${Math.round(p.income)} 战力${Math.round(p.worth)}`,
      );
    }
    /*
     * **敏感性：把窗口拉到 20 手再看一次。**
     *
     * 12×12 的贴脸题 T 只有 6~9 手，8 手里投经济不可能赚回战力，所以最优 k 恒为 0——
     * 这不是模型错，是窗口太短。真实 24×24 上 T 到 20+，"先发展再出兵"才会翻过来。
     * 这一行只是为了让人看到"k 会不会翻"，**不是真实 T**，别拿它当判据。
     */
    if (horizon.left < 20) {
      const far = projectEconUntil({
        T: 20,
        gold: s.players[world.me].gold,
        income: incomeNow(s, world),
        spots,
        combat: picks,
        soldierSlots: world.myCities.reduce(
          (n, c) => n + cityTiles(c).filter((p) => !s.units.some((u) => u.x === p.x && u.y === p.y)).length,
          0,
        ),
      });
      const fb = bestProjection(far);
      console.error(
        `[project] 敏感性 T=20（假窗口，只看 k 翻不翻）最优k=${fb?.k ?? '-'} 经济${fb?.econN ?? '-'} 兵${fb?.armyN ?? '-'} 收入${Math.round(fb?.income ?? 0)} 战力${Math.round(fb?.worth ?? 0)}`,
      );
    }
    /*
     * **带升级时代的投影**（2026-11-25 晚）：把"升到第几代"变成枚举维度。
     *
     * 上一版把升级硬编码成"不做"，用户的质疑是：高代经济兵每格产出更高，
     * v4 现在领先也许只是因为 v1/v3 在"经济兵找岗"上太差（v1 每城只认 2 个、
     * v3 走位混在打分里）。所以这里对 era = 当前代 .. 当前代+3 各建一份岗表
     * （`econSpots` 是按城代过滤的，换代必须重建 world），再枚举 (k × 升几级)。
     */
    const mine = world.myCities[0];
    if (mine) {
      const e0 = mine.era ?? 1;
      const eras: EraTable[] = [];
      for (let e = e0; e <= e0 + 3; e++) {
        const s2 = structuredClone(s);
        s2.current = world.me;
        for (const c of s2.cities) if (c.owner === world.me) c.era = e;
        const w2 = buildWorld(s2, world.me);
        const spots2 = w2.econSpots().map((x) => ({
          type: x.type,
          x: x.x,
          y: x.y,
          yield: x.yield,
          turns: x.turns,
          gold: x.gold,
        }));
        let cost = 0;
        if (e > e0) {
          const c2 = s2.cities.find((c) => c.owner === world.me)!;
          c2.era = e - 1;
          cost = upgradeTargetOf(s2, c2)?.cost ?? Number.POSITIVE_INFINITY;
        }
        eras.push({ era: e, spots: spots2, cityIncome: eraDef(e).cityIncome, cost });
      }
      const slots = world.myCities.reduce(
        (n, c) => n + cityTiles(c).filter((p) => !s.units.some((u) => u.x === p.x && u.y === p.y)).length,
        0,
      );
      const epts = projectWithEra({
        T: horizon.left,
        gold: s.players[world.me].gold,
        income: incomeNow(s, world),
        eras,
        combat: picks,
        soldierSlots: slots,
      });
      console.error(
        `[project2] T=${horizon.left} 城 ${e0} 代 → 可升到 ${eras[eras.length - 1]!.era} 代，费用 ${eras
          .slice(1)
          .map((x) => `${x.era}:${x.cost}`)
          .join(' ') || '无'} · 各代 6 手内岗 ${eras.map((x) => `${x.era}代${x.spots.filter((p) => p.turns <= 6).length}格/${x.spots.filter((p) => p.turns <= 6).reduce((n, p) => n + p.yield, 0)}金`).join(' ')}`,
      );
      for (const ups of [0, 1, 2, 3]) {
        const b = bestEraBy(epts.filter((p) => p.ups === ups), 'income');
        if (!b) continue;
        console.error(
          `[project2]   升${ups}级 → 第${b.era}代 · 最优k=${b.k} 经济${b.econN} 兵${b.armyN} 末金${Math.round(b.gold)} 收入${Math.round(b.income)} 战力${Math.round(b.worth)}`,
        );
      }
      const bi = bestEraBy(epts, 'income');
      const bw = bestEraBy(epts, 'worth');
      if (bi) {
        console.error(
          `[project2] 按收入最优：升${bi.ups}级 k=${bi.k} 收入${Math.round(bi.income)} 战力${Math.round(bi.worth)}`,
        );
      }
      if (bw) {
        console.error(
          `[project2] 按战力最优：升${bw.ups}级 k=${bw.k} 收入${Math.round(bw.income)} 战力${Math.round(bw.worth)}`,
        );
      }
      /*
       * **长窗口敏感性**：用户的观点是"只造低级经济兵不升代会更慢"——那是**长期**结论。
       * 22 手的窗口里升级费（1→3 代要 580 金）根本赚不回来，所以这里把窗口拉到 40 手再看，
       * 让"升级 vs 不升"在它该分胜负的尺度上比。**假窗口，只看方向，别当判据。**
       */
      const far = projectWithEra({
        T: 40,
        gold: s.players[world.me].gold,
        income: incomeNow(s, world),
        eras,
        combat: picks,
        soldierSlots: slots,
      });
      /*
       * **v3 式求解**：以"升到第 N 级"为目标，先算还差多少升级费，
       * 再决定这笔钱该不该变成经济兵（回本期 ≤ 攒够之前的剩余手数）。
       */
      const plans = solveEconAll({ T: horizon.left, gold: s.players[world.me].gold, income: incomeNow(s, world), eras, combat: picks, soldierSlots: slots });
      console.error(
        `[project3] T=${horizon.left}（v3 式：边投边攒）${plans.map((p) => `升到第${p.upTo + 1}级→第${p.era}代 收入${Math.round(p.income)} 经济${p.econN} 末金${Math.round(p.gold)} 升级费${p.spent}`).join(' · ')}`,
      );
      const plans40 = solveEconAll({ T: 40, gold: s.players[world.me].gold, income: incomeNow(s, world), eras, combat: picks, soldierSlots: slots });
      console.error(
        `[project3] 敏感性 T=40：${plans40.map((p) => `升到第${p.upTo + 1}级→第${p.era}代 收入${Math.round(p.income)} 经济${p.econN}`).join(' · ')}`,
      );
      console.error(
        `[project2] 敏感性 T=40（假窗口）：${[0, 1, 2, 3]
          .map((ups) => {
            const b = bestEraBy(far.filter((p) => p.ups === ups), 'income');
            return b ? `升${ups}级(第${b.era}代) 收入${Math.round(b.income)} 战力${Math.round(b.worth)}` : '';
          })
          .filter(Boolean)
          .join(' · ')}`,
      );
    }
  }
  /*
   * **把"让开"写成一支队**（9.14 的收尾）：只收那些这一手**真的被派了活儿**的兵。
   * 2026-11-25（9.18）：有了临时调令之后，"活儿"有两种——搬迁落点、或者朝任务走。
   * 两种都进这支 `yield` 队：回放里要能看见"它这一手的任务就是离开这一格"。
   */
  {
    const blockerIds = new Set(blockers.map((b) => b.id));
    const yieldIds = [
      ...new Set([
        ...Object.keys(transit),
        ...yieldMoves.map((m) => m.unitId).filter((id) => blockerIds.has(id)),
      ]),
    ];
    if (yieldIds.length > 0) squads.push({ id: 'yield', order: 'yield', unitIds: yieldIds });
  }
  /*
   * 升级的"能不能"（D6）：决定层说要不要，这里回答执行得了吗。
   * 被否时带一句话出去（`upgradeBlocked`），否则回放里只看得见"这一手什么也没升"。
   */
  const upgradePlan = planUpgrade(s, world, need, gold, decision.upgrade);
  /*
   * **一条线的三个存量**（W1 影子模式）：只在这里算一次，给日志和探针看。
   * 挂在主队上——主队就是这一波（`main` + 目标敌城）。
   */
  /*
   * **哨兵**（阶段 5 §2.2b，2026-11-28）：决定层说"去哪看"，这里挑一个人。
   *
   * 选人规则只有一条：**不在任何队里的战斗兵里，身价最低的那个**。
   * 挑不到（人都编进进攻队了）→ 这一手不派——**不拆进攻队去当眼睛**，
   * 那就是又长出一个"名额"，用户明确否掉过。
   */
  if (decision.alert && decision.alert.at) {
    const inAny = new Set(squads.flatMap((q) => q.unitIds));
    const spare = rest
      .filter((u) => !inAny.has(u.id) && captureId !== u.id)
      .sort((a, b) => unitWorth(s, a) - unitWorth(s, b) || (a.id < b.id ? -1 : 1))[0];
    if (spare) {
      squads.push({
        id: 'scout',
        order: 'scout',
        unitIds: [spare.id],
        cityId: decision.alert.cityId,
        at: decision.alert.at,
      });
    }
  }

  /**
   * 挂在主队上——主队就是这一波（`main` + 目标敌城）。
   */
  const attackSquads = squads.filter(
    (q) => !!q.cityId && q.order !== 'hold' && q.order !== 'yield' && q.order !== 'scout',
  );
  const laneCity = attackSquads[0]?.cityId
    ? s.cities.find((c) => c.id === attackSquads[0]!.cityId)
    : undefined;
  const lane =
    attackSquads.length > 0 && laneCity
      ? {
          ...world.laneStats(attackSquads.flatMap((q) => q.unitIds), laneCity),
          seats: world.siegeSeats(laneCity),
        }
      : undefined;
  return {
    need,
    spendCap,
    reserveGold,
    captureId,
    captureTarget,
    transit,
    horizon,
    upgrade: upgradePlan.upgrade,
    upgradeBlocked: upgradePlan.blocked,
    lane,
    bands: outBands,
    buildBand: outBuildBand,
    bridgeStage: decision.kind === 'bridge' ? decision.bridge?.stage : undefined,
    recruitBuilder: outRecruitBuilder,
    bandNeed: outBandNeed,
    econPosts: econPlan.posts,
    econNext: econPlan.next,
    econOrder: econPlan.order,
    spawnQuota: spawnQuota.length > 0 ? spawnQuota : undefined,
    keepClear,
    squads,
    steps: marched.steps,
    stepOrder: marched.order,
    yieldMoves,
    forbid,
  };
}

/** 这个单位属于哪支队（查表；没有任务 = undefined） */
export function taskOf(con: Constraints, unit: Unit): Squad | undefined {
  for (const sq of con.squads) if (sq.unitIds.includes(unit.id)) return sq;
  return undefined;
}

/** 站在 `keepClear` 上的自家单位（打分层要先把它们挪开） */
export function blockers(s: GameState, con: Constraints, world: World): Unit[] {
  const keep = new Set(con.keepClear);
  return s.units.filter(
    (u) => u.owner === world.me && keep.has(u.y * s.w + u.x) && utype(s, u.type).category !== undefined,
  );
}

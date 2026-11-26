/**
 * **决定层**：这一段时间做什么、做到什么时候、为什么。
 *
 * ── 它只准交出 `Decision` ────────────────────────────────────
 *
 * 不许输出"进攻意愿 +40"这种东西。加一项分，等于把"要不要打"这个问题
 * 摊进一张谁也读不懂的表里；而"这三回合先发展，第 20 手之前不开战"是
 * 一句能被人反驳的话——错了能改，含糊的分只能调参。
 *
 * ── 决定有期限 ──────────────────────────────────────────────
 *
 * `untilTurn` 是硬要求。没有期限的决定会悄悄变成常数，然后没人记得它是谁写的。
 */
import type { World } from './world.ts';
import type { City } from '../types.ts';
import type { BandTask, Decision, TakeoverStage, UpgradeCandidate, V4Memory } from './types.ts';
import { unitWorth } from './world.ts';
import { cityTiles, effectiveStats, previewAttack, utype } from '../rules.ts';
import { passable } from '../config.ts';
import { EARTH, tileOn } from '../board.ts';
import { upgradeTargetOf } from '../era-routes.ts';
import type { GameState } from '../types.ts';

/**
 * 沿用上一条理由时加一个标记（D6）。
 *
 * 原来是 `${prev.reason}（沿用）` 直接拼——理由每手都被沿用一次，于是字符串长成
 * "先守（沿用）（沿用）（沿用）…"，回放里三十手后就读不出原句了。
 * 现在先把已有的后缀去掉再拼，永远只有一个。
 */
function inherit(reason: string): string {
  return `${reason.replace(/（沿用）$/, '')}（沿用）`;
}

/** 还没挂"钱怎么花"的决定（`withSpend` 的入参形状） */
type BareDecision = Omit<Decision, 'spend'>;

/**
 * 给决定挂上"这一段钱怎么花"（D1，2026-11-25）。
 *
 * ── 它是搬家，不是改判据 ─────────────────────────────────────
 *
 * 下面三条二值判断原来写在入口 `ai-v4.ts` 的造兵那一段，判据一个字没改：
 *
 *   · `saving`     ：接管废墟、且不在清场段 → 一分不花（那笔钱是重建费）；
 *   · `preferEcon` ：在攒钱之外，只要"在发展"或者"看不见敌人" → 先补经济；
 *   · `needArmy`   ：看不见敌人 **并且** 在发展期 → 一个战斗兵都不造。
 *
 * 原样搬过来，所以 **33 道题的读数必须一字不变**。变了就是搬错了，不准顺手"修"。
 *
 * ── 为什么必须在决定层 ──────────────────────────────────────
 *
 * 这是"作战方式"的一部分：在打、在守、在发展，钱的用法不同。放在动作选择器里，
 * "这一手为什么没造兵"就只能翻代码行；放在这里，它和"打谁、管到第几手"是同一句话。
 *
 * ── 为什么 `cap` 要在这里算 ─────────────────────────────────
 *
 * 重建费那份钱是**决定的一部分**（"攒够 248 再进城"），不是采购时临时想起来的数。
 * 约束层只负责把它传给打分层，不再自己算第二遍。
 */
/**
 * **编队还缺几个人**（W3.6 第 5 步）：在编队的编制之和 − 现在还活着的人数。
 *
 * 只数"已出发"的队：收拢中的队本来就按编制在补，不该再喊缺人（否则永远在补兵）。
 */
function bandGap(s: GameState, mem: V4Memory | undefined): number {
  return (mem?.bands ?? [])
    .filter((b) => (b.state ?? 'forming') === 'marching')
    .reduce((n, b) => {
      const alive = b.unitIds.filter((id) => s.units.some((u) => u.id === id)).length;
      return n + Math.max(0, (b.want ?? b.unitIds.length) - alive);
    }, 0);
}

function withSpend(s: GameState, world: World, d: BareDecision, mem?: V4Memory): Decision {
  /*
   * **"看不见敌人"要把能开火的建筑算进去**（2026-11-26，P-2-01 逼出来的）。
   *
   * `foeCombat` 只数 `combat` 类；箭塔/炮台是 `building` 类。对手只摆防御建筑时，
   * v4 会认为天下太平 → `econOnly` → **只造经济兵，再也不造军队**（P-2-01 实测：
   * 第一队 10 个人死在炮台下，之后 17 手一个战斗兵都没造）。
   * 会打人的建筑和会打人的兵，在"要不要留钱造兵"这个问题上没有区别。
   */
  const noFoe =
    world.foeCombat.length === 0 &&
    !s.units.some((u) => {
      if (u.owner === world.me) return false;
      const d2 = utype(s, u.type);
      return d2.category === 'building' && (d2.atk ?? 0) > 0;
    });
  const gold = s.players[world.me]?.gold ?? 0;
  const keep = d.untilTurn;

  /* ① 攒钱：接管废墟、还在 save 或 enter 段（clear 段要打仗，照花） */
  if (d.kind === 'takeover' && d.stage !== 'clear') {
    const ruin = d.cityId ? s.cities.find((c) => c.id === d.cityId) : undefined;
    const cost = ruin ? world.ruinCost(ruin) : 0;
    const cap = Math.max(0, gold - cost);
    /*
     * `enter` 段也归 `save`：钱虽然够了，但这一手的钱是**留给重建费**的，
     * 花掉就进不了城。所以模式不改（行为一个字不动），只把理由写清楚——
     * 面板上不该出现"钱够了还在攒钱"这种自相矛盾的话。
     */
    return {
      ...d,
      spend: {
        mode: 'save',
        cap,
        untilTurn: keep,
        why:
          d.stage === 'enter'
            ? `钱够了，这一手的 ${cost} 金留给重建费，不采购（现有 ${gold}）`
            : `攒 ${cost} 金重建，这一手最多花 ${cap}（现有 ${gold}）`,
      },
    };
  }

  /*
   * ①.5) **架桥期的钱**（W4-4d-3，2026-11-26）。
   *
   *   · `seize`：先头部队要去占岸 → 钱**只买战斗兵**（不铺经济）；
   *   · `build`：工兵已经上来了 → **把桥钱留住**，其余不花（`save`）。
   *     不这么办的话，钱会在"占岸"那几手全变成兵，工兵到了岸边一分钱都没有
   *     （临时验证：300 金到第 10 手已经 0，桥一格没铺）。
   */
  if (d.kind === 'bridge' && d.bridge) {
    const city = s.cities.find((c) => c.id === d.bridge!.cityId);
    const cost = city ? (world.bridgeOutlook(city).cost?.gold ?? 0) : 0;
    const gold = s.players[world.me]?.gold ?? 0;
    if (d.bridge.stage === 'build' && cost > 0) {
      const cap = Math.max(0, gold - cost);
      return {
        ...d,
        spend: { mode: 'save', cap, untilTurn: keep, why: `留 ${cost} 金架桥，这一手最多花 ${cap}（现有 ${gold}）` },
      };
    }
    return {
      ...d,
      spend: { mode: 'army', untilTurn: keep, why: '架桥：先头部队先去占岸，钱只买战斗兵' },
    };
  }

  /*
   * **② 前面插一条：编队缺员时，先补兵**（W3.6 第 5 步，2026-11-26）。
   *
   * "采购认编队"落在这一句上：编队报的缺口（编制 − 现在几个人）不为零，说明前线有人
   * 在死、后面没人接。这时候还按"先经济、再补兵"排，等于看着它打光。
   *
   * 只改**排序**（经济兵让位给战斗兵），不加任何系数：缺口是数出来的，
   * 有缺口就先兵，没缺口照旧走原来的模式。
   */
  if (d.kind === 'expand' && bandGap(s, mem) > 0) {
    return {
      ...d,
      spend: {
        mode: 'army',
        untilTurn: keep,
        why: `编队还缺 ${bandGap(s, mem)} 个人，先补兵（不先铺经济）`,
      },
    };
  }

  /* ② 在发展、或者根本看不见敌人 → 先补经济 */
  if (d.kind === 'expand' || noFoe) {
    /*
     * 看不见敌人 + 发展期 → **连一个战斗兵都不造**。
     *
     * 这条是 S-015 逼出来的：不造经济兵就长不大；但"有钱就造兵"更糟
     * （v1 在一条人烟的题上花 367 金造了 5 个战斗兵）。攒下的钱会在
     * 真要打的时候变成兵——那时候 `mode` 就不是这个了。
     */
    if (noFoe && d.kind === 'expand') {
      return {
        ...d,
        spend: {
          mode: 'econOnly',
          untilTurn: keep,
          why: '发展期且看不见敌人：只补经济，一个战斗兵都不造',
        },
      };
    }
    return {
      ...d,
      spend: {
        mode: 'econThenArmy',
        untilTurn: keep,
        why: noFoe
          ? '看不见敌人，但这个决定不是"发展"（正在清场/接管）：先经济，再补战斗兵'
          : '在发展期但看得见敌人：先经济，没有空岗再补战斗兵',
      },
    };
  }

  /* ③ 在打 / 在守：钱只买战斗兵，买不起就攒 */
  return {
    ...d,
    spend: {
      mode: 'army',
      untilTurn: keep,
      why: '在打或在守：钱只买战斗兵，买不起就攒着',
    },
  };
}

/**
 * 把"钱怎么花"和"要不要升代"一起挂到决定上（D4a）。
 *
 * 为什么统一成一个出口：这两个字段都**必须每个 `return` 都有**，漏一个就是
 * "沿用了决定、忘了沿用升级"的默认值 bug。让唯一入口来挂，漏不掉。
 */
/**
 * **每队一条任务**（W3.6 第 3c 步，2026-11-26）。
 *
 * 决定层的输出原来只有一个"全局类型"，于是一次类型切换（打 → 发展）就只能把所有人
 * 重建成一支队伍，正在攻城的编队被叫回家（S-001 第 8/10/18 手来回走了 20 手）。
 *
 * 现在对**每一支在编的编队**交一条任务，规则只有四条：
 *   · 守：所有在打敌城的队，任务先标成"守这座城"（走不回去的，计划层会退回进攻）；
 *   · 接管：只有冲着这座废墟去的队改任务（清场段照打、攒钱/入驻段守着）；
 *   · 打 / 发展：目标还是敌城就继续打它自己的城——**发展只管钱和后方，不改前线的任务**；
 *   · 目标已经不是敌城（被打下 / 变废墟 / 丢了）→ 这队没有任务，交给计划层收编。
 *
 * 注意这里只写**意图**：`hold` 不代表它真的走得到，可不可行是计划层的事
 * （`DESIGN-LANES-WAVES` §0 的分工：选择在决定层、可行性在计划层）。
 */
function bandTasksOf(world: World, mem: V4Memory | undefined, d: BareDecision): BandTask[] {
  /* 架桥时所有战斗兵的目标是"渡口的岸"，不是某座城——统一交给计划层的 bridge 分支安排 */
  if (d.kind === 'bridge') return [];
  const out: BandTask[] = [];
  for (const b of mem?.bands ?? []) {
    if (b.unitIds.length === 0) continue;
    const isTarget = !!d.cityId && d.cityId === b.cityId;
    if (d.kind === 'defend' && d.cityId) {
      out.push({ bandId: b.id, order: 'hold', cityId: d.cityId });
      continue;
    }
    if (d.kind === 'takeover' && isTarget) {
      out.push({ bandId: b.id, order: d.stage === 'clear' ? 'march' : 'hold', cityId: b.cityId });
      continue;
    }
    if (!world.foeCities.some((c) => c.id === b.cityId)) continue;
    out.push({
      bandId: b.id,
      order: d.kind === 'press' && isTarget && d.stage === 'siege' ? 'siege' : 'march',
      cityId: b.cityId,
    });
  }
  return out;
}

function complete(s: GameState, world: World, mem: V4Memory | undefined, d: BareDecision): Decision {
  const dec = withSpend(s, world, d, mem);
  return { ...dec, upgrade: upgradeOf(s, world, mem, dec), bandTasks: bandTasksOf(world, mem, dec) };
}

/**
 * **闸 A：救不救这座城**（D4b：输入换成 `world.cityStand`）。
 *
 * 判据的两句话没变：城 ≤2 轮就塌、升完能多撑至少一轮。
 * 变的是**数的来源**——原来用一份"半径硬切 + 曼哈顿距离 + 一律从第 1 轮开火"的算术，
 * 现在读服务层的逐轮推进（`world.cityStand`）：
 *
 *   · 隔水/隔山"看着近"的敌人不再被算成当回合就砸（Y-001：曼哈顿 4 格、实际 9 步）；
 *   · 半径外正在赶来的敌人开始被计入（S-005：曼哈顿 9 格、实际 18 步）；
 *   · `burst`（一回合多段）已经在 `cityStand` 里乘过，这里不用再管。
 *
 * 排序不变：撑得最少的在前，同轮数取 id 小的；**多城从第一天就按每座城算**。
 * 升完还剩不剩一个打得穿的兵（原来的条件③）不在这里——那是可行性，留在计划层。
 */
function rescueCandidates(s: GameState, world: World, gold: number): UpgradeCandidate[] {
  const out: UpgradeCandidate[] = [];
  for (const info of world.cities) {
    const city = info.city;
    const stand = world.cityStand(city);
    if (!Number.isFinite(stand.rounds) || stand.rounds > 2) continue; /* 撑得过两轮 → 不叫应急 */
    const tgt = upgradeTargetOf(s, city);
    if (!tgt || tgt.cost === null || tgt.blocked) continue;
    if (gold < tgt.cost) continue;
    const after = stand.roundsAfterUpgrade;
    if (after === undefined) continue;
    if (!(after > stand.rounds)) continue; /* 升了不多撑一轮 → 白升 */
    out.push({
      cityId: city.id,
      targetEra: tgt.edge.to,
      cost: tgt.cost,
      label: tgt.label,
      rounds: { now: stand.rounds, after },
      why: `城 ${stand.rounds} 轮内会塌（威胁 ${stand.threats} 个，第 ${stand.firstAt} 回合开始挨打），升到${tgt.label}后能${roundsText(after)}`,
    });
  }
  return out.sort((a, b) => a.rounds.now - b.rounds.now || (a.cityId < b.cityId ? -1 : 1));
}

/** `Infinity` 不是给人看的：塌不了就说"塌不了" */
function roundsText(n: number): string {
  return Number.isFinite(n) ? `撑 ${n} 轮` : '撑到打不塌';
}

/**
 * **闸 B：钱多到产兵格成了瓶颈 → 升代**（D4a 从 `planUpgradeEcon` 搬来）。
 *
 * 判据（用户 2026-11-25 逐条纠过的三个坑，一个都没改）：
 *   ① 产兵格现算（城格减掉站着人的），不写死 4；
 *   ② "剩余手数" = `world.developLeft()`（行军时间，不是题目窗口）；
 *   ③ "花不完"按**每格战力**判：`金 > 格数 × 剩余手数 × 当前代最强兵价`。
 *
 * 枚举（每一代的累计价、每格最强的兵）在服务层 `world.eraLadder`；这里只做**选择**：
 * 对每一代算 `n = min(格数×剩余手数, 钱÷单价)`，取 `n × 每格战力` 最大的那一代。
 *
 * ⚠️ **规划一次，然后记住**（D5，2026-11-26）：升级费是沉没成本，每手重算会漂
 * （E-2-03 从 3 代漂到 5 代）。D5 之前靠"场上有兵就不规划"挡着，副作用是
 * "先造一个兵再暴富就永远升不了"；现在靠记忆里的 `eraPlan` 承诺挡住，**与有没有兵无关**。
 */
function econCandidates(
  s: GameState,
  world: World,
  mem: V4Memory | undefined,
  gold: number,
): Decision['upgrade'] {
  /** 承诺有效期：和编队的 12 手同一个尺度，够长到让"边升边攒"跑完，够短到不会变成常数 */
  const VALID = 12;
  const prev = mem?.eraPlan ?? null;
  /* ⚠️ `ruined` 是可选字段（正常城是 `undefined` 不是 `false`），不能写成 `?.ruined ?? true` */
  const prevCity = prev ? s.cities.find((c) => c.id === prev.cityId) : undefined;
  const live = prev && s.turn - prev.since <= VALID && !!prevCity && prevCity.ruined !== true ? prev : null;

  /*
   * **有承诺就照承诺走**（D5）：不再重算"哪一代最优"。
   *
   * 这就是拆掉"有兵就不规划"那道门之后的安全带——那门治的是漂移（沉没成本 + 窗口每手在变，
   * 最优代会越来越高），代价是"先造了一个兵再暴富就永远升不了"（E-2-05 正是这个形状）。
   * 承诺只治漂移，不管场上有没有兵：**这正是两条不同的判断**。
   *
   * 已经升到目标代 → 这一期不再规划（承诺到期才重来），否则到顶之后会立刻找下一样更贵的。
   */
  if (live) {
    const city = world.myCities.find((c) => c.id === live.cityId);
    if (!city || (city.era ?? 1) >= live.targetEra) return undefined;
    const ladder = world.eraLadder(city);
    const step = ladder.find((x) => x.era === live.targetEra);
    const next = ladder[1];
    if (!step || !next) return undefined;
    return {
      kind: 'econ',
      candidates: [
        {
          cityId: city.id,
          targetEra: step.era,
          /* 这一手付的是"下一级"的价 */
          cost: next.cost,
          label: `第${step.era}代`,
          rounds: { now: 0, after: 0 },
          why: `沿用第 ${live.since} 手立的承诺：升到第 ${step.era} 代（每格 ${Math.round(step.worth)}）`,
        },
      ],
    };
  }

  const h = world.developLeft();
  if (!h) return undefined;
  const left = Math.floor(h.left);
  if (left <= 0) return undefined;

  let best: UpgradeCandidate | undefined;
  for (const city of world.myCities) {
    if (city.ruined) continue;
    /* ① 产能现算：城格去掉站着人的（占满就造不了，别把它算成产能） */
    const cap = Math.max(
      1,
      cityTiles(city).filter((p) => !s.units.some((u) => u.x === p.x && u.y === p.y)).length,
    );
    const ladder = world.eraLadder(city);
    const now = ladder[0];
    if (!now) continue;
    /* ③ 钱花得完 → 不叫"钱多"，别升 */
    if (gold <= cap * left * now.gold) continue;

    let curTotal = Math.min(cap * left, Math.floor(gold / now.gold)) * now.worth;
    for (const step of ladder.slice(1)) {
      if (gold < step.acc) break;
      const n = Math.min(cap * left, Math.floor((gold - step.acc) / step.gold));
      const total = n * step.worth;
      if (total <= curTotal) continue;
      curTotal = total;
      best = {
        cityId: city.id,
        targetEra: step.era,
        /* 这一手要付的是"下一级"的价，不是整条路径的累计价 */
        cost: ladder[1]!.cost,
        label: `第${step.era}代`,
        rounds: { now: 0, after: 0 },
        why: `钱花不完（${gold} > ${cap}格×${left}手×${now.gold}），升到第${step.era}代后这 ${left} 手能造 ${n} 个${utype(s, step.type).name}（每格 ${Math.round(step.worth)}，现在 ${Math.round(now.worth)}）→ 战力 ${Math.round(total)} 对 ${Math.round(n * now.worth)}`,
      };
    }
  }
  return best ? { kind: 'econ', candidates: [best] } : undefined;
}

/** 这一期要不要升代（D4a）：先问"救不救得了"，再问"钱是不是多到花不完" */
function upgradeOf(s: GameState, world: World, mem: V4Memory | undefined, d: Decision): Decision['upgrade'] {
  /* 攒钱期不升级：那笔钱是重建费，动了就前功尽弃 */
  if (d.spend.mode === 'save') return undefined;
  const gold = s.players[world.me]?.gold ?? 0;
  const rescue = rescueCandidates(s, world, gold);
  if (rescue.length > 0) return { kind: 'rescue', candidates: rescue };
  return econCandidates(s, world, mem, gold);
}

/**
 * **一条线的账：这一路到底换到东西没有**（W2，2026-11-26）。
 *
 * 口径（`DESIGN-LANES-WAVES` §4）：
 *   · 窗口 = 最近 6 手（和 `DECIDE_HORIZON` 同尺度），**按窗口看，不按累计看**；
 *   · 有交换：`Σ敌方被击杀造价 ≥ Σ我方被击杀造价` → 赚，否则亏；
 *   · 没交换：看城血，掉了 ≥1 点算赚（砸墙也是收益），一点没掉 → **卡住**；
 *   · 窗口里连记录都没有、也从没接火 → `unknown`（还没得判，不能当亏损）。
 *
 * 为什么"没接火"必须单独一种：把 `0 ≥ 0` 判成亏，它会永远不敢开第一枪——
 * 那不是判据严，是死锁。
 */
export type LineVerdict = 'earn' | 'lose' | 'stalled' | 'unknown';

export interface LineLedger {
  verdict: LineVerdict;
  gain: number;
  loss: number;
  /** 窗口内城血掉了多少（>0 = 砸到了墙） */
  hpDrop: number;
}

function lineLedger(s: GameState, mem: V4Memory | undefined, city: City): LineLedger {
  const rows = (mem?.exchangeByCity?.[city.id] ?? []).filter((r) => r.turn > s.turn - DECIDE_HORIZON);
  const gain = rows.reduce((n, r) => n + r.gain, 0);
  const loss = rows.reduce((n, r) => n + r.loss, 0);
  const hpStart = rows.find((r) => r.hp !== undefined)?.hp;
  const hpDrop = hpStart === undefined ? 0 : Math.max(0, hpStart - city.hp);
  if (gain + loss > 0) return { verdict: gain >= loss ? 'earn' : 'lose', gain, loss, hpDrop };
  if (hpDrop > 0) return { verdict: 'earn', gain, loss, hpDrop };
  /*
   * **接过火、还什么都没换到 → 卡住；还没接火 / 刚接火 → 还没得判。**
   *
   * ⚠️ 两道门都是为了不让"还没发生的事"被判成"卡住"：
   *
   *   ① "接火"不能拿"出发"（`startTurn`）代替——走在路上当然既没交换也没掉血。
   *      S-016 实测：按出发判，T1 出发、T3 判卡住、T5 全军撤回。
   *   ② 刚接火的那一两手也不能判——走到城下的第一手还没来得及打。要求**接触满半个期限**
   *      （`DECIDE_HORIZON / 2` = 3 手）。E-2-03 实测：T9 刚贴到城、T11 就被判卡住，
   *      部队掉头回去造农民，一道"钱变成什么"的题因此翻红。
   */
  const firstArrival = (mem?.waves ?? [])
    .filter((w) => w.cityId === city.id)
    .map((w) => {
      const k = w.arrivals.findIndex((n) => n > 0);
      return k < 0 ? Infinity : w.bornTurn + k;
    });
  const contactTurns = firstArrival.length > 0 ? s.turn - Math.min(...firstArrival) : 0;
  /*
   * ③ **人得还在城下**。人都打光了 / 退回来了，那不是"卡住"，是"该送新的一批"——
   * 按前者判，一条线停过一次就永远卡住，再也起不来（S-001 实测：T5 亏一次，40 手不进攻）。
   */
  const atCity = (mem?.lineFront?.[city.id] ?? 0) > 0;
  /*
   * 门槛用**整个期限**（6 个"手"，= 双方各 3 回），不是半个。
   * `s.turn` 是玩家手数（我、敌各走一次算两手），按半个算只有 1.5 个自己的回合——
   * S-000 实测：T3 刚接火，T5 就判卡住，全军掉头去发展。
   */
  if (atCity && contactTurns >= DECIDE_HORIZON) {
    return { verdict: 'stalled', gain, loss, hpDrop };
  }
  return { verdict: 'unknown', gain, loss, hpDrop };
}

/**
 * **一批送几个人**（W3，2026-11-26）。
 *
 * 口径：一批 = **6 手内能走到城下的人数** = 这条线实测的到货率 × 期限。
 * 实测下来三条长局都是 1.2~1.4 人/手（`DESIGN-LANES-WAVES` §1），所以还没有数据时
 * 用 8（= 1.33 × 6）。
 *
 * 为什么不用"守军身价 ÷ 我方身价 × 1.5"：那个公式的输入是**敌人有多强**，
 * 输出是"该派几个"；可真正的限制是"一批能送到几个"——送 25 个只有 6 个能展开
 * （S-002 实测）。多送的人只是在路上排队，不如留在后面当预备队。
 *
 * `min(standing, …)` 是硬上限：手上没有那么多兵就是没有。
 * `max(2, …)` 是下限：一个兵不叫一批。
 */
/**
 * **一批至少要几个人**：凑得够打死一个守军（最厚守军的血 ÷ 我方单发）。
 *
 * 这是"不要一个一个送"的下限。少于它，一批连一个守军都打不掉，分批没有意义。
 */
function killOneNeed(s: GameState, world: World): number {
  const guards = s.units.filter((u) => u.owner !== world.me && utype(s, u.type).category !== 'economy');
  const hardest = guards.reduce<((typeof guards)[number] | undefined)>(
    (best, u) => (!best || u.hp > best.hp ? u : best),
    undefined,
  );
  const dmg = hardest
    ? world.myCombat.reduce((n, u) => Math.max(n, previewAttack(s, u, hardest).toDefender), 0)
    : 0;
  return hardest && dmg > 0 ? Math.ceil(hardest.hp / dmg) : 2;
}

function batchMen(s: GameState, world: World, standing: number): number {
  /*
   * **一批几个人：学 v3 的两条口径**（用户 2026-11-26："看看 v3 怎么处理编队上限"）。
   *
   * v3 的做法是两层，都是量出来的：
   *   ① **总配额** `6 + 8 × clamp((兵力比 − 0.7) / 0.9)` → 6~14 人。
   *      下限 6 是"4 人的编队打不动有守军的城"（Q4 从 5-1-0 掉到 2-3-1）；
   *      上限 14 是"再多也展不开"。
   *   ② **每队规模看目标城的守军**（`planNeed`：空城 6 / 突破 9 / 屯兵 8 / 过河 6）。
   *      12 人那版实测要"攒满才出发"，Q4 反而更差，改成 9。
   *
   * v4 原来的 `men` 是"手上剩多少就编多少"，长局里会涨到 27~29，收拢 10 多手。
   * 这里换成上面两条，**下限仍然是"打死一个守军"**（够打是硬要求）。
   */
  const need = killOneNeed(s, world);

  /*
   * 守军 = **看得见的全部敌战斗兵**，不是"6 手内走得到城的那些"。
   *
   * 按距离筛会漏掉隔河/隔远的守军（S-001 的 8 个守军在对岸，`marchTurns > 6`
   * 全被筛掉 → 判成空城 → 只派 6 人 → 打不动）。v3 用的是"这座城的守军价值"，
   * 也不看距离。
   */
  const guardWorth = world.foeCombat.reduce((n, u) => n + unitWorth(s, u), 0);
  const mine = world.myCombat;
  const perUnit = mine.length > 0 ? mine.reduce((n, u) => n + unitWorth(s, u), 0) / mine.length : 0;
  /* 势均力敌要几个人；空城按 v3 的下限 6 */
  const parity = guardWorth > 0 && perUnit > 0 ? Math.ceil(guardWorth / perUnit) : 0;
  /* v3 的总配额：6~14，按兵力比（人数） */
  const ratio = mine.length / Math.max(1, world.foeCombat.length);
  const x = Math.min(1, Math.max(0, (ratio - 0.7) / 0.9));
  const cap = Math.round(6 + 8 * x);
  const mission = Math.min(cap, Math.max(6, parity));
  return Math.min(standing, Math.max(need, mission));
}

/** 账本的一句话（进决定理由，回放里能直接读出来） */
function ledgerText(city: City, l: LineLedger): string {
  if (l.verdict === 'earn') {
    return l.gain + l.loss > 0
      ? `6 手账 赚 ${l.gain} / 亏 ${l.loss}（赚）`
      : `6 手没死人，${city.id} 掉了 ${l.hpDrop} 点血（算赚）`;
  }
  if (l.verdict === 'lose') return `6 手账 赚 ${l.gain} / 亏 ${l.loss}（亏）`;
  if (l.verdict === 'stalled') return `6 手没交换、${city.id} 一点血没掉（卡住）`;
  return '还没接火，没有账可看';
}

/** 兵力对比（按"身价"不按个数：一个四代兵不等于一个民兵） */
function strength(s: GameState, sideUnits: GameState['units']): number {
  let n = 0;
  for (const u of sideUnits) {
    const d = utype(s, u.type);
    n += ((d.atk ?? 0) + (d.maxHp ?? 0) + (d.range ?? 1) * 4) * (u.hp / Math.max(1, d.maxHp));
  }
  return n;
}

/**
 * 一个决定**名义上管几手**。
 *
 * 导出来给经济岗表用：它需要一个"还剩几手"的尺度来判断"这个岗值不值得占"
 * （走 5 手才到的岗，在 6 手的盘子里就只剩 1 手产出）。
 *
 * 为什么不用 `untilTurn - s.turn`：那个数在每个周期的最后几手会塌到 1，
 * 于是岗表突然全空、经济兵集体停手、钱堆着不花（实测 S-015 第 7 手）。
 * 战略上"决定快到期了"不等于"这块地不值得占"——下个决定大概率还是同一件事。
 */
export const DECIDE_HORIZON = 6;

/**
 * 做决定。
 *
 * 第一版只有三条规则，都很粗——这是**故意的**：先把"决定有期限、有理由、只有一个"
 * 这件事立住，细则靠题库一题一题长。v3 那六千行系数不抄。
 */
/**
 * **接管一座废墟**：先清场、再攒钱、最后入驻（见 `TakeoverStage`）。
 *
 * 为什么这件事要一个独立的决定：它的成功条件不是"把城打空"（那是 `press`），
 * 而是"钱够了、并且有一个兵站进去"。挤进 `press` 会让"城血 0"被当成"打完了"——
 * S-001 就是这么卡的：城打空后还在 press，继续造兵，把 248 金 rebuilding 费花光，
 * 40 手都接管不了。
 *
 * 阶段是**每回合重算**的（不沿用）：它只依赖两件每回合都在变的事（敌人还在不在、
 * 钱够不够），而且只会往一个方向走（clear → save → enter），不会抖。
 */
function takeoverDecision(s: GameState, world: World, mem: V4Memory | undefined, ruin: City): Decision {
  const threats = world.ruinThreats(ruin);
  const cost = world.ruinCost(ruin);
  const gold = s.players[world.me]?.gold ?? 0;
  const stage: TakeoverStage = threats.length > 0 ? 'clear' : gold < cost ? 'save' : 'enter';
  const why =
    stage === 'clear'
      ? `废墟还有 ${threats.length} 个单位能打到它，先清场`
      : stage === 'save'
        ? `城下清干净了，攒 ${cost} 金重建（现有 ${gold}）`
        : `钱够了（${gold} ≥ ${cost}），派兵入驻`;
  return complete(s, world, mem, {
    kind: 'takeover',
    stage,
    untilTurn: s.turn + DECIDE_HORIZON,
    cityId: ruin.id,
    reason: why,
  });
}

export function decide(s: GameState, world: World, mem?: V4Memory): Decision {
  const horizon = DECIDE_HORIZON;

  const myStr = strength(s, world.myCombat);
  const foeStr = strength(s, world.foeCombat);

  /*
   * ① 先看**有没有还没到期的承诺**（迟滞）。
   *
   * 为什么必须有：判决每回合重算会在阈值附近来回翻。v3 的注释里有一句实测——
   * "4 局翻 128 次"。这里抄它的做法：进入难、退出也难，两头都留余量。
   *
   * 但沿用不是无条件的：每条承诺都写清楚"什么情况下可以提前作废"。
   */
  const prev = mem?.decision;
  if (prev && s.turn <= prev.untilTurn) {
    if (prev.kind === 'press') {
      const cityAlive = !!prev.cityId && world.foeCities.some((c) => c.id === prev.cityId);
      /*
       * **目标城已经成废墟 → 这不是"还在打"，是"该去接管了"。**
       * 不转的话会一直按 press 造兵，把钱花光（S-001：城血 0 之后 40 手都没钱重建）。
       */
      const ruin = prev.cityId ? s.cities.find((c) => c.id === prev.cityId && c.ruined) : undefined;
      if (ruin) return takeoverDecision(s, world, mem, ruin);
      /*
       * **还能不能接着推：看账，不看兵力比**（W2，2026-11-26）。
       *
       * 旧的是"跌破 1.0 就退"，于是兵越打越少、越少越不敢推，永远攒不回 1.25。
       * 现在：这条线还在赚（或还没接火）就继续；亏了 / 卡住了才收手。
       */
      const line = prev.cityId ? s.cities.find((c) => c.id === prev.cityId) : undefined;
      const ledger = line ? lineLedger(s, mem, line) : undefined;
      /*
       * **只有"卡住"才停**，亏不停。
       *
       * 为什么：用户 2026-11-26 的口径是"**允许短期小亏**"——6 手窗口里一次净亏
       * 不该让全军掉头。实测代价：改成"亏就停"之后，S-001 每 6 手打一次、亏一次、
       * 回去造 6 手，40 手打不完；S-005 更直接——T9 净亏 125 就撤，桥头一丢再也上不去。
       *
       * "亏"在这一层只影响**换不换线**（见下面挑目标的循环：不往亏的城开新线），
       * "降预算"要等 W3 的"每批多少人"才有落点（现在没有预算这个旋钮）。
       */
      if (cityAlive && ledger && ledger.verdict !== 'stalled' && line) {
        return complete(s, world, mem, {
          kind: 'press',
          untilTurn: prev.untilTurn,
          cityId: prev.cityId,
          /*
           * **规模在一次决定期内不变**。每手重算会越算越小：第一队走了以后
           * 到货率掉到 0，下一队就变成 1 个人（W3 实测的死循环）。
           * 要调整规模，等下一次决定（开战之后有了烈度数据）再调。
           */
          men: prev.men ?? batchMen(s, world, world.myCombat.length),
          menMin: prev.menMin ?? killOneNeed(s, world),
          reason: inherit(prev.reason),
        });
      }
    } else if (prev.kind === 'defend') {
      /*
       * **威胁没解除就不转攻。**（W3.6 第 4 步）
       *
       * 旧判据是"对面身价掉到我方 0.6 以下就转攻"——那是全局比较，而且**抖**：
       * 兵一回到家，守军就"够了" → 立刻转攻 → 兵一走，城又没人 → 再转守。
       * 撤掉"每城留两个守军"之后这个抖动直接让两道题丢城（D-2-02 / P-1-03）：
       * 守了一手、第二手就全军出城，老家空着被拆。
       *
       * 现在只看一件事：**敌人还在不在门口**（`foeEta` ≤ 2 手能摸到城）。
       * 在，就继续守；走了，才回到"该打还是该发展"的正常判断。
       */
      const home = prev.cityId ? s.cities.find((c) => c.id === prev.cityId) : undefined;
      const atGate = home ? world.foeEta({ x: home.x, y: home.y }) <= 2 : false;
      /*
       * 这里仍然用**旧口径的等价物**（`state === 'lose'` = 连"在场 + 能回来的"都不够）。
       * 不能换成 `state !== 'hold'`：那会让"需要增援"也把守势无限续期，
       * 而"要不要继续守"是另一件事（下一步再单独改，一次只动一处）。
       */
      if (home && (atGate || world.defensible(home).state === 'lose')) {
        return complete(s, world, mem, {
          kind: 'defend',
          untilTurn: prev.untilTurn,
          cityId: prev.cityId,
          reason: inherit(prev.reason),
        });
      }
    } else if (prev.kind === 'takeover' && myStr / Math.max(1, foeStr) < 1.25) {
      /*
       * 接管废墟的**旧判据原样保留**：打不过就先别进去。
       *
       * W2 只换"推 / 不推"，接管不属于投送。这条原来是靠兜底的 `ratio < 1.25`
       * 顺手实现的；把兜底收窄之后它跟着丢了，S-015（经济选型）实测：每手都说
       * "钱够了，派兵入驻"，但派出去的人一直走不到，`save` 模式把经济全停了。
       * 注意 `Math.max(1, foeStr)` 不能省：看不见敌人时 foeStr = 0，写成
       * `myStr < foeStr × 1.25` 永远不成立，就和旧行为分叉了（S-015 实测）。
       */
      return complete(s, world, mem, {
        kind: 'expand',
        untilTurn: prev.untilTurn,
        reason: inherit(prev.reason),
      });
    } else if (
      prev.kind === 'expand' &&
      !world.foeCities.some((c) => lineLedger(s, mem, c).verdict === 'earn')
    ) {
      /*
       * 发展期照旧走完自己的期限：只有"某条线真的在赚"才提前结束发展去加码。
       * （旧的提前退出条件是"兵力比 < 1.25"，那等于用总量比较替代"这仗值不值得打"。）
       *
       * ⚠️ 这条**只对 `expand` 生效**。原来写成"不是 press 也不是 defend"的兜底，
       * 于是接管废墟（`takeover`）也被它接过去换成"发展"——T-2-01 的入驻就是这么没的。
       */
      return complete(s, world, mem, {
        kind: 'expand',
        untilTurn: prev.untilTurn,
        reason: inherit(prev.reason),
      });
    }
  }

  /*
   * 1) **有城挡不住 → 守**（W3.6 第 3b 步，2026-11-26）。
   *
   * 旧判据是"对面总身价 > 我 ×0.9 就守"——那是**全军比较**，回答不了"这一座城要不要救"：
   * 兵都在对面城下时总身价可能还占优，可老家已经要塌了。
   * 现在读服务层算好的那一份（`world.defensible`）：守军 + 这座城的产能，挡不挡得住来犯；
   * 时间窗就是"城还能撑几轮"，所以赶不到的人不算守军、也不用来犯。
   * 最急的排前面（`rounds` 小的先救）。
   */
  const threatened = world.cities.filter((c) => c.role === 'threatened' || c.role === 'home');
  /*
   * **守军里不算"已经被派去别处进攻的人"。**
   *
   * 它们在别人的城下，既不在家、也不会回来（回不回得来由计划层按距离判）。
   * 不算进来之前，D-1-01 开局会把 2 个正在攻城的兵算成守军（身价 236 = 来犯 236），
   * 判成"挡得住"→ 不守 → 6 手丢城。
   */
  const committedTo = (cityId: string): Set<string> =>
    new Set(
      (mem?.bands ?? [])
        .filter((b) => b.cityId !== cityId && world.foeCities.some((f) => f.id === b.cityId))
        .flatMap((b) => b.unitIds),
    );
  const losing = threatened
    .map((c) => ({ info: c, out: world.defensible(c.city, committedTo(c.city.id)) }))
    /*
     * **"挡得住"不够用了，要有"需要增援"这一档**（2026-11-26 22:00，用户定）。
     *
     * 原来这里写的是 `!out.hold`，而 `hold` 数的是**窗口内能赶回来的所有人**——
     * 于是"外面推得顺"反而让守军身价虚高，判据永远说"挡得住"，一次都不派人回。
     * 现在 `state` 把"在场"和"能回来"分开：只有**在场就够**才叫 hold；
     * "在场不够、加上能回来的够"是 `reinforce`——这一档必须整队召回。
     */
    .filter((x) => x.out.state !== 'hold')
    /*
     * 先救最快塌的；同样急的时候，"回去也守不住"的排在"需要增援"前面
     * （前者更危急，而且需要更果断的动作）。
     */
    .sort(
      (a, b) =>
        a.out.rounds - b.out.rounds ||
        (a.out.state === b.out.state ? 0 : a.out.state === 'lose' ? -1 : 1) ||
        a.info.foeEta - b.info.foeEta,
    );
  if (losing.length > 0) {
    const { info, out } = losing[0]!;
    return complete(s, world, mem, {
      kind: 'defend',
      untilTurn: s.turn + horizon,
      cityId: info.city.id,
      reason: `${info.city.id} ${
        Number.isFinite(out.rounds) ? `${out.rounds} 轮内会塌` : '正在被压'
      }（${out.state === 'reinforce' ? '需要增援' : '回去也守不住'}）：${out.why}，先守`,
    });
  }

  /* 1.5) **有打空的城 → 接管它**（在"再打下一座"之前） */
  if (world.ruins.length > 0) {
    /*
     * 只接管"手上这座"：要么是上一段 press 的目标，要么是身边最近的那座
     * （部队已经推到城下，下一手就能进去）。远处的废墟先不碰——跑过去再被抢，
     * 不如先把眼前的事办完。
     */
    const near = [...world.ruins].sort((a, b) => {
      const da = Math.min(
        ...world.myCombat.map((u) => world.marchTurns({ x: a.x, y: a.y }, { x: u.x, y: u.y })),
        Infinity,
      );
      const db = Math.min(
        ...world.myCombat.map((u) => world.marchTurns({ x: b.x, y: b.y }, { x: u.x, y: u.y })),
        Infinity,
      );
      return da - db;
    })[0];
    if (near) return takeoverDecision(s, world, mem, near);
  }

  /*
   * 1.5) **走不到那座城 → 先架桥**（W4-4d-2，2026-11-26）。
   *
   * 判据只有一条（学 v3）：**地形连通性走不到**。桥一通这里自然不成立，立刻回到"打"。
   * 分两个阶段，顺序是用户定的——**工兵不许跑在部队前面**，否则它在河边会被守军打死：
   *
   *   · `seize`：先头部队去渡口的岸上占位（这一步只有战斗兵动）；
   *   · `build`：岸上已经有自己人、且敌人**两回合内摸不到**渡口，才让工兵上来。
   *
   * 只挑**没变废墟**的敌城：废墟走得到（地形可通行），不需要桥；而且废墟要办的是接管。
   */
  const bridgeTargets = world.foeCities
    .filter((c) => !c.ruined)
    .map((c) => ({ c, o: world.bridgeOutlook(c) }))
    .filter((x) => !x.o.reach && !!x.o.crossing);
  if (bridgeTargets.length > 0) {
    const { c, o } = bridgeTargets[0]!;
    const dir = o.crossing!.dir;
    const at = { x: o.crossing!.x, y: o.crossing!.y };
    const stand = { x: at.x - dir[0], y: at.y - dir[1] };
    /*
     * **战斗兵待的岸**：从 `at` 沿反方向退到第一块"不是桥"的陆地。
     * 桥铺到第二格之后 `stand` 已经是桥面，战斗兵再往那儿挤就会把工兵顶开
     * （4d-3 实测：桥停在第二格、工兵在桥头抖了 10 手）。
     */
    let bank = { ...stand };
    for (let i = 0; i < 6; i += 1) {
      const t = tileOn(s, EARTH, bank.x, bank.y)?.terrain;
      if (!t || !passable(t)) break;
      if (t !== 'bridge') break;
      bank = { x: bank.x - dir[0], y: bank.y - dir[1] };
    }
    /*
     * 再退两格：战斗兵聚在桥头会把工兵挤在外面（4d-3 实测，退了 20 手都没进 buildRange）。
     * 它们只是"占岸接应"，站远两格一样接应，桥头反而能空出来给工兵。
     */
    for (let i = 0; i < 2; i += 1) {
      const nb = { x: bank.x - dir[0], y: bank.y - dir[1] };
      const t = tileOn(s, EARTH, nb.x, nb.y)?.terrain;
      if (!t || !passable(t) || t === 'bridge' || t === 'city') break;
      bank = nb;
    }
    /*
     * "岸上有没有自己人"要按**战斗兵站的那个岸**（`bank`）算，不是按桥头。
     * 按桥头算的话，战斗兵一退到岸上（stand 已经变成桥面），就判成"岸上没人"、
     * 工兵被撤编，桥停在第二格（4d-3 实测）。
     */
    const onBank = world.myCombat.filter(
      (u) => Math.abs(u.x - bank.x) + Math.abs(u.y - bank.y) <= 3,
    ).length;
    /*
     * **只守一条门槛：岸上已有自己人。**
     *
     * 试过再加两条（敌人两回合内摸不到、没有敌人能打到岸边），用户 2026-11-26 否掉：
     * 太苛刻，实战里"顶着火力强行架桥"是常事。所以这里只问"岸上有没有人接应"，
     * 有就上工兵——打不打得过是前线的事，不是架桥这件事的判据。
     */
    const eta = world.foeEta(stand);
    const stage: 'seize' | 'build' = onBank > 0 ? 'build' : 'seize';
    return complete(s, world, mem, {
      kind: 'bridge',
      untilTurn: s.turn + horizon,
      cityId: c.id,
      bridge: { cityId: c.id, stage, at, stand, bank },
      reason:
        stage === 'seize'
          ? `到 ${c.id} 走不通（${o.why}）；先头部队先去渡口岸边 (${stand.x},${stand.y}) 占位，工兵随后`
          : `渡口 (${stand.x},${stand.y}) 已有 ${onBank} 个自己人（敌人 ${Number.isFinite(eta) ? `${eta} 回合能到` : '一时来不了'}），工兵上来铺 ${o.cost?.cells ?? '?'} 格`,
    });
  }

  /*
   * 2) **能打就打：判据是"这条路换到钱没有"，不是"我比敌人多 25%"**（W2，2026-11-26）。
   *
   * 旧判据的毛病：兵少了就不打。可打消耗战恰恰是"兵少了也该上"——用一队人的命
   * 换城血是划算的。门槛在，它就永远攒不回 1.25 倍，永远不打。
   *
   * 现在按顺序试最近的敌城：
   *   · 这条线在赚 / 还没接火 → 打它；
   *   · 亏了 / 卡住 → **换一条**（两座敌城时试下一座）；都亏就不打，回去攒。
   *
   * ⚠️ 唯一的门槛是**编队下限：至少 1 个战斗兵**。这不是"兵力比"，是"没有兵就没法开线"。
   * （原来想写 2，E-2-03 实测不行：那道题场上只有 1 个兵、敌人看不见，
   *   旧判据 `1 > 0×1.25` 会开打，下限写 2 就永远不打、发展期被经济兵吃满。）
   * W3 会用"每波成本 × 产能"把它换掉（`DESIGN-LANES-WAVES` §5）。
   */
  if (world.foeCities.length > 0 && world.myCombat.length >= 1) {
    const from = { x: world.myCombat[0]?.x ?? 0, y: world.myCombat[0]?.y ?? 0 };
    const targets = [...world.foeCities].sort(
      (a, b) => world.marchTurns(from, { x: a.x, y: a.y }) - world.marchTurns(from, { x: b.x, y: b.y }),
    );
    for (const target of targets) {
      const ledger = lineLedger(s, mem, target);
      if (ledger.verdict === 'lose' || ledger.verdict === 'stalled') continue;
      /*
       * **先清场、再砸城。**
       *
       * 判据：目标城周围还有没有"够得着这座城"的守军（它自己的移动力 + 射程）。
       * 有 → `clear`（全队打人，不砸城）；清干净 → `siege`（全队攻城）。
       *
       * 这是从 S-002 的人手答案量出来的：人类前四波（3/5/7/9 手）25 次攻击全是打人、
       * 0 次攻城，第 11 手才开始砸。
       */
      const guards = world.foeCombat.filter((f) => {
        const st = effectiveStats(s, f);
        return (
          Math.abs(f.x - target.x) + Math.abs(f.y - target.y) <=
          (st.range ?? 1) + (st.move ?? 2)
        );
      });
      return complete(s, world, mem, {
        kind: 'press',
        stage: guards.length > 0 ? 'clear' : 'siege',
        untilTurn: s.turn + horizon,
        cityId: target.id,
        men: batchMen(s, world, world.myCombat.length),
        menMin: killOneNeed(s, world),
        reason: `${ledgerText(target, ledger)}；${
          guards.length > 0 ? `${target.id} 周围还有 ${guards.length} 个守军，先清场` : `${target.id} 城下已清空，开始攻城`
        }`,
      });
    }
  }

  /* 3) 其它情况：发展（没有能打的线：兵不够，或每条线都亏/卡住） */
  return complete(s, world, mem, {
    kind: 'expand',
    untilTurn: s.turn + horizon,
    reason:
      world.myCombat.length === 0
        ? '手上一个战斗兵都没有，先发展'
        : `能打的线都亏或卡住了（${world.foeCities
            .map((c) => {
              const l = lineLedger(s, mem, c);
              return `${c.id} ${l.verdict === 'lose' ? `亏 ${l.gain}/${l.loss}` : `卡住 ${l.gain}/${l.loss}`}`;
            })
            .join('；')}），先攒兵攒钱`,
  });
}

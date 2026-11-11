/**
 * 月球基地与「月壤采样」——第一个**非战斗**的胜利条件。
 *
 * ── 怎么赢 ────────────────────────────────────────────────────────────
 *
 *   1. 把一支工程单位送到月面（发射井）；
 *   2. 在月面上「展开月球基地」：2×2 的建筑，工程单位并进去；
 *   3. 点基地的主动技能「月壤采样」，**3 个自己的回合**后结果送回地球 → 获胜。
 *
 * ── 为什么是"展开"而不是"施工" ────────────────────────────────────────
 *
 * 月面能走子（81cc39f 接上的），但**选址类动作仍然只认地球**（`rules.offWorld`：
 * 建造走的是地球的格子表），所以真施工这条路走不通。
 * 改成"工程单位带着预制舱落地、就地展开"：
 * 它用的还是 `UNIT_ACTION`，和发射井的加注同一套，规则层不需要认识月球。
 * 等月面能走能打了，把 `deployBase` 换成 `BUILD` 即可，数值不用动。
 *
 * ── 为什么倒计时按"自己的回合"数 ──────────────────────────────────────
 *
 * `s.turn` 是**双方共用**的计数器：写 `turn + 3` 实际上只等于一个半自己的回合。
 * 所以计数放在 `onTurnStart` 里、只推进自己的基地——玩家看到"还剩 2 回合"
 * 就是他还能行动两次，和面板上的数字永远对得上。
 *
 * ── 对手的反制 ────────────────────────────────────────────────────────
 *
 * 两条路都成立（2026-11-11 月面战斗接上之后）：
 *   · **发射之前**：拆掉发射井、或者杀掉等舱的那支工程单位；
 *   · **落地之后**：再派一支兵登月，贴到基地边上把它拆掉——采样随之作废。
 * 第二条**不需要在这里补代码**：`lunarWinner` / `samplingOf` 只认活着的基地，
 * 基地一没，胜负判定自然回到"城打光就输"。
 */

import type { GameState, PlayerId, SkillDef, Unit, UnitTypeDef } from '../types.ts';
import { boardIdOf, boardOf } from '../board.ts';
import { CONFIG, passable } from '../config.ts';
import { registerSkillEffect, registerSkillReadyCheck } from '../skill-hooks.ts';
import { MOON_BOARD } from './silo.ts';

export const MOON_BASE_ID = 'moon-base';

/** 采样要几个自己的回合才送回结果 */
export const SAMPLE_TURNS = 3;

/** 基地占地边长 */
export const BASE_FOOTPRINT = 2;

export const LUNAR_SAMPLING: SkillDef = {
  id: 'lunar-sampling',
  name: '月壤采样',
  summary:
    `把月壤样本封进返回舱，${SAMPLE_TURNS} 个回合后结果送回地球；` +
    '结果一到，本方直接获胜。整局只能做一次。' +
    '<b>基地挨打就作废</b>：进度清零，要重新开始——所以登月之后还得守。',
  effect: 'lunar-sampling',
  // 一次性：真正的闸门在就绪检查里（做过就不能再做），冷却留着是为了按钮文案
  cooldown: 0,
  multiCast: false,
  targeting: 'none',
};

export const MOON_BASE: UnitTypeDef = {
  id: MOON_BASE_ID,
  name: '月球基地',
  short: '基',
  era: 5,
  category: 'building',
  // 不卖、不产、不进选卡：只能由工程单位在月面展开
  cost: 0,
  move: 0,
  atk: 0,
  armor: 12,
  maxHp: 200,
  range: 0,
  // 视野要够：基地是月面上唯一"看得远"的东西，落地就能看清周围
  vision: 5,
  footprint: 2,
  summonedOnly: true,
  skills: [LUNAR_SAMPLING],
};

// ── 采样状态（存在 custom 里，老存档没有就是没开始） ────────────────

interface BaseState {
  /** 还剩几个自己的回合；0 = 没在采样 */
  left: number;
  /** 结果已经送回（赢） */
  sampled: boolean;
}

function baseStateOf(u: Unit): BaseState {
  const raw = Number(u.custom?.sample ?? 0);
  const left = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  return { left, sampled: u.custom?.sampled === true };
}

function log(s: GameState, p: PlayerId, text: string, open = false): void {
  s.log.push({ turn: s.turn, player: p, text, open });
}

// ── 展开 ─────────────────────────────────────────────────────────────

/**
 * 「平地」的定义：能走，而且不额外费脚力（`terrainCost` ≤ 1）。
 *
 * 为什么不硬编码 `regolith`：以后给月面加地形（沙脊、浅坑）时，
 * 谁算平地该由地形表说话，而不是回来改这个函数。
 * 环形山是 2——爬坑缘费劲，算不上平地。
 */
function isFlat(t: keyof typeof CONFIG.terrainCost): boolean {
  return passable(t) && (CONFIG.terrainCost[t] ?? 99) <= 1;
}

/**
 * 2×2 能不能落在这里（在月图里、**整块平地**、没被占）。
 *
 * 地形要求是"整块平地"而不只是"能走"：文案一直写着"要一块平地"，
 * 以前实际只判了 `passable`，于是环形山（2 步、+2 甲）也能展开——
 * 等于文案在骗人。现在按文案来：四格都得是平地，站在环形山边上就得先挪一格。
 *
 * `ignoreId` 是**要展开的那个人自己**：他就站在锚点上，不排掉的话
 * "脚下这一格被占着"，一块平地都放不下。
 */
function canPlaceBaseAt(s: GameState, x: number, y: number, ignoreId?: string): boolean {
  const moon = boardOf(s, MOON_BOARD);
  for (let dy = 0; dy < BASE_FOOTPRINT; dy++) {
    for (let dx = 0; dx < BASE_FOOTPRINT; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= moon.w || ty >= moon.h) return false;
      const tile = moon.tiles[ty * moon.w + tx];
      if (!tile || !isFlat(tile.terrain)) return false;
      // 月面上没有城；占地的只可能是单位（含另一座基地）
      const busy = s.units.some(
        (u) =>
          u.id !== ignoreId &&
          boardIdOf(u) === MOON_BOARD &&
          tx >= u.x &&
          tx < u.x + (s.unitTypes[u.type]?.footprint === 2 ? 2 : 1) &&
          ty >= u.y &&
          ty < u.y + (s.unitTypes[u.type]?.footprint === 2 ? 2 : 1),
      );
      if (busy) return false;
    }
  }
  return true;
}

/**
 * 从工程单位脚下往外找一角能放下 2×2 的锚点。
 *
 * 顺序很重要：先试"你就是左上角"，再往左上角挪。玩家站在月面中心时
 * 多半是第一种；站在着陆点最里侧时靠后三种才放得下。
 */
export function baseAnchorFor(s: GameState, u: Unit): { x: number; y: number } | null {
  for (const [dx, dy] of [
    [0, 0],
    [-1, 0],
    [0, -1],
    [-1, -1],
  ] as const) {
    if (canPlaceBaseAt(s, u.x + dx, u.y + dy, u.id)) return { x: u.x + dx, y: u.y + dy };
  }
  return null;
}

/** 这个单位能不能在这儿展开基地。返回 null = 可以 */
export function deployProblem(s: GameState, u: Unit): string | null {
  if (boardIdOf(u) !== MOON_BOARD) return '要在月球上才能展开基地';
  if (s.unitTypes[u.type]?.category !== 'builder') return '只有工程单位能展开月球基地';
  if (s.units.some((x) => x.owner === u.owner && x.type === MOON_BASE_ID)) {
    return '本方已经有一座月球基地了';
  }
  if (!s.boards?.[MOON_BOARD]) return '这一局没有月球图';
  if (!baseAnchorFor(s, u)) return '这里放不下 2×2 的基地（四格都得是月壤平地，环形山不行）';
  return null;
}

/**
 * 展开：工程单位并进基地，凭空多出一座 2×2。
 *
 * **沿用原来那个 id**（不是新发一个）：`recordDeaths` 是按 id 数人头的，
 * 换了 id 就等于"这支工程队阵亡了"，它会掉进 `fallen` 名单——魂修的招魂
 * 能把一支已经变成基地的工程队拉回棋盘。沿用 id 之后，`recordDeaths`
 * 只看到"这支兵还在，只是换了兵种"，不会有假阵亡。
 *
 * 顺带一个好处：界面上 `selectedId` 还指着它，展开之后侧栏直接跳到基地卡，
 * 玩家不用再点一次。
 */
export function deployBase(s: GameState, u: Unit): string | null {
  const problem = deployProblem(s, u);
  if (problem) return problem;
  const at = baseAnchorFor(s, u)!;

  s.units = s.units.filter((x) => x.id !== u.id);
  s.units.push({
    id: u.id,
    type: MOON_BASE_ID,
    owner: u.owner,
    x: at.x,
    y: at.y,
    hp: MOON_BASE.maxHp,
    kills: 0,
    moved: true,
    acted: true,
    // 和"刚招出来的兵"同一条：落地这一回合不能放技能，免得"展开 + 采样"一口气做完
    bornTurn: s.turn,
    board: MOON_BOARD,
  });
  log(
    s,
    u.owner,
    `${s.unitTypes[u.type]?.name ?? '工程单位'}在月面展开成「月球基地」——接下来只要把月壤采样送回来就赢了`,
    true,
  );
  return null;
}

// ── 采样 ─────────────────────────────────────────────────────────────

/**
 * 所有在采样（或已采完）的基地，按 `s.units` 的顺序。
 *
 * 以前只返回**第一个**，于是顶栏只有一个「登月 n」：两个人同时登月时，
 * 其中一个的倒计时是隐形的。而这条胜利条件本质是场竞赛——"谁先送回谁赢"，
 * 看不见对手的进度就等于看不见这场竞赛的另一半。
 *
 * 同一方最多一座基地（`deployProblem` 挡着），所以不用去重。
 */
export function samplingsOf(s: GameState): Array<{ owner: PlayerId; left: number; done: boolean }> {
  const out: Array<{ owner: PlayerId; left: number; done: boolean }> = [];
  for (const u of s.units) {
    if (u.type !== MOON_BASE_ID || u.hp <= 0) continue;
    const st = baseStateOf(u);
    if (st.sampled) out.push({ owner: u.owner, left: 0, done: true });
    else if (st.left > 0) out.push({ owner: u.owner, left: st.left, done: false });
  }
  return out;
}

/** 正在采样/已完成的那个基地（单数版；多人同时采样时只看得到第一个，见上） */
export function samplingOf(s: GameState): { owner: PlayerId; left: number; done: boolean } | null {
  return samplingsOf(s)[0] ?? null;
}

/** 有人的采样结果送回了 → 他赢。没有就返回 undefined（**必须**是 undefined） */
export function lunarWinner(s: GameState): PlayerId | undefined {
  for (const u of s.units) {
    if (u.type !== MOON_BASE_ID || u.hp <= 0) continue;
    if (baseStateOf(u).sampled) return u.owner;
  }
  return undefined;
}

/** 回合开始：只推进自己的基地 */
export function tickMoonBases(s: GameState, player: PlayerId): void {
  for (const u of s.units) {
    if (u.owner !== player || u.type !== MOON_BASE_ID) continue;
    const st = baseStateOf(u);
    if (st.sampled || st.left <= 0) continue;
    const left = st.left - 1;
    u.custom = { ...(u.custom ?? {}), sample: left };
    if (left <= 0) {
      u.custom.sampled = true;
      log(
        s,
        player,
        `${s.unitTypes[u.type]?.name ?? '月球基地'}的月壤采样结果送回地球——登月成功`,
        true,
      );
    }
  }
}

/** 面板上的几行字。对手看得到"还剩几回合"（那是压力），看不到别的 */
export function moonBaseLines(_s: GameState, u: Unit, viewer?: PlayerId): string[] {
  if (u.type !== MOON_BASE_ID) return [];
  const mine = viewer === undefined || viewer === u.owner;
  const st = baseStateOf(u);
  const out: string[] = [];
  if (st.sampled) {
    out.push('月壤采样结果已送回：登月胜利达成');
    return out;
  }
  if (st.left > 0) {
    out.push(`月壤采样进行中：还剩 ${st.left} 个回合送回结果`);
    out.push('基地一挨打就作废（进度清零）——要么有人守，要么别急着点');
  } else if (mine) {
    out.push(`点「月壤采样」（主动技能）开始；结果 ${SAMPLE_TURNS} 个回合后送回，一到就赢`);
  } else {
    out.push('还没开始采样');
  }
  if (mine) out.push(`基地 ${u.hp} / ${MOON_BASE.maxHp}：被打掉的话采样作废`);
  return out;
}

/**
 * 采样被打断：基地**挨一下**就作废，进度清零。
 *
 * 为什么门槛这么低（哪怕只掉 1 点血）：这条胜利条件原本是"开始采样 = 赢"，
 * 对手没有任何反制。清零之后，一个普通兵贴上基地就能把倒计时按死——
 * 于是"登月"从"飞上去就赢"变成"飞上去还要守"，投送率（一次一个 / 3 回合加注）
 * 才第一次成为真实的资源竞争。
 *
 * 不做"≥N 点伤害才算"的门槛：那是数值问题，真要调只改这一个数，
 * 机制不必重写。也不加冷却：清零之后随时可以重新点，倒计时从头算——
 * 玩家看到的永远是"还剩几个回合"，而不是一个隐藏的冷却条。
 *
 * 环境伤害（中毒/灼烧/天气）不算：它们走 `tickStatuses` 扣血，不经过
 * `hurtUnit`，所以天然不触发这里——"被打断"必须真的是对面在打你。
 */
export function interruptSampling(s: GameState, base: Unit, source?: Unit): void {
  if (base.type !== MOON_BASE_ID) return;
  const st = baseStateOf(base);
  if (st.left <= 0 || st.sampled) return;
  base.custom = { ...(base.custom ?? {}), sample: 0 };
  const who = source ? `「${s.unitTypes[source.type]?.name ?? source.type}」` : '';
  log(
    s,
    base.owner,
    `月球基地挨了${who}一下，月壤采样被打断（进度清零，要重新开始）`,
    true,
  );
}

// ── 技能注册 ─────────────────────────────────────────────────────────

registerSkillReadyCheck('lunar-sampling', (_s, u) => {
  if (u.type !== MOON_BASE_ID) return '只有月球基地能做月壤采样';
  const st = baseStateOf(u);
  if (st.sampled) return '采样结果已经送回了';
  if (st.left > 0) return `采样正在进行（还剩 ${st.left} 回合）`;
  return true;
});

registerSkillEffect('lunar-sampling', (c) => {
  const u = c.self;
  if (u.type !== MOON_BASE_ID) {
    c.result.ok = false;
    c.result.reason = '只有月球基地能做月壤采样';
    return;
  }
  const st = baseStateOf(u);
  if (st.sampled) {
    c.result.ok = false;
    c.result.reason = '采样结果已经送回了';
    return;
  }
  if (st.left > 0) {
    c.result.ok = false;
    c.result.reason = `采样正在进行（还剩 ${st.left} 回合）`;
    return;
  }
  u.custom = { ...(u.custom ?? {}), sample: SAMPLE_TURNS };
  /*
   * 这条要**公开**：对手必须知道"他还有 3 个回合就赢了"，
   * 那正是这条胜利条件唯一的张力。所以自己写日志，把核心那条私有的让掉。
   */
  c.state.log.push({
    turn: c.state.turn,
    player: u.owner,
    text:
      `${c.state.unitTypes[u.type]?.name ?? '月球基地'}开始月壤采样：` +
      `${SAMPLE_TURNS} 个回合后把结果送回地球，届时本方获胜`,
    open: true,
  });
  c.result.log = '';
});

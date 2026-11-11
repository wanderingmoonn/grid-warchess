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
import { passable } from '../config.ts';
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
    '结果一到，本方直接获胜。整局只能做一次。',
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
 * 2×2 能不能落在这里（在月图里、地形过得去、没被占）。
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
      if (!tile || !passable(tile.terrain)) return false;
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
  if (!baseAnchorFor(s, u)) return '这里放不下 2×2 的基地（要一块平地）';
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

/** 正在采样/已完成的那个基地（给顶栏倒计时用） */
export function samplingOf(s: GameState): { owner: PlayerId; left: number; done: boolean } | null {
  for (const u of s.units) {
    if (u.type !== MOON_BASE_ID || u.hp <= 0) continue;
    const st = baseStateOf(u);
    if (st.sampled) return { owner: u.owner, left: 0, done: true };
    if (st.left > 0) return { owner: u.owner, left: st.left, done: false };
  }
  return null;
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
  } else if (mine) {
    out.push(`点「月壤采样」（主动技能）开始；结果 ${SAMPLE_TURNS} 个回合后送回，一到就赢`);
  } else {
    out.push('还没开始采样');
  }
  if (mine) out.push(`基地 ${u.hp} / ${MOON_BASE.maxHp}：被打掉的话采样作废`);
  return out;
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

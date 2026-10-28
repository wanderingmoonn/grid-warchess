/**
 * 组装层：把规则内核、视图过滤、渲染、存档粘在一起。
 *
 * 这一层只做三件事：读事件 → 造 Action → 重绘。
 * 它不允许直接改 state 的任何字段（切换迷雾除外，那不是规则行为）。
 */

import './style.css';

import { expansionById } from './core/expansions.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiLevelLabel, aiLevelOf, aiNextAction, anyAiSide, isAiSide } from './core/ai.ts';
import type { AiBudget } from './core/ai.ts';
import { CITY, CONFIG, ORDER_UPGRADE, passable } from './core/config.ts';
import { playerView } from './core/fog.ts';
import {
  adjacentToWater,
  applyAction,
  attackableTargets,
  canAttack,
  canMove,
  cityAt,
  citiesOf,
  distance,
  disbandRefundOf,
  eggSpots,
  idx,
  incomeOf,
  isAirborne,
  ordersOf,
  reachableTiles,
  recruitCost,
  recruitSpawnCells,
  refreshMemory,
  siegeTargets,
  threatTiles,
  unitIncomeAt,
  unitsAt,
  unitsOf,
  upgradeCostOf,
  utype,
} from './core/rules.ts';
import {
  clearUnits,
  paintTerrain,
  placeCity,
  placeUnit,
  removeAt,
  sandboxCityProblem,
} from './core/sandbox.ts';
import type { SandboxResult } from './core/sandbox.ts';
import { loadCustomUnits } from './core/customUnits.ts';
import { createMatch, DEFAULT_CONFIG, normalizePlayerNames, randomSeed } from './core/setup.ts';
import type { Action, GameState, PlayerId, Terrain, Unit, UnitTypeDef } from './core/types.ts';
import { coordsFromEvent, renderBoard } from './ui/board.ts';
import { renderPanel, seasonLabel, topbarShell, updateTopbar, TERRAIN_NAMES } from './ui/panel.ts';
import type { PanelInput, PanelReport } from './ui/panel.ts';
import { buildMatchReport, reportFileName, reportJson, reportSignature } from './core/report.ts';
import { newTimeline, noteAction, sampleTurn, timelineSummary, type MatchTimeline } from './core/timeline.ts';
import { uploadReport } from './net/reports.ts';
import { godBarHtml, godShelfHtml } from './ui/god-panel.ts';
import type { GodBrush } from './ui/god-panel.ts';
import { loadChimeVolume, nextChimeVolume, playChime, saveChimeVolume } from './ui/sound.ts';
import { openSetupPanel } from './ui/setup-panel.ts';
import { openOnlinePanel } from './ui/online-panel.ts';
import { manualBooks, openManualChooser } from './ui/books.ts';
import { openUnitEditor } from './ui/unit-editor.ts';
import {
  claimSeat,
  fetchRoom,
  loadSeat,
  newToken,
  normalizeCode,
  originMismatch,
  saveSeat,
  submitTurn,
  type RoomSeat,
  type RoomSnapshot,
} from './net/room.ts';
import {
  clearMatch,
  exportMatch,
  importMatch,
  loadMatch,
  saveMatch,
  setSaveScope,
} from './storage/save.ts';

/** 取元素，取不到直接抛——界面结构缺失属于硬错误，不该静默继续 */
function pick<T extends Element>(parent: ParentNode, sel: string): T {
  const el = parent.querySelector<T>(sel);
  if (!el) throw new Error(`界面结构缺少 ${sel}`);
  return el;
}

const appEl = pick<HTMLElement>(document, '#app');

appEl.innerHTML = `
  <div class="app">
    <header class="topbar" id="topbar"></header>
    <div class="commander-bar" id="commander" hidden></div>
    <div class="main">
      <div class="board-wrap" id="board-wrap">
        <div class="force-flag" id="force-flag" hidden></div>
        <div class="board-scroll" id="board-scroll">
          <div class="board" id="board"></div>
        </div>
        <div class="zoom-bar" id="zoom-bar">
          <button class="zoom-btn" data-act="zoom-fit" data-ref="zoom-fit" title="让整张图回到屏幕里">适应</button>
          <button class="zoom-btn" data-act="zoom-out" title="缩小">−</button>
          <button class="zoom-btn" data-act="zoom-in" title="放大">＋</button>
        </div>
      </div>
      <aside class="side" id="side"></aside>
    </div>
  </div>
`;

const boardEl = pick<HTMLElement>(appEl, '#board');
const boardWrapEl = pick<HTMLElement>(appEl, '#board-wrap');
/**
 * 真正滚动的容器。
 *
 * 为什么缩放条不能直接挂在 board-wrap 上：board-wrap 一旦自己滚动，
 * 它里面的绝对定位子元素会跟着内容一起走——表现就是"放大之后拖动地图，
 * 按钮跟着跑掉了"。所以滚动挪到内层，缩放条留在外层，
 * 它只认"可视区域"这一个坐标系，永远钉在右下角。
 */
const boardScrollEl = pick<HTMLElement>(appEl, '#board-scroll');
/**
 * 强制模式的横幅。
 *
 * 这个模式会**接管整个棋盘的点击**（每一格只有"走过去 / 开火"一种解释），
 * 所以它必须一直看得见。按钮在侧栏里，玩家滚到战报那一段就把它忘了，
 * 之后在棋盘上点什么都没反应——第一反应只会是"卡住了"。
 */
const forceFlagEl = pick<HTMLElement>(appEl, '#force-flag');
const sideEl = pick<HTMLElement>(appEl, '#side');
const topbarEl = pick<HTMLElement>(appEl, '#topbar');
const commanderEl = pick<HTMLElement>(appEl, '#commander');

// 顶栏骨架只插一次。之后每一步只改文字/class/hidden，绝不重建按钮节点——
// 否则 AI 连续行动时 click 会在 mousedown 与 mouseup 之间丢掉目标（按钮点不动）。
topbarEl.innerHTML = topbarShell();

// 应急入口：地址栏带 ?fresh=1 就丢掉本机存档重开。
// 留着是因为"存档坏了进不去"这件事，除了让人清缓存之外总得有个说法，
// 而这个入口不需要打开开发者工具、也不需要知道 localStorage 在哪。
if (new URLSearchParams(location.search).get('fresh') === '1') {
  try {
    clearMatch();
  } catch {
    // 隐私模式写不了，忽略
  }
}

let state: GameState = loadMatch() ?? createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
let selectedId: string | null = null;

/**
 * 撤回栈：每一步成功的操作之前，把旧 state 存进来。
 *
 * 只在本回合、只有自己一个人的局里有效——联机对局一提交就已经推到对面了，
 * 撤回等于改历史，两边会直接对不上。跨回合也不给撤（上一回合的账已经结了）。
 *
 * 存的是 state 的**引用**而不是克隆：applyAction 内部本来就 structuredClone 过，
 * 旧对象不会再被修改，留着引用是安全的，也省掉每步一次深拷贝。
 */
let undoStack: GameState[] = [];
const UNDO_LIMIT = 30;

/** 回合提示音的音量，存在 localStorage 里 */
let chimeVolume = loadChimeVolume();
/** 上一次渲染时的行动方：用来判断"回合是不是换人了" */
let lastTurnPlayer: PlayerId | null = null;
let selectedCityId: string | null = null;
/** 选中的己方军营（点开来当产兵面板用） */
let selectedCampId: string | null = null;
/** 点空地时选中的地形，用来在面板里看说明 */
let selectedTile: { x: number; y: number } | null = null;
/**
 * 产兵搜索框里的字。
 *
 * 放在模块级而不是面板里，是因为面板每次都整块重绘：字存进 DOM 的话，
 * 敲一个字就被下一次 render 冲掉。这里存字、重绘时回填，光标落到末尾。
 */
let recruitQuery = '';
/**
 * 产兵列表按扩展包筛选：'' = 全部，'core' = 原版，其它是扩展 id。
 *
 * 和 recruitQuery 一样存在这里而不是 DOM 里：面板整块重绘，状态必须由
 * JS 侧持有。搜索是"找已知的名字"，这个开关是"先圈定范围再找"，两件事。
 */
let recruitPack = '';

/**
 * 「允许上传对局数据」这个开关本身。
 *
 * 默认关，存在本机：这是一次性的意愿，不该每打完一局都拿弹窗问一遍。
 * 但它只代表"允许"——真正的发送仍然要在结算卡上点一次按钮。
 */
const REPORT_OPT_KEY = 'warchess.report.optin';
function loadReportOptIn(): boolean {
  try {
    return localStorage.getItem(REPORT_OPT_KEY) === '1';
  } catch {
    return false;
  }
}
let reportOptIn = loadReportOptIn();
/** 写回许可开关：开局勾了详细记录时用它，和结算卡里那个勾选框是同一份偏好 */
function saveReportOptIn(v: boolean): void {
  reportOptIn = v;
  try {
    localStorage.setItem(REPORT_OPT_KEY, v ? '1' : '0');
  } catch {
    // 隐私模式写不进去：这一次有效，下次打开回到默认（关）
  }
}
/**
 * 结算卡上那次上传走到哪一步。
 *
 * 只活在这次会话里：刷新页面就回到 idle，反正报告随时能重新生成。
 * 也刻意不做"失败自动重试"——传不上去就明说，别在后台偷偷再发一遍。
 */
let reportSend: { status: 'idle' | 'sending' | 'done' | 'failed'; note?: string; howTo?: string } = {
  status: 'idle',
};
/** 上一份已结算对局的指纹：换了新的一局，上传状态就清回 idle */
let reportSig = '';

/**
 * 已经传过的那几局的指纹。
 *
 * 为什么要记：一局打完的存档会留在本机，刷新页面还能再看见结算卡——
 * 不记的话同一局能被传三遍，数据里就多出三个"一模一样的人"，
 * 统计出来的胜率立刻歪掉。留 20 个够用，也只占几十字节。
 */
const REPORT_SENT_KEY = 'warchess.report.sent';
function loadSentReports(): string[] {
  try {
    const raw = localStorage.getItem(REPORT_SENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
let reportSentSigs = loadSentReports();

/**
 * 这一局的逐回合摘要。
 *
 * 只在 config.recordDetail 打开时存在；**不放进 GameState**——它是观测量，
 * 不是棋局状态，塞进去会让存档、联机同步、规则测试都得为它让路。
 * 代价是刷新页面会丢（记不清了就记不清，报告里本来就有"帧数"可以看出来），
 * 换来的是核心规则一厘米都没变。
 */
let recorder: MatchTimeline | null = null;

/** 按当前对局的配置决定要不要记；换局 / 读档之后调一次 */
function resetRecorder(): void {
  recorder = state.config.recordDetail === true && state.config.godMode !== true
    ? newTimeline(state.turn)
    : null;
  // 开局先落一帧基线。没有它的话，"第 1 回合就结束"的局会交上一份 0 帧摘要
  // （2026-10-28 实测：一局认输，上传上来的 timeline 里 samples 是空的）。
  if (recorder) sampleTurn(state, recorder, true);
}

/** 记一步（AI 和玩家都走这里） */
function noteStep(actor: PlayerId, action: Action): void {
  if (!recorder) return;
  noteAction(recorder, actor, action);
}

/** 回合结束：采一帧。两处会结束回合——玩家点、AI 循环末尾 */
function noteTurnEnd(): void {
  if (!recorder) return;
  sampleTurn(state, recorder);
}

/**
 * 分出胜负的那一刻补最后一帧。
 *
 * 认输、或者最后一个兵被打死，都不会走"结束回合"，所以只挂在 END_TURN 上是采不到的。
 * 这一帧很重要：它记的是胜负定格时的双方身价与兵力，正是"崩在哪一步"的终点。
 */
function noteFinalFrame(): void {
  if (!recorder || !state.winner) return;
  const last = recorder.samples[recorder.samples.length - 1];
  if (last && last.t === state.turn) return; // 这一回合已经采过了
  sampleTurn(state, recorder, true);
}

function markReportSent(sig: string): void {
  reportSentSigs = [sig, ...reportSentSigs.filter((x) => x !== sig)].slice(0, 20);
  try {
    localStorage.setItem(REPORT_SENT_KEY, JSON.stringify(reportSentSigs));
  } catch {
    // 存不进去顶多下次再传一遍，不影响这一局
  }
}

let reach: number[] = [];
let targets: string[] = [];
let siege: string[] = [];
/** 非空时表示某个建造单位正在选址 */
let buildPlan: { unitId: string; type: string } | null = null;
/**
 * 非空时表示"正在给这一船选下水的位置"。
 *
 * 临水的城常常挨着好几片水（城角一片湖、另一侧一条河），以前只能从
 * 列表里的第一格下水——想让它从另一侧绕过去，唯一的办法是先把那格水填了。
 * 现在点水军的产兵按钮先"上膛"，棋盘上把能下水的格点亮，点哪格就从哪格出。
 */
let spawnPlan: {
  cityId?: string;
  campId?: string;
  type: string;
  cells: number[];
} | null = null;
/** 非空时表示这条船正在等人上船（值是船的 id） */
let loadPlan: string | null = null;
/** 非空时表示这条船正在找地方下船（值是船的 id） */
let unloadPlan: string | null = null;
let handoffOpen = false;
/**
 * 强制模式：**扣住**的，不是"上膛一次"。
 *
 * 早先这里是"点一下按钮 = 给下一次点击换一种解释，然后自动卸下"。实战里
 * 这条最坑人：强制移动往往要连点几下（先往桥上挪、再挪到桥中间、发现走错了
 * 换一格），而第二下点击就已经回到普通语义——那一下要是点在别的单位上，
 * 手上的兵就被换掉了，"强制"这件事还没做完，先被自己的操作打断。
 * 飞行单位最明显：它停在敌人头顶，脚底下那格永远压着一个单位，
 * 第二下点击必定选中敌人，飞行的走位就此断在半路。
 *
 * 现在按"模式"来：点按钮进入并**保持**，期间棋盘的点击只按这一个动词解释
 * （不选中、不下别的指令），再点同一个按钮才退出。按住 Alt/Shift 仍然是
 * 一次性的修饰键，两边互不干扰——老玩家的手感不动。
 */
let forceMode: 'move' | 'attack' | null = null;
/**
 * 同一格上压着好几个东西时的轮换位置。
 *
 * 为什么需要它：兵站在自己的塔上、飞行单位停在敌人头顶，点这一格
 * 永远只会命中 DOM 最上面那一个，下面那个就再也选不中——而"选中它"
 * 是拆塔、驻军、看属性的前提。连点同一格 = 往下翻一层。
 */
let pickState: { key: number; ids: string[]; index: number } | null = null;

/** AI 每一步之间的停顿，三档：慢、快、极快（0 = 不等，但仍然让出主线程） */
const AI_SPEED_MS = [180, 70, 0];
const AI_SPEED_NAME = ['慢', '快', '极快'];
// 默认用最慢档：第一次看 AI 走棋得看清它在干什么，也留出按"暂停"的时间
let aiSpeed = 0;
/** 观战时可以随时按暂停，让 AI 停在当前这一步 */
let aiPaused = false;
/** 每次启动或中止 AI 循环都 +1，旧循环看到自己的令牌过期就自己退出 */
let aiToken = 0;

/**
 * 下一步移动要走的路线，只用于画动画。
 *
 * 只活一次：render() 把它交给棋盘、随即清空。留着不清的话，下一次重绘
 * （比如点了个按钮）会拿旧路线再演一遍，看起来像棋子又走了一次。
 */
let pendingMovePath: Map<string, Array<{ x: number; y: number }>> | null = null;

/** 记一条"这个单位这一步是从哪走到哪"，供动画用 */
function planMovePath(before: GameState, action: Action): void {
  if (action.type !== 'MOVE') return;
  const u = before.units.find((x) => x.id === action.unitId);
  if (!u) return;
  pendingMovePath = new Map([
    [u.id, pathCells(before, { x: u.x, y: u.y }, { x: action.x, y: action.y })],
  ]);
}

/**
 * 从起点到终点的一条路（四连通 BFS，只绕不可走地形）。
 *
 * 这是**画动画用的**，不是规则：它不看移动力、不看单位阻挡，所以不能拿去
 * 判断"这一步合不合法"。规则层算出来的可达格是另一套（reachableTiles）。
 * 走不通（比如飞行单位直接飞过河）时退化成"起点直连终点"。
 */
function pathCells(
  s: GameState,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const w = s.w;
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  const prev = new Map<number, number>();
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  while (queue.length > 0 && !prev.has(goal)) {
    const cur = queue.shift() as number;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= s.h) continue;
      const ni = ny * w + nx;
      if (seen.has(ni)) continue;
      const tile = s.tiles[ni];
      if (!tile || !passable(tile.terrain)) continue;
      seen.add(ni);
      prev.set(ni, cur);
      queue.push(ni);
      if (ni === goal) break;
    }
  }
  if (!prev.has(goal)) return [from, to];
  const cells: Array<{ x: number; y: number }> = [];
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur);
    if (p === undefined) return [from, to];
    cells.push({ x: cur % w, y: Math.floor(cur / w) });
    cur = p;
  }
  cells.push(from);
  cells.reverse();
  return cells;
}

/** 现在这一方是 AI 在走、且没被暂停 */
function aiBusy(): boolean {
  return isAiSide(state, state.current) && !aiPaused;
}

/** 观战席位：坐在房间里但没有座位，只能看 */
function watching(): boolean {
  return room?.spectator === true;
}

/** 双 AI 观战：谁都还没"入座"，给全图视角，否则看的是某一方的迷雾 */
function spectating(): boolean {
  // 上帝模式也是全图：沙盒里藏信息毫无意义——盘上的兵都是自己摆上去的。
  // 迷雾要是没关，摆完 B 方的兵下一帧就看不见了，这个模式会变得没法用。
  if (state.config.godMode === true) return true;
  // 房间观战位是同一回事：没有"我方"，迷雾就没有意义
  if (watching()) return true;
  return isAiSide(state, 'A') && isAiSide(state, 'B');
}

// ---------- 联机 ----------

/** 当前房间；null 表示这是本机对局 */
let room: RoomSeat | null = null;
/**
 * 本回合有没有还没提交的改动。
 * 有草稿时绝不能让轮询拿云端状态盖掉——那等于把玩家刚摆好的兵删了。
 */
let dirty = false;
let roomTimer = 0;

/** 记住"我现在在哪一局房间里"，刷新页面能自己回到那一局 */
const ROOM_KEY = 'warchess:room-current';

function rememberRoom(code: string | null): void {
  try {
    if (code) localStorage.setItem(ROOM_KEY, code);
    else localStorage.removeItem(ROOM_KEY);
  } catch {
    // 隐私模式无所谓，顶多刷新之后要重新输一次代码
  }
}

/**
 * 刷新页面时回到上一局房间。
 *
 * 关键点：先把存档作用域切到房间槽，**再**去读草稿——
 * 否则读到的会是本机那局，把没提交的走法弄丢。
 */
function resumeRoom(): boolean {
  try {
    const code = localStorage.getItem(ROOM_KEY);
    if (!code) return false;
    const seat = loadSeat(code);
    if (!seat) return false;
    room = seat;
    setSaveScope(code);
    const draft = loadMatch();
    if (draft) state = draft;
    startRoomPolling();
    return true;
  } catch {
    return false;
  }
}

/** 视角玩家：联机时永远是自己那一方，而不是"现在轮到谁" */
function me(): PlayerId {
  // 上帝模式没有"我的一方"：两边都归你摆，所以视角跟着当前行动方走。
  // 这一步很重要——面板和点击判定里的 `mine` 都要有个主人，
  // 固定成 A 会让"轮到蓝方时点蓝方的兵"变成点别人家的东西。
  if (state.config.godMode === true) return state.current;
  // 观战位没有"我的一方"，给谁都一样——渲染走的是全图，
  // 面板里所有"我的"判断都被 spectator 挡住了。
  if (watching()) return 'A';
  if (room) return room.seat;
  // 人机局：AI 那一方永远不是"我"。
  //
  // 以前这里跟着 state.current 走，于是 AI 的回合里面板把 AI 的兵当成自己的，
  // 产兵、升级、技能全都亮着（点下去又被 aiBusy 挡住），视野也跟着 AI 走。
  // 现在"我是谁"是固定的，AI 走它的回合时，面板就是一张只读的卡。
  const aiA = isAiSide(state, 'A');
  const aiB = isAiSide(state, 'B');
  if (aiA !== aiB) return aiA ? 'B' : 'A';
  return state.current;
}

/**
 * 战报用谁的眼睛看：null = 全都看得见。
 *
 * 只看自己这一方，是因为"对面造了什么、走了哪、攒了多少钱"属于迷雾该管的事。
 * 但战损（兵倒下、桥塌、城破）棋盘上看得见，瞒着只会让人以为界面算错了——
 * 所以那类条目带 `open` 标记，两个人都能读到。
 */
function logScope(): PlayerId | null {
  // 观战位 / 双 AI 观战：本来就没有"我方"
  if (watching() || spectating()) return null;
  // 热座：一台机器两个人轮流玩，谁都别装看不见
  if (!room && !isAiSide(state, 'A') && !isAiSide(state, 'B')) return null;
  return me();
}

/** 取当前房间。用函数包一层是为了绕开模块级变量的控制流收窄 */
function currentRoom(): RoomSeat | null {
  return room;
}

/** 联机时轮到我操作吗（本机对局恒为 true） */
function myTurn(): boolean {
  if (!room) return true;
  // 观战位永远"不是我的回合"：这一个判断同时挡住了走子、产兵、提交、认输
  if (room.spectator) return false;
  return state.current === room.seat;
}

/**
 * 面板要的全部输入。
 *
 * 抽成函数是为了"只重画面板"这条路：搜索框每敲一个字都要重绘，
 * 走整个 render() 会连棋盘一起重建，白掉一次图层、还丢焦点。
 */
function panelInput(): PanelInput {
  const view = playerView(state, me(), spectating());
  const picked = selectedId ? (view.state.units.find((u) => u.id === selectedId) ?? null) : null;
  return {
    view,
    me: me(),
    // 注意用 view.state 而不是 state：面板同样不该看到视野外的东西
    selectedUnit: picked,
    selectedCityId,
    selectedCampId,
    selectedTile,
    // 联机同样能撤：提交（结束回合）会把栈清空，所以「还能撤」本身就等于「还没提交」
    canUndo: undoStack.length > 0,
    chimeVolume,
    recruitQuery,
    recruitPack,
    logSide: logScope(),
    spawnPick: spawnPlan ? { type: spawnPlan.type } : null,
    spectator: watching(),
    // 指挥官模式也走"只看"这条线：mine 关掉，但提示文案不一样
    commander: state.config.commanderMode === true,
    forceMode,
    report: reportPanel(),
  };
}

/**
 * 结算卡上的上传区块：一局打完才给。
 *
 * 三种情况不给：
 *   · 沙盒——那盘棋是摆出来试兵的（十个坦克打一个农民），交上去只会把数据搅浑；
 *   · 房间观战位——那不是你的对局，你也没法替两个当事人点头；
 *   · 还在打——没有结局的报告没有用。
 *
 * 双 AI 观战**给**：那正是最该被收集的一类数据（AI 自己打出来的平衡问题，
 * 人打十局也未必撞得上）。
 *
 * 顺手在这里做"换局就清状态"：render 每帧都会走到，不用在十几个
 * "开新局 / 读存档 / 联机同步"的地方各写一遍重置。
 */
function reportPanel(): PanelReport | undefined {
  if (!state.winner || state.config.godMode === true || watching()) return undefined;
  const sig = reportSignature(buildMatchReport(state, new Date(), recorder));
  if (sig !== reportSig) {
    reportSig = sig;
    // 这一局之前传过（刷新页面又看见结算卡），就别再让点一遍
    reportSend = reportSentSigs.includes(sig)
      ? { status: 'done', note: '这局已经上传过了，不用再传一遍' }
      : { status: 'idle' };
  }
  // 配置里说要记、但一帧都没有：中途刷新过（记录器在内存里）或者开了沙盒。
  // 不写这一句的话，玩家会以为"我明明勾了"，然后在数据里留下一个沉默的洞。
  const detail =
    timelineSummary(recorder) ||
    (state.config.recordDetail === true
      ? '（这局没记下摘要：中途刷新过页面，或这一局是沙盒）'
      : '');
  return { optedIn: reportOptIn, detail, ...reportSend };
}

/**
 * 侧栏整块重绘，但保住滚动位置。
 *
 * innerHTML 一换，滚动条就回到顶端。普通对局里这不过是"面板跳了一下"，
 * 在沙盒里却很致命：一场几十回合的仗打完，玩家正顺着战报往下读，
 * 收尾那一帧就把他甩回顶部，得重新往下滚一遍才找得到刚才看到哪。
 *
 * 内外两层一起记：侧栏自己会滚（.side），战报和货架还各有一个内层滚动条。
 */
function keepSideScroll(paint: () => void): void {
  const outer = sideEl.scrollTop;
  const inner = Array.from(sideEl.querySelectorAll<HTMLElement>('.log, .god-shelf')).map(
    (el) => el.scrollTop,
  );

  paint();

  sideEl.scrollTop = outer;
  Array.from(sideEl.querySelectorAll<HTMLElement>('.log, .god-shelf')).forEach((el, i) => {
    el.scrollTop = inner[i] ?? 0;
  });
}

function render(): void {
  const view = playerView(state, me(), spectating());

  const selected = selectedId ? state.units.find((u) => u.id === selectedId) : undefined;
  const threat =
    selected && selected.owner === state.current && !selected.acted
      ? Array.from(threatTiles(state, selected))
      : [];

  renderBoard(boardEl, view, {
    selectedId,
    reach,
    targets,
    siegeTargets: siege,
    selectedCityId,
    placeable: computePlaceable(),
    threat,
    movePath: pendingMovePath ?? undefined,
    incomeHints: computeIncomeHints(selected),
  });
  // 路线只演一次：下一次重绘不该再播一遍
  pendingMovePath = null;

  // 强制模式的横幅。文字只在档位变了才写一次：每帧重写一遍是白干活，
  // 也会让读屏软件把同一句话反复念。
  if (forceMode && state.config.godMode !== true) {
    // 沙盒里点棋盘是"落子"，走的不是这条分支，横幅在那儿没有意义
    const text =
      forceMode === 'move'
        ? '强制移动：点可达格就走上去 · 再点按钮退出'
        : '强制攻击：点目标就开火（含身下那个）· 再点按钮退出';
    forceFlagEl.hidden = false;
    if (forceFlagEl.textContent !== text) forceFlagEl.textContent = text;
    if (forceFlagEl.dataset.mode !== forceMode) forceFlagEl.dataset.mode = forceMode;
  } else {
    forceFlagEl.hidden = true;
  }

  if (state.config.godMode === true) {
    // 上帝模式把侧栏整块让给兵种货架：这个模式里没人要看属性卡，
    // 兵是自己一手摆上去的，摆的时候就知道它是谁。
    renderGodShelf();
    renderGodBar();
  } else {
    // 离开沙盒（新对局 / 导入 / 切回普通局）：两份签名作废，
    // 下次再进上帝模式时不会拿着上一局的签名把重绘挡掉
    godSig = '';
    godShelfSig = '';
    keepSideScroll(() => renderPanel(sideEl, panelInput()));
    renderCommander();
  }

  // 换人了就"叮"一声：手机放在桌上等对手的人，靠这一声回神。
  // AI 之间互打不响（会变成每秒一声），观战也不响。
  if (
    lastTurnPlayer !== null &&
    lastTurnPlayer !== state.current &&
    !state.winner &&
    !isAiSide(state, state.current) &&
    !spectating()
  ) {
    playChime(chimeVolume);
  }
  lastTurnPlayer = state.current;

  updateTopbar(topbarEl, {
    fog: state.fog,
    blackout: state.config.expansionIds.includes('blackout'),
    turn: state.turn,
    season: state.config.expansionIds.includes('seasons') ? seasonLabel(state.turn) : null,
    current: state.current,
    currentName: state.players[state.current].name,
    aiCurrent: isAiSide(state, state.current),
    aiLevelName: aiLevelLabel(aiLevelOf(state)) + ' AI',
    aiAny: anyAiSide(state),
    paused: aiPaused,
    speedName: AI_SPEED_NAME[aiSpeed] ?? '快',
    roomCode: room?.code ?? null,
    waitingForPeer: !myTurn() && !state.winner,
    spectator: watching(),
    god: state.config.godMode === true,
  });
  syncTopbarScroll();
  fitBoard();
}

/**
 * 缩放档位。
 *
 * 32×32 的图上"适应屏幕"意味着每格只剩二十来像素，棋子上的字认得出、位置看不清。
 * 放大不是把画布拉伸（那样只是糊），而是**把棋盘元素本身变宽**：
 * 格子和棋子全是百分比定位，宽度一变，格子就真的变大了；
 * 多出来的部分由外层的滚动容器吃掉。
 */
const ZOOM_STEPS = [1, 1.5, 2, 3];
let boardZoom = 1;
/** 1× 时棋盘该有多大（像素）。放大只是在这个数上乘，不改它 */
let baseBoardSize = 0;

/**
 * 把棋盘压进容器。
 *
 * 为什么要用 JS 量而不是交给 CSS：
 *   · calc(100dvh - 108px) 把"顶栏多高"写死了，后来加参谋部栏就顶穿容器；
 *   · 容器查询（100cqh）在不支持的客户端上整条声明失效，棋盘退回 100% 宽，
 *     容器比它矮时就裁掉最后一两行——就是"只能看到 11 行"那个现象。
 * 量一次写像素，就不存在"支持不支持"的问题了。
 *
 * 量的是"容器宽"和"视口高减去实际工具栏高度"：
 * 容器高度在窄屏下是由内容撑出来的，直接量它自己会绕成环
 * （棋盘变高 → 容器变高 → 棋盘更高）。
 *
 * 宽度用 offsetWidth 而不是 clientWidth：放大之后容器会长出滚动条，
 * clientWidth 会跟着少掉一条滚动条的宽度，于是"放大→基准变小→格子变小"，
 * 每帧都在抖。offsetWidth 含滚动条，数字是稳的。
 */
function fitBoard(): void {
  const width = boardWrapEl.offsetWidth;
  if (width <= 0) return;

  const chrome = topbarEl.offsetHeight + (commanderEl.hidden ? 0 : commanderEl.offsetHeight);
  const box = boardWrapEl.parentElement;
  const cs = box ? window.getComputedStyle(box) : null;
  const padY = cs
    ? parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0')
    : 36;

  // 用 #app 的实际高度而不是 window.innerHeight：有的客户端里两者会差一个滚动条
  const viewportH = appEl.clientHeight || window.innerHeight;
  const availH = viewportH - chrome - padY;
  // 160 是地板：窗口被压到极窄时也别让棋盘缩成一个点
  baseBoardSize = Math.max(160, Math.round(Math.min(width, availH)));

  const zoomed = boardZoom > 1;
  const px = Math.round(baseBoardSize * boardZoom);
  boardEl.style.width = `${px}px`;
  boardEl.style.height = `${px}px`;
  boardEl.classList.toggle('zoomed', zoomed);
  boardScrollEl.classList.toggle('zoomed', zoomed);

  // 放大时把"看地图的窗口"钉在"适应屏幕"那个尺寸上：地图变大、窗口不变，
  // 于是多出来的部分可以滚（手机上是手指拖）。
  // 不这么做的话，窄屏单列布局里 board-wrap 是按内容撑高的，
  // 放大之后整块会跟着长大，被 .app 的 overflow:hidden 裁掉——
  // 表现就是"一放大就只能看见左上角，剩下的永远看不到"。
  if (zoomed) {
    boardScrollEl.style.width = `${baseBoardSize}px`;
    boardScrollEl.style.height = `${baseBoardSize}px`;
  } else {
    boardScrollEl.style.width = '';
    boardScrollEl.style.height = '';
  }

  const label = boardWrapEl.querySelector<HTMLElement>('[data-ref="zoom-fit"]');
  if (label) label.textContent = boardZoom > 1 ? `${boardZoom}×` : '适应';
}

/**
 * 换一档缩放。
 *
 * 放大之后把视口挪回中间：32×32 上放大的目的通常是"看中间那片战场"，
 * 停在左上角等于放大了一个空的角落。
 */
function setZoom(next: number): void {
  const steps = ZOOM_STEPS;
  const clamped = Math.min(steps[steps.length - 1]!, Math.max(1, next));
  if (clamped === boardZoom) return;
  boardZoom = clamped;
  // 先重绘再量：格子大小是从元素宽度推出来的，宽度变了必须重算一次
  render();
  if (boardZoom > 1) {
    boardScrollEl.scrollLeft = Math.max(0, (boardScrollEl.scrollWidth - boardScrollEl.clientWidth) / 2);
    boardScrollEl.scrollTop = Math.max(0, (boardScrollEl.scrollHeight - boardScrollEl.clientHeight) / 2);
  } else {
    boardScrollEl.scrollLeft = 0;
    boardScrollEl.scrollTop = 0;
  }
}

function zoomStep(dir: 1 | -1): void {
  const i = ZOOM_STEPS.indexOf(boardZoom);
  const at = i < 0 ? 0 : i;
  setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir))]!);
}

/**
 * 顶栏还有没有"藏起来的部分"，用两侧的阴影提示。
 *
 * 滚动条本身很细、移动端干脆不显示，所以必须有个额外信号告诉人"右边还有按钮"。
 */
function syncTopbarScroll(): void {
  const canLeft = topbarEl.scrollLeft > 2;
  const canRight = topbarEl.scrollWidth - topbarEl.scrollLeft - topbarEl.clientWidth > 2;
  topbarEl.classList.toggle('can-scroll-left', canLeft);
  topbarEl.classList.toggle('can-scroll-right', canRight);
}
/** 根据当前选中单位重算可达、可攻击、可攻城集合 */
function refreshSelection(): void {
  if (!selectedId) {
    reach = [];
    targets = [];
    siege = [];
    return;
  }
  const unit = state.units.find((u) => u.id === selectedId);
  if (!unit) {
    selectedId = null;
    reach = [];
    targets = [];
    siege = [];
    return;
  }
  // 观战：只画**当前行动方**这一边的范围。
  //
  // 按归属画不行——观战位的 me() 固定是 A，轮到 B 时整盘一片空白；
  // 两边都画也不行——两堆高亮叠在一起，看不出这一步到底谁有威胁。
  // 观战看的是"这一步它能打到哪"，那就只画这一步的主人。
  if (spectating()) {
    if (unit.owner !== state.current || unit.acted || state.winner) {
      reach = [];
      targets = [];
      siege = [];
      return;
    }
    reach = canMove(unit) ? Array.from(reachableTiles(state, unit).keys()) : [];
    targets = canAttack(unit) ? attackableTargets(state, unit).map((t) => t.id) : [];
    siege = canAttack(unit) ? siegeTargets(state, unit).map((c) => c.id) : [];
    return;
  }
  if (unit.owner !== me() || watching()) {
    reach = [];
    targets = [];
    siege = [];
    return;
  }
  reach = canMove(unit) ? Array.from(reachableTiles(state, unit).keys()) : [];
  targets = canAttack(unit) ? attackableTargets(state, unit).map((t) => t.id) : [];
  siege = canAttack(unit) ? siegeTargets(state, unit).map((c) => c.id) : [];
}

function clearSelection(): void {
  recruitQuery = '';
  // 扩展包筛选不清：它是"我这一局只想看哪几个包"，换一个单位不该把它重置掉
  forceMode = null;
  pickState = null;
  selectedId = null;
  selectedCityId = null;
  selectedCampId = null;
  selectedTile = null;
  buildPlan = null;
  spawnPlan = null;
  loadPlan = null;
  unloadPlan = null;
  reach = [];
  targets = [];
  siege = [];
}

/**
 * 经济单位的移动产出预览。
 *
 * 选中带收入的经济单位、且它还有可达格时，把每一格站上去之后的收入
 * 都算出来（农民按地形、牧民按地形、临水一律 +河运）。
 * 固定收入的单位也参与：河边那格会多 3 金，这正是要给人看的差别。
 * reach 本身已经带上了"是谁的回合、动没动过"的口径，这里只补一条
 * 收入判空——没收入的东西没必要在几十个格子上各印一个 +0。
 */
function computeIncomeHints(unit: Unit | undefined): Map<number, number> {
  const hints = new Map<number, number>();
  if (!unit || reach.length === 0) return hints;
  const def = utype(state, unit.type);
  if (!def.incomeByTerrain && !def.income) return hints;
  for (const i of reach) {
    const x = i % state.w;
    const y = Math.floor(i / state.w);
    hints.set(i, unitIncomeAt(state, unit, x, y));
  }
  return hints;
}

/** 建造者周围哪些空格可以盖东西（桥是唯一能盖在水上的） */
function computePlaceable(): number[] {
  // 上帝模式：只有"摆城"需要提前点亮格子（2×2 的角放哪儿是有讲究的，
  // 光靠点错再弹提示得试上十几次）。摆兵不点亮——整张图大半都能放，
  // 亮起来只是把棋盘糊成一片橙的。
  if (state.config.godMode === true) return godCitySpots();

  // 水军选下水点：把能下水的几格点亮，点哪格就从哪格出。
  // 放在最前面——它是个"已经上膛"的操作，别的选择都该让位。
  if (spawnPlan) return spawnPlan.cells;

  // 蛋落位也复用这一层橙格：轮到我了、手里还有一枚蛋，就把可选格点亮。
  // 它比"点错了再弹提示"友好得多——玩家一眼就知道能放哪儿。
  if (state.pendingEgg && state.pendingEgg.owner === state.current) {
    return eggSpots(state).map((p) => p.y * state.w + p.x);
  }

  // 下船选址复用同一层高亮（橙格 = 点这里）。两件事不会同时进行：
  // 一条船在等卸货时，不可能另有一个建造单位在选址。
  if (unloadPlan) {
    const ferry = state.units.find((u) => u.id === unloadPlan);
    if (!ferry) return [];
    const out: number[] = [];
    for (let y = 0; y < state.h; y++) {
      for (let x = 0; x < state.w; x++) {
        if (distance(ferry, { x, y }) !== 1) continue;
        const tile = state.tiles[y * state.w + x];
        if (!tile || !passable(tile.terrain)) continue;
        if (state.units.some((u) => u.x === x && u.y === y)) continue;
        const city = tile.cityId ? state.cities.find((c) => c.id === tile.cityId) : null;
        if (city && city.owner !== ferry.owner) continue;
        out.push(y * state.w + x);
      }
    }
    return out;
  }

  if (!buildPlan) return [];
  const builder = state.units.find((u) => u.id === buildPlan?.unitId);
  if (!builder) return [];
  const def = state.unitTypes[buildPlan.type];
  const overWater = !!def?.bridges;

  const out: number[] = [];
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      const tile = state.tiles[y * state.w + x];
      if (!tile) continue;
      if (state.units.some((u) => u.x === x && u.y === y)) continue;
      if (distance(builder, { x, y }) > CONFIG.buildRange) continue;

      const allowed = def?.buildOn;
      if (allowed) {
        if (!allowed.includes(tile.terrain)) continue;
      } else if (!passable(tile.terrain)) {
        continue;
      }

      if (overWater) {
        // 桥：至少要有一侧是陆地
        const landNext = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => {
          const nb = state.tiles[(y + dy) * state.w + (x + dx)];
          return !!nb && passable(nb.terrain);
        });
        if (!landNext) continue;
      } else if (tile.terrain === 'bridge') {
        continue;
      }

      // 军营要临水（靠水补给）：高亮只画真正能建的地方
      if (def?.requiresWater && !adjacentToWater(state, x, y)) continue;

      out.push(y * state.w + x);
    }
  }
  return out;
}

/**
 * 当前这一方"看得见"的状态。
 *
 * 点击判定也要走它：直接读 state 会点到视野外的敌方单位（本地还看不见，
 * 但控制台里能查到），既不安全也不符合"只渲染 playerView"的约定。
 */
function viewNow(): ReturnType<typeof playerView> {
  return playerView(state, me(), spectating());
}

function selectUnit(u: Unit): void {
  selectedCityId = null;
  selectedCampId = null;
  selectedTile = null;
  buildPlan = null;
  loadPlan = null;
  unloadPlan = null;
  selectedId = u.id;
  refreshSelection();
  render();
}

/**
 * 选中军营：直接进产兵面板。
 *
 * 军营是建筑，本来就没有移动/攻击可选，所以点它跟点城市是一类操作；
 * 只有自己（或同盟视角）的军营才这么处理，敌方的还是走普通单位面板看属性。
 */
function selectCamp(u: Unit): void {
  if (selectedCampId !== u.id) recruitQuery = '';
  selectedCityId = null;
  selectedTile = null;
  buildPlan = null;
  spawnPlan = null;
  selectedCampId = u.id;
  selectedId = u.id;
  refreshSelection();
  render();
}

function selectCity(cityId: string): void {
  // 换了城就把搜索词清掉：上一座城搜的「龙」，套到下一座城上只会显示「没有匹配」。
  // 同一座城里连着买不清——连买三个弓手不该每次重新打字。
  if (selectedCityId !== cityId) recruitQuery = '';
  selectedId = null;
  selectedCampId = null;
  selectedTile = null;
  buildPlan = null;
  spawnPlan = null;
  loadPlan = null;
  unloadPlan = null;
  reach = [];
  targets = [];
  siege = [];
  selectedCityId = cityId;
  render();
}

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 2200);
}

function dispatch(action: Action): boolean {
  // AI 正在走这一方：玩家的点击一律不生效，不然会出现两边同时改同一个状态
  if (aiBusy()) {
    toast('这一方正由 AI 行动');
    return false;
  }
  // 联机里轮到对方：能看棋盘，但不能替他走
  if (!myTurn()) {
    toast(watching() ? '观战位只能看，不能操作' : '等对方提交这一回合');
    return false;
  }

  const prevTurn = state.turn;
  const actor = state.current;
  planMovePath(state, action);
  const result = applyAction(state, action);
  if (!result.ok) {
    pendingMovePath = null;
    toast(result.reason);
    return false;
  }
  undoStack.push(state);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  state = result.state;
  noteStep(actor, action);
  if (action.type === 'END_TURN') noteTurnEnd();
  noteFinalFrame();
  saveMatch(state);

  if (action.type === 'END_TURN') {
    // 回合结束了，这个回合的走子就不许再撤——账已经结了
    undoStack = [];
    clearSelection();
    render();
    if (room) {
      // 联机里"结束回合"就等于提交：把整局推上去，然后等对面
      void pushTurn(room, prevTurn);
      return true;
    }
    if (!state.winner) {
      // 轮到 AI 就让它接着走（双 AI 时会一直走回人类或分出胜负）
      if (isAiSide(state, state.current)) {
        void runAiLoop();
      } else if (!anyAiSide(state)) {
        // 只有两边都是人，才需要"把设备交给对方"
        openHandoff();
      }
    }
    return true;
  }

  dirty = true;

  refreshSelection();
  render();
  return true;
}

/**
 * 撤回上一步。
 *
 * 能撤的范围：本回合、自己这一方、AI 没在走。
 *
 * 联机也能撤——只要**这一回合还没提交**。提交发生在「结束回合」那一下
 * （pushTurn），在那之前所有走子都只是本机草稿，撤掉不会让两边对不上。
 * 反过来说，一旦按过结束回合，undoStack 就直接清空了，这里也就无从撤起。
 */
function undoLast(): void {
  if (state.config.commanderMode) {
    toast('指挥官模式下走位归 AI，撤不了');
    return;
  }
  if (aiBusy()) {
    toast('AI 正在行动，等它走完');
    return;
  }
  if (!myTurn()) {
    toast('等对方提交这一回合');
    return;
  }
  const prev = undoStack.pop();
  if (!prev) {
    toast('没有可以撤回的操作');
    return;
  }
  state = prev;
  saveMatch(state);
  clearSelection();
  render();
}

/**
 * 这一格上压着哪些单位，按"最上面那个先"排。
 *
 * 排序必须和渲染层的绘制顺序一致（见 board.ts：建筑 → 地面 → 空中）：
 * 玩家眼睛看到谁在上面，第一次点就该选中谁，第二次点往下翻。
 */
function stackAt(x: number, y: number): Unit[] {
  const view = viewNow().state;
  const list = unitsAt(view, x, y).slice();
  const rank = (u: Unit) => {
    if (utype(view, u.type).category === 'building') return 2;
    return isAirborne(view, u) ? 0 : 1;
  };
  list.sort((a, b) => rank(a) - rank(b));
  return list;
}

/**
 * 点这一格到底选中谁：同格连点就是往下翻一层。
 *
 * preferTarget=true（强制攻击）时，优先挑这一格上"我能打的那个"——
 * 飞行单位停在敌人头顶时，玩家按 Shift 点的意思一定是打脚下那个，
 * 不是选中自己的兵。
 */
function pickUnitId(coords: { x: number; y: number } | null, preferTarget: boolean): string | null {
  if (!coords) {
    pickState = null;
    return null;
  }
  const list = stackAt(coords.x, coords.y);
  if (list.length === 0) {
    pickState = null;
    return null;
  }
  const key = coords.y * state.w + coords.x;
  const ids = list.map((u) => u.id);

  if (preferTarget) {
    const hit = list.find((u) => targets.includes(u.id));
    if (hit) {
      pickState = { key, ids, index: list.indexOf(hit) };
      return hit.id;
    }
  }

  if (!pickState || pickState.key !== key) {
    pickState = { key, ids, index: 0 };
    return ids[0]!;
  }
  // 抓成局部常量再进闭包：TS 不会把模块级 let 的收窄带进回调，
  // 直接写 pickState.ids[i] 会被判成"可能是 null"
  const cur = pickState;
  const same = cur.ids.length === ids.length && ids.every((id, i) => id === cur.ids[i]);
  if (!same) {
    pickState = { key, ids, index: 0 };
    return ids[0]!;
  }
  pickState.index = (pickState.index + 1) % ids.length;
  return ids[pickState.index]!;
}

/** 强制移动走不上这一格时，说清楚是为什么——静默无反应比报错更让人困惑 */
function moveRefusal(coords: { x: number; y: number }): string {
  const blockers = stackAt(coords.x, coords.y).filter((u) => u.id !== selectedId);
  if (blockers.length > 0) {
    const b = blockers[0]!;
    return `这一格被「${utype(state, b.type).name}」占着，走不上去`;
  }
  const mover = selectedId ? state.units.find((u) => u.id === selectedId) : undefined;
  if (mover && mover.x === coords.x && mover.y === coords.y) return '它已经站在这了';
  const tile = state.tiles[idx(state, coords.x, coords.y)];
  const onFoot = mover ? utype(state, mover.type).domain !== 'water' : true;
  // 地形拒绝是强制移动里最常见的一种。只回一句"不在移动范围内"，玩家会当成
  // 走位问题，于是挨个试旁边的格子——而它其实一步都进不去。
  if (tile?.terrain === 'water' && onFoot) {
    return '水面对陆军不通：要么从桥上过，要么换成水军';
  }
  if (tile?.terrain === 'mountain') return '高山进不去，得绕开';
  return '这一格不在移动范围内';
}

/**
 * 强制模式这一下能不能落到"手上这个兵"身上。
 *
 * 模式是持续的，所以每次点击都要重新确认主体还成立：轮到我、是自己的兵、
 * 手上没有别的计划（选址/上下船）。不成立就把这一下交回普通流程——
 * 比如对手正好提交了回合，模式不该继续拦着人看棋盘。
 */
function forceSource(): string | null {
  if (!selectedId) return null;
  if (watching() || !myTurn() || state.config.commanderMode === true) return null;
  if (buildPlan || loadPlan || unloadPlan || spawnPlan) return null;
  const u = viewNow().state.units.find((x) => x.id === selectedId);
  if (!u || u.owner !== me()) return null;
  return u.id;
}

/**
 * 只读查看：点这一格能看什么就看什么（单位 → 城市 → 地形），一个动词都不给。
 *
 * 用于"轮不到我"的三种场合：对方在联机里行动、AI 正在思考、自己这一手已经提交。
 * 以前这些时候点棋盘一律弹一句提示就完事，于是一盘棋里有一半时间点不动——
 * 而那段等待恰恰是最想点开对面那个兵、看看它射程几格、还剩多少血的时候。
 * 动词不用在这里挡：面板拿到的 myTurn 是假，产兵/升级/技能本来就是灰的。
 */
function inspectAt(coords: { x: number; y: number } | null): void {
  if (!coords) return;

  const id = pickUnitId(coords, false);
  const u = id ? viewNow().state.units.find((x) => x.id === id) : undefined;
  if (u) {
    // 自己的军营点开是产兵面板，只读的时候也一样：
    // "这座营还能出什么"是它身上最值得看的一条
    if (u.owner === me() && utype(state, u.type).barracks) selectCamp(u);
    else selectUnit(u);
    return;
  }

  const city = cityAt(state, coords.x, coords.y);
  if (city) {
    selectCity(city.id);
    return;
  }

  clearSelection();
  selectedTile = coords;
  render();
}

function onBoardClick(e: Event): void {
  // 上帝模式的点击语义完全不同：这里点棋盘是"落子"，不是"走子"。
  // 走子那套判断（轮到我吗、这格可达吗、能不能开火）在沙盒里一条都不成立，
  // 所以整块交出去，不在这里塞一堆 if。
  if (state.config.godMode === true) {
    onGodClick(e);
    return;
  }
  if (handoffOpen || state.winner) return;

  const coords = coordsFromEvent(e);

  // AI 正在行动：不许下子，但"看"必须留着。
  //
  // 对手思考、走子、开火，这一段能持续十几秒；以前整块 return，
  // 玩家在这段时间里点什么都没反应，只能干等。
  if (aiBusy()) {
    inspectAt(coords);
    return;
  }

  // 强制键分两种：按住 Alt/Shift 是一次性修饰键；按钮扣住的模式（forceMode）持续。
  //
  // 这里**不能**再清 forceMode——旧语义"上膛一次、点一下就用掉"正是
  // "强制移动被别的交互打断"的根源（见 forceMode 的注释）。
  const mouse = e instanceof MouseEvent ? e : null;
  const latched = forceMode;
  const wantMove = latched === 'move' || mouse?.altKey === true;
  const wantAttack = latched === 'attack' || mouse?.shiftKey === true;

  // 0) 正在选下水点：点亮的格子就是答案，点别处就当取消。
  // 排在最前面，因为它是一个"已经上膛"的操作——这时候点棋盘的意思
  // 一定是"从这儿下水"，不该被下面任何一条选择逻辑抢走。
  if (spawnPlan) {
    const spot = coords ? idx(state, coords.x, coords.y) : -1;
    if (coords && spot >= 0 && spawnPlan.cells.includes(spot)) {
      const { cityId, campId, type } = spawnPlan;
      spawnPlan = null;
      dispatch({ type: 'RECRUIT', cityId, unitId: campId, unitType: type, x: coords.x, y: coords.y });
      render();
      return;
    }
    spawnPlan = null;
    render();
  }

  // 0.4) 模式扣住了：这一下只按那一个动词解释，绝不落到"选中"上去。
  //
  // 这是"强制移动优先级不足"的正面修法。以前强制是一次性的，第二下点击就
  // 回到普通语义，于是点到别的单位就把手上的兵换掉。现在只要模式还在，
  // 任何一格都只有两种结局：照做，或者被明确拒绝——选择与指令一律不做。
  const forcedFrom = latched && coords ? forceSource() : null;
  if (latched && coords && forcedFrom) {
    const cell = idx(state, coords.x, coords.y);
    if (latched === 'move') {
      if (reach.includes(cell)) {
        // 模式不清：下一格还按"走上去"解释，连点几下都是同一个意思
        dispatch({ type: 'MOVE', unitId: forcedFrom, x: coords.x, y: coords.y });
        return;
      }
      toast(moveRefusal(coords));
      return;
    }
    // 强制攻击：先在这一格里找我打得到的那个——包括压在我身下的那个。
    // 飞行单位停在敌人头顶时，"打它"和"飞到它那格"落在同一格上，
    // 所以这里的顺序是先目标、后走位。
    const hit = stackAt(coords.x, coords.y).find((u) => targets.includes(u.id));
    if (hit) {
      dispatch({ type: 'ATTACK', unitId: forcedFrom, targetId: hit.id });
      return;
    }
    toast('这一格没有能打的目标（再点一次按钮可以退出强制模式）');
    return;
  }

  // 0.5) 强制移动（按住 Alt 的那条路）：无视这一格上压着谁，直接按"走上去"解释。
  //
  // 和上面 0.4 是同一个动词的两条入口：0.4 是按钮扣住的模式，这一条是一次性
  // 的修饰键，也是模式因为"轮不到我 / 手上在选址"而不成立时的后备。
  // 两处都必须"成或明确拒绝，绝不落到选中"，否则压在格子上那枚棋子又把话抢走了。
  //
  // 桥不用修饰键了：桥面可达时直接点就算"走上去"（见 1.9），因为桥没有
  // 自己的操作面板，选中它从来都不是玩家想要的。
  if (
    wantMove &&
    coords &&
    !watching() &&
    myTurn() &&
    !state.config.commanderMode &&
    selectedId &&
    !buildPlan &&
    !loadPlan &&
    !unloadPlan
  ) {
    const cell = idx(state, coords.x, coords.y);
    if (reach.includes(cell)) {
      dispatch({ type: 'MOVE', unitId: selectedId, x: coords.x, y: coords.y });
      return;
    }
    toast(moveRefusal(coords));
    return;
  }

  const clickedUnitId = pickUnitId(coords, wantAttack);

  // 只读查看：点敌方单位出属性卡——不看轮到谁，也不看是不是指挥官模式。
  //
  // 扩展包把兵种从 49 个堆到 118 个之后，"对面这个是什么、射程几格、护甲多少"
  // 变成了临场刚需（以前整局就那几种兵，看图标就知道）。而"看"不是"操作"，
  // 没理由要求轮到自己才能看。面板那边对非己方单位一律不给按钮。
  //
  // 但这一段排在攻击判断前面，所以必须先算清"这一下到底是不是要开火"：
  // 早先无条件拦下所有敌方单位，结果选中己方部队之后点敌人只弹属性卡，
  // 攻击这个动作在界面上等于消失了。能打到的目标要让路给下面第 1 步。
  const attackingNow =
    myTurn() &&
    !watching() &&
    !state.config.commanderMode &&
    Boolean(clickedUnitId && selectedId && targets.includes(clickedUnitId));
  if (clickedUnitId && !attackingNow) {
    const preview = viewNow().state.units.find((u) => u.id === clickedUnitId);
    if (preview && (watching() || preview.owner !== me())) {
      selectUnit(preview);
      return;
    }
  }

  // 观战位：两边都不归我，所以"点单位看属性"要对双方都成立；
  // 城市和地形照样能点开看，但一律不给按钮。
  if (watching()) {
    if (coords) {
      const city = cityAt(state, coords.x, coords.y);
      if (city) {
        selectCity(city.id);
        return;
      }
      clearSelection();
      selectedTile = coords;
      render();
    }
    return;
  }

  // 指挥官模式：这一方的走位与开火归 AI —— 但"看"是人该有的权利。
  //
  // 这里原来是一句光秃秃的 return，结果点自己的部队什么也不弹：参谋部的
  // 下拉框里写着"长弓手 · 40 金"，想知道它射程几格却只能去翻规则书。
  // 所以保留三段只读入口（单位 / 城市 / 空地），动词一个都不给——
  // 面板那边 commander 一开，`mine` 全线失效，卡片上不会长出能按的东西。
  if (state.config.commanderMode) {
    inspectAt(coords);
    return;
  }
  // 对方行动阶段（联机等对手提交）：同样只能看。
  //
  // 以前这里只弹一句「等对方提交这一回合」，连"我这个兵还剩多少血"都查不到。
  // 现在走同一条只读路径；只有"手上捏着单位去点空地"这一种情况才提原因——
  // 那说明他其实是想动兵，光给一格地形对他没帮助。
  if (!myTurn()) {
    const hitsUnit = Boolean(pickUnitId(coords, false));
    const hitsCity = coords ? Boolean(cityAt(state, coords.x, coords.y)) : false;
    if (!hitsUnit && !hitsCity && selectedId) {
      clearSelection();
      toast('等对方提交这一回合');
      return;
    }
    inspectAt(coords);
    return;
  }

  // 正在选址：点哪儿就让建造者在那儿开工
  if (buildPlan) {
    if (!coords) return;
    const ok = dispatch({
      type: 'BUILD',
      unitId: buildPlan.unitId,
      unitType: buildPlan.type,
      x: coords.x,
      y: coords.y,
    });
    if (ok) {
      buildPlan = null;
      render();
    }
    return;
  }

  // 0) 同一格上叠着两个单位（飞行单位压在地面单位头上）时，
  //    点这一格点到的永远是上面那个 DOM 元素，下面那个就再也选不中、更打不着。
  //    所以先按格子找"这一格里有没有我能打的目标"，有就直接开火——
  //    规则层本来就允许距离 0 的对射（空中打地面），只是界面点不到。
  if (coords && selectedId && targets.length > 0) {
    const stacked = state.units.find(
      (u) => u.x === coords.x && u.y === coords.y && targets.includes(u.id),
    );
    if (stacked) {
      dispatch({ type: 'ATTACK', unitId: selectedId, targetId: stacked.id });
      return;
    }
  }

  // 1) 点到了攻击目标
  if (clickedUnitId && selectedId && targets.includes(clickedUnitId)) {
    dispatch({ type: 'ATTACK', unitId: selectedId, targetId: clickedUnitId });
    return;
  }

  // 1.5) 装卸模式：这两件事优先于"选中单位"
  if (loadPlan) {
    const ferry = state.units.find((u) => u.id === loadPlan);
    const cargo = clickedUnitId ? state.units.find((u) => u.id === clickedUnitId) : null;
    if (ferry && cargo && cargo.owner === ferry.owner && distance(ferry, cargo) === 1) {
      dispatch({ type: 'LOAD', unitId: ferry.id, cargoId: cargo.id });
      loadPlan = null;
      return;
    }
    if (ferry) {
      toast('点一个贴着船的己方陆军');
      return;
    }
    loadPlan = null;
  }

  if (unloadPlan) {
    const ferry = state.units.find((u) => u.id === unloadPlan);
    if (ferry?.cargo?.length && coords && distance(ferry, coords) === 1) {
      dispatch({
        type: 'UNLOAD',
        unitId: ferry.id,
        cargoId: ferry.cargo[0]!.id,
        x: coords.x,
        y: coords.y,
      });
      unloadPlan = null;
      return;
    }
    if (ferry) {
      toast('点船边一格空地');
      return;
    }
    unloadPlan = null;
  }

  // 1.9) 点在桥面上：桥是"能站的地形"，不是一个等着被选中的物件。
  //
  // 桥在数据上是一枚建筑棋子（bridges 标记 + 把水格改成桥面），所以直接点
  // 永远是"选中这座桥"——桥修好了却只能穿过去，守桥、堵口、在桥中间换气
  // 全都点不出来，表现就是"点了没反应"。这一格既然在可达范围里，就让
  // "我要走上去"赢过"我要选它"：桥没有自己的操作面板（塔和军营才有），
  // 选中它本来也做不了任何事。真要拆桥走的是上面那条攻击分支——
  // 敌桥进了射程时，点它就是开火，轮不到这里。
  const onBridge =
    coords && selectedId && reach.includes(idx(state, coords.x, coords.y))
      ? stackAt(coords.x, coords.y).find((u) => utype(state, u.type).bridges)
      : undefined;
  if (onBridge && coords && selectedId) {
    dispatch({ type: 'MOVE', unitId: selectedId, x: coords.x, y: coords.y });
    return;
  }

  // 2) 点到了某个单位
  if (clickedUnitId) {
    const u = state.units.find((x) => x.id === clickedUnitId);
    if (u) {
      // 自己的军营：点开就是产兵面板（它不能动也不能打，没什么别的可看）
      if (u.owner === me() && utype(state, u.type).barracks) selectCamp(u);
      else selectUnit(u);
      return;
    }
  }

  if (!coords) return;
  // 手里有蛋：这一下必须用来落位。蛋是"死了才出现"的临时状态，
  // 一直挂着不处理会把整个回合卡住，所以优先于移动/攻击。
  if (state.pendingEgg && state.pendingEgg.owner === state.current) {
    const egg = state.pendingEgg;
    if (eggSpots(state).some((p) => p.x === coords.x && p.y === coords.y)) {
      dispatch({ type: 'PLACE_EGG', x: coords.x, y: coords.y });
    } else {
      toast(`蛋只能放在原地的 ${egg.radius} 格内（橙格）`);
    }
    return;
  }

  const cell = idx(state, coords.x, coords.y);
  const city = cityAt(state, coords.x, coords.y);

  // 3) 城市格：攻城优先（单位不可能站在敌城格上，所以和移动不冲突）
  if (city && selectedId && siege.includes(city.id)) {
    dispatch({ type: 'SIEGE', unitId: selectedId, cityId: city.id });
    return;
  }

  // 4) 可达格 → 移动（自己的城市格也算普通可走格）
  if (selectedId && reach.includes(cell)) {
    dispatch({ type: 'MOVE', unitId: selectedId, x: coords.x, y: coords.y });
    return;
  }

  // 5) 点城市格 → 打开城市面板（自己的能产兵，敌方的看耐久）
  if (city) {
    selectCity(city.id);
    return;
  }

  // 6) 点空地 → 看看这块地是什么
  clearSelection();
  selectedTile = coords;
  render();
}

/** 结算卡上要显示的和要发出去的必须是同一份：都从当前 state 现算 */
function finishedReport() {
  return buildMatchReport(state, new Date(), recorder);
}

async function sendMatchReport(): Promise<void> {
  if (!state.winner || reportSend.status === 'sending') return;
  if (!reportOptIn) {
    toast('先勾上「允许上传对局数据」');
    return;
  }
  reportSend = { status: 'sending' };
  render();

  const sent = finishedReport();
  const r = await uploadReport(sent);
  if (r.ok) markReportSent(reportSignature(sent));
  reportSend = r.ok
    ? { status: 'done', note: r.note }
    : { status: 'failed', note: r.reason, howTo: r.howTo };
  render();
  toast(r.ok ? '这一局的数据已上传，谢谢' : '没传上去，报告还在，可以复制或下载');
}

/**
 * 复制到剪贴板。
 *
 * 有些环境没有 clipboard API（http 页面、部分旧浏览器），这时退成下载文件，
 * 而不是留一个点了没反应的按钮。
 */
async function copyMatchReport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(reportJson(finishedReport()));
    reportSend = { ...reportSend, note: '报告已复制到剪贴板，粘到哪都行' };
    render();
    toast('报告已复制');
  } catch {
    downloadMatchReport();
    toast('这个环境不让写剪贴板，改成下载文件');
  }
}

function downloadMatchReport(): void {
  const rep = finishedReport();
  const blob = new Blob([reportJson(rep)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = reportFileName(rep);
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${a.download}`);
}

function handleAction(act: string, el: HTMLElement): void {
  switch (act) {
    case 'force-move':
    case 'force-attack': {
      // 点一下进入、再点同一下退出；点另一个就直接切过去。
      // 以前这两个按钮只有壳子，data-act 没有对应的分支——点下去什么都不会发生，
      // 等于把"强制"这件事彻底锁在 Alt/Shift 后面（触屏用户完全没有入口）。
      const want: 'move' | 'attack' = act === 'force-move' ? 'move' : 'attack';
      forceMode = forceMode === want ? null : want;
      render();
      if (forceMode === 'move') {
        toast('强制移动：点可达格就走上去，再点一次按钮退出');
      } else if (forceMode === 'attack') {
        toast('强制攻击：点目标就开火，再点一次按钮退出');
      } else {
        toast('已退出强制模式');
      }
      return;
    }

    case 'end-turn':
      dispatch({ type: 'END_TURN' });
      return;

    case 'zoom-in':
      zoomStep(1);
      return;

    case 'zoom-out':
      zoomStep(-1);
      return;

    case 'zoom-fit':
      setZoom(1);
      return;

    case 'undo':
      undoLast();
      return;

    case 'chime':
      chimeVolume = nextChimeVolume(chimeVolume);
      saveChimeVolume(chimeVolume);
      // 点一下顺手试听当前档位（音量 0 时 playChime 自己会跳过）
      playChime(chimeVolume);
      render();
      return;

    case 'surrender': {
      // 认输是不可逆的，必须问一句
      if (!window.confirm('确认认输？这一局会直接判负，且不能撤回。')) return;
      dispatch({ type: 'SURRENDER' });
      return;
    }

    case 'disband': {
      if (!selectedId) return;
      const u = state.units.find((x) => x.id === selectedId);
      if (!u) return;
      const def = utype(state, u.type);
      const refund = disbandRefundOf(state, u);
      const hint =
        refund > 0
          ? `回收约 ${refund} 金。`
          : '这支部队已经残破，遣散不回收金币。';
      if (!window.confirm(`确认拆除「${def.name}」？${hint}`)) return;
      if (dispatch({ type: 'DISBAND', unitId: selectedId })) {
        selectedId = null;
        render();
      }
      return;
    }

    case 'hero-skill': {
      const unitId = el.dataset.id;
      const skillId = el.dataset.skill;
      if (!unitId || !skillId) return;
      dispatch({ type: 'HERO_SKILL', unitId, skillId });
      render();
      return;
    }

    case 'open-camp': {
      const id = el.dataset.id;
      if (!id) return;
      const camp = state.units.find((u) => u.id === id);
      if (!camp) return;
      selectCamp(camp);
      return;
    }

    case 'recruit': {
      const type = el.dataset.type;
      if (!type) return;
      const def = state.unitTypes[type];
      const cityId = selectedCityId ?? undefined;
      const campId = selectedCampId ?? undefined;

      // 水军：能下水的位置不止一格时，先让玩家点一格。
      //
      // 临水的城常常挨着好几片水，以前永远从"列表里的第一格"下水——
      // 想让它从另一侧的河道绕过去，唯一的办法是把那格水填了再挖开。
      if (def?.domain === 'water') {
        const cells = recruitSpawnCells(state, cityId, campId, type);
        if (cells.length > 1) {
          spawnPlan = { cityId, campId, type, cells: cells.map((c) => c.y * state.w + c.x) };
          toast(`${def.name}：点一格亮起来的水面下水（再点一次别的兵种就取消）`);
          render();
          return;
        }
      }

      // 军营和城市同一类操作，只是 action 里填的字段不同
      if (campId) {
        dispatch({ type: 'RECRUIT', unitId: campId, unitType: type });
        render();
        return;
      }
      if (!cityId) return;
      dispatch({ type: 'RECRUIT', cityId, unitType: type });
      render();
      return;
    }

    case 'build': {
      const type = el.dataset.type;
      if (!type || !selectedId) return;
      // 再点一次同一个建筑等于取消
      if (buildPlan && buildPlan.type === type) {
        buildPlan = null;
      } else {
        buildPlan = { unitId: selectedId, type };
        toast('点击高亮的空地开工');
      }
      render();
      return;
    }

    case 'load': {
      if (!selectedId) return;
      const ferry = state.units.find((u) => u.id === selectedId);
      if (!ferry || !state.unitTypes[ferry.type]?.transport) return;
      loadPlan = loadPlan ? null : ferry.id;
      unloadPlan = null;
      if (loadPlan) toast('点一个贴着船的己方陆军，让它上船');
      render();
      return;
    }

    case 'unload': {
      if (!selectedId) return;
      const ferry = state.units.find((u) => u.id === selectedId);
      if (!ferry?.cargo || ferry.cargo.length === 0) return;
      unloadPlan = unloadPlan ? null : ferry.id;
      loadPlan = null;
      if (unloadPlan) toast('点船边一格空地，让他们下船');
      render();
      return;
    }

    case 'upgrade': {
      if (!selectedCityId) return;
      dispatch({ type: 'UPGRADE', cityId: selectedCityId });
      render();
      return;
    }

    case 'toggle-fog': {
      // 上帝模式固定全图：
      //   1. 沙盒里藏信息没有意义，盘上的兵都是自己摆的；
      //   2. 更要紧的是 AI——它的寻路方向来自"敌城 + 视野内敌军"，
      //      沙盒里常常一座城都没有，雾一开两边就互相看不见，谁都不动。
      if (godMode()) {
        toast('上帝模式固定全图：关雾不只是给你看，AI 也要看得见才打得起来');
        return;
      }
      // 「浓雾蔽野」把"地图不可见"当成规则本身，这里必须拦住：
      // 能一键关掉的话，这个扩展就只是个大号的显示选项
      if (state.config.expansionIds.includes('blackout')) {
        toast('「浓雾蔽野」下迷雾锁定开启，不能关闭');
        return;
      }
      state.fog = !state.fog;
      if (state.fog) refreshMemory(state);
      saveMatch(state);
      render();
      toast(state.fog ? '战争迷雾已开启' : '战争迷雾已关闭');
      return;
    }

    case 'toggle-ai': {
      if (godMode()) {
        // 顶栏那个开关是"托管一方"，而沙盒里两边本来就归 AI 打——
        // 用它会把某一方永久交给 AI，回合会自动往前跑，摆兵就摆不安稳了
        toast('沙盒用「交给 AI · 一回合」或「接管 · 打到全灭」');
        return;
      }
      if (room) {
        toast(
          watching()
            ? '观战位不能替任何一方开 AI'
            : '联机房间里两边各走各的，AI 托管用不了',
        );
        return;
      }
      const p = state.current;
      const nowAi = !isAiSide(state, p);
      // 两边都写一遍，避免"收回 A 的托管"时 B 的托管状态被顺手抹掉
      const next = { A: isAiSide(state, 'A'), B: isAiSide(state, 'B') };
      next[p] = nowAi;
      state.aiControl = next;
      // 收回操作权要立刻掐掉正在跑的循环，否则它会把这一回合走完
      aiToken += 1;
      aiPaused = false;
      clearSelection();
      saveMatch(state);
      render();
      const lv = aiLevelLabel(aiLevelOf(state));
      toast(
        nowAi
          ? `${state.players[p].name}交给 ${lv} AI 托管`
          : `${state.players[p].name}改由你操作`,
      );
      if (nowAi) void runAiLoop();
      return;
    }

    case 'ai-pause': {
      aiPaused = !aiPaused;
      if (!aiPaused) {
        render();
        void runAiLoop();
      } else {
        aiToken += 1; // 让正在跑的循环停在这一步
        render();
        toast('AI 已暂停');
      }
      return;
    }

    case 'ai-speed': {
      aiSpeed = (aiSpeed + 1) % AI_SPEED_MS.length;
      render();
      toast(`AI 速度：${AI_SPEED_NAME[aiSpeed]}`);
      return;
    }

    case 'manual': {
      // 只有核心规则书相关时直接打开，别为形式多问一次；
      // 开了扩展才可能出现"看哪本"这个选择。
      const books = manualBooks(state.config.expansionIds);
      if (books.length === 1) {
        window.open(`./${books[0]!.file}`, '_blank', 'noopener');
        return;
      }
      openManualChooser(books);
      return;
    }

    case 'unit-editor': {
      openUnitEditor(() => render());
      return;
    }

    case 'online': {
      openOnlinePanel({
        currentState: () => state,
        room: () => room,
        enter: (seat, snapshot) => applyRoom(seat, snapshot),
        watch: (code, snapshot) => watchRoom(code, snapshot),
        leave: () => leaveRoom(),
      });
      return;
    }

    case 'export': {
      const text = exportMatch(state);
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast('对局已复制到剪贴板，可以直接发给对方'))
        .catch(() => window.prompt('复制下面的内容发给对方：', text));
      return;
    }

    case 'import': {
      const text = window.prompt('粘贴对方发来的对局内容：');
      if (!text) return;
      const imported = importMatch(text);
      if (!imported) {
        toast('这段内容不是有效的对局存档，或来自旧版本');
        return;
      }

      // 存档里只有扩展 id，本机没注册的规则会静默失效——必须先告诉用户，
      // 否则两边算出来的结果会不一样，谁都不知道为什么。
      const missing = imported.config.expansionIds.filter((id) => !expansionById(id));
      if (missing.length > 0) {
        toast(`注意：这局用了本机没有的规则（${missing.join('、')}），它们不会生效`);
      }

      state = imported;
      detachRoom(); // 换了一局，房间就对不上了
      boardZoom = 1; // 换局可能换尺寸，缩放档位不能跟着上一局走
      clearSelection();
      // 导入的这局要不要记摘要，看它自己的配置；记录器必须跟着换，
      // 否则会把上一局的摘要记到这一局头上
      resetRecorder();
      saveMatch(state);
      render();
      kickAiIfNeeded();
      return;
    }

    case 'new-game': {
      // 不先 confirm：打开面板本身就说明了意图，点"取消"等于没放弃。
      // 只有点了"开始对局"才会覆盖当前存档。
      void openSetupPanel(state.config, randomSeed()).then((result) => {
        if (!result) return;
        state = createMatch(result.config, result.seed, loadCustomUnits());
        detachRoom();
        boardZoom = 1;
        clearSelection();
        resetRecorder();
        // 开局时勾了"结束后上传详细数据"，等于对**这一局**点了头：
        // 结算卡上的许可框跟着勾上，但那一下「匿名上传」仍然要玩家自己点。
        if (result.config.recordDetail === true) saveReportOptIn(true);
        saveMatch(state);
        render();
        toast('新对局开始');
        kickAiIfNeeded();
      });
      return;
    }

    case 'handoff-start': {
      closeHandoff();
      render();
      return;
    }

    // ---------- 上帝模式 ----------

    case 'god-side': {
      godSide = el.dataset.side === 'B' ? 'B' : 'A';
      render();
      return;
    }

    case 'god-brush': {
      const b = el.dataset.brush;
      godBrush =
        b === 'city' ? { kind: 'city' } : b === 'erase' ? { kind: 'erase' } : { kind: 'none' };
      render();
      return;
    }

    // 按扩展包筛产兵列表：再点一次当前那一档＝回到全部
    case 'report-opt': {
      // 勾选框的 checked 在这时候已经翻好了，照它存就行
      reportOptIn = el instanceof HTMLInputElement ? el.checked : !reportOptIn;
      try {
        localStorage.setItem(REPORT_OPT_KEY, reportOptIn ? '1' : '0');
      } catch {
        // 隐私模式下写不进去，本次会话内仍然生效
      }
      render();
      return;
    }

    case 'report-upload':
      void sendMatchReport();
      return;

    case 'report-copy':
      void copyMatchReport();
      return;

    case 'report-download':
      downloadMatchReport();
      return;

    case 'recruit-pack': {
      const p = el.dataset.pack ?? '';
      recruitPack = recruitPack === p ? '' : p;
      render();
      return;
    }

    // 地形笔刷：再点一次同一种地形＝放下笔刷，和兵种货架一个手感
    case 'god-terrain': {
      const t = el.dataset.terrain as Terrain | undefined;
      if (!t) return;
      godBrush =
        godBrush.kind === 'terrain' && godBrush.terrain === t
          ? { kind: 'none' }
          : { kind: 'terrain', terrain: t };
      render();
      return;
    }

    // 货架按扩展包切：再点一次当前那一档＝回到全部
    case 'god-pack': {
      const p = el.dataset.pack ?? '';
      godPack = godPack === p ? '' : p;
      render();
      return;
    }

    case 'god-pick': {
      const type = el.dataset.unit ?? '';
      if (!type) return;
      // 再点一次同一个兵种＝放下笔刷。否则想"查看一下"还得先跑去点工具栏
      godBrush =
        godBrush.kind === 'unit' && godBrush.type === type
          ? { kind: 'none' }
          : { kind: 'unit', type };
      render();
      return;
    }

    case 'god-city-era': {
      const n = Number(el.dataset.era ?? 1);
      godCityEra = Math.max(1, Math.min(5, Number.isFinite(n) ? Math.round(n) : 1));
      render();
      return;
    }

    case 'god-clear': {
      godApply(clearUnits(state, el.dataset.side === 'B' ? 'B' : 'A'));
      return;
    }

    case 'god-speed': {
      const n = Number(el.dataset.speed ?? 0);
      godSpeed = Math.max(0, Math.min(AI_SPEED_MS.length - 1, Number.isFinite(n) ? n : 0));
      // 跑到一半也能改：runGodFight 每一回合都重新读一次档位，
      // 点完两三步之内就慢下来。这里不改 aiToken，不打断正在跑的那一回合。
      render();
      return;
    }

    case 'god-run-round': {
      void runGodFight('round');
      return;
    }

    case 'god-run-dead': {
      void runGodFight('dead');
      return;
    }

    case 'god-stop': {
      // 令牌一换，正在跑的 AI 循环下一步就自己退出（和参谋部中断同一个手法）
      aiToken += 1;
      godRunning = false;
      godResult = '已停止';
      saveMatch(state);
      render();
      return;
    }
  }
}

// ---------- AI 回合 ----------

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * 一直走到"轮到人"或者分出胜负为止。
 *
 * 双 AI 观战时 A 走完接 B、B 走完接 A，所以必须是循环而不是"走一方就收工"。
 * 每一轮都检查令牌：玩家点了"收回操作权"，旧循环必须在下一步之前认出自己已经作废。
 */
async function runAiLoop(): Promise<void> {
  const token = ++aiToken;
  clearSelection();

  while (token === aiToken && !state.winner && !aiPaused && isAiSide(state, state.current)) {
    await runAiTurn(token);
  }

  if (token !== aiToken) return; // 被新的调用接管了，交给它渲染
  render();
  if (state.winner) return;

  if (!isAiSide(state, state.current) && !aiPaused) {
    if (!anyAiSide(state)) {
      openHandoff();
    } else {
      toast(`轮到${state.players[state.current].name}`);
    }
  }
}

/**
 * 让 AI 把当前这一方走完，然后结束回合。
 *
 * 每一步之间停一下，是为了让玩家看得见它在干什么——
 * 瞬间跳完会让整局变成"我做了什么？对面怎么就满编了？"。
 *
 * `stopWhen` 是"这一仗已经打完了"的外部判据（只有沙盒用得上）：
 * 它每步都问一次，成立就立刻收手并交还回合。以前只在**回合之间**检查，
 * 于是一方在自己回合中途把对面最后一个兵清掉之后，剩下的部队还会继续
 * 原地折腾几十步——沙盒里看到的正是"没有敌人了，它还在动"。
 */
async function runAiTurn(
  token: number,
  overrides?: Partial<AiBudget>,
  delayOverride?: number,
  stopWhen?: () => boolean,
): Promise<void> {
  const player = state.current;
  const budget: AiBudget = {
    ...DEFAULT_BUDGET,
    // 指挥官模式下**每一方**都只有"一回合一个兵"的产能，AI 也不例外。
    // 否则双 AI 观战跑出来的还是普通对局，测不到限制本身。
    ...(state.config.commanderMode ? { maxRecruit: 1 } : {}),
    ...overrides,
  };
  const delay = delayOverride ?? AI_SPEED_MS[aiSpeed] ?? 70;
  const alive = () =>
    token === aiToken && !aiPaused && !state.winner && state.current === player;

  for (let step = 0; step < AI_MAX_STEPS; step++) {
    if (!alive()) return;
    // 打完了就别再摆弄部队：只收手，不 return——这一回合还得正常交割，
    // 否则 state.current 会停在半路，沙盒的"轮到谁"和回合数都对不上。
    if (stopWhen?.()) break;
    const action = aiNextAction(state, budget);
    if (!action) break;

    planMovePath(state, action);
    const walked = pendingMovePath?.values().next().value?.length ?? 0;
    const actor = state.current;
    const result = applyAction(state, action);
    if (!result.ok) break;

    state = result.state;
    noteStep(actor, action);
    noteFinalFrame();
    if (action.type === 'RECRUIT') budget.recruited += 1;
    if (action.type === 'UPGRADE') budget.upgraded += 1;

    // 逐帧重绘是为了让人看清；极快档就不必每步都画，每几步刷一次够了
    if (delay > 0 || step % 6 === 0) {
      saveMatch(state);
      render();
      // 走了两格以上就把这条路线"播完"再走下一步：
      // 否则动画刚起头就被下一个动作的重绘打断，观众只看到棋子闪了一下。
      if (delay > 0 && walked > 2) {
        await sleep(Math.min(560, 70 * (walked - 1)));
        if (!alive()) return;
      }
    }

    // 关键：即使 0ms 也要 await。同步跑完 50 步会把主线程占死，
    // 那段时间里按钮点不动、暂停按不下去——"AI 一快，界面就死了"。
    await sleep(delay);
  }

  if (!alive()) return;
  const end = applyAction(state, { type: 'END_TURN' });
  if (end.ok) state = end.state;
  if (end.ok) noteTurnEnd();
  saveMatch(state);
  render();
  await sleep(delay);
}

/** 新开一局 / 导入存档之后，如果当前方是 AI 就让它自己跑起来 */
function kickAiIfNeeded(): void {
  aiPaused = false;
  if (isAiSide(state, state.current) && !state.winner) void runAiLoop();
}

// ---------- 指挥官模式 ----------

/** 面板上一次重建时对应的局面签名，用来避免无谓重建（重建会把下拉框抽走） */
let commanderSig = '';
/** 批量执行中：面板换成进度条，按钮禁用 */
let commanderRunning = false;
/** 批量执行到第几个回合（1..5），0 表示没在跑 */
let commanderRound = 0;
/** 窄屏下「参谋部」是折叠的，点一下才展开排计划 */
let commanderExpanded = false;

/** 批量执行时每步的停顿。比"慢档"快得多：一次要跑 5 个回合，180ms 会拖成一分钟 */
const BATCH_DELAY = 40;

/** 现在是不是"轮到玩家当指挥官" */
function commanderActive(): boolean {
  return !!state.config.commanderMode && !state.winner && !spectating() && state.current === me();
}

/** 玩家这一方现在造得出来的兵种（按自己最高级的城市算，含上一代） */
function commanderPool(): UnitTypeDef[] {
  const eras = citiesOf(state, me()).map((c) => c.era);
  const era = eras.length > 0 ? Math.max(...eras) : 1;
  return Object.values(state.unitTypes)
    .filter(
      (d) =>
        d.category !== 'building' && !d.summonedOnly && d.era <= era && d.era >= era - 1,
    )
    .sort((a, b) => a.era - b.era || a.cost - b.cost);
}

/**
 * 生产序列里一格要花多少钱。
 *
 * 「升级时代」按"自己几座城里最便宜的那次升级"算——AI 执行时会挑它认为最该升的那座，
 * 个数对不上是常态，所以界面上的金币数字一律标成"≈"，不假装精确。
 */
function slotCost(unitId: string): number {
  if (!unitId) return 0;
  if (unitId === ORDER_UPGRADE) {
    const costs = citiesOf(state, me())
      .map((c) => upgradeCostOf(state, c))
      .filter((c): c is number => c !== null);
    return costs.length > 0 ? Math.min(...costs) : 0;
  }
  const def = state.unitTypes[unitId];
  return def ? recruitCost(state, me(), def) : 0;
}

/**
 * 每一格执行时手上有多少钱（估算）。
 *
 * 回合顺序是"我方 → 对方 → 我方…"，而收入是在结束回合时结算给**下一位**的，
 * 所以每轮到我方时正好多进一笔收入。于是：
 *   第 i 格可用 = 现有金币 + i × 每回合收入 − 前面各格的花费
 */
function estimateGold(): number[] {
  const income = incomeOf(state, me());
  const queue = ordersOf(state, me());
  const out: number[] = [];
  let spent = 0;
  for (let i = 0; i < CONFIG.commanderSlots; i++) {
    out.push(state.players[me()].gold + i * income - spent);
    spent += slotCost(queue[i] ?? '');
  }
  return out;
}

/** 只刷新金币提示，不重建下拉——否则玩家正在点的格子会被抽走 */
function refreshEstimates(): void {
  const gold = estimateGold();
  commanderEl.querySelectorAll<HTMLElement>('[data-est]').forEach((el) => {
    const i = Number(el.dataset.est);
    const avail = gold[i] ?? 0;
    const queue = ordersOf(state, me());
    const cost = slotCost(queue[i] ?? '');
    const tight = cost > avail;
    el.textContent = `≈ ${Math.max(0, Math.round(avail))} 金`;
    el.classList.toggle('tight', tight);
  });
  const tail = commanderEl.querySelector<HTMLElement>('[data-est-total]');
  if (tail) {
    const last = gold[gold.length - 1] ?? 0;
    tail.textContent = `跑完这批预计剩 ≈ ${Math.max(0, Math.round(last - slotCost(ordersOf(state, me())[CONFIG.commanderSlots - 1] ?? '')))} 金`;
  }
}

/**
 * 画指挥官面板。
 *
 * 只在"回合 / 可用时代 / 是否在跑"变化时重建：面板里是 <select>，
 * 而 AI 每走一步都会触发 render()，每次都重建的话玩家的下拉框会在点到一半时被抽走。
 */
function renderCommander(): void {
  if (!commanderActive()) {
    commanderEl.hidden = true;
    commanderSig = '';
    return;
  }
  commanderEl.hidden = false;

  if (commanderRunning) {
    const sig = `run|${commanderRound}`;
    if (sig === commanderSig) return;
    commanderSig = sig;
    const rounds = room ? 1 : CONFIG.commanderSlots;
    commanderEl.innerHTML = `
      <div class="cmd-head">
        <b>参谋部</b>
        <span class="cmd-hint">正在执行：第 ${commanderRound} / ${rounds} 回合</span>
      </div>
      <div class="cmd-progress"><i style="width:${(commanderRound / rounds) * 100}%"></i></div>
      <button class="btn" data-cmd="stop">中断</button>
    `;
    return;
  }

  const pool = commanderPool();
  const era = pool.length > 0 ? Math.max(...pool.map((d) => d.era)) : 1;
  const online = room !== null;
  const sig = `${state.turn}|${era}|${commanderExpanded}|${online}`;
  if (sig === commanderSig) {
    refreshEstimates();
    return;
  }
  commanderSig = sig;

  const queue = ordersOf(state, me());
  const opts = (sel: string) =>
    [
      '<option value="">— 不指定 —</option>',
      `<option value="${ORDER_UPGRADE}"${sel === ORDER_UPGRADE ? ' selected' : ''}>升级时代</option>`,
    ]
      .concat(
        pool.map(
          (d) =>
            `<option value="${d.id}"${d.id === sel ? ' selected' : ''}>${d.name} · ${d.cost} 金</option>`,
        ),
      )
      .join('');

  const slots = Array.from({ length: CONFIG.commanderSlots }, (_, i) => {
    const label = i === 0 ? '本回合' : `+${i}`;
    return `<label class="cmd-slot${i === 0 ? ' now' : ''}">
      <span class="cmd-step">${label}</span>
      <select data-slot="${i}">${opts(queue[i] ?? '')}</select>
      <span class="cmd-est" data-est="${i}"></span>
    </label>`;
  }).join('');

  commanderEl.innerHTML = `
    <div class="cmd-head">
      <b>参谋部</b>
      <span class="cmd-hint">${
        online
          ? '联机局里对面是人：点一次只打完你自己这一回合，然后提交给他。'
          : `排满下面 ${CONFIG.commanderSlots} 格，点一次就把这 ${CONFIG.commanderSlots} 个回合一起交给 AI 打完。`
      }</span>
      <button class="btn btn-sm cmd-toggle" data-cmd="toggle">${commanderExpanded ? '收起' : '排计划'}</button>
    </div>
    <div class="cmd-slots${commanderExpanded ? ' open' : ''}">${slots}</div>
    <div class="cmd-foot">
      <span class="cmd-total" data-est-total></span>
      <button class="btn btn-primary" data-cmd="run">${
        online ? '执行本回合并提交' : `执行 ${CONFIG.commanderSlots} 回合`
      }</button>
    </div>
  `;
  refreshEstimates();
}

/** 玩家改了某一格：整条序列重发一次（SET_ORDERS 是"设置"语义，天然幂等） */
commanderEl.addEventListener('change', (e) => {
  const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-slot]');
  if (!sel) return;
  const queue = Array.from(
    commanderEl.querySelectorAll<HTMLSelectElement>('select[data-slot]'),
  ).map((s) => s.value);
  dispatch({ type: 'SET_ORDERS', queue });
  refreshEstimates();
});

commanderEl.addEventListener('click', (e) => {
  const cmd = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
  if (!cmd) return;
  if (cmd === 'run') void runCommanderBatch();
  if (cmd === 'stop') {
    // 令牌一换，所有正在跑的 AI 循环下一步就自己退出
    aiToken += 1;
  }
  if (cmd === 'toggle') {
    commanderExpanded = !commanderExpanded;
    commanderSig = '';
    renderCommander();
    fitBoard();
  }
});

/** 这一方本回合的命令：三种走法见 runCommanderBatch 的注释 */
function commanderBudget(player: PlayerId): Partial<AiBudget> {
  const head = ordersOf(state, player)[0] ?? '';
  if (head === ORDER_UPGRADE) return { maxRecruit: 0, maxUpgrade: 1, order: null };
  return { maxRecruit: head ? 1 : 0, maxUpgrade: 0, order: head || null };
}

/**
 * 把计划一次性执行掉。
 *
 * 这是指挥官模式的本意：**减负**。玩家一次排 5 格、点一次，然后看结果，
 * 而不是每回合都要回来点一下——那就只是把"走子"换成了"点按钮"，负担没减。
 *
 * 单机时每一轮：我方按序列队首执行 → 对方（AI）自己排 → 轮回我方，序列各前移一格。
 * 中途分出胜负或玩家点"中断"就停。
 *
 * 联机局必须换一套走法：对面坐的是人，替他跑回合等于替他下棋，而且云端
 * 根本不知道我们本地走了什么。早先这里一视同仁地跑满 5 回合，症状就是
 * "预演一遍然后回退"（15 秒后轮询把云端旧局面套回来）加上"两边一起等对方"
 * （谁都没提交）。所以联机只推进自己这一回合，走完立刻提交，然后等对面。
 */
async function runCommanderBatch(): Promise<void> {
  if (!commanderActive() || commanderRunning) return;

  const online = room !== null;
  const rounds = online ? 1 : CONFIG.commanderSlots;
  /** 提交用的回合号：必须是"这一批开始前"的那个，才能撞出两边同时提交 */
  const startTurn = state.turn;

  const token = ++aiToken;
  clearSelection();
  aiPaused = false;
  // 先把当前下拉里的选择落到状态里：玩家可能只是改了选择就直接点执行
  const plan = Array.from(
    commanderEl.querySelectorAll<HTMLSelectElement>('select[data-slot]'),
  ).map((s) => s.value);
  if (plan.length > 0) {
    const set = applyAction(state, { type: 'SET_ORDERS', queue: plan });
    if (set.ok) state = set.state;
  }

  commanderRunning = true;
  commanderRound = 0;
  commanderSig = '';
  renderCommander();

  try {
    for (let r = 0; r < rounds; r++) {
      if (token !== aiToken || state.winner) break;
      if (state.current !== me()) break;

      commanderRound = r + 1;
      commanderSig = '';
      renderCommander();

      await runAiTurn(token, commanderBudget(state.current), BATCH_DELAY);
      if (token !== aiToken || state.winner) break;

      // 联机：到此为止。对面那一回合该由他自己在另一台机器上走。
      if (online) break;

      // 单机：对手也是 AI，自己决定这一回合造什么
      while (token === aiToken && !state.winner && state.current !== me()) {
        await runAiTurn(token, undefined, BATCH_DELAY);
      }
    }

    // 提交要在 commanderRunning 还是 true 的时候做：一旦放开，
    // 15 秒轮询就有机会在我们的网络请求回来之前把云端旧局面套上来。
    if (online && token === aiToken && room) {
      await pushTurn(room, startTurn);
    }
  } finally {
    commanderRunning = false;
    commanderRound = 0;
    commanderSig = '';
  }

  if (state.winner) {
    render();
    return;
  }

  // 联机：计划不回收。END_TURN 已经把序列前移了一格，让"这 5 格"
  // 老老实实对应接下来的 5 个回合，比每回合都重复第一格更好懂。
  if (online) {
    render();
    return;
  }

  // 单机：把这批计划重新装回序列，玩家满意的话下一次直接点执行，不用重排 5 格。
  // 这也正是"减负"——排一次能用很多批，想改再改。
  const rearm = applyAction(state, { type: 'SET_ORDERS', queue: plan });
  if (rearm.ok) state = rearm.state;

  saveMatch(state);
  render();
  // 被"中断"打断时 token 已经换人，这时别报"打完了"
  if (token === aiToken) toast(`这 ${CONFIG.commanderSlots} 个回合打完了`);
}

// ---------- 上帝模式（沙盒） ----------

/**
 * 上帝模式：不要钱、不看回合，直接往盘上摆兵摆城，然后让 AI 打给你看。
 *
 * 它和指挥官模式解决的不是同一件事：
 *   · 指挥官模式是**降低操作负担**，棋盘仍然是一盘正常对局；
 *   · 上帝模式是**想试一件事**——十个长弓手守不守得住一座桥、一辆坦克
 *     能不能捅穿一队枪兵、这个兵种到底值不值那个价。
 *     这类问题拿正常对局去验证，要先攒十分钟钱，打完还得重开一局。
 *
 * 所以这里的按钮只有"打完这一回合"和"打到全灭"，没有一个是在下棋。
 */

/** 摆哪一方 */
let godSide: PlayerId = 'A';
/** 手上拿的是什么 */
let godBrush: GodBrush = { kind: 'none' };
/** 摆城用哪个时代；0 表示"还没挑过"，按这一局的起始时代走 */
let godCityEra = 0;
/** 货架按扩展包筛选（'' = 全部）。和侧栏那个分开存：两边看的东西不一样 */
let godPack = '';
/** AI 正在同时操控两边 */
let godRunning = false;
/** 打到第几个回合（工具栏上那个"第 N 回合"）。1 是"正在打第一轮"，不是 0 */
let godRound = 1;
/** 上一次打完的一句话结论 */
let godResult = '';
/** 工具栏上次重建时的局面签名：AI 跑起来时每一步都在变，靠它挡掉无谓重建 */
let godSig = '';
/**
 * 货架那份签名。
 *
 * 单开一份，是因为它变的条件和工具栏不一样：AI 走一步（位置变了、血量变了）
 * 不需要重排 49 个兵种按钮，而重排会把货架的滚动位置清零——
 * 打一场仗要点几百步，站在货架下面看的人会被弹回顶部几百次。
 */
let godShelfSig = '';

/**
 * 沙盒里的 AI 速度档位。
 *
 * 和外面那条 `aiSpeed` 分开存，理由是两个场景要的东西不一样：
 *   · 正常对局最慢档（180ms）是给"我要看清对手在干什么"用的；
 *   · 沙盒看的是几十回合的走势，用最慢档放一场歼灭战得等一分多钟。
 * 所以这里默认快一档（70ms），和以前写死的 GOD_DELAY=60 基本一致，
 * 但现在是能调的。
 */
let godSpeed = 1;

/**
 * 「打到全灭」的安全上限（单位"次行动"，不是回合）。
 *
 * 一场歼灭战正常二三十回合就完了，这里给到 400 次行动，因为撞上它只有
 * 一种情况：两边谁也打不动谁（隔着河、全是高甲单位、或者只剩建筑）。
 * 那种局面继续跑只是在空转，不如停下来告诉玩家"没分出胜负"。
 */
const GOD_MAX_TURNS = 400;

/**
 * 沙盒里的 AI 不许产兵、不许升时代。
 *
 * 不是办不到，是那样就当不了试验场：两座城一开产线，五回合之后场上就变成
 * 两支新军，玩家摆上去的那几个兵反而成了配角。这个模式要回答的问题是
 * "我摆的这支部队怎么样"，所以经济这一层直接掐掉。
 */
const GOD_BUDGET: Partial<AiBudget> = { maxRecruit: 0, maxUpgrade: 0 };

function godMode(): boolean {
  return state.config.godMode === true;
}

/**
 * 还"能打"的部队。
 *
 * 建筑不算：军营、塔、磨坊既不会走也不会主动冲，把它们算进"还有兵"，
 * 会让一场已经打完的仗在界面上继续跑到 400 次行动——玩家看着空棋盘
 * 等一个永远不会来的"全灭"。
 */
function godCombatUnits(p: PlayerId): Unit[] {
  return unitsOf(state, p).filter((u) => utype(state, u.type).category === 'combat');
}

/**
 * 这一方还有没有"人"。
 *
 * 比 godCombatUnits 多认一样东西：**一枚等着孵的蛋**。
 *
 * 不死鸟倒下时不会立刻站起来，而是留下一枚蛋，等下次轮到主人才孵。
 * 中间这段时间，这一方在盘上确实一个战斗单位都没有——只按 units 判断，
 * 「打到全灭」会在蛋出现的那一瞬间收工，于是"复活"这件事在这个模式下
 * 永远没有机会发生。玩家看到的是"不死鸟死了就没了"，而规则层其实是
 * 活着的，只是没人把它孵出来。
 */
function godHasArmy(p: PlayerId): boolean {
  if (godCombatUnits(p).length > 0) return true;
  return state.pendingEgg?.owner === p;
}

function godUi() {
  return {
    state,
    side: godSide,
    brush: godBrush,
    pack: godPack,
    // 没挑过时代就按这一局的起始时代：从古典开局的人摆出来的城，
    // 没有理由默认成另一个时代
    cityEra: godCityEra || state.config.startEra,
    running: godRunning,
    round: godRound,
    result: godResult,
    speed: godSpeed,
    speedNames: AI_SPEED_NAME,
    log: state.log,
  };
}

function renderGodBar(): void {
  if (!godMode()) return;
  commanderEl.hidden = false;
  const sig = [
    state.turn,
    state.current,
    godSide,
    godBrush.kind,
    godBrush.kind === 'unit' ? godBrush.type : '',
    // 地形笔刷换一种地形也要重画，否则 chip 的高亮会停在上一格
    godBrush.kind === 'terrain' ? godBrush.terrain : '',
    godCityEra,
    godSpeed,
    godRunning ? `run${godRound}` : '-',
    godResult,
    state.units.length,
    state.cities.length,
    // 有一枚蛋等着孵也要重绘：工具栏上那句结论会从"接着摆"变成
    // "还有一枚蛋"，而蛋出现时单位数正好减一，两边都得算进签名
    state.pendingEgg ? state.pendingEgg.owner : '-',
  ].join('|');
  if (sig === godSig) return;
  godSig = sig;
  // 参谋部那份签名作废：下次回到指挥官模式时必须整块重建，否则会拿着
  // 沙盒的签名去比，面板原地不动
  commanderSig = '';
  commanderEl.innerHTML = godBarHtml(godUi());
}

function renderGodShelf(): void {
  const sig = [
    Object.keys(state.unitTypes).length,
    godSide,
    godBrush.kind,
    godBrush.kind === 'unit' ? godBrush.type : '',
    // 换包要重排整个货架，这一格必须进签名
    godPack,
    state.units.length,
    state.cities.length,
    state.players.A.gold,
    state.players.B.gold,
    // 战报条数进签名：这是唯一"局面没怎么变、但确实该重画"的东西。
    // 只认长度不认内容——一条新战报必然让长度 +1（战报只增不减）。
    state.log.length,
    // AI 在跑的时候货架要收起来，这也得重画
    godRunning ? 'run' : '-',
  ].join('|');
  if (sig === godShelfSig) return;
  godShelfSig = sig;
  // 换包/换兵种会整块重排：滚动位置由 keepSideScroll 一起搬过去
  keepSideScroll(() => {
    sideEl.innerHTML = godShelfHtml(godUi());
  });
}

/** 摆城时能放下 2×2 的角，扔给棋盘点亮成橙格 */function godCitySpots(): number[] {
  if (godBrush.kind !== 'city') return [];
  const out: number[] = [];
  const cs = state.config.citySize ?? CITY.size;
  for (let y = 0; y + cs <= state.h; y++) {
    for (let x = 0; x + cs <= state.w; x++) {
      if (sandboxCityProblem(state, x, y) === null) out.push(y * state.w + x);
    }
  }
  return out;
}

/** 沙盒里改局面：和 dispatch 一样记撤回栈，但不过规则层（不看回合、不查金币） */
function godApply(result: SandboxResult): void {
  if (!result.ok) {
    toast(result.reason);
    return;
  }
  undoStack.push(state);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  state = result.state;
  godResult = '';
  saveMatch(state);
  render();
}

function onGodClick(e: Event): void {
  if (godRunning) {
    toast('AI 正在打，先按「停止」');
    return;
  }
  const coords = coordsFromEvent(e);
  if (!coords) return;
  const { x, y } = coords;

  // 空手：这一格上是什么。沙盒里没有属性卡这回事，
  // 想知道血量就点一下，一句话说清就够了。
  if (godBrush.kind === 'none') {
    const u = state.units.find((v) => v.x === x && v.y === y);
    if (u) {
      const def = utype(state, u.type);
      toast(`${state.players[u.owner].name} · ${def.name} ${u.hp}/${def.maxHp} 血`);
      return;
    }
    const city = cityAt(state, x, y);
    if (city) {
      toast(
        `${state.players[city.owner].name} · ${city.era} 级城 ${city.hp}/${city.maxHp} 耐久`,
      );
      return;
    }
    const tile = state.tiles[idx(state, x, y)];
    if (tile) toast(TERRAIN_NAMES[tile.terrain] ?? tile.terrain);
    return;
  }

  if (godBrush.kind === 'erase') godApply(removeAt(state, x, y));
  else if (godBrush.kind === 'city') {
    godApply(placeCity(state, godSide, x, y, godCityEra || state.config.startEra));
  } else if (godBrush.kind === 'terrain') {
    // 改地形不看"摆给谁"：地形不属于任何一方
    godApply(paintTerrain(state, x, y, godBrush.terrain));
  } else godApply(placeUnit(state, godSide, godBrush.type, x, y));
}

/**
 * 让 AI 同时操控两边打。
 *
 * mode='round' 只推两方各一个回合（正好是一个完整的"回合"），然后把棋盘
 * 还给玩家；mode='dead' 一直打到一方没有能打的部队，中途可以按停止。
 *
 * 为什么两边都交给 AI：沙盒的看点就是"这两支部队对撞会怎样"。玩家亲自
 * 走一边，结果就带上了自己的水平，试数值这件事也就没意义了。
 */
async function runGodFight(mode: 'round' | 'dead'): Promise<void> {
  if (!godMode() || godRunning) return;
  if (!godHasArmy('A') || !godHasArmy('B')) {
    toast('两边都得有战斗单位才打得起来');
    return;
  }

  const token = ++aiToken;
  godRunning = true;
  godRound = 1;
  godResult = '';
  aiPaused = false;
  clearSelection();
  godSig = '';
  render();

  const maxTurns = mode === 'round' ? 2 : GOD_MAX_TURNS;
  let turns = 0;

  try {
    while (token === aiToken && turns < maxTurns) {
      if (state.winner) break;
      // 认「蛋」也是认兵：不死鸟倒下那一刻这一方在盘上是空的，
      // 按 godCombatUnits 判断就会在这里收工，复活永远等不到下一回合。
      // 每回合现读一次速度：跑到一半觉得太快，点一下下一回合就变慢。
      if (!godHasArmy('A') || !godHasArmy('B')) break;
      await runAiTurn(token, GOD_BUDGET, AI_SPEED_MS[godSpeed] ?? 70, () => !godHasArmy('A') || !godHasArmy('B'));
      turns += 1;
      // 刚走完的那一步属于第几轮：走完 1 次还是第一轮（另一方还没走）
      godRound = Math.floor(turns / 2) + 1;
      render();
    }
  } finally {
    godRunning = false;
    godSig = '';
  }

  // 被「停止」打断：令牌已经换人，收尾交给停止那一下，这里不许再报结论
  if (token !== aiToken) return;

  const wiped = (['A', 'B'] as PlayerId[]).filter((p) => !godHasArmy(p));
  if (wiped.length > 0) {
    godResult = `${state.players[wiped[0]!].name}的部队打光了`;
  } else if (state.pendingEgg) {
    // 停在一枚蛋上：不是"打光了"，是还没孵出来。按「打到全灭」再点一次，
    // AI 会先把它孵出来接着打。
    godResult = `${state.players[state.pendingEgg.owner].name}还有一枚蛋没孵`;
  } else if (mode === 'dead') {
    godResult = `打了 ${turns} 次行动，两边都还有兵`;
  } else {
    godResult = '一回合打完，接着摆，或者让 AI 继续';
  }
  saveMatch(state);
  render();
  toast(godResult);
}

// ---------- 联机 ----------

/** 进入房间：把云端那一局装进本机，并把存档切到这个房间的草稿槽 */
function applyRoom(seat: RoomSeat, snapshot: RoomSnapshot): void {
  room = seat;
  saveSeat(seat);
  rememberRoom(seat.code);
  setSaveScope(seat.code);
  // 迷雾是"我这边想不想看"的偏好，不该被对方的存档覆盖
  const fog = state.fog;
  state = snapshot.state;
  state.fog = fog;
  // 云端房间可能是老版本建的，"我方/敌方"这种旧默认名顺手换掉
  normalizePlayerNames(state);
  // 房间里的这一局记不记，看它自己的配置；换了局就得重开一个记录器
  resetRecorder();
  // 房间里两边各走各的：AI 托管在这里没有意义，顺手关掉免得它替人下棋
  state.aiControl = { A: false, B: false };
  aiToken += 1;
  aiPaused = false;
  dirty = false;
  closeHandoff();
  clearSelection();
  saveMatch(state);
  render();
  startRoomPolling();
}

function leaveRoom(): void {
  const wasWatching = watching();
  detachRoom();
  // 回到本机那局：进房间时没动过它，原样还在
  state = loadMatch() ?? createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
  resetRecorder();
  clearSelection();
  render();
  toast(wasWatching ? '已退出观战，回到本机对局' : '已退出房间，回到本机对局');
}

/** 只断开房间、不载入本机对局：换局或导入存档时用 */
function detachRoom(): void {
  if (!room) return;
  window.clearInterval(roomTimer);
  roomTimer = 0;
  room = null;
  dirty = false;
  rememberRoom(null);
  setSaveScope(null);
}

/** 提交这一回合。expectedTurn 是提交前本机的回合数，用来发现"两边同时提交" */
async function pushTurn(seat: RoomSeat, expectedTurn: number): Promise<void> {
  try {
    const ok = await submitTurn(seat.code, state, expectedTurn);
    if (!ok) {
      toast('云端已经是别的回合了（可能对面也提交过），点「联机 → 刷新状态」看一眼');
      return;
    }
    dirty = false;
    toast('这一回合已提交，等对方行动');
    render();
  } catch (err) {
    toast(err instanceof Error ? err.message : '提交失败，网络可能不通');
  }
}

function startRoomPolling(): void {
  window.clearInterval(roomTimer);
  roomTimer = window.setInterval(() => void pollRoom(), 15000);
}

/**
 * 定时问一句"对面走完没有"。
 *
 * 参赛者：只在两个条件同时成立时才把云端状态装进来：
 *   1. 云端说轮到我了（否则拉回来也没用）；
 *   2. 我这边没有未提交的草稿（否则会把人刚摆好的兵清掉）。
 *
 * 观战位没有"轮到我"这回事，所以只要有新东西就往下拉：
 * 回合变了、换人了、或者分出胜负了（认输不会推进回合，只看 turn 会漏）。
 */
async function pollRoom(): Promise<void> {
  const seat = room;
  if (!seat || handoffOpen) return;
  if (document.visibilityState !== 'visible') return;
  if (aiBusy()) return;
  // 参谋部正在批量执行：这时云端的 turn 还是旧的，拉回来就是把刚走的一步抹掉
  if (commanderRunning) return;

  try {
    const snapshot = await fetchRoom(seat.code);
    if (!snapshot || room?.code !== seat.code) return;

    if (seat.spectator) {
      const changed =
        snapshot.turn !== state.turn ||
        snapshot.current !== state.current ||
        !!snapshot.state.winner !== !!state.winner;
      if (!changed) return;
      const fog = state.fog;
      state = snapshot.state;
      state.fog = fog;
      saveMatch(state);
      render();
      return;
    }

    if (snapshot.current !== seat.seat) return;
    if (snapshot.turn === state.turn) return;
    if (dirty) {
      toast('对方已提交，但你这边还有没提交的走法——先结束回合，或者重新进房间');
      return;
    }
    const fog = state.fog;
    state = snapshot.state;
    state.aiControl = { A: false, B: false };
    state.fog = fog; // 同上：迷雾是本地偏好，别被对面关掉
    clearSelection();
    saveMatch(state);
    render();
    toast('对方已提交，轮到你');
  } catch {
    // 轮询失败不打扰人：下次再问就是了
  }
}

/**
 * 用邀请链接打开（?room=CODE）时自动入座。
 *
 * 有本机的席位记录就直接回到原席位；没有就坐空位——
 * 也就是说"把链接发给同学"这一步，他点开就已经坐下了，不用再填代码。
 * 两个座位都满了就自动转观战：这条链接本来就是"来看我这局"，
 * 弹一句"席位满了"把人挡在门外，是最没必要的一次拒绝。
 */
async function enterRoomFromUrl(code: string): Promise<void> {
  try {
    const snapshot = await fetchRoom(code);
    if (!snapshot) {
      toast(`没有找到房间 ${code}，可能代码打错了`);
      return;
    }
    const mine = loadSeat(code);
    if (mine?.spectator) {
      applyRoom({ code, seat: 'A', token: mine.token, spectator: true }, snapshot);
      toast(`回到房间 ${code} 的观战视角`);
      return;
    }
    const token = mine?.token ?? newToken();
    const order: PlayerId[] = mine ? [mine.seat] : ['A', 'B'];
    for (const seat of order) {
      const result = await claimSeat(code, seat, token);
      if (result === 'ok') {
        applyRoom({ code, seat, token }, snapshot);
        toast(`已进入房间 ${code}，你执${seat === 'A' ? '红方' : '蓝方'}`);
        return;
      }
    }
    applyRoom({ code, seat: 'A', token, spectator: true }, snapshot);
    toast(`两个席位都有人了，已切到观战视角（全图）`);
  } catch (err) {
    toast(err instanceof Error ? err.message : '进入房间失败');
  }
}

/** 以观战身份进入一个房间：不占座、不写云端，只看 */
function watchRoom(code: string, snapshot: RoomSnapshot): void {
  applyRoom({ code, seat: 'A', token: newToken(), spectator: true }, snapshot);
}

// ---------- 交接遮罩 ----------

function openHandoff(): void {
  closeHandoff();
  handoffOpen = true;
  const nextPlayer = state.current;
  const side = nextPlayer === 'A' ? 'a' : 'b';
  const name = state.players[nextPlayer].name;
  const gold = state.players[nextPlayer].gold;

  const el = document.createElement('div');
  el.className = 'handoff';
  el.id = 'handoff';
  el.innerHTML = `
    <div class="handoff-card">
      <div class="handoff-badge ${side}">轮到 ${name}</div>
      <h2>把设备交给对方</h2>
      <p>当前金币 ${gold}。点开始之后，屏幕上只会显示你视野内的对方单位。<br />其余看不见的单位会以虚框标记在最后已知的位置。</p>
      <button class="btn btn-primary btn-block" data-act="handoff-start">我是 ${name}，开始行动</button>
    </div>
  `;
  appEl.appendChild(el);
}

function closeHandoff(): void {
  handoffOpen = false;
  document.getElementById('handoff')?.remove();
}

// ---------- 事件 ----------

// ---------- 拖动看地图 ----------
//
// 放大之后只有滚动条，用鼠标得去够右下角那条细缝，很难受；
// 手机上虽然有系统滚动，但指针事件这条也要能走，行为才一致。
//
// 关键一步是"拖动过就别再算点击"：不然松开的地方正好压着一个格子，
// 会顺带把选中的单位走过去——拖一次地图走一步棋，谁都不敢拖。
let panning = false;
let panMoved = false;
let panFrom = { x: 0, y: 0, left: 0, top: 0 };
let suppressClick = false;

boardScrollEl.addEventListener('pointerdown', (e) => {
  if (boardZoom <= 1) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  panning = true;
  panMoved = false;
  panFrom = { x: e.clientX, y: e.clientY, left: boardScrollEl.scrollLeft, top: boardScrollEl.scrollTop };
  boardScrollEl.classList.add('dragging');
  boardScrollEl.setPointerCapture?.(e.pointerId);
});

boardScrollEl.addEventListener('pointermove', (e) => {
  if (!panning) return;
  const dx = e.clientX - panFrom.x;
  const dy = e.clientY - panFrom.y;
  if (!panMoved && Math.abs(dx) + Math.abs(dy) < 6) return;
  panMoved = true;
  boardScrollEl.scrollLeft = panFrom.left - dx;
  boardScrollEl.scrollTop = panFrom.top - dy;
  e.preventDefault();
});

const endPan = (): void => {
  if (!panning) return;
  panning = false;
  boardScrollEl.classList.remove('dragging');
  if (panMoved) suppressClick = true;
};
boardScrollEl.addEventListener('pointerup', endPan);
boardScrollEl.addEventListener('pointercancel', endPan);
boardScrollEl.addEventListener('pointerleave', endPan);

appEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  // 上一次操作是"拖地图"：这一下 click 是拖动的尾巴，不是点格子
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  const actionEl = target.closest<HTMLElement>('[data-act]');
  if (actionEl?.dataset.act) {
    handleAction(actionEl.dataset.act, actionEl);
    return;
  }

  if (target.closest('.board')) onBoardClick(e);
});

/**
 * 顶栏放不下时横向滚动。
 *
 * 光有滚动条还不够：鼠标竖轮在横向容器上是不会滚的，
 * 得有人把 deltaY 翻译成 scrollLeft，否则"滚轮"这个动作在预览面板里完全没反应。
 */
topbarEl.addEventListener(
  'wheel',
  (e) => {
    if (topbarEl.scrollWidth <= topbarEl.clientWidth + 1) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 已经是横向手势，交给浏览器
    e.preventDefault();
    topbarEl.scrollLeft += e.deltaY;
  },
  { passive: false },
);

topbarEl.addEventListener('scroll', () => syncTopbarScroll(), { passive: true });

/**
 * 产兵搜索框。
 *
 * 重绘会换掉整个 input 元素，所以敲字之后必须把焦点还回去。
 *
 * 但**输入法组字期间绝对不许重绘**——这是 "chuan船" 变成一串乱码的根源：
 * 中文输入时 input 元素正身处分词状态，浏览器把这段状态挂在那个 DOM 节点上。
 * 我们在 composition 中途把它整个换掉，浏览器只好把缓冲的按键重新投递进
 * 新元素，于是已经上屏的 "chuan" 又被敲了一遍，最终提交出 "chuanchuan船"。
 * 所以组字期间只记字、不重绘；`compositionend` 一到再统一重画一次。
 *
 * 这也意味着组字期间列表不跟着筛——反正那时候框里是拼音，筛了也没有意义。
 * 英文/数字输入没有 composition 事件，仍然是逐字实时过滤。
 */
const isRecruitSearch = (el: EventTarget | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement && el.dataset.act === 'recruit-search';

/** 输入法正在组字（分词的临时状态挂在这个 input 节点上，不能动它） */
let recruitComposing = false;

/** 重绘侧栏并把焦点、光标还回搜索框 */
function repaintRecruitPanel(): void {
  keepSideScroll(() => renderPanel(sideEl, panelInput()));

  const again = sideEl.querySelector<HTMLInputElement>('[data-act="recruit-search"]');
  if (!again) return;
  again.focus({ preventScroll: true });
  const end = again.value.length;
  try {
    again.setSelectionRange(end, end);
  } catch {
    // type=search 在某些内核上不支持选区，光标在末尾也无所谓
  }
}

appEl.addEventListener('compositionstart', (e) => {
  if (isRecruitSearch(e.target)) recruitComposing = true;
});

appEl.addEventListener('compositionend', (e) => {
  if (!isRecruitSearch(e.target)) return;
  recruitComposing = false;
  recruitQuery = e.target.value;
  repaintRecruitPanel();
});

appEl.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | null;
  if (!isRecruitSearch(el)) return;
  recruitQuery = el.value;

  // 组字中（包括没拿到 composition 事件、只在 input 上标了 isComposing 的内核）
  if (recruitComposing || (e as InputEvent).isComposing === true) return;

  repaintRecruitPanel();
});

// 悬停可移动格时加深高亮
boardEl.addEventListener('mouseover', (e) => {
  const target = e.target as HTMLElement | null;
  const tile = target?.closest<HTMLElement>('.tile.reach');
  if (!tile) return;
  const x = Number(tile.dataset.x);
  const y = Number(tile.dataset.y);
  if (reach.includes(idx(state, x, y))) tile.classList.add('reach-hover');
});

boardEl.addEventListener('mouseout', (e) => {
  const target = e.target as HTMLElement | null;
  target?.closest<HTMLElement>('.tile.reach')?.classList.remove('reach-hover');
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => render(), 120);
});

// ---------- 启动 ----------

/**
 * 白屏兜底。
 *
 * 启动是整套界面里唯一"一炸就什么都没了"的地方：state 从存档读出来可能是脏的，
 * 兵种表对不上存档里的 id 时 `utype` 会直接 throw，而 `render()` 要给每个棋子
 * 查兵种——一抛错，页面上一个字都不会出现。
 *
 * 玩家那边看到的就是白屏：没有提示、没有按钮，不知道是网断了、站点挂了、
 * 还是自己点坏了，只知道"登不上去了"。这是最糟糕的失败方式。
 *
 * 所以这里必须做两件事：把错误**显示出来**，并且留一条**一定能进来**的路。
 */
function fatalBanner(err: unknown, title = '启动出错'): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[方格战棋]', title, err);
  if (document.getElementById('fatal-banner')) return;

  const box = document.createElement('div');
  box.id = 'fatal-banner';
  box.className = 'fatal-banner';
  const head = document.createElement('div');
  head.className = 'fatal-title';
  head.textContent = `${title}，页面没能启动`;
  const body = document.createElement('div');
  body.className = 'fatal-msg';
  body.textContent = msg;
  const hint = document.createElement('div');
  hint.className = 'fatal-hint';
  hint.textContent = '详情在浏览器控制台。旧存档已另存一份（warchess:match:v1.broken），不会丢。';
  const actions = document.createElement('div');
  actions.className = 'fatal-actions';
  const reset = document.createElement('button');
  reset.className = 'btn btn-sm';
  reset.textContent = '清空本机存档并重开';
  reset.addEventListener('click', () => {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('warchess:match')) localStorage.removeItem(k);
      }
    } catch {
      // 隐私模式写不了就算了
    }
    location.reload();
  });
  const reload = document.createElement('button');
  reload.className = 'btn btn-sm btn-quiet';
  reload.textContent = '刷新页面';
  reload.addEventListener('click', () => location.reload());
  actions.append(reset, reload);
  box.append(head, body, actions, hint);
  document.body.prepend(box);
}

/**
 * 先尝试"修"存档，而不是直接扔掉。
 *
 * 兵种表是跟着存档一起存快照的，版本一换就可能对不上：存档里记着某个兵种 id，
 * 而这一版的兵种表里已经没有它了。`utype` 碰到这种 id 会 throw，`render()`
 * 又在启动时逐个棋子查兵种——于是一条脏数据就能让整页白屏。
 *
 * 但为了一条脏数据丢掉人家打了一半的局，代价太大了。所以先把它摘掉：
 * 棋盘上少一个兵，棋还能接着下。返回摘掉了几个，好让人知道发生了什么。
 */
function repairLoadedState(): number {
  const dropped: string[] = [];
  state.units = state.units.filter((u) => {
    if (state.unitTypes[u.type]) return true;
    dropped.push(`${u.id}:${u.type}`);
    return false;
  });

  if (dropped.length > 0) {
    console.warn('[方格战棋] 存档里有本版不认识的单位，已移除', dropped);
  }
  return dropped.length;
}

/**
 * 存档读不动了：先把它挪到一边（留证据），再开一局新的把人放进去。
 *
 * 宁可丢掉一局，也不能让人卡在进不去的白屏上——前者是可惜，后者是断绝。
 */
function recoverFromBadSave(err: unknown): void {
  console.error('[方格战棋] 存档读不动了，改开新局', err);
  try {
    const raw = localStorage.getItem('warchess:match:v1');
    if (raw) localStorage.setItem('warchess:match:v1.broken', raw);
  } catch {
    // 隐私模式写不了，忽略
  }
  try {
    clearMatch();
    detachRoom();
  } catch {
    // 同上
  }
  try {
    state = createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
    refreshMemory(state);
    saveMatch(state);
    render();
    toast('上一局的存档读不出来，已经为你新开一局（旧存档留在本机）');
    return;
  } catch (err2) {
    fatalBanner(err2, '存档已重置但仍然出错');
  }
}

// 运行期兜底：别让一次未捕获的异常变成一个没有任何信息的白屏
window.addEventListener('error', (e) => {
  if (e.error) fatalBanner(e.error, '运行时出错');
});

let resuming = false;
try {
  // 先看看上次是不是在某个房间里：是的话要先把存档作用域切过去，再读草稿
  resuming = resumeRoom();

  // 旧版本存档结构已经变了，直接丢掉重新开局
  if (state.version !== 4) {
    clearMatch();
    detachRoom();
    state = createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
    resuming = false;
  }

  const patched = repairLoadedState();
  refreshMemory(state);
  saveMatch(state);
  render();
  if (patched > 0) {
    toast(`存档里有 ${patched} 个本版不认识的单位，已经移除，剩下的照常打`);
  }
} catch (err) {
  resuming = false;
  recoverFromBadSave(err);
}

// 双 AI 观战局，打开页面就该自己动起来
kickAiIfNeeded();
if (resuming) {
  const seat = currentRoom();
  if (seat) {
    toast(`回到房间 ${seat.code}`);
    void pollRoom();
  }
}

// 回到这个页面、或者切回这个标签页时，先问一句对面走完没有——
// 轮询是兜底，用户切回来那一下才是真正会被感知到的时机。
window.addEventListener('focus', () => void pollRoom());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void pollRoom();
});

// 邀请链接 ?room=CODE：点开就直接入座，不用再填一遍代码
const invited = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
if (invited.length >= 4) {
  // 只摘掉 room 参数：sharecode 是站点本身的通行证，一起删掉页面就打不开了
  const clean = new URL(location.href);
  clean.searchParams.delete('room');
  window.history.replaceState(null, '', clean.toString());
  void enterRoomFromUrl(invited);
}

/*
 * 启动时核对一次"页面域名 vs 云端 endpoint"。
 *
 * 这两者必须完全一致：云服务对 Origin 做精确匹配，差一个字就是 403，
 * 而 SDK 会把 403 包成一个没有 code、没有 message 的错误，界面最终只能说
 * "网络不通，稍后再试"——2026-10-27 那次联机全挂就是这么被误判成网络问题的。
 *
 * 这里只写控制台，不弹窗：本机对局完全用不到云端，没必要为一个"以后可能
 * 用不到的能力"在开局挡一次路。真正要用的时候，联机面板顶上那条自检
 * 会把原因摆出来。
 */
// 启动收尾：读回来的存档可能开着"记录详细数据"，那就从现在这一回合接着记。
// 放在文件末尾是因为它要等 recorder 这些模块级变量都初始化完（TDZ）。
resetRecorder();

const drift = originMismatch();
if (drift) {
  console.error(
    `[联机] 云端配置和当前域名不一致：页面在 ${drift.actual}，` +
      `而 CLOUD_CONFIG.endpoint 是 ${drift.configured}。\n` +
      '联机（建房 / 进房 / 提交）一定会失败，并且会报成"网络不通"。\n' +
      '修法：把 src/net/cloud-config.ts 的 endpoint 和 publishableKey 换成这个应用当前下发的 publicConfig。',
  );
}

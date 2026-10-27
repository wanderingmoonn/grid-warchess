/**
 * 组装层：把规则内核、视图过滤、渲染、存档粘在一起。
 *
 * 这一层只做三件事：读事件 → 造 Action → 重绘。
 * 它不允许直接改 state 的任何字段（切换迷雾除外，那不是规则行为）。
 */

import './style.css';

import { expansionById } from './core/expansions.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiLevelOf, aiNextAction, anyAiSide, isAiSide } from './core/ai.ts';
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
  ordersOf,
  reachableTiles,
  recruitCost,
  refreshMemory,
  siegeTargets,
  threatTiles,
  unitsOf,
  upgradeCostOf,
  utype,
} from './core/rules.ts';
import { clearUnits, placeCity, placeUnit, removeAt, sandboxCityProblem } from './core/sandbox.ts';
import type { SandboxResult } from './core/sandbox.ts';
import { loadCustomUnits } from './core/customUnits.ts';
import { createMatch, DEFAULT_CONFIG, normalizePlayerNames, randomSeed } from './core/setup.ts';
import type { Action, GameState, PlayerId, Unit, UnitTypeDef } from './core/types.ts';
import { coordsFromEvent, renderBoard, unitIdFromEvent } from './ui/board.ts';
import { renderPanel, topbarShell, updateTopbar, TERRAIN_NAMES } from './ui/panel.ts';
import type { PanelInput } from './ui/panel.ts';
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
let reach: number[] = [];
let targets: string[] = [];
let siege: string[] = [];
/** 非空时表示某个建造单位正在选址 */
let buildPlan: { unitId: string; type: string } | null = null;
/** 非空时表示这条船正在等人上船（值是船的 id） */
let loadPlan: string | null = null;
/** 非空时表示这条船正在找地方下船（值是船的 id） */
let unloadPlan: string | null = null;
let handoffOpen = false;

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
  return room ? room.seat : state.current;
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
    spectator: watching(),
    // 指挥官模式也走"只看"这条线：mine 关掉，但提示文案不一样
    commander: state.config.commanderMode === true,
  };
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
  });
  // 路线只演一次：下一次重绘不该再播一遍
  pendingMovePath = null;

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
    renderPanel(sideEl, panelInput());
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
    current: state.current,
    currentName: state.players[state.current].name,
    aiCurrent: isAiSide(state, state.current),
    aiLevelName: aiLevelOf(state) === 'basic' ? '初级 AI' : '高级 AI',
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
  selectedId = null;
  selectedCityId = null;
  selectedCampId = null;
  selectedTile = null;
  buildPlan = null;
  loadPlan = null;
  unloadPlan = null;
  reach = [];
  targets = [];
  siege = [];
}

/** 建造者周围哪些空格可以盖东西（桥是唯一能盖在水上的） */
function computePlaceable(): number[] {
  // 上帝模式：只有"摆城"需要提前点亮格子（2×2 的角放哪儿是有讲究的，
  // 光靠点错再弹提示得试上十几次）。摆兵不点亮——整张图大半都能放，
  // 亮起来只是把棋盘糊成一片橙的。
  if (state.config.godMode === true) return godCitySpots();

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

function onBoardClick(e: Event): void {
  // 上帝模式的点击语义完全不同：这里点棋盘是"落子"，不是"走子"。
  // 走子那套判断（轮到我吗、这格可达吗、能不能开火）在沙盒里一条都不成立，
  // 所以整块交出去，不在这里塞一堆 if。
  if (state.config.godMode === true) {
    onGodClick(e);
    return;
  }
  if (handoffOpen || state.winner || aiBusy()) return;

  const clickedUnitId = unitIdFromEvent(e);
  const coords = coordsFromEvent(e);

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
    if (clickedUnitId) {
      const u = state.units.find((x) => x.id === clickedUnitId);
      if (u) {
        if (u.owner === me() && utype(state, u.type).barracks) selectCamp(u);
        else selectUnit(u);
        return;
      }
    }
    if (!coords) return;
    const cityHere = cityAt(state, coords.x, coords.y);
    if (cityHere) {
      selectCity(cityHere.id);
      return;
    }
    clearSelection();
    selectedTile = coords;
    render();
    return;
  }
  if (!myTurn()) {
    toast('等对方提交这一回合');
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

function handleAction(act: string, el: HTMLElement): void {
  switch (act) {
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
      // 军营和城市同一类操作，只是 action 里填的字段不同
      if (selectedCampId) {
        dispatch({ type: 'RECRUIT', unitId: selectedCampId, unitType: type });
        render();
        return;
      }
      if (!selectedCityId) return;
      dispatch({ type: 'RECRUIT', cityId: selectedCityId, unitType: type });
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
      const lv = aiLevelOf(state) === 'basic' ? '初级' : '高级';
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
 */
async function runAiTurn(
  token: number,
  overrides?: Partial<AiBudget>,
  delayOverride?: number,
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
    const action = aiNextAction(state, budget);
    if (!action) break;

    planMovePath(state, action);
    const walked = pendingMovePath?.values().next().value?.length ?? 0;
    const result = applyAction(state, action);
    if (!result.ok) break;

    state = result.state;
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
  // 重排会把滚动位置清零，记一下再还回去
  const keep = sideEl.querySelector<HTMLElement>('.god-shelf')?.scrollTop ?? 0;
  sideEl.innerHTML = godShelfHtml(godUi());
  const shelf = sideEl.querySelector<HTMLElement>('.god-shelf');
  if (shelf) shelf.scrollTop = keep;
}

/** 摆城时能放下 2×2 的角，扔给棋盘点亮成橙格 */function godCitySpots(): number[] {
  if (godBrush.kind !== 'city') return [];
  const out: number[] = [];
  for (let y = 0; y + CITY.size <= state.h; y++) {
    for (let x = 0; x + CITY.size <= state.w; x++) {
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
      await runAiTurn(token, GOD_BUDGET, AI_SPEED_MS[godSpeed] ?? 70);
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
 * 重绘会换掉整个 input 元素，所以敲字之后必须把焦点还回去，否则输入法
 * 拼音打到一半就被打断（第一个字上屏，后面全丢）——这也是为什么不能
 * 简单地在 input 上挂 debounce 再 render()：焦点一丢，中文就打不出来。
 * 这里每次 input 都同步重绘并立刻复位光标，串行跑，中间不留空档。
 */
appEl.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | null;
  if (!el || el.dataset.act !== 'recruit-search') return;
  recruitQuery = el.value;

  renderPanel(sideEl, panelInput());

  const again = sideEl.querySelector<HTMLInputElement>('[data-act="recruit-search"]');
  if (!again) return;
  again.focus({ preventScroll: true });
  const end = again.value.length;
  try {
    again.setSelectionRange(end, end);
  } catch {
    // type=search 在某些内核上不支持选区，光标在末尾也无所谓
  }
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

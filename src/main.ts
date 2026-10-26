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
import { CONFIG, ORDER_UPGRADE, passable } from './core/config.ts';
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
  idx,
  incomeOf,
  ordersOf,
  reachableTiles,
  recruitCost,
  refreshMemory,
  siegeTargets,
  threatTiles,
  upgradeCostOf,
  utype,
} from './core/rules.ts';
import { loadCustomUnits } from './core/customUnits.ts';
import { createMatch, DEFAULT_CONFIG, randomSeed } from './core/setup.ts';
import type { Action, GameState, PlayerId, Unit, UnitTypeDef } from './core/types.ts';
import { coordsFromEvent, renderBoard, unitIdFromEvent } from './ui/board.ts';
import { renderPanel, topbarShell, updateTopbar } from './ui/panel.ts';
import { loadChimeVolume, nextChimeVolume, playChime, saveChimeVolume } from './ui/sound.ts';
import { openSetupPanel } from './ui/setup-panel.ts';
import { openOnlinePanel } from './ui/online-panel.ts';
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
        <div class="board" id="board"></div>
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
const sideEl = pick<HTMLElement>(appEl, '#side');
const topbarEl = pick<HTMLElement>(appEl, '#topbar');
const commanderEl = pick<HTMLElement>(appEl, '#commander');

// 顶栏骨架只插一次。之后每一步只改文字/class/hidden，绝不重建按钮节点——
// 否则 AI 连续行动时 click 会在 mousedown 与 mouseup 之间丢掉目标（按钮点不动）。
topbarEl.innerHTML = topbarShell();

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
  });

  renderPanel(sideEl, {
    view,
    me: me(),
    // 注意用 view.state 而不是 state：面板同样不该看到视野外的东西
    selectedUnit: selectedId ? (view.state.units.find((u) => u.id === selectedId) ?? null) : null,
    selectedCityId,
    selectedCampId,
    selectedTile,
    canUndo: undoStack.length > 0 && !room,
    chimeVolume,
    spectator: watching(),
  });

  renderCommander();

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

  const px = Math.round(baseBoardSize * boardZoom);
  boardEl.style.width = `${px}px`;
  boardEl.style.height = `${px}px`;
  boardEl.classList.toggle('zoomed', boardZoom > 1);
  boardWrapEl.classList.toggle('zoomed', boardZoom > 1);

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
    boardWrapEl.scrollLeft = Math.max(0, (boardWrapEl.scrollWidth - boardWrapEl.clientWidth) / 2);
    boardWrapEl.scrollTop = Math.max(0, (boardWrapEl.scrollHeight - boardWrapEl.clientHeight) / 2);
  } else {
    boardWrapEl.scrollLeft = 0;
    boardWrapEl.scrollTop = 0;
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
  selectedCityId = null;
  selectedTile = null;
  buildPlan = null;
  selectedCampId = u.id;
  selectedId = u.id;
  refreshSelection();
  render();
}

function selectCity(cityId: string): void {
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
  const result = applyAction(state, action);
  if (!result.ok) {
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
 * 能撤的范围是刻意收窄的：联机不行、指挥官模式不行、AI 正在走不行、跨回合不行。
 * 这四条都是"撤了会和真实状态对不上"的情况，不是保守。
 */
function undoLast(): void {
  if (room) {
    toast('联机对局不能撤回：提交过的回合收不回来');
    return;
  }
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
  if (handoffOpen || state.winner || aiBusy()) return;

  const clickedUnitId = unitIdFromEvent(e);
  const coords = coordsFromEvent(e);

  // 只读查看：点敌方单位出属性卡——不看轮到谁，也不看是不是指挥官模式。
  //
  // 扩展包把兵种从 49 个堆到 118 个之后，"对面这个是什么、射程几格、护甲多少"
  // 变成了临场刚需（以前整局就那几种兵，看图标就知道）。而"看"不是"操作"，
  // 没理由要求轮到自己才能看。面板那边对非己方单位一律不给按钮。
  if (clickedUnitId) {
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

  // 指挥官模式：这一方的走位与开火归 AI，棋盘只看不碰
  if (state.config.commanderMode) return;
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
      if (!window.confirm(`确认拆除「${def.name}」？回收约 ${Math.round(recruitCost(state, u.owner, def) * 0.4)} 金。`)) return;
      if (dispatch({ type: 'DISBAND', unitId: selectedId })) {
        selectedId = null;
        render();
      }
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

    const result = applyAction(state, action);
    if (!result.ok) break;

    state = result.state;
    if (action.type === 'RECRUIT') budget.recruited += 1;
    if (action.type === 'UPGRADE') budget.upgraded += 1;

    // 逐帧重绘是为了让人看清；极快档就不必每步都画，每几步刷一次够了
    if (delay > 0 || step % 6 === 0) {
      saveMatch(state);
      render();
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
    .filter((d) => d.category !== 'building' && d.era <= era && d.era >= era - 1)
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
    commanderEl.innerHTML = `
      <div class="cmd-head">
        <b>参谋部</b>
        <span class="cmd-hint">正在执行：第 ${commanderRound} / ${CONFIG.commanderSlots} 回合</span>
      </div>
      <div class="cmd-progress"><i style="width:${(commanderRound / CONFIG.commanderSlots) * 100}%"></i></div>
      <button class="btn" data-cmd="stop">中断</button>
    `;
    return;
  }

  const pool = commanderPool();
  const era = pool.length > 0 ? Math.max(...pool.map((d) => d.era)) : 1;
  const sig = `${state.turn}|${era}|${commanderExpanded}`;
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
      <span class="cmd-hint">排满下面 5 格，点一次就把这 5 个回合一起交给 AI 打完。</span>
      <button class="btn btn-sm cmd-toggle" data-cmd="toggle">${commanderExpanded ? '收起' : '排计划'}</button>
    </div>
    <div class="cmd-slots${commanderExpanded ? ' open' : ''}">${slots}</div>
    <div class="cmd-foot">
      <span class="cmd-total" data-est-total></span>
      <button class="btn btn-primary" data-cmd="run">执行 ${CONFIG.commanderSlots} 回合</button>
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
 * 把接下来 5 个回合一次性打完。
 *
 * 这是指挥官模式的本意：**减负**。玩家一次排 5 格、点一次，然后看结果，
 * 而不是每回合都要回来点一下——那就只是把"走子"换成了"点按钮"，负担没减。
 *
 * 每一轮：我方按序列队首执行 → 对方（AI）自己排 → 轮回我方，序列各前移一格。
 * 中途分出胜负或玩家点"中断"就停。
 */
async function runCommanderBatch(): Promise<void> {
  if (!commanderActive() || commanderRunning) return;

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
    for (let r = 0; r < CONFIG.commanderSlots; r++) {
      if (token !== aiToken || state.winner) break;
      if (state.current !== me()) break;

      commanderRound = r + 1;
      commanderSig = '';
      renderCommander();

      await runAiTurn(token, commanderBudget(state.current), BATCH_DELAY);
      if (token !== aiToken || state.winner) break;

      // 对手的回合：指挥官模式下对手也是 AI，自己决定这一回合造什么
      while (token === aiToken && !state.winner && state.current !== me()) {
        await runAiTurn(token, undefined, BATCH_DELAY);
      }
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

  // 把这批计划重新装回序列：玩家满意的话下一次直接点执行，不用重排 5 格。
  // 这也正是"减负"——排一次能用很多批，想改再改。
  const rearm = applyAction(state, { type: 'SET_ORDERS', queue: plan });
  if (rearm.ok) state = rearm.state;

  saveMatch(state);
  render();
  // 被"中断"打断时 token 已经换人，这时别报"打完了"
  if (token === aiToken) toast(`这 ${CONFIG.commanderSlots} 个回合打完了`);
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
        toast(`已进入房间 ${code}，你执${seat === 'A' ? '我方' : '敌方'}`);
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
      <p>当前金币 ${gold}。点开始之后，屏幕上只会显示你视野内的敌方单位。<br />其余看不见的单位会以虚框标记在最后已知的位置。</p>
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

appEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;

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

// 先看看上次是不是在某个房间里：是的话要先把存档作用域切过去，再读草稿
const resuming = resumeRoom();

// 旧版本存档结构已经变了，直接丢掉重新开局
if (state.version !== 4) {
  clearMatch();
  detachRoom();
  state = createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
}

refreshMemory(state);
saveMatch(state);
render();
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

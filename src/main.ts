/**
 * 组装层：把规则内核、视图过滤、渲染、存档粘在一起。
 *
 * 这一层只做三件事：读事件 → 造 Action → 重绘。
 * 它不允许直接改 state 的任何字段（切换迷雾除外，那不是规则行为）。
 */

import './style.css';
import * as tutorial from './ui/tutorial.ts';
import { openBattleCard } from './ui/battle-card.ts';
import { buildBattleCard } from './core/battle-card.ts';
import { createTutorialMatch } from './core/tutorial.ts';

import { holdOf } from './core/carry.ts';
import { coversTile, skillsOf } from './core/query.ts';
import { isProducer } from './core/produce.ts';
import { activeExpansions, expansionById } from './core/expansions.ts';
import type { BoardView } from './core/expansions.ts';
// 只取"这一方是不是 AI / 难度叫什么"这几个判断——它们要用来画首屏。
// 真正的引擎（走子推演，35KB）见下面的 aiEngine()，等到 AI 真的要走才拉。
import { DEFAULT_BUDGET, aiNameOf, anyAiSide, isAiSide } from './core/ai-meta.ts';
import type { AiBudget } from './core/ai-meta.ts';
import { CITY, CONFIG, ORDER_IDLE, ORDER_UPGRADE, passable } from './core/config.ts';
import { onlyVisibleCells, playerView, viewOnBoard } from './core/fog.ts';
import { newHeatCells, visibleHeat } from './core/heat.ts';
import type { PlayerView } from './core/fog.ts';
import {
  applyAction,
  mergeDraftStep,
  aliveSeats,
  attackableTargets,
  buildSiteError,
  canAttack,
  canMove,
  canStandAt,
  cityAt,
  citiesOf,
  cityName,
  distBetweenUnits,
  distToUnit,
  disbandRefundOf,
  eggSpots,
  heroBlocked,
  heroSkillsOf,
  idx,
  incomeOf,
  isAirborne,
  orderDirectiveOf,
  ordersOf,
  orderSitesOf,
  planBothReady,
  reachableTiles,
  recruitPriceOf,
  recruitSpawnCells,
  refreshMemory,
  siegeTargets,
  terrainWalkable,
  threatTiles,
  unitYieldAt,
  unitsAt,
  unitsOf,
  upgradeCostOf,
  utype,
} from './core/rules.ts';
import {
  clearUnits,
  deleteUnitsInRect,
  fillUnitsInRect,
  paintRect,
  paintTerrain,
  placeCity,
  placeUnit,
  rectH,
  rectOf,
  rectW,
  removeAt,
  sandboxCityProblem,
  translateUnitsInRect,
  unitsInRect,
} from './core/sandbox.ts';
import type { Rect, SandboxResult } from './core/sandbox.ts';
import { loadCustomUnits } from './core/customUnits.ts';
import { createMatch, DEFAULT_CONFIG, DEFAULT_PLAYER_NAMES, normalizePlayerNames, randomSeed } from './core/setup.ts';
import type { ResourceCost } from './core/resources.ts';
import { seatsOf } from './core/types.ts';
import type { Action, BoardId, GameState, OrderDirective, PlayerId, Terrain, Unit } from './core/types.ts';
import { lineBetween } from './core/grid-line.ts';
import { cellAtPoint, coordsFromEvent, renderBoard } from './ui/board.ts';
import type { BoardUi } from './ui/board.ts';
import { boardIdOf, boardIds, boardKindOf, boardName, boardOf, boardState, EARTH, hasBoard } from './core/board.ts';
import { createMoonBoard } from './core/space/moon.ts';
import {
  aiDraftBan,
  aiDraftPick,
  draftMsOf,
  draftInProgress,
  draftPhaseLabel,
  draftSecondsLeft,
  draftView,
} from './core/draft.ts';
import { draftScreenHtml, paintDraftTimer } from './ui/draft-panel.ts';
import { bindChatComposer } from './ui/chat-input.ts';
import { renderPanel, invalidatePanel, topbarShell, updateTopbar, setWatchCount, TERRAIN_NAMES, detailCardHtml } from './ui/panel.ts';
import type { PanelInput, PanelReport } from './ui/panel.ts';
import { buildMatchReport, reportFileName, reportJson, reportSignature } from './core/report.ts';
import type { LoggedAction, MatchReport } from './core/report.ts';
import {
  newTimeline,
  noteAction,
  noteDeaths,
  sampleTurn,
  sealTimeline,
  timelineSummary,
  type MatchTimeline,
} from './core/timeline.ts';
import { uploadReport } from './net/reports.ts';
import { godBarHtml, godShelfHtml } from './ui/god-panel.ts';
import type { GodBrush } from './ui/god-panel.ts';
import { openMapUpload } from './ui/map-upload.ts';
import { chimeLabel, loadChimeVolume, playChime, saveChimeVolume } from './ui/sound.ts';
import { openSetupPanel } from './ui/setup-panel.ts';
import { openTitle } from './ui/title-screen.ts';
import { buildReplayFromText } from './core/replay-file.ts';
import type { ReplaySession } from './core/replay-file.ts';
import { replayBarHtml, syncReplayBar, type ReplayUi } from './ui/replay-bar.ts';
import { BUILD_VERSION } from './core/build-info.ts';
import { openOnlinePanel } from './ui/online-panel.ts';
import { manualBooks, openManualChooser } from './ui/books.ts';
import { openUnitEditor } from './ui/unit-editor.ts';
import { openFeedbackPanel } from './ui/feedback.ts';
import {
  adoptDecision,
  claimSeat,
  fetchRoom,
  loadSeat,
  newToken,
  normalizeCode,
  originMismatch,
  saveSeat,
  submitDraft,
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
  suspendSaves,
} from './storage/save.ts';
import {
  CHAT_MAX_LEN,
  ChatFeed,
  chatBodyLength,
  chatBodyOverflows,
  chatLinesHtml,
  shouldAutoExpand,
  fetchChat,
  sendChat,
  trimChatBody,
  type ChatSeat,
} from './net/chat.ts';
import {
  PRESENCE_BEAT_MS,
  countWatchers,
  fetchPresence,
  heartbeat,
} from './net/presence.ts';
import { SKILL_PREVIEWERS, SKILL_TARGET_CELLS } from './core/skill-hooks.ts';
import { skillTargetPicked } from './ui/skill-aim.ts';
import { applyUiTheme, installUiConsole, setUiMode, setUiMotion } from './ui/theme.ts';
import { initUnitArt, loadUnitArtIndex, setUiArt, uiArtOn } from './ui/unit-art.ts';
import { initTerrainArt, setUiTerrain, uiTerrainOn } from './ui/terrain-art.ts';
import { settingsHtml } from './ui/settings.ts';
import { MODULES, deviceTargetOf } from './core/armor.ts';

/*
 * 主题要在**任何渲染之前**落地。
 *
 * `applyUiTheme` 只改 `<html data-ui>` / `data-motion>` 两个属性，不碰任何规则；
 * 但必须抢在第一帧之前——放在模块末尾（我第一版就放那儿了）会先按 legacy 画一帧
 * 再跳成 modern，那一闪比不换主题还难受。所以放在 import 之后、所有初始化之前。
 *
 * 切换入口（暂不进设置页）：
 *   · 地址栏 `?ui=modern`（对比用，优先级最高）；
 *   · 控制台 `__ui('modern')` / `__ui('legacy')`（会记住偏好）。
 */
applyUiTheme();
installUiConsole();
/*
 * 兵种贴图：默认关，只把 `<html data-art>` 定下来。
 * 真的打开时才去拉清单——关着的时候一个字节都不多请求。
 */
initUnitArt();
initTerrainArt();


/**
 * 非空时表示某个英雄正在等玩家选技能目标。
 *
 * `targeting` 必须一起记下来：方向型技能只有四邻可以点，选点型（传送阵）
 * 则是全图任意格。以前这里只存 unitId/skillId，所有技能都按"四邻热区"处理，
 * 于是「挪移」只能往身边一格挪——技能数据里的 `targeting: 'point'` 白写了。
 */
let pendingSkill:
  | { unitId: string; skillId: string; targeting: 'point' | 'direction' }
  | null = null;

/**
 * 上一次悬停预览过的落点（"x,y"）。只在全图选点时用：同一格里反复 mousemove
 * 不必重算一遍预览，棋盘也不用跟着重绘。
 */
let skillAimKey = '';

/**
 * 非空时表示某台装甲正在等玩家给设备选落点（弹射钩索）。
 *
 * 和 `pendingSkill` 是同一个套路，但不合并：技能有冷却/连发这一整套要处理，
 * 设备只有"选一格"。合成一个字段之后，"取消"该退回哪一层就说不清了。
 */
let pendingDevice: { unitId: string; deviceId: string } | null = null;

/**
 * 邀请链接：在当前地址上加 `?room=CODE`。
 *
 * 必须在**当前地址**上加，不能拼一个干净的 origin+path：分享出来的站点靠
 * `?sharecode=…` 才放行，把它丢了对方点开就是 403。
 */
function inviteLink(code: string): string {
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  return url.toString();
}

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
    <div class="replay-bar" id="replay" hidden></div>
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
        <div class="board-list" id="board-list"></div>
      </div>
      <aside class="side" id="side"></aside>
    </div>
    <div class="draft-mask" id="draft" hidden></div>
  </div>
`;

const boardEl = pick<HTMLElement>(appEl, '#board');
const draftEl = pick<HTMLElement>(appEl, '#draft');
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
/** 左下角的地图列表：收起时只显示当前图，点开列出所有图 */
const boardListEl = pick<HTMLElement>(appEl, '#board-list');
/**
 * 强制模式的横幅。
 *
 * 这个模式会**接管整个棋盘的点击**（每一格只有"走过去 / 开火"一种解释），
 * 所以它必须一直看得见。按钮在侧栏里，玩家滚到战报那一段就把它忘了，
 * 之后在棋盘上点什么都没反应——第一反应只会是"卡住了"。
 */
const forceFlagEl = pick<HTMLElement>(appEl, '#force-flag');
const sideEl = pick<HTMLElement>(appEl, '#side');

/*
 * 侧栏两张折叠卡（「操作」「战报」）的开合状态记录点。
 *
 * `<details>` 的 `toggle` 事件**不冒泡**，所以只能用捕获阶段挂在容器上。
 * 面板每次重建都会按这个标记重新加 `open`，收起/展开才不会一刷新就弹回去。
 */
sideEl.addEventListener(
  'toggle',
  (e) => {
    const el = e.target as HTMLElement | null;
    if (!el || !el.classList.contains('card-fold')) return;
    const open = (el as HTMLDetailsElement).open;
    // 用 data-fold 区分是哪一张：以后再加折叠卡只要加一个分支，不用改写这一处
    if (el.dataset.fold === 'log') logOpen = open;
    else opsOpen = open;
  },
  true,
);
const topbarEl = pick<HTMLElement>(appEl, '#topbar');
const commanderEl = pick<HTMLElement>(appEl, '#commander');
const replayEl = pick<HTMLElement>(appEl, '#replay');

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

/**
 * 本机有没有**真的打过**的一局。
 *
 * 不能直接拿 `loadMatch() !== null` 现查：启动流程末尾无条件 `saveMatch()`
 * （新建的那局当场就落盘），于是第一次来的人也会看到亮着的「继续上一局」——
 * 点了接着打的其实是一张谁都没动过的随机棋盘。
 *
 * 所以开机那一刻先量一次（这时 boot 的自动存档还没发生），之后开一局、
 * 导入一局、进房间接手一局，都把它置 true。
 */
let hasRealSave = loadMatch() !== null;
let state: GameState = loadMatch() ?? createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());

/*
 * 棋盘视图的开关：悬停看一眼，点一下钉住。
 *
 * **只活在这一层**，绝不进 `GameState`——进去了就会跟着存档、回放、联机快照
 * 一起走，然后出现"读档之后灵气视图还开着"这种既不必要也解释不清的状态。
 *
 * `hover` 优先于 `pinned`：鼠标停在别的 chip 上时先看那个，移开再回到钉住的。
 */
let boardViewHover: string | null = null;
let boardViewPinned: string | null = null;

/** 现在该画哪个视图（都没有就是 null） */
function activeBoardViewId(): string | null {
  return boardViewHover ?? boardViewPinned;
}

/** 这一局所有扩展声明的棋盘视图。每帧都会调，别在里面做重活 */
function boardViewsOf(): BoardView[] {
  const out: BoardView[] = [];
  for (const e of activeExpansions(state)) {
    if (!e.hooks.boardViews) continue;
    out.push(...e.hooks.boardViews({ state }));
  }
  return out;
}

/**
 * 顶栏上的视图 chip。
 *
 * 和顶栏骨架那条注释同一个理由：**绝不在每帧重建按钮节点**——
 * mousedown 和 mouseup 落在不同节点上，click 就直接丢了（AI 托管时最明显）。
 * 所以只在"数量变了"的时候重建一次，之后只改 class。
 */
function syncBoardViewChips(views: BoardView[]): void {
  const box = topbarEl.querySelector<HTMLElement>('[data-ref="board-views"]');
  if (!box) return;

  if (box.dataset.count !== String(views.length)) {
    box.dataset.count = String(views.length);
    const esc = (t: string) =>
      t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    box.innerHTML = views
      .map(
        (v) =>
          `<button class="view-chip" data-act="board-view" data-id="${esc(v.id)}" ` +
          `title="${esc(v.hint)}">${esc(v.label)}</button>`,
      )
      .join('');
  }

  const active = activeBoardViewId();
  for (const el of box.querySelectorAll<HTMLElement>('.view-chip')) {
    const id = el.dataset.id ?? '';
    el.classList.toggle('on', id === active);
    el.classList.toggle('pinned', id === boardViewPinned);
  }
}

/**
 * 顶栏的常驻徽章（季节这类"整局的一个状态"）。
 *
 * 和 `syncBoardViewChips` 同一套做法：只在内容签名变了时才写 DOM。
 * 以前季节是 `TopbarState.season` 一个具名字段 + 一个 `data-ref="season"`，
 * 那是核心为「季节与气候」这个词专门开的口子——现在它只是"某个扩展的一枚徽章"。
 */
function syncTopbarBadges(): void {
  const box = topbarEl.querySelector<HTMLElement>('[data-ref="topbar-badges"]');
  if (!box) return;
  const badges: Array<{ id: string; text: string; hint: string }> = [];
  for (const e of activeExpansions(state)) {
    if (!e.hooks.topbarBadges) continue;
    badges.push(...e.hooks.topbarBadges({ state }));
  }
  const sig = badges.map((b) => `${b.id}:${b.text}:${b.hint}`).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const esc = (t: string) =>
    t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  box.innerHTML = badges
    .map((b) => `<span class="topbar-badge" title="${esc(b.hint)}">${esc(b.text)}</span>`)
    .join('');
}

/*
 * 浓雾下点黑格：**不拦，交给面板说"未探明"**。
 *
 * 2026-11-10 之前这里有一对 `blackedOutAt` / `refuseLook`：浓雾里点视野外的格子
 * 直接 toast 一句「看不清」就吞掉这次点击。同日另一条线（Liuks）把遮蔽做到了
 * 面板层——`PlayerView.terrainHidden` + 「未探明」/「记忆里的地形（可能有变）」，
 * 活数据（灵气浓度、脚下天气）只在看得见时才算。
 *
 * 两套叠在一起的结果是：面板那套在浓雾里永远走不到，玩家只能得到一句提示。
 * 所以按"留面板、不留硬拦"收口：点得开，但念不出东西——这比"点不动"信息量更大，
 * 也让普通雾与浓雾共用一条判断（`terrainHidden`）。
 *
 * 视图染色那条闸门（`onlyVisibleCells`）仍然在：它管的是"别把天气画到黑区"，
 * 和点击是两回事。
 */

/**
 * 这一帧要染的格子（格索引 → 颜色）。没有激活的视图就返回 undefined。
 *
 * `visible` 是这一帧的视野：视图染色必须过一遍 `onlyVisibleCells`。
 * 天气、灵气这些场都是**按全图算的**（存在各自的 `Tile.custom` 里），
 * 不裁的话，看视图就等于开了一张全图透视——对面城市在哪、附近是山是林，
 * 一眼就能读出来。遮蔽放在核心而不是各个扩展里，是为了只有一个地方能漏。
 */
function computeBoardView(visible: readonly number[]): Map<number, string> | undefined {
  const id = activeBoardViewId();
  if (!id) return undefined;
  const def = boardViewsOf().find((v) => v.id === id);
  const cells = def?.cells?.({ state, viewer: me() });
  if (!cells || cells.length === 0) return undefined;

  const out = new Map<number, string>();
  for (const c of onlyVisibleCells(state, visible, cells)) out.set(c.y * state.w + c.x, c.color);
  return out;
}

/**
 * 视图层上的字符（风向箭头）。和染色同一条可见性闸门：
 * 雾外的箭头同样不许出现——它泄露的信息（哪边风大）和颜色一样多。
 */
function computeBoardGlyph(visible: readonly number[]): Map<number, string> | undefined {
  const id = activeBoardViewId();
  if (!id) return undefined;
  const def = boardViewsOf().find((v) => v.id === id);
  const glyphs = def?.glyph?.({ state, viewer: me() });
  if (!glyphs || glyphs.length === 0) return undefined;
  const out = new Map<number, string>();
  for (const g of onlyVisibleCells(state, visible, glyphs)) out.set(g.y * state.w + g.x, g.text);
  return out;
}
let selectedId: string | null = null;

// ---------- 复盘 ----------

/**
 * 正在看的复盘（null = 没在看）。
 *
 * 复盘的做法是**把 `state` 换掉**，而不是另养一套渲染管线：棋盘、属性卡、地形提示
 * 全都读 `state`，换掉它之后这些一次都不用改。代价是必须在几个地方把闸门关上——
 * 见 `dispatch` / `onBoardClick` / `saveMatch` 的暂停。三处，不多不少。
 */
let replay: ReplaySession | null = null;
/** 现在停在第几步（0 = 开局） */
let replayIndex = 0;
let replayPlaying = false;
/** 播放倍速：1 / 2 / 4 */
let replaySpeed = 1;
let replayName = '';
/** 播放定时器。用 setTimeout 链而不是 setInterval：每步的重绘时长不一样，定长会越拖越后 */
let replayTimer: ReturnType<typeof setTimeout> | null = null;
/** 进复盘之前那一局。退出时必须原样还回去 */
let liveState: GameState | null = null;
/** 复盘里每步的重绘最小间隔（毫秒），按倍速折算 */
const REPLAY_STEP_MS = 260;
/**
 * 玩家正在拖进度条。
 *
 * 拖动期间**不许写回 slider.value**：手指按住的时候把它改成一个和手指不一样的值，
 * 滑块会当场跳回去。这是浏览器在跟输入打架，不是样式问题。
 */
let replaySeeking = false;

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
/**
 * 这一局的"打完了"提示放过没有。
 *
 * 放在 render 里做，是因为分出胜负有**八条路**（攻城、认输、城被打光、
 * 联机对面提交、AI 走完、指挥官批次收尾……）。在这些地方各写一句 toast
 * 一定会漏掉其中几条，而且漏掉的那条恰好最需要提示。render 是唯一都经过的地方。
 */
let settledNotified = false;
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
 * 产兵列表按时代筛选：0 = 全部，其它是时代等级。
 *
 * 和 recruitPack 同一套：空值＝不筛，两个维度是"与"。同样**不随换城清空**——
 * "我只想看青铜的兵"是这一局的口味，不是对某座城的一时好奇。
 */
let recruitEra = 0;

/**
 * 打击感的两个来源：**掉血的单位**与**刚出手的单位**。
 *
 * 掉血不能靠"渲染时和上一帧比"来推——渲染会因为顶栏、横幅、悔棋、
 * 联机拉取、AI 连走被跳过或重放，那个比对会把旧伤当新伤，
 * 表现为"打了一个兵，旁边几个老伤号一起演了一遍掉血"。
 *
 * 所以改成**动作前后对账**：`dispatch` / AI 每落地一个动作，就在
 * `noteHpDrops` 里把"这一下真少了血的单位"记进 `pendingDrops`，
 * 绘制时取走并清空。一次动作只可能标记它真正伤到的那几个。
 *
 * 出手那一侧算不出来（它自己没掉血），所以由 dispatch 记一笔，绘制时消费一次。
 */
const pendingDrops = new Map<string, number>();
let lastStrikerId: string | null = null;

/**
 * 对账：`after` 里哪些单位比 `before` 少血，以及少之前占最大生命的比例。
 *
 * 三条保守约定：
 *   · 换型的（晋升/孵卵/聚合）不算掉血——maxHp 变了，比例不可比；
 *   · 只见于一边的（新兵出生、阵亡）不算，它们没有"之前"；
 *   · 比例差小于 0.1% 的忽略，避免浮点噪声把满血单位也标记成受击。
 */
function noteHpDrops(before: GameState, after: GameState): void {
  const prev = new Map<string, { type: string; ratio: number }>();
  for (const u of before.units) {
    const def = before.unitTypes[u.type];
    if (!def || def.maxHp <= 0) continue;
    prev.set(u.id, { type: u.type, ratio: u.hp / def.maxHp });
  }
  for (const u of after.units) {
    const was = prev.get(u.id);
    if (!was || was.type !== u.type) continue;
    const def = after.unitTypes[u.type];
    if (!def || def.maxHp <= 0) continue;
    const now = u.hp / def.maxHp;
    if (now < was.ratio - 0.001) pendingDrops.set(u.id, was.ratio);
  }
}

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

/**
 * 动作序列：和 `recorder` 同生共死（同一份"要不要记详细数据"的选择）。
 *
 * 为什么单独存而不塞进 timeline：timeline 是**统计量**（每回合采样、逐兵种计数），
 * 动作序列是**过程**。两者的采样节奏、体积、消费者都不一样——
 * 混在一起会让"只想看曲线"的分析被几十 KB 的动作对象拖累。
 *
 * 上限 1500 步：一局通常 400~1000 步；超了就从尾部截断并计数（`actionsDropped`），
 * 让"这份日志不全"这件事在报告里自己说出来，而不是重放时对不上再让人去猜。
 */
let actionLog: LoggedAction[] | null = null;
let actionDropped = 0;
let actionBytes = 0;
/** 步数上限 */
const ACTION_LOG_CAP = 1500;
/**
 * 字节上限（估算，按紧凑 JSON 计）。
 *
 * 数据库那边有条硬约束 `pg_column_size(payload) < 256 KB`。实测一局 1176 步的
 * 报告缩进后有 232 KB 文本——虽然 jsonb 落盘会压缩、实际远低于上限，但这条线
 * **不能靠"应该压得下"来赌**：一局打满 1500 步就会贴边。
 *
 * 120 KB 是留了一半余量的位置：超过就停止追加并计数（`actionsDropped`），
 * 让"这份日志被截断了"写在报告里，而不是等重放到一半对不上再去猜。
 */
const ACTION_LOG_BYTES = 120_000;

/** 按当前对局的配置决定要不要记；换局 / 读档之后调一次 */
function resetRecorder(): void {
  const wantDetail = state.config.recordDetail === true && state.config.godMode !== true;
  recorder = wantDetail ? newTimeline(state.turn) : null;
  actionLog = wantDetail ? [] : null;
  actionDropped = 0;
  actionBytes = 0;
  if (recorder) {
    // 先把"开局有哪些单位"记下来，后面才能靠差分认出谁死了
    noteDeaths(recorder, state);
    // 再落一帧基线。没有它的话，"第 1 回合就结束"的局会交上一份 0 帧摘要
    // （2026-10-28 实测：一局认输，上传上来的 timeline 里 samples 是空的）。
    sampleTurn(state, recorder, true);
  }
}

/** 记一步（AI 和玩家都走这里） */
function noteStep(actor: PlayerId, action: Action): void {
  if (actionLog) {
    if (actionLog.length < ACTION_LOG_CAP && actionBytes < ACTION_LOG_BYTES) {
      // 带上行动方（2026-11-11）：END_TURN 归谁光看动作推不准，
      // 而"人这一步怎么想的"恰恰要靠它把人类的决策单独拎出来
      const step = { ...action, by: actor } as LoggedAction;
      actionLog.push(step);
      // 粗算就够：这里的用途只是"别撞上限"，不需要精确
      actionBytes += JSON.stringify(step).length + 1;
    } else {
      actionDropped += 1;
    }
  }
  if (!recorder) return;
  noteAction(recorder, actor, action);
  // 死亡是在这一步里发生的，所以每次动作后都要比一次单位集合
  noteDeaths(recorder, state, action);
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
/** 非空时表示技能正在选方向，里面是四周四个格子的坐标 */
let aimTiles: number[] = [];
/** 技能波及范围格子 */
let skillThreatTiles: number[] = [];
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
  // 别的图不画拐弯路径：`pathCells` 是按地球宽度写死的。直线滑过去就够用了，
  // 真要为月球画逐格路径，等它有了障碍和地形再说。
  if (boardIdOf(u) !== EARTH) {
    pendingMovePath = null;
    return;
  }
  pendingMovePath = new Map([
    [u.id, pathCells(before, { x: u.x, y: u.y }, { x: action.x, y: action.y }, u.type)],
  ]);
}

/**
 * 从起点到终点的一条路（四连通 BFS，只绕不可走地形）。
 *
 * 这是**画动画用的**，不是规则：它不看移动力、不看单位阻挡，所以不能拿去
 * 判断"这一步合不合法"。规则层算出来的可达格是另一套（reachableTiles）。
 *
 * `typeId` 是走路那个兵种，用来决定"什么算不可走"：
 * 以前这里一律按陆军判（`passable`），于是船沿岸线绕行时画出来的路
 * 一步都过不了水，只能退化成一跳一跳到终点——看着像"寻路被水挡住了"。
 * 飞行单位同理：它能掠水，路径就该跨过水面画出来。
 */
function pathCells(
  s: GameState,
  from: { x: number; y: number },
  to: { x: number; y: number },
  typeId?: string,
): Array<{ x: number; y: number }> {
  const def = typeId ? utype(s, typeId) : null;
  const walkable = (t: Terrain): boolean => (def ? terrainWalkable(def, t) : passable(t));
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
      if (!tile || !walkable(tile.terrain)) continue;
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
/**
 * 观战人数的心跳与轮询。
 *
 * 和房间轮询分开：房间 15 秒一次是"看有没有新棋"，人数 12 秒一次是"我还在这儿"。
 * 两者节奏不同、失败也互不影响——心跳挂了不该让棋局同步变慢，反之亦然。
 */
let presenceTimer = 0;
/** 最近一次拉到的观战人数。顶栏重画之后要靠它把数字补回去 */
let watchCount = 0;

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
  // 热座：一台机器几个人轮流玩，谁都别装看不见
  if (!room && !anyAiSide(state)) return null;
  return me();
}

/** 取当前房间。用函数包一层是为了绕开模块级变量的控制流收窄 */
function currentRoom(): RoomSeat | null {
  return room;
}

/** 联机时轮到我操作吗（本机对局恒为 true） */
function myTurn(): boolean {
  /*
   * 复盘里没有"我的回合"。
   *
   * 这条读起来像废话，但它是好几处判断的源头：交接遮罩、「结束行动」按钮、
   * 键盘快捷键、选中单位的动作按钮都挂在它上面。复盘期间 `state` 是别人那一局的
   * 某一帧，`state.current` 恰好是 A 的时候，这一串全会亮起来——看起来能走子，
   * 点下去被闸门挡住，这正是"棋局和界面各说各话"的来源。
   */
  if (replay) return false;
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
 *
 * `known` 是调用方手上已经算好的雾视图。render() 里刚算过一份，
 * 这里再算一遍纯属白烧——`playerView` 每帧 1.4ms，32×32 上占单帧的 7%。
 * 单独重画面板的那条路没有，就现算。
 */
/**
 * 侧栏折叠卡是否展开（「操作」「战报」各一个）。
 *
 * 面板是**整块重建**的（每回合、每次金币变动都会重写 innerHTML），`<details>`
 * 的 open 状态一重建就没了。所以状态存在这里，渲染时带上去；`<details>` 的
 * toggle 不冒泡，监听挂在 sideEl 上用捕获。
 */
let opsOpen = false;
let logOpen = false;

function panelInput(known?: PlayerView): PanelInput {
  const view = known ?? playerView(state, me(), spectating());
  const picked = selectedId ? (view.state.units.find((u) => u.id === selectedId) ?? null) : null;
  return {
    view,
    me: me(),
    // 注意用 view.state 而不是 state：面板同样不该看到视野外的东西
    selectedUnit: picked,
    selectedCityId,
    selectedCampId,
    selectedTile,
    opsOpen,
    logOpen,
    // 联机同样能撤：提交（结束回合）会把栈清空，所以「还能撤」本身就等于「还没提交」
    canUndo: undoStack.length > 0,
    chimeVolume,
    recruitQuery,
    recruitPack,
    recruitEra,
    logSide: logScope(),
    spawnPick: spawnPlan ? { type: spawnPlan.type } : null,
    /*
     * 复盘时侧栏必须按"别人的棋"渲染。
     *
     * 原来只传 `watching()`（联机观战位），于是复盘里面板认为你就是甲方：
     * 顶上一句「轮到你行动」，城里有「生产」按钮，选中单位还有强制移动 / 拆除 / 结束回合——
     * 全都是死的（dispatch 那道闸会拦），但看上去每一颗都能点。
     * 面板本身早就有"只读"这一档（`readOnly`），缺的只是把复盘也算进去。
     */
    spectator: watching() || replay !== null,
    replay: replay !== null,
    // 指挥官模式也走"只看"这条线：mine 关掉，但提示文案不一样。
    // 复盘里哪怕这一局是 commanders 局，也不该出现"执行一批"的入口。
    commander: replay === null && state.config.commanderMode === true,
    // 底栏那颗按钮在指挥官模式里是"执行一批再交还"的入口，得知道这批打几个回合
    commanderRunning,
    commanderRounds: room ? 1 : CONFIG.commanderSlots,
    // 热座：底栏那颗按钮变成「提交作战计划」，两边都交完才开推
    planHotseat: commanderHotseat(),
    planReady: state.orderReady?.[me()] === true,
    forceMode,
    report: reportPanel(),
    /*
     * 战报卡只排一种情况：复盘。
     *
     * 复盘里 `me()` 是"看棋的人"的席位，拖进来的那局跟你没关系，
     * 生成的卡会把别人那局标成"胜利"——和结算卡替人签同意书是同一类错。
     * 上帝模式、双 AI 观战**给**：前者是自家最常用的模式，
     * 后者打完一局正好发群里。
     */
    battleCard: state.winner !== null && replay === null,
  };
}

/**
 * 当前对局的报告。
 *
 * 面板上的指纹和真正上传的那一份必须是同一个东西，所以在这里统一密封
 * （sealTimeline 会去掉内部用来做差分的单位表）。两处各建一次很容易漂。
 */
function currentReport(): MatchReport {
  return buildMatchReport(state, new Date(), recorder ? sealTimeline(recorder) : null, actionLog, actionDropped);
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
  /*
   * 复盘里不给结算卡。
   *
   * 拖进来的那份报告**自己就有** `winner`，于是复盘一跳到终局帧，这块卡片就冒出来：
   * "这局的数据要不要捐出来"。按下去传的是别人那局（`currentReport()` 读的是 `state`）——
   * 等于替一个不知情的人签了同意书。这一条和观战位是同一条理由。
   */
  if (!state.winner || state.config.godMode === true || watching() || replay) return undefined;
  const sig = reportSignature(currentReport());
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


// ---------- 复盘 ----------

/** 复盘条要的全部数据。每次重绘现算：都是标量，比维护一份副本便宜 */
function replayUiOf(): ReplayUi {
  const s = replay!;
  const m = s.meta;
  const parts = [`${m.size}×${m.size}`, `${m.players} 人`, m.expansionsText, `种子 ${m.seed}`];
  if (m.build) parts.push(`v${m.build}`);
  const winner = state.winner ? state.players[state.winner].name : null;
  return {
    name: replayName,
    index: replayIndex,
    total: s.applied,
    turn: state.turn,
    current: state.players[state.current].name,
    winner,
    playing: replayPlaying,
    speed: replaySpeed,
    metaLine: parts.join(' · '),
    exact: m.exact,
    warnings: s.warnings,
  };
}

/**
 * 进入复盘。
 *
 * 只有在**没有联机房**的时候才允许：联机时 `state` 会被对端的提交覆盖
 * （`applyRoom`），复盘到一半被人顶掉，看到的就是两份棋搅在一起。
 */
function enterReplay(text: string, name: string): boolean {
  if (room) {
    toast('复盘要在本机看：先从联机房间里退出来');
    return false;
  }
  const built = buildReplayFromText(text);
  if (!built.ok) {
    toast(built.reason);
    return false;
  }
  // 已经在复盘里又拖进来一份：只换这一份，别把 liveState 覆盖成上一份复盘的状态
  if (!replay) liveState = state;
  /*
   * 先把还在跑的 AI / 参谋部按停，再换 `state`。
   *
   * 两条循环（`runAiTurn` 与 `runCommanderBatch`）都盯着 `aiToken`，改它等于
   * 让它们在下一个检查点退出。不按停的话：`enterReplay` 把 `state` 换成别人那一局，
   * 而 AI 循环手里攥着它自己的 `player` 与 `token`，会接着在**回放**上下子——
   * 表现就是"拖到自己那一帧，过一会儿棋又变了"，而且明显和侧栏/回合数对不上。
   *
   * `aiPaused` 也要置上：退出复盘时 `kickAiIfNeeded()` 会把它清掉并重新点起来。
   */
  aiToken += 1;
  aiPaused = true;
  // 热座交接遮罩：拖文件进来的时候它可能正盖在屏幕上（那层也是 window 级拖放能触发的）
  closeHandoff();
  replayStopTimer();
  replay = built.session;
  replayName = name;
  replayIndex = 0;
  replayPlaying = false;
  replaySpeed = 1;
  // 存档必须停：main.ts 里二十多个地方会顺手 saveMatch(state)，
  // 不拦的话"看一次别人的复盘"= 把自己没打完那局覆盖掉
  suspendSaves(true);
  state = replay.stateAt(0);
  clearSelection();
  // 外壳先建一次，之后每帧只改数字
  replayEl.innerHTML = replayBarHtml(replayUiOf());
  replayEl.hidden = false;
  render();
  if (built.session.stopReason) toast(`复盘只能走到第 ${built.session.applied} 步，原因见上方提示`);
  return true;
}

/** 退出复盘：把进之前那一局原样还回去 */
function exitReplay(): void {
  if (!replay) return;
  replayStopTimer();
  replay = null;
  replayPlaying = false;
  replayIndex = 0;
  replayName = '';
  replayEl.hidden = true;
  replayEl.innerHTML = '';
  suspendSaves(false);
  // 原来那局可能在复盘期间被别处清掉了（换局、清存档）。真没了就开一局新的——
  // 崩在这里比丢一局更糟。
  state = liveState ?? loadMatch() ?? createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
  liveState = null;
  resetZoom();
  clearSelection();
  render();
  kickAiIfNeeded();
}

/** 跳到第 index 步（会被夹到 [0, 真的走到的那一步]） */
function replayGoto(index: number): void {
  if (!replay) return;
  const target = Math.max(0, Math.min(replay.applied, Math.round(index)));
  if (target === replayIndex) return;
  replayIndex = target;
  state = replay.stateAt(target);
  render();
}

/** 复盘条上的按钮。和 `handleAction` 分开，是因为它不碰对局规则 */
function handleReplayAction(act: string, el: HTMLElement): void {
  if (!replay) return;
  switch (act) {
    case 'rp-first':
      replayStopTimer();
      replayPlaying = false;
      replayGoto(0);
      return;
    case 'rp-prev':
      replayStepBy(-1);
      return;
    case 'rp-next':
      replayStepBy(1);
      return;
    case 'rp-last':
      replayStopTimer();
      replayPlaying = false;
      replayGoto(replay.applied);
      return;
    case 'rp-toggle':
      replayTogglePlay();
      return;
    case 'rp-speed': {
      const n = Number(el.dataset.speed);
      replaySpeed = n === 2 || n === 4 ? n : 1;
      // 正在放就按新倍速重排下一帧，别等这一帧睡完
      if (replayPlaying) {
        replayStopTimer();
        replayTimer = setTimeout(replayTick, Math.round(REPLAY_STEP_MS / replaySpeed));
      }
      render();
      return;
    }
    case 'rp-exit':
      exitReplay();
      return;
  }
}

function replayStepBy(delta: number): void {
  if (!replay) return;
  replayStopTimer();
  replayPlaying = false;
  replayGoto(replayIndex + delta);
}

function replayStopTimer(): void {
  if (replayTimer !== null) {
    clearTimeout(replayTimer);
    replayTimer = null;
  }
}

/**
 * 播放。
 *
 * 用 setTimeout 链而不是 setInterval：每步的重绘耗时不一样（残局兵多就慢），
 * 定长间隔会在慢帧上堆积，最后变成"越放越快、还夹着卡顿"。
 */
function replayTick(): void {
  replayTimer = null;
  if (!replay || !replayPlaying) return;
  if (replayIndex >= replay.applied) {
    replayPlaying = false;
    render();
    return;
  }
  replayIndex += 1;
  state = replay.stateAt(replayIndex);
  render();
  replayTimer = setTimeout(replayTick, Math.max(16, Math.round(REPLAY_STEP_MS / replaySpeed)));
}

function replayTogglePlay(): void {
  if (!replay) return;
  if (replayPlaying) {
    replayPlaying = false;
    replayStopTimer();
    render();
    return;
  }
  // 已经放到尾巴了：再按一次当"从头放"，不然按钮点了没反应
  if (replayIndex >= replay.applied) {
    replayIndex = 0;
    state = replay.stateAt(0);
  }
  replayPlaying = true;
  render();
  replayTimer = setTimeout(replayTick, Math.round(REPLAY_STEP_MS / replaySpeed));
}

/** 读文件 → 复盘。文件读失败和"不是对局报告"要分开说 */
async function importReplayFile(file: File): Promise<void> {
  let text = '';
  try {
    text = typeof file.text === 'function' ? await file.text() : await readAsText(file);
  } catch {
    toast('这个文件读不出来（不是文本，或者被占用）');
    return;
  }
  enterReplay(text, file.name || '未命名.json');
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsText(file);
  });
}

/** 选文件。首页的「复盘」和拖放走同一条路 */
function pickReplayFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void importReplayFile(file);
  });
  input.click();
}

/** 教程这一步要圈的格子 / 要框的城（转成棋盘渲染认识的两个字段） */
function tutorialMarksOf(): {
  tutorialTiles: number[];
  tutorialCityId: string | null;
  tutorialOwnCityId: string | null;
} {
  const m = tutorial.tutorialMarks(state);
  return { tutorialTiles: m.tiles, tutorialCityId: m.cityId, tutorialOwnCityId: m.ownCityId };
}

/**
 * 贴图清单是异步的：**第一帧一定还没有它**。
 *
 * 所以不能在启动时拉一次就完事——那一刻还没有渲染入口，拉到了也没人重画，
 * 结果就是"打开了开关、棋盘照旧全是汉字"，看着像开关失效。
 * 放在 render 里惰性触发：清单到货后补画一帧，只补一次。
 */
let artIndexAsked = false;
function ensureArtIndex(): void {
  if (artIndexAsked || !uiArtOn()) return;
  artIndexAsked = true;
  void loadUnitArtIndex().then(() => render());
}

function render(): void {
  ensureArtIndex();
  // 选卡没打完时，棋盘只是一个背景：遮罩在它上面，且不响应点击
  renderDraft();
  // 全图选点模式（传送阵）：整张图都是落点，用十字光标说明"这里能点"。
  // 不逐格染红——`.tile.aim` 是红斜纹，铺满全图就没法看了。
  boardEl.classList.toggle('aim-point', pendingSkill?.targeting === 'point');
  // 顶栏可能被整块重建（换局、导入存档），观战人数不在对局状态里，
  // 重建之后要补写一次；不补的话它会一直空着，直到下一次心跳。
  setWatchCount(watchCount);
  // 顶栏的扩展槽位：常驻徽章（季节）+ 棋盘视图 chip。都没有就整块不占位。
  syncTopbarBadges();
  syncBoardViewChips(boardViewsOf());
  /*
   * 复盘时换一副眼镜：**旁观 + 全信息**。
   *
   * `state` 已经是复盘里那一帧，而迷雾挡的是"当时谁看得见"——复盘要回答的是
   * "整局到底发生了什么"，所以这里直接给全局视野。不这么做还会撞上第二个问题：
   * 迷雾是按 `me()` 算的，而复盘里的双方都不是"我"，怎么算都是在替一方偷看。
   */
  const view = replay ? playerView(state, 'A', true) : playerView(state, me(), spectating());
  // 地图列表的待命数/敌人红点跟着视图走；签名没变就不重建 DOM
  syncBoardList(view);

  const selected = selectedId ? state.units.find((u) => u.id === selectedId) : undefined;
  // 复盘里选中只用来"看这张卡"：可达格与攻击目标一律不画，否则看起来像能操作
  const threat =
    !replay &&
    selected &&
    boardIdOf(selected) === EARTH &&
    selected.owner === state.current &&
    !selected.acted &&
    !pendingSkill
      ? Array.from(threatTiles(state, selected))
      : [];

  // 战况烈度：**上一次敌方回合**里，对方打过的那些格子（含溅射波及），按次数闪烁。
  //
  // 轮到自己就生效，不依赖"选中了谁"；这一回合**出手一次之后就收起**——
  // 它是"上回合的答卷"，看一眼就该让位给可达格与攻击目标。
  const heat = replay
    ? new Map<number, number>()
    : visibleHeat(state, me(), {
        visible: new Set(view.visible),
        dismissed: heatDismissTurn === state.turn,
        active: state.current === me() && !spectating(),
      });

  // 出手闪烁：和上面那层用同一套色块，区别是它只活在动作后的 0.7 秒里。
  // 复盘不闪——那是别人的历史回放，没有"刚刚"可言；雾外不画，和红层同一口径。
  let heatFlashView: Map<number, number> | undefined;
  if (!replay && heatFlash && Date.now() < heatFlash.until) {
    const seenNow = new Set(view.visible);
    const out = new Map<number, number>();
    for (const [i, n] of heatFlash.cells) if (seenNow.has(i)) out.set(i, n);
    if (out.size > 0) heatFlashView = out;
  }

  // 这一帧要抖谁、谁的血条要演残留：**只认上一个动作里真掉血的单位**
  const hpDrops = new Map(pendingDrops);
  pendingDrops.clear();
  const impacts = new Map<string, number>();
  for (const id of hpDrops.keys()) impacts.set(id, 1);
  if (lastStrikerId) {
    // 出手方可能已经死了（反击打死自己）：那就只抖挨打的那一侧
    if (state.units.some((u) => u.id === lastStrikerId)) impacts.set(lastStrikerId, 0.55);
    lastStrikerId = null;
  }

  const boardUi: BoardUi = {
    selectedId,
    reach,
    targets,
    aimTiles,
    skillThreatTiles, 
    siegeTargets: siege,
    selectedCityId,
    placeable: computePlaceable(),
    // 框选：拖动中显示临时矩形，松手后显示提交的那一块
    marqueeTiles: godRectIndices(),
    threat,
    heat,
    // 扩展染的那一层（灵气浓度等）。只在视图打开时有值，且按视野裁过。
    boardView: computeBoardView(view.visible),
    boardGlyph: computeBoardGlyph(view.visible),
    heatFlash: heatFlashView,
    flashSeq: heatFlash?.seq ?? 0,
    movePath: pendingMovePath ?? undefined,
    incomeHints: computeIncomeHints(selected),
    impacts,
    hpDrops,
    // 地上的东西（水雷/地雷）要按"这是谁的视角"分实心/空心
    me: me(),
    /*
     * 新手教程的圈和城里红框。走渲染参数而不是渲染完再贴 class：
     * 棋盘每帧重建、首帧还在 rAF 里，贴上去的那一下经常白贴（城市红框就是这么丢的）。
     */
    ...(tutorial.tutorialOn() ? tutorialMarksOf() : {}),
  };
  /*
   * 画**当前这一张**图。
   *
   * `viewOnBoard` 给渲染层一份"替身视图"：宽高、格子、单位、城市都换成
   * 那张图的那一份（地球也走这条路——不裁的话月球上的兵会画到地球上）。
   * 没有别的图的东西时它原样返回，一个对象都不建。
   * 选中/可达/染色这类"图内坐标"在 boardUiFor 里按图过滤。
   */
  renderBoard(boardEl, viewOnBoard(view, activeBoardId), boardUiFor(boardUi, activeBoardId));

  /*
   * 笔刷在手时，棋盘自己吃掉触摸手势。
   *
   * `.board-scroll` 在放大档是 `touch-action: pan-x pan-y`，手指一划就变成滚地图，
   * pointermove 直接被浏览器掐掉——拖动绘制在触摸设备上会"划一下就断"。
   * 这个 class 必须在**手势开始之前**就在，所以放在每帧渲染里维护，
   * 而不是等 pointerdown 再贴。
   */
  boardEl.classList.toggle(
    'brush-paint',
    state.config.godMode === true && !replay && godBrush.kind !== 'none' && !godInControl(),
  );
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

  if (state.config.godMode === true && !replay) {
    // 上帝模式把侧栏整块让给兵种货架：这个模式里没人要看属性卡，
    // 兵是自己一手摆上去的，摆的时候就知道它是谁。
    renderGodShelf();
    renderGodBar();
  } else {
    // 离开沙盒（新对局 / 导入 / 切回普通局）：两份签名作废，
    // 下次再进上帝模式时不会拿着上一局的签名把重绘挡掉
    godSig = '';
    godShelfSig = '';
    keepSideScroll(() => renderPanel(sideEl, panelInput(view)));
    renderCommander();
  }

  // 换人了就"叮"一声：手机放在桌上等对手的人，靠这一声回神。
  // AI 之间互打不响（会变成每秒一声），观战也不响。
  if (
    !replay &&
    lastTurnPlayer !== null &&
    lastTurnPlayer !== state.current &&
    !state.winner &&
    !isAiSide(state, state.current) &&
    !spectating()
  ) {
    playChime(chimeVolume);
  }
  lastTurnPlayer = state.current;

  const topbarChanged = updateTopbar(topbarEl, {
    fog: state.fog,
    blackout: state.config.expansionIds.includes('blackout'),
    turn: state.turn,
    current: state.current,
    currentName: state.players[state.current].name,
    aiCurrent: isAiSide(state, state.current),
    aiLevelName: aiNameOf(state),
    aiAny: anyAiSide(state),
    paused: aiPaused,
    speedName: AI_SPEED_NAME[aiSpeed] ?? '快',
    roomCode: room?.code ?? null,
    waitingForPeer: replay === null && !myTurn() && !state.winner,
    spectator: watching(),
    replay: replay !== null,
    god: state.config.godMode === true,
    commander: state.config.commanderMode === true,
    commanderRunning,
  });
  // 没有观察者就每帧量（老行为）；有就只在它标脏之后量。
  // 这一句从"每帧一次强制布局"变成"改窗口 / 换缩放 / 工具栏变高时一次"。
  // 第三个条件是那道对账单：档位换了但 DOM 没跟上，必须补量一次。
  const remeasure = boardDirty || lastFitZoom !== boardZoom || !canWatchResize;
  if (remeasure) fitBoard();
  // 顶栏内容没动、尺寸也没动，"还能不能往两边滚"就不会变——那道判断要读
  // scrollWidth，是笔强制布局，不值得每帧付一遍。滚动本身另有 scroll 监听。
  if (topbarChanged || remeasure) syncTopbarScroll();

  // 聊天入口跟着房间走：进房间才出现，退出去就收起
  renderChatDock();

  // 复盘条：只改数字，不重建节点（重建会把正在拖的滑块抽走）
  if (replay) {
    replayEl.hidden = false;
    syncReplayBar(replayEl, replayUiOf(), replaySeeking);
  } else if (!replayEl.hidden) {
    replayEl.hidden = true;
  }

  /*
   * 打完了：告诉玩家产出在哪。
   *
   * 光有一张卡没人知道要点——按钮在右侧面板里，而终局那一刻大家的视线在棋盘上。
   * 只提示一次（`settledNotified`），不自动弹卡：自动弹会挡住最后一眼局面，
   * 而"刚打完"正是最想看清残局的时候。
   * 复盘和教程局不提示：前者不是你的对局，后者有自己的收尾。
   */
  if (state.winner && !settledNotified) {
    settledNotified = true;
    if (replay === null && !tutorial.tutorialOn()) {
      toast('这局打完了——右侧「战报卡」能存成图片');
    }
  } else if (!state.winner) {
    // 换局 / 读档 / 撤销回到中局：标志要跟着回去，否则下一局打完了不再提示
    settledNotified = false;
  }

  /*
   * 新手教程的教练层。
   *
   * 放在 render 的最后：卡片要盖在已经画好的棋盘和面板上面，而且棋盘每帧重建，
   * 圈出来的格子也得每帧重挂一次。tutorial 自己判断"还是不是同一张卡片"，
   * 不会每帧新建节点（否则按钮会丢焦点、动画会闪）。
   */
  if (tutorial.tutorialOn()) {
    const before = tutorial.tutorialStep();
    tutorial.tutorialTick(state, selectedId, selectedTile);
    /*
     * 教程刚翻页：这一帧的棋盘还是按**上一步**的标记画的（圈在哪、框哪座城）。
     * 不补一帧的话，红框要等到玩家下一次点击才出现——"该打这座城了"却什么都没框。
     * 用 setTimeout 而不是直接递归，是为了不把 render 套进 render 里。
     */
    if (tutorial.tutorialOn() && tutorial.tutorialStep() !== before) {
      setTimeout(() => { if (tutorial.tutorialOn()) render(); }, 0);
    }
  }
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
/**
 * 当前在看哪张图。
 *
 * 地球之外由图在运行时创建（月球、空间站）。这个变量只决定"画哪一张"，
 * 不参与任何规则计算——规则层认的是单位/动作自带的 `board`。
 */
let activeBoardId: BoardId = EARTH;
/** 左下角地图列表是否展开 */
let boardListOpen = false;
/** 地图列表已经画出来的签名，避免每帧重建 DOM */
let boardListSig = '';
/**
 * 每张图各自的相机（缩放档 + 滚动位置）。
 *
 * 切图要还原相机：32×32 的地球放大到中间看战场，切到 7×7 的空间站再切回来，
 * 如果回到左上角，玩家得重新拖一遍——多图玩法里这个动作一天要做几十次。
 */
const boardCameras = new Map<BoardId, { zoom: number; left: number; top: number }>();
/**
 * 上一次 `fitBoard()` 用的是哪一档。
 *
 * 这是"我想要的档位"和"屏幕上真的写进去的档位"之间的对账单。
 * 两者对不上就说明 DOM 落后了——不管 `boardDirty` 是谁忘了打上，
 * 下一帧都会重新量一次。玩家报的"放大之后缩不回去、而且一直缩不回去"，
 * 本质上就是这两个值悄悄分家了，却没人负责把它们捏回去。
 */
let lastFitZoom = 0;
/** 1× 时棋盘该有多大（像素）。放大只是在这个数上乘，不改它 */
let baseBoardSize = 0;

/**
 * 棋盘尺寸还有效吗。
 *
 * `fitBoard()` 要读 `offsetWidth` / `offsetHeight` / 计算样式，再写 `style`。
 * 读-写这一对放在渲染流水线的末尾，在真机上就是一次**强制同步布局**：
 * 刚写完一千个格子的样式，浏览器为了回答"容器多宽"必须先把这一切算完。
 * 而棋盘尺寸一年也变不了几次——窗口改大小、缩放换档、参谋部栏展开/收起，
 * 就这三件事。所以默认不量：由 ResizeObserver 在真变了的时候把它标脏。
 *
 * 没有 ResizeObserver 的宿主（jsdom、很老的浏览器）量不到这些变化，
 * 就老老实实每帧都量——那是从前的行为，慢一点，但不会算错。
 */
let boardDirty = true;
const canWatchResize = typeof ResizeObserver === 'function';

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

  // 这一量是有效的，下一帧不必再来一遍（除非谁把 boardDirty 重新打上）
  boardDirty = false;
  lastFitZoom = boardZoom;
}

/**
 * 盯着会改变棋盘可用空间的三个东西。
 *
 * 回调里只标脏、并顺手排一次 fitBoard，不调整个 render()：
 * 尺寸变了不需要重画棋盘内容，格子是按百分比排的，跟着走就行。
 * 排一次而不是就地做，是因为回调本身就在布局之后，就地写样式会让
 * 观察者再触发一轮；隔一帧再写，同一轮里的多次变化能合并成一次。
 */
function watchBoardResize(): void {
  if (!canWatchResize) return;
  let queued = false;
  const ro = new ResizeObserver(() => {
    boardDirty = true;
    if (queued) return;
    queued = true;
    const next = (): void => {
      queued = false;
      if (!boardDirty) return;
      fitBoard();
      // 顶栏换了宽度，"还能不能往两边滚"也跟着变——这一步读 scrollWidth，
      // 放在这里正好，反正刚量完布局，读一次是顺手的
      syncTopbarScroll();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(next);
    else window.setTimeout(next, 16);
  });
  // 容器宽、顶栏高（会换行）、参谋部栏高（会展开）—— 这三项决定可用空间
  for (const el of [boardWrapEl, topbarEl, commanderEl]) ro.observe(el);
}

/**
 * 换一档缩放。
 *
 * 放大之后把视口挪回中间：32×32 上放大的目的通常是"看中间那片战场"，
 * 停在左上角等于放大了一个空的角落。
 *
 * **不能用"数字没变就直接 return"**。`boardZoom` 只是"我想要的档位"，
 * 屏幕上真实的大小由 `fitBoard()` 写进 `style` 和 `zoomed` 类——这两者会脱钩
 * （换局、导入存档、窗口从隐藏变可见都会改 DOM 而不改这个变量）。
 * 一旦脱钩，早退就变成了"数字是 1、画面是 3×，点缩小永远没反应"，
 * 也就是玩家报的那个"放大之后缩不回去、开新局也缩不回去"。所以每次调用都
 * 重绘一次、重新量一次，让 DOM 跟着这个数字走。
 */
function setZoom(next: number): void {
  const steps = ZOOM_STEPS;
  const clamped = Math.min(steps[steps.length - 1]!, Math.max(1, next));
  const same = clamped === boardZoom;
  boardZoom = clamped;
  // 缩放直接改的是"棋盘该多大"，尺寸缓存必须作废
  boardDirty = true;
  // 先重绘再量：格子大小是从元素宽度推出来的，宽度变了必须重算一次
  render();
  if (same) return;
  if (boardZoom > 1) {
    boardScrollEl.scrollLeft = Math.max(0, (boardScrollEl.scrollWidth - boardScrollEl.clientWidth) / 2);
    boardScrollEl.scrollTop = Math.max(0, (boardScrollEl.scrollHeight - boardScrollEl.clientHeight) / 2);
  } else {
    boardScrollEl.scrollLeft = 0;
    boardScrollEl.scrollTop = 0;
  }
}

/**
 * 当前档位在第几档。
 *
 * 用"最近的一档"而不是 `indexOf`：`indexOf` 找不到会给 -1，
 * 再拿 -1 去 `+dir`，一次点击就变成"原地不动"，看起来就是按键失灵。
 */
function zoomIndex(): number {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const gap = Math.abs(ZOOM_STEPS[i]! - boardZoom);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

function zoomStep(dir: 1 | -1): void {
  const at = zoomIndex() + dir;
  setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at))]!);
}

/**
 * 缩放退回"适应屏幕"。
 *
 * 换局、导入存档、进房间都必须走这里，而不是写一句 `boardZoom = 1`：
 * 只改数字不把 `boardDirty` 打上，`render()` 里那句
 * `const remeasure = boardDirty || !canWatchResize;` 就不成立，`fitBoard()` 根本不跑，
 * 棋盘尺寸、滚动窗口、右下角那个档位标签全部停在上一局的放大状态。
 * 于是变量是 1、画面是 3×，点"缩小"被 `setZoom` 的早退挡掉——怎么点都没反应，
 * 而且再开一局还是这样（新局同样只改了数字）。
 */
function resetZoom(): void {
  activeBoardId = EARTH;
  boardListOpen = false;
  boardListSig = '';
  boardCameras.clear();
  boardZoom = 1;
  // 尺寸缓存必须作废，否则下一帧不会重新量
  boardDirty = true;
  // 视口也回去：换局之后还停在上一局拖到的位置，会看着像"棋盘缺了一块"
  boardScrollEl.scrollLeft = 0;
  boardScrollEl.scrollTop = 0;
  boardScrollEl.classList.remove('dragging', 'zoomed');
  boardEl.classList.remove('zoomed');
}

/** 地图列表里的小标记：图的类型（地球单独给个"地"） */
function boardGlyphOf(id: BoardId): string {
  if (id === EARTH) return '地';
  const kind = boardKindOf(state, id);
  return kind === 'station' ? '站' : kind === 'orbit' ? '轨' : '星';
}

/** 这一张图上还有几个自家单位能动（建筑不算） */
function boardReadyCount(view: PlayerView, id: BoardId): number {
  if (replay || spectating()) return 0;
  return view.state.units.filter((u) => {
    if (u.owner !== me() || boardIdOf(u) !== id || u.acted) return false;
    return view.state.unitTypes[u.type]?.category !== 'building';
  }).length;
}

/** 这一张图上有没有看得见的敌人（地图列表上的红点） */
function boardHasContact(view: PlayerView, id: BoardId): boolean {
  if (replay || spectating()) return false;
  return view.state.units.some((u) => u.owner !== me() && boardIdOf(u) === id);
}

/** 地图列表里的文字来自扩展，转义一遍再拼 HTML */
function escapeBoardText(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 左下角的地图列表。
 *
 * 收起时只显示当前图（名字 + 待命数 + 敌人红点），点开列出所有图。
 * 用签名挡住每帧重建：棋盘一帧要重画很多次，列表没必要跟着抖。
 */
function syncBoardList(view: PlayerView): void {
  if (!hasBoard(state, activeBoardId)) activeBoardId = EARTH;
  const ids = boardIds(state);
  const entries = ids.map((id) => ({
    id,
    name: boardName(state, id),
    ready: boardReadyCount(view, id),
    contact: boardHasContact(view, id),
  }));
  const sig = [
    boardListOpen ? 'open' : 'shut',
    activeBoardId,
    replay ? 'replay' : '',
    ...entries.map((e) => `${e.id}/${e.name}/${e.ready}/${e.contact}`),
  ].join('|');
  if (sig === boardListSig) return;
  boardListSig = sig;

  boardListEl.classList.toggle('open', boardListOpen);
  const cur = entries.find((e) => e.id === activeBoardId) ?? entries[0]!;
  const current =
    `<button class="bl-current" data-act="bl-toggle" title="切换地图（共 ${entries.length} 张）">` +
    `<span class="bl-kind">${boardGlyphOf(cur.id)}</span>` +
    `<span class="bl-name">${escapeBoardText(cur.name)}</span>` +
    (cur.ready > 0 ? `<span class="bl-ready">${cur.ready}</span>` : '') +
    (cur.contact ? '<i class="bl-contact" title="这张图上有敌人"></i>' : '') +
    `<span class="bl-caret">▴</span>` +
    `</button>`;

  const rows = entries
    .map(
      (e) =>
        `<button class="bl-row${e.id === activeBoardId ? ' on' : ''}" data-board="${escapeBoardText(e.id)}" title="${escapeBoardText(e.name)}">` +
        `<span class="bl-kind">${boardGlyphOf(e.id)}</span>` +
        `<span class="bl-name">${escapeBoardText(e.name)}</span>` +
        (e.ready > 0 ? `<span class="bl-ready">${e.ready}</span>` : '') +
        (e.contact ? '<i class="bl-contact"></i>' : '') +
        `</button>`,
    )
    .join('');

  // 调试脚手架：第四步接入真正的月球后删掉
  const debug =
    godMode() && !replay
      ? `<button class="bl-add" data-act="bl-add" title="开发用：按地球的尺寸生成月球图">＋ 月球</button>`
      : '';

  boardListEl.innerHTML = `${current}<div class="bl-menu">${rows}${debug}</div>`;
}

/**
 * 切到另一张图。
 *
 * 只换"渲染的是哪张图"和相机，规则一行不动——单位、视野、动作各自带着
 * 自己的 `board`，切图不影响它们。
 */
function switchBoard(id: BoardId): void {
  if (id === activeBoardId || !hasBoard(state, id)) return;
  // 走之前把相机存下来
  boardCameras.set(activeBoardId, {
    zoom: boardZoom,
    left: boardScrollEl.scrollLeft,
    top: boardScrollEl.scrollTop,
  });

  activeBoardId = id;
  /*
   * 选中、待放技能、待选落点全部清掉。
   *
   * 它们记的是**地球**的格坐标；原样带到 7×7 的空间站上，要么越界，
   * 要么指向完全无关的格子。清掉是最不容易出错的做法——重新点一下就是了。
   */
  selectedId = null;
  selectedTile = null;
  selectedCityId = null;
  selectedCampId = null;
  pendingMovePath = null;
  pendingSkill = null;
  pendingDevice = null;
  boardListOpen = false;

  const cam = boardCameras.get(id) ?? { zoom: 1, left: 0, top: 0 };
  boardZoom = cam.zoom;
  boardDirty = true;
  render();

  const restore = (): void => {
    boardScrollEl.scrollLeft = cam.left;
    boardScrollEl.scrollTop = cam.top;
  };
  // 等这一帧的尺寸写完再还原滚动位置，否则会被 fitBoard 的布局覆盖
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  else restore();
}

/**
 * 上帝模式里的「＋ 月球」：按当前的玩法生成真正的月球图。
 *
 * 正式入口在「太空时代」扩展里（第 5 步接），这里只是提前留一个能看效果的按钮：
 * 尺寸按 `moonSizeFor(state.w)` 跟着地球缩，地形是月壤 + 环形山。
 */
function addMoonBoard(): void {
  if (!godMode() || replay) return;
  if (state.boards?.moon) {
    switchBoard('moon');
    return;
  }
  const board = createMoonBoard(state.w, state.seed);
  state.boards ??= {};
  state.boards.moon = board;
  // 迷雾记忆按图刷新一次，切过去不会满屏"未探明"
  refreshMemory(state);
  switchBoard('moon');
}

/** 非地球的图没有选中/可达/染色这些地球坐标的东西，一律清空 */
function boardUiFor(ui: BoardUi, id: BoardId): BoardUi {
  if (id === EARTH) return ui;
  // 选中的单位如果就在这张图上，高亮要留着；切图时它属于别处才清掉
  const sel = ui.selectedId ? state.units.find((u) => u.id === ui.selectedId) : undefined;
  return {
    ...ui,
    selectedId: sel && boardIdOf(sel) === id ? sel.id : null,
    selectedCityId: null,
    // 可达格与建造高亮都是"图内索引"，渲染的正好是同一张图，照用
    reach: ui.reach,
    targets: [],
    siegeTargets: [],
    aimTiles: [],
    skillThreatTiles: [],
    placeable: ui.placeable,
    threat: [],
    heat: undefined,
    heatFlash: undefined,
    movePath: undefined,
    boardView: undefined,
    boardGlyph: undefined,
    incomeHints: undefined,
    tutorialTiles: [],
    tutorialCityId: null,
    tutorialOwnCityId: null,
  };
}

boardListEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-board]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'bl-toggle') {
    boardListOpen = !boardListOpen;
    syncBoardList(viewNow());
    return;
  }
  if (act === 'bl-add') {
    addMoonBoard();
    return;
  }
  const id = el.dataset.board;
  if (id) switchBoard(id);
});

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
  /*
   * 别的图还没有动作系统：可达格、攻击目标、技能落点全是**地球**坐标算出来的，
   * 在月球上算一遍只会把地球那套高亮带过去（它们最终也会被 boardUiFor 清掉）。
   * 直接清空，省一次错误的寻路。
   */
  if (activeBoardId !== EARTH) {
    /*
     * 别的图也能走（第 8 步起的月面行动）：可达格由 `reachableTiles` 按
     * 单位所在的图算，索引也是那张图的索引，和渲染层对得上。
     *
     * 攻击、攻城、技能选点仍然只在地球：它们的射程、溅射、地形掩护全按
     * `state` 结算，月面战斗是「太空战争」那一包的事。
     */
    reach = [];
    targets = [];
    siege = [];
    aimTiles = [];
    skillThreatTiles = [];
    const unit = selectedId ? state.units.find((u) => u.id === selectedId) : undefined;
    if (unit && unit.owner === me() && boardIdOf(unit) === activeBoardId && !unit.acted) {
      reach = canMove(unit) ? Array.from(reachableTiles(state, unit).keys()) : [];
    }
    return;
  }

  if (pendingSkill) {
    reach = [];
    targets = [];
    siege = [];
    aimTiles = []; 
    skillThreatTiles = [];
    skillAimKey = '';

    const caster = state.units.find(u => u.id === pendingSkill?.unitId);
    const skillId = pendingSkill.skillId;
    const previewer = SKILL_PREVIEWERS[skillId];

    if (caster) {
      /*
       * 全图选点（传送阵「挪移」）：**不**逐格高亮。
       *
       * `.tile.aim` 是把整格铺成红色斜纹的样式，给"四选一方向"用的；
       * 一千个格子全点亮会变成一片红海，什么也看不清。所以这里只清空高亮，
       * 落点范围改由鼠标悬停时现算（见 boardEl 上的 skillAimPreview）。
       */
      if (pendingSkill.targeting === 'point') {
        /*
         * 先点亮**可落点的范围圈**。
         *
         * 两条来源，谁有就用谁：
         *   1. 技能登记过"合法落点"（`SKILL_TARGET_CELLS`，陨卵就是这种）——
         *      直接把它给的那一片点亮。这是玩家判断"9 格边界在哪"的唯一线索。
         *      2026-11-09 我合 main.ts 时以为这张表没人读，整段删了，
         *      结果陨卵在界面上没有射程圈；这次连"点空地也能放"一起补回来。
         *   2. 没登记的（掌心雷、传送阵这类）——拿"落点 = 自己脚下"问一次预览器：
         *      以自己为圆心的射程圈立刻就有；传送阵在落点=自己时返回空，保持不亮。
         *
         * 点亮只影响观感：选点型的点击判定不查 `aimTiles`（见 skill-aim.ts），
         * 所以"圈外的格子点了会失败"这件事仍然由规则层给说法。
         */
        const skillDef = heroSkillsOf(state, caster).find((k) => k.def.id === skillId)?.def;
        const cellsOf = skillDef ? SKILL_TARGET_CELLS[skillDef.effect] : undefined;
        if (cellsOf && skillDef) {
          for (const p of cellsOf({ state, self: caster, skill: skillDef })) {
            aimTiles.push(idx(state, p.x, p.y));
          }
        } else if (previewer && caster) {
          skillThreatTiles = previewer({ state, self: caster, target: { x: caster.x, y: caster.y } });
        }
        return;
      }

      // 方向型：四周四个方向作为点击热区（这符合战棋习惯）
      const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
      const threatSet = new Set<number>();

      for (const [dx, dy] of dirs) {
        const aimX = caster.x + dx;
        const aimY = caster.y + dy;
        
        if (aimX >= 0 && aimY >= 0 && aimX < state.w && aimY < state.h) {
          aimTiles.push(aimY * state.w + aimX);

          // 2. 如果有预览器，就问一下这个方向会打到哪
          if (previewer) {
            const cells = previewer({ state, self: caster, target: { x: aimX, y: aimY } });
            for (const cell of cells) {
              // 把自己脚下和起点的 aim 格剔除
              if (cell !== caster.y * state.w + caster.x && !aimTiles.includes(cell)) {
                threatSet.add(cell);
              }
            }
          }
        }
      }
      skillThreatTiles = Array.from(threatSet);
    }
    return;
  }
  aimTiles = [];
  skillThreatTiles = [];
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
  // 扩展包 / 时代筛选都不清：它们是"我这一局只想看哪几个包、哪几代"，
  // 换一个单位不该把它们重置掉
  forceMode = null;
  pickState = null;
  selectedId = null;
  selectedCityId = null;
  selectedCampId = null;
  selectedTile = null;
  buildPlan = null;
  spawnPlan = null;
  pendingSkill = null;
  loadPlan = null;
  unloadPlan = null;
  reach = [];
  targets = [];
  siege = [];
  aimTiles = [];
  skillThreatTiles = [];
}

/**
 * 经济单位的移动产出预览。
 *
 * 选中经济单位、且它还有可达格时，把每一格站上去之后的**全部产出**都算出来
 * （农民按地形、牧民按地形、临水 +河运、扩展的 modifyYield 折算也一并算上）。
 *
 * 以前这里先看 `def.income` / `def.incomeByTerrain` 有没有写，没写就直接返回——
 * 只产粮、材、灵石的单位（灵田、粮仓）因此永远没有预览，玩家挪它们时
 * "去哪儿都一样"是错的。现在逐格算 unitYield，算出来是空表才跳过；
 * reach 本身已经带上了"是谁的回合、动没动过"的口径。
 */
function computeIncomeHints(unit: Unit | undefined): Map<number, ResourceCost> {
  const hints = new Map<number, ResourceCost>();
  if (!unit || reach.length === 0) return hints;
  for (const i of reach) {
    const x = i % state.w;
    const y = Math.floor(i / state.w);
    const yields = unitYieldAt(state, unit, x, y);
    if (Object.keys(yields).length > 0) hints.set(i, yields);
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
        if (distToUnit(state, { x, y }, ferry) !== 1) continue;
        const tile = state.tiles[y * state.w + x];
        if (!tile) continue;
        // 落点问规则层（canStandAt 按**货舱里那个兵**判）：自己数一遍地形的话，
        // 飞行兵下船落水这类合法落点会被界面吞掉——高亮了点下去被拒，
        // 或者反过来（点了没反应）。
        if (!(ferry.cargo ?? []).some((c) => canStandAt(state, x, y, c.type))) continue;
        const city = tile.cityId ? state.cities.find((c) => c.id === tile.cityId) : null;
        if (city && city.owner !== ferry.owner && !city.ruined) continue;
        out.push(y * state.w + x);
      }
    }
    return out;
  }

  if (!buildPlan) return [];
  const builder = state.units.find((u) => u.id === buildPlan?.unitId);
  if (!builder) return [];
  const def = state.unitTypes[buildPlan.type];
  if (!def) return [];

  // 高亮的含义是"点下去一定建得成"，所以不在这里另写一套判据，直接问规则。
  //
  // 以前这里是第二份实现：地形、桥要两侧有陆地、军营要临水……每一条单看都对，
  // 但和 `buildSiteError` 是两套代码，改一处忘一处就冒出"高亮了、点了却被拒"。
  // 军营那次就是这么坏的：规则里判临水只认 `water`，这里用的 `adjacentToWater`
  // 认桥面，于是桥头被高亮成可建，点下去才回一句"必须扎在水边"。
  // 判据只能有一处，界面这一层只负责问。
  /*
   * 按**建造者所在的那张图**算：月面上的工程队看的是月球的格子。
   * `boardState` 对地球直接返回 state 本身，所以这条不影响原路径。
   */
  const grid = boardState(state, boardIdOf(builder));
  const out: number[] = [];
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      if (buildSiteError(grid, def, builder, x, y) !== null) continue;
      out.push(y * grid.w + x);
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

/* ===========================================================================
 * 选卡（BP）：开局那一段的用户操作
 *
 * 它不走 dispatch()，因为 dispatch 的整套前提都是"轮到 state.current 走棋"：
 * 选卡期间 current 一直是 A（棋盘还没开始），而禁用是双方同时进行的。
 * 所以这里单开一条通道，把 actor 显式传进 applyAction。
 * ======================================================================== */

/** 本地设备现在替哪一方操作（热座会换手；对 AI 时固定在人类那一方） */
let draftSeat: PlayerId = 'A';
/** 上一次画出来的选卡快照，用来避免每帧重建整块遮罩 */
let draftSig = '';
/** 是否已经排了一次 AI 选卡（防止每帧都排） */
let draftAiPending = false;
/** 正在往云端提交一步 BP：期间不接受新的点击（避免同一手上交两次） */
let draftBusy = false;
/**
 * 上一步没交上去（重试四轮都失败 / 断网）。
 *
 * 单独记一个标记，是因为"本地进度号跑到房间前面"这件事只能从这里来：
 * 本地已经落下这一步、房间没有，于是两边各拿一份不同的名单互相等——
 * 谁也不会再动，界面上看起来就是"禁不动、选不动"。看到这个标记就按房间重来。
 */
let draftStuck = false;
/** 提交期间点下去的卡片：不丢，等这一步交完接着办 */
let draftQueuedClick: { action: Action; actor: PlayerId } | null = null;
/** 对面是否已经入座（选卡 lobby 要显示"等待对方加入"） */
let peerSeated = false;

/** 本机现在替哪一方操作：联机以房间席位为准，热座看座位交接 */
function draftActor(): PlayerId {
  return room && !room.spectator ? room.seat : draftSeat;
}

function draftIsAi(side: PlayerId): boolean {
  // 房间里的两侧都是人（席位就是身份），托管开关在进房时已经被关掉了
  if (room) return false;
  return isAiSide(state, side);
}

/**
 * 座位交接。
 *
 * 禁用改成轮流之后（2026-11-07），两段的判据其实是同一个了：
 * **轮到谁，设备就跟着谁**。禁用期不再有"我交完就把设备交出去"这一步模糊操作
 * ——只要 `banTurn` 不是我，设备就该在对面的手上。
 */
function syncDraftSeat(): void {
  const view = draftView(state);
  if (!view || view.phase === 'done') return;
  // 联机：设备只代表自己那个席位，不跟着 order 换手
  if (room) {
    if (!room.spectator) draftSeat = room.seat;
    return;
  }
  if (view.phase === 'pick' && view.toAct && !draftIsAi(view.toAct)) {
    draftSeat = view.toAct;
    return;
  }
  if (view.phase === 'ban' && view.banTurn && !draftIsAi(view.banTurn)) {
    draftSeat = view.banTurn;
  }
}

function dispatchDraft(action: Action, actor: PlayerId): boolean {
  /*
   * 联机：本地先落一步（手感即时，点下去就见效），然后带着"我看到的进度号"
   * 提交上去。被对面抢先写了就重新拉、把这一步补到最新状态上再交——
   * 禁用期本来就允许双方同时提交，这不是冲突而是常态。
   */
  if (room) {
    if (room.spectator) {
      toast('观战位只能看，不参与选卡');
      return false;
    }
    // 席位只认房间：缓存下来的 draftSeat 一旦和房间不一致，点下去会被判成
    // "这是对面的席位"，表现就是"选不动卡"。所以这一步以 room.seat 为准。
    if (actor !== room.seat) actor = room.seat;
    if (draftBusy) {
      // 上一步还在提交：先记下这一下，等它交完再办。
      // 以前直接 return，快速连点时后几下会被静默吃掉——玩家以为卡了。
      draftQueuedClick = { action, actor };
      return true;
    }
    const prevSeq = state.draft?.seq ?? 0;
    const result = applyAction(state, action, actor);
    if (!result.ok) {
      toast(result.reason);
      return false;
    }
    state = result.state;
    saveMatch(state);
    render();
    void pushDraft(room, prevSeq, action, actor);
    return true;
  }

  const result = applyAction(state, action, actor);
  if (!result.ok) {
    toast(result.reason);
    return false;
  }
  state = result.state;
  saveMatch(state);
  if (state.draft?.phase === 'done') {
    afterDraft();
  } else {
    render();
  }
  return true;
}

/**
 * 把一步 BP 交到云端。
 *
 * 锁是"进度号"（房间的 turn 列在 BP 期间存 draft.seq）：被挡回来就说明
 * 对面先写了。这时候**不能直接覆盖**——先把最新状态拉下来，把自己的这一步
 * 补上去，再用新的进度号重交。最多试四轮，失败就明说"没交上去"。
 */
async function pushDraft(
  seat: RoomSeat,
  prevSeq: number,
  action: Action,
  actor: PlayerId,
): Promise<void> {
  draftBusy = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ok = await submitDraft(seat.code, state, prevSeq);
      if (ok) {
        dirty = false;
        draftStuck = false;
        if (state.draft?.phase === 'done') afterDraft();
        return;
      }
      const snap = await fetchRoom(seat.code);
      if (!snap || room?.code !== seat.code) return;
      const remote = snap.state.draft;
      if (!remote || remote.phase === 'done') {
        // 对面已经打完 BP 并且推上去了：直接采纳，别在旧状态上继续折腾
        takeSnapshot(snap);
        return;
      }
      // 对面先写了：把自己的这一步补到最新状态上再来一次
      const retry = mergeDraftStep(snap.state, action, actor);
      if (!retry.ok) {
        // 这一步在新局面上已经不合法了（比如对面已经禁过、或者轮次已经过去）。
        // 房间是权威：退回房间那份，把出手权还给玩家。
        takeSnapshot(snap);
        toast(retry.reason);
        return;
      }
      state = retry.state;
      prevSeq = remote.seq;
      saveMatch(state);
      render();
    }
    // 四轮都没交上去：本地已经落下的这一步房间里没有。记住它，
    // 轮询看到"本地进度号比房间大"时就会按房间重来，不至于两边干等。
    draftStuck = true;
    toast('这一步没交上去（网络可能不稳）。点「刷新房间状态」按房间重来');
  } catch (err) {
    draftStuck = true;
    toast(err instanceof Error ? err.message : '提交失败，网络可能不通');
  } finally {
    draftBusy = false;
    // 提交期间点下去的卡片：现在接着办（只留最后一下，连点不会堆成队列）
    const queued = draftQueuedClick;
    draftQueuedClick = null;
    if (queued && room?.code === seat.code && draftInProgress(state)) {
      window.setTimeout(() => dispatchDraft(queued.action, queued.actor), 0);
    }
  }
}

/** 把云端快照无提示地装进本机（BP 用；对局中的那次在 pollRoom 里带 toast） */
function takeSnapshot(snapshot: RoomSnapshot): void {
  const fog = state.fog;
  dropHeatFlash();
  state = snapshot.state;
  state.aiControl = { A: false, B: false };
  state.fog = fog;
  clearSelection();
  saveMatch(state);
  // 从房间接手的那一局也是"真的打过"的：回首页之后应该能接着打
  hasRealSave = true;
  render();
}

/** 选卡打完：把方向盘交回正常对局 */
function afterDraft(): void {
  draftSig = '';
  draftEl.hidden = true;
  render();
  if (state.draft?.skipped) {
    toast('已跳过选卡：这一局用全部兵种开打');
  } else {
    const names = (side: PlayerId) =>
      (state.draft?.picks[side] ?? []).map((id) => state.unitTypes[id]?.name ?? id).join('、');
    toast(`选卡完成 · 甲方：${names('A')} ／ 乙方：${names('B')}`);
  }
  if (isAiSide(state, state.current)) void runAiLoop();
}

/** 画（或收起）遮罩。每次 render 都会问一次，但只有内容变了才重建 DOM */
function renderDraft(): void {
  /*
   * 复盘期间一律不铺选卡遮罩。
   *
   * 报告里的选卡名单没存（见 replay-file 的说明），重建出来的 `state.draft`
   * 大概率停在"等待开局/禁用"——那层遮罩会盖在**回放**上面，还带着倒计时和
   * 「开始选卡」按钮，看上去像这一局在等你选卡。回放里没有这一屏。
   */
  if (replay || !draftInProgress(state)) {
    if (!draftEl.hidden) draftEl.hidden = true;
    draftSig = '';
    stopDraftTicker();
    stopDraftPolling();
    return;
  }
  startDraftTicker();
  if (room) startDraftPolling();
  draftEl.hidden = false;
  syncDraftSeat();
  const view = draftView(state)!;
  const sig = [
    view.phase,
    view.step,
    view.a.bans.join(','),
    view.b.bans.join(','),
    view.a.picks.join(','),
    view.b.picks.join(','),
    draftSeat,
    view.remaining.length,
    room?.code ?? '',
    peerSeated ? '1' : '0',
  ].join('|');
  if (sig !== draftSig) {
    draftSig = sig;
    // 重画之后旧卡片已经不在文档里，浮层再留着就是一片错位的信息
    hideHoverTip();
    draftEl.innerHTML = draftScreenHtml(state, {
      seat: draftSeat,
      now: Date.now(),
      isAi: draftIsAi,
      room: room
        ? { code: room.code, link: inviteLink(room.code), peerSeated }
        : null,
      // 倒计时取"本机看到这一轮之后剩下的秒数"和房间那份的小者：
      // 房间那份可能是别人的钟写的，早就不作数了
      secondsCap: draftLocalSecondsLeft(Date.now()),
    });
    // AI 的那一手：晚半秒再动，让它看起来像在挑，而不是"你点完它就位"
    scheduleDraftAi();
  }
  paintDraftTimer(draftEl, state, Date.now(), draftLocalSecondsLeft(Date.now()));
}

/**
 * 倒计时与超时兜底。
 *
 * 只在选卡期间跑，选完就停：一个永远活着的 400ms 定时器会让页面和
 * 测试都"关不掉"（Node 里它等于一直有关系挂着，进程不肯退出）。
 *
 * 放在界面侧而不是规则里，是因为"现在几点"不是规则的一部分：
 * 规则只认动作里带的 `at`，谁先到点谁提交。这样同一个状态在哪台设备上
 * 都能算出同样的结果，也不会因为某个客户端时钟慢半拍就把对局卡死。
 */
let draftTicker: number | null = null;
/** 上一次为哪个进度号判过超时（防止每 400ms 重复提交同一步） */
let draftTimeoutAt = -1;
/**
 * 本机第一次看到"当前这一轮"的时刻。
 *
 * 为什么不能只信 state 里的 deadline：那个数是**另一台机器**的钟写进来的，
 * 而且可能是几分钟前写的（你入座时对面已经在禁用屏上坐了一会儿）。拿它直接
 * 减 Date.now()，轻则倒计时一进来就是 0，重则当场判"双方禁用超时"。
 * 所以本机自己记一个锚点：超时只在我亲眼看着这一轮走完整个时长之后才发起。
 * 房间那份 deadline 仍然是上限（它更晚就等它）。
 */
let draftAnchor = { key: '', at: 0 };

/** 这一轮的时长（禁用 25 秒 / 每次选人 30 秒） */
function draftPhaseMs(state: GameState): number {
  // 时长必须和规则层写 deadline 时用的是同一份（开局面板可以改这两档）
  return draftMsOf(state);
}

/**
 * 距离本机锚点还有多少秒（倒计时显示用；不小于 0）。
 *
 * 还没立锚点时（刚进这一轮、定时器还没跑过第一拍）按**满格**算：
 * 这一轮就是从这一刻开始的，返回 0 会让界面一进来就写「0s」。
 */
function draftLocalSecondsLeft(now: number): number {
  const ms = draftPhaseMs(state);
  if (!draftAnchor.at) return Math.ceil(ms / 1000);
  return Math.max(0, Math.ceil((draftAnchor.at + ms - now) / 1000));
}

function startDraftTicker(): void {
  if (draftTicker !== null) return;
  draftTicker = window.setInterval(() => {
    if (!draftInProgress(state)) {
      stopDraftTicker();
      return;
    }
    // lobby 不计时（要等人），done 更不用；只有禁用与选人这两段才有倒计时
    const phase = state.draft?.phase;
    if (phase !== 'ban' && phase !== 'pick') return;
    const now = Date.now();
    paintDraftTimer(draftEl, state, now);

    /*
     * ① 先把本机的钟对准这一轮。
     *
     * 换了一轮（阶段或进度号变了）就重新起算：这一拍只记时，不判超时。
     * 少了这一句，刚进禁用屏的那一下会因为拿到的是别人的 deadline 而当场
     * 判"双方禁用超时"——这正是这次要修的那个毛病。
     */
    const key = `${phase}:${state.draft?.seq ?? 0}`;
    if (draftAnchor.key !== key) {
      draftAnchor = { key, at: now };
      return;
    }

    // ② 本机还没走完这一轮 → 不判。
    if (now < draftAnchor.at + draftPhaseMs(state)) return;
    // ③ 房间那份 deadline 也得到点（它更晚就等它）。
    //    联机时多留一点余量：deadline 是对方那台机器的钟写进来的。
    const slack = room ? 1500 : 0;
    if (draftSecondsLeft(state, now + slack) > 0) return;
    /*
     * 到点了。这一步也必须**提交进房间**——以前只改本地，于是两边各超时各的：
     * A 的钟先到点，A 本机补了一手，房间里没有；B 的钟后到点，也补了一手。
     * 两份名单从此分叉，进度号各自往前跑，谁也追不上谁，界面上就是
     * "超时补选之后还得再选一次"（对方的版本被自己这边覆盖/被拉回来）。
     *
     * 超时的结果本身是确定的（禁用＝放弃；选人＝按种子在剩余池里取一个），
     * 所以哪一台机器先提交都一样，谁先到点谁写，另一边拉下来即可。
     */
    const actor = draftActor();
    // 同一格只尝试一次，别每 400ms 反复弹提示
    if (draftTimeoutAt === state.draft?.seq) return;
    draftTimeoutAt = state.draft?.seq ?? 0;
    if (!dispatchDraft({ type: 'DRAFT_TIMEOUT', at: now }, actor)) {
      // 没接住（比如本地时钟还没到房间的 deadline）：解锁，下一拍再试
      draftTimeoutAt = -1;
    }
  }, 400);
}

function stopDraftTicker(): void {
  if (draftTicker === null) return;
  window.clearInterval(draftTicker);
  draftTicker = null;
  draftAnchor = { key: '', at: 0 };
}

function scheduleDraftAi(): void {
  if (draftAiPending) return;
  const view = draftView(state);
  if (!view) return;
  // 轮流禁用之后，"轮到谁"才是判据：不能再用"还有谁没禁完"——
  // 对面那一轮里没禁完的那个席位是玩家自己，AI 不该替他下手
  const aiPending =
    view.phase === 'ban'
      ? !!view.banTurn && draftIsAi(view.banTurn)
      : view.phase === 'pick' && !!view.toAct && draftIsAi(view.toAct);
  if (!aiPending) return;

  draftAiPending = true;
  window.setTimeout(() => {
    draftAiPending = false;
    if (!draftInProgress(state)) return;
    const now = draftView(state);
    if (!now) return;
    if (now.phase === 'ban') {
      const side = now.banTurn;
      if (!side || !draftIsAi(side)) return;
      const id = aiDraftBan(state, side);
      if (id) dispatchDraft({ type: 'DRAFT_BAN', unitId: id, at: Date.now() }, side);
      return;
    }
    if (now.phase === 'pick' && now.toAct && draftIsAi(now.toAct)) {
      const id = aiDraftPick(state, now.toAct);
      if (id) dispatchDraft({ type: 'DRAFT_PICK', unitId: id, at: Date.now() }, now.toAct);
    }
  }, 600);
}

/**
 * 选卡界面上的按钮（开始 / 跳过 / 退出 / 复制链接）。
 *
 * 这几个都是"遮罩自己的出口"——遮罩盖住了顶栏，如果没有它们，玩家进了 lobby
 * 就只能干看着，既建不了房也退不出去。
 */
function onDraftCommand(cmd: string): void {
  const view = draftView(state);
  if (!view) return;
  const actor: PlayerId = room && !room.spectator ? room.seat : 'A';

  if (cmd === 'copy-link') {
    if (!room) return;
    const link = inviteLink(room.code);
    void navigator.clipboard?.writeText(link);
    toast(`邀请链接已复制（房间 ${room.code}）`);
    return;
  }

  if (cmd === 'start') {
    dispatchDraft({ type: 'DRAFT_START', at: Date.now() }, actor);
    return;
  }

  if (cmd === 'skip') {
    dispatchDraft({ type: 'DRAFT_SKIP', at: Date.now() }, actor);
    return;
  }

  if (cmd === 'exit') {
    // 放弃这一局：走和顶栏「新对局」同一条路（它会顺带离开房间）
    handleAction('new-game', draftEl);
    toast('已退出选卡，可以重新配置开局');
  }

  if (cmd === 'refresh') void refreshDraftRoom();
}

/**
 * 「刷新房间状态」：把房间那一份硬拉下来。
 *
 * 这是联机选卡的逃生口。选卡每一步都要写房间，写失败之后本机会停在
 * 一份"房间里并不存在"的名单上，表现就是点哪张卡都没反应、或者一直
 * 显示"等对面"。自动轮询要等下一次、还得满足条件，玩家不该被迫等；
 * 点一下立刻对齐，然后重新出这一手。
 */
async function refreshDraftRoom(): Promise<void> {
  const seat = room;
  if (!seat) return;
  try {
    const snap = await fetchRoom(seat.code);
    if (!snap || room?.code !== seat.code) return;
    draftStuck = false;
    draftQueuedClick = null;
    takeSnapshot(snap);
    if (!snap.state.draft || snap.state.draft.phase === 'done') {
      afterDraft();
      toast('房间里的选卡已经完成了，直接开打');
      return;
    }
    toast(`已按房间对齐：${draftPhaseLabel(snap.state)}`);
  } catch (err) {
    toast(err instanceof Error ? err.message : '拉不到房间状态，检查网络');
  }
}

/**
 * 卡片详情浮层（悬停显示完整数据）。
 *
 * 最早只给选卡池用，现在产兵按钮也挂同一套：任何带 `data-hover-tip` 的宿主里
 * 放一份 `.hover-tip[hidden]` 数据，这里只负责"搬上来 + 定位"——一份数据、
 * 一处渲染逻辑，不用在两边各维护一份文案。
 *
 * 为什么不写在卡片里做 CSS 浮层：池子是 `overflow:auto` 的滚动容器，
 * 卡片内部的绝对定位浮层会被裁掉——最上面一排的详情直接看不见。所以这个节点
 * 挂在 body 上，位置按宿主的视口矩形算，指针事件全部穿透（`pointer-events:none`），
 * 免得它自己把 hover 打断。
 *
 * 宿主**不能是 disabled 按钮**：部分浏览器连鼠标事件都不派发，钱不够时反而
 * 看不到详情。选卡一直用 `.draft-card-wrap` 当宿主，产兵按钮也照此套一层 span。
 */
let hoverTipEl: HTMLElement | null = null;
let hoverTipHost: HTMLElement | null = null;

function hoverTipPanel(): HTMLElement {
  if (hoverTipEl) return hoverTipEl;
  const el = document.createElement('div');
  el.id = 'hover-tip';
  el.hidden = true;
  document.body.appendChild(el);
  hoverTipEl = el;
  return el;
}

function hideHoverTip(): void {
  if (hoverTipEl) hoverTipEl.hidden = true;
  hoverTipHost = null;
}

function showHoverTip(host: HTMLElement): void {
  const src = host.querySelector<HTMLElement>('.hover-tip');
  if (!src) return;
  const panel = hoverTipPanel();
  panel.innerHTML = src.innerHTML;
  panel.hidden = false;

  const r = host.getBoundingClientRect();
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  // 默认放上面（卡片多半在屏幕下半部分）；顶上放不下就翻到下面
  const above = r.top - ph - 8 >= 8;
  const top = above ? r.top - ph - 8 : r.bottom + 8;
  const left = Math.min(Math.max(8, r.left), Math.max(8, vw - pw - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.min(top, vh - ph - 8)}px`;
  hoverTipHost = host;
}

/** 所有 `data-hover-tip` 宿主共用的悬停：进出时搬运详情 */
function bindHoverTips(): void {
  const hostOf = (t: EventTarget | null): HTMLElement | null =>
    (t as HTMLElement | null)?.closest<HTMLElement>('[data-hover-tip]') ?? null;
  appEl.addEventListener('mouseover', (e) => {
    const host = hostOf(e.target);
    if (!host) {
      hideHoverTip();
      return;
    }
    if (host !== hoverTipHost) showHoverTip(host);
  });
  appEl.addEventListener('mouseout', (e) => {
    const host = hostOf(e.target);
    if (!host || host !== hoverTipHost) return;
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    // 在同一张卡内部移动（图标→文字）不算离开
    if (to && host.contains(to)) return;
    hideHoverTip();
  });
  // 滚动、点击、切走：浮层立刻收起来，别让它飘在旧位置上
  appEl.addEventListener('scroll', hideHoverTip, true);
  document.addEventListener('visibilitychange', hideHoverTip);


appEl.addEventListener('click', hideHoverTip, true);
}

/** 点兵种卡：按当前阶段决定是禁用还是选用 */
function onDraftClick(typeId: string): void {
  const view = draftView(state);
  if (!view) return;
  // 席位一律问 draftActor()：联机以房间为准，热座看交接
  const seat = draftActor();
  if (view.phase === 'ban') {
    // 轮流禁用：先看轮到谁，再看禁没禁满——顺序反过来会给出误导的提示
    if (view.banTurn && view.banTurn !== seat) {
      toast(`现在轮到${state.players[view.banTurn].name}禁用`);
      return;
    }
    const mine = seat === 'A' ? view.a : view.b;
    if (mine.banDone) {
      toast('你已经禁完了，等对面');
      return;
    }
    dispatchDraft({ type: 'DRAFT_BAN', unitId: typeId, at: Date.now() }, seat);
    return;
  }
  if (view.phase === 'pick') {
    if (view.toAct !== seat) {
      toast(`等${state.players[view.toAct ?? 'A'].name}选完`);
      return;
    }
    dispatchDraft({ type: 'DRAFT_PICK', unitId: typeId, at: Date.now() }, seat);
  }
}

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 2200);
}

/**
 * 战况烈度的红格在哪一回合已经被"出手"消费掉了。
 *
 * 记回合号而不是布尔：回合一变，旧值自然失效，不用额外挂钩子清理。
 * 撤回不撤销这个标记——玩家已经看过那份情报了，撤一步不该把它又翻出来。
 */
let heatDismissTurn: number | null = null;

/**
 * 刚刚这一手打出去的格子。
 *
 * 不另建账本：每次伤害本来就会被 `noteHeatCell` 记在**挨打方、当前回合**下
 * （溅射逐格各记一次，多段各记一次）。所以动作前后各拍一张记账快照、取差值，
 * 差出来的就是"这一下覆盖了哪"——普攻、溅射、攻城、剑气这类技能全自动覆盖，
 * 不必按动作类型逐个特判。
 *
 * 只要"这一下"，不留"这一回合"：留着就会和常驻的复盘红格抢同一个视觉位置，
 * 而那种"刚才打了哪"的复盘需求，回合结束后也一样没人看。
 */
let heatFlash: { cells: Map<number, number>; seq: number; until: number } | null = null;
let heatFlashTimer = 0;
let heatFlashSeq = 0;
/** 闪烁时长，与 CSS 里 `.fx-heat.flash` 的动画时长保持一致 */
const HEAT_FLASH_MS = 700;

/**
 * 对账：这一步比上一步多记了哪些格子。
 *
 * 差值本身由 `core/heat.ts` 的 `newHeatCells` 算（那边能直接测），
 * 这里只负责把它变成一个 0.7 秒的视觉事件。
 */
function noteStrikeFlash(before: GameState, after: GameState): void {
  const cells = newHeatCells(before, after);
  if (cells.size === 0) return;

  heatFlashSeq += 1;
  heatFlash = { cells, seq: heatFlashSeq, until: Date.now() + HEAT_FLASH_MS };
  if (heatFlashTimer) window.clearTimeout(heatFlashTimer);
  heatFlashTimer = window.setTimeout(() => {
    heatFlashTimer = 0;
    // 这期间又打了一下：那一手自己排了新的定时器，这里不要抢先收掉
    if (!heatFlash || Date.now() < heatFlash.until) return;
    heatFlash = null;
    render();
  }, HEAT_FLASH_MS + 16);
}

/**
 * 直接抹掉闪烁状态（连同定时器）。
 *
 * 换局、进房、退房时要调用：那批格子属于**上一张棋盘**，留到新局上会凭空
 * 亮一块红，看起来像是刚有人在那边挨了打。
 */
function dropHeatFlash(): void {
  heatFlash = null;
  if (heatFlashTimer) window.clearTimeout(heatFlashTimer);
  heatFlashTimer = 0;
}

function dispatch(action: Action): boolean {
  // 复盘里只能看：`state` 是别人那一局，往前走一步就是改写历史
  if (replay) {
    toast('复盘里只能看，要接着下先点「退出复盘」');
    return false;
  }
  /*
   * 教程的"讲解页"：先读完这一页，点了「继续」再动手。
   *
   * 不拦的话，第一步还没开始玩家就能自由走棋（教程卡片只是浮在上面），
   * 兵走偏了后面几步就全对不上。这里拦的是**所有**改局动作，包括面板上的按钮——
   * 屏幕上一个"看起来能按"的东西，按下去什么都不发生，比直接不让按更让人困惑。
   */
  if (tutorial.tutorialOn() && tutorial.tutorialBlocking()) {
    toast('先读完这一页，点「继续」再动手');
    return false;
  }
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
  const prevWinner = state.winner;
  planMovePath(state, action);
  const before = state;
  const result = applyAction(state, action);
  if (!result.ok) {
    pendingMovePath = null;
    toast(result.reason);
    return false;
  }
  if (result.irreversible) {
    // 这一步撤不回来（传送阵）：清空撤回栈。
    //
    // 为什么是"清空整个栈"而不是"只封这一步"：撤回是一摞快照，每一步存的都是
    // 它**之前**的整份状态。要"跳过这一步、保留更早的几步"根本做不到——更早的
    // 快照里灵石还在，装回去照样退款。所以只有两种可能：要么整摞作废，
    // 要么这一次施放白扣。战报里那句「传送阵撼动了时空结构」就是在说这件事。
    //
    // 清空之后本回合继续走子照旧可撤，只是撤不回传送之前——够用，也不会让
    // 手滑一次就锁死整回合。
    undoStack = [];
  } else {
    undoStack.push(state);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  state = result.state;
  // 这一下打到了哪：记账前后差出来的格子，闪一次就散（移动/招募差值为空，自然不闪）
  noteStrikeFlash(before, state);
  // 这一回合第一次出手：红格收起来。结束回合不算（那时已经轮不到自己看了）
  if (action.type !== 'END_TURN') heatDismissTurn = state.turn;
  noteHpDrops(before, state);
  if (action.type === 'ATTACK' || action.type === 'SIEGE') lastStrikerId = action.unitId;
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
      // 沙盒里没有"把设备交给对方"这回事：对面那一方交给 AI 走一个回合，
      // 或者（两边都归你时）直接把棋盘交给下一步。
      if (godMode()) {
        void godAfterTurn();
        return true;
      }
      // 轮到 AI 就让它接着走（双 AI 时会一直走回人类或分出胜负）
      if (isAiSide(state, state.current)) {
        void runAiLoop();
      } else if (!anyAiSide(state) && !tutorial.tutorialOn()) {
        // 只有两边都是人，才需要"把设备交给对方"。
        // 教程局也不弹：那一局的对面板由教程自己代按结束回合（见 ui/tutorial.ts），
        // 弹出「请把设备交给蓝方」会让新手以为要换人打。
        openHandoff();
      }
    }
    return true;
  }

  dirty = true;

  // 一出手就把这局判了（认输是唯一的一种）：联机里也要**立刻提交**。
  //
  // 不提交的话，对面要等到"轮到我"才去拉云端，而认输既不换人也不推进回合，
  // 于是赢的那一边一直停在旧局面上——输了的人已经看见结算卡，赢的人还在等下家。
  //
  // 三人四人局还有第二种情况：认输**不判胜负**（剩下的人接着打），所以
  // `state.winner` 是空的，上面这条根本不会触发——认输那一下从来没交上去过。
  // 表现就是：认输的人自己退出了，另外两家还当他在打，行动权一直卡在他身上，
  // 整个房间等到超时。所以退出名单变长也要立刻提交。
  const quitNow = (state.out ?? []).length > (before.out ?? []).length;
  if (room && (quitNow || (!prevWinner && state.winner))) {
    dirty = false;
    void pushTurn(
      room,
      prevTurn,
      quitNow ? '你已认输，剩下的两家接着打' : '这一局已结束，结果已经同步给对方',
    );
  }

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
  // 撤回来的这一步没有"刚刚打过"这回事：闪着的格子跟着一起撤掉
  dropHeatFlash();
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
  /*
   * **只收当前这张图上的单位**。
   *
   * `unitsAt` 是按坐标算的，不认识"图"：月球上的兵在 (5,5)，地球的 (5,5)
   * 也会把它找出来。于是玩家在地球点一下那个空格，就选中了月球上的那支兵，
   * 之后的走子指令全按地球坐标下——月球的兵在地球上走，对面还看不见它。
   * 这个幽灵就是这么来的（2026-11-10 实机反馈）。
   */
  const list = unitsAt(view, x, y).filter((u) => boardIdOf(u) === activeBoardId).slice();
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
  const moverDef = mover ? utype(state, mover.type) : null;
  // "水挡不挡它"要按兵种问：飞行/掠水的兵点水面时，以前也会被告一句
  // "水面对陆军不通"——它明明过得去，只是这一格不在移动力范围内。
  const canEnterWater = moverDef ? terrainWalkable(moverDef, 'water') : false;
  if ((tile?.terrain === 'water' || tile?.terrain === 'deep') && !canEnterWater) {
    return tile.terrain === 'deep'
      ? '深水架不了桥：陆军过不去，只能靠船或飞行'
      : '水面对陆军不通：要么从桥上过，要么换成水军';
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
 * 放完一次技能之后，还能不能接着放同一个。
 *
 * 两个条件缺一不可：
 *   · 技能声明了 `multiCast` —— 没声明的技能，`doHeroSkill` 的 `skillTurn`
 *     会拒掉同一回合的第二次；
 *   · `heroSkillsOf` 说它 `ready` —— 冷却、充能、`SKILL_READY_CHECKS`
 *     全都走这一条。剑气纵横就靠最后那一项：攻击次数没打完才 ready。
 *
 * 修的是"每次放完技能都掉回普通操作"这件事。高等级剑修一回合能挥好几下，
 * 每下都要重新点技能按钮再点方向，太碎了。放完还 ready 就留在瞄准模式里，
 * 下一发直接点方向。
 */
function canRepeatSkill(unitId: string, skillId: string): boolean {
  const u = state.units.find((x) => x.id === unitId);
  if (!u) return false;
  const info = heroSkillsOf(state, u).find((k) => k.def.id === skillId);
  if (!info) return false;
  return info.def.multiCast === true && info.ready;
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
    if (u.owner === me() && isProducer(utype(state, u.type))) selectCamp(u);
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
  /*
   * 别的图（月球、以后的空间站）现在只做到"点得中、看得见"。
   *
   * 走子 / 开火 / 建造整条链路都按**地球**的坐标与宽度算（`idx()` 认的是
   * `state.w`），在 12×12 的月球上点 (3,4) 会被当成地球的 (3,4) 去执行。
   * 所以这里只做选中：选中之后侧栏那张属性卡是真的（它读的是单位自己），
   * 面板里的按钮也照常能用——发射井的加注/发射就是在这条路上跑的。
   */
  if (activeBoardId !== EARTH) {
    const at = coordsFromEvent(e);
    if (!at) return;
    const id = activeBoardId;
    const board = boardOf(state, id);
    if (at.x < 0 || at.y < 0 || at.x >= board.w || at.y >= board.h) return;

    /*
     * 别的图（目前是月球）的点击：**建造选址 → 走子 → 选中**。
     *
     * 顺序和地球那条一致。这里没有攻击/攻城/技能选点——月面战斗还没做
     * （见 refreshSelection 里的说明），所以那几种点击后面会落到"选中/取消"。
     */
    if (buildPlan) {
      const plan = buildPlan;
      const built = dispatch({
        type: 'BUILD',
        unitId: plan.unitId,
        unitType: plan.type,
        x: at.x,
        y: at.y,
      });
      if (built) buildPlan = null;
      refreshSelection();
      render();
      return;
    }

    const here = state.units.filter((u) => boardIdOf(u) === id && coversTile(state, u, at.x, at.y));
    // 和地球那条一致：兵压在建筑上面，先选兵
    const pick =
      here.filter((u) => state.unitTypes[u.type]?.category !== 'building').at(-1) ?? here.at(-1);

    // 点空地、手上又选着自己的人：下移动命令（走不走得通由规则层说）
    if (!pick && selectedId) {
      const sel = state.units.find((u) => u.id === selectedId);
      if (sel && sel.owner === me() && boardIdOf(sel) === id && !sel.acted) {
        if (dispatch({ type: 'MOVE', unitId: sel.id, x: at.x, y: at.y })) return;
      }
    }

    selectedId = pick?.id ?? null;
    selectedCityId = null;
    selectedTile = null;
    aimTiles = [];
    skillThreatTiles = [];
    refreshSelection();
    if (!pick && !selectedId) {
      const tile = board.tiles[at.y * board.w + at.x];
      if (tile) toast(TERRAIN_NAMES[tile.terrain] ?? tile.terrain);
    }
    render();
    return;
  }

  /*
   * 复盘里点棋盘只有一个意思：**看看这个兵现在是什么样**。
   *
   * 走子/开火那条路整段跳过——`state` 是历史帧，改它就等于篡改别人的对局。
   * 只保留选中，因为"这一步它为什么这么走"十有八九要从属性卡上的
   * 光环、加成、剩余行动次数里找答案。
   */
  if (replay) {
    const at = coordsFromEvent(e);
    if (!at) return;
    const here = stackAt(at.x, at.y);
    if (here.length > 0) {
      selectedId = here[here.length - 1]!.id;
      selectedCityId = null;
    } else {
      /*
       * 城里没站兵的那几格要能点开城。
       *
       * 复盘最常问的一句是"这一步它为什么不敢压上去"，答案往往在城的耐久和
       * 时代上（攻城伤害 = 攻击 − 护甲）。而城不是单位，不在这条 `stackAt` 里，
       * 不单独认一下的话，城市卡在复盘里永远打不开。
       */
      const city = cityAt(state, at.x, at.y);
      selectedId = null;
      selectedCityId = city?.id ?? null;
      selectedTile = city ? null : at;
    }
    // 只换选中，不重算可达格/目标：那两样会让棋盘看起来像能操作
    reach = [];
    targets = [];
    siege = [];
    render();
    return;
  }
  if (state.config.godMode === true) {
    // 摆放档：这里点棋盘是"落子"，不是"走子"。走子那套判断（轮到我吗、
    // 这格可达吗、能不能开火）在纯沙盒里一条都不成立，整块交出去。
    if (!godInControl()) {
      onGodClick(e);
      return;
    }
    // 操控档：下面落到正常那一套（选中、走子、开火、强制移动全都照旧）。
    // 借的只有一样——`me()`：上帝模式里它返回"当前行动方"，正好就是你要走的那一方。
    if (godRunning || godPassing) {
      toast(godRunning ? 'AI 正在打，先按「停止」' : '对面那一边在走，等它走完');
      return;
    }
    if (!godMyTurn()) {
      toast(`现在是${state.players[state.current].name}（AI）的回合，等它走完`);
      return;
    }
    // 上一次"交给 AI"那句结论到这儿就过期了：局面马上就要被你自己改。
    // 不清的话它会一直占着状态行，把刚加的"这支兵还剩什么"压住。
    if (godResult) {
      godResult = '';
      godSig = '';
    }
    // 空手点空地＝"看看这儿是什么"：沙盒里这比"取消选中"常用得多。
    // 只在**手上没选中任何东西**时提示——手上有一支兵的时候，点别处
    // 几乎总是"想走到那儿"，这时候弹地形名就是噪声。
    const probe = coordsFromEvent(e);
    if (!selectedId && probe && !cityAt(state, probe.x, probe.y)) {
      if (stackAt(probe.x, probe.y).length === 0) {
        const tile = state.tiles[idx(state, probe.x, probe.y)];
        if (tile) toast(TERRAIN_NAMES[tile.terrain] ?? tile.terrain);
      }
    }
  }
  if (handoffOpen || state.winner) return;

  const coords = coordsFromEvent(e);

  // 0.1) 正在等待技能选点
  if (pendingSkill && coords) {
    const cell = idx(state, coords.x, coords.y);
    const { unitId, skillId, targeting } = pendingSkill;
    const caster = state.units.find((u) => u.id === unitId);
    // 点自己脚下：全图选点时当作"取消"。技能那边会把"落点 = 自己"判成过载并
    // **照扣灵石**，玩家手一抖点到自家阵上就白亏 10 灵石，没必要。
    const onSelf = !!caster && caster.x === coords.x && caster.y === coords.y;

    // 选点型技能（传送阵）：地图上任意一格都是合法落点；方向型只认四邻热区。
    // 判定放在 skill-aim.ts 里，测试能直接把两种技能的规则钉住。
    const picked = skillTargetPicked({ targeting, onSelf, aimTiles, cell });

    if (picked) {
      const ok = dispatch({
        type: 'HERO_SKILL',
        unitId,
        skillId,
        targetX: coords.x,
        targetY: coords.y,
      });

      // 放完之后还放不放得出去：
      //   · 成功 + 还能连发（multiCast）→ 留在瞄准模式，下一发直接点方向
      //   · 成功 + 次数/冷却已经不够     → 退出，回到普通操作
      //   · 失败（dispatch 已经 toast 了原因）→ 也退出，别让玩家困在一个必然失败的模式里
      if (!(ok && canRepeatSkill(unitId, skillId))) {
        pendingSkill = null;
      }
    } else {
      // 方向型点到 4 格之外、或全图选点点到自己脚下：取消施法
      pendingSkill = null;
      toast('已取消施法');
    }
    refreshSelection(); // 恢复常规的移动/攻击高亮
    render();
    return; // 阻断后续的逻辑
  }

  // 0.15) 正在等待设备选点（弹射钩索）
  if (pendingDevice && coords) {
    const { unitId, deviceId } = pendingDevice;
    pendingDevice = null;
    const self = state.units.find((x) => x.id === unitId);
    // 点回自己脚下 = 放弃：钩索"落点等于原地"本来就是非法目标，
    // 与其让规则层回一句"已经在那一格了"，不如当取消。
    if (self && coords.x === self.x && coords.y === self.y) {
      toast('已取消');
    } else {
      dispatch({ type: 'USE_DEVICE', unitId, deviceId, x: coords.x, y: coords.y });
    }
    refreshSelection();
    render();
    return;
  }

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
      dispatch({
        type: 'ATTACK',
        unitId: forcedFrom,
        targetId: hit.id,
        x: coords.x,
        y: coords.y,
      });
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
  // 桥不用修饰键了：桥面可达时直接点就算"走上去"（见 1.2），因为桥没有
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

  // 1.2) 点在**可达的桥面**上：桥是"能站的地形"，不是一个等着被选中的物件。
  //
  // 桥在数据上是一枚建筑棋子（bridges 标记 + 把水格改成桥面），所以直接点
  // 永远是"选中这座桥"，或者——更糟——"打这座桥"。于是别人的桥修好了却只能
  // 隔着河干看：桥明明在可达范围里，点上去了却变成开火，永远站不上那座桥。
  //
  // 必须排在下面那段"只读查看"**之前**：不能开火的单位（工人、商队、工程队）
  // 打不出 targets，于是点敌桥永远落到"查看这座桥"上，它们照样过不了河。
  //
  // 优先级给"走过去"，理由有三条：
  //   1. 桥没有自己的操作面板（塔和军营才有），选中它本来就做不了任何事；
  //   2. "过河"是这个格子上唯一常用的动作，攻击是可以换一种点法的；
  //   3. 射程放开之后（远程也能打桥），不改的话敌桥几乎永远在 targets 里，
  //      等于把"站上敌桥"这个玩法彻底关掉。
  //
  // 想拆桥：按住 Shift 点（强制攻击），或者走到射程内用强制攻击模式。
  // 其余动词各管各的：正在选址就不抢（那一下是"盖在这儿"），装卸上膛时同理。
  const walkable = coords ? idx(state, coords.x, coords.y) : -1;
  const bridgeWalk =
    myTurn() && !watching() && !state.config.commanderMode &&
    coords && selectedId && !wantAttack && !buildPlan && !loadPlan && !unloadPlan &&
    reach.includes(walkable)
      ? stackAt(coords.x, coords.y).find((u) => utype(state, u.type).bridges)
      : undefined;
  if (bridgeWalk && coords && selectedId) {
    dispatch({ type: 'MOVE', unitId: selectedId, x: coords.x, y: coords.y });
    // 敌桥既能走又能打，两种点法差一个 Shift——不说一句，玩家会以为"打不了"
    if (bridgeWalk.owner !== me()) toast('走上桥面了。想拆这座桥：按住 Shift 点它');
    return;
  }

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
      dispatch({
        type: 'ATTACK',
        unitId: selectedId,
        targetId: stacked.id,
        x: coords.x,
        y: coords.y,
      });
      return;
    }
  }

  // 1) 点到了攻击目标
  if (clickedUnitId && selectedId && targets.includes(clickedUnitId)) {
    dispatch({
      type: 'ATTACK',
      unitId: selectedId,
      targetId: clickedUnitId,
      x: coords?.x,
      y: coords?.y,
    });
    return;
  }

  // 1.5) 装卸模式：这两件事优先于"选中单位"
  if (loadPlan) {
    const ferry = state.units.find((u) => u.id === loadPlan);
    const cargo = clickedUnitId ? state.units.find((u) => u.id === clickedUnitId) : null;
    /*
     * 贴身按**占地**算，不是锚点：2×2 的发射井锚点在左上角，
     * 站在它右下角旁边的兵，锚点距离是 3。规则层早就改过来了（doLoad 用的是
     * distBetweenUnits），这里漏改，玩家按下去只会听到"点一个贴着船的己方陆军"。
     */
    if (
      ferry &&
      cargo &&
      cargo.owner === ferry.owner &&
      distBetweenUnits(state, ferry, cargo) === 1
    ) {
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
    if (ferry?.cargo?.length && coords && distToUnit(state, coords, ferry) === 1) {
      const cargoId = ferry.cargo[0]!.id;
      const ok = dispatch({
        type: 'UNLOAD',
        unitId: ferry.id,
        cargoId,
        x: coords.x,
        y: coords.y,
      });
      unloadPlan = null;
      // 加强渡船：下船之后那个兵还能动（本回合没行动过的话），
      // 顺势把它选中——否则玩家看到的是"人都上岸了，但什么事都做不了"，
      // 得再点一次才知道它其实还亮着。
      const landed = ok ? state.units.find((u) => u.id === cargoId) : undefined;
      if (landed && landed.acted === false) selectUnit(landed);
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
      //
      // 沙盒例外：那边侧栏是货架，没有产兵面板可开，`selectCamp` 等于
      // "点了没反应"。改成普通选中——至少棋盘上会亮出一个选中框，
      // 让人知道这一下确实点到了东西。
      if (u.owner === me() && isProducer(utype(state, u.type)) && !godMode()) selectCamp(u);
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
    dispatch({
      type: 'SIEGE',
      unitId: selectedId,
      cityId: city.id,
      x: coords.x,
      y: coords.y,
    });
    return;
  }

  // 4) 可达格 → 移动（自己的城市格也算普通可走格）
  if (selectedId && reach.includes(cell)) {
    /*
     * 教程的"走过去"那一步只放行**走完能贴着对手**的格子。
     *
     * 不放行的话，玩家走反了就会卡住：下一步是"打他"，而教程不倒退。
     * 与其在文案里喊"请往右上走"，不如直接把别的格子拦在门外。
     */
    if (tutorial.tutorialOn() && !tutorial.tutorialAllowsMove(state, coords.x, coords.y)) {
      toast('这一课只学一步：走到那个农民旁边（亮着的格子）');
      return;
    }
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
  return currentReport();
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

/**
 * 战报卡：一局打完才给。
 *
 * 用的是**当前**的 state（不是给系统看的那份报告）：卡面写的是"你这一局发生了什么"，
 * 两边字段故意不共用，免得为了报表好看去改玩家看到的话。
 */
function openBattleCardFlow(): void {
  if (!state.winner) {
    toast('这局还没分出胜负，打完再来看');
    return;
  }
  openBattleCard(buildBattleCard(state, me(), BUILD_VERSION), document.body, {
    onCopied: () => toast('战报文字已复制'),
  });
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
  // 复盘控件先处理：它在"对局已经结束/不该能操作"的时候仍然要能按，
  // 所以不能跟着下面那堆对局动作一起被挡掉
  if (act.startsWith('rp-')) {
    handleReplayAction(act, el);
    return;
  }
  /*
   * 复盘里除了"看"，别的对局动作一律不接。
   *
   * 不能只靠 `dispatch` 那道闸：侧栏里有一半按钮根本不走 dispatch
   * （撤回直接弹 undoStack、联机直接换 state、参谋部直接排队列）。
   * 逐个去堵必然漏，所以在这儿统一拦——只放行和"改这一局"无关的事：
   * 规则书、反馈、回首页，以及装这三件的「设置」弹窗本身
   * （它里面的「导出」由 settingsHtml 的 replay 参数自己收起来）。
   */
  if (replay) {
    const harmless = act === 'manual' || act === 'feedback' || act === 'new-game' || act === 'settings';
    if (!harmless) {
      toast('复盘里只能看，要接着下先点「退出复盘」');
      return;
    }
    // 回首页之前先把那一局还回去：不还原的话，首页后面躲着的是一份别人棋的副本
    if (act === 'new-game') exitReplay();
  }
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

    case 'order-add': {
      // 指挥官模式：产兵面板上的按钮不再是"立刻造"，而是"排进队列"
      enqueueOrder(el.dataset.type ?? '', el.dataset.site ?? '');
      return;
    }

    case 'end-turn':
      dispatch({ type: 'END_TURN' });
      return;

    /*
     * 指挥官模式里"推进游戏"只有一个意思：**打完一批再交还**。
     *
     * 底栏那颗按钮（以前是「结束行动，交给对方」）和顶栏的「交给 AI」都指到这里。
     * 三条入口（还有参谋部那颗「执行 5 回合」）做同一件事，就不会出现
     * "我顺手点了结束行动，于是只走了半批、对面看到的回合数和我这边对不上"。
     */
    case 'commander-run':
      void runCommanderBatch();
      return;

    // 热座：交自己这一份。交完还差对面就只换人；两边齐了就开始轮流推进
    case 'plan-commit': {
      commitPlan();
      return;
    }

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

    /*
     * 顶栏那颗"铃声：60% → 80% → 0 → 60%"的循环按钮已经拆了（2026-11-11），
     * 音量改在「设置」里用滑块调，那才是"调一个连续量"该有的样子。
     * 原来那个 case 留在这儿只会变成第二条没人管的设置路径。
     */

    case 'surrender': {
      // 认输是不可逆的，必须问一句
      if (!window.confirm('确认认输？这一局会直接判负，且不能撤回。')) return;
      dispatch({ type: 'SURRENDER' });
      return;
    }

    case 'launch': {
      if (!selectedId) return;
      dispatch({ type: 'LAUNCH', unitId: selectedId });
      refreshSelection();
      return;
    }

    case 'recover': {
      const planeId = el.dataset.plane;
      if (!selectedId || !planeId) return;
      dispatch({ type: 'RECOVER', unitId: selectedId, planeId });
      refreshSelection();
      return;
    }

    case 'mount': {
      const mod = el.dataset.mod;
      if (!selectedId || !mod) return;
      dispatch({ type: 'MOUNT', unitId: selectedId, moduleId: mod });
      refreshSelection();
      return;
    }

    case 'unmount': {
      const mod = el.dataset.mod;
      if (!selectedId || !mod) return;
      dispatch({ type: 'UNMOUNT', unitId: selectedId, moduleId: mod });
      refreshSelection();
      return;
    }

    // 用设备。要选落点的那一种（弹射钩索）先进入"等玩家点地图"的状态，
    // 其余的直接结算：整备臂的目标是"相邻友军"，按钮本身就是按友军各出一个，
    // 所以 `data-target` 已经带上了目标 id。
    case 'use-device': {
      const mod = el.dataset.mod;
      if (!selectedId || !mod) return;
      const target = el.dataset.target;
      if (target) {
        dispatch({ type: 'USE_DEVICE', unitId: selectedId, deviceId: mod, targetId: target });
        refreshSelection();
        return;
      }
      const u = state.units.find((x) => x.id === selectedId);
      const kind = u ? MODULES[mod]?.device : undefined;
      if (kind && deviceTargetOf(kind) === 'tile') {
        pendingDevice = { unitId: selectedId, deviceId: mod };
        toast('在地图上点一个 3 格内的空地作为落点');
        refreshSelection();
        render();
        return;
      }
      dispatch({ type: 'USE_DEVICE', unitId: selectedId, deviceId: mod });
      refreshSelection();
      return;
    }

    case 'recharge': {
      if (!selectedId) return;
      dispatch({ type: 'RECHARGE', unitId: selectedId });
      refreshSelection();
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

      // 去兵种表里查出这个技能的原始数据
      const unit = state.units.find(u => u.id === unitId);
      /*
       * 必须查 `skillsOf`（兵种表 + 学来的），不能只查 `def.skills`：
       * "学来的法术"只存在单位的 `extraSkills` 里，兵种表上根本没有。
       * 只查兵种表的话，一个 `targeting: 'point'` 的法术会被当成"不需要选点"
       * 直接派发出去——点一下按钮就白放，而且永远点不到目标。
       */
      const skillDef = unit ? skillsOf(state, unit).find(s => s.id === skillId) : null;

      // 如果数据里声明了需要选点/选方向，就进入等待状态
      if (skillDef && (skillDef.targeting === 'point' || skillDef.targeting === 'direction')) {
        // 先确认它现在放得出去，再进瞄准模式。
        // 旧代码直接进——攻击次数用完之后点技能按钮，会进到一个"点哪都失败"
        // 的模式里。以前这个问题很轻（点一次失败就退回普通操作），现在
        // 连发模式要和它共存，就必须把这道门先关上。
        if (unit && !heroSkillsOf(state, unit).find(k => k.def.id === skillId)?.ready) {
          toast(skillDef.notReadyReason ?? `${skillDef.name} 现在还不能放`);
          return;
        }
        const targeting = skillDef.targeting === 'point' ? 'point' : 'direction';
        pendingSkill = { unitId, skillId, targeting };
        refreshSelection(); // 刷新高亮
        toast(
          targeting === 'point'
            ? skillDef.irreversible
              ? '点击地图上任意位置作为落点（点自己脚下取消）；这一次施放撤不回来'
              : '点击地图上任意位置作为落点（点自己脚下取消）'
            : '请在地图上点击要施放的方向',
        );
        render();
        return;
      }

      // 没声明需要选点，或者找不到数据，维持原来的直接释放
      dispatch({ type: 'HERO_SKILL', unitId, skillId });
      render();
      return;
    }

    case 'unit-action': {
      // 扩展声明的单位操作（学法术、遗忘法术……）。核心不解释 actionId，
      // 只把它和单位 id 一起派发给规则层，由扩展的 onUnitAction 处理。
      const id = el.dataset.id;
      const actionId = el.dataset.action;
      if (!id || !actionId) return;
      // 破坏性操作（遗弃法术……）由扩展在按钮上声明确认文案，核心只负责弹
      const confirmText = el.dataset.confirm;
      if (confirmText && !window.confirm(confirmText)) return;
      // dispatch 自己会 toast 失败原因，这里只管发
      dispatch({ type: 'UNIT_ACTION', unitId: id, actionId });
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
      if (!ferry || !holdOf(state.unitTypes[ferry.type])) return;
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

    case 'board-view': {
      const id = el.dataset.id ?? '';
      // 点一下钉住、再点取消。钉住那一刻顺手清掉 hover：鼠标还停在 chip 上，
      // 不清的话"取消"会立刻被 hover 重新点亮，看起来像点不动。
      boardViewPinned = boardViewPinned === id ? null : id;
      boardViewHover = null;
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
      if (state.config.commanderMode === true && !room) {
        // 指挥官模式：这一方的走位本来就归 AI，"交给 AI"没有别的意思可讲。
        // 当成"执行一批"处理，顺手点错也不会把对面也丢给 AI。
        void runCommanderBatch();
        return;
      }
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
      // 四个席位都写一遍：这一局没坐人的席位也留着 false，别让 AI 接管空座
      const next = {
        A: isAiSide(state, 'A'),
        B: isAiSide(state, 'B'),
        C: isAiSide(state, 'C'),
        D: isAiSide(state, 'D'),
      };
      next[p] = nowAi;
      state.aiControl = next;
      // 收回操作权要立刻掐掉正在跑的循环，否则它会把这一回合走完
      aiToken += 1;
      aiPaused = false;
      clearSelection();
      saveMatch(state);
      render();
      toast(
        nowAi
          ? `${state.players[p].name}交给 ${aiNameOf(state)}托管`
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

    case 'settings': {
      openSettings();
      return;
    }

    case 'manual': {
      openManualFlow();
      return;
    }

    case 'unit-editor': {
      // 顶栏这颗按钮已经挪到首页（2026-11-04）。分支留着：首页的入口
      // 走的是同一个 openUnitEditor，两处语义必须一致。
      openUnitEditor(() => render());
      return;
    }

    case 'feedback': {
      // 随时可拍：这时候棋可能还没打完，找 bug 要的就是"当时那一刻"
      openFeedbackPanel({
        current: () => state,
        timeline: () => (recorder ? sealTimeline(recorder) : null),
      });
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
      /*
       * 复盘期间不许导出。
       *
       * `exportMatch(state)` 导的是**当前**局面，而复盘期间 `state` 是别人那一局的
       * 某一帧。这条路径原来没有闸门，于是"看着别人的棋点导出"发出去的是别人那局，
       * 而玩家以为那是自己的。顶栏那颗按钮在复盘里已经藏起来了，这里再拦一道：
       * 入口将来多一个（快捷键、菜单），不会因为忘了藏就漏。
       */
      if (replay) {
        toast('复盘里导出的是别人的棋：先点复盘条上的「退出」，回到你那局再导');
        return;
      }
      const text = exportMatch(state);
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast('对局已复制到剪贴板，可以直接发给对方'))
        .catch(() => window.prompt('复制下面的内容发给对方：', text));
      return;
    }

    case 'import': {
      // 顶栏这颗按钮也挪到首页了，分支留作同一条实现（见 importMatchFlow）
      importMatchFlow();
      return;
    }

    case 'new-game': {
      // 复盘里先退出来：首页那层会把棋盘盖住，但 `replay` 还挂着，
      // 点「继续上一局」回来时 `state` 和 `replayIndex` 就对不上了。
      if (replay) exitReplay();
      // 不再直接换一局：回家，由首页的「开始对局」统一开门。
      // 顺手暂停 AI——棋盘还在下面，别让它在没人看的时候接着下。
      showTitle({ pauseAi: true });
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
      // 「我打这一方」跟着「摆给」走：换边摆的时候，操控的那一方也跟着换，
      // 否则会出现"摆给蓝方、却还在走红方"，两件事对不上
      godSig = '';
      clearSelection();
      render();
      // 新这一边如果正轮到它就没事；轮到对面就让人家先把这一步走完
      if (godPlay === 'me' && state.current !== godSide) void godAfterTurn();
      return;
    }

    // 操控档：谁亲手走。和上面的笔刷是两件事——笔刷决定"点下去放什么"，
    // 这一组决定"点下去是走子还是落子"
    case 'god-play': {
      const mode = el.dataset.play;
      godPlay = mode === 'me' ? 'me' : mode === 'both' ? 'both' : null;
      godSig = '';
      // 切档就把上一轮的结论收掉：那句话说的是"上一次 AI 打完的样子"，
      // 而你现在要自己动手了，留着它只会盖住手上这支兵的血量
      godResult = '';
      clearSelection();
      render();
      // 接管时正轮到对面：让它先把这一步走完。不然「我打红方」按下去，
      // 棋盘上一个能点的兵都没有，看着像没生效
      if (godPlay === 'me' && state.current !== godSide) void godAfterTurn();
      return;
    }

    case 'god-end-turn': {
      // 对面在走时按不动：那一个回合不归你收尾
      if (!godMyTurn() || state.winner) return;
      dispatch({ type: 'END_TURN' });
      return;
    }

    case 'god-quick': {
      saveGodQuick(!godQuick);
      // 签名作废，否则那一行提示（"空格 = 结束回合" / "打开后可用…"）不会跟着变
      godSig = '';
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

    case 'battle-card':
      openBattleCardFlow();
      return;

    case 'recruit-pack': {
      const p = el.dataset.pack ?? '';
      recruitPack = recruitPack === p ? '' : p;
      render();
      return;
    }

    // 空结果里那颗「清掉筛选」：一次把三个维度都放回全部
    case 'recruit-clear': {
      recruitQuery = '';
      recruitPack = '';
      recruitEra = 0;
      render();
      return;
    }

    // 时代的切换规矩和扩展包一致：再点一次当前那一档＝回到全部
    case 'recruit-era': {
      const v = Number(el.dataset.era ?? 0);
      recruitEra = recruitEra === v ? 0 : v;
      render();
      return;
    }

    // ---------- 框选之后的批量操作（2026-11-10） ----------
    //
    // 每个 case 都是"纯函数算新状态 → godBatchApply 压一次撤销 → toast 报数"。
    // 报数不是客套：刷一片地形里有城会被跳过，不说清楚玩家会以为漏刷了。
    case 'god-batch-del': {
      if (!godRect) return;
      const r = deleteUnitsInRect(state, godRect);
      if (!r.ok) {
        toast(r.reason);
        return;
      }
      godBatchApply(r.state, `删除 ${r.removed} 个单位（城留着）`);
      return;
    }

    case 'god-batch-terrain': {
      if (!godRect) return;
      // 手上没地形笔刷就刷成平原：沙盒里最常做的是"把这片推平"
      const t: Terrain = godBrush.kind === 'terrain' ? godBrush.terrain : 'plain';
      const r = paintRect(state, godRect, t);
      if (!r.ok) {
        toast(r.reason);
        return;
      }
      godBatchApply(
        r.state,
        `刷上${CONFIG.terrainName[t]} ${r.painted} 格${r.skipped > 0 ? `（跳过 ${r.skipped} 格：城 / 有兵 / 已经是这个地形）` : ''}`,
      );
      return;
    }

    case 'god-batch-fill': {
      if (!godRect) return;
      // 手上没兵种笔刷就填民兵：它是货架上的第一格，也是"凑一支队伍"的默认
      const type = godBrush.kind === 'unit' ? godBrush.type : 'militia';
      const r = fillUnitsInRect(state, godRect, godSide, type);
      if (!r.ok) {
        toast(r.reason);
        return;
      }
      const name = state.unitTypes[type]?.name ?? type;
      const tail = r.capped
        ? '（到上限，没放完）'
        : r.skipped > 0
          ? `（${r.skipped} 格站不下）`
          : '';
      godBatchApply(r.state, `放下 ${r.placed} 个${name}${tail}`);
      return;
    }

    case 'god-shift': {
      if (!godRect) return;
      const dx = Number(el.dataset.dx ?? 0);
      const dy = Number(el.dataset.dy ?? 0);
      const r = translateUnitsInRect(state, godRect, dx, dy);
      if (!r.ok) {
        toast(r.reason);
        return;
      }
      // 选区跟着走一格，才能连着按：挪完还框着同一批人
      godRect = {
        x0: Math.max(0, Math.min(state.w - 1, godRect.x0 + dx)),
        y0: Math.max(0, Math.min(state.h - 1, godRect.y0 + dy)),
        x1: Math.max(0, Math.min(state.w - 1, godRect.x1 + dx)),
        y1: Math.max(0, Math.min(state.h - 1, godRect.y1 + dy)),
      };
      godBatchApply(r.state, `整体平移 ${r.moved} 个单位`);
      return;
    }

    case 'god-sel-clear': {
      godRect = null;
      godSig = '';
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

    // 货架按时代切：同一套手感，再点一次回到「全部时代」
    case 'god-era': {
      const v = Number(el.dataset.era ?? 0);
      godEra = godEra === v ? 0 : v;
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

    /*
     * 上传这张图：沙盒 → 云端地图库（待审核）。
     *
     * 不在这里直接传：地图名要人填，折算和校验的结果也要先说清楚。
     * 弹窗负责那三句话，这里只负责把当前局面递过去。
     */
    case 'god-map-upload': {
      if (godRunning || godPassing) {
        toast(godRunning ? 'AI 正在打，先按「停止」' : '对面那一边在走，等它走完');
        return;
      }
      openMapUpload({ state });
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
    if (!anyAiSide(state) && !tutorial.tutorialOn()) {
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
/**
 * AI 引擎按需加载。
 *
 * 引擎有 35KB（威胁图、换子价值、三套战术），而**首屏一帧都用不到它**：
 * 开局只回答"这一方是不是 AI"。所以它被挪到第一次真的要它走子的时候再拉。
 *
 * 代价是 AI 的第一步会多等一次网络（本地缓存后为 0），而这一步本来就
 * 被 `AI_SPEED_MS` 故意放慢了——玩家看到的是它照常在思考。
 */
let aiEnginePromise: Promise<typeof import('./core/ai.ts')> | null = null;
function aiEngine(): Promise<typeof import('./core/ai.ts')> {
  aiEnginePromise ??= import('./core/ai.ts');
  return aiEnginePromise;
}

/**
 * 测试 AI 的内核（策略网络）。
 *
 * 和手写引擎一样按需加载，但**分成两块**：
 *   · 代码（编码器 + 合法动作枚举 + 前向）约 40KB，跟着 `import()` 走；
 *   · 权重 175KB，第一次真要用它走子时才 fetch。
 * 绝大多数玩家一辈子用不到测试 AI，那 215KB 就不该进首屏。
 */
let netBrainPromise: Promise<typeof import('./rl/brain.ts')> | null = null;
function netBrain(): Promise<typeof import('./rl/brain.ts')> {
  netBrainPromise ??= import('./rl/brain.ts');
  return netBrainPromise;
}

/**
 * 网络那一侧的随机流：**一局一家一条**，从种子派生。
 *
 * 不能每回合新建一条：那样每个回合的第一个采样都会拿到同一个随机数，
 * 策略会稳定地偏爱同一个分支。也不能用 Math.random：存档、回放、
 * 双 AI 观战都得重跑出同一局。
 */
const netRands = new Map<string, () => number>();
function netRandFor(seed: number, seat: 'A' | 'B', make: (n: number) => () => number): () => number {
  const key = `${seed}:${seat}`;
  let r = netRands.get(key);
  if (!r) {
    // 只留最近两局：长会话里一直往里塞会慢慢吃内存
    if (netRands.size > 8) netRands.clear();
    r = make((seed * 2654435761 + (seat === 'A' ? 1 : 2)) >>> 0);
    netRands.set(key, r);
  }
  return r;
}

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
  const rejected = new Set<string>();
  const engine = await aiEngine();

  /*
   * 网络内核：只在 `config.aiBrain === 'net'` 时加载。
   *
   * 加载失败**不中断这一局**——退回手写 AI 并说明一句。让玩家在"点了测试 AI"
   * 之后面对一局卡死的棋，比"这一局先用普通 AI"糟得多。
   *
   * 指挥官模式**不认**它：那个模式的核心是"玩家点名这一格造哪个兵、在哪造"，
   * 而策略网络只认局面，不认 `budget.order`（训练口径里根本没有这个字段）。
   * 让它上，队列就变成了摆设，玩家排的计划一条也不会被执行。
   */
  let brain: typeof import('./rl/brain.ts') | null = null;
  let netPolicy: import('./rl/policy.ts').Policy | null = null;
  if (state.config.aiBrain === 'net' && !state.config.commanderMode) {
    brain = await netBrain();
    netPolicy = await brain.loadNetPolicy();
    if (!netPolicy) {
      toast(`测试 AI 没加载起来（${brain.netLoadError() ?? '未知原因'}），这一局先用普通 AI`);
    }
  }

  for (let step = 0; step < engine.AI_MAX_STEPS; step++) {
    if (!alive()) return;
    // 打完了就别再摆弄部队：只收手，不 return——这一回合还得正常交割，
    // 否则 state.current 会停在半路，沙盒的"轮到谁"和回合数都对不上。
    if (stopWhen?.()) break;
    // 有网络内核就用它；没有（或加载失败）就退回手写 AI
    const action =
      brain && netPolicy
        ? brain.netNextAction(
            state,
            player,
            netRandFor(state.seed, player === 'A' ? 'A' : 'B', brain.mulberry32),
            netPolicy,
            rejected,
          )
        : engine.aiNextAction(state, budget, rejected);
    if (!action) break;

    planMovePath(state, action);
    const walked = pendingMovePath?.values().next().value?.length ?? 0;
    const actor = state.current;
    const before = state;
    const result = applyAction(state, action);
    if (!result.ok) { rejected.add(engine.aiActionKey(action)); await sleep(0); continue; }
    rejected.clear();

    state = result.state;
    noteHpDrops(before, state);
    noteStrikeFlash(before, state);
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
  /*
   * 结束回合也要记一笔（2026-11-04）。
   *
   * 人类那边走的是 dispatch → noteStep，AI 这边原来是直接 apply，于是
   * **动作日志里缺了 AI 的每一次 END_TURN**——重放到那里就卡在同一方，
   * 后面全部对不上。补上之后，日志才是一份能重放的完整动作序列。
   */
  const endActor = state.current;
  const end = applyAction(state, { type: 'END_TURN' });
  if (end.ok) {
    state = end.state;
    noteStep(endActor, { type: 'END_TURN' });
  }
  if (end.ok) noteTurnEnd();
  saveMatch(state);
  render();
  await sleep(delay);
}

/**
 * 回到首页。
 *
 * 三个入口共用它：启动时、顶栏「新对局」、以及「继续上一局」被误触后想找回门口。
 * 2026-11-04 之前顶栏那颗「新对局」是直接换一局（跳过门面），结果是
 * "开局"这件事有两个门：一个有选项、一个没有。现在它只负责回门口。
 */
function showTitle(opts: { pauseAi?: boolean } = {}): void {
  /*
   * 挂到 body，不挂 #app：`appEl.innerHTML` 在启动时会被整块写一次，
   * 之后各处面板还会局部换 innerHTML。挂 body 就与这些渲染彻底无关，
   * 不会出现"第一屏刚出现又被谁刷没了"。
   */
  const host = document.body;
  if (!host) return;
  // 回首页时首页可能已经在了（顶栏按钮连点两下）：再 append 一次就是两层叠着，
  // 撤掉上面那层下面那层还在——"点了开始对局却还是首页"这种 bug 最难查。
  if (host.querySelector('.title-screen')) return;

  /*
   * 只有"打对局打到一半、被按了首页"才暂停 AI。
   *
   * 棋盘还在下面（这是「继续上一局」能瞬开的前提）。如果这局正轮到 AI，
   * 它会在没人看的时候自己往下走——玩家盯着门面，回来发现丢了两个城。
   * 暂停是现成的机制；点「继续上一局」时 kickAiIfNeeded 会把它重新点起来。
   *
   * **启动时不暂停**：开机本来就没有循环在跑（没人调 kickAiIfNeeded），
   * 而存档可能正停在 AI 的回合上——那里暂停等于把一局活棋冻住，
   * 上帝模式那条"对面真由 AI 接手"的用例就是这么红的。
   */
  if (opts.pauseAi) aiPaused = true;

  openTitle(host, {
    // 「继续上一局」只认真打过的一局，见 hasRealSave 的注释
    hasSave: hasRealSave,
    // 第一次来（没打过一局、也没看过教程）：把教程摆成主按钮
    firstVisit: !hasRealSave && !tutorialSeen(),
    version: BUILD_VERSION,
    latest: '新：新手教程（约 3 分钟，从首页进）',
    onNew: newGameFlow,
    onTutorial: startTutorial,
    onContinue: () => {
      render();
      kickAiIfNeeded();
    },
    onOnline: () => {
      const btn = document.querySelector<HTMLButtonElement>('[data-act="online"]');
      if (btn) btn.click();
      else toast('联机面板没打开，先用「开始对局」打一局本机的');
    },
    onManual: openManualFlow,
    onEditor: () => openUnitEditor(() => render()),
    onImport: importMatchFlow,
    onReplay: pickReplayFile,
  });
}

/**
 * 打开开局面板、确认后换一局。
 *
 * 抽成函数是因为它不止一个调用方（首页的「开始对局」、导入失败后的兜底）。
 * 抄一份的话，两处迟早会走岔（比如只在一处记得关掉房间、重置记录器）。
 *
 * 不先 confirm：打开面板本身就说明了意图，点"取消"等于没放弃。
 * 只有点了面板里的"开始对局"才会覆盖当前存档。
 */
function newGameFlow(): void {
  void openSetupPanel(state.config, randomSeed()).then((result) => {
    if (!result) return;
    state = createMatch(result.config, result.seed, loadCustomUnits());
    dropHeatFlash();
    detachRoom();
    resetZoom();
    clearSelection();
    resetRecorder();
    // 开局时勾了"结束后上传详细数据"，等于对**这一局**点了头：
    // 结算卡上的许可框跟着勾上，但那一下「匿名上传」仍然要玩家自己点。
    if (result.config.recordDetail === true) saveReportOptIn(true);
    saveMatch(state);
    hasRealSave = true;
    render();
    toast('新对局开始');
    kickAiIfNeeded();
  });
}

/**
 * 新手教程：开一局钉死的局面，把教练层挂上。
 *
 * 存档在教程期间**挂起**（`suspendSaves`）。这不是防作弊，是防覆盖：教程每走一步
 * 都会调 saveMatch，不挂起的话玩家正在打的那局会被一张教学棋盘顶掉，
 * 而且没有任何提示——退出教程时再把存档读回来，他原来那局还在原地。
 */
/**
 * 看过教程了没有。
 *
 * 跳过也算看过——跳过一次的人不该每次回来都被摆一次"先学三分钟"。
 * 这个标记和"打过一局"是两件事：看教程不产生存档（教程期间存档是挂起的），
 * 所以只用 hasRealSave 判断的话，学完教程回首页还会被再推一次。
 */
const TUTORIAL_SEEN_KEY = 'warchess:tutorial-seen:v1';

function tutorialSeen(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markTutorialSeen(): void {
  try {
    localStorage.setItem(TUTORIAL_SEEN_KEY, '1');
  } catch {
    /* 隐私模式下存不了：不影响这一局，下次还会提示一遍而已 */
  }
}

function startTutorial(): void {
  suspendSaves(true);
  state = createTutorialMatch();
  detachRoom();
  resetZoom();
  clearSelection();
  aiPaused = true;
  tutorialStartHooks();
  tutorial.tutorialSnapshot(state, selectedTile);
  render();
  toast('新手教程：跟着卡片走就行，随时可以跳过');
}

function tutorialStartHooks(): void {
  tutorial.tutorialStart({
    apply: (a) => {
      const r = applyAction(state, a);
      if (!r.ok) return;
      state = r.state;
      render();
    },
    exit: exitTutorial,
  }, document.body);
}

/**
 * 退出教程：把玩家原来那局还回去。
 *
 * 从**存档**读，不从内存读——内存里现在是那张教学棋盘。读不到（第一次玩就点教程）
 * 就现造一局默认的，和打开页面时的行为一致。
 */
function exitTutorial(): void {
  markTutorialSeen();
  tutorial.tutorialExit();
  suspendSaves(false);
  state = loadMatch() ?? createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
  clearSelection();
  render();
  showTitle();
  kickAiIfNeeded();
}

/** 新开一局 / 导入存档之后，如果当前方是 AI 就让它自己跑起来 */
function kickAiIfNeeded(): void {
  aiPaused = false;
  if (isAiSide(state, state.current) && !state.winner) void runAiLoop();
}

/**
 * 导入对局：把对方发来的一串文本变成当前这局。
 *
 * 从 `handleAction` 的 case 里抽出来的，因为首页也要用（2026-11-04 起
 * 「导入对局」只在首页出现）。抽出来之后那段"换局要重置哪些东西"的清单
 * 只有一份，不会在两侧走岔。
 */
function importMatchFlow(): void {
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
  resetZoom(); // 换局可能换尺寸，缩放档位不能跟着上一局走
  clearSelection();
  // 导入的这局要不要记摘要，看它自己的配置；记录器必须跟着换，
  // 否则会把上一局的摘要记到这一局头上
  resetRecorder();
  saveMatch(state);
  hasRealSave = true;
  render();
  kickAiIfNeeded();
}

/**
 * 打开规则手册。
 *
 * 只有核心那一本时直接开，别为形式多问一次；开了扩展才可能出现"看哪本"。
 * 首页和顶栏的「规则书」共用这一条。
 */
function openManualFlow(): void {
  const books = manualBooks(state.config.expansionIds);
  if (books.length === 1) {
    window.open(`./${books[0]!.file}`, '_blank', 'noopener');
    return;
  }
  openManualChooser(books);
}

// ---------- 指挥官模式 ----------

/** 面板上一次重建时对应的局面签名，用来避免无谓重建（重建会把下拉框抽走） */
let commanderSig = '';
/** 批量执行中：面板换成进度条，按钮禁用 */
let commanderRunning = false;
/** 批量执行到第几个回合（1..5），0 表示没在跑 */
let commanderRound = 0;

/** 批量执行时每步的停顿。比"慢档"快得多：一次要跑 5 个回合，180ms 会拖成一分钟 */
const BATCH_DELAY = 40;

/** 现在是不是"轮到玩家当指挥官" */
function commanderActive(): boolean {
  // 复盘里没有"参谋部"：那条横条会带着「执行 5 回合」的按钮一起出现，
  // 而它推的是 `state`——也就是别人那局回放的某一帧。点下去等于拿回放当棋下。
  if (replay) return false;
  return !!state.config.commanderMode && !state.winner && !spectating() && state.current === me();
}

/**
 * 双人热座指挥官：两个人共用一台机器、对面不是 AI、也不是联机。
 *
 * 这一档和"人机 / 联机"的区别是**排队这件事本身要不要等对面**：
 *   · 人机：对面是 AI，我排完直接执行，不用等；
 *   · 联机：两边各在自己机器上排，房间进度号就是同步点；
 *   · 热座：两台"人"轮流用同一块屏幕，所以必须先各自排完、再一起开推，
 *     否则第一个人一按执行，第二个人就只剩看的分。
 */
function commanderHotseat(): boolean {
  return (
    state.config.commanderMode === true &&
    room === null &&
    state.config.aiOpponent !== true &&
    !watching()
  );
}

/** 自己的产兵点：城市 + 军营。`era` 是它现在能产到第几代 */
function ownSites(): Array<{ id: string; label: string; era: number; city: boolean }> {
  const out: Array<{ id: string; label: string; era: number; city: boolean }> = [];
  for (const c of citiesOf(state, me())) {
    out.push({ id: c.id, label: `${cityName(c)} · ${c.era} 代`, era: c.era, city: true });
  }
  for (const u of unitsOf(state, me())) {
    const d = utype(state, u.type);
    if (!isProducer(d)) continue;
    const x = String.fromCharCode(65 + u.x);
    out.push({
      id: u.id,
      label: `${d.name}（${x}${u.y + 1}）· 营`,
      era: d.era,
      city: false,
    });
  }
  return out;
}

/** 这一格为什么造不出来（能造返回空串）。界面据此把估价标红并写一句原因 */
function slotProblem(unitId: string, site: string): string {
  if (!unitId) return '';
  // 「空过」是玩家亲口排的一个决定，不是"排不出来"：它没有任何前置条件
  if (unitId === ORDER_IDLE) return '';
  /*
   * 哨兵要先于兵种表判断。
   *
   * 原来的顺序是"先查 state.unitTypes[unitId]、查不到就报没有这个兵种"，
   * 而「升级时代」这一格存的是 `@upgrade` 这个哨兵——它当然不在兵种表里，
   * 于是每次点升级都弹「没有这个兵种」，明明这一格本来是合法的。
   */
  if (unitId === ORDER_UPGRADE) {
    if (!site) return '';
    const city = state.cities.find((c) => c.id === site);
    if (!city) return '营不升级';
    return upgradeCostOf(state, city) === null ? '升不上去了' : '';
  }
  const def = state.unitTypes[unitId];
  if (!def) return '没有这个兵种';
  if (heroBlocked(state, me(), def)) return '已在场';
  // 没指定产兵点时按"最高级那座城"算：AI 会自己挑能造的那一座
  const eras = citiesOf(state, me()).map((c) => c.era);
  const era = site
    ? (ownSites().find((s) => s.id === site)?.era ?? (eras.length > 0 ? Math.max(...eras) : 1))
    : eras.length > 0
      ? Math.max(...eras)
      : 1;
  if (def.era > era) return '产不了（时代不够）';
  return '';
}

/**
 * 生产序列里一格要花多少钱。
 *
 * 「升级时代」按"自己几座城里最便宜的那次升级"算——AI 执行时会挑它认为最该升的那座，
 * 个数对不上是常态，所以界面上的金币数字一律标成"≈"，不假装精确。
 *
 * 兵种走 `recruitPriceOf`：英雄**第一次**要连解锁费一起算。
 * 以前这里只算兵价，于是面板上写着「矮人王 · 360 金」、估价也照 360 算，
 * 玩家排了它，执行时规则层还要再收 150 金解锁——钱不够，那一格静默空转。
 *
 * `paid` 是"这条序列里前面已经付过解锁费的英雄"：同一份计划里排两次
 * 同一个英雄（比如第一格造、第四格补），第二格不该再算一次解锁费。
 */
function slotCost(unitId: string, paid?: Set<string>): number {
  if (!unitId || unitId === ORDER_IDLE) return 0;
  if (unitId === ORDER_UPGRADE) {
    const costs = citiesOf(state, me())
      .map((c) => upgradeCostOf(state, c))
      .filter((c): c is number => c !== null);
    return costs.length > 0 ? Math.min(...costs) : 0;
  }
  const def = state.unitTypes[unitId];
  if (!def) return 0;
  const quote = recruitPriceOf(state, me(), def);
  if (!def.hero || !paid) return quote.gold;
  if (paid.has(def.id)) return Math.max(0, quote.gold - quote.unlockFee);
  paid.add(def.id);
  return quote.gold;
}

/**
 * 每一格执行时手上有多少钱、这一格要花多少（都是估算）。
 *
 * 回合顺序是"我方 → 对方 → 我方…"，而收入是在结束回合时结算给**下一位**的，
 * 所以每轮到我方时正好多进一笔收入。于是：
 *   第 i 格可用 = 现有金币 + i × 每回合收入 − 前面各格的花费
 *
 * 两串一起返回，是因为调用方两个数都要用（一个显示、一个判"钱紧不紧"），
 * 分开算等于把这条走位逻辑（含"英雄解锁费只在第一格收"）抄两遍。
 */
function estimateGold(): { avail: number[]; cost: number[] } {
  const income = incomeOf(state, me());
  const queue = ordersOf(state, me());
  const paid = new Set<string>();
  const avail: number[] = [];
  const cost: number[] = [];
  let spent = 0;
  for (let i = 0; i < CONFIG.commanderSlots; i++) {
    avail.push(state.players[me()].gold + i * income - spent);
    const c = slotCost(queue[i] ?? '', paid);
    cost.push(c);
    spent += c;
  }
  return { avail, cost };
}

/** 只刷新金币提示，不重建队列条——否则玩家刚点出来的那一格会被抽走 */
function refreshEstimates(): void {
  const est = estimateGold();
  const queue = ordersOf(state, me());
  const sites = orderSitesOf(state, me());
  commanderEl.querySelectorAll<HTMLElement>('[data-est]').forEach((el) => {
    const i = Number(el.dataset.est);
    const avail = est.avail[i] ?? 0;
    const cost = est.cost[i] ?? 0;
    // 造不出来的原因比余额更要紧：钱够、但那座城时代不够，同样是一格空转
    const why = slotProblem(queue[i] ?? '', sites[i] ?? '');
    el.textContent = why
      ? `≈ ${Math.max(0, Math.round(avail))} 金 · ${why}`
      : `≈ ${Math.max(0, Math.round(avail))} 金`;
    el.classList.toggle('tight', cost > avail || why !== '');
  });
  const tail = commanderEl.querySelector<HTMLElement>('[data-est-total]');
  if (tail) {
    const last = est.avail.length - 1;
    const left = (est.avail[last] ?? 0) - (est.cost[last] ?? 0);
    tail.textContent = `跑完这批预计剩 ≈ ${Math.max(0, Math.round(left))} 金`;
  }
}

/**
 * 画指挥官面板（顶端那条生产队列）。
 *
 * 这里是**只读的展示层**：排队动作全部走"点自己的城 → 右侧面板点兵种"，
 * 和常规模式一模一样，只是按钮从「生产」变成「＋队列」（见 panel.ts 的
 * recruitButton）。从前这里挂着 5×2 个下拉框（造什么 / 哪个产兵点），
 * 等于把产兵这件事在两种模式下做成两套操作——同一座城，常规模式点右边，
 * 指挥官模式写下拉框，玩家得先想"我现在是哪种模式"。
 *
 * 重建只在"队列内容 / 产兵点 / 在线与否 / 当前行动方"变化时发生：AI 每走一步
 * 都会 render()，无脑重建会把这排按钮在玩家点到一半时抽走。
 */
/**
 * 指挥官栏里的"策略 / 进攻方向"这一行。
 *
 * 为什么不和排产序列放一起：序列回答"造什么"，这里回答"怎么打"。两者改的频率也
 * 不一样——序列每回合都在动，策略开局定一次、想起来才改。混在一行里，玩家会
 * 以为策略也是"排一格"。
 *
 * 两处都从 `orderDirectiveOf` 读，所以刷新、读档、联机同步之后显示不会和实际行为脱节。
 */
function strategyRow(): string {
  const dir = orderDirectiveOf(state, me());
  const strat = dir.strategy;
  const chip = (key: string, label: string, title: string) =>
    `<button class="chip ${strat === key ? 'active' : ''}" data-cmd="strategy" data-strategy="${key}" title="${title}">${label}</button>`;

  // 方向：自动 / 打某一家（多人局才有意义）/ 八向。两家局也留"打某一家"，
  // 让两种模式的界面完全一致——它在那里的含义就是"盯着对面推"。
  const t = dir.target;
  const value = !t ? 'auto' : 'seat' in t ? `seat:${t.seat}` : `dir:${t.dx},${t.dy}`;
  const seatOpts = seatsOf(state)
    .filter((x) => x !== me())
    .map((x) => `<option value="seat:${x}" ${value === `seat:${x}` ? 'selected' : ''}>只打 ${x} 方</option>`)
    .join('');
  const dirs: Array<[number, number, string]> = [
    [0, -1, '北'], [1, -1, '东北'], [1, 0, '东'], [1, 1, '东南'],
    [0, 1, '南'], [-1, 1, '西南'], [-1, 0, '西'], [-1, -1, '西北'],
  ];
  const dirOpts = dirs
    .map(([dx, dy, label]) => `<option value="dir:${dx},${dy}" ${value === `dir:${dx},${dy}` ? 'selected' : ''}>朝${label}推</option>`)
    .join('');

  return `
    <span class="cmd-plan-label">策略</span>
    <span class="cmd-plan-chips">
      ${chip('auto', '自动', '交给 AI 自己判断打还是发展')}
      ${chip('rush', '猛攻', '全力进攻：不管经营，兵一出来就往前压')}
      ${chip('boom', '经营', '先发展：攒钱、升城、补经济，只在必要时接战')}
      ${chip('hold', '屯兵不动', '不出击：只在自己城下迎击，兵攒着，生产照常')}
    </span>
    <label class="cmd-plan-dir">方向
      <select data-cmd="dir" aria-label="进攻方向">
        <option value="auto" ${value === 'auto' ? 'selected' : ''}>自动</option>
        ${seatOpts}
        ${dirOpts}
      </select>
    </label>`;
}

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

  /*
   * 队列条：只显示"排了什么"，不再提供下拉框。
   *
   * 排队只有一条路——点自己的城（或军营），在右侧面板点兵种。这样指挥官模式和
   * 常规模式的手感是同一套：**城市是入口，兵种在右边点**。
   * 这里只负责把结果摆出来：排了哪几格、每格预计花多少、哪一格会空转。
   */
  const queue = ordersOf(state, me());
  const sites = orderSitesOf(state, me());
  const slots = CONFIG.commanderSlots;
  const online = room !== null;
  // 提交状态进签名：热座里"对面交了没有"会改变文案和按钮，不重画就一直显示旧状态。
  // 策略与方向也要进：改了策略却不重画，玩家点了"屯兵不动"界面还停在"自动"。
  const curDir = orderDirectiveOf(state, me());
  const dirKey = !curDir.target
    ? 'auto'
    : 'seat' in curDir.target
      ? `s${curDir.target.seat}`
      : `d${curDir.target.dx},${curDir.target.dy}`;
  const readyKey = seatsOf(state)
    .map((x) => (state.orderReady?.[x] === true ? x : '-'))
    .join('');
  const sig = `${state.turn}|${queue.join(',')}|${sites.join(',')}|${online}|${state.current}|${curDir.strategy}|${dirKey}|${readyKey}`;
  if (sig === commanderSig) {
    refreshEstimates();
    return;
  }
  commanderSig = sig;

  /** 产兵点的短名：城市叫名字，军营叫兵种名，空串＝交给 AI 挑 */
  const siteLabel = (id: string): string => {
    if (!id) return '自动选址';
    const city = state.cities.find((c) => c.id === id);
    if (city) return cityName(city);
    const unit = state.units.find((u) => u.id === id);
    if (unit) return state.unitTypes[unit.type]?.name ?? unit.type;
    return id;
  };

  const chips: string[] = [];
  for (let i = 0; i < slots; i++) {
    const type = queue[i] ?? '';
    if (!type) {
      // 没排到这一格：虚线框，点「空过」可以就地把它变成"这一回合什么都不要"
      chips.push(`<span class="cmd-chip is-empty"><b>${i + 1}</b><span>空</span></span>`);
      continue;
    }
    if (type === ORDER_IDLE) {
      // 排了"空过"：和虚线空格必须长得不一样，否则玩家分不清
      // "我还剩 3 格没排"和"我明确要求这 3 回合不造兵"
      chips.push(`<span class="cmd-chip is-idle">
        <b>${i + 1}</b>
        <span class="cmd-chip-name">空过</span>
        <i>· 这回合不造兵也不升级</i>
        <span class="cmd-chip-est" data-est="${i}"></span>
        <button class="cmd-x" data-cmd="drop" data-idx="${i}" title="把这一格从队列里去掉">×</button>
      </span>`);
      continue;
    }
    const name = type === ORDER_UPGRADE ? '升级时代' : (state.unitTypes[type]?.name ?? type);
    chips.push(`<span class="cmd-chip">
      <b>${i + 1}</b>
      <span class="cmd-chip-name">${name}</span>
      <i>· ${siteLabel(sites[i] ?? '')}</i>
      <span class="cmd-chip-est" data-est="${i}"></span>
      <button class="cmd-x" data-cmd="drop" data-idx="${i}" title="把这一格从队列里去掉">×</button>
    </span>`);
  }

  // 热座：这一格按钮是"交计划"，而且要显示"对面交了没有"
  const hotseat = commanderHotseat();
  const mineReady = state.orderReady?.[me()] === true;
  // 三家四家局里"对面"不止一个：只报"还差几家"，不再写死 A/B
  const others = seatsOf(state).filter((x) => x !== me());
  const waiting = others.filter((x) => state.orderReady?.[x] !== true);
  const foeLabel =
    others.length <= 1
      ? waiting.length === 0
        ? '对方已提交'
        : '等对方排'
      : waiting.length === 0
        ? '都交齐了'
        : `还差 ${waiting.length} 家`;

  commanderEl.innerHTML = `
    <div class="cmd-head">
      <b>参谋部</b>
      <span class="cmd-hint">${
        online
          ? '点自己的城市 → 在右侧点兵种，就排进这条队列；执行一次打完你自己这一回合并提交。'
          : hotseat
            ? `点自己的城市 → 在右侧点兵种，把自己这 ${slots} 回合排完，然后点「提交作战计划」；两边都交齐才按回合轮流推进。`
            : `点自己的城市 → 在右侧点兵种，就排进这条队列；排好之后点执行，AI 一次打完这 ${slots} 回合。`
      }</span>
      <span class="cmd-count">${
        hotseat
          ? `已排 ${queue.length} / ${slots}　${mineReady ? '你已提交' : '你未提交'} · ${foeLabel}`
          : `已排 ${queue.length} / ${slots}`
      }</span>
    </div>
    <div class="cmd-plan">${strategyRow()}</div>
    <div class="cmd-queue">${chips.join('')}</div>
    <div class="cmd-foot">
      <span class="cmd-total" data-est-total></span>
      <button class="btn btn-sm" data-cmd="idle" ${queue.length >= slots ? 'disabled' : ''}
        title="在序列末尾排一格「这一回合什么都不造」：攒钱、等时代、等对面先动手">空过一回合</button>
      <button class="btn btn-sm" data-cmd="clear" ${queue.length > 0 ? '' : 'disabled'}>清空</button>
      <button class="btn btn-primary" data-cmd="run" ${
        hotseat && mineReady ? 'disabled' : ''
      }>${
        online
          ? '执行本回合并提交'
          : hotseat
            ? mineReady
              ? '已提交，等对方'
              : '提交作战计划'
            : `执行 ${slots} 回合`
      }</button>
    </div>
  `;
  refreshEstimates();
}


/**
 * 队列条上的三颗操作：执行、中断、删一格、清空。
 *
 * 删格是"按位置删"，不是"按兵种删"：同一条队列里可以有两次同一个兵（两个回合各造一个），
 * 按兵种删会把两格一起删掉，而玩家只点了其中一格。
 */
commanderEl.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const cmd = el.closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
  if (!cmd) return;

  // 热座：这一颗按钮是"交计划"，不是"开打"（两边都交完才开推）
  if (cmd === 'run') commanderHotseat() ? commitPlan() : void runCommanderBatch();
  if (cmd === 'idle') enqueueOrder(ORDER_IDLE, '');
  if (cmd === 'stop') {
    // 令牌一换，所有正在跑的 AI 循环下一步就自己退出
    aiToken += 1;
  }
  if (cmd === 'drop') {
    const idx = Number(el.closest<HTMLElement>('[data-idx]')?.dataset.idx ?? '-1');
    const queue = [...ordersOf(state, me())];
    const sites = [...orderSitesOf(state, me())];
    if (idx < 0 || idx >= queue.length) return;
    queue.splice(idx, 1);
    sites.splice(idx, 1);
    dispatch({ type: 'SET_ORDERS', queue, sites });
    return;
  }
  if (cmd === 'clear') {
    dispatch({ type: 'SET_ORDERS', queue: [], sites: [] });
  }
  if (cmd === 'strategy') {
    const key = el.closest<HTMLElement>('[data-strategy]')?.dataset.strategy;
    if (!key) return;
    const cur = orderDirectiveOf(state, me());
    // 只改策略、保留已选的进攻方向：这两件事是分开定的，改一个不该把另一个清掉
    dispatch({
      type: 'SET_DIRECTIVE',
      directive: { strategy: key as OrderDirective['strategy'], ...(cur.target ? { target: cur.target } : {}) },
    });
  }
});

/*
 * 进攻方向用下拉框，所以走 change 而不是 click。
 *
 * 下拉是原生控件：点它不会触发按钮那套 `[data-cmd]` 逻辑，混在一起会互相吞事件。
 */
commanderEl.addEventListener('change', (e) => {
  const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-cmd="dir"]');
  if (!sel) return;
  const cur = orderDirectiveOf(state, me());
  const v = sel.value;
  let target: OrderDirective['target'];
  if (v.startsWith('seat:')) target = { seat: v.slice(5) as PlayerId };
  else if (v.startsWith('dir:')) {
    const [dx, dy] = v.slice(4).split(',').map(Number);
    target = { dx: dx ?? 0, dy: dy ?? 0 };
  }
  dispatch({
    type: 'SET_DIRECTIVE',
    directive: { strategy: cur.strategy, ...(target ? { target } : {}) },
  });
});

/**
 * 把「这座城 · 这个兵」排进本回合的生产队列。
 *
 * 队列就是一串"每回合造什么"，`orders` 与 `orderSites` 逐格对齐
 * （见 types.ts 的 orders 注释）。这里只做追加，删除在顶端队列条上。
 * 动作走 `dispatch` 而不是直接改 state：SET_ORDERS 是规则层的动作，
 * 联机时它会连同其它动作一起被推给对面。
 */
function enqueueOrder(type: string, site: string): void {
  if (!state.config.commanderMode) return;
  const queue = [...ordersOf(state, me())];
  const sites = [...orderSitesOf(state, me())];
  if (queue.length >= CONFIG.commanderSlots) {
    toast(`队列满了（${CONFIG.commanderSlots} 格）：先在顶部删掉一格`);
    return;
  }
  queue.push(type);
  sites.push(site);
  if (!dispatch({ type: 'SET_ORDERS', queue, sites })) return;
  if (type === ORDER_IDLE) {
    toast(`已排入第 ${queue.length} 格：这一回合什么都不造，钱留着`);
    return;
  }
  const name = type === ORDER_UPGRADE ? '升级时代' : (state.unitTypes[type]?.name ?? type);
  toast(`已排入队列：${name}`);
}

/** 这一方本回合的命令：三种走法见 runCommanderBatch 的注释 */
function commanderBudget(player: PlayerId): Partial<AiBudget> {
  const head = ordersOf(state, player)[0] ?? '';
  // 队首那一格指定的产兵点：空串＝不指定（AI 自己挑最合适的那座）
  const site = orderSitesOf(state, player)[0] || null;
  if (head === ORDER_UPGRADE) return { maxRecruit: 0, maxUpgrade: 1, order: null, orderSite: site };
  // 空过：这一回合一个兵都不造、也不要升级，钱留着
  if (head === ORDER_IDLE) return { maxRecruit: 0, maxUpgrade: 0, order: null, orderSite: null };
  return { maxRecruit: head ? 1 : 0, maxUpgrade: 0, order: head || null, orderSite: head ? site : null };
}

/**
 * 双人热座：提交这一方的作战计划（底栏按钮和参谋部那颗按钮共用）。
 *
 * 提交**不推进回合**：只把"这一方交了"记下来，然后换人排。
 * 两边齐了才真正开推——这正是"各自排五回合、齐了再轮流推"的意思。
 */
function commitPlan(): void {
  if (!commanderHotseat() || commanderRunning) return;
  const r = applyAction(state, { type: 'PLAN_COMMIT' });
  if (!r.ok) {
    toast(r.reason);
    return;
  }
  state = r.state;
  clearSelection();
  saveMatch(state);
  render();
  if (planBothReady(state)) void runCommanderResolve();
}

/**
 * 双人热座：两份计划都交齐了，按回合轮流推进。
 *
 * 一次循环 = 一个半回合（`runAiTurn` 结尾自己会 END_TURN，顺带把这一方的
 * 序列前移一格）。所以"五回合轮着来"就是 5 × 2 次调用，不用自己数谁先谁后：
 * `PLAN_COMMIT` 已经把 `current` 拨回这一批的开局方，END_TURN 负责交替。
 *
 * 每一方读的都是**自己那份**队列（`commanderBudget(state.current)`），
 * 于是 A 排的两个火枪、B 排的三艘船会各自按自己的顺序落到各自那五个回合里。
 */
async function runCommanderResolve(): Promise<void> {
  if (commanderRunning) return;
  const token = ++aiToken;
  clearSelection();
  aiPaused = false;
  commanderRunning = true;
  commanderRound = 0;
  commanderSig = '';
  render();

  try {
    for (let r = 0; r < CONFIG.commanderSlots; r++) {
      // 一"轮"= 每一席各走一次。两家局就是两半回合，三家四家局跟着席位走。
      for (let half = 0; half < seatsOf(state).length; half++) {
        if (token !== aiToken || state.winner || room) break;
        commanderRound = r + 1;
        commanderSig = '';
        renderCommander();
        await runAiTurn(token, commanderBudget(state.current), BATCH_DELAY);
      }
      if (token !== aiToken || state.winner) break;
    }
  } finally {
    // 标记要清在"跑完之后"：清早了，进场那一刻两边又变成"未提交"，
    // 面板立刻又能点提交，和正在跑的这批撞在一起。
    if (token === aiToken) {
      const end = applyAction(state, { type: 'PLAN_END' });
      if (end.ok) state = end.state;
    }
    commanderRunning = false;
    commanderRound = 0;
    commanderSig = '';
  }

  saveMatch(state);
  render();
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
  // 热座不走这条：那边必须先两边都交计划再开推，见 commitPlan / runCommanderResolve
  if (commanderHotseat()) return commitPlan();
  if (!commanderActive() || commanderRunning) return;

  const online = room !== null;
  const rounds = online ? 1 : CONFIG.commanderSlots;
  /** 提交用的回合号：必须是"这一批开始前"的那个，才能撞出两边同时提交 */
  const startTurn = state.turn;

  const token = ++aiToken;
  clearSelection();
  aiPaused = false;
  // 队列就是状态本身（点城市面板的那一刻就写进去了），执行时不必再"收一遍下拉"。
  // 以前那一步是必需的：下拉是界面的临时值，不收就会把玩家刚改的那一格漏掉。

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

  // 单机：把这批计划重新装回序列，玩家满意的话下一次直接点执行，不用重排。
  // 这也正是"减负"——排一次能用很多批，想改再改。
  const rearm = applyAction(state, {
    type: 'SET_ORDERS',
    queue: [...ordersOf(state, me())],
    sites: [...orderSitesOf(state, me())],
  });
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

/* ── 框选（2026-11-10） ────────────────────────────────────────────────
 *
 * 一次拖动有三种可能的含义，靠**手上有没有笔刷**分开，不靠修饰键：
 *   · 空手（`brush.kind === 'none'`）→ 斜向拖出矩形选区；
 *   · 拿着地形/兵种/橡皮 → 仍然是"拖动绘制"（老行为，一个字没改）。
 *
 * 为什么不加 Shift/Alt：沙盒里 Shift 已经在正常对局里是"强制攻击"，
 * 而这里最常做的事就是"摆一片"。让"空手"承担框选，符合"手上没工具 =
 * 在指东西"这个直觉，也不需要玩家记住第二个修饰键。
 *
 * 单击不受影响：框选要到**第一次 pointermove** 才算成立（和笔刷拖动同一个
 * 门槛），所以"点一下看看这格是什么"照旧走 `onGodClick`。
 */
let godRect: Rect | null = null;
/** 正在拖的那个（松手才提交给 godRect；没动过就当作单击，不产选区） */
let godMarquee: { a: { x: number; y: number }; b: { x: number; y: number }; pid: number } | null = null;

/** 选区里那几格的索引（给棋盘染色用）；没有选区就是空数组 */
function godRectIndices(): number[] {
  const r = godMarquee ? rectOf(godMarquee.a, godMarquee.b, state.w, state.h) : godRect;
  if (!r) return [];
  const out: number[] = [];
  for (let y = r.y0; y <= r.y1; y += 1) {
    for (let x = r.x0; x <= r.x1; x += 1) out.push(y * state.w + x);
  }
  return out;
}

/** 工具栏那块摘要要的三个数 */
function godSelectionForUi(): { w: number; h: number; cells: number; units: number } | null {
  const r = godRect;
  if (!r) return null;
  return { w: rectW(r), h: rectH(r), cells: rectW(r) * rectH(r), units: unitsInRect(state, r).length };
}

/**
 * 批量操作的统一出口：**只压一次撤销**。
 *
 * 选二十个兵删掉，撤销一下就全回来——和"一笔拖动 = 一步"是同一条规矩。
 * 复用 `godApply` 不行：那个每次调用压一次栈，二十次操作就是二十层撤销。
 */
function godBatchApply(next: GameState, msg: string): void {
  undoStack.push(state);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  state = next;
  godResult = '';
  godSig = '';
  godShelfSig = '';
  saveMatch(state);
  render();
  toast(msg);
}
/** 摆城用哪个时代；0 表示"还没挑过"，按这一局的起始时代走 */
let godCityEra = 0;
/**
 * 玩家亲手操控哪一方。
 *
 * 现在界面上的三档 chip 撤掉了，默认就是 `'both'`：沙盒的用途是自己演一遍，
 * 想歇手的时候有「交给 AI · 一回合」和「接管 · 打到全灭」两颗按钮，那才是正解。
 * 保留这两个取值是因为"我打一边、对面补一手"这条代码路径（`godAfterTurn`）还有用，
 * 只是暂时没有入口——别在没验证的情况下删掉它。
 *
 *   · `'me'`    我打「摆给」那一边，对面交给 AI（一步一交）
 *   · `'both'`  两边都由我走（默认）
 *
 * 为什么不复用 `state.aiControl`：那个开关是"这一方**永久**托管"，一个回合接一个
 * 回合地自己往下跑，沙盒里会跑到你摆不下子。这里的交接是**一步一交**——对面走完
 * 一个回合就停住，等你。两者的区别在 AI 那半边看得很清楚：那边是循环，这边是一回合。
 */
let godPlay: 'me' | 'both' | null = 'both';
/**
 * AI 正在替对面走那一个回合。
 *
 * 和 godRunning 分开：godRunning 是"两边都交给 AI，一直打到全灭"，这个只是把
 * 对面那一步补上然后交还。界面上也分开——前者整条工具栏换成进度条，
 * 后者只把「结束回合」换成"对面在想"。
 */
let godPassing = false;
/** 货架按扩展包筛选（'' = 全部）。和侧栏那个分开存：两边看的东西不一样 */
let godPack = '';
/** 货架按时代筛选（0 = 全部）。理由同上：沙盒里想看的是"这一代有什么" */
let godEra = 0;
/**
 * 货架的按字搜索词。
 *
 * 和产兵面板那个 `recruitQuery` 分开存：两边在找的东西不一样，
 * 在货架里搜完「弓」再回去造兵，不该发现产兵列表也被筛了。
 */
let godQuery = '';
/**
 * 快捷模式：开着的时候按空格直接结束回合。
 *
 * 记进 localStorage——这是个"手感"偏好，不是每局都要重新做一次的决定。
 * 读取放在启动时（下面的 QUICK_KEY），写回放在切换那一刻。
 */
const GOD_QUICK_KEY = 'warchess.god.quick';
/** 读偏好。注意 key 必须声明在它上面——`const` 在初始化前被访问是 TDZ 报错，
 *  而这条报错会把整个模块初始化掀掉（表现是首页一堆测试连锁失败）。 */
function loadGodQuick(): boolean {
  try {
    return localStorage.getItem(GOD_QUICK_KEY) === '1';
  } catch {
    // 隐私模式 / 禁用存储：读不到就当没开，不影响使用
    return false;
  }
}
let godQuick = loadGodQuick();
/** 写回开关：和读同一份 key，刷新之后手感不变 */
function saveGodQuick(v: boolean): void {
  godQuick = v;
  try {
    localStorage.setItem(GOD_QUICK_KEY, v ? '1' : '0');
  } catch {
    /* 存不上就算了，这一次会话里仍然生效 */
  }
}
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
 * 现在轮不轮得到玩家自己走一步。
 *
 * `'both'` 档永远算"轮到你"——两边都是你，当前行动方就是你要走的那一方。
 */
function godMyTurn(): boolean {
  if (godPlay === null || godRunning || godPassing) return false;
  if (godPlay === 'both') return true;
  return state.current === godSide;
}

/**
 * 这一下点棋盘该按"操控"解释吗。
 *
 * 手上有摆放笔刷时**仍然先摆放**：沙盒里"我想在这儿加一个人"永远比
 * "我想走一步"急，而且摆完立刻能走，反过来的顺序要切两次模式。
 */
function godInControl(): boolean {
  return godPlay !== null && !godRunning && godBrush.kind === 'none';
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
    selection: godSelectionForUi(),
    pack: godPack,
    era: godEra,
    // 没挑过时代就按这一局的起始时代：从青铜开局的人摆出来的城，
    // 没有理由默认成另一个时代
    cityEra: godCityEra || state.config.startEra,
    running: godRunning,
    round: godRound,
    result: godResult,
    speed: godSpeed,
    speedNames: AI_SPEED_NAME,
    log: state.log,
    play: godPlay,
    myTurn: godMyTurn(),
    passing: godPassing,
    // 侧栏顶上那块属性卡：直接拿正常面板那一份（含光环/规则加成/技能按钮），
    // 没选中任何东西时是空串
    detail: godDetailHtml(),
    query: godQuery,
    quick: godQuick,
  };
}

/**
 * 「手上这支兵」这一路会变的所有状态：血量、还能走/打、技能冷却。
 *
 * 两个签名都要它：工具栏那行状态文字写的是血量与行动力，侧栏那块卡写的是
 * 同一批数字再加技能按钮。只认 `selectedId` 的话，同一个兵挨了一刀、
 * 或者刚开完技能，两块地方都会停在旧内容上——而那正是最需要看准的时刻。
 */
function godPickedSig(): string {
  const u = selectedId ? state.units.find((x) => x.id === selectedId) : undefined;
  if (!u) return '-';
  return `${u.id}:${u.hp}:${u.moved ? 'm' : '-'}${u.acted ? 'a' : '-'}:${
    u.attacksLeft ?? ''
  }:${JSON.stringify(u.skillCd ?? {})}`;
}

/**
 * 侧栏顶上那块属性卡。
 *
 * 直接复用正常面板的 `panelInput()` + `detailCardHtml()`——**不另写一份**。
 * 理由：属性卡里那套东西（光环、规则加成后的真实数值、击杀成长、技能按钮、上下船）
 * 全都挂在 `renderDetail` 上，重写一遍等于把"沙盒和实战数字不一致"这件事
 * 写进代码里。而 `panelInput()` 在上帝模式里本来就是对的：
 * `me()` 返回当前行动方、`spectating()` 返回 true 给全图视角。
 *
 * 唯一的额外判断是"什么都没选中时不要摆一个空卡片"。
 */
function godDetailHtml(): string {
  if (state.config.godMode !== true) return '';
  if (!selectedId && !selectedCityId && !selectedCampId && !selectedTile) return '';
  return detailCardHtml(panelInput(), godMyTurn());
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
    // 操控档：换了谁亲手走、轮到谁、AI 是不是正在替对面走，
    // 这三样都会改工具栏的按钮和提示
    godPlay ?? '-',
    godPassing ? 'pass' : '-',
    // 状态行会显示"手上这支兵还剩多少行动力"，所以不是只看换了没换，
    // 血量/行动力/技能冷却任何一项变了都得重写这一行
    godPickedSig(),
    godRunning ? `run${godRound}` : '-',
    // 快捷模式改的是「结束回合」那一行的提示，必须进签名
    godQuick ? 'q' : '-',
    godResult,
    state.units.length,
    state.cities.length,
    // 有一枚蛋等着孵也要重绘：工具栏上那句结论会从"接着摆"变成
    // "还有一枚蛋"，而蛋出现时单位数正好减一，两边都得算进签名
    state.pendingEgg ? state.pendingEgg.owner : '-',
    // 框选：选区的尺寸/格数/单位数会整条出现或整条消失，四样都要进签名。
    // 漏了它，拖完一次框选工具栏不会变（第一次就踩到了）。
    godRect ? `${godRect.x0},${godRect.y0},${godRect.x1},${godRect.y1}` : '-',
    // 选区里的兵力会随批量操作变（删兵、放兵、平移），所以另算一个数
    godRect ? unitsInRect(state, godRect).length : 0,
  ].join('|');
  if (sig === godSig) return;
  godSig = sig;
  // 参谋部那份签名作废：下次回到指挥官模式时必须整块重建，否则会拿着
  // 沙盒的签名去比，面板原地不动
  commanderSig = '';
  commanderEl.innerHTML = godBarHtml(godUi());
}

/** 属性卡的内容指纹：进签名用，避免每帧都白比一遍长字符串 */
function godDetailSig(): string {
  if (state.config.godMode !== true) return '-';
  if (!selectedId && !selectedCityId && !selectedCampId && !selectedTile) return '-';
  const h = godDetailHtml();
  // 长度 + 前 64 字足够区分"换了一张卡"，又不用把整块 HTML 塞进签名比
  return `${h.length}:${h.slice(0, 64)}`;
}

function renderGodShelf(): void {
  const pickedSig = godPickedSig();
  const sig = [
    Object.keys(state.unitTypes).length,
    godSide,
    godBrush.kind,
    godBrush.kind === 'unit' ? godBrush.type : '',
    // 换包 / 换时代都要重排整个货架，这两格必须进签名
    godPack,
    godEra,
    state.units.length,
    state.cities.length,
    // 各席位的金币都进签名：沙盒现在是两人局专属，但按席位写一遍不会错，
    // 也不会哪天"沙盒支持三家"时漏掉重画
    ...seatsOf(state).map((p) => state.players[p].gold),
    // 战报条数进签名：这是唯一"局面没怎么变、但确实该重画"的东西。
    // 只认长度不认内容——一条新战报必然让长度 +1（战报只增不减）。
    state.log.length,
    // AI 在跑的时候货架要收起来，这也得重画
    godRunning ? 'run' : '-',
    // 操控档决定货架顶上那句提示，AI 替对面走的时候又要换一句
    godPlay ?? '-',
    godPassing ? 'pass' : '-',
    // 「手上这支兵」那块卡：id、血量、还能走/打、技能冷却。
    // 只放 id 是不够的——开完技能冷却变了，卡片却还停在"就绪"上。
    pickedSig,
    // 货架的搜索词：不放进签名的话，敲字之后列表根本不会重排
    godQuery,
    // 属性卡整块内容进签名。它比上面那串签名更"粗"，但胜在不会漏：
    // 光环、地形加成、天气、上下船入口，任何一样变了它都跟着变。
    // 面板本来每帧就整块重建，这里多比一次字符串不算成本。
    godDetailSig(),
  ].join('|');
  if (sig === godShelfSig) return;
  godShelfSig = sig;
  // 换包/换兵种会整块重排：滚动位置由 keepSideScroll 一起搬过去
  keepSideScroll(() => {
    // 侧栏被直接改写，普通面板的"上次写的是什么"缓存必须作废——
    // 否则退出沙盒那一帧内容碰巧一样就会被跳过，货架留在屏幕上不走
    invalidatePanel(sideEl);
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

/**
 * 把笔刷作用到**一格**：只算，不落撤销栈、不存档、不重绘。
 *
 * 拖动绘制要在一根手指划过的十几格上连着改局面。如果每格都走 `godApply`，
 * 一次拖动会在撤销栈里压十几步——按一下 Ctrl+Z 只退一格，用起来就是"撤销坏了"。
 * 所以把"改局面"和"记一步"拆开：这里只改，提交由 `godStrokeEnd` 统一做一次。
 */
function godPaintAt(base: GameState, x: number, y: number): SandboxResult {
  // 空手不落笔（"空手点一下 = 看看这格是什么"，那是 `onGodClick` 的事）
  if (godBrush.kind === 'none') return { ok: false, reason: '先挑一个笔刷' };
  if (godBrush.kind === 'erase') return removeAt(base, x, y);
  if (godBrush.kind === 'city') {
    return placeCity(base, godSide, x, y, godCityEra || base.config.startEra);
  }
  // 改地形不看"摆给谁"：地形不属于任何一方
  if (godBrush.kind === 'terrain') return paintTerrain(base, x, y, godBrush.terrain);
  return placeUnit(base, godSide, godBrush.type, x, y);
}

function onGodClick(e: Event): void {
  if (godRunning || godPassing) {
    toast(godRunning ? 'AI 正在打，先按「停止」' : '对面那一边在走，等它走完');
    return;
  }
  const coords = coordsFromEvent(e);
  if (!coords) return;
  const { x, y } = coords;

  // 这一次 click 是刚结束那根拖动的尾巴：那一格拖动时已经画过了，
  // 再走一遍就是重复落子（摆兵/橡皮会直接报"这格已经有东西"）。
  if (godDragTail && performance.now() - godDragTail.at < 600 && godDragTail.x === x && godDragTail.y === y) {
    godDragTail = null;
    return;
  }

  /*
   * 有选区的时候，点棋盘 = 先收选区（并继续做这一下原本要做的事）。
   *
   * 不这么做的话，选区会一直亮着，玩家改完一批想去点别的地方，屏幕上
   * 还挂着一块蓝框，分不清"现在框的是谁"。
   */
  if (godRect) {
    godRect = null;
    godSig = '';
    render();
  }

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

  godApply(godPaintAt(state, x, y));
}

/* ── 笔刷拖动绘制 ─────────────────────────────────────────────────────────
 *
 * 按下记一笔底账 → 移动时把**上一格到这一格之间的每一格**都补上 → 松开提交。
 *
 * 三件事是刻意这么定的：
 *   · **按下不落笔**。落笔放在第一次 pointermove。这样"点一下"这个手势
 *     根本不会进入拖动路径，松手后照旧由 click 走 `onGodClick`——
 *     单格点击的行为一个字节都没变，也不会和它抢。
 *   · **补线用 Bresenham，不用"逐格点"**。快速拖动时 pointermove 本身会跳格
 *     （60Hz 手指一划就是三四格），只画事件点会画出一条虚线。
 *     有 `getCoalescedEvents` 就把浏览器压掉的中间采样也取出来一起算。
 *   · **撤销只压一次**。整根拖动 = 一步。鼠标划过去的不是十几次操作。
 */
let godStroke: {
  /** 按下之前的局面：撤销栈要压的就是它 */
  base: GameState;
  /** 上一次落笔的格（补线的起点） */
  last: { x: number; y: number };
  /** 这一笔已经画过的格，避免同一个格子反复改（来回划不该刷十遍） */
  cells: Set<number>;
  /** 画成功几格。为 0 就不是拖动，交给 click 走原路 */
  painted: number;
  /** 第一句失败原因：整笔一格都没画上时说出来，画上了就当噪声吞掉 */
  error: string;
  pid: number;
} | null = null;

/** 拖动刚结束的那一格。用来吞掉松手后派生出来的那一下 click */
let godDragTail: { x: number; y: number; at: number } | null = null;

/** 画一格（同一笔里画过的跳过） */
function godStrokePaint(x: number, y: number): void {
  const stroke = godStroke;
  if (!stroke) return;
  const key = y * state.w + x;
  if (stroke.cells.has(key)) return;
  stroke.cells.add(key);
  const r = godPaintAt(state, x, y);
  if (!r.ok) {
    if (!stroke.error) stroke.error = r.reason;
    return;
  }
  state = r.state;
  stroke.painted += 1;
}

/** 能不能起笔：和 `onGodClick` 的门槛保持一致（那边拦什么，这边也拦什么） */
function godStrokeBegin(e: PointerEvent): boolean {
  if (state.config.godMode !== true || replay) return false;
  if (godRunning || godPassing) return false;
  if (e.pointerType === 'mouse' && e.button !== 0) return false;
  const at = cellAtPoint(boardEl, e.clientX, e.clientY);
  if (!at) return false;

  /*
   * 空手：起一个**框选**，不落笔。
   *
   * 松手之前都不算数（见 `godStrokeEnd`）：这样"点一下"根本不会产生选区，
   * 也就不会和 `onGodClick` 抢——和笔刷拖动"按下不落笔"是同一个理由。
   */
  if (godBrush.kind === 'none') {
    godMarquee = { a: at, b: at, pid: e.pointerId };
    try {
      boardEl.setPointerCapture?.(e.pointerId);
    } catch {
      /* 抓不住只影响"划出边界还能继续"，不该让框选连起点都没有 */
    }
    e.stopPropagation();
    return true;
  }

  /*
   * 有笔刷时，操控档不给画：那里的一举一动都是"真的走一步"，
   * 拖过一片就等于替对手改局面。摆放档（`play === null`）才允许笔刷拖动。
   *
   * 框选**两种档都允许**：它只选不改，选完要按哪颗批量按钮还是玩家自己决定。
   */
  if (godInControl()) return false;

  godStroke = { base: state, last: at, cells: new Set(), painted: 0, error: '', pid: e.pointerId };
  /*
   * 抓指针：手指/鼠标划出棋盘边界也还算数，不会拖到一半断掉。
   *
   * 包 try：指针已经失效（比如这一下是合成事件、或者系统刚把手势抢走）时，
   * 规范允许 `setPointerCapture` 抛 NotFoundError。抓不住只影响"划出边界还能继续"，
   * 不该把整根拖动连第一格都赔进去。
   */
  try {
    boardEl.setPointerCapture?.(e.pointerId);
  } catch {
    /* 抓不住就算了，拖动本身照旧 */
  }
  // 别让 .board-scroll 顺手把这一下当成"拖地图"（放大档里它也在听 pointerdown）
  e.stopPropagation();
  return true;
}

function godStrokeMove(e: PointerEvent): void {
  if (godMarquee) {
    if (e.pointerId !== godMarquee.pid) return;
    const at = cellAtPoint(boardEl, e.clientX, e.clientY);
    if (!at) return; // 划出棋盘就停在最后一格，不把选区缩成 0
    if (at.x === godMarquee.b.x && at.y === godMarquee.b.y) return;
    godMarquee.b = at;
    render();
    return;
  }
  const stroke = godStroke;
  if (!stroke || e.pointerId !== stroke.pid) return;

  /*
   * 合并采样：高刷新率鼠标/极快的手指一帧里会攒好几个点，浏览器只派发最后一个。
   * 不取出来，补线的起点就会从"上一个派发点"算起，那几格照样漏。
   */
  const coalesced =
    typeof e.getCoalescedEvents === 'function' ? (e.getCoalescedEvents() as PointerEvent[]) : [];
  const points = coalesced.length > 0 ? coalesced : [e];

  let dirty = false;
  for (const ev of points) {
    const at = cellAtPoint(boardEl, ev.clientX, ev.clientY);
    if (!at) continue;
    /*
     * 第一笔要把**按下那一格**补上。
     *
     * 落笔是"不含起点、含终点"的（起点算上一笔画过），可按下的时候我们故意
     * 什么都没画——留给"点一下"走 click 那条老路。于是第一格必须在这里补：
     * 不补的话，从 (2,3) 划到 (6,3) 画出来是 (3..6)，起点那个洞永远在。
     */
    if (stroke.cells.size === 0) {
      const beforeFirst = stroke.painted;
      godStrokePaint(stroke.last.x, stroke.last.y);
      if (stroke.painted !== beforeFirst) dirty = true;
    }
    if (at.x === stroke.last.x && at.y === stroke.last.y) continue;
    const before = stroke.painted;
    for (const c of lineBetween(stroke.last, at)) godStrokePaint(c.x, c.y);
    stroke.last = at;
    if (stroke.painted !== before) dirty = true;
  }
  // 一帧最多重绘一次：每个格子都 render 会让 20×20 的拖动掉到个位数帧
  if (dirty) render();
}

function godStrokeEnd(e: PointerEvent): void {
  if (godMarquee) {
    if (e.pointerId !== godMarquee.pid) return;
    const m = godMarquee;
    godMarquee = null;
    const r = rectOf(m.a, m.b, state.w, state.h);
    const clicked = r.x0 === r.x1 && r.y0 === r.y1;
    /*
     * 没拖开就当作单击：不产选区、清掉旧选区，把这一下让给 `onGodClick`。
     * （拖开的门槛是"矩形超过一格"，不是"指针动过"——手抖一像素不该变成 1×1 选区。）
     */
    godRect = clicked ? null : r;
    if (!clicked) {
      const n = unitsInRect(state, r).length;
      toast(`已选 ${rectW(r)}×${rectH(r)} 区域 · ${n} 个单位`);
    }
    // 吞掉松手后浏览器补的那一下 click（它会落到 onGodClick 上）
    godDragTail = { x: m.b.x, y: m.b.y, at: performance.now() };
    render();
    return;
  }
  const stroke = godStroke;
  if (!stroke || e.pointerId !== stroke.pid) return;
  godStroke = null;
  try {
    if (boardEl.hasPointerCapture?.(stroke.pid)) boardEl.releasePointerCapture(stroke.pid);
  } catch {
    /* 同上：抓没抓到都不影响已经画上的格子 */
  }

  // 一格都没画上：要么是"点一下"（该由 click 走原路），要么每格都失败了
  if (stroke.painted === 0) {
    state = stroke.base;
    if (stroke.error) toast(stroke.error);
    return;
  }

  // 整根拖动压一步撤销
  undoStack.push(stroke.base);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  godResult = '';
  saveMatch(state);
  render();
  // 松手这一格拖动时已经画过了，记下来吞掉随之而来的 click
  godDragTail = { x: stroke.last.x, y: stroke.last.y, at: performance.now() };
}


/**
 * 玩家结束回合之后：把对面那一步补上，然后交还。
 *
 * `'both'` 档什么都不做——两边都是你，棋盘直接交给下一步。
 * `'me'` 档让 AI 走完对面**那一个回合**再停住，而不是像「交给 AI」那样一直打：
 * 沙盒里要的是"我走一步、看它怎么应"，不是看它俩自己打完。
 *
 * 这一步是"一步一交"的关键，也是它和 `aiControl` 托管的区别所在。
 */
async function godAfterTurn(): Promise<void> {
  if (!godMode() || godRunning) return;
  if (godPlay !== 'me') {
    // 两边都归你：提示一句轮到谁，免得摆完忘了刚才走的是哪一边
    if (godPlay === 'both' && !state.winner) {
      toast(`轮到${state.players[state.current].name}，接着走`);
    }
    return;
  }
  // 已经转回自己这一边：上一步是玩家自己结束的，没有对面的事
  if (state.current === godSide) return;

  const token = ++aiToken;
  godPassing = true;
  godSig = '';
  render();
  try {
    // 对面这一方也可能没兵了（刚被玩家打光）——那时候让它走一个空回合
    // 反而会把回合数推上去，不如直接判定结束
    if (godHasArmy(state.current)) {
      await runAiTurn(token, GOD_BUDGET, AI_SPEED_MS[godSpeed] ?? 70, () =>
        !godHasArmy(godSide),
      );
    } else {
      const end = applyAction(state, { type: 'END_TURN' });
      if (end.ok) state = end.state;
    }
  } finally {
    godPassing = false;
  }
  // 被「停止」或别人抢了令牌：收尾交给那一下
  if (token !== aiToken) return;

  if (!godHasArmy(godSide)) {
    godResult = `${state.players[godSide].name}的部队打光了`;
  } else {
    godResult = '';
  }
  godSig = '';
  saveMatch(state);
  render();
  if (godResult) toast(godResult);
}

/** 让 AI 操控当前这一方打。
 *
 * mode='round' 只推**一个回合**——这里说的"回合"就是顶栏那个「第 N 回合」，
 * 一方的一次行动算一个。走完立刻把棋盘还给你；mode='dead' 一直打到一方
 * 没有能打的部队，中途可以按停止。
 *
 * 早先 round 是"两边各推一回合"（`maxTurns = 2`），于是按一下按钮、
 * 顶栏的回合数跳 2——按钮写着"一回合"，账却记了两回合。`state.turn`
 * 在每次 END_TURN 时 +1（rules.ts 的 doEndTurn），界面又直接把它印成
 * 「第 N 回合」，所以"一回合"在这局游戏里只有一个意思，不能有两种口径。
 *
 * 为什么要 AI 来走：沙盒的看点就是"这两支部队对撞会怎样"。玩家亲自
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

  const maxTurns = mode === 'round' ? 1 : GOD_MAX_TURNS;
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
      // 顶栏那句「第 N 回合」要和实际走的一致：每走完一个回合，下一个就是 N+1
      godRound = turns + 1;
      render();
    }
  } finally {
    godRunning = false;
    godSig = '';
  }

  // 被「停止」打断：令牌已经换人，收尾交给停止那一下，这里不许再报结论
  if (token !== aiToken) return;

  const wiped = seatsOf(state).filter((p) => !godHasArmy(p));
  if (wiped.length > 0) {
    godResult = `${state.players[wiped[0]!].name}的部队打光了`;
  } else if (state.pendingEgg) {
    // 停在一枚蛋上：不是"打光了"，是还没孵出来。按「打到全灭」再点一次，
    // AI 会先把它孵出来接着打。
    godResult = `${state.players[state.pendingEgg.owner].name}还有一枚蛋没孵`;
  } else if (mode === 'dead') {
    godResult = `打了 ${turns} 次行动，两边都还有兵`;
  } else {
    // 交还的那一方要点名：只走了一个回合，回合方翻过面了，
    // 不说清楚就得自己盯顶栏才知道现在轮到谁
    godResult = `这一回合走完了，轮到${state.players[state.current].name}`;
  }
  saveMatch(state);
  render();
  toast(godResult);

  // 收尾要交还给你。
  //
  // 「打到全灭」可能正好停在**对面那一方**的回合上（谁先没兵是随机的）。
  // 操控档下那一方归 AI，而 AI 这时已经停了——不在这里接一下，棋盘就永远
  // 停在"轮到 X（AI）"，按钮也是灰的，看着像卡死。
  //
  // 只对 'dead' 接：'round' 按设计就只走一个回合，走完轮到对面是**应该的**，
  // 在这里补一手等于偷偷把"一回合"变回两回合——那正是这次修掉的毛病。
  if (mode === 'dead' && godPlay === 'me' && !state.winner && state.current !== godSide) {
    void godAfterTurn();
  }
}

// ---------- 联机 ----------

/**
 * 「别人都进来了吗」。
 *
 * 两人局里它就是"对面入座了没有"，三家四家局里是"剩下几个位子都坐了"——
 * 大厅那句"等待对手入座"、邀请链接上的状态、进房那一刻的初值都读它。
 * 写死成 `seat === 'A' ? 'B' : 'A'` 的话，四人局会认为"只要 B 进来就能开局"。
 */
function peersAllSeated(snapshot: RoomSnapshot, me: PlayerId): boolean {
  const others = seatsOf(snapshot.state).filter((p) => p !== me);
  return others.length > 0 && others.every((p) => snapshot.seats[p] !== null);
}

/** 进入房间：把云端那一局装进本机，并把存档切到这个房间的草稿槽 */
function applyRoom(seat: RoomSeat, snapshot: RoomSnapshot): void {
  room = seat;
  peerSeated = seat.spectator === true ? true : peersAllSeated(snapshot, seat.seat);
  saveSeat(seat);
  rememberRoom(seat.code);
  setSaveScope(seat.code);
  // 迷雾是"我这边想不想看"的偏好，不该被对方的存档覆盖
  const fog = state.fog;
  dropHeatFlash();
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
  // 换了一局就是换了一张图：上一局放大到 3× 拖着看的位置，到这一局毫无意义
  resetZoom();
  clearSelection();
  // 换房间＝换一间屋子说话：上一局的消息一条都不该跟过来
  chatFeed.reset();
  chatNotice = '';
  chatUnread = 0;
  saveMatch(state);
  render();
  startRoomPolling();
}

function leaveRoom(): void {
  const wasWatching = watching();
  detachRoom();
  dropHeatFlash();
  // 回到本机那局：进房间时没动过它，原样还在
  state = loadMatch() ?? createMatch(DEFAULT_CONFIG, randomSeed(), loadCustomUnits());
  resetRecorder();
  resetZoom();
  clearSelection();
  render();
  toast(wasWatching ? '已退出观战，回到本机对局' : '已退出房间，回到本机对局');
}

/** 只断开房间、不载入本机对局：换局或导入存档时用 */
function detachRoom(): void {
  if (!room) return;
  window.clearInterval(roomTimer);
  roomTimer = 0;
  window.clearInterval(presenceTimer);
  presenceTimer = 0;
  watchCount = 0;
  setWatchCount(0);
  room = null;
  dirty = false;
  rememberRoom(null);
  setSaveScope(null);
}

/** 提交这一回合。expectedTurn 是提交前本机的回合数，用来发现"两边同时提交" */
async function pushTurn(seat: RoomSeat, expectedTurn: number, okText?: string): Promise<void> {
  try {
    const ok = await submitTurn(seat.code, state, expectedTurn);
    if (!ok) {
      toast('云端已经是别的回合了（可能对面也提交过），点「联机 → 刷新状态」看一眼');
      return;
    }
    dirty = false;
    toast(okText ?? '这一回合已提交，等对方行动');
    render();
  } catch (err) {
    toast(err instanceof Error ? err.message : '提交失败，网络可能不通');
  }
}

function startRoomPolling(): void {
  window.clearInterval(roomTimer);
  roomTimer = window.setInterval(() => void pollRoom(), 15000);
  startPresence();
}

/**
 * 报送"我还在这儿"，并把这一间房的人数拉回来。
 *
 * 顺序很重要：先心跳再拉名单。反过来的话，自己那一条要等到下一轮才会出现在
 * 名单里，观战者看到的数字永远比自己实际的身份慢一拍（甚至显示 0）。
 */
function startPresence(): void {
  window.clearInterval(presenceTimer);
  presenceTimer = 0;
  if (!room) {
    watchCount = 0;
    setWatchCount(0);
    return;
  }
  void syncPresence();
  presenceTimer = window.setInterval(() => void syncPresence(), PRESENCE_BEAT_MS);
}

async function syncPresence(): Promise<void> {
  const seat = room;
  if (!seat) return;
  await heartbeat(seat.code, seat.spectator ? 'watch' : 'seat', chatMyName());
  const res = await fetchPresence(seat.code);
  // 期间换了房间/退出：这一份名单已经不是眼前这间房的了
  if (room?.code !== seat.code) return;
  if (!res.ok) return;
  watchCount = countWatchers(res.rows, Date.now());
  setWatchCount(watchCount);
}

let draftPollTimer = 0;

/**
 * BP 期间的快取轮询。
 *
 * 正常对局 15 秒问一次就够了（一个回合以分钟计），但 BP 是一来一回的十几步，
 * 15 秒等于没法玩。所以 BP 期间单独开一条 1.5 秒的轮询，选完立刻关掉——
 * 常驻定时器会让页面和测试进程一直挂着不退出（这个坑刚踩过一次）。
 */
function startDraftPolling(): void {
  if (draftPollTimer) return;
  draftPollTimer = window.setInterval(() => {
    if (!room || !draftInProgress(state) || draftBusy) return;
    if (document.visibilityState !== 'visible') return;
    void pollRoom();
  }, 1500);
}

function stopDraftPolling(): void {
  if (!draftPollTimer) return;
  window.clearInterval(draftPollTimer);
  draftPollTimer = 0;
}

/**
 * 定时问一句"对面走完没有"。
 *
 * 参赛者：只在两个条件同时成立时才把云端状态装进来：
 *   1. 云端说轮到我了（否则拉回来也没用）；
 *   2. 我这边没有未提交的草稿（否则会把人刚摆好的兵清掉）。
 *
 * 但有一个例外，而且是压倒性的：**云端说这局已经结束了**。
 * 认输既不推进回合、也不换行动方（`doSurrender` 只是把 winner 写上），
 * 所以只按上面两条判断的话，对手点完认输，这一边永远等不到"轮到我了"，
 * 棋盘就一直停在原状——输了的人那边已经看见结算卡，赢的人还在等下家。
 * 分出胜负之后"未提交的草稿"也没有意义了（这局已经结了），所以这一条
 * 不看 dirty、也不看轮次，直接把终局装进来。
 *
 * 观战位没有"轮到我"这回事，所以只要有新东西就往下拉：
 * 回合变了、换人了、或者分出胜负了（同样是因为认输不推进回合）。
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

    // "别人入座了没有"要靠每次拉取刷新：lobby 里那句"等待对面入座…"就是看它
    if (!seat.spectator) {
      const seated = peersAllSeated(snapshot, seat.seat);
      if (seated !== peerSeated) {
        peerSeated = seated;
        // 进度号没变时下面会直接 return，所以这里得自己重画一次遮罩
        renderDraft();
      }
    }

    /*
     * BP 期间另走一条判断：**进度号往前走了就采纳**。
     *
     * 不能套用 adoptDecision——它按"回合 + 行动方"判，而 BP 里回合一直是 1、
     * 行动方一直是 A（棋盘还没开始），两边都会以为"没我的事"，于是一直停在
     * 自己那份旧名单上。这正是联机 BP 必须单独一条判断的原因。
     */
    const remoteDraft = snapshot.state.draft;
    const localDraft = state.draft;
    const remoteBP = !!remoteDraft && remoteDraft.phase !== 'done';
    const localBP = !!localDraft && localDraft.phase !== 'done';
    if (remoteBP || localBP) {
      const rseq = remoteDraft?.seq ?? 0;
      const lseq = localDraft?.seq ?? 0;
      if (rseq <= lseq) {
        /*
         * 本地跑到房间前面：只可能是"这一手没交上去"（提交四轮都失败）。
         *
         * 以前这里直接 return，于是两边各拿一份对方没有的名单互相等——
         * 禁用卡在"你已提交，等对面"，选人卡在"等对方选"，点哪张都没用。
         * 房间是权威：退回房间那份，让玩家重新出这一手。
         */
        if (rseq < lseq && draftStuck) {
          draftStuck = false;
          takeSnapshot(snapshot);
          toast('选卡进度已按房间重新对齐，刚才那一步没交上去，请再点一次');
        }
        return;
      }
      takeSnapshot(snapshot);
      if (!remoteBP) toast('对面的选卡打完了，进入对局');
      return;
    }

    // 要不要把云端的这一局装进来，交给 room.ts 里那个纯函数判断（它有专门的用例）。
    // 这里只负责"装进来之后干什么"——两份分支的分工就是这么切的。
    const decision = adoptDecision(
      {
        turn: snapshot.turn,
        current: snapshot.current,
        winner: snapshot.state.winner ?? null,
      },
      { turn: state.turn, current: state.current, winner: state.winner ?? null },
      { seat: seat.seat, spectator: seat.spectator === true, draft: dirty },
    );
    if (!decision.take) {
      if (decision.why === 'draft') {
        toast('对方已提交，但你这边还有没提交的走法——先结束回合，或者重新进房间');
      }
      return;
    }

    const fog = state.fog;
    // 认输不推进回合、只换行动方，所以"谁退出了"要拿退出名单的条数来判
    const wasOut = (state.out ?? []).length;
    // 联机没有"本地动作"可挂钩：对面这一回合打到哪，只能靠新旧两份状态的记账差
    const beforeSync = state;
    state = snapshot.state;
    state.aiControl = { A: false, B: false };
    state.fog = fog; // 迷雾是本地偏好，别被对面关掉
    if (decision.why !== 'finished') noteStrikeFlash(beforeSync, state);
    if (decision.why === 'finished') {
      dirty = false;
      clearSelection();
      saveMatch(state);
      render();
      toast(
        snapshot.state.winner === seat.seat
          ? '对面已经结束这一局，你赢了'
          : '这一局已经结束，对面赢了',
      );
      return;
    }
    if (seat.spectator) {
      saveMatch(state);
      render();
      return;
    }
    clearSelection();
    saveMatch(state);
    render();
    /*
     * 提示语要按"现在到底轮到谁"来说。
     *
     * 以前这里固定是"对方已提交，轮到你"——因为旧判据只在自己回合才装状态，
     * 能走到这一行就等于轮到自己了。现在三个人打的时候，别人交回合、
     * 或者干脆认输退出，也会把新局面装进来，那句话就全是错的：
     * B 认输、轮到 C，A 却看见"轮到你"。
     */
    const quitters = (state.out ?? []).slice(wasOut);
    if (quitters.length > 0) {
      const names = quitters.map((q) => state.players[q].name).join('、');
      toast(`${names} 认输退出，还剩 ${aliveSeats(state).length} 家`);
    } else if (state.current === seat.seat) {
      toast('对方已提交，轮到你');
    } else {
      toast(`轮到 ${state.players[state.current].name} 了`);
    }
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
    // 自己记着座位就先去抢回原位；没记着（换了设备/清了缓存）就从第一个空座开始试。
    // 三人、四人桌的座位数由这一局的 config 决定，不能再写死 A/B 两个。
    const tableSeats = seatsOf(snapshot.state);
    const order: PlayerId[] = mine
      ? [mine.seat, ...tableSeats.filter((x) => x !== mine.seat)]
      : tableSeats;
    for (const seat of order) {
      const result = await claimSeat(code, seat, token);
      if (result === 'ok') {
        applyRoom({ code, seat, token }, snapshot);
        toast(`已进入房间 ${code}，你执${DEFAULT_PLAYER_NAMES[seat]}`);
        return;
      }
    }
    applyRoom({ code, seat: 'A', token, spectator: true }, snapshot);
    toast('席位都满了，已切到观战视角（全图）');
  } catch (err) {
    toast(err instanceof Error ? err.message : '进入房间失败');
  }
}

/** 以观战身份进入一个房间：不占座、不写云端，只看 */
function watchRoom(code: string, snapshot: RoomSnapshot): void {
  applyRoom({ code, seat: 'A', token: newToken(), spectator: true }, snapshot);
}

// ---------- 房间聊天 ----------

/**
 * 聊天只开在房间里。
 *
 * 本机对局没有"别人"可说话：双人热座是把设备递过去，AI 局是对着电脑；
 * 在这两种局里放一个永远没回应的输入框，比没有更让人困惑。
 * 观战位**有**（这正是它存在的意义之一）：看局的人也能说话，两边都看得见。
 */
/**
 * 聊天框的三种状态。
 *
 *   open   —— 开着，正常收发；
 *   folded —— 折叠：只留右下角那颗按钮，**对方一说话就自动展开**；
 *             这是"暂时收起来，但别错过他这句话"。
 *   muted  —— 屏蔽发言：不自动展开、不计数、不再提示；
 *             这是"这一局我不想听对面说话"，是社交选择，不是界面状态。
 *
 * 以前只有一个 `chatOpen` 布尔：关掉之后既不会自动弹，也不再有未读提示，
 * 两件不同的事被压成了同一件。
 */
type ChatMode = 'open' | 'folded' | 'muted';
const CHAT_MODE_KEY = 'warchess:chat-mode';

function loadChatMode(): ChatMode {
  try {
    const raw = localStorage.getItem(CHAT_MODE_KEY);
    if (raw === 'open' || raw === 'muted' || raw === 'folded') return raw;
  } catch {
    // 隐私模式读不到就用默认值
  }
  // 默认折叠：收着，但对方开口时会自己弹出来——比"默认关死"更像有人在家
  return 'folded';
}

function saveChatMode(mode: ChatMode): void {
  try {
    localStorage.setItem(CHAT_MODE_KEY, mode);
  } catch {
    // 写不进去就只在本次会话内生效
  }
}

let chatMode: ChatMode = loadChatMode();
const chatIsOpen = (): boolean => chatMode === 'open';
/**
 * 已经收到的消息 + "拉到哪儿了"。
 *
 * 水位（`lastId`）只能由服务器返回的数据推，见 net/chat.ts 里 `ChatFeed` 的注释：
 * 以前自己发一条就把水位推到自己那条的 id，两个人几乎同时说话时，
 * 夹在中间的那条会被永久跳过——"对方说的我这边缺一句"就是这么来的。
 */
const chatFeed = new ChatFeed();
let chatTimer = 0;
let chatDock: HTMLElement | null = null;
let chatNotice = '';
/** 收起面板时来了新消息，就在按钮上点一下——不然说完话没人知道 */
let chatUnread = 0;
/**
 * 聊天面板被拖到哪了（相对出厂位置的像素偏移）。
 *
 * 出厂位置是"钉在视口右下"，这个偏移只在它上面加一层 transform：
 * 换成 left/top 的话，每换一次窗口大小、每换一档缩放，都得重新算一遍基准。
 */
let chatShift = { x: 0, y: 0 };
/** 至少留这么多像素在视口里，拖到边上也还能抓回来 */
const CHAT_EDGE = 8;

const chatSeat = (): ChatSeat => (watching() ? 'watch' : (room?.seat ?? 'A'));

/** 我在这条聊天里的名字：玩家用他那一方的名字，观战就叫"观众" */
function chatMyName(): string {
  if (watching()) return '观众';
  return state.players[me()].name;
}

/**
 * 聊天面板（一次建好，之后只更新里面的日志）。
 *
 * 为什么不像交接遮罩那样每次重建：里面有一个正在输入的 `<input>`。
 * 重建＝把节点换掉＝焦点丢失、光标回到开头，一边打字一边被"新消息"打断。
 * 所以壳子只建一次，`paintChat` 只改 `.chat-log` 那一块。
 */
function ensureChatDock(): HTMLElement {
  if (chatDock) return chatDock;
  const el = document.createElement('div');
  el.className = 'chat-dock';
  el.innerHTML = `
    <button class="chat-fab" data-chat="toggle" hidden>聊天</button>
    <section class="chat-panel" hidden aria-label="房间聊天">
      <header class="chat-head" title="按住这里可以拖动面板">
        <b>房间聊天</b>
        <span class="chat-who"></span>
        <button class="chat-x chat-fold" data-chat="fold" title="折叠：收起来，对方说话时自动展开" aria-label="折叠">–</button>
        <button class="chat-x chat-mute" data-chat="mute" title="屏蔽发言：不再提示，也不自动展开" aria-label="屏蔽发言">屏蔽</button>
      </header>
      <div class="chat-banner" hidden>
        已屏蔽对方的发言 —— 新消息不会自动弹出，也不会计数。
        <button class="link-btn" data-chat="unmute" type="button">恢复</button>
      </div>
      <div class="chat-log"></div>
      <form class="chat-send">
        <input class="chat-input" type="text" maxlength="${CHAT_MAX_LEN}"
               placeholder="说点什么…（Enter 发送）" autocomplete="off" />
        <button class="btn btn-sm" type="submit">发送</button>
      </form>
      <div class="chat-note"></div>
    </section>`;
  document.body.append(el);

  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]')?.dataset.chat;
    if (act === 'toggle') openChat();
    if (act === 'fold') foldChat();
    if (act === 'mute') muteChat();
    if (act === 'unmute') openChat();
  });

  // 输入法组字的时候按 Enter 是"选词"，不是"发送"（见 ui/chat-input.ts）
  const input = el.querySelector<HTMLInputElement>('.chat-input');
  if (input) bindChatComposer(input, () => void sendChatNow());

  bindChatDrag(el);

  chatDock = el;
  return el;
}

/**
 * 让聊天面板能被拖着走。
 *
 * 为什么抓手是标题栏而不是整块面板：面板里有滚动的聊天记录和输入框，
 * 整块可拖会把"选中一句话 / 拖滚动条 / 点输入框"统统变成"挪窗口"。
 * 标题栏上没有别的功能（除了那个 ×，它被排除掉了），是唯一不妨碍任何操作的抓手。
 *
 * 位移只写 `transform`，不碰 right/bottom：出厂位置按视口右下钉着，
 * 改定位属性就得跟着视口尺寸重算，而 transform 是个与基准无关的偏移。
 * 拖动范围夹在视口里，最少留 CHAT_EDGE 个像素——不然一拖就再也抓不回来了。
 */
function bindChatDrag(el: HTMLElement): void {
  const panel = el.querySelector<HTMLElement>('.chat-panel');
  const head = el.querySelector<HTMLElement>('.chat-head');
  if (!panel || !head) return;

  /**
   * 拖动开始时的现场：指针位置、面板当时的位置、以及当时的偏移量。
   *
   * `l/t` 是**含当前偏移**的位置。用"没偏移的基准"去加位移是错的：
   * 面板已经被拖过一次之后再拖，它会被拉回基准位置重新起步，看着像"跳了一下"。
   */
  let drag: {
    id: number;
    x: number;
    y: number;
    l: number;
    t: number;
    w: number;
    h: number;
    sx: number;
    sy: number;
  } | null = null;

  const paint = (): void => {
    panel.style.transform =
      chatShift.x || chatShift.y ? `translate(${chatShift.x}px, ${chatShift.y}px)` : '';
  };

  head.addEventListener('pointerdown', (e) => {
    // 点在 × 上是要关面板，不是要拖
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const box = panel.getBoundingClientRect();
    if (box.width <= 0) return; // 还没显示出来，量不到基准
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      l: box.left,
      t: box.top,
      w: box.width,
      h: box.height,
      sx: chatShift.x,
      sy: chatShift.y,
    };
    head.setPointerCapture?.(e.pointerId);
    panel.classList.add('dragging');
    // 不拦这一下，标题文字会被顺手选中，拖起来像在划词
    e.preventDefault();
  });

  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const maxL = Math.max(CHAT_EDGE, window.innerWidth - drag.w - CHAT_EDGE);
    const maxT = Math.max(CHAT_EDGE, window.innerHeight - drag.h - CHAT_EDGE);
    const l = Math.min(maxL, Math.max(CHAT_EDGE, drag.l + (e.clientX - drag.x)));
    const t = Math.min(maxT, Math.max(CHAT_EDGE, drag.t + (e.clientY - drag.y)));
    chatShift = {
      x: Math.round(drag.sx + (l - drag.l)),
      y: Math.round(drag.sy + (t - drag.t)),
    };
    paint();
  });

  const end = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    panel.classList.remove('dragging');
    head.releasePointerCapture?.(e.pointerId);
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

/**
 * 把拖过的位置夹回视口。
 *
 * 只在"打开面板"时做一次：窗口可能在上次关掉之后被改小了，
 * 或者手机横竖屏换过，不夹一下面板就有一半在屏幕外，而且抓不回来。
 */
function clampChatShift(): void {
  const panel = chatDock?.querySelector<HTMLElement>('.chat-panel');
  if (!panel || panel.hidden) return;
  if (!chatShift.x && !chatShift.y) return;
  const box = panel.getBoundingClientRect();
  if (box.width <= 0) return;
  const maxL = Math.max(CHAT_EDGE, window.innerWidth - box.width - CHAT_EDGE);
  const maxT = Math.max(CHAT_EDGE, window.innerHeight - box.height - CHAT_EDGE);
  const l = Math.min(maxL, Math.max(CHAT_EDGE, box.left));
  const t = Math.min(maxT, Math.max(CHAT_EDGE, box.top));
  const nx = Math.round(chatShift.x + (l - box.left));
  const ny = Math.round(chatShift.y + (t - box.top));
  if (nx === chatShift.x && ny === chatShift.y) return;
  chatShift = { x: nx, y: ny };
  panel.style.transform = `translate(${nx}px, ${ny}px)`;
}

/** 显示 / 隐藏聊天入口。跟着 `room` 走——没房间就没有聊天这回事 */
function renderChatDock(): void {
  const el = ensureChatDock();
  const fab = el.querySelector<HTMLElement>('.chat-fab')!;
  const panel = el.querySelector<HTMLElement>('.chat-panel')!;
  if (!room) {
    // 退出房间：把面板收掉，记录清空——换到另一局时不该看见上一局的对话
    if (chatIsOpen()) foldChat();
    chatFeed.reset();
    chatNotice = '';
    chatUnread = 0;
  }
  fab.hidden = !room;
  panel.hidden = !(room && chatIsOpen());
  panel.classList.toggle('chat-muted', chatMode === 'muted');
  const muted = chatMode === 'muted';
  fab.classList.toggle('is-muted', muted);
  fab.classList.toggle('has-new', !muted && chatUnread > 0);
  fab.textContent = muted
    ? '聊天 · 已屏蔽'
    : chatUnread > 0
      ? `聊天 · ${chatUnread}`
      : '聊天';
  // 被屏蔽时面板里要有一句话和一个开关：否则玩家只能靠"再点一次那颗按钮"
  // 去猜自己是不是屏蔽了对方
  const banner = el.querySelector<HTMLElement>('.chat-banner');
  if (banner) banner.hidden = !muted;
}

/** 只重画日志那一块（壳子里的输入框不动） */
function paintChat(): void {
  const el = ensureChatDock();
  const log = el.querySelector<HTMLElement>('.chat-log')!;
  log.innerHTML = chatLinesHtml(chatFeed.lines, chatSeat());
  // 贴在底部：新消息进来时不往上翻就等于没看见
  log.scrollTop = log.scrollHeight;
  const who = el.querySelector<HTMLElement>('.chat-who');
  if (who) {
    who.textContent = room
      ? `${chatMyName()} · 房间 ${room.code}${watching() ? '（观战）' : ''}`
      : '';
  }
  const note = el.querySelector<HTMLElement>('.chat-note');
  if (note) note.textContent = chatNotice;
}

function openChat(): void {
  if (!room) return;
  chatMode = 'open';
  saveChatMode(chatMode);
  chatUnread = 0;
  renderChatDock();
  paintChat();
  // 上次拖到的位置可能已经不在视口里（换过窗口、转过屏幕），先夹回来
  clampChatShift();
  chatDock?.querySelector<HTMLInputElement>('.chat-input')?.focus({ preventScroll: true });
  void pollChat();
  window.clearInterval(chatTimer);
  // 4 秒一轮：回合制对局里聊天不是弹幕，比这个更快只是白耗电；
  // 比 15 秒的房间轮询快，是因为"说话"这件事本来就该有回声。
  chatTimer = window.setInterval(() => void pollChat(), 4000);
}

/**
 * 折叠：面板收起来，但**继续拉消息**。
 *
 * 和"屏蔽"的关键差别就在这里——折叠期间必须还在轮询，否则对面说了话，
 * 我们根本不会知道，也就不可能"自动展开"。轮询停不停是这两种模式的分水岭。
 */
function foldChat(): void {
  chatMode = 'folded';
  saveChatMode(chatMode);
  chatUnread = 0;
  renderChatDock();
  if (!room) return;
  window.clearInterval(chatTimer);
  chatTimer = window.setInterval(() => void pollChat(), 4000);
}

/** 屏蔽发言：停掉轮询、清掉未读，面板也不弹 */
function muteChat(): void {
  chatMode = 'muted';
  saveChatMode(chatMode);
  chatUnread = 0;
  window.clearInterval(chatTimer);
  chatTimer = 0;
  renderChatDock();
}

async function pollChat(): Promise<void> {
  const seat = room;
  // 屏蔽时连拉都不拉：既然不看，就不必每 4 秒问一次服务器
  if (!seat || chatMode === 'muted') return;
  if (document.visibilityState !== 'visible') return;
  const res = await fetchChat(seat.code, chatFeed.lastId);
  if (room?.code !== seat.code) return; // 期间退出了房间
  if (!res.ok) {
    const msg = res.reason ?? '';
    if (msg !== chatNotice) {
      chatNotice = msg;
      paintChat();
    }
    return;
  }
  if (res.lines.length === 0) {
    if (chatNotice) {
      chatNotice = '';
      paintChat();
    }
    return;
  }
  // 水位由这一页推（见 ChatFeed.accept）；这里是唯一推进它的地方
  const fresh = chatFeed.accept(res.lines);
  if (!chatIsOpen()) {
    // 折叠时：只有**对方**开口才自动展开。自己刚发出去那条（乐观显示）
    // 也会从服务器拉回来，拿它触发展开就等于"我说话把我自己的面板弹开"。
    const mine = chatSeat();
    const foeSpoke = shouldAutoExpand(chatMode, fresh, mine);
    chatUnread += fresh.length;
    renderChatDock();
    if (foeSpoke) {
      openChat();
      // 自动展开时给一句话，解释"它为什么自己弹开了"
      chatNotice = '对方刚发来一条消息，已为你展开';
      paintChat();
      return;
    }
  }
  paintChat();
}

async function sendChatNow(): Promise<void> {
  const seat = room;
  if (!seat) return;
  const input = chatDock?.querySelector<HTMLInputElement>('.chat-input');
  const raw = input?.value ?? '';
  // 先问一句"会不会被截"：`maxlength` 是输入框自己在拦，输入法和某些粘贴
  // 并不总是听话。真超了就不发、把字留在框里——让对面收到半句比拒发更糟。
  if (chatBodyOverflows(raw)) {
    chatNotice = `太长了，最多 ${CHAT_MAX_LEN} 字（现在 ${chatBodyLength(raw)} 字）。拆成两条发吧，字还留在框里。`;
    paintChat();
    input?.focus();
    return;
  }
  const body = trimChatBody(raw);
  if (!body) {
    input?.focus();
    return;
  }
  if (input) input.value = '';
  const res = await sendChat(seat.code, chatSeat(), chatMyName(), body);
  if (!res.ok) {
    // 发失败就把字还回去：重打一遍是最气人的一种失败
    if (input && !input.value) input.value = body;
    chatNotice = res.howTo ? `${res.reason}（${res.howTo}）` : (res.reason ?? '没发出去');
    paintChat();
    return;
  }
  chatNotice = '';
  if (res.line) {
    // 自己这条先显示出来。注意 `adopt` **不推水位**：见 ChatFeed 的注释，
    // 推了就会跳过别人夹在中间发的那条。
    chatFeed.adopt(res.line);
    chatUnread = 0;
    paintChat();
    // 顺手补一次增量：自己这条的 id 之前可能还有别人刚发的消息
    void pollChat();
  } else {
    // 云端没回那一行：立刻增量取一次，别让人对着空白等
    await pollChat();
    paintChat();
  }
}

// ---------- 交接遮罩 ----------

function openHandoff(): void {
  closeHandoff();
  handoffOpen = true;
  const nextPlayer = state.current;
  // 徽章配色跟着席位走：A/B 是老配色，C/D 是多人局新加的
  const side = nextPlayer.toLowerCase();
  const name = state.players[nextPlayer].name;
  const gold = state.players[nextPlayer].gold;
  // 三人四人局里"对方"不是一个东西：剩下几家都可能是下一个拿设备的人
  const rivals = seatsOf(state).filter((p) => p !== nextPlayer).length;

  const el = document.createElement('div');
  el.className = 'handoff';
  el.id = 'handoff';
  el.innerHTML = `
    <div class="handoff-card">
      <div class="handoff-badge ${side}">轮到 ${name}</div>
      <h2>把设备交给下一位</h2>
      <p>当前金币 ${gold}。点开始之后，屏幕上只会显示你视野内的${
        rivals > 1 ? '别家单位（另外几家都算别人）' : '对方单位'
      }。<br />其余看不见的单位会以虚框标记在最后已知的位置。</p>
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
/**
 * 拖动结束后，"吞掉下一次点击"这个开关的有效期。
 *
 * 它只该吃掉**这次拖动**甩出来的那一下 click。以前没有任何期限，
 * 于是拖完松手若没换来一个点击（触点被系统手势吃掉、在窗口外松手、
 * 触摸被浏览器 `pointercancel` 掐断），这个标记就一直挂着，
 * 把后面第一次真正的点格子吃掉——表现就是"放大之后，有时候点格子没反应"。
 */
let suppressTimer = 0;

boardScrollEl.addEventListener('pointerdown', (e) => {
  if (boardZoom <= 1) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  panning = true;
  panMoved = false;
  panFrom = { x: e.clientX, y: e.clientY, left: boardScrollEl.scrollLeft, top: boardScrollEl.scrollTop };
  // 上一轮遗留的"吞点击"到这里就过期了：新手势开始时它还挂着，只可能是泄漏
  suppressClick = false;
  /*
   * 这里**不抓指针**。
   *
   * 指针捕获除了改写 pointer 事件的目标，还会把随后的鼠标事件（mouseup）和
   * 由它派生的 `click` 一起改到捕获元素上。而这段代码以前是无条件捕获的——
   * 于是一放大，每一次普通点击的 target 都变成了 `.board-scroll` 本身，
   * `closest('[data-x]')` 当然找不到格子，整张地图**点不动了**。
   * 浏览器实测（Edge/Chromium，2× 档）：点在任何一格上，click 的 target 都是
   * `board-scroll`；缩回 1× 立刻恢复正常——这就是"放大之后点击失效"。
   *
   * 现在改成"手真的开始拖了才抓"（见 pointermove）。单纯点一下不碰捕获，
   * 事件目标照旧是那一格。
   */
  boardScrollEl.classList.add('dragging');
});

boardScrollEl.addEventListener('pointermove', (e) => {
  if (!panning) return;
  const dx = e.clientX - panFrom.x;
  const dy = e.clientY - panFrom.y;
  if (!panMoved && Math.abs(dx) + Math.abs(dy) < 6) return;
  if (!panMoved) {
    panMoved = true;
    // 这一步才算"拖"，此时才抓指针：手指/鼠标滑出视口也还能继续拖。
    // 抓在 pointerup 之前就释放（见 endPan），不会影响那之后派生的 click。
    boardScrollEl.setPointerCapture?.(e.pointerId);
  }
  boardScrollEl.scrollLeft = panFrom.left - dx;
  boardScrollEl.scrollTop = panFrom.top - dy;
  e.preventDefault();
});

const endPan = (e?: Event): void => {
  if (!panning) return;
  panning = false;
  boardScrollEl.classList.remove('dragging');
  // 松手就把捕获还回去：留着的话，这一下 pointerup 之后派生的 click
  // 仍会被改到 .board-scroll 上，拖动尾巴那次点击就会落到别的地方
  const pid = (e as PointerEvent | undefined)?.pointerId;
  if (pid !== undefined && boardScrollEl.hasPointerCapture?.(pid)) {
    boardScrollEl.releasePointerCapture(pid);
  }
  if (panMoved) {
    suppressClick = true;
    // 400ms 够覆盖"松手→click"这一小段；再长就是在冤枉下一次点击了
    window.clearTimeout(suppressTimer);
    suppressTimer = window.setTimeout(() => {
      suppressClick = false;
    }, 400);
  }
};
boardScrollEl.addEventListener('pointerup', endPan);
boardScrollEl.addEventListener('pointercancel', endPan);boardScrollEl.addEventListener('pointerleave', (e) => {
  /*
   * 已经抓住指针了就别再因为"离开元素边界"收工。
   *
   * 抓指针的意思正是"拖出这块地方也还算数"——横向拖到视口边上再往外，
   * 边界事件一响就把拖动掐了，手感就是"拖到一半突然卡住"。
   * 没抓住（比如这一下根本没拖起来）才按老规矩收。
   */
  if (boardScrollEl.hasPointerCapture?.(e.pointerId)) return;
  endPan(e);
});

/*
 * 笔刷拖动：按下起笔、移动补格、松开提交。
 *
 * 挂在 `boardEl`（`#board`，一个长期存在的节点）而不是格子上：棋盘每帧都在重建
 * 子节点，监听器挂在格子上，第一次重绘之后就没了。指针捕获也抓在这个节点上，
 * 所以整根拖动的 pointermove 都会回到这里，哪怕手已经划到棋盘外面。
 */
boardEl.addEventListener('pointerdown', (e) => {
  godStrokeBegin(e as PointerEvent);
});
boardEl.addEventListener('pointermove', (e) => {
  // 框选时 `godStroke` 是空的（那一笔没落），所以两个都要判
  if (!godStroke && !godMarquee) return;
  godStrokeMove(e as PointerEvent);
});
boardEl.addEventListener('pointerup', (e) => {
  if (!godStroke && !godMarquee) return;
  godStrokeEnd(e as PointerEvent);
});
boardEl.addEventListener('pointercancel', (e) => {
  // 系统把手势抢走了（来电、切后台）。已经画上去的东西**留着**：
  // 玩家看得见它，回滚等于把他刚画的抹掉，比"提前提交"更没道理。
  if (!godStroke && !godMarquee) return;
  godStrokeEnd(e as PointerEvent);
});

// 悬停看详情：选卡时判断禁不禁、造兵之前判断这个工兵能盖什么，都靠这一套
bindHoverTips();

appEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  // 上一次操作是"拖地图"：这一下 click 是拖动的尾巴，不是点格子。
  // **只吞落在棋盘上的那一下**：缩放条和顶栏按钮不在 .board 里面，
  // 拖着地图松手时正好压在"缩小"上，要是连它一起吞掉，按键看着就是失灵的
  // ——"放大了点缩小没反应"有一部分就是这么来的。
  if (suppressClick) {
    suppressClick = false;
    if (target.closest('.board')) return;
  }

  const draftAct = target.closest<HTMLElement>('[data-draft-act]');
  if (draftAct?.dataset.draftAct) {
    onDraftCommand(draftAct.dataset.draftAct);
    return;
  }

  const draftCard = target.closest<HTMLElement>('[data-draft]');
  if (draftCard?.dataset.draft) {
    onDraftClick(draftCard.dataset.draft);
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

/*
 * 棋盘视图 chip 的悬停：进来看一眼、移开就收。
 *
 * 用**委托**而不是逐个绑：chip 是每局重建一次的（扩展列表变了才重建），
 * 绑在节点上的监听会跟着旧节点一起丢。挂在顶栏上，重建多少次都还在。
 */
topbarEl.addEventListener('mouseover', (e) => {
  const chip = (e.target as Element | null)?.closest?.('.view-chip') as HTMLElement | null;
  if (!chip) return;
  const id = chip.dataset.id ?? null;
  if (!id || boardViewHover === id) return;
  boardViewHover = id;
  render();
});

topbarEl.addEventListener('mouseout', (e) => {
  const chip = (e.target as Element | null)?.closest?.('.view-chip') as HTMLElement | null;
  if (!chip) return;
  // 在 chip 内部移动（换到子节点）不算离开
  const to = (e as MouseEvent).relatedTarget as Node | null;
  if (to && chip.contains(to)) return;
  if (boardViewHover === null) return;
  boardViewHover = null;
  render();
});

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
/**
 * 带搜索框的地方（产兵面板、上帝的兵种货架）。
 *
 * 这份逻辑**必须只有一份**：它里面那几条全是从"输入法把字打成乱码"里换来的，
 * 复制一遍就等于把同一个 bug 复制一遍。两个搜索框共用同一个 input 元素生命周期。
 */
const SEARCH_ACTS: ReadonlySet<string> = new Set(['recruit-search', 'god-search']);

const isSearchInput = (el: EventTarget | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement && SEARCH_ACTS.has(el.dataset.act ?? '');

/** 输入法正在组字（分词的临时状态挂在这个 input 节点上，不能动它） */
let searchComposing = false;

/**
 * 重绘侧栏并把焦点、光标还回搜索框。
 *
 * `act` 决定重画哪一块：产兵列表走正常面板，货架走上帝模式那一份。
 * 光标一律落在**末尾**——这两个框都是"边打边筛"，没有人在中间插入。
 */
function repaintSearchPanel(act: string): void {
  if (act === 'god-search') {
    // 货架有签名缓存，不清掉的话重画会被跳过，敲字看着像没反应
    godShelfSig = '';
    renderGodShelf();
  } else {
    keepSideScroll(() => renderPanel(sideEl, panelInput()));
  }

  const again = sideEl.querySelector<HTMLInputElement>(`[data-act="${act}"]`);
  if (!again) return;
  again.focus({ preventScroll: true });
  const end = again.value.length;
  try {
    again.setSelectionRange(end, end);
  } catch {
    // type=search 在某些内核上不支持选区，光标在末尾也无所谓
  }
}

/** 把输入框里的字写回它对应的那份状态（产兵面板和货架各存一份） */
function applySearchQuery(act: string, value: string): void {
  if (act === 'god-search') godQuery = value;
  else recruitQuery = value;
}

appEl.addEventListener('compositionstart', (e) => {
  if (isSearchInput(e.target)) searchComposing = true;
});

appEl.addEventListener('compositionend', (e) => {
  if (!isSearchInput(e.target)) return;
  searchComposing = false;
  const act = e.target.dataset.act ?? '';
  applySearchQuery(act, e.target.value);
  repaintSearchPanel(act);
});

appEl.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | null;
  if (!isSearchInput(el)) return;
  const act = el.dataset.act ?? '';
  applySearchQuery(act, el.value);

  // 组字中（包括没拿到 composition 事件、只在 input 上标了 isComposing 的内核）
  if (searchComposing || (e as InputEvent).isComposing === true) return;

  repaintSearchPanel(act);
});

/**
 * 快捷模式：空格 = 结束回合。
 *
 * 为什么单独挂在 window 上而不是 appEl：焦点可能在任何地方（刚点完棋盘、
 * 刚切完时代 chip），而"结束回合"是个全局动作。挂了三个守卫：
 *
 *   1. 正在输入时绝不抢（搜索框、聊天、改名框）——空格在那里是"打一个空格"；
 *   2. 焦点在按钮上时也不抢——空格本来是"激活这个按钮"，抢了就成了
 *      "想按 A 结果结束了回合"；
 *   3. 按住不放（e.repeat）只认第一下，否则连发会把好几个回合一起交出去。
 */
window.addEventListener('keydown', (e) => {
  if (!godQuick || state.config.godMode !== true) return;
  // 复盘里空格归复盘（播放/暂停）：这里再拦一道，否则放一段沙盒回放时空格会被
  // 这条抢去当"结束回合"——它 dispatch 不进去（闸门拦着），但 preventDefault 已经执行了。
  if (replay) return;
  if (godRunning || godPassing) return;
  if (e.key !== ' ' && e.code !== 'Space') return;
  if (e.repeat) return;
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLButtonElement ||
      t.isContentEditable)
  ) {
    return;
  }
  if (!godMyTurn() || state.winner) return;
  e.preventDefault();
  dispatch({ type: 'END_TURN' });
});

/*
 * 复盘：拖文件进来。
 *
 * 挂在 window 上而不是棋盘上，因为玩家的第一反应是"把文件拖到窗口里"，
 * 不会先去找一块指定区域。代价是要自己判断"现在该不该接"：
 *   · 进房间了就不接（复盘会和对端提交抢 state）；
 *   · 拖的不是文件（拖的是选中的文字、图片）就放行，别抢浏览器的默认行为。
 */
let dragDepth = 0;
const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || room) return;
  dragDepth += 1;
  appEl.classList.add('dropping');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || room) return;
  // 不 preventDefault 的话浏览器会拿文件当导航（直接打开那个 json），页面就没了
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) appEl.classList.remove('dropping');
});
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  appEl.classList.remove('dropping');
  if (!hasFiles(e) || room) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) void importReplayFile(file);
});

/*
 * 复盘快捷键。
 *
 * 单独一个监听、而且在**复盘时才接管**：左/右/空格/Home/End 在别的地方
 * 各有各的用处（比如空格是上帝模式的"结束回合"），不能全局抢。
 */
window.addEventListener('keydown', (e) => {
  if (!replay) return;
  const t = e.target as HTMLElement | null;
  if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)) return;
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      replayStepBy(-1);
      return;
    case 'ArrowRight':
      e.preventDefault();
      replayStepBy(1);
      return;
    case ' ':
    case 'Spacebar':
      // 焦点在按钮上时空格是"按这个按钮"，不是"播放"——那条规矩和上帝模式一致
      if (t instanceof HTMLButtonElement) return;
      e.preventDefault();
      replayTogglePlay();
      return;
    case 'Home':
      e.preventDefault();
      replayStepBy(-replay.applied);
      return;
    case 'End':
      e.preventDefault();
      replayStepBy(replay.applied);
      return;
    case 'Escape':
      e.preventDefault();
      exitReplay();
      return;
  }
});

/*
 * 复盘进度条。
 *
 * `input` 是拖动过程中连续触发的（跟手），`change` 是松手那一下。
 * 拖动期间把 `replaySeeking` 立起来，render 就不再去改 slider.value——
 * 不然每一帧都会把滑块拽回上一格，手感是"拖不动"。
 */
replayEl.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | null;
  if (!replay || !el || el.dataset.act !== 'rp-seek') return;
  replaySeeking = true;
  replayStopTimer();
  replayPlaying = false;
  replayGoto(Number(el.value));
});
const endSeek = (): void => {
  replaySeeking = false;
};
replayEl.addEventListener('change', endSeek);
replayEl.addEventListener('pointerup', endSeek);
replayEl.addEventListener('pointercancel', endSeek);

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

/**
 * 全图选点技能的落点预览（传送阵「挪移」）。
 *
 * 这类技能没有逐格高亮（见 render 里的 `aim-point`），所以改成"鼠标停在哪，
 * 就预览那一格作为落点会把谁挪到哪"。只在 `pendingSkill` 且
 * `targeting === 'point'` 时工作，其它时候这两个监听什么都不做。
 *
 * 换格才重算：同一格里 mousemove 会连发几十次，没必要每次都跑一遍预览再重绘。
 */
boardEl.addEventListener('mouseover', (e) => {
  const pending = pendingSkill;
  if (!pending || pending.targeting !== 'point') return;
  const tile = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tile');
  if (!tile) return;
  const x = Number(tile.dataset.x);
  const y = Number(tile.dataset.y);
  const key = `${x},${y}`;
  if (key === skillAimKey) return;

  const caster = state.units.find((u) => u.id === pending.unitId);
  const previewer = SKILL_PREVIEWERS[pending.skillId];
  if (!caster || !previewer) return;
  skillAimKey = key;
  skillThreatTiles = previewer({ state, self: caster, target: { x, y } });
  render();
});

boardEl.addEventListener('mouseout', (e) => {
  if (!pendingSkill || pendingSkill.targeting !== 'point') return;
  // 在格子之间移动不算离开棋盘：relatedTarget 还在棋盘里，预览就该留着
  const to = (e as MouseEvent).relatedTarget as Node | null;
  if (to && boardEl.contains(to)) return;
  // 离开棋盘不清空，而是退回"基础范围"（落点=自己）。技能还端着，
  // 射程就该一直看得见——清空会让人误以为技能已经取消了。
  const caster = state.units.find((u) => u.id === pendingSkill!.unitId);
  const previewer = SKILL_PREVIEWERS[pendingSkill.skillId];
  skillAimKey = '';
  skillThreatTiles =
    caster && previewer ? previewer({ state, self: caster, target: { x: caster.x, y: caster.y } }) : [];
  render();
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => render(), 120);
});

// 尺寸变化走观察者，不必每帧去量（见 watchBoardResize）
watchBoardResize();

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
  console.error('[时代与回旋镖]', title, err);
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
    console.warn('[时代与回旋镖] 存档里有本版不认识的单位，已移除', dropped);
  }
  return dropped.length;
}

/**
 * 存档读不动了：先把它挪到一边（留证据），再开一局新的把人放进去。
 *
 * 宁可丢掉一局，也不能让人卡在进不去的白屏上——前者是可惜，后者是断绝。
 */
function recoverFromBadSave(err: unknown): void {
  console.error('[时代与回旋镖] 存档读不动了，改开新局', err);
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

/*
 * 第一屏。
 *
 * 位置很重要：这一行必须在**启动流程的最末尾**——上面那一大段才是
 * "读存档 / 修存档 / 首次渲染 / 让 AI 跑起来"。我第一次把调用写进了
 * `applyRoom()`（那是以联机入房为入口的函数），于是正常打开页面根本走不到，
 * 表现就是"首页做完了但看不见"。教训：给"启动时的东西"找位置，要认
 * 模块末尾的初始化代码，而不是随便找一个 startRoomPolling 的邻居。
 *
 * 带邀请链接（?room=CODE）直接进房间，不让门面挡路；
 * 想看门面又不想清存档，就在地址后面加 ?home=1。
 */
const forceHome = new URLSearchParams(location.search).get('home') === '1';
if (forceHome || invited.length < 4) showTitle();

/* ── 设置弹窗 ────────────────────────────────────────────────────────────
 *
 * 顶栏只留每回合都要看的东西；"想起来才改"的都进这里：主题、动效、铃声、
 * 导出、规则书、反馈、回首页。
 *
 * 为什么自己建节点而不进 render()：面板每帧重建，而弹窗是**短暂**的、带输入
 * 焦点（滑块）——扔进渲染循环会被反复冲掉，拖动滑块的手感直接废掉。
 */
let settingsMask: HTMLElement | null = null;

function closeSettings(): void {
  settingsMask?.remove();
  settingsMask = null;
}

function openSettings(): void {
  closeSettings();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  settingsMask = mask;

  const paint = (): void => {
    mask.innerHTML = settingsHtml({
      theme: document.documentElement.dataset.ui === 'modern' ? 'modern' : 'legacy',
      reducedMotion: document.documentElement.dataset.motion === 'reduced',
      chime: chimeVolume,
      chimeText: chimeLabel(chimeVolume),
      unitArt: uiArtOn(),
      terrainArt: uiTerrainOn(),
      replay: replay !== null,
      // 窄屏顶栏放不下「联机」「迷雾」，这两项只在手机上搬进设置。
      // matchMedia 在 jsdom 里没有实现，取不到就退回 innerWidth（测试跑在 1024）。
      compact:
        typeof window.matchMedia === 'function'
          ? window.matchMedia('(max-width: 640px)').matches
          : window.innerWidth <= 640,
      fog: state.fog !== false,
      blackout: state.config.expansionIds.includes('blackout'),
      roomCode: room?.code ?? null,
    });
  };
  paint();
  document.body.append(mask);

  mask.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    // 点遮罩空白处 = 关闭（和规则书那些弹窗一个手势）
    if (t === mask) {
      closeSettings();
      return;
    }
    const el = t.closest<HTMLElement>('[data-act]');
    const act = el?.dataset.act;
    if (!act) return;

    if (act === 'settings-close') {
      closeSettings();
      return;
    }
    if (act === 'set-theme') {
      setUiMode(el!.dataset.theme === 'modern' ? 'modern' : 'legacy');
      paint();
      return;
    }
    if (act === 'set-motion') {
      setUiMotion(el!.dataset.motion === 'reduced' ? 'reduced' : 'full');
      paint();
      return;
    }
    if (act === 'set-fx') {
      /*
       * 一个按钮管两件事：地面材质 + 棋子贴图。
       *
       * 拆成两个开关的那一版，用户点了「棋子贴图」发现地面没变——
       * "切换贴图"在他脑子里是一个动作。合并之后仍然两个状态分开存，
       * 只是入口只有一个。
       */
      const on = el!.dataset.fx === 'on';
      setUiTerrain(on);
      setUiArt(on);
      if (on) {
        // 棋子清单要等拉回来，先画一帧地形，到货后再补一帧
        void loadUnitArtIndex().then(() => paint());
      }
      paint();
      return;
    }
    if (act === 'set-terrain') {
      setUiTerrain(el!.dataset.terrain === 'on');
      paint();
      return;
    }
    if (act === 'set-art') {
      const on = el!.dataset.art === 'on';
      setUiArt(on);
      if (on) {
        // 清单要先到，否则这一帧仍然全是汉字，看起来像"点了没反应"
        void loadUnitArtIndex().then(() => paint());
      }
      paint();
      return;
    }
    if (act === 'chime-test') {
      playChime(chimeVolume);
      return;
    }

    /*
     * 迷雾开关：**不关弹窗**，原地重画。
     * 玩家刚点的就是这一屏上的开关，把他踢出去再开一次才能确认结果，
     * 那是把"看一眼变成了三步"。其余动作仍然走下面那条统一出口。
     */
    if (act === 'toggle-fog') {
      const proxy = document.createElement('button');
      proxy.dataset.act = act;
      appEl.append(proxy);
      proxy.click();
      proxy.remove();
      paint();
      return;
    }

    /*
     * 其余动作（导出 / 回首页 / 规则书 / 反馈 / 联机）走**主分发**，不在这里重写一遍。
     * 造一个带同样 data-act 的替身点一下：多一条实现就多一条会跑偏的地方。
     */
    closeSettings();
    const proxy = document.createElement('button');
    proxy.dataset.act = act;
    appEl.append(proxy);
    proxy.click();
    proxy.remove();
  });

  // 滑块：拖动时只改音量与那一行文字，不整块重画（重画会丢焦点、断手感）
  mask.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act !== 'chime-range') return;
    chimeVolume = Math.min(1, Math.max(0, Number(t.value) / 100));
    saveChimeVolume(chimeVolume);
    const value = mask.querySelector('.set-value');
    if (value) value.textContent = chimeLabel(chimeVolume);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsMask) closeSettings();
});

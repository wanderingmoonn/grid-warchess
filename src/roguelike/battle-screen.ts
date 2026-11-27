/**
 * 战斗屏：**照抄战役模式的那一套**，只删掉肉鸽用不到的部分。
 *
 * 2026-11-28 重做。上一版是自己画了一条顶栏 + 右侧四张卡（我军/战况/技能/操作），
 * 看着"能用"，但和本体是两套东西：单位详情只有五行字、没有地形卡、没有城卡、
 * 没有技能输入框、没有天气/灵气的扩展面板、没有攻击预览与缩放。玩家每换一个模式
 * 就得重学一遍界面。
 *
 * 现在的做法不是"照着战役的样子再画一遍"，而是**直接用战役的组件**：
 *   · 侧栏 → `ui/panel.ts` 的 `renderPanel`（回合徽章、资源、席位、单位/城/地形卡、
 *     技能、扩展面板、战报、结束行动、认输，全是同一份实现）；
 *   · 顶栏 → `topbarShell` 里那些类的子集（回合、关卡目标、扩展徽章、棋盘视图）；
 *   · 资源条 → `battleStatusShell` / `updateBattleStatus`（金币、每回合、撤回）；
 *   · 棋盘 → `ui/board.ts`（连同缩放、强制模式、棋盘视图染色）。
 *
 * 删掉的是战役里有、肉鸽没有对应玩法的：联机、回放、上帝模式、迷雾开关、
 * 选卡、指挥官、战报上传、城市生产/升级（前三层玩家没有城）。
 *
 * 肉鸽自己只有三样要补：
 *   1. **出征军**没有城 —— 所以胜负看"战斗单位打光"，不是"城全丢"；
 *   2. **守城战的波次**在敌方回合结束时往 `state.units` 追加（不碰规则层）；
 *   3. **场外交涉**（中立单位）—— 战役里没有这种东西，单独补一张小卡。
 */
import { AI_MAX_STEPS, aiActionKey, aiNextAction } from '../core/ai.ts';
import { DEFAULT_BUDGET } from '../core/ai-meta.ts';
import type { AiBudget } from '../core/ai-meta.ts';
import { EARTH } from '../core/board.ts';
import { activeExpansions } from '../core/expansions.ts';
import {
  attackableTargets,
  heroSkillsOf,
  isAirborne,
  maxHpOf,
  reachableTiles,
  siegeTargets,
  unitsAt,
  unitsOf,
  utype,
} from '../core/rules.ts';
import { playerView } from '../core/fog.ts';
import { cellAtPoint, fitBoardBox, refreshCellVar, renderBoard } from '../ui/board.ts';
import type { BoardUi } from '../ui/board.ts';
import {
  actionFeedback,
  combatForecastHtml,
  forecastCombat,
} from '../ui/combat-feedback.ts';
import type { CombatAction } from '../ui/combat-feedback.ts';
import {
  battleStatusShell,
  renderPanel,
  updateBattleStatus,
} from '../ui/panel.ts';
import type { Action, GameState, Unit } from '../core/types.ts';
import { buildBattle, baseTypeOf, outcomeOf, resultOf, spawnWave, step } from './battle.ts';
import type { BattleInit, BattleResult } from './types.ts';
import { growthOf } from './data.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
/** 撤回上限：一回合里走不到这么多步，够用又不会把内存拖大 */
const UNDO_LIMIT = 40;

/** AI 每步之间的停顿（毫秒）：慢 / 正常 / 快 */
const AI_SPEEDS = [
  { label: '慢', ms: 110 },
  { label: '正常', ms: 45 },
  { label: '快', ms: 0 },
] as const;

/** 缩放档位（和本体同一个序列） */
const ZOOM_STEPS = [1, 1.35, 1.8, 2.4] as const;

interface BattleHandlers {
  onDone: (result: BattleResult) => void;
}

export function mountBattle(host: HTMLElement, init: BattleInit, handlers: BattleHandlers): () => void {
  let state: GameState = buildBattle(init);
  let selectedId: string | null = null;
  let selectedCityId: string | null = null;
  let selectedTile: { x: number; y: number } | null = null;
  let reach: number[] = [];
  let targets: string[] = [];
  let sieges: string[] = [];
  let busy = false;
  let finished = false;
  let disposed = false;
  let paused = false;
  let speedIdx = 1;
  let boardZoom = 1;
  let activeView: string | null = null;
  let opsOpen = true;
  let logOpen = true;
  /** 撤回栈：每次我方动作之前压一份，结束回合清空（和本体一个口径） */
  const undoStack: GameState[] = [];
  /** 敌人这一场已经补了几个兵（`AiBudget.maxRecruit` 是**每回合**的额度，得自己累计） */
  let enemyRecruited = 0;
  /** 守城战：下一波还没到的那一波 */
  let waveIdx = 0;
  /** 三席守城：B 是友军、C 是攻方；两席局敌人仍是 B */
  const foeSeat = init.allyCity ? ('C' as const) : ('B' as const);
  /** 这一局几个席位：回合按"每人一次"算，不能写死 /2 */
  const hiddenSeats = state.config.level?.seats?.hidden ?? [];
  const seats = Math.max(1, (state.config.playerCount ?? 2) - hiddenSeats.length);
  const roundsNow = (): number => Math.ceil(state.turn / seats);

  /** 正在等落点的技能（和本体一个节奏：点技能 → 点地图） */
  let pendingSkill: { unitId: string; skillId: string; targeting: 'point' | 'direction' } | null = null;
  let skillAim: number[] = [];
  /** 强制模式：这一下点击只按一个动词解释（空地叠在同格时必需） */
  let forceMode: 'move' | 'attack' | null = null;
  /** 攻击预览（战役的 combat-aim）：开着时点目标先出预估，确认才打 */
  let previewMode = false;
  let pendingCombat: CombatAction | null = null;
  /** 同一格连点翻页 */
  let pick: { key: number; ids: string[]; index: number } | null = null;
  /** 棋盘尺寸缓存 */
  let fitDirty = true;
  host.classList.add('rg-battle-host');

  host.innerHTML = `
    <div class="app rg-battle-app">
      <header class="battle-header">
        <div class="topbar" id="rg-topbar"></div>
        <div class="battle-status" id="rg-battle-status"></div>
      </header>
      <div class="main">
        <div class="board-wrap" id="rg-board-wrap">
          <div class="force-flag" id="rg-force-flag" hidden></div>
          <section class="combat-preview" id="rg-combat-preview" hidden aria-label="攻击结果预览" aria-live="polite"></section>
          <div class="action-feedback" id="rg-action-feedback" hidden role="status" aria-atomic="true"></div>
          <div class="board-scroll" id="rg-board-scroll">
            <div class="board rg-board" id="rg-board"></div>
          </div>
          <div class="zoom-bar" id="rg-zoom-bar">
            <button class="zoom-btn" data-act="zoom-fit" title="让整张图回到屏幕里">适应</button>
            <button class="zoom-btn" data-act="zoom-out" title="缩小">−</button>
            <button class="zoom-btn" data-act="zoom-in" title="放大">＋</button>
          </div>
        </div>
        <aside class="side-drawer" id="rg-side-drawer" data-expanded="false">
          <div class="mobile-drawer-head">
            <button type="button" class="drawer-toggle" data-act="drawer-toggle" aria-expanded="false" aria-controls="rg-side">
              <span class="drawer-copy"><b>战场概览</b><small>回合、资源与单位详情</small></span>
              <span class="drawer-state">展开详情</span>
            </button>
          </div>
          <div class="side" id="rg-side"></div>
        </aside>
      </div>
    </div>`;

  const rootEl = host.querySelector<HTMLElement>('.rg-battle-app');
  const topbarEl = host.querySelector<HTMLElement>('#rg-topbar');
  const statusEl = host.querySelector<HTMLElement>('#rg-battle-status');
  const boardEl = host.querySelector<HTMLElement>('#rg-board');
  const boardWrapEl = host.querySelector<HTMLElement>('#rg-board-wrap');
  const boardScrollEl = host.querySelector<HTMLElement>('#rg-board-scroll');
  const sideEl = host.querySelector<HTMLElement>('#rg-side');
  const drawerEl = host.querySelector<HTMLElement>('#rg-side-drawer');
  const forceFlagEl = host.querySelector<HTMLElement>('#rg-force-flag');
  const previewEl = host.querySelector<HTMLElement>('#rg-combat-preview');
  const feedbackEl = host.querySelector<HTMLElement>('#rg-action-feedback');
  if (!rootEl || !topbarEl || !statusEl || !boardEl || !boardWrapEl || !boardScrollEl || !sideEl || !drawerEl || !forceFlagEl || !previewEl || !feedbackEl) {
    throw new Error('战斗界面结构缺失');
  }

  /* ------------------------------------------------------------------ 顶栏 */

  topbarEl.innerHTML = `
    <div class="brand">肉鸽 2.0 <small>第 ${init.layer} 层 · ${escapeHtml(init.label)}</small></div>
    <div class="turn-chip" title="当前行动方">
      <b data-ref="turn"></b>
      <span class="side-dot a" data-ref="dot"></span>
      <span data-ref="who"></span>
    </div>
    <span class="level-goal" data-ref="goal" hidden></span>
    <div class="topbar-badges" data-ref="badges"></div>
    <div class="topbar-ext" data-ref="views"></div>
    <div class="topbar-spacer"></div>
    <div class="topbar-actions">
      <button class="btn btn-sm" data-act="pause" data-ref="pause">暂停 AI</button>
      <button class="btn btn-sm" data-act="speed" data-ref="speed">速度 正常</button>
    </div>`;
  statusEl.innerHTML = battleStatusShell();

  function topbarBadges(): void {
    const box = topbarEl!.querySelector<HTMLElement>('[data-ref="badges"]');
    if (!box) return;
    const badges: Array<{ id: string; text: string; hint: string }> = [];
    for (const e of activeExpansions(state)) {
      if (e.hooks.topbarBadges) badges.push(...e.hooks.topbarBadges({ state }));
    }
    const sig = badges.map((b) => `${b.id}:${b.text}:${b.hint}`).join('|');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = badges
      .map((b) => `<span class="topbar-badge" title="${escapeHtml(b.hint)}">${escapeHtml(b.text)}</span>`)
      .join('');
  }

  function boardViews(): Array<{ id: string; label: string; hint: string; cells?: (c: { state: GameState; viewer: 'A'; board: string }) => Array<{ x: number; y: number; color: string }>; glyph?: (c: { state: GameState; viewer: 'A'; board: string }) => Array<{ x: number; y: number; text: string }> }> {
    const out: ReturnType<typeof boardViews> = [];
    for (const e of activeExpansions(state)) {
      if (e.hooks.boardViews) out.push(...e.hooks.boardViews({ state }));
    }
    return out;
  }

  function renderViewChips(): void {
    const box = topbarEl!.querySelector<HTMLElement>('[data-ref="views"]');
    if (!box) return;
    const views = boardViews();
    box.hidden = views.length === 0;
    const sig = views.map((v) => v.id).join('|');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML = views
        .map(
          (v) =>
            `<button class="view-chip" data-act="board-view" data-id="${escapeHtml(v.id)}" title="${escapeHtml(v.hint)}">${escapeHtml(v.label)}</button>`,
        )
        .join('');
    }
    for (const el of box.querySelectorAll<HTMLElement>('.view-chip')) {
      el.classList.toggle('on', el.dataset.id === activeView);
    }
  }

  function updateTopbarChrome(): void {
    const ref = (name: string) => topbarEl!.querySelector<HTMLElement>(`[data-ref="${name}"]`);
    const turn = ref('turn');
    if (turn) turn.textContent = `第 ${roundsNow()} 回合`;
    const dot = ref('dot');
    if (dot) dot.className = `side-dot ${state.current === 'A' ? 'a' : 'b'}`;
    const who = ref('who');
    if (who) {
      who.textContent = state.current === 'A' ? '轮到你' : `${state.players[state.current]?.name ?? '对方'}行动`;
    }
    const goal = ref('goal');
    if (goal) {
      const text = goalText();
      goal.hidden = text === '';
      goal.textContent = text;
    }
    const pause = ref('pause');
    if (pause) {
      pause.hidden = finished || busy === false && state.current === 'A';
      pause.textContent = paused ? '继续 AI' : '暂停 AI';
    }
    const speed = ref('speed');
    if (speed) speed.textContent = `速度 ${AI_SPEEDS[speedIdx]?.label ?? '正常'}`;
  }

  function goalText(): string {
    if (init.holdRounds > 0) {
      const rounds = roundsNow();
      const left = init.waves.filter((w) => w.atRound > rounds).length;
      return `守住 ${init.holdRounds} 轮 · 已守 ${Math.min(rounds, init.holdRounds)} · 还有 ${left} 波`;
    }
    if (init.kind === 'siege' || init.kind === 'boss') {
      const cities = state.cities.filter((c) => c.owner === foeSeat && !c.ruined).length;
      return `攻破敌城 ${cities} 座 · 回合上限 ${init.roundLimit}`;
    }
    if (init.kind === 'elite') return `摧毁据点 · 回合上限 ${init.roundLimit}`;
    return `击溃敌军 · 回合上限 ${init.roundLimit}`;
  }

  /* ------------------------------------------------------------------ 棋盘尺寸 */

  function applyFit(): void {
    if (!fitDirty) return;
    fitDirty = false;
    const w = state.w;
    const h = state.h;
    const availW = Math.max(180, boardWrapEl!.clientWidth - 24);
    const availH = Math.max(180, boardWrapEl!.clientHeight - 24);
    const fit = fitBoardBox(w, h, availW, availH);
    const pxW = Math.round(fit.w * boardZoom);
    const pxH = Math.round(fit.h * boardZoom);
    boardEl!.style.width = `${pxW}px`;
    boardEl!.style.height = `${pxH}px`;
    const zoomed = boardZoom > 1;
    boardEl!.classList.toggle('zoomed', zoomed);
    boardScrollEl!.classList.toggle('zoomed', zoomed);
    if (zoomed) {
      boardScrollEl!.style.width = `${fit.w}px`;
      boardScrollEl!.style.height = `${fit.h}px`;
    } else {
      boardScrollEl!.style.width = '';
      boardScrollEl!.style.height = '';
    }
    refreshCellVar(boardEl!, w, h);
    const label = host.querySelector<HTMLElement>('[data-act="zoom-fit"]');
    if (label) label.textContent = boardZoom > 1 ? `${boardZoom}×` : '适应';
  }

  function setZoom(next: number): void {
    const clamped = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, Math.max(1, next));
    boardZoom = clamped;
    fitDirty = true;
    render();
    if (boardZoom > 1) {
      boardScrollEl!.scrollLeft = Math.max(0, (boardScrollEl!.scrollWidth - boardScrollEl!.clientWidth) / 2);
      boardScrollEl!.scrollTop = Math.max(0, (boardScrollEl!.scrollHeight - boardScrollEl!.clientHeight) / 2);
    } else {
      boardScrollEl!.scrollLeft = 0;
      boardScrollEl!.scrollTop = 0;
    }
  }

  function zoomStep(dir: 1 | -1): void {
    const at = ZOOM_STEPS.indexOf(boardZoom as (typeof ZOOM_STEPS)[number]);
    const idx = at < 0 ? 0 : at;
    setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + dir))]!);
  }

  /* ------------------------------------------------------------------ 选择 */

  function selected(): Unit | undefined {
    return selectedId ? state.units.find((u) => u.id === selectedId) : undefined;
  }

  function stackAt(x: number, y: number): Unit[] {
    const rank = (u: Unit): number => {
      if (utype(state, u.type).category === 'building') return 2;
      return isAirborne(state, u) ? 0 : 1;
    };
    return unitsAt(state, x, y)
      .filter((u) => u.hp > 0)
      .sort((a, b) => rank(a) - rank(b));
  }

  function pickUnitAt(x: number, y: number, preferTarget: boolean): Unit | undefined {
    const list = stackAt(x, y);
    if (list.length === 0) {
      pick = null;
      return undefined;
    }
    const key = y * state.w + x;
    const ids = list.map((u) => u.id);
    if (preferTarget) {
      const hit = list.find((u) => targets.includes(u.id));
      if (hit) {
        pick = { key, ids, index: list.indexOf(hit) };
        return hit;
      }
    }
    if (!pick || pick.key !== key) {
      pick = { key, ids, index: 0 };
      return list[0];
    }
    const cur = pick;
    const same = cur.ids.length === ids.length && ids.every((id, i) => id === cur.ids[i]);
    if (!same) {
      pick = { key, ids, index: 0 };
      return list[0];
    }
    cur.index = (cur.index + 1) % ids.length;
    return list[cur.index];
  }

  function refreshSelection(): void {
    const unit = selected();
    if (!unit || unit.owner !== 'A' || state.current !== 'A' || unit.hp <= 0) {
      selectedId = null;
      reach = [];
      targets = [];
      sieges = [];
      pendingSkill = null;
      skillAim = [];
      return;
    }
    const isWork = utype(state, unit.type).category === 'building';
    reach = unit.moved || isWork ? [] : [...reachableTiles(state, unit).keys()];
    targets = unit.acted ? [] : attackableTargets(state, unit).map((u) => u.id);
    sieges = unit.acted ? [] : siegeTargets(state, unit).map((c) => c.id);
  }

  /* ------------------------------------------------------------------ 渲染 */

  function render(): void {
    if (disposed) return;
    refreshSelection();
    const view = playerView(state, 'A');
    const ui: BoardUi = {
      selectedId,
      selectedCityId,
      reach,
      targets,
      siegeTargets: sieges,
      aimTiles: skillAim,
      placeable: [],
      threat: [],
    };
    const wanted = boardViews().find((v) => v.id === activeView);
    if (wanted?.cells) {
      const cells = wanted.cells({ state, viewer: 'A', board: EARTH });
      if (cells.length > 0) {
        ui.boardView = new Map(cells.map((c) => [c.y * state.w + c.x, c.color]));
      }
    }
    if (wanted?.glyph) {
      const glyphs = wanted.glyph({ state, viewer: 'A', board: EARTH });
      if (glyphs.length > 0) {
        ui.boardGlyph = new Map(glyphs.map((g) => [g.y * state.w + g.x, g.text]));
      }
    }
    renderBoard(boardEl!, view, ui);
    applyFit();

    updateBattleStatus(statusEl!, state, 'A', !busy && state.current === 'A' && undoStack.length > 0);
    updateTopbarChrome();
    topbarBadges();
    renderViewChips();

    renderCampaignPanel(view);

    forceFlagEl!.hidden = forceMode === null && !pendingSkill;
    forceFlagEl!.textContent =
      pendingSkill
        ? '正在选技能落点：点高亮格施法，点别处取消'
        : forceMode === 'move'
          ? '强制移动：点可达格就走上去（压在别人身上也行）· 再点按钮退出'
          : forceMode === 'attack'
            ? '强制攻击：点目标就开火（含身下那个）· 再点按钮退出'
            : '';
    renderCombatPreview();
  }

  /**
   * 侧栏直接用战役的 `renderPanel`。
   *
   * 传进去的只有"肉鸽真的有的东西"：单位、城、地形、强制模式、撤回栈。
   * 城市生产/联机/回放那些字段根本不传，面板自己就不会画。
   */
  function renderCampaignPanel(view: ReturnType<typeof playerView>): void {
    const cityId = selectedCityId && state.cities.some((c) => c.id === selectedCityId) ? selectedCityId : null;
    renderPanel(sideEl!, {
      view,
      me: 'A',
      selectedUnit: selected() ?? null,
      selectedCityId: cityId,
      selectedCampId: null,
      selectedTile,
      activeBoard: EARTH,
      forceMode,
      battleStatusInHeader: true,
      combatInspectMode: previewMode,
      combatTargetCount: targets.length + sieges.length,
      opsOpen,
      logOpen,
      canUndo: !busy && state.current === 'A' && undoStack.length > 0,
      opsHtml: `
        <div class="hint">
          <b>单位</b>：蓝格移动，红框攻击。走完还能接着打，不用重新选。<br />
          <b>强制移动 / 攻击</b>：<kbd>Alt</kbd> / <kbd>Shift</kbd>；也可以打开「进阶操作」里的两个按钮。
          空地叠在同一格时，只有强制模式能指到下面那个。<br />
          <b>撤回</b>：<kbd>Ctrl</kbd>+<kbd>Z</kbd>，只在同一回合内可用。<br />
          <b>这一仗没有城</b>：所以没有生产、升级和招募——兵只从战利品、商店与事件里来。
        </div>`,
    });
    // 隐藏席位（中立单位用的 C）不该出现在席位栏里：它不占回合、不参与胜负
    if (hiddenSeats.length > 0) {
      for (const row of sideEl!.querySelectorAll<HTMLElement>('.seat-row')) {
        const dot = row.querySelector('.vs-dot');
        const seat = dot ? [...dot.classList].find((c) => c.length === 1)?.toUpperCase() : null;
        if (seat && hiddenSeats.includes(seat as never)) row.hidden = true;
      }
    }
    /*
     * 肉鸽独有的两张卡，补在战役面板上：
     *   · 我军 —— 战役里兵都围着城，点棋盘就够；肉鸽没有城，队伍可能散在
     *     地图边缘，而且"这一仗还剩几个人"是要一眼看到的；
     *   · 外人 —— 中立单位的场外交涉，战役里没有这种对象。
     * 每次先把上一次插的摘掉，再插新的：`renderPanel` 在 HTML 没变时会早退
     * （不动 DOM），不清就会一帧多一张。
     */
    for (const old of sideEl!.querySelectorAll(':scope > .rg-army-card, :scope > .rg-parley-card')) old.remove();
    const seats = sideEl!.querySelector('.card-seats');
    const army = armyCardHtml();
    if (army) {
      const card = document.createElement('div');
      card.className = 'card rg-army-card';
      card.innerHTML = army;
      sideEl!.insertBefore(card, seats?.nextSibling ?? sideEl!.firstChild);
    }
    const parley = parleyCardHtml();
    if (parley) {
      const card = document.createElement('div');
      card.className = 'card rg-parley-card';
      card.innerHTML = parley;
      sideEl!.appendChild(card);
    }
  }

  /** 我军清单：点一行 = 选中那个兵（棋盘之外的第二个入口） */
  function armyCardHtml(): string {
    const mine = unitsOf(state, 'A').filter((u) => u.hp > 0);
    if (mine.length === 0) return '';
    const combat = mine.filter((u) => utype(state, u.type).category === 'combat');
    const works = mine.filter((u) => utype(state, u.type).category === 'building');
    const rows = mine
      .map((u) => {
        const d = utype(state, u.type);
        const grow = growthOf(baseTypeOf(u.type), init.layer);
        const badge =
          grow && grow.step < grow.fullAt ? `<i class="rg-army-grow">成长 ${grow.step}/${grow.fullAt}</i>` : '';
        const done = u.moved && u.acted ? ' done' : u.moved || u.acted ? ' part' : '';
        const sel = u.id === selectedId ? ' sel' : '';
        const where =
          d.category === 'building'
            ? '工事'
            : u.moved && u.acted
              ? '已行动'
              : u.moved
                ? '已移动'
                : u.acted
                  ? '已攻击'
                  : `${String.fromCharCode(65 + u.x)}${u.y + 1}`;
        return `<button class="rg-army-row${sel}${done}" data-pick-unit="${u.id}" title="${escapeHtml(d.name)} · ${u.hp}/${maxHpOf(state, u)}">
          <span class="n">${escapeHtml(d.name)}${badge}</span>
          <span class="s">${u.hp}/${maxHpOf(state, u)} · ${where}</span>
        </button>`;
      })
      .join('');
    return `<div class="card-title">我军 <span class="hint">${combat.length} 个战斗单位${
      works.length > 0 ? ` · ${works.length} 处工事` : ''
    }</span></div><div class="rg-army-list">${rows}</div>`;
  }

  function parleyCardHtml(): string {
    const ns = neutrals();
    if (ns.length === 0) return '';
    const idle = state.current !== 'A' || busy || finished;
    return `<div class="card-title">外人 <span class="hint">不占回合 · 场外交涉</span></div>
      ${ns
        .map((u) => {
          const d = utype(state, u.type);
          const cost = recruitCost(u.type);
          const poor = state.players.A.gold < cost;
          return `<div class="rg-parley-row">
            <span class="rg-parley-name"><b>${escapeHtml(d.name)}</b><i>${u.hp}/${maxHpOf(state, u)} · 身价 ${d.cost ?? 0}</i></span>
            <button class="btn btn-sm" data-parley="${u.id}" ${poor || idle ? 'disabled' : ''}>招募 ${cost}</button>
            <button class="btn btn-sm" data-dismiss="${u.id}" ${idle ? 'disabled' : ''}>请走</button>
          </div>`;
        })
        .join('')}`;
  }

  function renderCombatPreview(): void {
    if (!pendingCombat) {
      previewEl!.hidden = true;
      previewEl!.innerHTML = '';
      return;
    }
    const forecast = forecastCombat(playerView(state, 'A'), 'A', pendingCombat);
    if (!forecast) {
      pendingCombat = null;
      previewEl!.hidden = true;
      return;
    }
    previewEl!.hidden = false;
    previewEl!.innerHTML = combatForecastHtml(forecast, true);
  }

  /* ---------------------------------------------------------------- 动作 */

  function act(action: Action): void {
    if (busy || finished || state.current !== 'A') return;
    const before = playerView(state, 'A');
    const r = step(state, action);
    if (!r.ok) {
      flash(r.reason ?? '这一步走不了');
      return;
    }
    if (action.type !== 'END_TURN') {
      undoStack.push(state);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    state = r.state;
    if (action.type === 'END_TURN') selectedId = null;
    pendingCombat = null;
    pendingSkill = null;
    skillAim = [];
    selectedCityId = null;
    selectedTile = null;
    render();
    const after = playerView(state, 'A');
    const note = actionFeedback(before, after, action);
    if (note) flash(note);
    checkEnd();
  }

  function undo(): void {
    if (busy || finished || state.current !== 'A') return;
    const prev = undoStack.pop();
    if (!prev) {
      flash('没有可以撤回的操作');
      return;
    }
    state = prev;
    selectedId = null;
    selectedCityId = null;
    selectedTile = null;
    pendingSkill = null;
    skillAim = [];
    pendingCombat = null;
    render();
  }

  function flash(msg: string): void {
    if (!feedbackEl) return;
    feedbackEl.textContent = msg;
    feedbackEl.hidden = false;
    window.setTimeout(() => {
      if (!disposed && feedbackEl) feedbackEl.hidden = true;
    }, 2600);
  }

  function checkEnd(): void {
    if (finished) return;
    const outcome = outcomeOf(state, init);
    if (!outcome) {
      if (roundsNow() > init.roundLimit) {
        finished = true;
        flash('拖太久了：这一战按撤退算。');
        window.setTimeout(() => {
          if (!disposed) handlers.onDone(resultOf(state, false));
        }, 900);
      }
      return;
    }
    finished = true;
    window.setTimeout(() => {
      if (!disposed) handlers.onDone(resultOf(state, outcome === 'win'));
    }, 900);
  }

  /* ---------------------------------------------------------------- 技能 */

  function castSkill(unitId: string, skillId: string, input?: string): void {
    if (busy || finished || state.current !== 'A') return;
    const unit = state.units.find((u) => u.id === unitId);
    if (!unit) return;
    const info = heroSkillsOf(state, unit).find((k) => k.def.id === skillId);
    if (!info) return;
    if (!info.ready) {
      flash(info.notReadyReason ?? '这个技能还不能用');
      return;
    }
    if (info.def.input && input === undefined) {
      const v = window.prompt(info.def.input.label);
      if (v === null) return;
      input = v;
    }
    const targeting = info.def.targeting;
    if (targeting === 'point' || targeting === 'direction') {
      pendingSkill = { unitId, skillId, targeting };
      skillAim =
        targeting === 'direction'
          ? [
              [0, -1],
              [0, 1],
              [-1, 0],
              [1, 0],
            ]
              .map(([dx, dy]) => {
                const x = unit.x + (dx as number);
                const y = unit.y + (dy as number);
                return x >= 0 && y >= 0 && x < state.w && y < state.h ? y * state.w + x : -1;
              })
              .filter((i) => i >= 0)
          : [];
      flash(targeting === 'point' ? '点地图上任意一格施法（点自己脚下取消）' : '点四个方向之一施法');
      render();
      return;
    }
    act({
      type: 'HERO_SKILL',
      unitId,
      skillId,
      targetX: unit.x,
      targetY: unit.y,
      ...(input !== undefined ? { input } : {}),
    });
  }

  /* ---------------------------------------------------------------- 中立 */

  function recruitCost(type: string): number {
    const c = utype(state, type).cost ?? 0;
    return Math.max(20, Math.round((c * 1.8) / 10) * 10);
  }

  function neutrals(): Unit[] {
    if (!init.neutral || init.neutral.length === 0 || init.allyCity) return [];
    return state.units.filter((u) => u.owner === 'C' && u.hp > 0);
  }

  function recruitNeutral(u: Unit): void {
    if (busy || finished || state.current !== 'A') return;
    const cost = recruitCost(u.type);
    if (state.players.A.gold < cost) {
      flash(`钱不够：招他得 ${cost} 金`);
      return;
    }
    undoStack.push(state);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    state = {
      ...state,
      units: state.units.map((x) =>
        x.id === u.id ? { ...x, owner: 'A' as const, moved: false, acted: false } : x,
      ),
      players: {
        ...state.players,
        A: { ...state.players.A, gold: state.players.A.gold - cost },
      },
    };
    render();
    flash(`${utype(state, u.type).name} 入了队（−${cost} 金）`);
  }

  function dismissNeutral(u: Unit): void {
    if (busy || finished || state.current !== 'A') return;
    undoStack.push(state);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    state = { ...state, units: state.units.filter((x) => x.id !== u.id) };
    render();
    flash('它走开了');
  }

  /* ---------------------------------------------------------------- AI */

  async function waitWhilePaused(): Promise<void> {
    while (paused && !disposed && !finished) await sleep(120);
  }

  async function runAi(): Promise<void> {
    if (busy || finished) return;
    busy = true;
    undoStack.length = 0;
    render();
    const budget: AiBudget = {
      ...DEFAULT_BUDGET,
      maxRecruit: Math.max(0, init.enemyRecruit - enemyRecruited),
      maxUpgrade: 0,
    };
    while (!disposed && !finished && state.current !== 'A' && !outcomeOf(state, init)) {
      await waitWhilePaused();
      if (disposed || finished) break;
      const seat = state.current;
      const rejected = new Set<string>();
      for (let i = 0; i < AI_MAX_STEPS; i += 1) {
        if (disposed || finished || state.current !== seat || outcomeOf(state, init)) break;
        await waitWhilePaused();
        const action = aiNextAction(state, budget, rejected);
        if (!action) break;
        const r = step(state, action);
        if (!r.ok) {
          rejected.add(aiActionKey(action));
          continue;
        }
        rejected.clear();
        state = r.state;
        if (action.type === 'RECRUIT') {
          budget.recruited += 1;
          enemyRecruited += 1;
        }
        if (action.type === 'UPGRADE') budget.upgraded += 1;
        render();
        await sleep(AI_SPEEDS[speedIdx]?.ms ?? 45);
      }
      if (!disposed && !finished && state.current === seat && !outcomeOf(state, init)) {
        const end = step(state, { type: 'END_TURN' });
        if (!end.ok) break;
        state = end.state;
      }
      render();
    }
    busy = false;
    arrivalWaves();
    render();
    checkEnd();
  }

  /* ---------------------------------------------------------------- 波次 */

  function arrivalWaves(): void {
    if (finished || disposed) return;
    let came = false;
    while (waveIdx < init.waves.length) {
      const wave = init.waves[waveIdx] as BattleInit['waves'][number];
      if (wave.atRound > roundsNow()) break;
      waveIdx += 1;
      const units = spawnWave(state, wave.types, init.seed ^ (waveIdx * 7919), foeSeat);
      if (units.length === 0) continue;
      came = true;
      flash(`第 ${waveIdx + 1} 波到了：${units.length} 个兵`);
    }
    if (came) render();
  }

  /* ---------------------------------------------------------------- 点击 */

  function tryCombat(action: CombatAction): void {
    if (previewMode) {
      pendingCombat = action;
      renderCombatPreview();
      render();
      return;
    }
    act(action);
  }

  boardEl!.addEventListener('click', (e) => {
    if (busy || finished || state.current !== 'A') return;
    const coords = cellAtPoint(boardEl!, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    if (!coords) return;
    const { x, y } = coords;

    /*
     * 不死鸟的蛋：引擎会在 `pendingEgg` 里挂一个"等你选一格"的状态，
     * 战役面板顶上都写了提示；棋盘这一下必须先把它放下去，否则点哪都没反应。
     */
    if (state.pendingEgg && state.pendingEgg.owner === 'A') {
      act({ type: 'PLACE_EGG', x, y });
      return;
    }

    if (pendingSkill) {
      const { unitId, skillId, targeting } = pendingSkill;
      const caster = state.units.find((u) => u.id === unitId);
      const onSelf = !!caster && caster.x === x && caster.y === y;
      const cell = y * state.w + x;
      const picked = targeting === 'point' ? !onSelf : skillAim.includes(cell);
      pendingSkill = null;
      skillAim = [];
      if (!picked) {
        flash('已取消施法');
        render();
        return;
      }
      act({ type: 'HERO_SKILL', unitId, skillId, targetX: x, targetY: y });
      return;
    }

    const mouse = e instanceof MouseEvent ? e : null;
    const wantMove = forceMode === 'move' || mouse?.altKey === true;
    const wantAttack = forceMode === 'attack' || mouse?.shiftKey === true;
    const cell = y * state.w + x;
    const unit = selected();

    if (wantMove) {
      if (!unit) {
        flash('先选中一个兵，再点强制移动');
        return;
      }
      if (reach.includes(cell)) {
        act({ type: 'MOVE', unitId: unit.id, x, y });
        return;
      }
      flash('这一格不在可达范围里');
      return;
    }
    if (wantAttack) {
      if (!unit) {
        flash('先选中一个兵，再点强制攻击');
        return;
      }
      const hit = stackAt(x, y).find((u) => targets.includes(u.id));
      if (hit) {
        tryCombat({ type: 'ATTACK', unitId: unit.id, targetId: hit.id, x, y });
        return;
      }
      flash(unit.acted ? '它这一回合已经打过了' : '这一格没有能打的目标');
      return;
    }

    const clicked = pickUnitAt(x, y, false);
    const city = state.cities.find((c) => x >= c.x && x < c.x + c.size && y >= c.y && y < c.y + c.size);

    // 先判"我方单位"：点自己的兵永远是选中，不会误触发攻击
    if (clicked && clicked.owner === 'A') {
      selectedId = clicked.id;
      selectedCityId = null;
      selectedTile = null;
      pendingCombat = null;
      render();
      return;
    }

    // 已选中我方单位：点敌人 → 攻击；点敌城 → 攻城；点可达格 → 移动
    if (unit) {
      if (clicked && targets.includes(clicked.id)) {
        tryCombat({ type: 'ATTACK', unitId: unit.id, targetId: clicked.id, x, y });
        return;
      }
      if (city && sieges.includes(city.id)) {
        tryCombat({ type: 'SIEGE', unitId: unit.id, cityId: city.id, x, y });
        return;
      }
      if (reach.includes(cell) && !clicked) {
        act({ type: 'MOVE', unitId: unit.id, x, y });
        return;
      }
    }

    // 什么都不做：把这一格/这座城/这个敌人当"查看对象"
    if (clicked) {
      selectedId = clicked.id;
      selectedCityId = null;
      selectedTile = null;
    } else if (city) {
      selectedId = null;
      selectedCityId = city.id;
      selectedTile = null;
    } else {
      selectedId = null;
      selectedCityId = null;
      selectedTile = { x, y };
    }
    pendingCombat = null;
    render();
  });

  /* ---------------------------------------------------------------- 面板/按钮 */

  rootEl!.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
    }
    if (e.key === 'Escape') {
      selectedId = null;
      selectedCityId = null;
      selectedTile = null;
      pendingSkill = null;
      skillAim = [];
      pendingCombat = null;
      forceMode = null;
      render();
    }
  });
  // 让键盘事件能进 root：棋盘/侧栏本身不是可聚焦元素
  rootEl!.tabIndex = -1;

  rootEl!.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;

    /* ---- 棋盘缩放 ---- */
    const zoomAct = target?.closest<HTMLElement>('[data-act="zoom-fit"],[data-act="zoom-in"],[data-act="zoom-out"]')?.dataset.act;
    if (zoomAct) {
      if (zoomAct === 'zoom-fit') setZoom(1);
      else if (zoomAct === 'zoom-in') zoomStep(1);
      else zoomStep(-1);
      return;
    }

    /* ---- 我军清单（侧栏） ---- */
    const pickUnit = target?.closest<HTMLElement>('[data-pick-unit]')?.dataset.pickUnit;
    if (pickUnit) {
      selectedId = pickUnit;
      selectedCityId = null;
      selectedTile = null;
      pendingCombat = null;
      render();
      return;
    }

    /* ---- 顶栏 ---- */
    const topAct = target?.closest<HTMLElement>('[data-act="pause"],[data-act="speed"]')?.dataset.act;
    if (topAct === 'pause') {
      paused = !paused;
      render();
      return;
    }
    if (topAct === 'speed') {
      speedIdx = (speedIdx + 1) % AI_SPEEDS.length;
      render();
      return;
    }
    const viewId = target?.closest<HTMLElement>('[data-act="board-view"]')?.dataset.id;
    if (viewId) {
      activeView = activeView === viewId ? null : viewId;
      render();
      return;
    }

    /* ---- 攻击预览的确认/取消 ---- */
    const combat = target?.closest<HTMLElement>('[data-combat]')?.dataset.combat;
    if (combat === 'cancel') {
      pendingCombat = null;
      render();
      return;
    }
    if (combat === 'confirm' && pendingCombat) {
      const action = pendingCombat;
      pendingCombat = null;
      act(action);
      return;
    }

    /* ---- 面板动作 ---- */
    const actName = target?.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (actName === 'end-turn') {
      if (busy || finished || state.current !== 'A') return;
      const r = step(state, { type: 'END_TURN' });
      if (r.ok) {
        state = r.state;
        selectedId = null;
        selectedCityId = null;
        selectedTile = null;
        pendingSkill = null;
        skillAim = [];
        pendingCombat = null;
        undoStack.length = 0;
        render();
        void runAi();
      }
      return;
    }
    if (actName === 'undo') {
      undo();
      return;
    }
    if (actName === 'surrender') {
      if (busy || finished) return;
      finished = true;
      handlers.onDone({ win: false, survivors: [], gold: state.players.A.gold, turns: state.turn });
      return;
    }
    if (actName === 'force-move') {
      forceMode = forceMode === 'move' ? null : 'move';
      pick = null;
      render();
      return;
    }
    if (actName === 'force-attack') {
      forceMode = forceMode === 'attack' ? null : 'attack';
      pick = null;
      render();
      return;
    }
    if (actName === 'combat-aim') {
      previewMode = !previewMode;
      pendingCombat = null;
      render();
      return;
    }
    if (actName === 'disband') {
      const unit = selected();
      if (unit && unit.owner === 'A') act({ type: 'DISBAND', unitId: unit.id });
      return;
    }
    if (actName === 'drawer-toggle') {
      const open = drawerEl!.dataset.expanded !== 'true';
      drawerEl!.dataset.expanded = String(open);
      const btn = drawerEl!.querySelector<HTMLElement>('[data-act="drawer-toggle"]');
      btn?.setAttribute('aria-expanded', String(open));
      const stateEl = drawerEl!.querySelector<HTMLElement>('.drawer-state');
      if (stateEl) stateEl.textContent = open ? '收起' : '展开详情';
      return;
    }

    const skillId = target?.closest<HTMLElement>('[data-act="hero-skill"]')?.dataset.skill;
    if (skillId) {
      const unitId = target?.closest<HTMLElement>('[data-act="hero-skill"]')?.dataset.id;
      if (!unitId) return;
      const item = target?.closest<HTMLElement>('.skill-item');
      const inputEl = item?.querySelector<HTMLInputElement>('.skill-input');
      castSkill(unitId, skillId, inputEl ? inputEl.value : undefined);
      return;
    }

    const actionId = target?.closest<HTMLElement>('[data-act="unit-action"]')?.dataset.action;
    if (actionId) {
      const unitId = target?.closest<HTMLElement>('[data-act="unit-action"]')?.dataset.id;
      if (unitId) act({ type: 'UNIT_ACTION', unitId, actionId });
      return;
    }

    // 生产/建造/升级：肉鸽前三层没有城，也不让在战场上补员
    if (actName === 'recruit' || actName === 'build' || actName === 'upgrade' || actName === 'open-camp') {
      flash('肉鸽里不能造兵：兵只从战利品、商店和事件来');
      return;
    }

    const rec = target?.closest<HTMLElement>('[data-parley]')?.dataset.parley;
    if (rec) {
      const u = state.units.find((x) => x.id === rec);
      if (u) recruitNeutral(u);
      return;
    }
    const dis = target?.closest<HTMLElement>('[data-dismiss]')?.dataset.dismiss;
    if (dis) {
      const u = state.units.find((x) => x.id === dis);
      if (u) dismissNeutral(u);
      return;
    }
  });

  /* ---- 折叠状态、缩放拖拽 ---- */
  sideEl!.addEventListener(
    'toggle',
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!el || !el.classList.contains('card-fold')) return;
      if (el.dataset.fold === 'ops' || !el.dataset.fold) opsOpen = (el as HTMLDetailsElement).open;
      if (el.dataset.fold === 'log') logOpen = (el as HTMLDetailsElement).open;
    },
    true,
  );

  let dragging = false;
  let dragFrom = { x: 0, y: 0, left: 0, top: 0 };
  boardScrollEl.addEventListener('pointerdown', (e) => {
    if (boardZoom <= 1) return;
    dragging = true;
    dragFrom = { x: e.clientX, y: e.clientY, left: boardScrollEl.scrollLeft, top: boardScrollEl.scrollTop };
    boardScrollEl.classList.add('dragging');
  });
  boardScrollEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    boardScrollEl.scrollLeft = dragFrom.left - (e.clientX - dragFrom.x);
    boardScrollEl.scrollTop = dragFrom.top - (e.clientY - dragFrom.y);
  });
  const endDrag = (): void => {
    dragging = false;
    boardScrollEl.classList.remove('dragging');
  };
  boardScrollEl.addEventListener('pointerup', endDrag);
  boardScrollEl.addEventListener('pointercancel', endDrag);
  boardScrollEl.addEventListener('pointerleave', endDrag);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    fitDirty = true;
    applyFit();
  }) : null;
  ro?.observe(boardWrapEl);

  /* ---------------------------------------------------------------- 启动 */

  arrivalWaves();
  render();
  // 让根节点拿到焦点，Ctrl+Z / Esc 才能用
  window.setTimeout(() => rootEl.focus(), 0);
  if (state.current !== 'A') void runAi();

  return () => {
    disposed = true;
    ro?.disconnect();
    host.innerHTML = '';
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}


/**
 * 战斗屏：把核心棋盘搬过来，只做"肉鸽需要的那几件事"。
 *
 * 为什么不复用主程序那一套：主程序（main.ts）是一万多行的装配层，里面有联机、
 * 回放、选卡、指挥官、星图、战报上传……肉鸽只需要"选中 / 移动 / 攻击 / 攻城 / 结束回合"。
 * 而**规则和渲染**都是现成的独立模块（core/* 与 ui/board.ts），直接调它们，
 * 既能保证"打起来的手感和本体一样"，又不用改本体任何一行。
 *
 * 手感跟上本体的三件事（2026-11-23 按反馈补的）：
 *   · **选中一次就能先走再打**——移动之后不清选中，同一条命令链走完；
 *   · **能撤回**——每步都压栈，Ctrl+Z 或按按钮退回上一步（结束回合后清空）；
 *   · 没有招募——前三层玩家没有城，这一关只打这一支部队。
 */
import { AI_MAX_STEPS, aiActionKey, aiNextAction } from '../core/ai.ts';
import { DEFAULT_BUDGET } from '../core/ai-meta.ts';
import { attackableTargets, maxHpOf, reachableTiles, siegeTargets, unitById, unitsOf, utype } from '../core/rules.ts';
import { describeUnit, unitStatLine } from '../core/info.ts';
import { playerView } from '../core/fog.ts';
import { cellAtPoint, renderBoard } from '../ui/board.ts';
import type { BoardUi } from '../ui/board.ts';
import type { AiBudget } from '../core/ai-meta.ts';
import type { Action, GameState, Unit } from '../core/types.ts';
import { buildBattle, outcomeOf, resultOf, step } from './battle.ts';
import type { BattleInit, BattleResult } from './types.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
/** 撤回上限：一回合里走不到这么多步，够用又不会把内存拖大 */
const UNDO_LIMIT = 40;

interface BattleHandlers {
  onDone: (result: BattleResult) => void;
}

export function mountBattle(host: HTMLElement, init: BattleInit, handlers: BattleHandlers): () => void {
  let state: GameState = buildBattle(init);
  let selectedId: string | null = null;
  let reach: number[] = [];
  let targets: string[] = [];
  let sieges: string[] = [];
  let busy = false;
  let finished = false;
  let disposed = false;
  /** 撤回栈：每次我方动作之前压一份，结束回合清空（和本体一个口径） */
  const undoStack: GameState[] = [];
  /** 敌人这一场已经补了几个兵（`AiBudget.maxRecruit` 是**每回合**的额度，得自己累计） */
  let enemyRecruited = 0;

  host.innerHTML = `
    <div class="rg-battle">
      <div class="rg-battle-head">
        <div class="rg-battle-title">
          <b>${escapeHtml(init.label)}</b>
          <span>${escapeHtml(init.sub)}</span>
        </div>
        <div class="rg-battle-hud" id="rg-hud"></div>
        <div class="rg-battle-btns">
          <button class="rg-btn ghost" data-act="undo" id="rg-undo">撤回</button>
          <button class="rg-btn" data-act="end">结束回合</button>
          <button class="rg-btn ghost" data-act="quit">认输</button>
        </div>
      </div>
      <div class="rg-hovercard" id="rg-hovercard" hidden></div>
      <div class="rg-battle-body">
        <div class="rg-boardwrap">
          <div class="board rg-board" id="rg-board"></div>
        </div>
        <aside class="rg-side">
          <div class="rg-side-card">
            <h4>我军</h4>
            <div id="rg-army" class="rg-army"></div>
          </div>
          <div class="rg-side-card">
            <h4>战况</h4>
            <div id="rg-foes" class="rg-foes"></div>
          </div>
          <div class="rg-side-card grow">
            <h4>操作</h4>
            <div id="rg-tip" class="rg-tip"></div>
          </div>
        </aside>
      </div>
    </div>`;

  const boardEl = host.querySelector<HTMLElement>('#rg-board');
  const hoverEl = host.querySelector<HTMLElement>('#rg-hovercard');
  const hudEl = host.querySelector<HTMLElement>('#rg-hud');
  const armyEl = host.querySelector<HTMLElement>('#rg-army');
  const foeEl = host.querySelector<HTMLElement>('#rg-foes');
  const tipEl = host.querySelector<HTMLElement>('#rg-tip');
  const undoBtn = host.querySelector<HTMLButtonElement>('#rg-undo');
  if (!boardEl || !hudEl || !armyEl || !foeEl || !tipEl || !undoBtn || !hoverEl) {
    throw new Error('战斗界面结构缺失');
  }

  /** 单位属性卡：和本体一样，指到谁就看谁 */
  function statCardHtml(u: Unit): string {
    const def = utype(state, u.type);
    const lines = describeUnit(state, def, u.owner, u);
    const hp = `${u.hp}/${maxHpOf(state, u)}`;
    return `<div class="rg-hc-head"><b>${escapeHtml(def.name)}</b><i>${u.owner === 'A' ? '我方' : '敌方'}</i></div>
      <div class="rg-hc-hp"><span style="width:${Math.max(0, Math.min(100, (u.hp / Math.max(1, maxHpOf(state, u))) * 100))}%"></span><em>${hp}</em></div>
      <div class="rg-hc-stats">${escapeHtml(unitStatLine(def))}</div>
      ${lines.map((l) => `<div class="rg-hc-line">${escapeHtml(l)}</div>`).join('')}`;
  }

  boardEl.addEventListener('mouseover', (e) => {
    const id = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-id]')?.dataset.id;
    const u = id ? unitById(state, id) : undefined;
    if (!u || !hoverEl) return;
    hoverEl.innerHTML = statCardHtml(u);
    hoverEl.hidden = false;
  });
  boardEl.addEventListener('mousemove', (e) => {
    if (!hoverEl || hoverEl.hidden) return;
    const ev = e as MouseEvent;
    const x = Math.min(window.innerWidth - 220, ev.clientX + 16);
    const y = Math.min(window.innerHeight - 160, ev.clientY + 12);
    hoverEl.style.left = `${x}px`;
    hoverEl.style.top = `${y}px`;
  });
  boardEl.addEventListener('mouseout', (e) => {
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (to && to.closest?.('[data-id]')) return;
    if (hoverEl) hoverEl.hidden = true;
  });

  function selected(): Unit | undefined {
    return selectedId ? state.units.find((u) => u.id === selectedId) : undefined;
  }

  /** 重新算"这个兵还能去哪、打谁"：移动过的只剩攻击，打过的两样都没有 */
  function refreshSelection(): void {
    const unit = selected();
    if (!unit || unit.owner !== 'A' || state.current !== 'A' || unit.hp <= 0) {
      selectedId = null;
      reach = [];
      targets = [];
      sieges = [];
      return;
    }
    reach = unit.moved ? [] : [...reachableTiles(state, unit).keys()];
    targets = unit.acted ? [] : attackableTargets(state, unit).map((u) => u.id);
    sieges = unit.acted ? [] : siegeTargets(state, unit).map((c) => c.id);
  }

  function render(): void {
    if (disposed) return;
    refreshSelection();
    const ui: BoardUi = {
      selectedId,
      reach,
      targets,
      siegeTargets: sieges,
      selectedCityId: null,
      placeable: [],
      threat: [],
    };
    renderBoard(boardEl as HTMLElement, playerView(state, 'A'), ui);

    const rounds = Math.ceil(state.turn / 2);
    const mine = unitsOf(state, 'A').length;
    const foes = unitsOf(state, 'B').length;
    hudEl!.innerHTML = `
      <span>回合 <b>${rounds}</b>/${init.roundLimit}</span>
      <span>我 <b>${mine}</b> · 敌 <b>${foes}</b></span>
      <span>${state.current === 'A' ? (busy ? '对方行动中…' : '轮到你') : '对方行动中…'}</span>`;

    armyEl!.innerHTML =
      mine === 0
        ? '<p class="rg-dim">一个兵都没有了。</p>'
        : unitsOf(state, 'A')
            .map((u) => {
              const d = utype(state, u.type);
              const cls = u.id === selectedId ? 'sel' : '';
              const done = u.moved && u.acted ? 'done' : '';
              const where = u.moved && !u.acted ? '已移动' : u.acted ? '已行动' : `${u.x},${u.y}`;
              return `<button class="rg-unitrow ${cls} ${done}" data-unit="${u.id}">
                <span class="n">${escapeHtml(d.name)}</span>
                <span class="s">${u.hp}/${maxHpOf(state, u)} · ${where}</span>
              </button>`;
            })
            .join('');

    foeEl!.innerHTML =
      foes === 0
        ? '<p class="rg-dim">对面已经没人了。</p>'
        : `<p class="rg-dim">还剩 ${foes} 个单位${
            init.enemyCityCount > 0 ? `、${init.enemyCityCount} 座城` : ''
          }。</p>`;

    tipEl!.innerHTML = hintText();
    undoBtn!.disabled = busy || state.current !== 'A' || undoStack.length === 0;
  }

  function hintText(): string {
    if (finished) return '这一战已经结束。';
    if (busy || state.current !== 'A') return '对面在想。';
    const unit = selected();
    if (!unit) {
      return '点自己的兵 → 点空格移动 / 点敌人开火 / 点敌城攻城。<br>走完还能接着打，不用重新选。';
    }
    const name = escapeHtml(utype(state, unit.type).name);
    if (unit.moved && unit.acted) return `${name} 这一回合已经动完了。`;
    if (unit.moved) return `${name} 已经走过了，现在可以开火（红框是目标）。`;
    if (unit.acted) return `${name} 已经打过了，还能走（绿点是可达格）。`;
    return `${name}：绿点走，红框打。走完还能打。`;
  }

  function act(action: Action): void {
    if (busy || finished || state.current !== 'A') return;
    const r = step(state, action);
    if (!r.ok) {
      flashTip(r.reason ?? '这一步走不了');
      return;
    }
    if (action.type !== 'END_TURN') {
      undoStack.push(state);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    state = r.state;
    // 关键：移动之后**不清选中**——同一条命令链走完，和本体一致
    if (action.type === 'END_TURN') selectedId = null;
    render();
    checkEnd();
  }

  function undo(): void {
    if (busy || finished || state.current !== 'A') return;
    const prev = undoStack.pop();
    if (!prev) {
      flashTip('没有可以撤回的操作');
      return;
    }
    state = prev;
    selectedId = null;
    render();
  }

  function flashTip(msg: string): void {
    tipEl!.textContent = msg;
    window.setTimeout(() => {
      if (!disposed) tipEl!.innerHTML = hintText();
    }, 1800);
  }

  function checkEnd(): void {
    if (finished) return;
    const outcome = outcomeOf(state);
    if (!outcome) {
      // 超时：小图打到二十几轮还没结果，就是"两边都不想打"
      if (Math.ceil(state.turn / 2) > init.roundLimit) {
        finished = true;
        flashTip('拖太久了：这一战按撤退算。');
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

  async function runAi(): Promise<void> {
    if (busy || finished) return;
    busy = true;
    undoStack.length = 0;
    render();
    /*
     * 不给 AI 补员：这一关两边都只打**开局编队**。
     *
     * 玩家没有城，本来就没法补；让对面能补就是单方面加血——实测攻坚关里
     * 敌人每两回合摸出一个民兵，玩家再能打也磨不过。`AiBudget` 就是现成的闸门。
     */
    /*
     * 有城的关卡允许敌人补员（最多 init.enemyRecruit 个），没城的关卡一个都不给——
     * 那是"开局编队"的仗。补员要占它的金币，所以城是有价值的，但撑不了无限磨。
     */
    const budget: AiBudget = {
      ...DEFAULT_BUDGET,
      // 整场总量，不是每回合：额度减掉已经补过的，补满就再也不补
      maxRecruit: Math.max(0, init.enemyRecruit - enemyRecruited),
      maxUpgrade: 0,
    };
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS; i += 1) {
      if (disposed || finished || state.current !== 'B' || outcomeOf(state)) break;
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
      await sleep(40);
    }
    if (!disposed && !finished && state.current === 'B' && !outcomeOf(state)) {
      const end = step(state, { type: 'END_TURN' });
      if (end.ok) state = end.state;
    }
    busy = false;
    render();
    checkEnd();
  }

  boardEl.addEventListener('click', (e) => {
    if (busy || finished || state.current !== 'A') return;
    const coords = cellAtPoint(boardEl as HTMLElement, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    if (!coords) return;
    const { x, y } = coords;
    const clicked = state.units.find((u) => u.x === x && u.y === y && u.hp > 0);
    if (clicked && clicked.owner === 'A') {
      selectedId = clicked.id;
      render();
      return;
    }
    const unit = selected();
    if (unit) {
      if (clicked && targets.includes(clicked.id)) {
        act({ type: 'ATTACK', unitId: unit.id, targetId: clicked.id, x, y });
        return;
      }
      const city = state.cities.find((c) => x >= c.x && x < c.x + c.size && y >= c.y && y < c.y + c.size);
      if (city && sieges.includes(city.id)) {
        act({ type: 'SIEGE', unitId: unit.id, cityId: city.id, x, y });
        return;
      }
      const idx = y * state.w + x;
      if (reach.includes(idx)) {
        act({ type: 'MOVE', unitId: unit.id, x, y });
        return;
      }
    }
    selectedId = null;
    render();
  });

  host.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
    }
  });

  host.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const act0 = target?.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act0 === 'end') {
      if (busy || finished || state.current !== 'A') return;
      const r = step(state, { type: 'END_TURN' });
      if (r.ok) {
        state = r.state;
        selectedId = null;
        undoStack.length = 0;
        render();
        void runAi();
      }
      return;
    }
    if (act0 === 'undo') {
      undo();
      return;
    }
    if (act0 === 'quit') {
      if (busy || finished) return;
      finished = true;
      handlers.onDone({ win: false, survivors: [], gold: state.players.A.gold, turns: state.turn });
      return;
    }
    const unitId = target?.closest<HTMLElement>('[data-unit]')?.dataset.unit;
    if (unitId) {
      selectedId = unitId;
      render();
    }
  });

  render();
  if (state.current === 'B') void runAi();

  return () => {
    disposed = true;
    host.innerHTML = '';
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

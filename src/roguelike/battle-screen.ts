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
import { attackableTargets, heroSkillsOf, isAirborne, maxHpOf, reachableTiles, siegeTargets, unitById, unitsAt, unitsOf, utype } from '../core/rules.ts';
import { describeUnit, unitStatLine } from '../core/info.ts';
import { playerView } from '../core/fog.ts';
import { cellAtPoint, renderBoard } from '../ui/board.ts';
import type { BoardUi } from '../ui/board.ts';
import type { AiBudget } from '../core/ai-meta.ts';
import type { Action, GameState, Unit } from '../core/types.ts';
import { buildBattle, baseTypeOf, outcomeOf, resultOf, spawnWave, step } from './battle.ts';
import { CULTIVATORS, growthOf } from './data.ts';
import { expForRank, getExp, getRank, REALMS } from '../core/cultivation/progression.ts';
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
  /** 守城战：下一波还没到的那一波 */
  let waveIdx = 0;
  /** 三席守城：B 是友军、C 是攻方；两席局敌人仍是 B */
  const foeSeat = init.allyCity ? ('C' as const) : ('B' as const);
  /** 这一局几个席位：回合按"每人一次"算，不能写死 /2 */
  const hiddenSeats = state.config.level?.seats?.hidden?.length ?? 0;
  const seats = Math.max(1, (state.config.playerCount ?? 2) - hiddenSeats);
  const roundsNow = (): number => Math.ceil(state.turn / seats);
  /**
   * 正在等落点的技能。
   *
   * 本体的施法流程是两步（点技能 → 点地图），这里照搬同一个节奏：
   * 方向型只认施法者四邻，选点型认任意格（自己脚下算取消）。
   * 我们的英雄技能目前全是 `targeting: 'none'`（战吼、圣旗、招魂……），
   * 所以绝大多数情况下点一下就放；把选点这条路留着，是为了别让
   * 以后加进来的法术在肉鸽里变成"点了没反应"。
   */
  let pendingSkill: { unitId: string; skillId: string; targeting: 'point' | 'direction' } | null = null;
  let skillAim: number[] = [];
  /**
   * 强制模式（照抄本体）：`move` = 点哪格就走上去，`attack` = 点哪格就开火。
   *
   * 为什么需要它：空中单位和地面单位**可以叠在同一格**（引擎按层判占位），
   * 而"点这一格"只能有一个意思。没有强制模式时，地勤兵压在飞行兵身上，
   * 你就永远选不到下面那个、也永远挪不上去——这就是"我方空地做不到重合"。
   * 本体用 Alt / Shift + 两个按钮解决，这里照搬，只去掉肉鸽用不上的部分。
   */
  let forceMode: 'move' | 'attack' | null = null;
  /** 同一格连点翻页：记上一次点的格子与翻到第几个 */
  let pick: { key: number; ids: string[]; index: number } | null = null;

  host.innerHTML = `
    <div class="rg-battle">
      <div class="rg-battle-head">
        <div class="rg-battle-title">
          <b>${escapeHtml(init.label)}</b>
          <span>${escapeHtml(init.sub)}</span>
        </div>
        <div class="rg-battle-hud" id="rg-hud"></div>
        <div class="rg-battle-btns">
          <button class="rg-btn ghost mini" data-act="force-move" id="rg-force-move" title="按 Alt 点格子 = 临时用一次">强制移动 <kbd>Alt</kbd></button>
          <button class="rg-btn ghost mini" data-act="force-attack" id="rg-force-attack" title="按 Shift 点格子 = 临时用一次">强制攻击 <kbd>Shift</kbd></button>
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
          <div class="rg-side-card" id="rg-neutral-card" hidden>
            <h4>外人</h4>
            <div id="rg-neutral" class="rg-foes"></div>
          </div>
          <div class="rg-side-card">
            <h4>技能</h4>
            <div id="rg-skills" class="rg-skills"></div>
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
  const neutralCardEl = host.querySelector<HTMLElement>('#rg-neutral-card');
  const neutralEl = host.querySelector<HTMLElement>('#rg-neutral');
  const skillEl = host.querySelector<HTMLElement>('#rg-skills');
  const tipEl = host.querySelector<HTMLElement>('#rg-tip');
  const undoBtn = host.querySelector<HTMLButtonElement>('#rg-undo');
  const forceMoveBtn = host.querySelector<HTMLButtonElement>('#rg-force-move');
  const forceAttackBtn = host.querySelector<HTMLButtonElement>('#rg-force-attack');
  if (!boardEl || !hudEl || !armyEl || !foeEl || !tipEl || !undoBtn || !hoverEl || !skillEl) {
    throw new Error('战斗界面结构缺失');
  }

  /** 单位属性卡：和本体一样，指到谁就看谁 */
  function statCardHtml(u: Unit): string {
    const def = utype(state, u.type);
    const lines = describeUnit(state, def, u.owner, u);
    const hp = `${u.hp}/${maxHpOf(state, u)}`;
    const base = baseTypeOf(u.type);
    const grow = growthOf(base, init.layer);
    /*
     * 修士的境界：`describeUnit` 只讲兵种定义，不讲这个单位**现在**修到哪了。
     * 但境界正是修士一半的数值来源（每级 +3 攻 / +8 血），也是玩家判断
     * "这个长老我打不打得动"的唯一依据，必须在卡上写出来。
     */
    const cult = CULTIVATORS.has(base);
    const rank = cult ? getRank(u) : 0;
    const exp = cult ? getExp(u) : 0;
    const next = cult && rank < 9 ? expForRank(rank) : 0;
    const side =
      u.owner === 'A'
        ? '我方'
        : init.allyCity && u.owner === 'B'
          ? '友军'
          : !init.allyCity && u.owner === 'C'
            ? '中立'
            : '敌方';
    return `<div class="rg-hc-head"><b>${escapeHtml(def.name)}</b><i>${side}</i></div>
      <div class="rg-hc-hp"><span style="width:${Math.max(0, Math.min(100, (u.hp / Math.max(1, maxHpOf(state, u))) * 100))}%"></span><em>${hp}</em></div>
      <div class="rg-hc-stats">${escapeHtml(unitStatLine(def))}</div>
      ${
        grow && grow.step < grow.fullAt
          ? `<div class="rg-hc-line">成长期 ${grow.step}/${grow.fullAt}：它自己的时代还在第 ${grow.fullAt} 层，每层末长一次。</div>`
          : ''
      }
      ${
        cult
          ? `<div class="rg-hc-line rg-hc-realm">境界 <b>${REALMS[rank] ?? '凡人'}</b>（攻 +${rank * 3} / 血 +${rank * 8}）· 修为 ${exp}${
              rank >= 9 ? '（已至顶）' : ` / ${next}`
            }</div>`
          : ''
      }
      ${lines.map((l) => `<div class="rg-hc-line">${escapeHtml(l)}</div>`).join('')}`;
  }

  /** 跟"外人"打交道的价钱：身价的 1.8 倍，取整到 10 */
  function recruitCost(type: string): number {
    const c = utype(state, type).cost ?? 0;
    return Math.max(20, Math.round((c * 1.8) / 10) * 10);
  }

  /** 场外的中立单位（守城战里的 C 是攻方，不能算进来） */
  function neutrals(): Unit[] {
    if (!init.neutral || init.neutral.length === 0 || init.allyCity) return [];
    return state.units.filter((u) => u.owner === 'C' && u.hp > 0);
  }

  /**
   * 交涉：花钱把它招进来。
   *
   * 它**战后会留在队里**（`survivorsOf` 按 owner 收人），所以这不是"借用一回合"，
   * 是雇一个兵——价格按身价 1.8 倍定，和商店的 1.15 倍相比贵了三成，
   * 买的是"当场多一个能打的"，不是便宜货。
   */
  function recruitNeutral(u: Unit): void {
    if (busy || finished || state.current !== 'A') return;
    const cost = recruitCost(u.type);
    if (state.players.A.gold < cost) {
      flashTip(`钱不够：招他得 ${cost} 金`);
      return;
    }
    /*
     * 这里**必须造一个新 state**，不能就地改。
     *
     * 撤回转的是引用：就地改的话，刚才压进栈的那份"回忆"也跟着变了，
     * Ctrl+Z 退回去会发现钱已经扣了、人也已经是我们的人了。
     */
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
    flashTip(`${utype(state, u.type).name} 入了队（−${cost} 金）`);
  }

  /** 交涉：请它走开（不花钱，但也没有兵） */
  function dismissNeutral(u: Unit): void {
    if (busy || finished || state.current !== 'A') return;
    undoStack.push(state);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    // 同上：造新 state，别让撤回栈里的那份跟着被改掉
    state = { ...state, units: state.units.filter((x) => x.id !== u.id) };
    render();
    flashTip('它走开了');
  }

  /**
   * 把属性卡放进视口：先量它有多高，下方放不下就翻到鼠标上方。
   *
   * 上一版把 `top` 硬夹在 `innerHeight - 160`——那是按普通兵五六行算的。
   * 修真单位多出「境界 / 特殊能力 / 技能」好几段，卡能到三百像素高，
   * 底部直接被屏幕切掉；偏偏玩家自己的兵都摆在棋盘下沿，悬停时最容易撞上。
   */
  function placeHover(x: number, y: number): void {
    if (!hoverEl) return;
    const pad = 10;
    const w = hoverEl.offsetWidth || 252;
    const h = hoverEl.offsetHeight || 180;
    let left = Math.min(window.innerWidth - w - pad, x + 16);
    if (left < pad) left = pad;
    let top = y + 12;
    if (top + h > window.innerHeight - pad) top = y - h - 12;
    top = Math.max(pad, Math.min(window.innerHeight - h - pad, top));
    hoverEl.style.left = `${left}px`;
    hoverEl.style.top = `${top}px`;
  }

  boardEl.addEventListener('mouseover', (e) => {
    const id = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-id]')?.dataset.id;
    const u = id ? unitById(state, id) : undefined;
    if (!u || !hoverEl) return;
    hoverEl.innerHTML = statCardHtml(u);
    hoverEl.hidden = false;
    const ev = e as MouseEvent;
    placeHover(ev.clientX, ev.clientY);
  });
  boardEl.addEventListener('mousemove', (e) => {
    if (!hoverEl || hoverEl.hidden) return;
    const ev = e as MouseEvent;
    placeHover(ev.clientX, ev.clientY);
  });
  boardEl.addEventListener('mouseout', (e) => {
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (to && to.closest?.('[data-id]')) return;
    // 鼠标移到卡片上（为了滚动看全文）时不要收起来
    if (to && hoverEl && hoverEl.contains(to)) return;
    if (hoverEl) hoverEl.hidden = true;
  });
  // 卡片本身可滚：从卡片上离开再收起
  hoverEl.addEventListener('mouseleave', () => {
    hoverEl.hidden = true;
  });

  function selected(): Unit | undefined {
    return selectedId ? state.units.find((u) => u.id === selectedId) : undefined;
  }

  /**
   * 这一格上压着哪些单位，按渲染顺序排（空中 → 地面 → 建筑）。
   *
   * 和 board.ts 的绘制顺序一致：眼睛看到谁在上面，第一下点就该选中谁，
   * 再点一下往下翻。`unitsAt` 认的是"覆盖格"，所以 2×2 的建筑也对。
   */
  function stackAt(x: number, y: number): Unit[] {
    const rank = (u: Unit): number => {
      if (utype(state, u.type).category === 'building') return 2;
      return isAirborne(state, u) ? 0 : 1;
    };
    return unitsAt(state, x, y)
      .filter((u) => u.hp > 0)
      .sort((a, b) => rank(a) - rank(b));
  }

  /**
   * 点这一格到底选中谁：同格连点就是往下翻一层。
   * `preferTarget`（强制攻击）时优先挑"我能打的"——飞行兵停在敌人头顶时，
   * 按 Shift 点的意思一定是打脚下那个，不是选中自己的兵。
   */
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

  /** 走不上这一格时给一句原因——静默没反应比报错更让人困惑 */
  function moveRefusal(x: number, y: number, unit: Unit): string {
    const blockers = stackAt(x, y).filter((u) => u.id !== unit.id);
    if (blockers.length > 0) {
      return `这一格被「${utype(state, (blockers[0] as Unit).type).name}」占着，走不上去`;
    }
    return '这一格不在可达范围里';
  }

  /** 重新算"这个兵还能去哪、打谁"：移动过的只剩攻击，打过的两样都没有 */
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
    // 工事永远不给"可达格"：本体里它们 move 0，肉鸽的加成也不该落到它们身上。
    reach = unit.moved || isWork ? [] : [...reachableTiles(state, unit).keys()];
    targets = unit.acted ? [] : attackableTargets(state, unit).map((u) => u.id);
    sieges = unit.acted ? [] : siegeTargets(state, unit).map((c) => c.id);
  }

  /**
   * 技能栏：只列**当前选中那个兵**的主动技能。
   *
   * 本体那边是一整块指挥官面板（产兵、升级、装备、技能），肉鸽只留技能这一格：
   * 前三层玩家没有城，其余按钮在这里都没有意义。按钮的"灰"和规则层
   * （`heroSkillsOf.ready`）走同一个判据，不会出现"按钮亮着、点下去被拒"。
   */
  function renderSkills(): void {
    const unit = selected();
    const list = unit && state.current === 'A' && unit.owner === 'A' ? heroSkillsOf(state, unit) : [];
    if (!unit) {
      skillEl!.innerHTML = '<p class="rg-dim">选中一个兵，看它会不会技能。</p>';
      return;
    }
    if (list.length === 0) {
      skillEl!.innerHTML = `<p class="rg-dim">${escapeHtml(utype(state, unit.type).name)} 没有主动技能。</p>`;
      return;
    }
    skillEl!.innerHTML = list
      .map((k) => {
        const why = k.notReadyReason ?? (k.toNext > 0 ? `${k.toNext} 回合` : '冷却中');
        return `<button class="rg-skill" data-skill="${k.def.id}" ${k.ready ? '' : 'disabled'} title="${escapeHtml(
          k.def.summary,
        )}">
          <b>${escapeHtml(k.def.name)}</b>
          <span>${escapeHtml(k.ready ? k.def.summary : why)}</span>
        </button>`;
      })
      .join('');
  }

  function render(): void {
    if (disposed) return;
    refreshSelection();
    const ui: BoardUi = {
      selectedId,
      reach,
      targets,
      siegeTargets: sieges,
      aimTiles: skillAim,
      selectedCityId: null,
      placeable: [],
      threat: [],
    };
    renderBoard(boardEl as HTMLElement, playerView(state, 'A'), ui);

    const rounds = roundsNow();
    /*
     * 人数只数**战斗单位**：守城战时玩家有塔和墙，它们不是"人"，
     * 混进"我 5"里会让人以为还剩五个兵，其实只剩三个。
     */
    const combatOf = (owner: 'A' | 'B' | 'C' | 'D'): number =>
      unitsOf(state, owner).filter((u) => state.unitTypes[u.type]?.category === 'combat').length;
    const worksOf = (owner: 'A' | 'B' | 'C' | 'D'): number =>
      unitsOf(state, owner).filter((u) => state.unitTypes[u.type]?.category === 'building').length;
    const mine = combatOf('A');
    const myWorks = worksOf('A');
    // 三席：B 是友军、C 是敌人；两席：B 就是敌人
    const allies = init.allyCity ? combatOf('B') : 0;
    const allyWorks = init.allyCity ? worksOf('B') : 0;
    const foes = combatOf(foeSeat);
    const foeWorks = worksOf(foeSeat);
    const timer =
      init.holdRounds > 0
        ? `<span>守 <b>${Math.min(rounds, init.holdRounds)}</b>/${init.holdRounds} 轮</span>`
        : `<span>回合 <b>${rounds}</b>/${init.roundLimit}</span>`;
    const left = init.waves.filter((w) => w.atRound > rounds).length;
    hudEl!.innerHTML = `
      ${timer}
      <span>我 <b>${mine}</b>${myWorks > 0 ? `（工事 ${myWorks}）` : ''}${
        init.allyCity ? ` · 友 <b>${allies}</b>${allyWorks > 0 ? `（工事 ${allyWorks}）` : ''}` : ''
      } · 敌 <b>${foes}</b>${foeWorks > 0 ? `（工事 ${foeWorks}）` : ''}</span>
      ${init.holdRounds > 0 ? `<span>还有 <b>${left}</b> 波</span>` : ''}
      <span>金 <b>${state.players.A.gold}</b></span>
      <span>${state.current === 'A' ? (busy ? '对方行动中…' : '轮到你') : '对方行动中…'}</span>`;

    armyEl!.innerHTML =
      mine === 0
        ? '<p class="rg-dim">一个兵都没有了。</p>'
        : unitsOf(state, 'A')
            .filter((u) => state.unitTypes[u.type]?.category === 'combat')
            .map((u) => {
              const d = utype(state, u.type);
              const cls = u.id === selectedId ? 'sel' : '';
              const done = u.moved && u.acted ? 'done' : '';
              const where = u.moved && !u.acted ? '已移动' : u.acted ? '已行动' : `${u.x},${u.y}`;
              /*
               * 成长型单位挂一个"成长 n/m"的角标：它是这一局里唯一会**越打越强**
               * 的东西，玩家得知道自己带的是半成品，而不是一个弱的英雄。
               */
              const grow = growthOf(baseTypeOf(u.type), init.layer);
              const badge =
                grow && grow.step < grow.fullAt
                  ? `<i class="rg-grow">成长 ${grow.step}/${grow.fullAt}</i>`
                  : '';
              return `<button class="rg-unitrow ${cls} ${done}" data-unit="${u.id}">
                <span class="n">${escapeHtml(d.name)}${badge}</span>
                <span class="s">${u.hp}/${maxHpOf(state, u)} · ${where}</span>
              </button>`;
            })
            .join('');

    // 敌人手里的城：三席守城战里 B 是友军，不能把它的城算成敌人的
    const bCities = state.cities.filter((c) => c.owner === foeSeat && !c.ruined).length;
    foeEl!.innerHTML =
      foes === 0 && foeWorks === 0
        ? '<p class="rg-dim">对面已经没人了。</p>'
        : `<p class="rg-dim">还剩 ${foes} 个敌人${foeWorks > 0 ? `、${foeWorks} 处工事` : ''}${
            bCities > 0 ? `、${bCities} 座城` : ''
          }。</p>`;

    /*
     * 外人：两侧路过的中立单位。
     *
     * 这里做的是"场外交涉"——不占回合、不走棋盘，点一下就行：
     *   · 招募：花钱，它当场变成我方的兵（战后留在队里）；
     *   · 请走：不花钱，把它从场上拿掉（不想为它绕路，或者怕被它挡道）。
     * 都是直接改 state，所以**压一次撤回栈**：Ctrl+Z 能连同钱一起退回来。
     */
    const ns = neutrals();
    if (neutralCardEl && neutralEl) {
      neutralCardEl.hidden = ns.length === 0;
      const idle = state.current !== 'A' || busy || finished;
      neutralEl.innerHTML = ns
        .map((u) => {
          const d = utype(state, u.type);
          const cost = recruitCost(u.type);
          const poor = state.players.A.gold < cost;
          return `<div class="rg-neutral-row">
            <span class="n">${escapeHtml(d.name)}<i>${u.hp}/${maxHpOf(state, u)} · 身价 ${utype(state, u.type).cost ?? 0}</i></span>
            <button class="rg-btn mini" data-parley="${u.id}" ${poor || idle ? 'disabled' : ''}>招募 ${cost}</button>
            <button class="rg-btn ghost mini" data-dismiss="${u.id}" ${idle ? 'disabled' : ''}>请走</button>
          </div>`;
        })
        .join('');
    }

    tipEl!.innerHTML = hintText();
    renderSkills();
    undoBtn!.disabled = busy || state.current !== 'A' || undoStack.length === 0;
    // 强制模式的按钮：扣住时高亮，再点一次退出
    forceMoveBtn?.classList.toggle('armed', forceMode === 'move');
    forceAttackBtn?.classList.toggle('armed', forceMode === 'attack');
    const canAct = !busy && !finished && state.current === 'A';
    if (forceMoveBtn) forceMoveBtn.disabled = !canAct;
    if (forceAttackBtn) forceAttackBtn.disabled = !canAct;
  }

  function hintText(): string {
    if (finished) return '这一战已经结束。';
    if (pendingSkill) return '正在选技能落点：点高亮格施法，点别处取消。';
    if (busy || state.current !== 'A') return '对面在想。';
    if (forceMode === 'move') return '强制移动：点可达格就走上去（压在别人身上也行）· 再点一次按钮退出。';
    if (forceMode === 'attack') return '强制攻击：点目标就开火（含身下那个）· 再点一次按钮退出。';
    const unit = selected();
    if (!unit) {
      const head =
        init.holdRounds > 0
          ? `守住 <b>${init.holdRounds}</b> 轮。城破了就输，人打光了也算输。<br>`
          : '';
      return `${head}点自己的兵 → 点空格移动 / 点敌人（含塔）开火 / 点敌城攻城。<br>走完还能接着打，不用重新选。`;
    }
    const name = escapeHtml(utype(state, unit.type).name);
    if (utype(state, unit.type).category === 'building') {
      return `${name} 是工事：不能移动${targets.length > 0 ? '，但可以开火（红框）' : '，这一回合也打不到人'}。`;
    }
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
    pendingSkill = null;
    skillAim = [];
    render();
  }

  /** 点技能按钮：不需要落点的直接放，需要落点的进"瞄准"状态 */
  function castSkill(skillId: string): void {
    if (busy || finished || state.current !== 'A') return;
    const unit = selected();
    if (!unit) return;
    const info = heroSkillsOf(state, unit).find((k) => k.def.id === skillId);
    if (!info) return;
    if (!info.ready) {
      flashTip(info.notReadyReason ?? '这个技能还不能用');
      return;
    }
    const targeting = info.def.targeting;
    if (targeting === 'point' || targeting === 'direction') {
      pendingSkill = { unitId: unit.id, skillId, targeting };
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
      flashTip(targeting === 'point' ? '点地图上任意一格施法（点自己脚下取消）' : '点四个方向之一施法');
      render();
      return;
    }
    if (info.def.input) {
      const v = window.prompt(info.def.input.label);
      if (v === null) return;
      act({ type: 'HERO_SKILL', unitId: unit.id, skillId, targetX: unit.x, targetY: unit.y, input: v });
      return;
    }
    act({ type: 'HERO_SKILL', unitId: unit.id, skillId, targetX: unit.x, targetY: unit.y });
  }

  function flashTip(msg: string): void {
    tipEl!.textContent = msg;
    window.setTimeout(() => {
      if (!disposed) tipEl!.innerHTML = hintText();
    }, 1800);
  }

  function checkEnd(): void {
    if (finished) return;
    const outcome = outcomeOf(state, init);
    if (!outcome) {
      // 超时：小图打到二十几轮还没结果，就是"两边都不想打"
      if (roundsNow() > init.roundLimit) {
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

  /**
   * 守城战：到点的波次上场。
   *
   * 放在"敌方回合结束、轮到你"这一刻：玩家先看见新来的人站在上沿，
   * 再决定这一轮怎么挡。不在 render 里调，是因为它会改状态。
   */
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
      flashTip(`第 ${waveIdx + 1} 波到了：${units.length} 个兵`);
    }
    if (came) render();
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
    const budget: AiBudget = {
      ...DEFAULT_BUDGET,
      // 整场总量，不是每回合：额度减掉已经补过的，补满就再也不补
      maxRecruit: Math.max(0, init.enemyRecruit - enemyRecruited),
      maxUpgrade: 0,
    };
    /*
     * 三席局里"对面"不止一家：A 交棒之后要依次跑完 B（友军）和 C（攻方），
     * 直到轮回 A 为止。用 `state.current` 当循环条件，席位数由关卡决定，
     * 两席局的行为一个字没变。
     */
    while (!disposed && !finished && state.current !== 'A' && !outcomeOf(state, init)) {
      const seat = state.current;
      const rejected = new Set<string>();
      for (let i = 0; i < AI_MAX_STEPS; i += 1) {
        if (disposed || finished || state.current !== seat || outcomeOf(state, init)) break;
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

  boardEl.addEventListener('click', (e) => {
    if (busy || finished || state.current !== 'A') return;
    const coords = cellAtPoint(boardEl as HTMLElement, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    if (!coords) return;
    const { x, y } = coords;
    /*
     * 技能落点优先于一切：正在选点时，这一下点击只有一个含义。
     */
    if (pendingSkill) {
      const { unitId, skillId, targeting } = pendingSkill;
      const caster = state.units.find((u) => u.id === unitId);
      const onSelf = !!caster && caster.x === x && caster.y === y;
      const cell = y * state.w + x;
      const picked = targeting === 'point' ? !onSelf : skillAim.includes(cell);
      pendingSkill = null;
      skillAim = [];
      if (!picked) {
        flashTip('已取消施法');
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

    /*
     * 强制移动 / 强制攻击：这一下只按那一个动词解释，绝不落到"选中"上去。
     * 这是"空地叠在一格就动不了"的正解——不然压在格子上那枚棋子总把话抢走。
     */
    if (wantMove) {
      if (!unit) {
        flashTip('先选中一个兵，再点强制移动');
        return;
      }
      if (reach.includes(cell)) {
        act({ type: 'MOVE', unitId: unit.id, x, y });
        return;
      }
      flashTip(moveRefusal(x, y, unit));
      return;
    }
    if (wantAttack) {
      if (!unit) {
        flashTip('先选中一个兵，再点强制攻击');
        return;
      }
      const hit = stackAt(x, y).find((u) => targets.includes(u.id));
      if (hit) {
        act({ type: 'ATTACK', unitId: unit.id, targetId: hit.id, x, y });
        return;
      }
      flashTip(unit.acted ? '它这一回合已经打过了' : '这一格没有能打的目标');
      return;
    }

    const clicked = pickUnitAt(x, y, false);
    if (clicked && clicked.owner === 'A') {
      selectedId = clicked.id;
      render();
      return;
    }
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
      if (reach.includes(cell)) {
        act({ type: 'MOVE', unitId: unit.id, x, y });
        return;
      }
      if (clicked && clicked.owner !== 'A') {
        flashTip(moveRefusal(x, y, unit));
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
        pendingSkill = null;
        skillAim = [];
        undoStack.length = 0;
        render();
        void runAi();
      }
      return;
    }
    if (act0 === 'force-move') {
      forceMode = forceMode === 'move' ? null : 'move';
      pick = null;
      render();
      return;
    }
    if (act0 === 'force-attack') {
      forceMode = forceMode === 'attack' ? null : 'attack';
      pick = null;
      render();
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
    const skillId = target?.closest<HTMLElement>('[data-skill]')?.dataset.skill;
    if (skillId) {
      castSkill(skillId);
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
    const unitId = target?.closest<HTMLElement>('[data-unit]')?.dataset.unit;
    if (unitId) {
      selectedId = unitId;
      render();
    }
  });

  arrivalWaves();
  render();
  if (state.current !== 'A') void runAi();

  return () => {
    disposed = true;
    host.innerHTML = '';
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

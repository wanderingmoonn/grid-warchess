/**
 * 新手教程的"教练层"。
 *
 * 它不接管棋盘，也不改规则——只在旁边看着：**你说的话、你点的地方、你做到了没有**。
 * 所有动作仍然走 main.ts 平常那条路（选中、移动、攻击、结束回合），教程只做三件事：
 *
 *   1. 写一张卡片告诉他现在该干什么（以及为什么）；
 *   2. 把该看的地方圈出来（棋盘格子 / 面板按钮）；
 *   3. 判定"这一步做到了"，然后换下一步。
 *
 * 为什么判定用**状态谓词**而不是"他点了某个按钮"：
 *   同一个目标玩家可能用不同方式完成（先移动再三步走、或者原地攻击）。绑按钮的话，
 *   只要他换个顺序，教程就会卡住并显示"请点结束回合"，而他其实早就做完了。
 *   绑状态就不会——我们只关心"那个农民掉血了没有""城破了没有"。
 *
 * 为什么 B 席由教程代按结束回合：
 *   教程局里 B 不接 AI（见 core/tutorial.ts 文件头）。不代按的话，玩家结束回合后
 *   界面会停在"对方回合"，而对面永远不会动——新手会以为游戏卡了。所以只要看到
 *   `current === 'B'`，就延迟一帧替他按下结束回合，并配一句话解释"对面也在动"。
 *
 * 卡片挂在 body 上，不挂 #app：`render()` 每帧会整块重写 #app 里的东西，
 * 挂进去等于每帧重建一次卡片（动画会闪、按钮会丢焦点）。
 */
import { reachableTiles } from '../core/rules.ts';
import type { Action, GameState } from '../core/types.ts';

export interface TutorialHooks {
  /** 走 main 自己的应用路径（存档、渲染、联机同步都由它管） */
  apply: (a: Action) => void;
  /** 退出教程：main 负责把玩家原来那局还回去 */
  exit: () => void;
}

interface Ctx {
  state: GameState;
  selectedId: string | null;
}

/** 每一步开始时记下的局面读数，`done` 靠"和它比"判断有没有变化 */
interface Snap {
  baitHp: number;
  cityHp: number;
  cityRuined: boolean;
  myX: number;
  myY: number;
  turn: number;
}

interface Step {
  key: string;
  title: string;
  body: (c: Ctx) => string;
  /** 返回 true = 这一步做到了。没有 done 的是纯讲解，等玩家点「继续」 */
  done?: (c: Ctx, s: Snap) => boolean;
  /** 要高亮的格子 */
  mark?: (c: Ctx) => Array<{ x: number; y: number }>;
  /** 要高亮的面板元素（CSS 选择器） */
  markSel?: string;
  /**
   * 把**整座敌城**框起来（画在城市自己那个 `.city-block` 上）。
   *
   * 不能用逐格 outline：四个格子各画一圈，边框会落在格子交界处、中央还会拉出
   * 一个十字，看起来像把城切成了四块。城市本来就有一个整块的 `.city-block`，
   * 直接给它换颜色就行。
   */
  markCity?: boolean;
}

const ME = 'A';
const MY_ID = 'tut-mine';

const myUnit = (s: GameState) => s.units.find((u) => u.id === MY_ID) ?? null;
const bait = (s: GameState) => s.units.find((u) => u.owner === 'B') ?? null;
const foeCity = (s: GameState) => s.cities.find((c) => c.owner === 'B') ?? null;

/** 敌城四邻：走到这些格子上才能攻城 */
function cityRing(s: GameState): Array<{ x: number; y: number }> {
  const c = foeCity(s);
  if (!c) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (let y = c.y - 1; y <= c.y + c.size; y++) {
    for (let x = c.x - 1; x <= c.x + c.size; x++) {
      const inside = x >= c.x && x < c.x + c.size && y >= c.y && y < c.y + c.size;
      if (inside) continue;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/**
 * 这一步允许走的落点：**走完之后能贴着那个农民**的格子。
 *
 * 为什么只放这些：教程的第三步是"走过去"，第四步是"打他"。如果允许朝任意方向走，
 * 玩家很可能走反，然后第四步永远够不着——而教程又不会倒退，只能卡在那里。
 * 与其在文案里写"请往右上走"，不如直接不给别的格子点。
 */
function allowedDestinations(s: GameState): Array<{ x: number; y: number }> {
  const u = myUnit(s);
  const b = bait(s);
  if (!u || !b) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (const i of reachableTiles(s, u).keys()) {
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    // 八向相邻（本游戏斜着也走一步，所以用切比雪夫距离）
    if (Math.max(Math.abs(x - b.x), Math.abs(y - b.y)) === 1) out.push({ x, y });
  }
  return out;
}

/** 这一步允不允许落在这个格子上（只在「走过去」那一步设限） */
export function tutorialAllowsMove(state: GameState, x: number, y: number): boolean {
  if (!active) return true;
  const step = STEPS[stepIndex];
  if (!step || step.key !== 'move') return true;
  return allowedDestinations(state).some((p) => p.x === x && p.y === y);
}

function snapOf(s: GameState): Snap {
  const c = foeCity(s);
  const u = myUnit(s);
  return {
    baitHp: bait(s)?.hp ?? 0,
    cityHp: c?.hp ?? 0,
    cityRuined: Boolean(c?.ruined),
    myX: u?.x ?? -1,
    myY: u?.y ?? -1,
    turn: s.turn,
  };
}

const STEPS: Step[] = [
  {
    key: 'goal',
    title: '赢的条件只有一个',
    body: () => '这盘棋的胜利条件是把对面的城打下来。\n红框圈住的那座城就是目标。',
    markCity: true,
  },
  {
    key: 'select',
    title: '第一步：选中你的兵',
    body: () => '点亮着的那一格——那是你唯一的兵。\n选中之后，它能走到的格子会亮起来。',
    mark: (c) => {
      const u = myUnit(c.state);
      return u ? [{ x: u.x, y: u.y }] : [];
    },
    done: (c) => c.selectedId === MY_ID,
  },
  {
    key: 'move',
    title: '第二步：走过去',
    body: () => '点亮起来的格子，兵就走过去了。（这一课只让它走到那个农民旁边，别的格子先不给点）\n每个兵每回合只能走一次、打一次；走完它会自动取消选中，想做下一件事要重新点它。',
    mark: (c) => allowedDestinations(c.state),
    done: (c) => {
      const u = myUnit(c.state);
      const b = bait(c.state);
      if (!u || !b) return false;
      return Math.max(Math.abs(u.x - b.x), Math.abs(u.y - b.y)) === 1;
    },
  },
  {
    key: 'attack',
    title: '第三步：攻击',
    body: () => '旁边那个农民不会还手，拿它练手。\n选中兵之后点它，就是攻击——注意看它的血条掉了多少。',
    mark: (c) => {
      const b = bait(c.state);
      return b ? [{ x: b.x, y: b.y }] : [];
    },
    done: (c, s) => (bait(c.state)?.hp ?? 0) < s.baitHp,
  },
  {
    key: 'endturn',
    title: '第四步：结束回合',
    body: () => '兵打完了，这一回合就没什么可做的了——按「结束回合」。\n对面也会走一回合，所以每做一个动作都要想想：他下一步会不会打过来。',
    markSel: '[data-act="end-turn"]',
    done: (c) => c.state.current !== ME || c.state.turn > 1,
  },
  {
    key: 'siege',
    title: '最后一步：把城打下来',
    body: (c) => {
      const f = foeCity(c.state);
      if (f?.ruined) return '城已经塌了，但它还不归你——把兵走进废墟，才算接管。\n（走之前先点一下你的兵）';
      return '走到城墙边上（亮起来的格子），再点一下你的兵，然后点那座城——这叫攻城。\n城血打完会变成废墟，再派兵走进去接管，这局就赢了。';
    },
    markCity: true,
    mark: (c) => {
      const f = foeCity(c.state);
      const u = myUnit(c.state);
      if (!f || !u) return [];
      // 已经贴着城了：只要那个红框（点城就是攻城）；没贴到才给"该往哪站"
      const near = Math.abs(u.x - f.x) <= f.size && Math.abs(u.y - f.y) <= f.size;
      return near ? [] : cityRing(c.state);
    },
    done: (c) => c.state.winner === ME,
  },
  {
    key: 'done',
    title: '赢了',
    body: () => '这就是一局棋的骨架：选兵 → 移动 → 攻击 → 结束回合 → 攻城接管。\n\n这一局故意没教造兵、升级城、地形和扩展包——那些等你打赢一局标准的再来。\n下面点「回到首页」，去开一局真的。',
  },
];

let active = false;
let stepIndex = 0;
let snap: Snap = { baitHp: 0, cityHp: 0, cityRuined: false, myX: -1, myY: -1, turn: 1 };
let hooks: TutorialHooks | null = null;
let card: HTMLElement | null = null;
/**
 * 用宿主自己的 document，而不是全局那个。
 *
 * 界面用例跑在 jsdom 里，那边只把 `window.document` 挂在一个局部变量上，
 * 全局 `document` 根本不存在——第一版就是这么炸的（`document is not defined`）。
 * title-screen.ts 的注释里也记着同一个坑。
 */
let hostDoc: Document | null = null;
let marked: HTMLElement[] = [];
let endingTurn = false;

export function tutorialOn(): boolean {
  return active;
}

export function tutorialStart(h: TutorialHooks, host?: HTMLElement): void {
  hostDoc = host?.ownerDocument ?? (typeof document === 'undefined' ? null : document);
  hooks = h;
  active = true;
  stepIndex = 0;
  endingTurn = false;
}

export function tutorialSnapshot(state: GameState): void {
  snap = snapOf(state);
}

/** 这一步要圈的格子 / 要框的城，直接交给棋盘渲染（见 BoardUi.tutorialTiles） */
export function tutorialMarks(state: GameState): { tiles: number[]; cityId: string | null } {
  const step = STEPS[stepIndex];
  if (!active || !step) return { tiles: [], cityId: null };
  const tiles = (step.mark?.({ state, selectedId: null }) ?? []).map((p) => p.y * state.w + p.x);
  const cityId = step.markCity ? (foeCity(state)?.id ?? null) : null;
  return { tiles, cityId };
}

/** 当前步骤（给用例断言用） */
export function tutorialStep(): string {
  return STEPS[stepIndex]?.key ?? 'off';
}

export function tutorialExit(): void {
  active = false;
  hooks = null;
  for (const el of marked) el.classList.remove('tut-ring');
  marked = [];
  card?.remove();
  card = null;
}

/**
 * 每次渲染后调一次。返回 true 表示"教程替玩家做了一个动作"，
 * 调用方（main）据此决定要不要再排一次渲染。
 */
export function tutorialTick(state: GameState, selectedId: string | null): boolean {
  if (!active || !hooks || !hostDoc) return false;

  // B 席：教程代按结束回合。延迟一帧，避免在 render 里再触发一次 render 的递归。
  if (state.current !== ME && !state.winner) {
    if (!endingTurn) {
      endingTurn = true;
      setTimeout(() => {
        endingTurn = false;
        if (active && hooks) hooks.apply({ type: 'END_TURN' } as Action);
      }, 300);
    }
    paint(state, selectedId, '对面在走它的回合……（这一局它不会打你）');
    return false;
  }

  const step = STEPS[stepIndex];
  if (!step) return false;
  if (step.done && step.done({ state, selectedId }, snap)) {
    stepIndex += 1;
    snap = snapOf(state);
    if (stepIndex >= STEPS.length) {
      tutorialExit();
      return false;
    }
    paint(state, selectedId);
    return false;
  }
  paint(state, selectedId);
  return false;
}

/** 把卡片和圈画出来（每帧重画；棋盘每帧重建，圈也得跟着重挂） */
function paint(state: GameState, selectedId: string | null, override?: string): void {
  const doc = hostDoc;
  const step = STEPS[stepIndex];
  if (!doc || !step) return;

  if (!card) {
    card = doc.createElement('div');
    card.className = 'tut-card';
    card.innerHTML = `
      <div class="tut-head">
        <span class="tut-step"></span>
        <button class="tut-skip" data-tut="skip" type="button">跳过教程</button>
      </div>
      <h3 class="tut-title"></h3>
      <p class="tut-body"></p>
      <div class="tut-foot">
        <button class="btn btn-primary" data-tut="next" type="button">继续</button>
        <button class="btn" data-tut="done" type="button" hidden>回到首页</button>
      </div>
    `;
    card.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tut]');
      if (!btn) return;
      const act = btn.dataset.tut;
      if (act === 'skip') {
        hooks?.exit();
        return;
      }
      if (act === 'next') {
        // 只有讲解步（没有 done）才允许手动继续；有 done 的步必须真做到
        stepIndex += 1;
        snap = snapOf(state);
        if (stepIndex >= STEPS.length) hooks?.exit();
        else paint(state, selectedId);
        return;
      }
      if (act === 'done') hooks?.exit();
    });
    doc.body.appendChild(card);
  }

  /*
   * 棋盘上的圈**不在这里画**。
   *
   * 棋盘是每帧重建的、首帧还在 rAF 里，往 DOM 上贴的 class 随时会被冲掉或贴到
   * 还没建出来的节点上——第一版就是这样：城市红框一直不出现。现在圈和红框都走
   * `renderBoard` 的渲染参数（`tutorialTiles` / `tutorialCityId`），见 main.ts。
   * 这里只留"面板按钮"的高亮，它不在棋盘里，重建节奏不一样。
   */
  for (const el of marked) el.classList.remove('tut-ring');
  marked = [];
  const selEl = step.markSel ? doc.querySelector<HTMLElement>(step.markSel) : null;
  if (selEl) { selEl.classList.add('tut-ring'); marked.push(selEl); }

  card.querySelector('.tut-step')!.textContent = `第 ${stepIndex + 1} / ${STEPS.length} 步`;
  card.querySelector('.tut-title')!.textContent = step.title;
  card.querySelector('.tut-body')!.textContent = override ?? step.body({ state, selectedId });
  const next = card.querySelector<HTMLButtonElement>('[data-tut="next"]')!;
  const done = card.querySelector<HTMLButtonElement>('[data-tut="done"]')!;
  const isLast = step.key === 'done';
  next.hidden = Boolean(step.done) || isLast;
  done.hidden = !isLast;
}

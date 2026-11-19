/**
 * 肉鸽的两个面板：**回合间**（开始下一关）与**战后结算**（2026-11-19）。
 *
 * 只做展示与回调，不碰运行状态——状态机在 `core/roguelike/runner.ts`，
 * 这样面板可以随时被替换（比如以后换成带地图的路线图）而不动逻辑。
 */

import type { RosterUnit, RunState } from '../../core/roguelike/run-state.ts';
import { cityCapacity, citySizeFor } from '../../core/roguelike/roster.ts';
import { RELICS, relicNames } from '../../core/roguelike/relics.ts';
/** 各面板各写一份，和别的 UI 文件保持一致（没有共享的 util） */
const esc = (t: string): string =>
  String(t).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

export interface RunPanelOptions {
  run: RunState;
  /** 第几关（1 起） */
  stageNo: number;
  total: number;
  stageTitle: string;
  /** 没有存档时：给两个"新开"入口 */
  fresh?: boolean;
  onStart: () => void;
  onNewRun: (allowRestart: boolean) => void;
  onClose: () => void;
  /** 有存档时才有 */
  onAbandon?: () => void;
}

export function openRunPanel(opts: RunPanelOptions): void {
  const { run } = opts;
  const cap = cityCapacity(citySizeFor(run.wallProgress));
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal rogue-panel">
      <div class="modal-head">
        <h2>肉鸽 · 第 ${opts.stageNo} / ${opts.total} 关</h2>
        <p>${esc(opts.stageTitle)}</p>
      </div>
      <div class="modal-body">
        <div class="rogue-stats">
          <span class="rogue-chip">金币 <b>${run.gold}</b></span>
          <span class="rogue-chip">兵额 <b>${run.roster.length} / ${cap}</b></span>
          <span class="rogue-chip">城市时代 <b>${run.cityEra}</b></span>
          <span class="rogue-chip">免费建造 <b>${run.freeBuilds}</b></span>
          <span class="rogue-chip">遗物 <b>${
            run.relics.length === 0 ? '无' : relicNames(run).join('、')
          }</b></span>
          <span class="rogue-chip">重开 <b>${run.allowRestart ? '允许' : '不允许'}</b></span>
        </div>
        ${
          run.roster.length > 0
            ? `<div class="field-hint">带进这一关的兵：${run.roster
                .map((u) => `${esc(u.type)}(${u.hp})`)
                .join('、')}</div>`
            : '<div class="field-hint">还没有兵——第一关的兵要在战前征募（切片阶段由关卡自带开局兵）。</div>'
        }
        <div class="field-hint">敌人清空后还有 <b>2 手</b>把兵带进城：只有城内的单位能进下一关。</div>
      </div>
      <div class="modal-foot">
        ${
          opts.fresh
            ? `<button class="btn btn-primary" data-act="new-hard">新开一局（不允许重开）</button>
               <button class="btn btn-primary" data-act="new">新开一局</button>`
            : `<button class="btn btn-primary" data-act="start">开始第 ${opts.stageNo} 关</button>
               ${opts.onAbandon ? '<button class="btn" data-act="abandon">放弃这局</button>' : ''}`
        }
        ${
          run.relics.length > 0
            ? `<button class="btn" data-act="relics">遗物 ${run.relics.length}（看效果）</button>`
            : ''
        }
        <button class="btn" data-act="close">关掉</button>
      </div>
    </div>`;
  mask.addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (ev.target === mask || act === 'close') {
      mask.remove();
      opts.onClose();
      return;
    }
    if (act === 'relics') {
      openRelicPanel(opts.run);
      return;
    }
    if (act === 'start') {
      mask.remove();
      opts.onStart();
    } else if (act === 'new') {
      mask.remove();
      opts.onNewRun(true);
    } else if (act === 'new-hard') {
      mask.remove();
      opts.onNewRun(false);
    } else if (act === 'abandon') {
      mask.remove();
      opts.onAbandon?.();
    }
  });
  document.body.appendChild(mask);
}

export interface SettlePanelOptions {
  gold: number;
  taken: RosterUnit[];
  left: RosterUnit[];
  refund: number;
  halfDone: boolean;
  onNext: () => void;
}

export function openSettlePanel(opts: SettlePanelOptions): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal rogue-panel">
      <div class="modal-head">
        <h2>${opts.halfDone ? '败退' : '撤离完成'}</h2>
        <p>${opts.halfDone ? '没清完敌人就撤了，结算只给三成。' : '清完场了，看看带回来什么。'}</p>
      </div>
      <div class="modal-body">
        <div class="rogue-stats">
          <span class="rogue-chip">金币 <b>+${opts.gold}</b></span>
          <span class="rogue-chip">带回 <b>${opts.taken.length}</b> 个</span>
          <span class="rogue-chip">损失 <b>${opts.left.length}</b> 个</span>
          <span class="rogue-chip">抚恤 <b>+${opts.refund}</b></span>
        </div>
        ${
          opts.taken.length > 0
            ? `<div class="field-hint">带走：${opts.taken.map((u) => `${esc(u.type)}(${u.hp})`).join('、')}</div>`
            : '<div class="field-hint">一个都没带回来——下一关只能靠新征的兵。</div>'
        }
        ${
          opts.left.length > 0
            ? `<div class="field-hint">没进城的：${opts.left.map((u) => esc(u.type)).join('、')}</div>`
            : ''
        }
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" data-act="next">继续</button>
      </div>
    </div>`;
  mask.addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'next') {
      mask.remove();
      opts.onNext();
    }
  });
  document.body.appendChild(mask);
}


export interface CardChoiceOptions {
  /** 三个候选：兵种 id + 显示名 + 已有张数（用来提示"再来一张就升级"） */
  cards: Array<{ id: string; name: string; owned: number; note: string }>;
  /** 「不选，拿钱」给多少 */
  money: number;
  onPick: (id: string) => void;
  onSkip: () => void;
}

/**
 * 战后三选一（2026-11-19）。
 *
 * 设计稿里定的是"兵种卡 70% / 战术卡 30% / 永远并列一个不选拿钱"。
 * 切片先只做**兵种卡 + 不选拿钱**——战术卡要一套一次性效果的落点，
 * 那是下一步的事，先别把两种东西混在一个面板里。
 */
export function openCardChoice(opts: CardChoiceOptions): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal rogue-panel">
      <div class="modal-head">
        <h2>三选一</h2>
        <p>三张同名合成一级（每级 +12% 攻血）。</p>
      </div>
      <div class="modal-body">
        <div class="rogue-cards">
          ${opts.cards
            .map(
              (c) => `<button class="rogue-card" data-pick="${esc(c.id)}">
                <span class="rogue-card-name">${esc(c.name)}</span>
                <span class="rogue-card-note">${esc(c.note)}</span>
                <span class="rogue-card-owned">已有 ${c.owned} 张</span>
              </button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="skip">不选，拿 ${opts.money} 金</button>
      </div>
    </div>`;
  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const pick = t.closest<HTMLElement>('[data-pick]')?.dataset.pick;
    if (pick) {
      mask.remove();
      opts.onPick(pick);
      return;
    }
    if (t.closest<HTMLElement>('[data-act="skip"]')) {
      mask.remove();
      opts.onSkip();
    }
  });
  document.body.appendChild(mask);
}


export interface RestPanelOptions {
  /** 城墙加固进度（几次能升一级由 roster.WALL_STEPS 决定） */
  wallProgress: number;
  /** 城墙要到第几次才升一级 */
  wallSteps: number;
  /** 当前城市边长与兵额 */
  citySize: number;
  capacity: number;
  /** 花名册（用来显示"修整"会回多少血） */
  roster: Array<{ type: string; hp: number }>;
  /** 已经抽过几种卡（面板上显示一下） */
  cardKinds: number;
  /** 上一关结束时的城血（0 = 第一关，按满血算） */
  cityHp: number;
  /** 城市时代与升下一代的价钱（升城**不占整备次数**） */
  cityEra: number;
  upgradeCost: number | null;
  gold: number;
  onUpgradeCity: () => void;
  onPick: (kind: 'wall' | 'repairCity' | 'card') => void;
}

/**
 * 整备关（2026-11-19）。
 *
 * 三选一，**每项都只有一个方向**：加固城墙（累计两次升一级）/ 修整部队（回满血）/
 * 升一级兵种卡。为什么是"三选一"而不是全给：整备关是这一 run 里少数几个
 * "必须放弃点什么"的地方，全给就变成了纯奖励，节奏会塌。
 */
export function openRestPanel(opts: RestPanelOptions): void {
  const wallLeft = opts.wallSteps - (opts.wallProgress % opts.wallSteps);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal rogue-panel">
      <div class="modal-head">
        <h2>整备</h2>
        <p>停下来喘口气，只能选一件。</p>
      </div>
      <div class="modal-body">
        <div class="field-hint">
          城市是 ${opts.cityEra} 代 · 金币 ${opts.gold}
          ${
            opts.upgradeCost === null
              ? '　（已经到顶）'
              : `　升到 ${opts.cityEra + 1} 代要 ${opts.upgradeCost} 金——**不占这次整备**`
          }
        </div>
        <div class="rogue-cards">
          <button class="rogue-card" data-rest="wall">
            <span class="rogue-card-name">加固城墙</span>
            <span class="rogue-card-note">再加固 ${wallLeft} 次升一级（兵额 ${opts.capacity} → ${
              opts.capacity + (opts.citySize * 2 + 1)
            }）</span>
            <span class="rogue-card-owned">当前：${opts.citySize}×${opts.citySize} · 已加固 ${opts.wallProgress} 次</span>
          </button>
          <button class="rogue-card" data-rest="repairCity">
            <span class="rogue-card-name">修城</span>
            <span class="rogue-card-note">下一关开局城市回满血（城血跨关保留，打完仗是带着伤进下一关的）</span>
            <span class="rogue-card-owned">当前城血：${opts.cityHp > 0 ? opts.cityHp : '满'}</span>
          </button>
          <button class="rogue-card" data-rest="card">
            <span class="rogue-card-name">升一级兵种卡</span>
            <span class="rogue-card-note">直接给一张已有的卡 +1 级（等于一次补满三张）</span>
            <span class="rogue-card-owned">已抽 ${opts.cardKinds} 种</span>
          </button>
        </div>
      </div>
      <div class="modal-foot">
        ${
          opts.upgradeCost !== null
            ? `<button class="btn ${opts.gold >= opts.upgradeCost ? 'btn-primary' : ''}" data-upgrade-city ${
                opts.gold >= opts.upgradeCost ? '' : 'disabled'
              }>升城市：${opts.cityEra} → ${opts.cityEra + 1} 代（${opts.upgradeCost} 金）</button>`
            : '<span class="field-hint">城市已到顶代</span>'
        }
      </div>
    </div>`;
  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    /*
     * 升城**不关面板、不占三选一**（2026-11-19 用户定）：
     * 它是花钱买成长，和"停下来整备一次"是两件事。
     */
    if (t.closest('[data-upgrade-city]')) {
      const btn = t.closest<HTMLButtonElement>('[data-upgrade-city]')!;
      if (!btn.disabled) opts.onUpgradeCity();
      return;
    }
    const kind = t.closest<HTMLElement>('[data-rest]')?.dataset.rest;
    if (!kind) return;
    mask.remove();
    opts.onPick(kind as 'wall' | 'repairCity' | 'card');
  });
  document.body.appendChild(mask);
}


/**
 * 遗物一览（2026-11-19）。
 *
 * 之前只有关卡面板上一句"遗物：铁壁"，效果只写在代码注释里——
 * 玩家拿了什么、有什么用，界面上一概看不到。这一页把**每一件遗物**
 * 连同效果一起列出来：已获得的实心显示，没获得的灰掉（名字也藏着，
 * 免得剧透还没打到的东西）。
 */
export function openRelicPanel(run: RunState): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const owned = new Set(run.relics);
  mask.innerHTML = `
    <div class="modal rogue-panel">
      <div class="modal-head">
        <h2>遗物 ${owned.size} / ${RELICS.length}</h2>
        <p>遗物靠"打谁"获得：精英与 Boss 关固定掉落，拿到就永久生效。</p>
      </div>
      <div class="modal-body">
        <div class="rogue-cards">
          ${RELICS.map((r) => {
            const has = owned.has(r.id);
            return `<div class="rogue-card${has ? '' : ' is-locked'}">
              <span class="rogue-card-name">${has ? esc(r.name) : '？？？'}</span>
              <span class="rogue-card-note">${has ? esc(r.blurb) : '还没拿到'}</span>
              <span class="rogue-card-owned">${has ? '已获得' : '未获得'}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close">关掉</button>
      </div>
    </div>`;
  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t === mask || t.closest('[data-act="close"]')) mask.remove();
  });
  document.body.appendChild(mask);
}

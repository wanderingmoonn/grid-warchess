/**
 * 试玩版的界面层：开局面板 → 层地图 → 房间（事件/商店/休整）→ 战斗 → 结算。
 *
 * 全部是一块 DOM 反复重写，不引框架。房间图、金币、军队这些状态都活在
 * `RunState` 里，这里只负责"显示它、把点击变成对它的修改"。
 */
import { STRATEGIES, armyText, eventById, relicById, themeOf } from './run.ts';
import {
  applyDecision,
  decisionOptions,
  refreshCost,
  afterRoom,
  applyEffect,
  armyCount,
  battleFor,
  bossFor,
  finishBattle,
  loseRun,
  nextLayer,
  restOptions,
  rewardOptions,
  shopStock,
  startRun,
  STEPS_PER_LAYER,
} from './run.ts';
import { makeRng, randomSeed } from './rng.ts';
import type { Rng } from './rng.ts';
import type { BattleResult, RewardOption, RoomNode, RunState } from './types.ts';

let run: RunState | null = null;
/** 退出回标题（由 mount.ts 传进来；地址直开时也有） */
let exitToTitle: (() => void) | null = null;

/**
 * 内容预览：`?rogueAuto=win` 时所有战斗直接判胜。
 *
 * 不是作弊开关，是给"看内容 / 走流程"用的——想确认三层的事件、商店、结算都对，
 * 不必一场一场打过去。默认路径不受影响。
 */
function autoWin(): boolean {
  return new URLSearchParams(window.location.search).get('rogueAuto') === 'win';
}
let rng: Rng = makeRng(1);
let cleanupBattle: (() => void) | null = null;

export function bootRogue(root: HTMLElement, opts: { onExit?: () => void } = {}): void {
  exitToTitle = opts.onExit ?? null;
  root.innerHTML = '';
  showStart(root);
}

/** 「返回标题」按钮：只在有人接这个动作时才画 */
function exitBtn(cls = 'rg-exit'): string {
  return exitToTitle ? `<button class="${cls}" data-act="exit">← 返回标题</button>` : '';
}

// ------------------------------------------------------------------ 开局

function showStart(root: HTMLElement): void {
  root.innerHTML = `
    <div class="rg-start">
      ${exitBtn()}
      <header class="rg-hero">
        <h1>肉鸽 2.0 <span class="rg-tag">if 线</span></h1>
        <p>三层、每层十步，走房间图。赢了往下一层走，输了这一局就没了。</p>
        <p class="rg-sub">和标题页那个「肉鸽」不是同一套：那套是原版规则的线性切片；这一套把所有东西都揉进来了——房间图、事件、商店、营地、藏品。第四层不在本次范围内。</p>
      </header>
      <section class="rg-strategies">
        ${STRATEGIES.map(
          (s) => `<button class="rg-strategy" data-strategy="${s.id}">
            <b>${s.name}</b>
            <i>${s.sub}</i>
            <span>${armyText(s.army)}</span>
            <em>${s.passive}</em>
          </button>`,
        ).join('')}
      </section>
      <p class="rg-note">选一个方略出发。开局 180 金、三层房图随机、敌人编成随时代钟变硬。</p>
    </div>`;

  // 用 onclick 而不是 addEventListener：回到开局页会重跑这一段，
  // 用 addEventListener 的话每回来一次就多挂一个监听，点一下会开两局。
  root.onclick = (e) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('[data-act="exit"]')) {
      exitToTitle?.();
      return;
    }
    const id = el?.closest<HTMLElement>('[data-strategy]')?.dataset.strategy;
    if (!id) return;
    beginRun(root, id);
  };
}

function beginRun(root: HTMLElement, strategyId: string): void {
  const seed = randomSeed();
  run = startRun(seed, strategyId);
  rng = makeRng((seed ^ 0x85ebca6b) >>> 0);
  showMap(root);
}

// ------------------------------------------------------------------ 层地图

function showMap(root: HTMLElement): void {
  if (!run) return;
  cleanup();
  const r = run;
  const theme = themeOf(r.layer);
  const rows = r.plan.steps
    .map((doors, i) => {
      const state = i < r.step ? 'done' : i === r.step ? 'now' : 'next';
      return `<div class="rg-step ${state}">
        <div class="rg-stepno">${i + 1}</div>
        <div class="rg-doors">
          ${doors
            .map(
              (d, j) => `<button class="rg-door k-${d.kind}" data-step="${i}" data-door="${j}" ${
                state === 'now' ? '' : 'disabled'
              }>
                <b>${doorTitle(d)}</b>
                <span>${escapeHtml(d.sub)}</span>
              </button>`,
            )
            .join('')}
        </div>
      </div>`;
    })
    .join('');

  const bossRow =
    r.step >= STEPS_PER_LAYER
      ? `<div class="rg-bossrow">
           <b>层末会战</b>
           <span>${r.layer === 3 ? '钟楼：三家共守的地方' : '挡在路上的最后一道'}</span>
           <button class="rg-btn" data-act="boss">开战</button>
         </div>`
      : '';

  root.innerHTML = `
    <div class="rg-map">
      <header class="rg-top">
        <div class="rg-top-title">
          <b>${theme.name}</b><span>${theme.subtitle}</span>
        </div>
        <div class="rg-top-stats">
          <span>步 <b>${Math.min(r.step, STEPS_PER_LAYER)}</b>/${STEPS_PER_LAYER}</span>
          <span>钟 <b>${r.clock}</b></span>
          <span>金 <b>${r.gold}</b></span>
          <span>兵 <b>${armyCount(r.army)}</b></span>
          ${exitBtn('rg-btn ghost rg-exit-inline')}
        </div>
      </header>
      <div class="rg-mapbody">
        <div class="rg-steps">${rows}${bossRow}</div>
        <aside class="rg-inspect">
          <div class="rg-side-card">
            <h4>军队</h4>
            <p class="rg-armytext">${armyText(r.army)}</p>
          </div>
          <div class="rg-side-card">
            <h4>藏品（${r.relics.length}）</h4>
            <p class="rg-dim">${
              r.relics.length === 0
                ? '还没有。'
                : r.relics.map((id) => `${relicById(id)?.name ?? id}`).join('、')
            }</p>
          </div>
          <div class="rg-side-card grow">
            <h4>行记</h4>
            <ul class="rg-log">${r.log
              .slice(-12)
              .map((l) => `<li>${escapeHtml(l)}</li>`)
              .join('')}</ul>
          </div>
        </aside>
      </div>
    </div>`;

  root.onclick = (e) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('[data-act="exit"]')) {
      exitToTitle?.();
      return;
    }
    const boss = el?.closest<HTMLElement>('[data-act="boss"]');
    if (boss) {
      enterBoss(root);
      return;
    }
    const door = el?.closest<HTMLElement>('[data-door]');
    if (!door) return;
    const step = Number(door.dataset.step);
    const idx = Number(door.dataset.door);
    if (!run || step !== run.step) return;
    const node = run.plan.steps[step]?.[idx];
    if (node) enterRoom(root, node);
  };
}

function doorTitle(d: RoomNode): string {
  if (d.kind === 'event') return `事件 · ${eventById(d.eventId ?? '').title}`;
  if (d.kind === 'boss') return '层末会战';
  return d.title;
}

// ------------------------------------------------------------------ 房间

function enterRoom(root: HTMLElement, node: RoomNode): void {
  if (!run) return;
  if (node.kind === 'battle' || node.kind === 'elite' || node.kind === 'siege') {
    startBattle(root, node);
    return;
  }
  if (node.kind === 'event') {
    const def = eventById(node.eventId ?? '');
    openModal(
      root,
      `<h3>${def.title}</h3><p class="rg-body">${def.body}</p>`,
      def.choices.map((c, i) => ({ id: String(i), title: c.label, sub: c.hint ?? '' })),
      (pick) => {
        const choice = def.choices[Number(pick)];
        if (!choice) return;
        const notes = applyEffect(run!, choice.effect, rng);
        run!.log.push(`事件「${def.title}」：${choice.label}`);
        afterRoom(run!);
        showResultThen(root, `事件 · ${def.title}`, notes.length ? notes.join('，') : '什么都没发生');
      },
    );
    return;
  }
  if (node.kind === 'shop') {
    openShop(root);
    return;
  }
  // rest
  const opts = restOptions(run, rng);
  openModal(
    root,
    `<h3>营地</h3><p class="rg-body">今晚不开战。火堆边能做的事不多，只能挑一件。</p>`,
    opts,
    (pick) => {
      const item = opts.find((o) => o.id === pick);
      if (!item) return;
      const notes = applyEffect(run!, item.effect, rng);
      run!.log.push(`营地：${item.title}`);
      afterRoom(run!);
      showResultThen(root, '营地', notes.join('，'));
    },
  );
}

// ------------------------------------------------------------------ 战斗

function startBattle(root: HTMLElement, node: RoomNode): void {
  if (!run) return;
  if (autoWin()) {
    const r = run;
    if (!r) return;
    onBattleDone(root, node, { win: true, survivors: r.army.map((a) => ({ ...a })), gold: r.gold, turns: 1 });
    return;
  }
  const init = battleFor(run, node, (run.seed ^ (run.layer * 7919 + run.step * 104729)) >>> 0);
  const host = document.createElement('div');
  root.innerHTML = '';
  root.appendChild(host);
  cleanupBattle = mountInto(host, init, (result) => onBattleDone(root, node, result));
}

function enterBoss(root: HTMLElement): void {
  if (!run) return;
  /*
   * 临战决议：打之前先做一次三选一。
   *
   * 这是设计里的固定节点（层末必有），选项只影响这一场：夜袭 / 强攻 / 买通 /
   * 就地征召 / 工兵破墙。钱不够的选项直接不出现，免得点了没反应。
   * 内容预览（`?rogueAuto=win`）也走这一步——预览要能看见全流程，包括决议。
   */
  const affordable = decisionOptions(run, rng).filter((o) => (o.cost ?? 0) <= (run as RunState).gold);
  const opts = affordable.length > 0 ? affordable : decisionOptions(run, rng);
  openModal(
    root,
    `<h3>临战决议</h3><p class="rg-body">${escapeHtml(
      run.layer === 3 ? '钟楼就在前面。' : '再往前就是他们的城了。',
    )}这一仗怎么打，你说了算。</p>`,
    opts.map((o) => ({ id: o.id, title: o.label, sub: o.hint })),
    (pick) => {
      const opt = opts.find((o) => o.id === pick);
      if (opt) applyDecision(run!, opt);
      const r = run;
      if (!r) return;
      if (autoWin()) {
        onBossDone(root, { kind: 'boss', title: '层末会战', sub: '' }, {
          win: true,
          survivors: r.army.map((a) => ({ ...a })),
          gold: r.gold,
          turns: 1,
        });
        return;
      }
      startBossFight(root);
    },
  );
}

function startBossFight(root: HTMLElement): void {
  if (!run) return;
  const { node, init } = bossFor(run, (run.seed ^ (run.layer * 99991)) >>> 0);
  const host = document.createElement('div');
  root.innerHTML = '';
  root.appendChild(host);
  cleanupBattle = mountInto(host, init, (result) => onBossDone(root, node, result));
}

/**
 * 商店：三行（兵种 / 藏品 / 补给），买完不关店，可以接着买，也能花钱刷新。
 *
 * 上一版是"三选一，选完就走"，那不是商店，是奖励房。现在按组分行摆，
 * 每件标价、买过的置灰、刷新换一批。
 */
function openShop(root: HTMLElement): void {
  if (!run) return;
  const r = run;
  let stock = shopStock(r, rng);
  const bought = new Set<string>();

  const host = document.createElement('div');
  host.className = 'rg-mask';
  document.body.appendChild(host);

  const paint = (): void => {
    const row = (group: 'unit' | 'relic' | 'supply', title: string): string => {
      const items = stock.filter((it) => it.group === group);
      if (items.length === 0) return '';
      return `<div class="rg-shop-row"><h5>${title}</h5><div class="rg-shop-items">
        ${items
          .map((it) => {
            const sold = bought.has(it.id);
            const poor = r.gold < it.price;
            return `<button class="rg-shop-item" data-buy="${it.id}" ${sold || poor ? 'disabled' : ''}>
              <b>${escapeHtml(it.title)}</b>
              <span>${escapeHtml(it.sub)}</span>
              <em>${sold ? '已售' : poor ? '钱不够' : `${it.price} 金`}</em>
            </button>`;
          })
          .join('')}
      </div></div>`;
    };
    host.innerHTML = `<div class="rg-modal wide">
      <h3>行商</h3>
      <p class="rg-body">摊子支在路边。<b>身上 ${r.gold} 金</b>，看中哪件点哪件，买完可以接着挑。</p>
      <div class="rg-shop">
        ${row('unit', '兵种')}
        ${row('relic', '藏品')}
        ${row('supply', '补给')}
      </div>
      <div class="rg-shop-foot">
        <button class="rg-btn ghost" data-shop="refresh">刷新（${refreshCost()} 金）</button>
        <button class="rg-btn" data-shop="leave">离开</button>
      </div>
    </div>`;
  };

  host.onclick = (e) => {
    const el = e.target as HTMLElement | null;
    const buyId = el?.closest<HTMLElement>('[data-buy]')?.dataset.buy;
    if (buyId) {
      const item = stock.find((it) => it.id === buyId);
      if (!item || bought.has(item.id) || r.gold < item.price) return;
      r.gold -= item.price;
      applyEffect(r, item.effect, rng);
      r.log.push(`买下 ${item.title}（${item.price} 金）`);
      bought.add(item.id);
      paint();
      return;
    }
    const act = el?.closest<HTMLElement>('[data-shop]')?.dataset.shop;
    if (act === 'refresh') {
      const cost = refreshCost();
      if (r.gold < cost) return;
      r.gold -= cost;
      stock = shopStock(r, rng);
      bought.clear();
      paint();
      return;
    }
    if (act === 'leave') {
      host.remove();
      afterRoom(r);
      showMap(root);
    }
  };
  paint();
}

/** 动态 import 战斗屏：不进战斗就不加载 AI 那三十多 KB */
function mountInto(host: HTMLElement, init: Parameters<typeof import('./battle-screen.ts').mountBattle>[1], onDone: (r: BattleResult) => void): () => void {
  let stop: (() => void) | null = null;
  void import('./battle-screen.ts').then((mod) => {
    stop = mod.mountBattle(host, init, { onDone });
  });
  return () => {
    stop?.();
    host.remove();
  };
}

function onBattleDone(root: HTMLElement, node: RoomNode, result: BattleResult): void {
  if (!run) return;
  const r = run;
  if (!result.win) {
    loseRun(r, `「${node.title}」没打下来`);
    showOver(root);
    return;
  }
  finishBattle(r, result);
  r.log.push(`打赢「${node.title}」，剩 ${armyCount(r.army)} 人`);
  const options = rewardOptions(r, node.kind, rng);
  openModal(
    root,
    `<h3>战利品</h3><p class="rg-body">挑一样带走。</p>`,
    options,
    (pick) => {
      const item = options.find((o) => o.id === pick);
      if (item) applyEffect(run!, item.effect, rng);
      afterRoom(run!);
      showMap(root);
    },
  );
}

function onBossDone(root: HTMLElement, node: RoomNode, result: BattleResult): void {
  if (!run) return;
  const r = run;
  if (!result.win) {
    loseRun(r, `「${node.title}」没打下来`);
    showOver(root);
    return;
  }
  finishBattle(r, result);
  r.bossDone = true;
  r.log.push(`破「${node.title}」`);
  const options = rewardOptions(r, 'boss', rng);
  openModal(
    root,
    `<h3>${node.title} · 已破</h3><p class="rg-body">${node.sub}</p>`,
    options,
    (pick) => {
      const item = options.find((o) => o.id === pick);
      if (item) applyEffect(run!, item.effect, rng);
      if (run!.layer >= 3) {
        run!.over = {
          win: true,
          title: '常规结局 · 破钟',
          body: '钟楼倒了，钟声断在半途。这一代到此为止——你没有再往前走。',
        };
        showOver(root);
        return;
      }
      nextLayer(run!, run!.seed);
      showInterlude(root);
    },
  );
}

function showInterlude(root: HTMLElement): void {
  if (!run) return;
  const theme = themeOf(run.layer);
  root.innerHTML = `
    <div class="rg-inter">
      <h2>${theme.name}</h2>
      <p>${theme.subtitle}</p>
      <p class="rg-dim">身上带着 ${armyCount(run.army)} 个兵、${run.gold} 金、${run.relics.length} 件藏品。</p>
      <button class="rg-btn big" data-act="go">继续</button>
    </div>`;
  root.onclick = (e) => {
    if ((e.target as HTMLElement | null)?.closest('[data-act="go"]')) showMap(root);
  };
}

// ------------------------------------------------------------------ 通用

function showResultThen(root: HTMLElement, title: string, body: string): void {
  if (!run) return;
  const host = document.createElement('div');
  host.className = 'rg-mask';
  host.innerHTML = `<div class="rg-modal small">
      <h3>${escapeHtml(title)}</h3>
      <p class="rg-body">${escapeHtml(body)}</p>
      <div class="rg-choices"><button class="rg-choice" data-ok="1"><b>继续</b><span></span></button></div>
    </div>`;
  document.body.appendChild(host);
  host.onclick = (e) => {
    const ok = (e.target as HTMLElement | null)?.closest('[data-ok]');
    if (!ok) return;
    host.remove();
    if (run?.over) showOver(root);
    else showMap(root);
  };
}

function showOver(root: HTMLElement): void {
  if (!run) return;
  const r = run;
  const over = r.over ?? { win: false, title: '结束', body: '' };
  root.innerHTML = `
    <div class="rg-over ${over.win ? 'win' : 'lose'}">
      <h2>${escapeHtml(over.title)}</h2>
      <p class="rg-body">${escapeHtml(over.body)}</p>
      <dl class="rg-stats">
        <div><dt>打到的层</dt><dd>第 ${r.layer} 层</dd></div>
        <div><dt>走完的步</dt><dd>${r.step}/${STEPS_PER_LAYER}</dd></div>
        <div><dt>剩下的兵</dt><dd>${armyCount(r.army)}</dd></div>
        <div><dt>藏品</dt><dd>${r.relics.length}</dd></div>
        <div><dt>金币</dt><dd>${r.gold}</dd></div>
      </dl>
      <div class="rg-over-btns">
        <button class="rg-btn big" data-act="again">再来一局</button>
        ${exitBtn('rg-btn ghost')}
      </div>
    </div>`;
  root.onclick = (e) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('[data-act="exit"]')) {
      exitToTitle?.();
      return;
    }
    if (!el?.closest('[data-act="again"]')) return;
    run = null;
    showStart(root);
  };
}

/** 通用三选一面板（事件/商店/休整/战利品共用） */
function openModal(
  _root: HTMLElement,
  head: string,
  options: Array<RewardOption | { id: string; title: string; sub: string; effect?: undefined }>,
  onPick: (id: string) => void,
  onCancel?: () => void,
): void {
  const host = document.createElement('div');
  host.className = 'rg-mask';
  host.innerHTML = `<div class="rg-modal">
      ${head}
      <div class="rg-choices">
        ${options
          .map(
            (o) => `<button class="rg-choice" data-pick="${o.id}">
              <b>${escapeHtml(o.title)}</b><span>${escapeHtml(o.sub ?? '')}</span>
            </button>`,
          )
          .join('')}
      </div>
      ${onCancel ? '<button class="rg-cancel" data-cancel="1">离开</button>' : ''}
    </div>`;
  document.body.appendChild(host);
  host.onclick = (e) => {
    const el = e.target as HTMLElement | null;
    const pick = el?.closest<HTMLElement>('[data-pick]')?.dataset.pick;
    if (pick !== undefined) {
      host.remove();
      onPick(pick);
      return;
    }
    if (el?.closest('[data-cancel]')) {
      host.remove();
      onCancel?.();
    }
  };
}

function cleanup(): void {
  cleanupBattle?.();
  cleanupBattle = null;
  document.querySelectorAll('.rg-mask').forEach((el) => el.remove());
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

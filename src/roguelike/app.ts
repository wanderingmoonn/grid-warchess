/**
 * 试玩版的界面层：开局面板 → 层地图 → 房间（事件/商店/休整）→ 战斗 → 结算。
 *
 * 全部是一块 DOM 反复重写，不引框架。房间图、金币、军队这些状态都活在
 * `RunState` 里，这里只负责"显示它、把点击变成对它的修改"。
 */
import { STRATEGIES, armyText, eventById, relicById, themeOf, unitName } from './run.ts';
import { WORLDS } from './data.ts';
import type { WorldId } from './data.ts';
import {
  applyDecision,
  decisionOptions,
  refreshCost,
  afterRoom,
  applyEffect,
  armyCount,
  battleFor,
  bossFor,
  bossRewards,
  finishBattle,
  loseRun,
  nextLayer,
  restOptions,
  rewardOptions,
  shopStock,
  specialRewards,
  isHeroUnit,
  effectiveGold,
  startRun,
  STEPS_PER_LAYER,
} from './run.ts';
import { makeRng, randomSeed } from './rng.ts';
import type { Rng } from './rng.ts';
import type { BattleResult, Effect, RewardOption, RoomNode, RunState } from './types.ts';

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
            <b>${s.name}${s.tag ? `<u class="rg-strat-tag">${s.tag}</u>` : ''}</b>
            <i>${s.sub}</i>
            <span>${armyText(s.army)}</span>
            <em>${s.passive}</em>
          </button>`,
        ).join('')}
      </section>
      <p class="rg-note">选一个方略出发。开局 80–180 金（方略不同）、三层房图随机、敌人编成随时代钟变硬。</p>
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
  const theme = themeOf(r);
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
          <b>${theme.name}</b>${
            r.layer === 2 ? `<em class="rg-world-tag">${WORLDS[r.world].name}</em>` : ''
          }<span>${theme.subtitle}</span>
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
  if (d.kind === 'special') return `守城战 · ${d.special?.name ?? ''}`;
  if (d.kind === 'boss') return '层末会战';
  return d.title;
}

// ------------------------------------------------------------------ 房间

/**
 * 把选项里的"N 金"换成**实际会进账/扣掉**的数（只改显示，不改效果）。
 *
 * 数据里写的是**第一层的钱**（−30 / +70），效果结算时 `applyEffect` 会按同一张
 * 水位表换算；这里让玩家看到的数字和真正扣的钱一致。休整与决议的文案
 * 在生成时已经算好了，不走这里。
 */
function priceHint(hint: string, effect: Effect, r: RunState): string {
  const gold = effectiveGold(effect, r);
  if (gold === 0) return hint;
  return hint.replace(/[+−-]?\d+ 金/, `${gold > 0 ? '+' : '−'}${Math.abs(gold)} 金`);
}

function enterRoom(root: HTMLElement, node: RoomNode): void {
  if (!run) return;
  if (node.kind === 'battle' || node.kind === 'elite' || node.kind === 'siege' || node.kind === 'special') {
    startBattle(root, node);
    return;
  }
  if (node.kind === 'event') {
    const def = eventById(node.eventId ?? '');
    /*
     * 掏不起钱的选项**不出现**。
     *
     * 以前钱是写死的 30/50，几乎总掏得起；按层换算之后第三层一个选项要
     * 几百金，"点了照样给"就变成了白嫖。过滤掉比事后扣成负数干净。
     * 全掏不起时退回全部选项（至少让人有得选）。
     */
    const r = run;
    const indexed = def.choices.map((c, i) => ({ c, i }));
    const affordable = indexed.filter(({ c }) => {
      const g = effectiveGold(c.effect, r);
      return g >= 0 || r.gold >= Math.abs(g);
    });
    const choices = affordable.length > 0 ? affordable : indexed;
    openModal(
      root,
      `<h3>${def.title}</h3><p class="rg-body">${def.body}</p>`,
      choices.map(({ c, i }) => ({
        id: String(i),
        title: c.label,
        sub: priceHint(c.hint ?? '', c.effect, r),
      })),
      (pick) => {
        const choice = def.choices[Number(pick)];
        if (!choice) return;
        const notes = applyEffect(run!, choice.effect, rng, { scaleGold: true });
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
    const heroLocked = r.army.some((a) => isHeroUnit(a.type));
    const row = (group: 'unit' | 'relic' | 'supply', title: string): string => {
      const items = stock.filter((it) => it.group === group);
      if (items.length === 0) return '';
      return `<div class="rg-shop-row"><h5>${title}</h5><div class="rg-shop-items">
        ${items
          .map((it) => {
            // 兵是**按人头卖**的：有钱就能一直买（不然金币会堆成死钱）；
            // 藏品和补给是摊子上就那一件，买完没了。
            const repeatable = it.group === 'unit';
            const addType = it.effect.add?.type;
            const heroBlocked = !!addType && isHeroUnit(addType) && heroLocked;
            const sold = !repeatable && bought.has(it.id);
            const poor = r.gold < it.price;
            return `<button class="rg-shop-item" data-buy="${it.id}" ${
              sold || poor || heroBlocked ? 'disabled' : ''
            }>
              <b>${escapeHtml(it.title)}</b>
              <span>${escapeHtml(it.sub)}</span>
              <em>${heroBlocked ? '队里已有英雄' : sold ? '已售' : poor ? '钱不够' : `${it.price} 金`}</em>
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
        <button class="rg-btn ghost" data-shop="refresh">刷新（${refreshCost(r)} 金）</button>
        <button class="rg-btn" data-shop="leave">离开</button>
      </div>
    </div>`;
  };

  host.onclick = (e) => {
    const el = e.target as HTMLElement | null;
    const buyId = el?.closest<HTMLElement>('[data-buy]')?.dataset.buy;
    if (buyId) {
      const item = stock.find((it) => it.id === buyId);
      if (!item || r.gold < item.price) return;
      if (item.group !== 'unit' && bought.has(item.id)) return;
      const addType = item.effect.add?.type;
      if (addType && isHeroUnit(addType) && r.army.some((a) => isHeroUnit(a.type))) {
        r.log.push('队里只能有一位英雄，这一件没有买');
        paint();
        return;
      }
      r.gold -= item.price;
      applyEffect(r, item.effect, rng);
      r.log.push(`买下 ${item.title}（${item.price} 金）`);
      if (item.group !== 'unit') bought.add(item.id);
      paint();
      return;
    }
    const act = el?.closest<HTMLElement>('[data-shop]')?.dataset.shop;
    if (act === 'refresh') {
      const cost = refreshCost(r);
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
  /*
   * 守城战：报酬是**定好的**（东家给的兵 + 一件藏品 + 一笔钱），不给三选一。
   * 你答应了谁，就拿谁的东西——这跟"打完捡战利品"是两件事，所以单独走一条。
   */
  if (node.kind === 'special') {
    const notes = specialRewards(r, node, rng);
    afterRoom(r);
    showResultThen(root, `${node.title} · 守住了`, `报酬：${notes.join('；')}。`);
    return;
  }
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

/**
 * 层末结算：**战利品是一整套，不给选择**。
 *
 * 按设计：藏品 1 件 + 本层高级兵 1 个 + 相当于高级兵的钱 + **下一层的初级兵 1 个**。
 * 最后那一项是给下一层开局的（不换装之后，玩家会带着一队上一代的兵进新层）。
 */
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

  /*
   * 结算顺序：**先选路，再发战利品**。
   *
   * 战利品里有一项是"下一层的初级兵"，而下一层是哪一层要等选完路才知道
   * （奇想的下一层兵和修真的不是同一批）。所以第一层末的那次结算，
   * 岔口必须排在发奖前面。
   */
  const award = (): void => {
    if (!run) return;
    const notes = bossRewards(run, rng);
    const last = run.layer >= 3;
    if (last) {
      run.over = {
        win: true,
        title: '常规结局 · 破钟',
        body: '钟楼倒了，钟声断在半途。这一代到此为止——你没有再往前走。',
      };
    }
    showResultThen(root, `${node.title} · 已破`, `战利品：${notes.join('；')}。`, () => {
      if (!run) return;
      if (run.layer >= 3) {
        showOver(root);
        return;
      }
      nextLayer(run, run.seed);
      showInterlude(root);
    });
  };

  if (r.layer === 1) showWorldChoice(award);
  else award();
}

/**
 * 第二层的岔口：四种历史。
 *
 * 对应设计里"L1 末的临战决议 = 选这条历史怎么走"：
 *   原版 / 时代军备 → 技术史，奇想 / 修真 → 神话史。
 * 选完第二层的兵池、扩展开关、层末 boss 全部换成那一支史的样子；
 * 第三层保持科技底色，只把这一支史的高代兵混进去（修真是例外，见「末法之世」）。
 */
function showWorldChoice(onPick: () => void): void {
  if (!run) return;
  const list = Object.values(WORLDS);
  const cards = list
    .map((w) => {
      const sample = w.theme.pool.slice(0, 3).map((t) => unitName(t)).join('、');
      return `<button class="rg-world" data-world="${w.id}">
        <b>${w.name}</b>
        <em>${w.history === 'myth' ? '神话史' : '技术史'}</em>
        <span>${w.blurb}</span>
        <i>${sample}……</i>
      </button>`;
    })
    .join('');
  const host = document.createElement('div');
  host.className = 'rg-mask';
  host.innerHTML = `<div class="rg-modal wide">
    <h3>这条历史怎么走</h3>
    <p class="rg-body">第一层打完了。往后的路不止一条——<b>第二层会变成你选的那种样子</b>：兵、敌人、层末的对手全都换。</p>
    <div class="rg-worlds">${cards}</div>
  </div>`;
  document.body.appendChild(host);
  host.onclick = (e) => {
    const id = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-world]')?.dataset.world as
      | WorldId
      | undefined;
    if (!id) return;
    host.remove();
    const w = WORLDS[id];
    if (run) {
      run.world = id;
      run.log.push(`选定的路：${w.name}（${w.history === 'myth' ? '神话史' : '技术史'}）`);
    }
    onPick();
  };
}

function showInterlude(root: HTMLElement): void {
  if (!run) return;
  const theme = themeOf(run);
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

function showResultThen(root: HTMLElement, title: string, body: string, next?: () => void): void {
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
    if (next) next();
    else if (run?.over) showOver(root);
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

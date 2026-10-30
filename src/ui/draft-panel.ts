/**
 * 选卡（BP）界面。
 *
 * 一整块盖住棋盘的遮罩，因为选卡期间棋盘没有任何信息量：
 * 这一局还没开始，双方连兵都还没定。把战场露一半出来只会让人误点。
 *
 * 版面按"看什么最频繁"排：
 *   左边是**池子**（要反复扫的东西，占大头），右边是**双方的禁/选位**
 *   （用来判断"我还缺哪一档、对面拿走了什么"），顶部是阶段与倒计时
 *   （决定"现在该不该急"），底部是流水（回看谁禁了谁）。
 */

import { eraDef, isPseudoUnit } from '../core/config.ts';
import { draftPhaseLabel, draftSecondsLeft, draftView } from '../core/draft.ts';
import { abilityById } from '../core/ability-registry.ts';
import { EXPANSIONS, unitSourceIdOf, unitSourceOf } from '../core/expansions.ts';
import { resourceName } from '../core/resources.ts';
import type { ResourceId } from '../core/types.ts';
import type { GameState, PlayerId, UnitTypeDef } from '../core/types.ts';
import type { DraftState } from '../core/types.ts';

/** 座位的中文名：红方/蓝方来自 players，这里只给"甲/乙"这种不依赖名字的短称 */
function sideName(s: GameState, side: PlayerId): string {
  return s.players[side]?.name ?? (side === 'A' ? '红方' : '蓝方');
}

const CATEGORY_LABEL: Record<string, string> = {
  combat: '战斗',
  building: '建筑',
  economy: '经济',
  builder: '建造',
};

const DOMAIN_LABEL: Record<string, string> = { water: '水军', air: '空军' };

/** 一行数值：攻/甲/血是每个兵种都有的，其余有才写 */
function statLine(def: UnitTypeDef): string {
  const bits = [`攻 ${def.atk}`, `甲 ${def.armor}`, `血 ${def.maxHp}`];
  if (def.move > 0) bits.push(`移 ${def.move}`);
  bits.push(`射 ${def.range}`, `视 ${def.vision}`);
  if (def.splash) bits.push(`溅射 ${def.splash}`);
  if (def.burst && def.burst > 1) bits.push(`连击 ${def.burst}`);
  if (def.magicAtk) bits.push(`魔攻 ${def.magicAtk}`);
  return bits.join(' · ');
}

/** 造价：金币 + 扩展带来的其它资源（有才写） */
function costLine(def: UnitTypeDef): string {
  const bits = [`${def.cost} 金`];
  for (const [id, n] of Object.entries(def.costRes ?? {})) {
    if (typeof n === 'number' && n > 0) bits.push(`${n} ${resourceName(id as ResourceId)}`);
  }
  const src = unitSourceOf(def.id);
  return `${bits.join(' + ')}${src ? ` · 来自「${src}」` : ''}`;
}

/**
 * 卡片的悬停详情。
 *
 * 池子里 20 张卡每张只写"时代 · 造价 · 攻/血"——那是用来**扫**的，不是用来
 * **算**的。要判断"这一手禁它值不值"，得看护甲、射程、视野、溅射、能力。
 * 所以详情单放在这里，由界面在悬停时浮动显示（见 main.ts 的 draftTipPanel）。
 *
 * 关键一点：**点不动的卡也要有详情**。禁用交完了、轮到对面选人，这时候
 * 恰恰是最想研究池子的时候。所以"为什么点不了"是详情里的一行，而不是
 * 干脆不给看。
 */
function unitTip(def: UnitTypeDef, blocked: boolean, reason: string): string {
  const meta = [eraDef(def.era).name, CATEGORY_LABEL[def.category] ?? def.category];
  if (def.domain && DOMAIN_LABEL[def.domain]) meta.push(DOMAIN_LABEL[def.domain]);
  const abil = (def.abilities ?? [])
    .map((id) => abilityById(id)?.name ?? id)
    .filter(Boolean);
  return `<span class="draft-tip" hidden>
      <span class="tip-title"><b>${def.name}</b><i>${meta.join(' · ')}</i></span>
      <span class="tip-row">${statLine(def)}</span>
      <span class="tip-row">${costLine(def)}</span>
      ${abil.length > 0 ? `<span class="tip-row tip-abil">能力：${abil.join(' · ')}</span>` : ''}
      ${blocked && reason ? `<span class="tip-row tip-blocked">现在点不了：${reason}</span>` : ''}
    </span>`;
}

/**
 * 一张卡。
 *
 * 外面套一层 `.draft-card-wrap`：详情浮层要相对卡片定位，同时按钮本身在
 * "点不动"时仍然要能被悬停（`disabled` 的元素在部分浏览器里连鼠标事件都不派发，
 * 那样详情就永远出不来）。所以"点不动"用 `aria-disabled` 表达，点击由
 * onDraftClick 那边拦下并给一句原因。
 */
function unitCard(def: UnitTypeDef, blocked: boolean, reason: string): string {
  const bits = [`${eraDef(def.era).name}`];
  if (def.cost > 0) bits.push(`${def.cost} 金`);
  if (def.category === 'combat') bits.push(`攻 ${def.atk} · 血 ${def.maxHp}`);
  else bits.push('建筑');
  if (def.splash) bits.push(`溅射 ${def.splash}`);
  if (def.range >= 2) bits.push(`射程 ${def.range}`);
  return `<span class="draft-card-wrap">
    <button type="button" class="draft-card ${def.category === 'building' ? 'is-building' : ''}${blocked ? ' is-blocked' : ''}"
      data-draft="${def.id}" ${blocked ? 'aria-disabled="true"' : ''}>
      <span class="dc-icon">${def.short}</span>
      <span class="dc-body">
        <span class="dc-name">${def.name}</span>
        <span class="dc-meta">${bits.join(' · ')}</span>
      </span>
    </button>
    ${unitTip(def, blocked, reason)}
  </span>`;
}

/** 一个槽位：已经定了就显示名字，没定就显示虚线占位 */
function slotChip(label: string, kind: 'ban' | 'pick', filled: string | null): string {
  if (filled) {
    return `<span class="draft-slot is-${kind} is-filled">${filled}</span>`;
  }
  return `<span class="draft-slot is-${kind}">${label}</span>`;
}

function sideBlock(
  s: GameState,
  side: PlayerId,
  opts: { seat: PlayerId; toAct: PlayerId | null; myTurnHere: boolean },
): string {
  const view = draftView(s)!;
  const mine = view[side === 'A' ? 'a' : 'b'];
  const banned = mine.bans.map((id) => s.unitTypes[id]?.name ?? id);
  const picked = mine.picks.map((id) => s.unitTypes[id]?.name ?? id);

  const banSlots: string[] = [];
  for (let i = 0; i < (s.draft?.banSlots ?? 0); i++) {
    banSlots.push(slotChip('禁', 'ban', banned[i] ?? null));
  }
  const pickSlots: string[] = [];
  for (let i = 0; i < (s.draft?.pickSlots ?? 0); i++) {
    pickSlots.push(slotChip(String(i + 1), 'pick', picked[i] ?? null));
  }

  // 状态行：这一方现在在干什么。禁用期是"盲禁"，所以只报"交没交"，不报禁了什么。
  let status = '';
  if (view.phase === 'ban') {
    status = mine.banDone ? '已提交禁用' : '正在挑禁用';
  } else if (view.phase === 'pick') {
    status = opts.toAct === side ? '轮到你选' : `已选 ${picked.length} / ${s.draft?.pickSlots}`;
  } else {
    status = '已完成';
  }

  const cls = [
    'draft-side',
    side === 'A' ? 'is-a' : 'is-b',
    opts.toAct === side ? 'is-active' : '',
    opts.myTurnHere ? 'is-local' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<div class="${cls}">
    <div class="draft-side-head">
      <b>${sideName(s, side)}</b>
      <span class="draft-side-status">${status}</span>
    </div>
    <div class="draft-slot-row">${banSlots.join('')}</div>
    <div class="draft-slot-row">${pickSlots.join('')}</div>
  </div>`;
}

export interface DraftLobbyInfo {
  code: string;
  /** 邀请链接（带 ?room= 的那个） */
  link: string;
  /** 对面已经入座了吗 */
  peerSeated: boolean;
}

export interface DraftScreenCtx {
  /** 本地设备现在替哪一方操作（热座会换手） */
  seat: PlayerId;
  now: number;
  /** 这一方是不是 AI（用来写"AI 正在挑"而不是"轮到你了"） */
  isAi: (side: PlayerId) => boolean;
  /** 联机房间信息（没建房时是 null） */
  room?: DraftLobbyInfo | null;
  /**
   * 倒计时上限（秒）。
   *
   * 房间那份 deadline 是**另一台机器**的钟写进来的，可能早就过期了
   * （你入座时对面已经在禁用屏上坐了好几分钟）。直接拿它显示，一进来就是
   * "0s"。所以界面这边另外记一个"我看到这一轮的时刻"，两者取小。
   */
  secondsCap?: number;
}

/** 顶栏右上角的两颗按钮：跳过与退出。两个阶段都要能点到 */
function headActions(isLobby: boolean, online: boolean): string {
  return `<div class="draft-head-actions">
    ${
      /*
       * 「刷新房间状态」：联机选卡出岔子时的逃生口。
       *
       * 选卡的每一步都要写进房间，写失败（断网、对面抢先、手机切后台）之后
       * 本机会停在一份"房间里并不存在"的名单上，看起来就是"点不动了"。
       * 与其让玩家只能关页面重进，不如给他一颗按钮：按房间那份重新对齐。
       */
      online
        ? '<button class="draft-btn is-quiet" data-draft-act="refresh" title="按房间里的状态重新对齐一次（卡住时点这里）">刷新房间状态</button>'
        : ''
    }
    <button class="draft-btn" data-draft-act="skip" title="${
      isLobby ? '不选卡，这一局直接用全部兵种开打' : '放弃这一轮选卡，改用全部兵种继续'
    }">跳过选卡</button>
    <button class="draft-btn is-quiet" data-draft-act="exit" title="放弃这一局，回到开局设置">退出</button>
  </div>`;
}

/** 转义进 HTML 属性/文本的东西（房间链接里有 & 和 ?） */
function esc(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 等待开局（lobby）。
 *
 * 这一屏存在的理由很具体：选卡遮罩是整屏的，一盖上去顶栏的「联机」「新对局」
 * 就都点不到了——于是"建房把链接发给朋友"这件事在 BP 期间根本做不到。
 * 所以开局先停在这里：能建房、能看到邀请链接、能等对面入座，然后再开始禁用。
 */
function lobbyHtml(s: GameState, ctx: DraftScreenCtx): string {
  const draft = s.draft!;
  const room = ctx.room ?? null;
  const bonus = draft.pickSlots > 6 || draft.banSlots > 1
    ? `（本局按扩展加成：各禁 ${draft.banSlots}、各选 ${draft.pickSlots}）`
    : '';

  const roomBlock = room
    ? `<div class="lobby-room">
        <div class="lobby-row">
          <span class="lobby-label">房间码</span>
          <b class="lobby-code">${esc(room.code)}</b>
          <span class="lobby-status ${room.peerSeated ? 'is-ok' : ''}">${
            room.peerSeated ? '对面已入座' : '等待对面入座…'
          }</span>
        </div>
        <div class="lobby-row">
          <input class="lobby-link" readonly value="${esc(room.link)}" aria-label="邀请链接" />
          <button class="draft-btn" data-draft-act="copy-link">复制</button>
        </div>
      </div>`
    : '';

  return `<div class="draft">
    <header class="draft-head">
      <div class="draft-head-main">
        <span class="draft-step">选卡 · 等待开局</span>
        <span class="draft-seat">${room ? `房间 ${esc(room.code)}` : '本机 / 热座'}</span>
      </div>
      ${headActions(true, room !== null)}
      <div class="draft-hint">${
        room
          ? room.peerSeated
            ? '对面已经入座，点「开始选卡」进入禁用'
            : '把上面的链接发给他，他点开就入座；入座之后点「开始选卡」'
          : '想联机就先建房、把链接发过去；也可以直接在本机开打（热座轮流操作）'
      }</div>
    </header>
    <section class="draft-lobby">
      <h2>这一局能造什么，由这轮选卡决定</h2>
      <p class="draft-lobby-lead">
        系统抽出 <b>${draft.pool.length}</b> 个兵种组成池子，双方各禁用 <b>${draft.banSlots}</b> 个，
        再从剩下的里各选 <b>${draft.pickSlots}</b> 个${bonus}。这一局只能造自己选到的，
        外加经济、建造、军营这些骨架单位。
      </p>
      <div class="lobby-actions">
        <button class="draft-btn is-primary" data-act="online">联机 · 建房 / 加入</button>
        <button class="draft-btn is-primary" data-draft-act="start">开始选卡</button>
      </div>
      ${roomBlock}
      <p class="draft-hint">不想选卡也可以点右上角「跳过选卡」，这一局按原版用全部兵种开打。</p>
    </section>
  </div>`;
}

/**
 * 整块遮罩的 HTML。
 *
 * 只画"能看见的东西"：禁用期双方同时进行、互不可见，所以池子里**不显示**
 * 对面禁了谁——只显示"已提交 / 未提交"。两边都交完，禁用列表才一起出现。
 */
export function draftScreenHtml(s: GameState, ctx: DraftScreenCtx): string {
  const view = draftView(s);
  if (!view) return '';
  // 等待开局单独一屏：那里还没有禁/选，画池子只会让人以为可以点
  if (view.phase === 'lobby') return lobbyHtml(s, ctx);
  const draft = s.draft!;
  const seat = ctx.seat;
  const aiTurn = view.toAct ? ctx.isAi(view.toAct) : false;

  // 谁能点：禁用期＝本地这一方还没交；选人期＝当前这一方就是本地席位
  const canBan = view.phase === 'ban' && !view[seat === 'A' ? 'a' : 'b'].banDone;
  const canPick = view.phase === 'pick' && view.toAct === seat;
  const clickable = canBan || canPick;

  const hint =
    view.phase === 'ban'
      ? canBan
        ? `挑一个你最不想看到的兵种禁掉（${draft.banSlots} 个），对方同时在进行，互相看不到`
        : `你已提交，等${sideName(s, seat === 'A' ? 'B' : 'A')}禁用`
      : view.phase === 'pick'
        ? view.toAct === seat
          ? '轮到你选：点一个兵加入本局名单'
          : aiTurn
            ? `${sideName(s, view.toAct!)}（AI）正在挑`
            : `等${sideName(s, view.toAct!)}选，对方选完就轮到你`
        : '选卡完成，正在进入战场';

  /**
   * 卡片排序：**时代为主、扩展为辅**。
   *
   * 玩家扫池子时先问"这一代有什么"（时代决定它什么时候能用），第二个问题才是
   * "哪个包里带的"（同一代里本体的兵和扩展的兵手感不同）。抽池子时是按时代
   * 分层抽的，但抽出来的顺序是"一层一张"轮着来，直接铺出来是花的。
   */
  const packRank = new Map(EXPANSIONS.map((e, i) => [e.id, i + 1]));
  const rank = (id: string): [number, number, number, string] => {
    const def = s.unitTypes[id];
    // 没配 era 的怪东西排到最后，别把整个池子的顺序搞崩
    const era = typeof def?.era === 'number' ? def.era : 99;
    const source = unitSourceIdOf(id);
    // 原版（没有来源包）排最前，其余按扩展的声明顺序
    const pack = source ? (packRank.get(source) ?? 98) : 0;
    // 同一代同一个包里，战斗单位在前、建筑在后
    const cat = def?.category === 'building' ? 1 : 0;
    return [era, pack, cat, def?.name ?? id];
  };
  const remain = view.remaining
    .filter((id) => !isPseudoUnit(id) && !!s.unitTypes[id])
    .slice()
    .sort((a, b) => {
      const [ea, pa, ca, na] = rank(a);
      const [eb, pb, cb, nb] = rank(b);
      return ea - eb || pa - pb || ca - cb || na.localeCompare(nb);
    });

  // 点不动的原因要写在卡片详情里：禁用交完、对面在选人时，正是最想研究池子的时候
  const blockReason =
    view.phase === 'pick' && view.toAct !== seat
      ? `等${sideName(s, view.toAct ?? 'A')}选完`
      : canBan
        ? ''
        : view.phase === 'ban'
          ? '你已经提交过禁用了，等对面'
          : '现在不是你的操作';
  const cards = remain.map((id) => unitCard(s.unitTypes[id]!, !clickable, blockReason)).join('');

  // 禁用期不揭晓对面禁了什么；选人期两边都公开
  const banLine = (side: PlayerId) => {
    const list = draft.bans[side].filter(Boolean);
    return list.map((id) => s.unitTypes[id]?.name ?? id).join('、');
  };
  const bansHtml =
    view.phase === 'ban'
      ? ''
      : `<div class="draft-bans">
          <span class="draft-bans-title">禁用</span>
          <span class="draft-ban-chip is-a">${sideName(s, 'A')}：${banLine('A') || '无'}</span>
          <span class="draft-ban-chip is-b">${sideName(s, 'B')}：${banLine('B') || '无'}</span>
        </div>`;

  const log = draft.history
    .slice(-6)
    .map((h) => {
      const who = sideName(s, h.side);
      if (h.kind === 'ban') {
        const what = h.unitId ? s.unitTypes[h.unitId]?.name ?? h.unitId : '放弃';
        return `<li><b class="is-${h.side === 'A' ? 'a' : 'b'}">${who}</b> 禁用 ${what}${h.auto ? '（超时）' : ''}</li>`;
      }
      const what = h.unitId ? s.unitTypes[h.unitId]?.name ?? h.unitId : '—';
      return `<li><b class="is-${h.side === 'A' ? 'a' : 'b'}">${who}</b> 选用 ${what}${h.auto ? '（超时代选）' : ''}</li>`;
    })
    .join('');

  const remoteSecs = draftSecondsLeft(s, ctx.now);
  // 房间那份 deadline 可能是另一台机器的钟写的（甚至早就过期）；
  // 本机另有锚点，两者取小才既不会"一进来 0 秒"也不会把别人的时间当成自己的
  const secs = ctx.secondsCap === undefined ? remoteSecs : Math.min(remoteSecs, ctx.secondsCap);

  return `<div class="draft">
    <header class="draft-head">
      <div class="draft-head-main">
        <span class="draft-step">${draftPhaseLabel(s)}</span>
        <span class="draft-seat">${sideName(s, seat)}操作中</span>
      </div>
      <div class="draft-timer ${secs <= 5 ? 'is-hurry' : ''}" data-ref="draft-timer">${secs}s</div>
      ${headActions(false, ctx.room != null)}
      <div class="draft-hint">${hint}</div>
    </header>
    <div class="draft-body">
      <section class="draft-pool">
        <div class="draft-pool-head">
          <span>兵种池</span>
          <span class="draft-pool-count">剩 ${remain.length} / ${draft.pool.length}</span>
        </div>
        ${bansHtml}
        <div class="draft-grid">${cards || '<p class="draft-empty">池子空了</p>'}</div>
      </section>
      <aside class="draft-sides">
        ${sideBlock(s, 'A', { seat, toAct: view.toAct, myTurnHere: seat === 'A' })}
        ${sideBlock(s, 'B', { seat, toAct: view.toAct, myTurnHere: seat === 'B' })}
        <ul class="draft-log">${log}</ul>
      </aside>
    </div>
  </div>`;
}

/** 只换倒计时那一个节点，不整块重绘（整块重绘会把滚动位置和焦点一起丢掉） */
export function paintDraftTimer(
  root: HTMLElement,
  s: GameState,
  now: number,
  cap?: number,
): void {
  const el = root.querySelector<HTMLElement>('[data-ref="draft-timer"]');
  if (!el) return;
  const remote = draftSecondsLeft(s, now);
  const secs = cap === undefined ? remote : Math.min(remote, cap);
  const text = `${secs}s`;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('is-hurry', secs <= 5);
}

/** 选卡期间棋盘不该响应点击——遮罩自己带 pointer-events，这里只做语义开关 */
export function draftBlocksBoard(state: GameState): boolean {
  return !!state.draft && state.draft.phase !== 'done';
}

export type { DraftState };

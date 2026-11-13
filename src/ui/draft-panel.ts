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

import { UNIT_TYPES, eraDef, isPseudoUnit } from '../core/config.ts';
import { buildListOf } from '../core/build-list.ts';
import { draftMsOf, draftPhaseLabel, draftSecondsLeft, draftView } from '../core/draft.ts';
import { abilityById } from '../core/ability-registry.ts';
import { airLayer } from '../core/rules.ts';
import { EXPANSIONS, unitSourceIdOf, unitSourceOf } from '../core/expansions.ts';
import { resourceName } from '../core/resources.ts';
import { unitStatLine } from '../core/info.ts';
import type { ResourceId } from '../core/types.ts';
import { ELEMENT_NAME } from '../core/types.ts';
import type { GameState, PlayerId, UnitTypeDef } from '../core/types.ts';
import type { DraftState } from '../core/types.ts';

/** 座位的中文名：红方/蓝方来自 players，这里只给"甲/乙"这种不依赖名字的短称 */
function sideName(s: GameState, side: PlayerId): string {
  return s.players[side]?.name ?? (side === 'A' ? '红方' : '蓝方');
}

/**
 * 悬停卡里查建筑中文名用的表：本体兵种 + 各扩展登记的兵种。
 * 选卡时这一局还没真正开起来，手里只有静态数据，所以凑一张全量表；
 * 名单本身仍由 buildListOf 生成，规则书和产兵按钮用的是同一份逻辑。
 */
const TIP_UNIT_NAMES = new Map<string, string>();
/** 档位表：白名单里可能混着高代建筑（扩展在开局补条目），名单要按档位滤 */
const TIP_UNIT_ERAS = new Map<string, number>();
for (const [id, u] of Object.entries(UNIT_TYPES)) {
  TIP_UNIT_NAMES.set(id, u.name);
  TIP_UNIT_ERAS.set(id, u.era);
}
for (const e of EXPANSIONS) {
  for (const u of e.units ?? []) {
    TIP_UNIT_NAMES.set(u.id, u.name);
    TIP_UNIT_ERAS.set(u.id, u.era);
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  combat: '战斗',
  building: '建筑',
  economy: '经济',
  builder: '建造',
};

const DOMAIN_LABEL: Record<string, string> = { water: '水军', air: '空军' };

/*
 * 一行数值直接复用 `core/info` 的 `unitStatLine`。
 *
 * 这里原本是本地写的一份，措辞还和别处不同（它写「视」，产兵面板干脆没有这一项）。
 * 同一张兵种卡，从选卡面板看和从兵营面板看差一个数字，是最没道理的不一致。
 */

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
  // 建造单位：把"能盖哪几样"也放进悬停卡，玩家在禁用/选用之前就能判断值不值
  const builds = buildListOf(def, {
    nameOf: (id) => TIP_UNIT_NAMES.get(id),
    eraOf: (id) => TIP_UNIT_ERAS.get(id),
  });
  return `<span class="hover-tip" hidden>
      <span class="tip-title"><b>${def.name}</b><i>${meta.join(' · ')}</i></span>
      <span class="tip-row">${unitStatLine(def)}</span>
      <span class="tip-row">${costLine(def)}</span>
      ${abil.length > 0 ? `<span class="tip-row tip-abil">能力：${abil.join(' · ')}</span>` : ''}
      ${builds.names.length > 0 ? `<span class="tip-row tip-abil">可建造：${builds.names.join('、')}（共 ${builds.names.length} 种）</span>` : ''}
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
  // 紧凑卡是"一眼挑兵"用的，只写最能区分人的几项；视野跟着射程一起出，
  // 因为"打得到多远"和"看得到多远"是同一个问题的两面。
  if (def.category === 'combat') bits.push(`攻 ${def.atk} · 血 ${def.maxHp}`);
  else bits.push('建筑');
  if (def.splash) bits.push(`溅射 ${def.splash}`);
  if (def.range >= 2) bits.push(`射程 ${def.range}`);
  bits.push(`视野 ${def.vision}`);
  return `<span class="draft-card-wrap" data-hover-tip>
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

/**
 * 一个槽位：已经定了就显示名字，没定就显示虚线占位。
 *
 * 定下来的那一格**也带完整详情**（2026-11-07）。
 *
 * 原来这里只印一个名字。可是"对面拿走了什么"恰恰是选卡时最想研究的一件事：
 * 要确认它是不是我打算禁的那张、要确认它几甲几射程、要确认它带着什么能力。
 * 只给名字，等于让人凭记忆打——而池子有二十张卡，记忆是靠不住的。
 * 既然池子里的卡都有详情，已经落到位置上的那一张没理由反而看不全。
 *
 * 注释里"点不动"这条对它不成立：这是**已经定了**的格子，本来就没有点击这回事，
 * 所以 `unitTip` 的 blocked 一律传 false。
 */
function slotChip(
  label: string,
  kind: 'ban' | 'pick',
  id: string | null,
  s: GameState,
): string {
  if (!id) return `<span class="draft-slot is-${kind}">${label}</span>`;
  const def = s.unitTypes[id];
  if (!def) return `<span class="draft-slot is-${kind} is-filled">${id}</span>`;
  return `<span class="draft-slot is-${kind} is-filled is-tippy" data-hover-tip>${def.name}${unitTip(def, false, '')}</span>`;
}

function sideBlock(
  s: GameState,
  side: PlayerId,
  opts: { seat: PlayerId; toAct: PlayerId | null; myTurnHere: boolean },
): string {
  const view = draftView(s)!;
  const mine = view[side === 'A' ? 'a' : 'b'];
  // 传 id 而不是名字：槽位要自己查面板上的完整详情（见 slotChip）
  const banned = mine.bans;
  const picked = mine.picks;

  const banSlots: string[] = [];
  for (let i = 0; i < (s.draft?.banSlots ?? 0); i++) {
    banSlots.push(slotChip('禁', 'ban', banned[i] ?? null, s));
  }
  const pickSlots: string[] = [];
  for (let i = 0; i < (s.draft?.pickSlots ?? 0); i++) {
    pickSlots.push(slotChip(String(i + 1), 'pick', picked[i] ?? null, s));
  }

  // 状态行：这一方现在在干什么。禁用期是"盲禁"，所以只报"交没交"，不报禁了什么。
  let status = '';
  if (view.phase === 'ban') {
    // 轮流制：三种状态要分开——轮到我了 / 我在禁但没禁完 / 我禁完了
    const myTurn = view.banTurn === side;
    status = mine.banDone
      ? `已禁 ${mine.bans.length} 个`
      : myTurn
        ? `轮到禁用（还剩 ${Math.max(0, (s.draft?.banSlots ?? 0) - mine.bans.length)} 个）`
        : '等对面禁用';
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

/* ===========================================================================
 * 已选卡牌（底部对照区）
 *
 * 为什么单独做一块而不是塞进右边那栏：右边那栏是**槽位**（第几个选了谁），
 * 用它复盘一场 BP 够用，用它**读一个兵**不够——选卡期最常发生的动作是
 * "我已经拿了这三个，下一签该补什么"，这件事需要同时看见：
 *   ① 三个兵各自的面板（攻甲血、射程、溅射、魔抗……）
 *   ② 它们各自的特性（能力、技能、属性弱点）
 * 而这两样在 20 张卡的池子卡片里是**故意省略**的（那批卡是用来扫的，
 * 一行 meta 就够）。所以这里不省：数值一行不落，特性一条不藏，
 * 也不做"悬停才显示"——玩家要能把选卡面板当草稿纸看。
 *
 * 版面按"数量自适应"排：`auto-fill` 的网格，2 张时两列、8 张时四列，
 * 每张卡自己长高，整块跟着长，页面本来就能滚（`.draft-mask` 是 overflow:auto）。
 * ========================================================================= */

/** 一个数值格：只有真的有意义时才出现（攻甲血永远出现） */
function statCell(label: string, value: number | string): string {
  return `<span class="dp-stat"><i>${label}</i><b>${value}</b></span>`;
}

/** 这张卡上该写的全部特性（能力 + 技能 + 属性），一条都不折叠 */
function traitBlocks(def: UnitTypeDef): string {
  const out: string[] = [];

  const abilities = (def.abilities ?? [])
    .map((id) => abilityById(id))
    .filter((a): a is NonNullable<typeof a> => !!a);
  if (abilities.length > 0) {
    out.push(
      `<div class="dp-traits">${abilities
        .map(
          (a) =>
            `<div class="dp-trait"><b>${a.name}</b><span>${a.summary}</span></div>`,
        )
        .join('')}</div>`,
    );
  }

  for (const sk of def.skills ?? []) {
    out.push(
      `<div class="dp-trait is-skill"><b>${sk.name}${
        sk.cooldown ? `（冷却 ${sk.cooldown}）` : sk.charges ? `（${sk.charges} 发）` : ''
      }</b><span>${sk.summary}</span></div>`,
    );
  }

  // 属性与克制关系：这一条在池子卡片上从来不写，可它决定"这个兵该拿去打谁"
  if (def.element) {
    const bits = [ELEMENT_NAME[def.element]];
    for (const [el, mul] of Object.entries(def.weak ?? {})) {
      if (typeof mul === 'number' && mul > 1) bits.push(`弱 ${ELEMENT_NAME[el as keyof typeof ELEMENT_NAME]} ×${mul}`);
    }
    for (const [el, mul] of Object.entries(def.resist ?? {})) {
      if (typeof mul === 'number' && mul < 1) bits.push(`抗 ${ELEMENT_NAME[el as keyof typeof ELEMENT_NAME]} ×${mul}`);
    }
    out.push(`<div class="dp-trait is-element"><b>属性</b><span>${bits.join(' · ')}</span></div>`);
  }

  return out.join('');
}

/**
 * 一张"已选卡"的完整信息卡。
 *
 * 刻意不用 `.draft-card`：那个是按钮、是**候选**，参数是"能扫"；
 * 这里是**档案**，参数是"能读"。两者混用迟早会为了池子的密度去砍这里的文字。
 */
function pickedCard(def: UnitTypeDef, index: number): string {
  const tags: string[] = [
    `<span class="dp-tag">${eraDef(def.era).name}</span>`,
    `<span class="dp-tag">${CATEGORY_LABEL[def.category] ?? def.category}</span>`,
  ];
  if (def.hero) tags.push('<span class="dp-tag is-hero">英雄</span>');
  if (def.domain && DOMAIN_LABEL[def.domain]) tags.push(`<span class="dp-tag">${DOMAIN_LABEL[def.domain]}</span>`);
  /*
   * 空中层只有一种标签。
   *
   * 以前这里分「掠空 / 空中 / 飞行」三种写法：`layer==='air'` 的看 flight 决定
   * 叫掠空还是空中，只写了 flight 的叫"飞行"。可那三种写法背后是同一件事
   * （见 rules.airLayer），同一个能力被标成三个名字，玩家根本分不出差别。
   * 真正需要区分的是"能不能和地面同格"——那是空中层本身，现在一律叫「空中」；
   * 只掠水、仍在地面的（蜘蛛骑士的「跳跃」）另给一个标签。
   */
  if (airLayer(def)) tags.push('<span class="dp-tag is-air">空中</span>');
  else if ((def.abilities ?? []).some((a) => a === 'leap' || a === 'fly')) {
    tags.push('<span class="dp-tag is-air">掠水</span>');
  }
  if (def.summonedOnly) tags.push('<span class="dp-tag">召唤物</span>');

  const stats: string[] = [statCell('攻', def.atk), statCell('甲', def.armor), statCell('血', def.maxHp)];
  if (def.move > 0) stats.push(statCell('移', def.move));
  stats.push(statCell('射', def.range), statCell('视', def.vision));
  if (def.magicAtk) stats.push(statCell('魔攻', def.magicAtk));
  if (def.magicRes) stats.push(statCell('魔抗', def.magicRes));
  if (def.splash) stats.push(statCell('溅射', `${def.splash}${def.splashLine ? '（直线）' : ''}`));
  if (def.burst && def.burst > 1) stats.push(statCell('连击', def.burst));
  if (def.ammo) stats.push(statCell('弹药', def.ammo));
  if (def.income) stats.push(statCell('产出', `${def.income} 金/回合`));

  const src = unitSourceOf(def.id);
  const costBits = [`${def.cost} 金`];
  for (const [id, n] of Object.entries(def.costRes ?? {})) {
    if (typeof n === 'number' && n > 0) costBits.push(`${n} ${resourceName(id as ResourceId)}`);
  }
  if (def.hero && def.unlockCost) costBits.push(`解锁 ${def.unlockCost} 金`);

  return `<article class="draft-pick">
    <header class="dp-head">
      <span class="dp-icon">${def.short}</span>
      <div class="dp-head-body">
        <div class="dp-name-row"><span class="dp-index">${index}</span><b class="dp-name">${def.name}</b></div>
        <div class="dp-tags">${tags.join('')}</div>
      </div>
    </header>
    <div class="dp-stats">${stats.join('')}</div>
    <div class="dp-cost">${costBits.join(' + ')}${src ? ` · 来自「${src}」` : ''}</div>
    ${traitBlocks(def)}
  </article>`;
}

/**
 * 底部对照区：本地这一方**已经选到**的全部卡。
 *
 * 只放自己那一方。对面拿了什么，右边槽位和禁用条已经写清楚；
 * 把两边的完整面板都铺在下面，等于把一屏变成两屏，反而难对照。
 */
function pickedPanel(s: GameState, seat: PlayerId): string {
  const draft = s.draft!;
  const picks = (draft.picks[seat] ?? []).filter((id) => !!s.unitTypes[id]);
  const cards = picks.map((id, i) => pickedCard(s.unitTypes[id]!, i + 1)).join('');
  const empty = picks.length === 0;

  return `<section class="draft-picked is-${seat === 'A' ? 'a' : 'b'}">
    <div class="draft-picked-head">
      <b>我已选 · ${sideName(s, seat)}</b>
      <span class="draft-picked-count">${picks.length} / ${draft.pickSlots}</span>
      <span class="draft-picked-hint">${
        empty
          ? '禁用阶段还没有人选卡；选到的兵会带着完整面板出现在这里'
          : '完整数值与特性都摊开写着，挑下一签时直接对照，不用再悬停'
      }</span>
    </div>
    ${
      empty
        ? ''
        : `<div class="draft-picked-grid">${cards}</div>`
    }
  </section>`;
}

/**
 * 只读的"这一方选到了什么"——给**对局中**点城市时用。
 *
 * 为什么复用 `pickedCard` 而不是另写一套小卡片：
 * 这段内容的意义就是"和选卡界面右侧那个预览一模一样"。两份实现一定会漂移
 * （一边加了字段、另一边忘了），而玩家会立刻发现"BP 时看到的面板和打起来看到的不一样"。
 *
 * `skipped`（跳过选卡）时返回空串：那种局面没有名单，显示一个空框只会让人以为坏了。
 */
export function draftedCardsHtml(s: GameState, seat: PlayerId): string {
  const draft = s.draft;
  if (!draft || draft.skipped) return '';
  const picks = (draft.picks[seat] ?? []).filter((id) => !!s.unitTypes[id]);
  if (picks.length === 0) return '';
  const cards = picks.map((id, i) => pickedCard(s.unitTypes[id]!, i + 1)).join('');
  return `<section class="draft-picked is-${seat === 'A' ? 'a' : 'b'}" style="margin-top:12px">
    <div class="draft-picked-head">
      <b>${sideName(s, seat)} · 选到的卡</b>
      <span class="draft-picked-count">${picks.length} / ${draft.pickSlots}</span>
      <span class="draft-picked-hint">这一局的名单，BP 时定下的</span>
    </div>
    <div class="draft-picked-grid">${cards}</div>
  </section>`;
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
/**
 * 地图预览：选卡时双方都看得见这张图。
 *
 * ── 为什么必须有这一块 ────────────────────────────────────────────────
 *
 * 选卡发生在开局之前，但地图**已经生成好了**（`createMatch` 先建图再建选卡）。
 * AI 的选卡函数一直在读它：`aiDraftBan` / `aiDraftPick` 都拿 `waterShareOf(state)`
 * 给水军加权——"这张图有的是水，选两条船"。
 *
 * 而真人这边只有一层不透明的遮罩：手上有兵种表，看不到图。同一件决定，
 * 一边有情报、一边没有，这不叫"AI 聪明"，叫规则不公平。所以补上这块预览：
 * **要么两边都看得见，要么两边都别看**，而看得见显然更好玩——选船还是选马，
 * 本来就该是看着地形做的决定。
 *
 * ── 为什么不是把整张棋盘搬进来 ────────────────────────────────────────
 *
 * 棋盘那套 DOM 是给"能点的格子"用的（每一格带高亮层、交互类名），
 * 1024 格铺进来既慢又没法点。这里只画**地形和城的归属**：一格一个空 `<i>`，
 * 颜色直接取地形变量，不建伪元素、不加动画——和 64×64 那次"逐格 filter 把标签页
 * 压垮"的教训是同一件事：缩略图只该有颜色。
 */
function mapPreviewHtml(s: GameState): string {
  const W = s.w;
  // 城市格单独标出来：地形是 city，但要能看出是谁的城
  const cityOwner = new Map<number, PlayerId>();
  for (const c of s.cities) {
    for (let dy = 0; dy < c.size; dy++) {
      for (let dx = 0; dx < c.size; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= s.h) continue;
        cityOwner.set(y * W + x, c.owner);
      }
    }
  }
  const cells: string[] = [];
  let wet = 0;
  for (let i = 0; i < s.tiles.length; i++) {
    const terrain = s.tiles[i]?.terrain ?? 'plain';
    if (terrain === 'water' || terrain === 'deep') wet += 1;
    const own = cityOwner.get(i);
    cells.push(`<i class="mp t-${terrain}${own ? ` own-${own}` : ''}"></i>`);
  }
  const share = s.tiles.length > 0 ? Math.round((wet / s.tiles.length) * 100) : 0;
  const cities = s.cities.filter((c) => !c.ruined).length;
  return `<section class="draft-map" data-ref="draft-map">
    <div class="draft-map-head">
      <span>本局地图</span>
      <span class="draft-map-facts">${W}×${s.h} · 水域 ${share}% · 城市 ${cities} 座</span>
    </div>
    <div class="draft-map-grid" style="--cols:${W};--rows:${s.h}">${cells.join('')}</div>
    <p class="draft-map-note">双方看到的是同一张图（AI 选卡时也在看它）</p>
  </section>`;
}

export function draftScreenHtml(s: GameState, ctx: DraftScreenCtx): string {
  const view = draftView(s);
  if (!view) return '';
  // 等待开局单独一屏：那里还没有禁/选，画池子只会让人以为可以点
  if (view.phase === 'lobby') return lobbyHtml(s, ctx);
  const draft = s.draft!;
  const seat = ctx.seat;
  const aiTurn = view.toAct ? ctx.isAi(view.toAct) : false;

  /*
   * 谁能点：禁用期＝**轮到本地这一方**且还没禁满；选人期＝当前这一方就是本地席位。
   *
   * 轮流禁之后"没禁满"不再等于"能点"：对面那一轮里你也还没禁满，
   * 但一步都不该让你下（规则层也会拒，界面必须先在前面拦住，否则点一下弹一句
   * "轮到红方禁用"——那是在用提示音代替禁用）。
   */
  const banTurn = view.phase === 'ban' ? view.banTurn : null;
  const myBanLeft = Math.max(0, draft.banSlots - draft.bans[seat].length);
  const canBan = view.phase === 'ban' && banTurn === seat && myBanLeft > 0;
  const canPick = view.phase === 'pick' && view.toAct === seat;
  const clickable = canBan || canPick;

  const hint =
    view.phase === 'ban'
      ? canBan
        ? myBanLeft === draft.banSlots
          ? `轮到你禁用：挑 ${draft.banSlots} 个最不想看到的兵种，禁完就换对面`
          : `还能禁 ${myBanLeft} 个，禁完就换对面`
        : banTurn && banTurn !== seat
          ? `${sideName(s, banTurn)}正在禁用，禁完轮到你`
          : `你已禁完，等${sideName(s, seat === 'A' ? 'B' : 'A')}禁用`
      : view.phase === 'pick'
        ? view.toAct === seat
          ? '轮到你选：点一个兵加入本局名单'
          : aiTurn
            ? `${sideName(s, view.toAct!)}（AI）正在挑`
            : `等${sideName(s, view.toAct!)}选，对方选完就轮到你`
        : '选卡完成，正在进入战场';

  /**
   * 这一阶段的时限写成一句话挂在提示后面。
   *
   * 单独占一个格子会打乱头部那套 grid 布局，而玩家真正想知道的是
   * "我现在这一手有多少时间"——留在倒计时旁边最省事。
   */
  const limitSecs = Math.round(draftMsOf(s) / 1000);
  const hintWithLimit =
    view.phase === 'ban' || view.phase === 'pick' ? `${hint}（本阶段 ${limitSecs} 秒）` : hint;

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
          ? banTurn && banTurn !== seat
            ? `现在轮到${sideName(s, banTurn)}禁用`
            : '你已经禁完了，等对面'
          : '现在不是你的操作';
  const cards = remain.map((id) => unitCard(s.unitTypes[id]!, !clickable, blockReason)).join('');

  /*
   * 禁用条：**已经禁完的那一方要露出来**。
   *
   * 盲禁时代这里是空的（"禁用期不揭晓对面禁了什么"），因为两边同时交、
   * 交完一起开。轮流禁之后这条反过来了：后禁的一方**必须**看得见先禁方禁了
   * 什么，否则他会去禁一个已经被禁掉的兵（规则层会拒，但那已经浪费了他的时间）。
   * 只看"禁完的"——还在禁的那一方没禁完，露一半出来只会误导。
   */
  const banLine = (side: PlayerId) => {
    const list = draft.bans[side].filter(Boolean);
    return list.map((id) => s.unitTypes[id]?.name ?? id).join('、');
  };
  const banDoneOf = (side: PlayerId) => draft.bans[side].length >= draft.banSlots;
  const showBans = (side: PlayerId) => view.phase === 'pick' || banDoneOf(side);
  const bansHtml =
    !showBans('A') && !showBans('B')
      ? ''
      : `<div class="draft-bans">
          <span class="draft-bans-title">禁用</span>
          ${showBans('A') ? `<span class="draft-ban-chip is-a">${sideName(s, 'A')}：${banLine('A') || '无'}</span>` : ''}
          ${showBans('B') ? `<span class="draft-ban-chip is-b">${sideName(s, 'B')}：${banLine('B') || '无'}</span>` : ''}
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
      <div class="draft-hint">${hintWithLimit}</div>
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
        ${mapPreviewHtml(s)}
        ${sideBlock(s, 'A', { seat, toAct: view.toAct, myTurnHere: seat === 'A' })}
        ${sideBlock(s, 'B', { seat, toAct: view.toAct, myTurnHere: seat === 'B' })}
        <ul class="draft-log">${log}</ul>
      </aside>
    </div>
    ${pickedPanel(s, seat)}
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

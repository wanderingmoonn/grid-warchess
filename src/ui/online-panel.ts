/**
 * 联机面板。
 *
 * 干的事很少：把当前这局挂到网上、拿一个房间码，或者用别人的码坐进去。
 * 真正麻烦的部分（提交、轮询、迷雾归属）在 main.ts 和 net/room.ts 里，
 * 这里只负责把状态说人话。
 *
 * 一块要特别注意的文案：迷雾在联机模式下仍然是"界面不给你看"，
 * 不是密码学意义上的安全。写清楚比藏着好——
 * 谁都能 F12，别让人以为这游戏能防外挂。
 */

import type { GameState, PlayerId } from '../core/types.ts';
import {
  claimSeat,
  createRoom,
  fetchRoom,
  loadSeat,
  newToken,
  normalizeCode,
  type RoomSeat,
  type RoomSnapshot,
} from '../net/room.ts';

export interface OnlineHost {
  /** 当前本地这局，用来"挂到网上" */
  currentState(): GameState;
  room(): RoomSeat | null;
  /** 进入房间：把云端那一局装进本地 */
  enter(seat: RoomSeat, snapshot: RoomSnapshot): void;
  /** 以观战身份进入：不占座、不写云端，只看（两个席位都有人的时候用） */
  watch(code: string, snapshot: RoomSnapshot): void;
  /** 退出房间，回到本机对局 */
  leave(): void;
}

export function openOnlinePanel(host: OnlineHost): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';

  const joined = host.room();
  /** 房间已加载的快照；null 表示还在拉 */
  let snapshot: RoomSnapshot | null = null;
  let error = '';
  let busy = false;
  let closed = false;
  let codeInput = '';
  let timer = 0;

  const close = () => {
    closed = true;
    window.clearInterval(timer);
    mask.remove();
  };

  const seatName = (seat: PlayerId) => (seat === 'A' ? '我方' : '敌方');

  const agoText = (iso: string): string => {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '未知';
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    return `${Math.floor(hour / 24)} 天前`;
  };

  const paint = () => {
    const room = host.room();

    if (!room) {
      mask.innerHTML = `
        <div class="modal modal-narrow">
          <div class="modal-head">
            <h2>联机 / 云存档</h2>
            <p>把这一局存到网上，拿一个房间码。同学用手机输入这六个字符就能接着打。</p>
          </div>
          <div class="modal-body">
            ${
              error
                ? `<div class="online-error">${escapeHtml(error)}</div>`
                : ''
            }
            <section class="field">
              <div class="field-label">把当前这局放到网上</div>
              <div class="field-hint">
                会以你现在执的一方入座，顺便把这局原样传上去。
                之后每一步都在本机走，点「结束回合」才提交给对方。
              </div>
              <button class="btn btn-primary btn-block" data-act="create" ${busy ? 'disabled' : ''}>
                ${busy ? '正在创建…' : '创建房间'}
              </button>
            </section>

            <section class="field">
              <div class="field-label">用代码进入别人的局</div>
              <div class="seed-row">
                <input class="text-input room-input" data-field="code" placeholder="六个字符，例如 K7M2QP"
                  value="${escapeHtml(codeInput)}" maxlength="12" autocapitalize="characters" spellcheck="false" />
                <button class="btn" data-act="join" ${busy ? 'disabled' : ''}>进入</button>
                <button class="btn" data-act="watch" ${busy ? 'disabled' : ''}>只看</button>
              </div>
              <div class="field-hint">
                可以直接把整条邀请链接黏进来，代码会自己认出来。
                「只看」不用抢座位，两个席位都满了也能进去看——给的是全图视角。
              </div>
            </section>

            <section class="field">
              <div class="field-label">须知</div>
              <ul class="online-notes">
                <li>房间码就是钥匙，谁拿到谁能进，也就只能进这一局。</li>
                <li>对方没提交之前，看不到你这个回合的走法——你能存档、能离线、能慢慢想。</li>
                <li>想旁观一局？用「只看」进来，不占座位，用的是全图视角。</li>
                <li>战争迷雾在联机里是<b>界面层面</b>的约定，不是加密：存档整局存在云上，别拿它当防外挂。</li>
              </ul>
            </section>
          </div>
          <div class="modal-foot">
            <button class="btn" data-act="close">关闭</button>
          </div>
        </div>
      `;
      return;
    }

    const isWatcher = room.spectator === true;
    const myTurn = snapshot && !isWatcher ? snapshot.current === room.seat : false;
    const peer = room.seat === 'A' ? 'B' : 'A';
    const peerSeated = snapshot ? snapshot.seats[peer] !== null : false;

    let status = '正在读取房间状态…';
    let statusKind = '';
    if (snapshot) {
      if (isWatcher) {
        status = `观战中 —— 现在轮到 ${snapshot.current === 'A' ? 'A 座' : 'B 座'}（最近一次提交：${agoText(snapshot.updatedAt)}）`;
        statusKind = 'wait';
      } else if (peerSeated) {
        status = myTurn
          ? `轮到你 —— 对方已于 ${agoText(snapshot.updatedAt)}提交`
          : `等对方行动（他上次提交：${agoText(snapshot.updatedAt)}）`;
        statusKind = myTurn ? 'go' : 'wait';
      } else {
        status = '对方还没进来。把房间码发给他，他一进来就会接上。';
        statusKind = 'wait';
      }
    } else if (error) {
      status = error;
      statusKind = 'bad';
    }

    mask.innerHTML = `
      <div class="modal modal-narrow">
        <div class="modal-head">
          <h2>房间 ${room.code}</h2>
          <p>${isWatcher ? '你是观战者：不占座位，看的是全图。' : `你执 ${seatName(room.seat)}。`}</p>
        </div>
        <div class="modal-body">
          <div class="room-code">${room.code}</div>
          <div class="room-actions">
            <button class="btn btn-primary" data-act="copy-code">复制代码</button>
            <button class="btn" data-act="copy-link">复制邀请链接</button>
          </div>

          <div class="room-status ${statusKind}">${escapeHtml(status)}</div>

          <section class="field">
            <div class="field-label">席位</div>
            <div class="room-seats">
              <span class="seat-chip ${room.seat === 'A' && !isWatcher ? 'mine' : ''}">A 我方${room.seat === 'A' && !isWatcher ? '（你）' : ''}</span>
              <span class="seat-chip ${room.seat === 'B' && !isWatcher ? 'mine' : ''}">B 敌方${room.seat === 'B' && !isWatcher ? '（你）' : ''}</span>
              ${isWatcher ? '<span class="seat-chip mine">观战（你）</span>' : ''}
            </div>
            <div class="field-hint">
              ${snapshot ? (peerSeated ? '两边都坐好了。' : '对面那个席位还空着。') : ''}
              ${isWatcher ? '观战位不占座，多几个人同时看也不会互相挤掉。' : '换设备时，重新打开邀请链接就能回到你自己的席位。'}
            </div>
          </section>

          <section class="field">
            <div class="field-label">怎么走</div>
            <ul class="online-notes">
              <li>在本机把这一回合走完，点「结束回合」＝提交，对面下次打开就能看到。</li>
              <li>提交之前关掉页面也没关系，草稿存在这台设备的浏览器里。</li>
              <li>不想接着打了可以退出房间，本机原来的对局还在。</li>
            </ul>
          </section>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="refresh">刷新状态</button>
          <button class="btn" data-act="close">${isWatcher ? '去看棋盘' : '回到棋盘'}</button>
          <button class="btn btn-danger" data-act="leave">${isWatcher ? '退出观战' : '退出房间'}</button>
        </div>
      </div>
    `;
  };

  const refresh = async () => {
    const room = host.room();
    if (!room) return;
    try {
      snapshot = await fetchRoom(room.code);
      error = snapshot ? '' : '云端找不到这个房间了';
    } catch (err) {
      error = err instanceof Error ? err.message : '读取失败';
    }
    if (!closed) paint();
  };

  const doCreate = async () => {
    busy = true;
    error = '';
    paint();
    const state = host.currentState();
    try {
      const token = newToken();
      const seat = await createRoom(state, state.current, token);
      host.enter(seat, {
        code: seat.code,
        state,
        turn: state.turn,
        current: state.current,
        updatedAt: new Date().toISOString(),
        seats: { A: seat.seat === 'A' ? token : null, B: seat.seat === 'B' ? token : null },
      });
    } catch (err) {
      error = err instanceof Error ? err.message : '创建失败';
    }
    busy = false;
    if (!closed) {
      paint();
      void refresh();
    }
  };

  const doJoin = async () => {
    const code = normalizeCode(codeInput);
    if (code.length < 4) {
      error = '房间码太短了，再确认一下';
      paint();
      return;
    }

    busy = true;
    error = '';
    paint();
    try {
      const snapshotNow = await fetchRoom(code);
      if (!snapshotNow) {
        error = `没有找到代码为 ${code} 的房间`;
      } else {
        // 优先回到自己原来的席位（靠本机存的令牌），否则坐空位。
        // 观战记录不能拿来抢座：那条记录里的 seat 是占位用的 'A'，不是真的坐过 A。
        const saved = loadSeat(code);
        const mine = saved && !saved.spectator ? saved : null;
        const token = saved?.token ?? newToken();
        const order: PlayerId[] = mine ? [mine.seat] : ['A', 'B'];
        let seated: PlayerId | null = null;
        for (const seat of order) {
          if ((await claimSeat(code, seat, token)) === 'ok') {
            seated = seat;
            break;
          }
        }
        if (!seated) {
          // 两个座位都满了——别再拦人，直接转观战
          host.watch(code, snapshotNow);
          close();
          return;
        }
        host.enter({ code, seat: seated, token }, snapshotNow);
        close();
        return;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : '进入失败';
    }
    busy = false;
    if (!closed) paint();
  };

  /** 只看：不抢座，任何房间只要存在就能进去看 */
  const doWatch = async () => {
    const code = normalizeCode(codeInput);
    if (code.length < 4) {
      error = '房间码太短了，再确认一下';
      paint();
      return;
    }
    busy = true;
    error = '';
    paint();
    try {
      const snapshotNow = await fetchRoom(code);
      if (!snapshotNow) {
        error = `没有找到代码为 ${code} 的房间`;
      } else {
        host.watch(code, snapshotNow);
        close();
        return;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : '进入失败';
    }
    busy = false;
    if (!closed) paint();
  };

  mask.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === mask) {
      close();
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;

    if (act === 'close') close();
    if (act === 'create') void doCreate();
    if (act === 'join') void doJoin();
    if (act === 'watch') void doWatch();
    if (act === 'refresh') void refresh();
    if (act === 'leave') {
      host.leave();
      close();
      return;
    }
    if (act === 'copy-code' || act === 'copy-link') {
      const room = host.room();
      if (!room) return;
      // 邀请链接必须在当前地址上加参数，不能拼一个干净的 origin+path：
      // 分享出来的站点是靠 ?sharecode=… 才放行的，把它丢了对方会直接 403。
      const url = new URL(location.href);
      url.searchParams.set('room', room.code);
      const text = act === 'copy-code' ? room.code : url.toString();
      void navigator.clipboard?.writeText(text);
      const btn = target.closest<HTMLElement>('[data-act]');
      if (btn) btn.textContent = '已复制';
    }
  });
  mask.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.field === 'code') codeInput = input.value.toUpperCase();
  });

  paint();
  document.body.appendChild(mask);

  if (joined) {
    void refresh();
    // 面板开着的时候让状态自己跟上：对方提交了要能看见
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 8000);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

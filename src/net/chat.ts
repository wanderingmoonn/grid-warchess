/**
 * 房间聊天。
 *
 * 为什么单开一张表，而不是塞进 `warchess_rooms.state`：
 *
 *   · 房间那一行是**整局快照**，提交时整块覆盖（`submitTurn`）。聊天如果住在
 *     state 里，就只能跟着"结束回合"一起发出去——两个人正打着的时候说不了话，
 *     而观战位根本不提交，等于永远发不出声。
 *   · 也不能"只改 state 里的 chat 字段"：那需要先读整行再整块写回，中途对方
 *     提交的那一回合会被这次写回抹掉（`submitTurn` 用 `.eq('turn')` 防的就是这个）。
 *
 * 一条消息＝一次 insert，天然不会互相覆盖；读是"按 id 增量取"，
 * 谁发谁收都走同一条路——玩家和观战者没有任何区别，这正是这一层要的。
 *
 * 边界（必须写明）：
 *   · 房间码就是钥匙。任何拿到 6 位码的人都能读这个房间的聊天、也能发；
 *     这里没有身份校验，也没有私聊。别在聊天里放真名和联系方式。
 *   · 消息只能发、不能改也不能删（表上只给了 select / insert）。
 *   · 表没建的时候整块不可用，界面要明说"需要先在云端执行 sql/warchess_chat.sql"，
 *     而不是含糊成"网络不通"。
 */

import { cloudDatabase } from './room.ts';

export const CHAT_TABLE = 'warchess_chat';

/** 一条消息最多这么多个字。超过就截断——聊天框不是记事本 */
export const CHAT_MAX_LEN = 120;

/** 一次拉多少条 */
const PAGE = 50;

export type ChatSeat = 'A' | 'B' | 'watch';

export interface ChatLine {
  id: number;
  seat: ChatSeat;
  /** 发言者名字（玩家名，或者"观众"） */
  name: string;
  body: string;
  /** ISO 时间串 */
  at: string;
}

/* ---------- 纯函数：能单独测的那部分 ---------- */

/**
 * 把输入收拾成能发出去的样子。
 *
 * 做四件事：去掉首尾空白、把连续空行压成一个空格（聊天里换行会把面板撑开）、
 * 去掉不可见控制字符、按 `CHAT_MAX_LEN` 截断。
 * 返回空串＝这条不该发（全空格、只敲了回车）。
 */
export function trimChatBody(raw: string): string {
  const flat = raw
    // 控制字符（含 \u0000-\u001f）：粘贴进来的富文本里常有
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.slice(0, CHAT_MAX_LEN);
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => {
    switch (c) {
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

/** 这一条是谁说的：站在"我"的角度写，别用 A/B——屏幕两边都写着同样的名字 */
export function chatWhoLabel(seat: ChatSeat, mine: ChatSeat): string {
  if (seat === 'watch') return '观众';
  return seat === mine ? '我方' : '对方';
}

/** 时间只留时分：聊天里没人关心日期，而队列本来就在同一局里 */
export function chatTimeLabel(at: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(at);
  return m ? `${m[1]}:${m[2]}` : '';
}

/**
 * 聊天记录的那一屏。
 *
 * 抽成纯函数是为了能测：这段 HTML 里有三件容易出错的事——转义（消息是用户输入）、
 * 归属标签（观众 / 我方 / 对方）、空态（一条都没有时说什么）。
 */
export function chatLinesHtml(lines: readonly ChatLine[], mine: ChatSeat): string {
  if (lines.length === 0) {
    return '<div class="chat-empty">还没有人说话。对面在等你想好这一回合怎么打。</div>';
  }
  return lines
    .map((l) => {
      const cls = l.seat === 'watch' ? 'watch' : l.seat === mine ? 'mine' : 'foe';
      const time = chatTimeLabel(l.at);
      return `<div class="chat-line ${cls}">
        <span class="chat-meta">${escapeHtml(l.name)} · ${chatWhoLabel(l.seat, mine)}${
          time ? ` · ${time}` : ''
        }</span>
        <span class="chat-body">${escapeHtml(l.body)}</span>
      </div>`;
    })
    .join('');
}

/* ---------- 云端读写 ---------- */

interface DbError {
  code?: string;
  message?: string;
  error?: string;
  error_description?: string;
}

export interface ChatResult {
  ok: boolean;
  /** 失败原因，直接显示给人看 */
  reason?: string;
  /** 失败之后能做什么 */
  howTo?: string;
  /** 这一次真的写进去的那一行（成功时） */
  line?: ChatLine;
}

/**
 * 把云端错误翻成人话。
 *
 * 和 `reports.ts` 是同一套判据（同一朵云、同一类事故），但**文案分开写**：
 * 报告是"传不传得上去"，聊天是"还能不能说话"，后者更需要一句"怎么办"。
 */
function classify(err: DbError | undefined | null): ChatResult {
  const code = (err?.code ?? '').replace(/^DATABASE_/, '');
  const msg = (err?.message ?? '').toLowerCase();
  if (err?.error === 'invalid_client' || err?.error_description?.includes('client credential')) {
    return { ok: false, reason: '云端不认这个应用的密钥', howTo: '重新发布后要回来更新 cloud-config.ts。' };
  }
  if (code === '42P01' || /relation .*does not exist|undefined table|schema cache/.test(msg)) {
    return {
      ok: false,
      reason: '聊天还没开通（云数据库里没有 warchess_chat 这张表）',
      howTo: '在云数据库里执行一次 sql/warchess_chat.sql 就能用了；不建表也不影响下棋。',
    };
  }
  if (code === '42501' || /permission denied|not authorized/.test(msg)) {
    return { ok: false, reason: '云端拒绝了这次读写（权限策略问题）', howTo: '核对 sql/warchess_chat.sql 里的 grant / policy 有没有执行全。' };
  }
  if (err?.message) return { ok: false, reason: `聊天没发出去：${err.message}` };
  return { ok: false, reason: '聊天没发出去，网络可能不通' };
}

interface Tableish {
  select(cols?: string): Tableish;
  insert(row: Record<string, unknown>): Tableish;
  eq(col: string, value: unknown): Tableish;
  gt(col: string, value: unknown): Tableish;
  order(col: string, opts?: { ascending?: boolean }): Tableish;
  limit(n: number): Tableish;
  single(): Promise<{ data: unknown; error: DbError | null }>;
  then: PromiseLike<{ data: unknown; error: DbError | null }>['then'];
}

function table(): Tableish {
  const db = cloudDatabase() as unknown as { from(name: string): Tableish };
  return db.from(CHAT_TABLE);
}

interface Row {
  id: number;
  seat: string;
  name: string;
  body: string;
  created_at: string;
}

function toLine(row: Row): ChatLine {
  const seat: ChatSeat = row.seat === 'B' ? 'B' : row.seat === 'watch' ? 'watch' : 'A';
  return { id: Number(row.id), seat, name: row.name, body: row.body, at: row.created_at };
}

/** 取 `afterId` 之后的消息（增量）。失败时不抛，返回空数组 + 原因由界面决定怎么处理 */
export async function fetchChat(
  code: string,
  afterId: number,
): Promise<{ ok: boolean; lines: ChatLine[]; reason?: string }> {
  try {
    // 老房间可能一条消息都没有：`gt(id, 0)` 就把全表按房间筛一遍，加上 limit 没有性能问题
    const res = await table()
      .select('*')
      .eq('room', code)
      .gt('id', afterId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (res.error) {
      const c = classify(res.error);
      return { ok: false, lines: [], reason: c.reason };
    }
    const rows = Array.isArray(res.data) ? (res.data as Row[]) : [];
    return { ok: true, lines: rows.map(toLine) };
  } catch (err) {
    const c = classify(err as DbError);
    return { ok: false, lines: [], reason: c.reason };
  }
}

/**
 * 发一条。
 *
 * `seat` 只用于显示（我方 / 对方 / 观众），不是身份证明——这一层没有鉴权，
 * 前端报什么就存什么。要做真正的防冒名，得把说话人绑到席位令牌上并在服务端校验，
 * 那是"联机要防作弊"那条路上的事，见 room.ts 顶部的边界说明。
 */
export async function sendChat(
  code: string,
  seat: ChatSeat,
  name: string,
  raw: string,
): Promise<ChatResult> {
  const body = trimChatBody(raw);
  if (!body) return { ok: false, reason: '说点什么再发' };
  try {
    const res = await table()
      .insert({ room: code, seat, name: name.slice(0, 24), body })
      .select()
      .single();
    if (res.error) return classify(res.error);
    const row = res.data as Row | null;
    if (!row) return { ok: true }; // 有些策略不让 returning，写没写进去只能靠下一轮增量取回来看
    return { ok: true, line: toLine(row) };
  } catch (err) {
    const e = err as DbError;
    // 退一步：极少数环境 insert().select().single() 会因为 returning 被策略挡，
    // 但行其实写进去了。这里不把它当成失败——让下一轮 fetch 把它捞回来。
    if (/returning|single row/i.test(e?.message ?? '')) return { ok: true };
    return classify(e);
  }
}

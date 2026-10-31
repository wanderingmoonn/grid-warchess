/**
 * 房间里"现在有几个人在看"。
 *
 * 这是**唯一**一件需要"别人此刻在不在"的功能。它和房间快照是两种数据：
 *   · 快照（warchess_rooms）是整局状态，提交时整块覆盖，用 turn 做乐观锁；
 *   · 在线状态（warchess_presence）是"谁还开着这间房"，只增只覆盖自己那一行。
 *
 * 为什么不塞进房间行里：观战者每次心跳都写同一行，就会和"提交回合"抢同一份数据——
 * 要么把一次提交挤掉，要么自己被覆盖。分开一张表，两边各写各的，谁也不会踩谁。
 *
 * 为什么是心跳而不是"进来 +1、走了 -1"：浏览器可以直接被杀掉、标签页可以
 * 永远停在后台，那个"走了"的事件根本不会发出。所以只记录"最后见到你是什么时候"，
 * 超过 TTL 没动静就算你走了——这也是所有在线状态的实际做法。
 *
 * 边界（和聊天同一套）：房间码就是钥匙，没有账号校验；
 * 表里只有随机 client_id、角色、昵称和时间戳。
 */

import { clientId } from './client-id.ts';
import { cloudDatabase } from './room.ts';

export const PRESENCE_TABLE = 'warchess_presence';

/**
 * 多久没心跳就算"人已经走了"。
 *
 * 心跳间隔是 12 秒，TTL 给 45 秒：容得下两三次丢包或标签页被节流，
 * 又不至于让一个关掉的页面在人数里挂上十分钟。代价是"刚关掉的人"
 * 会多留半分钟——比起"人还在看，人数却掉了"，这个方向的错更不刺眼。
 */
export const PRESENCE_TTL_MS = 45_000;

/** 心跳间隔：房间轮询是 15 秒，这个比它略快一点，免得人数总是比场面慢一拍 */
export const PRESENCE_BEAT_MS = 12_000;

export type PresenceRole = 'watch' | 'seat';

export interface PresenceRow {
  clientId: string;
  role: PresenceRole;
  name: string;
  /** 最后一次心跳的时刻（毫秒时间戳） */
  seenAt: number;
}

/* ---------- 纯函数：能单独测的那部分 ---------- */

/** 数据库行 → 我们自己的形状。时间统一换成毫秒数，后面的判断就不用再解析字符串 */
export function presenceFromRow(raw: {
  client_id?: unknown;
  role?: unknown;
  name?: unknown;
  seen_at?: unknown;
}): PresenceRow | null {
  const id = typeof raw.client_id === 'string' ? raw.client_id : '';
  if (!id) return null;
  const role: PresenceRole = raw.role === 'seat' ? 'seat' : 'watch';
  const seenAt = Date.parse(String(raw.seen_at ?? ''));
  return {
    clientId: id,
    role,
    name: typeof raw.name === 'string' ? raw.name : '',
    seenAt: Number.isFinite(seenAt) ? seenAt : 0,
  };
}

/**
 * 数一数"还活着"的观战者。
 *
 * 只算 `watch`：参赛者本来就在棋盘上，把他算进"观战人数"会让 1v1 永远显示 2 人。
 * 未来的时间戳（本机时钟慢于服务器）按"刚说话"处理，不算过期——
 * 时钟差不是玩家的错，宁可多算一个也不要让人数凭空消失。
 */
export function countWatchers(
  rows: readonly PresenceRow[],
  now: number,
  ttl = PRESENCE_TTL_MS,
): number {
  let n = 0;
  for (const r of rows) {
    if (r.role !== 'watch') continue;
    if (r.seenAt > now) {
      n += 1;
      continue;
    }
    if (now - r.seenAt <= ttl) n += 1;
  }
  return n;
}

/**
 * 顶栏上那句话。0 人的时候返回空串：没人看的时候不需要专门说一句"没人看"。
 *
 * 观战者自己也看得见这个数字（含他自己）——"还有谁在看"这件事本来就该一致，
 * 给自己单独减一是另一种说法，只会让两边对不上号。
 */
export function watchLabel(n: number): string {
  if (n <= 0) return '';
  return `观战 ${n} 人`;
}

/* ---------- 云端读写 ---------- */

interface DbError {
  code?: string;
  message?: string;
  error?: string;
  error_description?: string;
}

interface Tableish {
  select(cols?: string): Tableish;
  insert(row: Record<string, unknown>): Tableish;
  update(row: Record<string, unknown>): Tableish;
  eq(col: string, value: unknown): Tableish;
  limit(n: number): Tableish;
  then: PromiseLike<{ data: unknown; error: DbError | null }>['then'];
}

async function table(): Promise<{ q: Tableish }> {
  const db = (await cloudDatabase()) as unknown as { from(name: string): Tableish };
  return { q: db.from(PRESENCE_TABLE) };
}

/** 表没建时不要说"网络不通"：这是一句能照着做的话 */
export function presenceError(err: DbError | null | undefined): string {
  const code = (err?.code ?? '').replace(/^DATABASE_/, '');
  const msg = (err?.message ?? '').toLowerCase();
  if (code === '42P01' || /relation .*does not exist|undefined table|schema cache/.test(msg)) {
    return '观战人数没开通（云数据库里没有 warchess_presence 表），执行一次 sql/warchess_presence.sql 就有了';
  }
  if (code === '42501' || /permission denied|not authorized/.test(msg)) {
    return '云端拒绝了观战名单的读写（权限策略问题），核对 sql/warchess_presence.sql 执行全了没有';
  }
  return '观战人数暂时读不到（网络不通）';
}

/**
 * 打一次心跳。失败不抛：这只是界面上的一个数字，不该让对局停下来。
 *
 * 先 update 再 insert（而不是 upsert）：SDK 这一层没有暴露 on conflict，
 * 而"更不更得到"这件事可以从 returning 的数组长度看出来。两个人同时首次心跳
 * 撞上主键时，后到的那次 insert 会失败——下一次心跳就走到 update 分支了，
 * 结果只是"晚 12 秒出现在名单里"。
 */
export async function heartbeat(
  code: string,
  role: PresenceRole,
  name: string,
): Promise<void> {
  try {
    const id = clientId();
    const seen = new Date().toISOString();
    const upd = await (await table()).q
      .update({ role, name, seen_at: seen })
      .eq('room', code)
      .eq('client_id', id)
      .select();
    if (upd.error) throw upd.error;
    if (Array.isArray(upd.data) && upd.data.length > 0) return;
    await (await table()).q.insert({ room: code, client_id: id, role, name }).select();
  } catch {
    // 心跳失败不影响任何规则：下一轮再试
  }
}

/** 拉这个房间的在线名单。失败返回空数组 + 一句能显示的原因 */
export async function fetchPresence(
  code: string,
): Promise<{ ok: boolean; rows: PresenceRow[]; reason?: string }> {
  try {
    const res = await (await table()).q
      .select('room,client_id,role,name,seen_at')
      .eq('room', code)
      .limit(200);
    if (res.error) return { ok: false, rows: [], reason: presenceError(res.error) };
    const raw = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    const rows: PresenceRow[] = [];
    for (const one of raw) {
      const row = presenceFromRow(one);
      if (row) rows.push(row);
    }
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], reason: presenceError(err as DbError) };
  }
}

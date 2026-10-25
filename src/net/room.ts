/**
 * 联机房间（云端存档）。
 *
 * 这一层只做一件事：把一局完整的 GameState 存到云数据库里，用一个 6 位房间码找回来。
 *
 * 为什么不是"实时同步"：这个游戏的线下玩法本来就是"各走一段再交接"，
 * 一回合半小时。所以这里刻意不做增量同步、不做每一步推送，
 * 只在**结束回合（提交）或分出胜负**时把整局状态写上去。
 * 好处有两个：
 *   1. 对方看不到你这个回合正在怎么摆兵，迷雾的观感才成立；
 *   2. 断网、关页面后还能继续本机草稿；换设备只能读到云端已提交的回合。
 *
 * 边界（必须诚实说明）：state 是一整块存进去的，服务端不参与规则计算，
 * 所以迷雾只是"界面不给你看"，不是安全边界。真要防作弊得把 playerView
 * 挪到服务端去算，那是下一步的事。
 */

import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';

import type { GameState } from '../core/types.ts';
import { normalizeState } from '../storage/migrate.ts';
import { CLOUD_CONFIG } from './cloud-config.ts';
import { isRoomSeat, readRoomSnapshot, sameSubmittedState, submissionPlayer } from './protocol.ts';
import type { RoomSeat, RoomSnapshot, Seat } from './protocol.ts';
export type { RoomSeat, RoomSnapshot, Seat } from './protocol.ts';

const TABLE = 'warchess_rooms';
/** 去掉了 I/O/0/1，念给对面听不会听错 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let client: ReturnType<typeof createWorkBuddyCloud> | null = null;

function db() {
  client ??= createWorkBuddyCloud({
    endpoint: CLOUD_CONFIG.endpoint,
    oauthRelayBaseUrl: CLOUD_CONFIG.oauthRelayBaseUrl,
    publishableKey: CLOUD_CONFIG.publishableKey,
  });
  return client.database;
}

/**
 * 表操作入口。
 *
 * SDK 的 schema 泛型要靠代码生成才有，我们没生成，所以默认会把行类型推成 never。
 * 这里只收窄到本项目实际用到的几个方法，返回数据交给 protocol 校验 ——
 * 比到处 `as any` 干净，也比手写 fetch 安全（凭证注入、会话都还在 SDK 里）。
 */
interface Queryish {
  select(cols?: string): Queryish;
  insert(row: Record<string, unknown>): Queryish;
  update(row: Record<string, unknown>): Queryish;
  eq(col: string, value: unknown): Queryish;
  is(col: string, value: unknown): Queryish;
  maybeSingle(): Promise<{ data: unknown; error: DbError | null }>;
  then: PromiseLike<{ data: unknown; error: DbError | null }>['then'];
}

interface DbError {
  code?: string;
  message?: string;
}

function table(): Queryish {
  return (db() as unknown as { from(name: string): Queryish }).from(TABLE);
}

export function newCode(len = 6): string {
  const bytes = new Uint8Array(len);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return out;
}

export function newToken(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 用户可能带着空格、小写、甚至整条链接黏进来，这里统一收拾干净 */
export function normalizeCode(raw: string): string {
  const fromUrl = raw.match(/[?&]room=([A-Z0-9]+)/i);
  const text = fromUrl?.[1] ?? raw;
  return text.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
}

/** 桌面上早就有一局了，把它变成房间：坐在"当前该行动的那一方" */
export async function createRoom(state: GameState, seat: Seat, token: string): Promise<RoomSeat> {
  const normalized = normalizeState(state);
  if (!normalized || !isRoomSeat({ code: 'pending', seat, token })) throw new Error('无法创建无效的房间');
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = newCode();
    const { data, error } = await table()
      .insert({
        code,
        state: normalized,
        turn: state.turn,
        current: state.current,
        seat_a: seat === 'A' ? token : null,
        seat_b: seat === 'B' ? token : null,
      })
      // 让 PostgREST 回报实际写入的行：没有 .select() 就分不清"写成功"和"被策略挡了"
      .select();

    if (!error) {
      if (!Array.isArray(data) || data.length === 0) throw new Error('云端没有确认房间创建成功，请重试');
      return { code, seat, token };
    }
    // 主键冲突就是代码撞车了，换一个再来
    if (error.code === '23505') {
      lastError = error;
      continue;
    }
    throw new Error(readableError(error));
  }

  throw new Error(readableError(lastError) || '连续撞了几次代码，再试一次');
}

export async function fetchRoom(code: string): Promise<RoomSnapshot | null> {
  const { data, error } = await table().select('*').eq('code', code).maybeSingle();
  if (error) throw new Error(readableError(error));
  if (!data) return null;
  const snapshot = readRoomSnapshot(data);
  if (snapshot.code !== code) throw new Error('云端返回了不同的房间，请重试');
  return snapshot;
}

/**
 * 占一个空席位。
 *
 * 三种结果：
 *   ok      —— 成功坐下（或者本来就是我）
 *   taken   —— 被另一个人坐了
 *   missing —— 没有这个房间
 */
export async function claimSeat(
  code: string,
  seat: Seat,
  token: string,
): Promise<'ok' | 'taken' | 'missing'> {
  if (!isRoomSeat({ code, seat, token })) throw new Error('席位信息无效');
  const snapshot = await fetchRoom(code);
  if (!snapshot) return 'missing';

  const current = snapshot.seats[seat];
  if (current === token) return 'ok';
  if (current) return 'taken';

  const column = seat === 'A' ? 'seat_a' : 'seat_b';
  // 加 is(column, null) 是为了原子性：两个人同时抢占时只有一个人能写进去
  const { data, error } = await table()
    .update({ [column]: token })
    .eq('code', code)
    .is(column, null)
    .select();
  if (error) throw new Error(readableError(error));
  return Array.isArray(data) && data.length > 0 ? 'ok' : 'taken';
}

/**
 * 提交这一回合。
 *
 * expectedTurn 是提交前本机看到的回合数：如果云端已经是别的回合，
 * 说明对面也提交过（两边同时走），这次写入会被 `.eq('turn', …)` 挡掉，
 * 返回 false，让 UI 提醒"冲突了，先同步"而不是直接覆盖掉对方的棋。
 */
export async function submitTurn(
  code: string,
  state: GameState,
  expectedTurn: number,
): Promise<boolean> {
  const normalized = normalizeState(state);
  if (!normalized) throw new Error('无法提交无效的对局状态');
  const expectedPlayer = submissionPlayer(normalized, expectedTurn);
  const { data, error } = await table()
    .update({
      state: normalized,
      turn: state.turn,
      current: state.current,
      updated_at: new Date().toISOString(),
    })
    .eq('code', code)
    .eq('turn', expectedTurn)
    .eq('current', expectedPlayer)
    .select();
  if (error) throw new Error(readableError(error));
  if (Array.isArray(data) && data.length > 0) return true;
  // The previous attempt may have committed but lost its network response.
  const snapshot = await fetchRoom(code);
  return snapshot !== null && sameSubmittedState(snapshot.state, normalized);
}

/* ---------- 本机的席位记忆 ---------- */

/**
 * 我在这局坐哪一桌，存在本机。
 * 换设备时没有这条记录，就只能凭"哪个席位是空的"入座——
 * 所以邀请链接要一直留着，它比房间码多带了你的身份。
 */
export function seatStorageKey(code: string): string {
  return `warchess:seat:${code}`;
}

export function loadSeat(code: string): RoomSeat | null {
  try {
    const raw = localStorage.getItem(seatStorageKey(code));
    if (!raw) return null;
    const seat: unknown = JSON.parse(raw);
    return isRoomSeat(seat) && seat.code === code ? seat : null;
  } catch {
    return null;
  }
}

export function saveSeat(seat: RoomSeat): void {
  try {
    if (!isRoomSeat(seat)) return;
    localStorage.setItem(seatStorageKey(seat.code), JSON.stringify(seat));
  } catch {
    // 隐私模式下写不进去，不影响这局本身
  }
}

function readableError(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  if (!err) return '';
  if (e?.code === '42P01') return '云端还没有房间表，需要先初始化数据库';
  if (e?.code === '42501') return '云端拒绝了这次读写（权限策略问题）';
  if (e?.code === '23505') return '房间码撞车了';
  if (e?.message) return e.message;
  return '网络不通，稍后再试';
}

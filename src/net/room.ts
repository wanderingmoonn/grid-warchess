/**
 * 联机房间（云端存档）。
 *
 * 这一层只做一件事：把一局完整的 GameState 存到云数据库里，用一个 6 位房间码找回来。
 *
 * 为什么不是"实时同步"：这个游戏的线下玩法本来就是"各走一段再交接"，
 * 一回合半小时。所以这里刻意不做增量同步、不做每一步推送，
 * 只在**结束回合（提交）**时把整局状态写上去。
 * 好处有两个：
 *   1. 对方看不到你这个回合正在怎么摆兵，迷雾的观感才成立；
 *   2. 断网、关页面、换设备都不会把这一回合弄坏——草稿在你本机。
 *
 * 边界（必须诚实说明）：state 是一整块存进去的，服务端不参与规则计算，
 * 所以迷雾只是"界面不给你看"，不是安全边界。真要防作弊得把 playerView
 * 挪到服务端去算，那是下一步的事。
 */

/**
 * 云 SDK 只取类型，**运行时不在这里引入**。
 *
 * 这个 SDK 有 70KB（minify 后，占主包 14%），而它只服务"联机房间"和
 * "云端战报"两件事——首屏（开局面板 → 进对局 → 打一局本地对战）里
 * 一行都不碰它。写在这里的 `import` 会被整段算进主包，所以真正的引入
 * 挪到 `cloudDatabase()` 里做动态 import：用到的那一刻才去取。
 */
import type { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';

import type { GameState, PlayerId } from '../core/types.ts';
import { CLOUD_CONFIG } from './cloud-config.ts';

export type Seat = PlayerId;

/** 一次拉取拿到的房间快照 */
export interface RoomSnapshot {
  code: string;
  state: GameState;
  /** 冗余出来的两个字段，用来判断"是否轮到我"而不用解析整局 */
  turn: number;
  current: PlayerId;
  /** 最后一次提交时间（ISO 字符串） */
  updatedAt: string;
  seats: Record<Seat, string | null>;
}

/** 我在这局房间里坐哪一桌 */
export interface RoomSeat {
  code: string;
  seat: Seat;
  /** 席位令牌：换设备时凭它证明"这还是我" */
  token: string;
  /**
   * 观战席位：不占座、不写云端，只看。
   *
   * 刻意**不在数据库里加一列**。加列意味着要给已经在跑的房间做迁移，
   * 而且观战这件事本来就不需要互斥——两个朋友同时看同一局完全正常，
   * 抢座位反而会互相挤掉。所以观战只是本机的一个视角标记：
   * 进房间时不 claimSeat、提交时被 myTurn 挡住、渲染时给全图。
   *
   * 代价要写清楚：观战看到的是**全图**，能看见对方的伏兵和金币。
   * 适合看完局和复盘，不适合在两个人还在打的时候开着麦。
   */
  spectator?: boolean;
}

const TABLE = 'warchess_rooms';
/** 去掉了 I/O/0/1，念给对面听不会听错 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let client: ReturnType<typeof createWorkBuddyCloud> | null = null;

/**
 * 云数据库句柄（联机房间和「对局报告」共用）。
 *
 * 一个客户端就够：凭据本来就是同一个应用的，多建一个只会多一份会话状态，
 * 真出问题时还更难判断是哪一份在过期。
 *
 * **异步**是因为 SDK 是动态引入的（见文件顶上那段说明）：第一次调用会多花
 * 一次拉 chunk 的时间（本地缓存后为 0），之后都走同一个 client。
 * 所有调用方本来就都在 async 函数里（发消息、拉房间、传战报），改这一处不影响别的。
 */
export async function cloudDatabase(): Promise<ReturnType<typeof createWorkBuddyCloud>['database']> {
  if (!client) {
    const { createWorkBuddyCloud: create } = await import('@tencent-ai/workbuddy-cloud-sdk');
    client = create({
      endpoint: CLOUD_CONFIG.endpoint,
      oauthRelayBaseUrl: CLOUD_CONFIG.oauthRelayBaseUrl,
      publishableKey: CLOUD_CONFIG.publishableKey,
    });
  }
  return client.database;
}

/**
 * 表操作入口。
 *
 * SDK 的 schema 泛型要靠代码生成才有，我们没生成，所以默认会把行类型推成 never。
 * 这里只收窄到本项目实际用到的几个方法，返回再显式断言成 Row ——
 * 比到处 `as any` 干净，也比手写 fetch 安全（凭证注入、会话都还在 SDK 里）。
 */
interface Queryish {
  select(cols?: string): Queryish;
  insert(row: Record<string, unknown>): Queryish;
  update(row: Record<string, unknown>): Queryish;
  eq(col: string, value: unknown): Queryish;
  is(col: string, value: unknown): Queryish;
  maybeSingle(): Promise<{ data: unknown; error: DbError }>;
  then: PromiseLike<{ data: unknown; error: DbError }>['then'];
}

interface DbError {
  code?: string;
  message?: string;
}

/**
 * 表操作入口。
 *
 * 返回的是一个**普通对象** `{ q }`，不是查询本身。原因：SDK 的查询对象是
 * thenable（`await query` 才拿到 `{ data, error }`），而 Promise 的解析过程会
 * 把这个 thenable 直接"吃掉"——`Promise<Queryish>` 实际拿到的永远是查询结果，
 * 于是 `.select()` / `.insert()` 全都不见了。包一层是唯一干净的解。
 */
async function table(): Promise<{ q: Queryish }> {
  const database = (await cloudDatabase()) as unknown as { from(name: string): Queryish };
  return { q: database.from(TABLE) };
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

interface Row {
  code: string;
  state: GameState;
  turn: number;
  current: PlayerId;
  seat_a: string | null;
  seat_b: string | null;
  updated_at: string;
}

function toSnapshot(row: Row): RoomSnapshot {
  return {
    code: row.code,
    state: row.state,
    turn: row.turn,
    current: row.current,
    updatedAt: row.updated_at,
    seats: { A: row.seat_a, B: row.seat_b },
  };
}

/** 桌面上早就有一局了，把它变成房间：坐在"当前该行动的那一方" */
export async function createRoom(state: GameState, seat: Seat, token: string): Promise<RoomSeat> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = newCode();
    const { error } = await (await table()).q
      .insert({
        code,
        state,
        turn: state.turn,
        current: state.current,
        seat_a: seat === 'A' ? token : null,
        seat_b: seat === 'B' ? token : null,
      })
      // 让 PostgREST 回报实际写入的行：没有 .select() 就分不清"写成功"和"被策略挡了"
      .select();

    if (!error) return { code, seat, token };
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
  const { data, error } = await (await table()).q.select('*').eq('code', code).maybeSingle();
  if (error) throw new Error(readableError(error));
  // 服务端是 jsonb 列，SDK 会直接反序列化成对象；个别环境会退回字符串
  const row = data as Row | null;
  if (!row) return null;
  const state = typeof row.state === 'string' ? (JSON.parse(row.state) as GameState) : row.state;
  return toSnapshot({ ...row, state });
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
  const snapshot = await fetchRoom(code);
  if (!snapshot) return 'missing';

  const current = snapshot.seats[seat];
  if (current === token) return 'ok';
  if (current) return 'taken';

  const column = seat === 'A' ? 'seat_a' : 'seat_b';
  // 加 is(column, null) 是为了原子性：两个人同时抢占时只有一个人能写进去
  const { data, error } = await (await table()).q
    .update({ [column]: token })
    .eq('code', code)
    .is(column, null)
    .select();
  if (error) throw new Error(readableError(error));
  if (Array.isArray(data) && data.length === 0) return 'taken';
  return 'ok';
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
  const { data, error } = await (await table()).q
    .update({
      state,
      turn: state.turn,
      current: state.current,
      updated_at: new Date().toISOString(),
    })
    .eq('code', code)
    .eq('turn', expectedTurn)
    .select();
  if (error) throw new Error(readableError(error));
  return Array.isArray(data) && data.length > 0;
}

/**
 * 拉回来的云端快照要不要装进本机。
 *
 * 单独抽成纯函数，是因为这段判断**只在联机里出错、却只能在真实房间复现**：
 * 认输那次事故（2026-10-29）就是"回合没变、行动方没变，于是谁都没去拉云端"，
 * 赢的那一边永远停在旧局面上。这条规则值得有几条能跑的用例盯着，
 * 而不是靠两个人开两个浏览器手点一遍。
 *
 * 顺序就是优先级：
 *   1. 云端说这局已经结束、而本机还不知道 → 装（终局压倒一切，
 *      认输不推进回合、也不换行动方，只按轮次判断会漏掉它）；
 *   2. 观战位：回合/行动方/胜负任一变就装（它没有"轮到我"这回事）；
 *   3. 参赛者：不是我的回合、或者回合没变 → 不装；
 *   4. 本机还有没提交的草稿 → 不装（否则会把人刚摆好的兵清掉）。
 */
export type AdoptDecision =
  | { take: false; why: 'same' | 'not-my-turn' | 'draft' }
  | { take: true; why: 'finished' | 'turn' };

export interface RemoteHead {
  turn: number;
  current: PlayerId;
  winner: PlayerId | null;
}

export function adoptDecision(
  remote: RemoteHead,
  local: RemoteHead,
  seat: { seat: Seat; spectator?: boolean; draft?: boolean },
): AdoptDecision {
  if (remote.winner && !local.winner) return { take: true, why: 'finished' };
  if (seat.spectator) {
    const changed =
      remote.turn !== local.turn ||
      remote.current !== local.current ||
      !!remote.winner !== !!local.winner;
    return changed ? { take: true, why: 'turn' } : { take: false, why: 'same' };
  }
  if (remote.current !== seat.seat) return { take: false, why: 'not-my-turn' };
  if (remote.turn === local.turn) return { take: false, why: 'same' };
  if (seat.draft) return { take: false, why: 'draft' };
  return { take: true, why: 'turn' };
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
    const seat = JSON.parse(raw) as RoomSeat;
    return seat && seat.code === code && typeof seat.token === 'string' ? seat : null;
  } catch {
    return null;
  }
}

export function saveSeat(seat: RoomSeat): void {
  try {
    localStorage.setItem(seatStorageKey(seat.code), JSON.stringify(seat));
  } catch {
    // 隐私模式下写不进去，不影响这局本身
  }
}

function readableError(err: unknown): string {
  const e = err as
    | { code?: string; message?: string; error?: string; error_description?: string }
    | null;
  if (!err) return '';
  // 数据面的"网关级"错误（鉴权/域名）不是 PostgREST 那种 {code,message} 形状，
  // 而是 OAuth 风格的 {error, error_description}。2026-10-27 那次事故里
  // 前端只认 code/message，于是 403 被降级成"网络不通"，把人往网络问题上带。
  if (e?.error === 'invalid_client' || e?.error_description?.includes('client credential')) {
    return '云端不认这个应用的密钥（publishableKey 已失效）。重新发布后要回来更新它';
  }
  if (e?.error === 'access_denied' || e?.error_description?.includes('request origin')) {
    return '云端拒绝了当前域名（Origin 不匹配）。endpoint 必须等于你打开页面的那条发布域名';
  }
  if (e?.error_description) return e.error_description;
  // 错误码可能带 DATABASE_ 前缀，剥掉再认（见 reports.ts 同一处注释）
  const code = (e?.code ?? '').replace(/^DATABASE_/, '');
  if (code === '42P01') return '云端还没有房间表，需要先初始化数据库';
  if (code === '42501') return '云端拒绝了这次读写（权限策略问题）';
  if (code === '23505') return '房间码撞车了';
  if (e?.message) return e.message;
  return '网络不通，稍后再试';
}

/* ---------- 云端自检 ---------- */

/**
 * 自检结果：只回答"联机这条路现在是通的吗，不通断在哪一步"。
 */
export type CloudProbe =
  | { ok: true }
  | { ok: false; kind: 'origin' | 'key' | 'table' | 'network' | 'unknown'; message: string };

/**
 * 直接敲一次数据面，把状态码翻成人话。
 *
 * 为什么要绕开 SDK 单独 probe：SDK 会把 HTTP 层的失败包成一个**既没有 code
 * 也没有 message** 的错误对象——401（密钥作废）、403（域名不匹配）、404（表
 * 不存在）、真断网，四种情况到界面上长得一模一样，只能落到兜底文案
 * "网络不通，稍后再试"。而真凶往往是一行过期的配置，不是网络。
 *
 * 这一发是**只读诊断**：读一行房间表，带的是同一个 publishableKey，
 * 不带额外凭据，不写任何东西。业务读写仍然全部走 SDK（上面几个函数），
 * 这里只负责在出问题时说清楚是哪一环。
 */
export async function probeCloud(): Promise<CloudProbe> {
  const base = CLOUD_CONFIG.endpoint;
  const url = `${base}/.cloud/database/rest/${TABLE}?select=code&limit=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'x-wb-webapp-access-key': CLOUD_CONFIG.publishableKey },
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      kind: 'network',
      message: `连不上云端地址 ${base}（域名打不开，或本地断网）`,
    };
  }

  if (res.ok) return { ok: true };

  const body = await res.text().catch(() => '');
  const detail = body.slice(0, 120);
  if (res.status === 401) {
    return {
      ok: false,
      kind: 'key',
      message: `云端不认这个应用的密钥（HTTP 401）。多半是重新发布后 publishableKey 没跟着更新。${detail}`,
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      kind: 'origin',
      message:
        `云端拒绝了当前域名（HTTP 403）。配置里的 endpoint 是 ${base}，` +
        `而你现在从 ${location.origin} 打开——两者必须完全一致。${detail}`,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      kind: 'table',
      message: `云端找不到房间表 ${TABLE}（HTTP 404），需要先初始化数据库。${detail}`,
    };
  }
  return {
    ok: false,
    kind: 'unknown',
    message: `云端返回 ${res.status}。${detail}`,
  };
}

/**
 * 当前页面域名和配置里的 endpoint 是否对不上。
 *
 * 对不上就是"联机必然失败"，而且报错会伪装成网络问题。所以启动时先看一眼，
 * 在控制台留一条明确的线索——不弹窗打扰，因为本机对局完全用不到云端。
 *
 * 只在**发布域名**上核对：localhost、局域网预览、jsdom 测试里的 origin
 * 本来就该和 endpoint 不同，那些环境下报这一条纯属噪音。
 */
export function originMismatch(): { actual: string; configured: string } | null {
  if (typeof location === 'undefined') return null;
  const actual = location.origin;
  // 只看云托管发出去的域名；本机跑 dev / 预览时不用管
  if (!location.hostname.endsWith('.workbuddy.host')) return null;
  const configured = new URL(CLOUD_CONFIG.endpoint).origin;
  return actual === configured ? null : { actual, configured };
}

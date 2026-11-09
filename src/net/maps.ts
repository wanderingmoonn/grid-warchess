/**
 * 玩家上传的地图：云端地图库。
 *
 * 和 `warchess_reports` 的关系：那张表**只写不读**（谁都能交，没人能顺着它把
 * 别人的东西全拉下来）。地图表相反——它的存在意义就是"给别人用"，所以
 * 读是公开的、写也是公开的，靠的不是权限，而是**校验**：
 * 一份地图必须能通过 `validateFixedMap` 才会被收进列表，也才会被允许建局。
 *
 * 设计上刻意保留的余地：
 *   · 只存"地形 + 城位"，不存任何执行内容（不是脚本、不是 URL）；
 *   · 单条上限 256KB（见 `MAP_MAX_BYTES`），且行内校验先于上传；
 *   · 列表按上传时间倒序，界面上限 60 张——够用，且不让面板变成一个无底洞。
 */

import { MAP_MAX_BYTES, validateFixedMap, type FixedMap } from '../core/fixed-maps.ts';
import { cloudDatabase } from './room.ts';

const TABLE = 'warchess_maps';
const LIST_LIMIT = 60;
const CACHE_KEY = 'warchess.maps.cache.v1';
/**
 * 本机传过的图（含还在排队等审核的）。
 *
 * 为什么单独存一份：待审核的行 `listed=false`，按读策略**作者自己也查不到**
 * （见 sql/warchess_maps.sql 的 `warchess_maps_read … using (listed)`）。
 * 不存这一份的话，作者传完刷新一次，自己画了一小时的图就没了——
 * 而他明明只是想等审核结果。存的是完整地图数据，不依赖云端回读。
 */
const MINE_KEY = 'warchess.maps.mine.v1';

interface DbFailure {
  code?: string;
  message?: string;
}

interface Row {
  id?: number | string;
  name?: string;
  author?: string;
  w?: number;
  h?: number;
  rows?: unknown;
  cities_a?: unknown;
  cities_b?: unknown;
  created_at?: string;
}

export interface MapListResult {
  ok: boolean;
  maps: FixedMap[];
  /** 失败原因（成功时为空）。界面直接显示这一句 */
  reason?: string;
  /** 失败时能不能指望"稍后再试"——配置类错误不行 */
  retryable?: boolean;
}

function failure(err: DbFailure | undefined, what: string): MapListResult {
  const code = (err?.code ?? '').replace(/^DATABASE_/, '');
  const msg = (err?.message ?? '').toLowerCase();
  if (code === '42P01' || /relation .*does not exist|undefined table|schema cache/.test(msg)) {
    return {
      ok: false,
      maps: [],
      retryable: false,
      reason: '地图库还没开通（云数据库里没有 warchess_maps 这张表）',
    };
  }
  if (code === '42501' || /permission denied|not authorized|invalid_client|origin/.test(msg)) {
    return { ok: false, maps: [], retryable: false, reason: '服务端不接受这次读写（凭据或域名对不上）' };
  }
  return { ok: false, maps: [], retryable: true, reason: `${what}失败：${err?.message ?? '网络不通'}` };
}

/** 一行 → 一份地图。坏数据直接丢掉：一张坏图不该让整个列表崩掉 */
function rowToMap(row: Row): FixedMap | null {
  const parsed = validateFixedMap({
    id: row.id !== undefined ? `user:${row.id}` : undefined,
    name: row.name,
    rows: row.rows,
    citiesA: row.cities_a,
    citiesB: row.cities_b,
    author: row.author,
    createdAt: row.created_at,
    source: 'user',
  });
  return parsed.ok ? parsed.map : null;
}

/** 本机缓存：断网 / 表还没开通时，至少还能玩到自己上次拉过的图 */
function readCache(): FixedMap[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.map((m) => validateFixedMap(m)).filter((r) => r.ok).map((r) => r.map);
  } catch {
    return [];
  }
}

function writeCache(maps: FixedMap[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(maps.slice(0, LIST_LIMIT)));
  } catch {
    // 存不下（隐私模式 / 配额满）：这一次能玩就行
  }
}

/** 缓存里最后一批可用地图（同步，界面首帧就能用） */
export function cachedMaps(): FixedMap[] {
  // 本机传过的排在前面：那是作者刚做的图，找它的频率比找别人的高得多
  return [...readMine(), ...readCache()];
}

interface MyUpload {
  map: FixedMap;
  /** true = 还在等审核（服务端看不见），false = 已通过 */
  pending: boolean;
  at: string;
}

function readMine(): FixedMap[] {
  try {
    const raw = localStorage.getItem(MINE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const out: FixedMap[] = [];
    for (const it of list as MyUpload[]) {
      const checked = validateFixedMap(it?.map);
      // pending 不在云端数据里（校验会把它丢掉），所以过完校验再补回去：
      // 画廊要靠它在名字后面写"待审核"
      if (checked.ok) out.push({ ...checked.map, pending: it.pending === true });
    }
    return out;
  } catch {
    return [];
  }
}

/** 把一张自己传的图记在本机（最多 20 张，最新的在前） */
function rememberMine(map: FixedMap, pending: boolean): void {
  try {
    const raw = localStorage.getItem(MINE_KEY);
    const list = Array.isArray(JSON.parse(raw ?? '[]')) ? (JSON.parse(raw ?? '[]') as MyUpload[]) : [];
    const next: MyUpload[] = [{ map, pending, at: new Date().toISOString() }, ...list.filter((it) => it?.map?.name !== map.name)];
    localStorage.setItem(MINE_KEY, JSON.stringify(next.slice(0, 20)));
  } catch {
    // 存不下（隐私模式 / 配额满）：这一次能玩就行
  }
}

/**
 * 把"已经放行了"的本机记录摘掉。
 *
 * 不摘会**同一张图出现两次**：待审核时本机那份的 id 是 `user:<时间戳>`
 * （插入那次服务端回不了行，读策略看不见未放行的行），放行之后从云端拉回来的
 * id 是 `user:<行号>`——两个不同的 id、同一个名字，画廊里就是两张。
 *
 * 认的是"名字 + 尺寸"：本机缓存里只有自己传的图（最多 20 张），
 * 撞名又撞尺寸的概率可以忽略；真撞了也只是少一张本地重复项，不丢数据。
 */
function syncMineWithServer(server: FixedMap[]): void {
  try {
    const raw = localStorage.getItem(MINE_KEY);
    const list = Array.isArray(JSON.parse(raw ?? '[]')) ? (JSON.parse(raw ?? '[]') as MyUpload[]) : [];
    const key = (m: { name?: string; w?: number; h?: number }) => `${m?.name}|${m?.w}|${m?.h}`;
    const live = new Set(server.map(key));
    const kept = list.filter((it) => !(it?.pending && live.has(key(it.map ?? {}))));
    if (kept.length !== list.length) localStorage.setItem(MINE_KEY, JSON.stringify(kept));
  } catch {
    // 存不下 / 读不出：多一张重复项而已，不该让整个列表跟着失败
  }
}

/**
 * 拉取云端地图库。
 *
 * 永远不抛：调用方是开局面板上的一段文字，它需要的是"几张 / 为什么没有"。
 */
export async function listSharedMaps(): Promise<MapListResult> {
  try {
    const db = (await cloudDatabase()) as unknown as {
      from(name: string): {
        select(cols?: string): {
          eq(col: string, value: unknown): PromiseLike<{ data?: unknown; error?: DbFailure }>;
        };
      };
    };
    // 只拉公开列出的。`listed` 这一列留着以后做"隐藏某个图"的余地
    const res = await db.from(TABLE).select('*').eq('listed', true);
    if (res?.error) return failure(res.error, '拉取地图库');
    const rows = Array.isArray(res?.data) ? (res.data as Row[]) : [];
    const maps = rows
      .map(rowToMap)
      .filter((m): m is FixedMap => !!m)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, LIST_LIMIT);
    writeCache(maps);
    // 自己传的那几张如果已经出现在公开列表里，说明审核过了：把本机那份待审核记录摘掉
    syncMineWithServer(maps);
    return { ok: true, maps };
  } catch (err) {
    const cached = readCache();
    if (cached.length > 0) {
      return { ok: false, maps: cached, retryable: true, reason: '云端地图没拉到，先显示上次缓存的那几张' };
    }
    return failure(err as DbFailure, '拉取地图库');
  }
}

export interface MapUploadResult {
  ok: boolean;
  reason?: string;
  /** 失败后玩家能做什么 */
  howTo?: string;
  /** 成功时回填云端 id，界面用它去重 */
  map?: FixedMap;
  /** 写进去了但**还没公开**：等人工审核放行（见表单里的 `listed`） */
  pending?: boolean;
}

export interface UploadOptions {
  /**
   * 进待审核队列。默认 **true**，因为这张表是公开可写的：
   * 不设闸门的话，任何一段脚本都能往"玩家上传地图"里塞任意内容。
   *
   * 闸门靠的是**权限**而不是界面：写入行带 `listed=false`，而读策略是
   * `using (listed)`，所以未放行的图对所有人（含作者）都不可见；
   * 客户端也**没有** update 权限，翻不了这个开关。放行只能在云端控制台做，
   * 见 `sql/warchess_maps_review.sql`。
   */
  pending?: boolean;
}

/**
 * 上传一张地图。
 *
 * 三道门，顺序不能换：
 *   1. **本机校验**（`validateFixedMap`）——省一次往返，也让报错不用等网络；
 *   2. **体积**——超了就别传，服务端也会拒；
 *   3. **写库**——成功之后把返回的行 id 拼成 `user:<id>`，和列表里的同一张图对上。
 */
export async function uploadSharedMap(
  map: FixedMap,
  author?: string,
  opts: UploadOptions = {},
): Promise<MapUploadResult> {
  const pending = opts.pending !== false;
  const parsed = validateFixedMap(map);
  if (!parsed.ok) return { ok: false, reason: parsed.errors[0], howTo: '改完再传一次' };
  const size = JSON.stringify(parsed.map).length;
  if (size > MAP_MAX_BYTES) {
    return {
      ok: false,
      reason: `地图数据太大（${Math.round(size / 1024)}KB，上限 ${MAP_MAX_BYTES / 1024}KB）`,
      howTo: '这张图的地形行数太多，先缩小尺寸',
    };
  }
  try {
    const db = (await cloudDatabase()) as unknown as {
      from(name: string): {
        insert(row: Record<string, unknown>): {
          select(): PromiseLike<{ data?: unknown; error?: DbFailure }>;
        };
      };
    };
    const res = await db
      .from(TABLE)
      .insert({
        name: parsed.map.name,
        author: (author ?? '').slice(0, 24) || null,
        w: parsed.map.w,
        h: parsed.map.h,
        rows: parsed.map.rows,
        cities_a: parsed.map.citiesA,
        cities_b: parsed.map.citiesB,
        // 关键一行：没审核之前不给别人看
        listed: !pending,
        created_at: new Date().toISOString(),
      })
      // 让服务端回报实际写入的行：没有 select 就分不清"写成功"和"被策略挡了"。
      // 待审核的那次这里会**回空**（读策略看不见未列出的行），这是预期的，
      // 所以下面 id 有兜底，不能因为回空就判失败。
      .select();
    if (res?.error) {
      const f = failure(res.error, '上传');
      return { ok: false, reason: f.reason, howTo: f.retryable ? '稍后再试一次' : '需要先开通地图库' };
    }
    const row = Array.isArray(res?.data) ? (res.data[0] as Row | undefined) : undefined;
    const id = row?.id !== undefined ? `user:${row.id}` : `user:${Date.now()}`;
    const got: FixedMap = { ...parsed.map, id, source: 'user', author: author ?? undefined };
    // 待审核的图服务端读不回来，只能靠本机这份保住"我刚画的那张"
    rememberMine(got, pending);
    return { ok: true, map: got, pending };
  } catch (err) {
    const f = failure(err as DbFailure, '上传');
    return { ok: false, reason: f.reason, howTo: f.retryable ? '稍后再试一次' : '需要先开通地图库' };
  }
}

export const MAP_TABLE = TABLE;

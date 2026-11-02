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
  return readCache();
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
}

/**
 * 上传一张地图。
 *
 * 三道门，顺序不能换：
 *   1. **本机校验**（`validateFixedMap`）——省一次往返，也让报错不用等网络；
 *   2. **体积**——超了就别传，服务端也会拒；
 *   3. **写库**——成功之后把返回的行 id 拼成 `user:<id>`，和列表里的同一张图对上。
 */
export async function uploadSharedMap(map: FixedMap, author?: string): Promise<MapUploadResult> {
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
        listed: true,
        created_at: new Date().toISOString(),
      })
      // 让服务端回报实际写入的行：没有 select 就分不清"写成功"和"被策略挡了"
      .select();
    if (res?.error) {
      const f = failure(res.error, '上传');
      return { ok: false, reason: f.reason, howTo: f.retryable ? '稍后再试一次' : '需要先开通地图库' };
    }
    const row = Array.isArray(res?.data) ? (res.data[0] as Row | undefined) : undefined;
    const id = row?.id !== undefined ? `user:${row.id}` : `user:${Date.now()}`;
    return { ok: true, map: { ...parsed.map, id, source: 'user', author: author ?? undefined } };
  } catch (err) {
    const f = failure(err as DbFailure, '上传');
    return { ok: false, reason: f.reason, howTo: f.retryable ? '稍后再试一次' : '需要先开通地图库' };
  }
}

export const MAP_TABLE = TABLE;

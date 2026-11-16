/**
 * 玩家分享的关卡：云端库（可选功能）。
 *
 * 结构和 `net/maps.ts` 那套一致，理由也一样：
 *   · 表是"公开读、提交待审"——读策略 `using (listed)`，插入强制 `listed = false`，
 *     客户端拿不到 update 权限，所以**自己没法给自己放行**；
 *   · 安全边界不放在权限上，放在**校验**上：只收 `validateLevel` 放行的数据，
 *     一份坏关卡最多是"列表里点不动"。
 *
 * 和地图那张表唯一的不同：**关卡比地图大得多**，而且带事件。
 * 所以整份 `LevelDef` 原样存进 `data`（jsonb），不再拆成列——
 * 拆列意味着以后每加一个关卡字段都要改表结构。
 *
 * 没开通也不影响任何事：上传/浏览会明说"关卡库还没开通"，本机文件进出照常能用。
 */

import { validateLevel, type LevelDef } from '../core/level.ts';
import { cloudDatabase } from './room.ts';

const TABLE = 'warchess_levels';
const LIST_LIMIT = 60;
const CACHE_KEY = 'warchess.levels.cloud.v1';
/**
 * 单条上限。
 *
 * 2026-11-16 量过：最大的内置关（孤城）序列化 3.4KB。256KB 留了约 70 倍余量，
 * 够塞一张 40×40 加几十条事件的图，同时不至于让列表接口一次拉回几十兆。
 */
export const LEVEL_MAX_BYTES = 256 * 1024;
export const LEVEL_TABLE = TABLE;

interface DbFailure {
  code?: string;
  message?: string;
}

interface Row {
  id?: number | string;
  name?: string;
  author?: string;
  listed?: boolean;
  data?: unknown;
}

export interface LevelListResult {
  ok: boolean;
  levels: LevelDef[];
  /** 失败时给玩家看的一句话 */
  reason?: string;
  retryable?: boolean;
}

export interface LevelUploadResult {
  ok: boolean;
  reason?: string;
  howTo?: string;
  level?: LevelDef;
  /** 写进去了但还没公开（等人工放行） */
  pending?: boolean;
}

/** 把失败翻译成"玩家能看懂 + 知道该做什么" */
function failure(err: DbFailure | undefined, what: string): { reason: string; retryable: boolean } {
  const code = (err?.code ?? '').replace(/^DATABASE_/, '');
  const msg = (err?.message ?? '').toLowerCase();
  /*
   * 提示里**带上原始码和原文**（2026-11-16）。
   *
   * 42501 这个码背后至少有两种完全不同的原因：权限没给、或者 RLS 的
   * WITH CHECK 没过（Postgres 对"违反行级安全策略"也报 42501）。
   * 之前这里统一翻成"凭据或域名对不上"，于是真实原因被这句话盖掉了——
   * 用户看到的是一句猜，我们这边也拿不到线索。码和原文一并留着，
   * 既方便用户转述，也方便直接对着日志定位。
   */
  const detail = `${code ? `[${code}] ` : ''}${err?.message ?? '网络不通'}`;
  if (code === '42P01' || /relation .*does not exist|undefined table|schema cache/.test(msg)) {
    return { reason: '关卡库还没开通（云数据库里没有 warchess_levels 这张表）', retryable: false };
  }
  if (code === '42501' || /permission denied|not authorized|invalid_client|origin/.test(msg)) {
    return { reason: `服务端拒绝了这次写入：${detail}`, retryable: false };
  }
  return { reason: `${what}失败：${detail}`, retryable: true };
}

/** 云端一行的 id 统一加前缀，和本机的 `user:` 分开——两种来源不能混成一个命名空间 */
function cloudId(raw: number | string): string {
  return `cloud:${raw}`;
}

export function isCloudLevelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('cloud:');
}

/** 一行 → 一份关卡。坏数据丢掉：一条坏关卡不该让整个列表崩掉 */
function rowToLevel(row: Row): LevelDef | null {
  const checked = validateLevel({ ...(row.data as object), ...(row.name ? { name: row.name } : {}) });
  if (!checked.ok) return null;
  return { ...checked.level, id: cloudId(row.id ?? Date.now()) };
}

function readCache(): LevelDef[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((it) => validateLevel(it))
      .filter((r): r is { ok: true; level: LevelDef } => r.ok)
      .map((r) => r.level);
  } catch {
    return [];
  }
}

function writeCache(levels: LevelDef[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(levels.slice(0, LIST_LIMIT)));
  } catch {
    // 存不下就算了：列表下一次还能重新拉
  }
}

/**
 * 本机缓存的那一份。
 *
 * 为什么缓存：网络断了 / 表没开通时，至少还能看见上次拉到的列表，
 * 而不是一个空白页——"空白页"会被当成"没有人的关卡"。
 */
export function cachedCloudLevels(): LevelDef[] {
  return readCache();
}

export async function listSharedLevels(): Promise<LevelListResult> {
  try {
    const db = (await cloudDatabase()) as unknown as {
      from(name: string): {
        select(cols: string): {
          eq(col: string, val: unknown): {
            order(col: string, opts: { ascending: boolean }): {
              limit(n: number): PromiseLike<{ data?: unknown; error?: DbFailure }>;
            };
          };
        };
      };
    };
    const res = await db
      .from(TABLE)
      .select('*')
      .eq('listed', true)
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT);
    if (res?.error) {
      const f = failure(res.error, '拉取关卡');
      const cached = readCache();
      return { ok: false, levels: cached, reason: f.reason, retryable: f.retryable };
    }
    const rows = Array.isArray(res?.data) ? (res.data as Row[]) : [];
    const levels = rows.map(rowToLevel).filter((l): l is LevelDef => !!l);
    writeCache(levels);
    return { ok: true, levels };
  } catch (err) {
    const f = failure(err as DbFailure, '拉取关卡');
    return { ok: false, levels: readCache(), reason: f.reason, retryable: f.retryable };
  }
}

/**
 * 上传一份关卡（默认进待审队列）。
 *
 * 三道门，顺序不能换：本机校验 → 体积 → 写库。
 * 校验放最前面，是因为"坏数据不该占用一次审核名额"，也省一次往返。
 */
export async function uploadSharedLevel(level: LevelDef, author?: string): Promise<LevelUploadResult> {
  const checked = validateLevel(level);
  if (!checked.ok) {
    return { ok: false, reason: checked.errors[0], howTo: '先把这几处改完再传' };
  }
  const data = checked.level;
  const size = JSON.stringify(data).length;
  if (size > LEVEL_MAX_BYTES) {
    return {
      ok: false,
      reason: `关卡数据太大（${Math.round(size / 1024)}KB，上限 ${LEVEL_MAX_BYTES / 1024}KB）`,
      howTo: '把地图缩小，或者少写几条事件',
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
        // 存的是**去掉本机 id 的那一份**：id 是"这一台设备上的第几张"，
        // 传到云端没有意义，云端有自己的行号
        name: data.name,
        author: (author ?? '').slice(0, 24) || null,
        w: data.map.w,
        h: data.map.h,
        seats: data.seats?.count ?? 2,
        events: data.events?.length ?? 0,
        data: { ...data, id: 'pending' },
        // 关键一行：没审核之前不给别人看
        listed: false,
        created_at: new Date().toISOString(),
      })
      .select();
    if (res?.error) {
      // 原文也留一份在控制台：提示条会被截断，这里不会
      console.warn('[levels] 上传被拒', res.error);
      const f = failure(res.error, '上传');
      return { ok: false, reason: f.reason, howTo: f.retryable ? '稍后再试一次' : '需要先开通关卡库' };
    }
    return { ok: true, pending: true, level: data };
  } catch (err) {
    const f = failure(err as DbFailure, '上传');
    return { ok: false, reason: f.reason, howTo: f.retryable ? '稍后再试一次' : '需要先开通关卡库' };
  }
}

/** 给测试和界面用：这条关卡能不能上传（不发请求，只看体积与校验） */
export function levelUploadBlocker(level: LevelDef): string | null {
  const checked = validateLevel(level);
  if (!checked.ok) return checked.errors[0] ?? '关卡数据有问题';
  const size = JSON.stringify(checked.level).length;
  if (size > LEVEL_MAX_BYTES) return `数据太大（${Math.round(size / 1024)}KB）`;
  return null;
}

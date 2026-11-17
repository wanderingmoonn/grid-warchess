/**
 * 玩家自己做的关卡（**只存在这台设备上**）。
 *
 * 为什么不塞进 `level.ts` 的 `LEVELS`：
 *   · `LEVELS` 是内置关卡的注册表，`probe:level` 的 26 段和整套 `npm test` 都直接读它。
 *     玩家的数据一旦混进去，"测试结果"就会随每台机器不同——那等于没有测试。
 *   · 内置关卡是平衡基准和回归夹具，玩家改不了；这是两个不同性质的集合。
 *
 * 怎么接进引擎：**不反向 import**。`level.ts` 暴露一个 `registerLevelSource(fn)`，
 * 这里在模块加载时把自己的内存表挂上去；`allLevels()` / `levelById()` 就会看见它们。
 * 反过来写（`level.ts` import 本文件）是循环依赖，`setup.ts` 那条链会在启动时炸。
 *
 * 存什么：`{ v: 1, items: [{ level, updatedAt }] }`。
 * 用数组而不是 `{ id: 关卡 }` 的对象：
 *   · 数组顺序天然就是"最近改过的在前"，不用给 `LevelDef` 加 `updatedAt` 字段
 *     （加了也会被 `validateLevel` 丢掉——它只拷自己认识的字段）；
 *   · 关卡数量有上限，数组足够小。
 */

import { LEVELS, registerLevelSource, validateLevel, type LevelDef } from './level.ts';

/** 成品关卡。改结构要换版本号，老数据能读就继续读，读不了就当没有——不要抛错 */
const STORE_KEY = 'warchess:user-levels:v1';
/** 草稿：还没校验通过的 JSON 文本。和成品分开存，理由见 PLAN 的原则 4 */
const DRAFT_KEY = 'warchess:level-drafts:v1';
/** 上限：选关页是画廊，不是网盘。到顶了丢最老的，并在界面上说一声 */
export const MAX_USER_LEVELS = 60;

export interface StoredLevel {
  level: LevelDef;
  /** 毫秒时间戳 */
  updatedAt: number;
}

interface Envelope {
  v: 1;
  items: StoredLevel[];
}

/**
 * 内存里的那一份。`loadUserLevels()` 从磁盘读进来，之后所有写操作都同时更新两边。
 *
 * 为什么保留内存这份：编辑器和选关页是同一套 DOM 反复重绘的，每次重绘都读一遍
 * localStorage 既慢又容易在隐私模式下拿到 null。内存这份是"这一会儿的事实"。
 */
let items: StoredLevel[] = [];

function storage(): Storage | null {
  try {
    // 探针在 node 里跑，没有 localStorage；隐私模式下 getItem 也可能抛
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 结构检查：只看到能用的程度。真正的校验在 `createMatch` 里（那是唯一入口） */
function looksLikeLevel(raw: unknown): raw is LevelDef {
  const o = raw as Partial<LevelDef> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.name === 'string' &&
    !!o.map &&
    Array.isArray(o.map.rows) &&
    o.map.rows.length > 0
  );
}

export function loadUserLevels(): LevelDef[] {
  const s = storage();
  /*
   * 没有 localStorage（node 探针、某些沙盒）时**什么都不做**。
   *
   * 早先这里写的是 `items = []`，结果是探针里"存一张 → 重新读一次"就把刚存的那张
   * 抹掉了，而测出来的现象是"注册表坏了"。没有磁盘不等于磁盘是空的。
   */
  if (!s) {
    return items.map((it) => it.level);
  }
  try {
    const raw = s.getItem(STORE_KEY);
    if (!raw) {
      items = [];
      return [];
    }
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    const list = Array.isArray(parsed?.items) ? parsed.items : [];
    items = list
      .filter((it): it is StoredLevel => !!it && looksLikeLevel(it.level))
      .map((it) => ({ level: it.level, updatedAt: Number(it.updatedAt) || 0 }))
      // 新→旧。存档被手改过（时间戳全 0）时这段也不会乱，退化成原顺序
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return items.map((it) => it.level);
  } catch {
    // 存的数据坏了：当没有，但**不要删**。作者可能还能手工捞出来
    items = [];
    return [];
  }
}

/** 落盘。返回 false 表示没写进去（隐私模式 / 配额满），调用方要告诉玩家 */
function write(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(STORE_KEY, JSON.stringify({ v: 1, items } satisfies Envelope));
    return true;
  } catch {
    return false;
  }
}

/** 最近改过的在前 */
export function userLevelList(): StoredLevel[] {
  return items.map((it) => ({ level: it.level, updatedAt: it.updatedAt }));
}

export function userLevelById(id: string | null | undefined): LevelDef | null {
  if (!id) return null;
  return items.find((it) => it.level.id === id)?.level ?? null;
}

/** `user:` 前缀是给界面和文档看的（"这是玩家做的，不是内置"），引擎不靠它判断 */
export function newLevelId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `user:${t}-${r}`;
}

export function isUserLevelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('user:');
}

/**
 * 存一张关卡（新建或覆盖）。
 *
 * **先校验再存**，因为 `validateLevel` 顺手做了两件必须的事：挡住坏数据、
 * 返回一份深拷贝。存进内存的必须是拷贝——否则界面上一改，正在打的那局会跟着变。
 *
 * `persisted: false` 表示内存里有了、磁盘上没写进去。别把它当失败：
 * 玩家至少能在这一会儿里玩到自己的关，关掉浏览器才没。
 */
export function saveUserLevel(
  raw: LevelDef,
): { ok: true; level: LevelDef; persisted: boolean } | { ok: false; errors: string[] } {
  /*
   * 不许占用内置关卡的 id。
   *
   * 光靠 `levelById` 的"内置优先"也能挡住（玩家顶不掉孤城），但那样会留下一条脏数据：
   * 用户表里躺着一份永远查不到的"假冒孤城"，作者会一直以为自己改的是它。
   * 在入口处直接拒掉，比事后解释便宜。
   */
  if (LEVELS.some((l) => l.id === raw.id)) {
    return { ok: false, errors: [`「${raw.id}」是内置关卡的 id，不能用来存自己的关。换个 id 再存。`] };
  }
  const prev = userLevelById(raw.id);
  /*
   * 版本号：每存一次 +1。
   *
   * 现在还没有人消费它（存档里带的是快照），但"这个存档用的是第几版"迟早要问，
   * 而且它是唯一能回答"我改了没有"的字段。便宜就先留着。
   */
  const next = { ...raw, version: prev ? Math.max(1, prev.version | 0) + 1 : 1 };
  const checked = validateLevel(next);
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const now = Date.now();
  const rest = items.filter((it) => it.level.id !== checked.level.id);
  items = [{ level: checked.level, updatedAt: now }, ...rest].slice(0, MAX_USER_LEVELS);
  return { ok: true, level: checked.level, persisted: write() };
}

export function deleteUserLevel(id: string): boolean {
  const before = items.length;
  items = items.filter((it) => it.level.id !== id);
  if (items.length === before) return false;
  write();
  return true;
}

/**
 * 把一张内置关卡（或别的关）拷成"我的关卡"。
 *
 * 这是新手的最低门槛：不用从空白开始，改孤城一个字就是自己的关。
 * 三样东西必须换掉，否则会和原版撞车：
 *   · `id`（存档按它找关卡）；
 *   · `map.id`（复盘、地图缓存按它认图）；
 *   · `map.source`（内置图在地图画廊里有特殊待遇）。
 */
export function cloneAsUserLevel(src: LevelDef, suffix = ' 副本'): LevelDef {
  const id = newLevelId();
  const name = `${src.name}${suffix}`.slice(0, 24);
  const copy = structuredClone(src);
  return {
    ...copy,
    id,
    version: 1,
    name,
    map: { ...copy.map, id: `levelmap:${id}`, name, source: 'user' },
  };
}

/** 导出成给人看的 JSON：带缩进，能直接贴进聊天窗口 */
export function exportLevelText(level: LevelDef): string {
  return JSON.stringify(level, null, 2);
}

/**
 * 从文本读一张关卡。
 *
 * JSON 语法错和字段错**分开说**：前者要告诉作者"第几行少了括号"，
 * 后者交给 `validateLevel` 逐条列。混成一句"格式不对"，作者只能瞎猜。
 */
export function parseLevelText(text: string): { ok: true; level: LevelDef } | { ok: false; errors: string[] } {
  const src = text.trim();
  if (!src) return { ok: false, errors: ['内容为空'] };
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    /*
     * "Unexpected end of JSON input" 是最常见的一种，而且它**没有位置**——
     * 作者看到这句英文只会更迷茫。翻成人话：括号/引号没闭合。
     */
    if (/unexpected end of json input/i.test(msg)) {
      return { ok: false, errors: ['JSON 语法错：内容没写完，括号或引号没有闭合。'] };
    }
    const at = /position (\d+)/.exec(msg)?.[1];
    if (at) {
      const line = src.slice(0, Number(at)).split('\n').length;
      return { ok: false, errors: [`JSON 语法错（大约第 ${line} 行）：${msg}`] };
    }
    return { ok: false, errors: [`JSON 语法错：${msg}`] };
  }
  return validateLevel(data);
}

/* ---- 草稿箱 ---- */

/**
 * 草稿故意只存**文本**，不存解析后的对象。
 *
 * 半成品的关键特征就是"过不了校验"，存对象就得先校验；存文本才能做到
 * "写了一半关掉浏览器，明天回来还在"。代价是草稿不能直接拿来开局——
 * 那是成品该干的事。
 */
function readDrafts(): Record<string, string> {
  const s = storage();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s.getItem(DRAFT_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDraft(id: string, text: string): void {
  const s = storage();
  if (!s) return;
  try {
    const all = readDrafts();
    all[id] = text;
    s.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    // 写不进去就算了：草稿不是成品，丢了不该打断编辑
  }
}

export function draftOf(id: string): string | null {
  return readDrafts()[id] ?? null;
}

export function clearDraft(id: string): void {
  const s = storage();
  if (!s) return;
  try {
    const all = readDrafts();
    if (!(id in all)) return;
    delete all[id];
    s.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    // 同上
  }
}

/*
 * 挂进关卡注册表，并把磁盘上已有的那份读进来。
 *
 * 放在模块底部、顶层执行，是为了"import 这个模块 = 用户的关卡已经就位"。
 * 少一次忘记调用：`main.ts` 和探针都只要 import 一行，不用记得再调一次。
 */
registerLevelSource(() => items.map((it) => it.level));
loadUserLevels();

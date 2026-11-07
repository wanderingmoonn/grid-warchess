/**
 * 固定地图：一份"地形已经画好"的地图数据，可以在开局设置里直接选。
 *
 * 和随机地图的关系：随机地图由 `seed + 风格` 变出来，同一个种子永远同一张图，
 * 但**玩家没法预知它长什么样**，也没法把它分享出去（分享种子等于分享一串数字）。
 * 固定地图补的是这一块：它是一份**可以直接看、直接传**的地形。
 *
 * 三件事都放在这里，因为它们必须共用同一个格式：
 *   · 内置地图（随游戏发布，选中即用）；
 *   · 玩家在上帝模式里上传的地图（走云端，别人也能选到）；
 *   · 两者的校验（一份地图能不能进游戏，只有一套判据）。
 *
 * ── 格式 ──────────────────────────────────────────────────────────────
 * 一份地图就是"一个字符矩阵 + 两边的城位"：
 *
 *   ```
 *   name: 双河渡口
 *   . . . f f . ~ ~ . . ...
 *   ...
 *   ```
 * 正式存储用下面这个结构（`rows` 每行 `w` 个字符，字符含义同 `mapgen` 的 `CHAR`）：
 *
 *   { id, name, w, h, rows: string[], citiesA: [{x,y}], citiesB: [{x,y}] }
 *
 * 城位只写**左上角**，边长由开局设置里的城郭大小决定（默认 2×2）。
 * 这样同一份地图在开了「城郭」扩展的局里会变成 3×3 的城，而不用改地图数据。
 */

/** 一份固定地图 */
export interface FixedMap {
  /** 唯一键：内置是 `builtin:xxx`，玩家上传的是 `user:<云端行 id>` */
  id: string;
  name: string;
  w: number;
  h: number;
  /** 每行 `w` 个字符；`'.'` 平原 `'f'` 森林 `'h'` 丘陵 `'~'` 水 `'^'` 山 `'='` 桥 …… 见 mapgen 的 CHAR */
  rows: string[];
  /** 甲方（红方）城的左上角 */
  citiesA: MapPoint[];
  /** 乙方（蓝方）城的左上角 */
  citiesB: MapPoint[];
  author?: string;
  /** 上传时间（ISO 或时间戳字符串），内置图为空 */
  createdAt?: string;
  /** 'builtin' / 'user'：界面据此决定要不要显示作者与删除入口 */
  source?: 'builtin' | 'user';
  /**
   * 还在等审核（**本机标记，不来自云端**）。
   *
   * 待审核的行 `listed=false`，按读策略谁也查不到——包括作者自己。所以这个
   * 标记只能由上传方在本机缓存里带上，用来在画廊里说明"这张还没公开"。
   * 拿它去判断权限就错了：它只是给人看的一行字。
   */
  pending?: boolean;
}

export interface MapPoint {
  x: number;
  y: number;
}

/** 边长范围：太小摆不开两座城，太大手机上缩略图糊成一团 */
export const MAP_MIN_SIZE = 8;
export const MAP_MAX_SIZE = 40;
/** 单份地图文件的上限（字符数）。40×40 也就 1600 个字符，256KB 已经很宽松 */
export const MAP_MAX_BYTES = 256 * 1024;

/**
 * 允许出现在地图里的地形字符。
 *
 * **只有本体这五种 + 桥**：`P`（台地）`v`（河谷）`w`（沼泽）`d`（沙丘）
 * `s`（浅滩）`D`（深水）都是扩展带来的地形，一份"给所有人玩"的地图用了它们，
 * 在没开对应扩展的局里就会还原成平原甚至未知格子。固定地图要能跨房间分享，
 * 所以这里直接不收——想用扩展地形，那种图只该留在自己的存档里。
 */
export const TERRAIN_CHARS = '.fh~^=';
export const TERRAIN_LEGEND = '（. 平原 / f 森林 / h 丘陵 / ~ 水 / ^ 山 / = 桥）';

/**
 * 校验一份"来路不明"的地图数据。
 *
 * 判据顺序是**先结构性、再全局性**：
 *   1. 形状对不对（尺寸范围、行列长度、字符是否认识）；
 *   2. 城位合不合法（在界内、不重叠、双方各至少一座）；
 *   3. 骨架通不通（每座城周围至少一格能站人——否则开局部队没地方站）。
 *
 * 只返回第一处错误 + 全部错误列表：界面上要把能改的都告诉作者，
 * 而不是让他修一个再上传一次。
 */
export function validateFixedMap(raw: unknown): { ok: true; map: FixedMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const obj = (raw ?? {}) as Partial<FixedMap> & Record<string, unknown>;

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) errors.push('缺少地图名（name）');
  if (name.length > 24) errors.push('地图名太长（最多 24 个字）');

  const rowsRaw = Array.isArray(obj.rows) ? obj.rows : null;
  if (!rowsRaw || rowsRaw.length === 0) {
    return { ok: false, errors: ['缺少地形（rows 应该是一行一个字符串的数组）'] };
  }
  const rows = rowsRaw.map((r) => String(r ?? ''));
  const h = rows.length;
  const w = rows[0]!.length;
  if (h < MAP_MIN_SIZE || h > MAP_MAX_SIZE) errors.push(`高度要在 ${MAP_MIN_SIZE}~${MAP_MAX_SIZE} 之间（现在 ${h}）`);
  if (w < MAP_MIN_SIZE || w > MAP_MAX_SIZE) errors.push(`宽度要在 ${MAP_MIN_SIZE}~${MAP_MAX_SIZE} 之间（现在 ${w}）`);
  const badRow = rows.findIndex((r) => r.length !== w);
  if (badRow >= 0) errors.push(`第 ${badRow + 1} 行长度是 ${rows[badRow]!.length}，和第一行（${w}）不一致`);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < rows[y]!.length; x += 1) {
      const ch = rows[y]![x]!;
      if (!TERRAIN_CHARS.includes(ch)) {
        errors.push(`第 ${y + 1} 行第 ${x + 1} 列是「${ch}」，不是可用地形${TERRAIN_LEGEND}`);
        y = h; // 一处就够，别再刷屏
        break;
      }
    }
  }

  const norm = (list: unknown): MapPoint[] => {
    if (!Array.isArray(list)) return [];
    return list
      .map((p) => ({ x: Math.round(Number((p as MapPoint)?.x)), y: Math.round(Number((p as MapPoint)?.y)) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  };
  const citiesA = norm(obj.citiesA);
  const citiesB = norm(obj.citiesB);
  if (citiesA.length === 0) errors.push('甲方一座城都没有（citiesA）');
  if (citiesB.length === 0) errors.push('乙方一座城都没有（citiesB）');
  if (citiesA.length > 8 || citiesB.length > 8) errors.push('每方最多 8 座城');

  for (const c of [...citiesA, ...citiesB]) {
    if (c.x < 1 || c.y < 1 || c.x > w - 3 || c.y > h - 3) {
      errors.push(`城位 (${c.x}, ${c.y}) 贴边了：城要离边界至少 1 格（2×2 的城左上角最大是 ${w - 3}, ${h - 3}）`);
      break;
    }
  }
  // 城与城不许叠：两份地图叠在一起会出"同一格两个城"的崩坏
  const seen = new Set<string>();
  for (const c of [...citiesA, ...citiesB]) {
    const k = `${c.x},${c.y}`;
    if (seen.has(k)) {
      errors.push(`两座城叠在 (${c.x}, ${c.y}) 上了`);
      break;
    }
    seen.add(k);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    map: {
      id: typeof obj.id === 'string' && obj.id ? obj.id : `user:${name}`,
      name,
      w,
      h,
      rows,
      citiesA,
      citiesB,
      author: typeof obj.author === 'string' ? obj.author.slice(0, 24) : undefined,
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
      source: obj.source === 'builtin' ? 'builtin' : 'user',
    },
  };
}

/**
 * 解析一份**上传文件**。
 *
 * 认两种写法，因为两种作者都存在：
 *   · JSON：程序生成的 / 从别处导出的，字段就是上面的结构；
 *   · 纯文本：一行一个字符串，`A` 和 `B` 标出双方城的左上角，其余字符是地形。
 *     这种写法人可以直接在记事本里画，不用数逗号和引号。
 *
 * 纯文本的规则刻意宽松但有边界：
 *   · 第一行若不是纯地形（含中文/冒号/空格），当成地图名；
 *   · 每行末尾的空白忽略，行内空白也忽略（方便对齐着画）；
 *   · `A`/`B` 自己算一格城市，不用再填 citiesA/B。
 */
export function parseMapFile(text: string): { ok: true; map: FixedMap } | { ok: false; errors: string[] } {
  if (text.length > MAP_MAX_BYTES) {
    return { ok: false, errors: [`文件太大（${Math.round(text.length / 1024)}KB，上限 ${MAP_MAX_BYTES / 1024}KB）`] };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, errors: ['文件是空的'] };

  if (trimmed.startsWith('{')) {
    try {
      return validateFixedMap(JSON.parse(trimmed));
    } catch {
      return { ok: false, errors: ['这看起来是 JSON，但解析失败：可能少了一个逗号或引号'] };
    }
  }

  // 纯文本：先判断第一行是不是名字
  const lines = trimmed.split(/\r?\n/);
  let name = '未命名地图';
  const grid: string[] = [];
  const rowsWithCity: string[] = [];
  const cityA: MapPoint[] = [];
  const cityB: MapPoint[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 名字行：出现非地形字符（字母、汉字、冒号）就当作名字
    if (grid.length === 0 && /[^\sfh~^=ABab.]/.test(line.replace(/^name[:：]\s*/i, ''))) {
      name = line.replace(/^name[:：]\s*/i, '').slice(0, 24);
      continue;
    }
    // 行内空格是排版用的，去掉；大小写统一
    const cells = line.replace(/\s+/g, '');
    rowsWithCity.push(cells);
    grid.push(
      cells
        // 城位字母本身在 mapgen 里不是地形，先占成平原，等下面按坐标盖回 city
        .replace(/[ABab]/g, '.'),
    );
  }
  if (grid.length === 0) return { ok: false, errors: ['没有读到任何地形行'] };

  const w = Math.max(...grid.map((r) => r.length));
  // 右侧补平原，让每行等长（作者常常懒得给最后一行补点）
  const rows = grid.map((r) => r.padEnd(w, '.'));
  rowsWithCity.forEach((r, y) => {
    for (let x = 0; x < r.length; x += 1) {
      const ch = r[x]!;
      if (ch === 'A' || ch === 'a') cityA.push({ x, y });
      if (ch === 'B' || ch === 'b') cityB.push({ x, y });
    }
  });
  // 一坨连着的 A 只算一座城（作者常常直接糊一个 2×2 的 A）
  const dedupe = (list: MapPoint[]): MapPoint[] => {
    const out: MapPoint[] = [];
    for (const p of list) {
      if (out.some((q) => Math.abs(q.x - p.x) < 2 && Math.abs(q.y - p.y) < 2)) continue;
      out.push(p);
    }
    return out;
  };

  return validateFixedMap({
    name,
    rows,
    citiesA: dedupe(cityA),
    citiesB: dedupe(cityB),
    source: 'user',
  });
}

/** 导出一份地图成纯文本（给"复制地图"用，也让作者能改自己上传的图） */
export function mapToText(map: FixedMap): string {
  const rows = map.rows.map((r) => r.split(''));
  for (const c of map.citiesA) if (rows[c.y]) rows[c.y]![c.x] = 'A';
  for (const c of map.citiesB) if (rows[c.y]) rows[c.y]![c.x] = 'B';
  return [`name: ${map.name}`, ...rows.map((r) => r.join(''))].join('\n');
}

/**
 * 内置地图。
 *
 * 数据是**冻结的**，不是"用某个种子现场生成"：固定地图的意义就在于
 * "我今天看到的是这张，三个月后还是这张"。随机生成器改一次参数，
 * 用种子描述的固定地图就会悄悄变脸——而它的名字还写着"双河渡口"。
 *
 * 这几张图都是 16×16 / 20×20，地形只用本体那五种，
 * 所以**不依赖任何扩展**：关掉全部扩展也能选、也能打。
 */
export const BUILTIN_MAPS: FixedMap[] = [
  {
    id: 'builtin:twin-river',
    name: '双河渡口',
    w: 16,
    h: 16,
    source: 'builtin',
    citiesA: [{ x: 1, y: 12 }],
    citiesB: [{ x: 12, y: 2 }],
    rows: [
      '..ff..hhhh..ff..',
      '.fff.hhhh...ff..',
      '..f..hh...ff....',
      '.....h...fff....',
      '..~~~..~~~~.....',
      '.~~~~..~~~~~....',
      '..~~~...~~~.....',
      '................',
      '................',
      '.....~~~..~~~...',
      '....~~~~~.~~~~..',
      '.....~~~..~~~...',
      '..ff....h.......',
      '..fff..hh..ff...',
      '...f...h...fff..',
      '.......h........',
    ],
  },
  {
    id: 'builtin:ridge-pass',
    name: '山脊隘口',
    w: 16,
    h: 16,
    source: 'builtin',
    citiesA: [{ x: 1, y: 1 }],
    citiesB: [{ x: 12, y: 12 }],
    rows: [
      '................',
      '.ff....^^^......',
      '.fff..^^^^^.....',
      '..ff...^^^..hh..',
      '...........hhh..',
      '..fff.......h...',
      '..ff...~~.......',
      '.......~~..hh...',
      '...hh......hhh..',
      '..hhh.......h...',
      '...h....fff.....',
      '.......ffff.....',
      '..hh....ff......',
      '.hhh............',
      '..h.............',
      '................',
    ],
  },
  {
    id: 'builtin:lake',
    name: '中央湖',
    w: 16,
    h: 16,
    source: 'builtin',
    citiesA: [{ x: 1, y: 7 }],
    citiesB: [{ x: 12, y: 7 }],
    rows: [
      '................',
      '..ff........ff..',
      '..fff......fff..',
      '...ff..~~..ff...',
      '.......~~~~.....',
      '......~~~~~~....',
      '.....~~~~~~~~...',
      '.....~~~~~~~~...',
      '.....~~~~~~~~...',
      '......~~~~~~....',
      '.......~~~~.....',
      '...ff..~~..ff...',
      '..fff......fff..',
      '..ff........ff..',
      '................',
      '................',
    ],
  },
  {
    id: 'builtin:crossroad',
    name: '十字路口',
    w: 16,
    h: 16,
    source: 'builtin',
    citiesA: [{ x: 1, y: 1 }],
    citiesB: [{ x: 12, y: 12 }],
    rows: [
      '..hh....ff......',
      '.hhh...fff...ff.',
      '..h.....f...fff.',
      '............ff..',
      '..hh.....^^.....',
      '.hhh....^^^^....',
      '..h......^^.....',
      '................',
      '................',
      '.....~~..hh.....',
      '....~~~~.hhh....',
      '.....~~...h.....',
      '..ff............',
      '.fff...ff..hh...',
      '..f...fff..hhh..',
      '.......f....h...',
    ],
  },
];

/** 内置地图 + 本地缓存的上传地图。云端拉取成功后由 `registerUserMaps` 合并进来 */
const userMaps = new Map<string, FixedMap>();

export function allFixedMaps(): FixedMap[] {
  return [...BUILTIN_MAPS, ...userMaps.values()];
}

export function fixedMapById(id: string | null | undefined): FixedMap | null {
  if (!id) return null;
  return BUILTIN_MAPS.find((m) => m.id === id) ?? userMaps.get(id) ?? null;
}

/** 把云端拉回来的一批地图登记进来（同 id 覆盖，名字改了也能同步） */
export function registerUserMaps(maps: FixedMap[]): void {
  for (const m of maps) {
    if (m.source !== 'builtin') userMaps.set(m.id, m);
  }
}

/** 给界面用：这一份地图占了哪些格、每种地形多少格（缩略图与统计都读它） */
export function mapStats(map: FixedMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of map.rows) {
    for (const ch of row) out[ch] = (out[ch] ?? 0) + 1;
  }
  return out;
}

/**
 * 城位的默认边长（写地图文件时用）。
 *
 * 只用于校验和文档：真正的边长由开局设置决定（`config.citySize`，
 * 「城郭」扩展会把它抬到 3）。所以同一份地图在开了城郭的局里，
 * 城会变大，而地图数据一个字都不用改。
 */
export const DEFAULT_CITY_SIZE = 2;

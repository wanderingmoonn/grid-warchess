/**
 * 关卡的"第二层校验"：**引擎查不了、但编辑器必须拦**的那些事。
 *
 * 为什么不能都塞进 `validateLevel`：
 *   · 它在**建局之前**跑，手里没有本局的兵种表（兵种要看扩展、看玩家勾了哪些）；
 *   · 它的语义是"这份数据能不能建出一局"，坏数据就退回随机地图——那是**保命**，
 *     不是**给作者看**。作者要的是"哪一行、哪一格错了"，而不是一句能跑就行。
 *
 * 所以这里只做两件事：把能确定的错挑出来，把"大概会出问题"的写成警告。
 * **能确定才报错**——虚报一个错，作者会去改一个本来就对的地方，比不报更糟。
 */

import { CONFIG, UNIT_TYPES, navigable, passable } from './config.ts';
import { EXPANSIONS } from './expansions.ts';
import { loadCustomUnits } from './customUnits.ts';
import { terrainFromChar } from './mapgen.ts';
import { LEVEL_TERRAINS, type DeployUnit, type LevelDef, type LevelDo } from './level.ts';
import type { PlayerId, Terrain, UnitTypeDef } from './types.ts';

export interface LevelIssue {
  severity: 'error' | 'warn';
  text: string;
  /** 能定位到某一格时给出来，编辑器可以据此把画布挪过去 */
  at?: { x: number; y: number };
}

/** 城市默认 2×2。开了「城郭」会变 3×3，但那只影响"漏报"，不会造成虚报 */
const CITY_CELL_SIZE = 2;

/** 本局可能存在的兵种：内置 + 玩家自定义 + 这一关自带的。扩展兵种算不出来，见下 */
function knownUnits(level: LevelDef): Record<string, UnitTypeDef> {
  return { ...UNIT_TYPES, ...loadCustomUnits(), ...(level.units ?? {}) };
}

function terrainAt(level: LevelDef, x: number, y: number): Terrain | null {
  const row = level.map.rows[y];
  if (!row || x < 0 || x >= level.map.w) return null;
  return terrainFromChar(row[x] ?? '.');
}

/** 城的格子（含 footprint）。用来判断"这个兵摆到别人城里了" */
function cityCells(level: LevelDef): Array<{ x: number; y: number; owner: PlayerId }> {
  const out: Array<{ x: number; y: number; owner: PlayerId }> = [];
  const push = (list: Array<{ x: number; y: number }> | undefined, owner: PlayerId): void => {
    for (const c of list ?? []) {
      for (let dy = 0; dy < CITY_CELL_SIZE; dy += 1) {
        for (let dx = 0; dx < CITY_CELL_SIZE; dx += 1) out.push({ x: c.x + dx, y: c.y + dy, owner });
      }
    }
  };
  push(level.map.citiesA, 'A');
  push(level.map.citiesB, 'B');
  push(level.seats?.cities?.C, 'C');
  push(level.seats?.cities?.D, 'D');
  return out;
}

/**
 * 这个兵种能不能站在这种地形上。
 *
 * **导出的**：摆兵面板（`ui/level-army.ts`）要用同一条判据。两边各写一份的话，
 * 会出现"编辑器说能放、建局时被静默跳过"——那是最难查的一类不一致。
 *
 * 判据和引擎的 `tileStandsOk` 对齐到"不会虚报"的程度：
 *   · 水域单位（船）只能待在水面；
 *   · 其它单位不能上山；
 *   · 水面**只警告**——飞行和掠水单位是能停的，而那是兵种属性，这里不一定知道。
 */
export function standState(def: UnitTypeDef | undefined, t: Terrain): 'ok' | 'warn' | 'bad' {
  if (!def) return 'ok'; // 未知兵种另有一条警告，别在这儿重复说
  if (def.domain === 'water') return navigable(t) ? 'ok' : 'bad';
  if (!passable(t)) return t === 'mountain' ? 'bad' : 'warn';
  return 'ok';
}

function terrainName(t: Terrain): string {
  // 用全局那一份，别在这儿再抄一张表——抄出来的表迟早和渲染/导出对不上
  return CONFIG.terrainName[t] ?? t;
}


/**
 * 兵种检查：**只查 id 认不认识**。
 *
 * 时代差不查。2026-11-16 实测：默认配置下 `unitTypes` 就是全部兵种，青铜局里
 * 刷一个 `knight`（铁器）**能成功**。而且"青铜关空投一辆坦克"是正经的关卡设计，
 * 不是配置错误——编辑器替作者做这个判断就越界了。
 * （早先版本这里有一条"跨时代"警告，同一天被用户要求去掉："框架内的东西越自由越好"。）
 */
function checkUnits(
  units: DeployUnit[] | undefined,
  label: string,
  known: Record<string, UnitTypeDef>,
  out: LevelIssue[],
): void {
  for (const u of units ?? []) {
    const def = known[u.type];
    if (!def) {
      out.push({
        severity: 'warn',
        text: `${label}里的兵种「${u.type}」在内置表和这一关的 units 里都找不到。拼错了，或者它来自一个没启用的扩展——那样开局时会被静默跳过。`,
        at: { x: u.x, y: u.y },
      });
      continue;
    }
  }
}

/** 一层落点检查：站不站得住、有没有压到别人的城 */
function checkSpots(
  units: DeployUnit[] | undefined,
  label: string,
  owner: PlayerId,
  level: LevelDef,
  known: Record<string, UnitTypeDef>,
  cities: Array<{ x: number; y: number; owner: PlayerId }>,
  out: LevelIssue[],
): void {
  for (const u of units ?? []) {
    const t = terrainAt(level, u.x, u.y);
    if (!t) continue; // 越界归 validateLevel 管，它已经报过一条
    const def = known[u.type];
    const spot = standState(def, t);

    if (spot === 'bad') {
      out.push({
        severity: 'error',
        text: `${label}：${
          def?.domain === 'water' ? '船' : '这个兵'
        }站在 (${u.x}, ${u.y}) 的${terrainName(t)}上，站不住——开局时这一格会被跳过。`,
        at: { x: u.x, y: u.y },
      });
      continue;
    }
    if (spot === 'warn') {
      out.push({
        severity: 'warn',
        text: `${label}：(${u.x}, ${u.y}) 是${terrainName(t)}。只有飞行/掠水单位能停在水面，其它兵种站不上去。`,
        at: { x: u.x, y: u.y },
      });
    }

    const city = cities.find((c) => c.x === u.x && c.y === u.y);
    if (city && city.owner !== owner) {
      out.push({
        severity: 'error',
        text: `${label}把兵摆到了第 ${city.owner} 家的城里 (${u.x}, ${u.y})——那一格进不去，开局时会被跳过。`,
        at: { x: u.x, y: u.y },
      });
    }
  }
}

/**
 * 校验一张关卡。**顺序固定：先结构（validateLevel 已经做过），再这里这些语义。**
 *
 * 调用方一般是编辑器；`createMatch` 不该调用它——建局时宁可少一批评测，
 * 也不要因为一条"警告"把一局拦下来。
 */
export function lintLevel(level: LevelDef): LevelIssue[] {
  const out: LevelIssue[] = [];
  const known = knownUnits(level);
  const cities = cityCells(level);
  const seats = level.seats?.count ?? 2;
  const seatList: PlayerId[] = (['A', 'B', 'C', 'D'] as PlayerId[]).slice(0, seats);

  /* ---- 开局部署 ---- */
  for (const [key, units] of Object.entries(level.deploy ?? {})) {
    const owner = key as PlayerId;
    checkUnits(units, `第 ${owner} 家的部署`, known, out);

  /*
   * ---- 禁用兵种 ----
   *
   * 只做两条**能确定**的提醒：
   *   · id 在内置、扩展、关卡兵种里都查不到（多半拼错了）；
   *   · 禁了某个席位开局就摆着的兵（开局有一个、但这一关造不出第二个）。
   * 不查"禁了本局根本没开的扩展兵种"——lint 这一层不知道玩家勾了哪些包。
   */
  const banned = level.banUnits ?? [];
  if (banned.length > 0) {
    const inPacks = new Set<string>();
    for (const e of EXPANSIONS) for (const u of e.units ?? []) inPacks.add(u.id);
    for (const id of banned) {
      if (known[id] || inPacks.has(id)) continue;
      out.push({
        severity: 'warn',
        text: `禁用名单里的「${id}」认不出来：内置、扩展和这一关的兵种表里都没有它，多半是拼错了。`,
      });
    }
    for (const [key, list] of Object.entries(level.deploy ?? {})) {
      const hit = (list ?? []).filter((u) => banned.includes(u.type));
      if (hit.length === 0) continue;
      out.push({
        severity: 'warn',
        text: `第 ${key} 家的开局兵力里有 ${hit.length} 个被禁用的兵种（${hit
          .map((u) => known[u.type]?.name ?? u.type)
          .join('、')}）：开局就有一个，但这一关造不出第二个。`,
      });
    }
  }
    checkSpots(units, `第 ${owner} 家的部署`, owner, level, known, cities, out);
  }

  /*
   * 未登场的席位必须有人叫它上场。
   *
   * 这是最容易漏的一条：`hidden` 的席位开局没城没兵、不占回合、不算出局，
   * 唯一的出场方式是 `{ kind: 'deploy', seat }` 事件。忘了写，它就永远不来，
   * 而且"还剩几家"也不算它——玩家那边看到的是"这关说有三家，我只见到两家"。
   */
  for (const seat of level.seats?.hidden ?? []) {
    const called = (level.events ?? []).some((ev) => ev.do.some((a) => a.kind === 'deploy' && a.seat === seat));
    if (!called) {
      out.push({
        severity: 'error',
        text: `第 ${seat} 家标成了「开局未登场」，但没有任何事件把它叫上场（缺一个「让某家登场」的动作）。它会永远不出现。`,
      });
    }
  }

  /* ---- 事件 ---- */
  for (const ev of level.events ?? []) {
    const hasSay = ev.do.some((a) => a.kind === 'say');
    for (const act of ev.do) {
      if (act.kind === 'spawn') {
        const label = `事件「${ev.id}」刷兵`;
        checkUnits(act.units, label, known, out);
        checkSpots(act.units, label, act.owner, level, known, cities, out);
      }
      if (act.kind === 'terrain') {
        checkTerrainAction(ev.id, act, level, hasSay, out);
      }
    }
  }

  /*
   * 无城席位必须写 `deploy`。
   *
   * 不写就是"开局零兵"，而零兵的无城席位第一帧就出局——这不是玩家能理解的失败，
   * 是作者漏了一个字段。所以要在编辑器里当场拦，而不是等他自己发现。
   */
  for (const seat of level.seats?.cityless ?? []) {
    if (level.seats?.hidden?.includes(seat)) {
      out.push({
        severity: 'error',
        text: `第 ${seat} 家同时被标成「没有城」和「中途登场」：未登场的席位要靠 deploy 事件放城，两件事冲突。`,
      });
      continue;
    }
    const list = level.deploy?.[seat] ?? [];
    if (list.length === 0) {
      out.push({
        severity: 'error',
        text: `第 ${seat} 家标成了「没有城」，但没写开局兵力。它会以零兵开局、第一帧就出局——去「摆兵」里给它摆几个兵。`,
      });
    }
  }

  /* ---- 胜负 ---- */
  for (const goal of level.goals ?? []) {
    if (goal.kind !== 'assassinate') continue;
    /*
     * 斩首的目标必须是"造不出来"的兵种。
     *
     * 否则对面一边死一边补，`assassinate` 永远不会成立——玩家会以为"我明明杀了他"。
     * 正确写法是在 `level.units` 里自带一个 `summonedOnly: true` 的单位。
     */
    const type = goal.unitType;
    if (!type) continue;
    const def = known[type];
    if (!def) {
      out.push({
        severity: 'error',
        text: `「斩首」的目标兵种「${type}」不存在，这个条件永远不会成立（不是白送胜利，是永远打不完）。`,
      });
    } else if (def.summonedOnly !== true) {
      /*
       * 只警告，不拦。
       *
       * 严格说这个条件"很难成立"而不是"不可能"：把对面的城全打掉、或者一口气清空同型兵，
       * 它也能成立。所以这是设计选择（虽然多半是没想到），不是配置错误——
       * 2026-11-16 定的口径是"框架内的东西越自由越好，编辑器不替作者判断"。
       */
      out.push({
        severity: 'warn',
        text: `「斩首」的目标「${def.name}」玩家造得出来，对面会一直补人，条件很难成立。想让它可靠，在 units 里给它加 summonedOnly: true。`,
      });
    }
  }

  /* ---- 覆盖不到的席位（提示，不拦） ---- */
  for (const key of Object.keys(level.deploy ?? {})) {
    if (!seatList.includes(key as PlayerId)) {
      out.push({ severity: 'warn', text: `部署里有第 ${key} 家，但这一关只坐 ${seatList.join(' / ')}。` });
    }
  }

  return out;
}

/**
 * 改地形这条动作的单独特有毛病：作者很容易只写"把水改成深水"，忘了播报。
 * 引擎那边会兜底（城格跳过、兵挤走），但**它不会替你说话**——
 * 玩家只看到地形自己变了，会当成渲染 bug。
 */
function checkTerrainAction(
  eventId: string,
  act: Extract<LevelDo, { kind: 'terrain' }>,
  level: LevelDef,
  hasSay: boolean,
  out: LevelIssue[],
): void {
  if (!hasSay) {
    out.push({
      severity: 'warn',
      text: `事件「${eventId}」改了地形却没配一句播报。玩家只会看到地形自己变了——建议加一条「播报」。`,
    });
  }
  const { x0, y0, x1, y1 } = act.zone;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  if (right < 0 || bottom < 0 || left >= level.map.w || top >= level.map.h) {
    out.push({
      severity: 'error',
      text: `事件「${eventId}」改地形的区域整块在地图外，永远不会生效。`,
    });
    return;
  }

  /*
   * 目标地形必须是"事件能改的"。
   *
   * 地图字符表（`TERRAIN_CHARS`）比这里宽：地图上能画桥 `=`、虚空 `#`、甲板 `_`。
   * 但事件改地形**改不了桥**——桥面由桥单位维持，`syncBridges` 每步对账，
   * 写进去的桥面下一步会被悄悄改回水面。作者会以为"我写了但没生效"。
   */
  if (!LEVEL_TERRAINS.includes(act.to as (typeof LEVEL_TERRAINS)[number])) {
    out.push({
      severity: 'error',
      text: `事件「${eventId}」想把地形改成「${terrainName(act.to as Terrain)}」，这一项不能由事件改（桥面、城、虚空都不行）。`,
    });
  }

  /*
   * 改成深水会**把这一片里的桥冲垮**（桥面撑得住浅水/干河床，撑不住深水）。
   * 这是目前"用事件拆桥"的唯一办法，所以不是错误；但桥上要是有兵会被挤走，
   * 值得先提醒一句——作者多半是想要这个效果，只是没想到连人一起波及。
   */
  if (act.to === 'deep') {
    let bridges = 0;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        if (terrainAt(level, x, y) === 'bridge') bridges += 1;
      }
    }
    if (bridges > 0) {
      out.push({
        severity: 'warn',
        text: `事件「${eventId}」把 ${bridges} 格桥面改成了深水：桥会被冲垮，站在上面的兵会被挤走。这是"用事件拆桥"的正常做法，确认一下是不是想要的。`,
      });
    }
  }
}

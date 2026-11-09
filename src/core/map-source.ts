/**
 * 一个文件 → 一张能上传的地图。
 *
 * 背景：作者手上常常不是"沙盒里的局面"，而是一个 `.txt/.json` 文件——
 * 可能是上帝模式存的**对局存档**，也可能是之前「复制文本」存下来的**地图**。
 * 上传入口原来只认当前沙盒局面，于是这两种文件都传不上去（存档连"打开"都没有，
 * 导入存档走的是只读复盘）。这一层把"读文件"这件事做成纯函数，
 * 上传弹窗和测试共用同一份判据。
 *
 * 三种输入，按这个顺序试：
 *   1. JSON 且是存档（`kind:"warchess-match"` 或裸 `state`）→ 走 `stateToFixedMap`，
 *      和游戏内「导出地图」同一个函数，**校验结论逐字一致**；
 *   2. JSON 且是地图（有 rows / citiesA）→ `validateFixedMap`；
 *   3. 纯文本地图（`name: xxx` + 若干行地形字符）→ `parseMapFile`。
 *
 * 都不成就报"这文件既不是地图也不是存档"，并把前两种的具体错因带出来——
 * 只说"格式不对"最费时间，作者根本不知道该改哪。
 */

import {
  parseMapFile,
  validateFixedMap,
  type FixedMap,
} from './fixed-maps.ts';
import { stateToFixedMap } from './map-export.ts';
import type { GameState } from './types.ts';

export type MapFileSource = 'save' | 'map' | 'unknown';

export interface MapFromFileResult {
  ok: boolean;
  map?: FixedMap;
  /** 给作者看的错因，已分好条 */
  errors: string[];
  /** 非致命提醒（扩展地形、兵被丢掉之类） */
  note: string;
  /** 认出来是什么：存档 / 地图 / 没认出来 */
  source: MapFileSource;
}

/** 存档里有没有"局面"这件事，只看这几样，别信 kind——导出工具会写错 */
function asState(raw: unknown): GameState | null {
  const obj = raw as { state?: unknown } & Partial<GameState>;
  const inner = (obj?.state ?? obj) as Partial<GameState> | undefined;
  if (!inner) return null;
  if (!Array.isArray(inner.tiles) || !inner.w || !inner.h) return null;
  return inner as GameState;
}

export function mapFromFileText(text: string, name?: string): MapFromFileResult {
  const fail = (errors: string[], note = ''): MapFromFileResult => ({
    ok: false,
    errors,
    note,
    source: 'unknown',
  });

  const trimmed = text.trim();
  if (!trimmed) return fail(['文件是空的']);

  const wanted = (name ?? '').trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return fail(['这看起来是 JSON，但解析失败：可能少了一个逗号或引号']);
    }

    // 先当存档：存档里有 tiles + w + h，这个组合地图文件不会有
    const state = asState(parsed);
    if (state) {
      const res = stateToFixedMap(state, wanted || '未命名');
      const units = state.units?.length ?? 0;
      const extra = units > 0
        ? `这一局里已经有 ${units} 个兵，地图只带地形和城位，兵会被丢掉`
        : '';
      if (!res.ok) return { ok: false, errors: res.errors, note: res.note, source: 'save' };
      return {
        ok: true,
        map: withName(res.map!, wanted),
        errors: [],
        note: [res.note, extra].filter(Boolean).join('；'),
        source: 'save',
      };
    }

    // 再当地图
    const checked = validateFixedMap(parsed);
    // 认出是地图了，就别把 source 报成"未识别"——错因和"没认出来"是两回事
    if (!checked.ok) return { ok: false, errors: checked.errors, note: '', source: 'map' };
    return { ok: true, map: withName(checked.map, wanted), errors: [], note: '', source: 'map' };
  }

  // 纯文本地图
  const parsed = parseMapFile(trimmed);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, note: '', source: 'map' };
  return { ok: true, map: withName(parsed.map, wanted), errors: [], note: '', source: 'map' };
}

/** 用户在输入框里改了名字就以输入框为准；没填就保留文件里带的 */
function withName(map: FixedMap, wanted: string): FixedMap {
  if (!wanted) return map;
  return { ...map, name: wanted };
}

/** 给界面用的一句话（"从哪儿读来的"） */
export function sourceLabel(source: MapFileSource): string {
  if (source === 'save') return '对局存档';
  if (source === 'map') return '地图文件';
  return '未识别';
}

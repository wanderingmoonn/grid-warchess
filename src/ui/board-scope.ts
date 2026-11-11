/**
 * 把"整局"的棋盘高亮缩到"某一张图"的那一份。
 *
 * 抽成独立函数是为了能被测试直接调：它只做纯数据换算，不碰 DOM。
 * 之前这段逻辑写在 main.ts 里，于是"月面上选中单位却没有可攻击格"这种错
 * 只能靠玩家实机发现——而它的成因（`targets` 被无条件清空）在代码里
 * 看起来完全合理。
 *
 * 判据只有一个：**选中的单位在不在这一张图上**。
 *   · 在 → 可达格、可攻击目标、瞄准格、威胁圈、产出预览都是按它算的，
 *     而且用的本来就是"这张图的格号"（`reachableTiles` / `attackableTargets`
 *     都按单位所在的图算），直接照用；
 *   · 不在 → 一律清空，免得把地球的格号画到月球上（那是另一个位置）。
 *
 * 地球专供、任何图都不放行的几样：
 *   · `heat` / `heatFlash`：存的是地球格号，没带"图"这一维；
 *   · `boardView` / `boardGlyph`：按地球可见格算出来的染色；
 *   · `tutorialTiles`：教学关只在地球。
 */

import { boardIdOf, EARTH } from '../core/board.ts';
import type { BoardId, Unit } from '../core/types.ts';
import type { BoardUi } from './board.ts';

export function scopeBoardUi(ui: BoardUi, id: BoardId, units: readonly Unit[]): BoardUi {
  if (id === EARTH) return ui;
  const sel = ui.selectedId ? units.find((u) => u.id === ui.selectedId) : undefined;
  const mine = !!sel && boardIdOf(sel) === id;
  return {
    ...ui,
    selectedId: mine ? sel!.id : null,
    selectedCityId: null,
    reach: mine ? ui.reach : [],
    targets: mine ? ui.targets : [],
    siegeTargets: mine ? ui.siegeTargets : [],
    aimTiles: mine ? ui.aimTiles : [],
    skillThreatTiles: mine ? ui.skillThreatTiles : [],
    placeable: ui.placeable,
    threat: mine ? ui.threat : [],
    heat: undefined,
    heatFlash: undefined,
    movePath: mine ? ui.movePath : undefined,
    boardView: undefined,
    boardGlyph: undefined,
    incomeHints: mine ? ui.incomeHints : undefined,
    tutorialTiles: [],
    tutorialCityId: null,
    tutorialOwnCityId: null,
  };
}

/**
 * 「太空时代」——第一个真正跨到地球之外的扩展。
 *
 * 现在它做两件事：
 *   1. **开局生成月球图**（`moon.ts`）；
 *   2. **火箭发射井**（`silo.ts`）：时代 5 的建筑，2×2，装一个地面单位，
 *      加注 3 回合之后把它送上月面着陆点。
 *
 * 为什么先只做这些：多棋盘的地基（Board / 视野 / 切图）已经跑通，
 * 登月胜利、月面战斗、太空战争都还没接。一次只上一条链，出问题时容易定位。
 *
 * 月球图**不放城市**——所以城市的产兵、升级、胜负判定一行都不用改。
 */

import type { Expansion, UnitActionOption } from '../expansions.ts';
import { createMoonBoard, MOON_MIN_SIZE, MOON_SIZE_RATIO } from './moon.ts';
import {
  ROCKET_SILO,
  SILO_FUEL_TURNS,
  SILO_ID,
  launchProblem,
  launchToMoon,
  siloLines,
  startFueling,
  tickSilos,
} from './silo.ts';

/**
 * 把发射井加进"会盖房的人"的手艺里。
 *
 * 写在开局而不是兵种数据上，是因为**核心不该认识扩展的词汇**：
 * `config.ts` 里那几支工兵的 `builds` 白名单是本体自己的手艺表，
 * 往里塞一个 `rocket_silo` 等于让没开太空包的局也挂着一个查不到的定义。
 *
 * 判据是"时代够、而且本来就带 `builds`"：这样以后新增的六代、七代工程队
 * 自动也会盖，不用回来改这里。
 */
function teachBuilders(state: { unitTypes: Record<string, { category: string; era?: number; builds?: string[] }> }): void {
  for (const def of Object.values(state.unitTypes)) {
    if (def.category !== 'builder') continue;
    if ((def.era ?? 0) < ROCKET_SILO.era) continue;
    if (!def.builds) continue;
    if (!def.builds.includes(SILO_ID)) def.builds.push(SILO_ID);
  }
}

export const SPACE_AGE: Expansion = {
  id: 'space-age',
  name: '太空时代',
  blurb: '月球图与火箭发射井：把一支地面部队送上月面。',
  summary:
    '开局在地球之外生成一张<b>月球图</b>：尺寸约为地球的 '
    + `${Math.round(MOON_SIZE_RATIO * 100)}%，最小 ${MOON_MIN_SIZE}×${MOON_MIN_SIZE}；`
    + '地形只有月壤与环形山，没有城市。'
    + '左下角的地图列表可以在两张图之间切换，每张图各记各的相机。'
    + '<b>时代 5 可以修「火箭发射井」</b>（2×2、建在平原）：装一个地面单位，'
    + `加注 ${SILO_FUEL_TURNS} 回合后点火，把它送到月面着陆点。`,
  scale: 'large',
  manualNotes: [
    `月球尺寸 = max(${MOON_MIN_SIZE}, round(地球边长 × ${MOON_SIZE_RATIO}))，`
      + '例如 12×12 的地球对应 9×9 的月球、16×16 对应 12×12。',
    '月壤：1 点移动力、无掩护；环形山：2 点移动力、护甲 +2。',
    '月球上不放城市——城市的产兵、升级与"城打光就输"的判定只作用于地球。',
    '<b>火箭发射井</b>：时代 5、2×2、只能建在平原，420 金。它有一个货舱，'
      + '贴着它点「装载」把一个地面单位接进来（船、飞机、建筑上不去）。',
    `加注是<b>计时器</b>：点一下「加注燃料」开始，之后每回合 +1，满 ${SILO_FUEL_TURNS} 回合才能点火。`
      + '发射后燃料清零，要再飞一趟就重新加注。',
    '落地在<b>离月球中心最近的一块空地</b>，当回合不能再动。发射井与月球都不会被消耗。',
  ],
  units: [ROCKET_SILO],
  hooks: {
    onMatchStart: ({ state }) => {
      // 会盖房的人先学会盖井（没开太空包的局连这个类型都没有，见上面）
      teachBuilders(state);
      // 已经有月球就别重复生成（导入存档、重开同一局）
      if (state.boards?.moon) return;
      state.boards ??= {};
      state.boards.moon = createMoonBoard(state.w, state.seed);
    },

    /** 加注是"我方后勤"：每回合推进自己那些正在加注的井 */
    onTurnStart: ({ state, player }) => {
      tickSilos(state, player);
    },

    unitActions: ({ state, unit, viewer }) => {
      if (unit.owner !== viewer) return [];
      if (unit.type !== SILO_ID) return [];
      // 还没盖完（有几座建筑是"工地"状态）：按钮一律不给
      if ((unit.buildNeed ?? 0) > (unit.buildDone ?? 0)) return [];

      const out: UnitActionOption[] = [];
      const fuel = Number(unit.custom?.fuel ?? 0);
      const fueling = unit.custom?.fueling === true;
      const cargo = unit.cargo ?? [];

      out.push({
        id: 'silo:fuel',
        group: '发射井',
        label: '加注燃料',
        detail: `点一下开始，之后每回合 +1，满 ${SILO_FUEL_TURNS} 回合才能点火`,
        note: `${Math.min(SILO_FUEL_TURNS, fuel)} / ${SILO_FUEL_TURNS}`,
        disabled: fuel >= SILO_FUEL_TURNS || fueling,
      });

      const problem = launchProblem(state, unit);
      out.push({
        id: 'silo:launch',
        group: '发射井',
        label: '发射',
        detail: cargo.length > 0
          ? `把货舱里的「${state.unitTypes[cargo[0]!.type]?.name ?? cargo[0]!.type}」送上月面`
          : '货舱是空的：先点「装载」接一个地面单位进来',
        note: problem ?? '条件齐了',
        disabled: !!problem,
      });
      return out;
    },

    onUnitAction: ({ state, unit, actionId }) => {
      if (unit.type !== SILO_ID) return '这里没有发射井';
      if (actionId === 'silo:fuel') return startFueling(state, unit);
      if (actionId === 'silo:launch') return launchToMoon(state, unit);
      return `认不出这个操作：${actionId}`;
    },

    // viewer 要传：给对手看的那份要裁掉"装的是谁"（见 siloLines）
    getUnitPanelLines: ({ state, unit, viewer }) => siloLines(state, unit, viewer),
  },
};

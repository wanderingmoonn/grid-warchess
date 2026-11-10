/**
 * 「太空时代」——第一个真正跨到地球之外的扩展。
 *
 * 目前它只做一件事：**开局生成月球图**。
 *
 * 为什么先只做这一件：多棋盘的地基（Board / 视野 / 切图）已经跑通，
 * 但"普通对局里能看到月球"是条独立的路——先把它跑顺，再往上面加
 * 火箭井、发射、着陆与登月胜利。一次只上一条链，出问题时容易定位。
 *
 * 月球图本身在 `moon.ts`：尺寸跟地球等比缩（下限 4×4），地形只有月壤与环形山，
 * **不放城市**——所以城市的产兵、升级、胜负判定一行都不用改。
 */

import type { Expansion } from '../expansions.ts';
import { createMoonBoard, MOON_MIN_SIZE, MOON_SIZE_RATIO } from './moon.ts';

export const SPACE_AGE: Expansion = {
  id: 'space-age',
  name: '太空时代',
  blurb: '开局多一张月球图，地月系从这里开始。',
  summary:
    '开局在地球之外生成一张<b>月球图</b>：尺寸约为地球的 '
    + `${Math.round(MOON_SIZE_RATIO * 100)}%，最小 ${MOON_MIN_SIZE}×${MOON_MIN_SIZE}；`
    + '地形只有月壤与环形山，没有城市。'
    + '左下角的地图列表可以在两张图之间切换，每张图各记各的相机。'
    + '<b>目前只有"能看"</b>：火箭井、发射、着陆与登月胜利在后续版本接入。',
  scale: 'large',
  manualNotes: [
    `月球尺寸 = max(${MOON_MIN_SIZE}, round(地球边长 × ${MOON_SIZE_RATIO}))，`
      + '例如 12×12 的地球对应 9×9 的月球、16×16 对应 12×12。',
    '月壤：1 点移动力、无掩护；环形山：2 点移动力、护甲 +2。',
    '月球上不放城市——城市的产兵、升级与"城打光就输"的判定只作用于地球。',
  ],
  hooks: {
    onMatchStart: ({ state }) => {
      // 已经有月球就别重复生成（导入存档、重开同一局）
      if (state.boards?.moon) return;
      state.boards ??= {};
      state.boards.moon = createMoonBoard(state.w, state.seed);
    },
  },
};

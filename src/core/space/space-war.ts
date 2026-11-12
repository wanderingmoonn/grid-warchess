/**
 * 「太空战争」——在基础包（太空时代）之上加**星图与空间站**。
 *
 * ── 为什么分两个包 ──────────────────────────────────────
 *
 * 基础包的承诺很小：造井、发射、落月、采样，一条线走完。
 * 太空战争要的是另一件事：把"图"变成有轨道的星图，让人在轨道上建站、
 * 加装舱段、把战争推离地面。
 *
 * 两件事的**体量差一个数量级**，混在一起的结果是——只想要"简单登月"的玩家
 * 也得吃下空间站与折扣系统，规则书里一半篇幅跟他无关。
 * 所以这里 `requires: ['space-age']`：**没有基础包就没有太空战争**，
 * 反过来不成立。
 *
 * ── 分界线画在哪 ────────────────────────────────────────
 *
 *   · 留在基础包：月球图、火箭发射井、月面基地、月壤采样、**星图数据与航道投送**
 *     （因为"发射到月球"本身就要用航道，那是发射的一部分）；
 *   · 搬到这里：核心舱、空间站棋盘、扩建与舱段、太空建设折扣、
 *     以及星图视图的入口（`main.ts` 按扩展 id 判断）。
 */

import type { Expansion, UnitActionOption } from '../expansions.ts';
import { SILO_ID } from './silo.ts';
import {
  CORE_DEFS,
  STATION_CORE,
  STATION_CORE_ID,
  STATION_PRODUCER,
  buildCost,
  launchCore,
  stationLines,
  tickProducers,
} from './station.ts';

export const SPACE_WAR: Expansion = {
  id: 'space-war',
  name: '太空战争',
  // 没有基础包就没有太空战争（反过来不成立）：月球、发射井、航道都在基础包里
  requires: ['space-age'],
  // 有自己的机制（空间站/扩建/折扣），值得单独一册规则书
  scale: 'large',
  blurb: '星图与空间站：在轨道上建站、扩建舱段，把战争推离地面。',
  summary:
    '在基础包（<b>太空时代</b>）之上加一层「轨道」：地球和月球成为星图上的两个节点，'
    + '中间连着航道；发射井除了送兵，还能把<b>核心舱</b>送上轨道，展开成一座可扩建的空间站。'
    + '站上的建设不需要工程队、不需要运输——花资源就长。',
  manualNotes: [
    '<b>空间站</b>：发射井可以直接发射「核心舱」——<b>不用加注、不用装载</b>，只花资源，'
      + '点火就入轨。核心舱决定站的规模（5×5 / 7×7 / 9×9），到轨道时只有正中间一格甲板，'
      + '其余全是虚空。点核心舱的「扩建甲板」选一格挨着已有甲板的虚空，花资源铺出来；'
      + '铺好之后可以在上面造「生产舱」（每回合产金币）。'
      + '站上的建设<b>不需要工程队、不需要运输</b>，钱到位就长。',
    '<b>太空建设折扣</b>：地球上每多一座发射井，站上建设就更便宜一点——'
      + '但<b>收益递减</b>：没有井时比额定贵 50%，一座井时贵 30%，两座贵 14%，'
      + '三座基本平价，之后才开始便宜，永远到不了半价。'
      + '所以"多盖井"和"多建站"是同一条投资曲线上的两段。',
    '<b>星图</b>：左上角面板里点「查看星图」。星图把每颗星球画成一格，'
      + '连线就是航道；点星球能看到轨道上停着哪些站、有没有东西正在飞来，'
      + '还能直接「前往」那张图或那座站。点连线能看到航程与路上的东西。'
      + '只有一张图的局面没有星图可看。',
  ],
  units: [STATION_CORE, STATION_PRODUCER],
  hooks: {
    /** 空间站上的生产舱：每回合给自己主人产金币 */
    onTurnStart: ({ state, player }) => {
      tickProducers(state, player);
    },

    /**
     * 发射井多出「发射核心舱」这一组业务。
     *
     * 和基础包的「加注 / 发射」并列而不是另起一座建筑：井本来就是发射台，
     * 送人上月球和送舱段入轨是同一件设施的两项业务。
     * 这些按钮**不看燃料**——核心舱不需要加注。
     */
    unitActions: ({ state, unit, viewer }) => {
      if (unit.owner !== viewer || unit.type !== SILO_ID) return [];
      // 还没盖完的井不接活
      if ((unit.buildNeed ?? 0) > (unit.buildDone ?? 0)) return [];
      const out: UnitActionOption[] = [];
      for (const core of CORE_DEFS) {
        const cost = buildCost(state, unit.owner, core.cost);
        const afford = state.players[unit.owner].gold >= cost;
        out.push({
          id: `silo:core:${core.id}`,
          group: '空间站',
          label: core.name,
          detail: core.blurb,
          note: `${cost} 金 · 免加注`,
          disabled: !afford,
        });
      }
      return out;
    },

    onUnitAction: ({ state, unit, actionId }) => {
      if (!actionId.startsWith('silo:core:')) return `认不出这个操作：${actionId}`;
      return launchCore(state, unit, actionId.slice('silo:core:'.length));
    },

    getUnitPanelLines: ({ state, unit }) => {
      if (unit.type !== STATION_CORE_ID) return [];
      return stationLines(state, unit);
    },
  },
};

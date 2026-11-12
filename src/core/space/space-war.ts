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
import { nodeName } from './starmap.ts';
import {
  CORE_DEFS,
  STATION_CORE,
  STATION_CORE_ID,
  STATION_LIFE,
  STATION_PRODUCER,
  STATION_SOLAR,
  STATION_THRUSTER,
  CORE_POWER,
  PRODUCER_DRAW,
  SOLAR_POWER,
  THRUSTER_DRAW,
  THRUSTER_SPEED,
  beginStationSail,
  buildCost,
  launchCore,
  stationDestinations,
  stationLines,
  stationOf,
  stationPowerHtml,
  stationSailProblem,
  stationSpeed,
  tickProducers,
  tickStationTravel,
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
    '<b>舱段与能量</b>：空间站有一条<b>自己的能量账</b>（不是地球上的电网）：'
      + `核心舱自带 ${CORE_POWER} 电，每块「太阳能舱」+${SOLAR_POWER}，`
      + `每台「推进器舱」耗 ${THRUSTER_DRAW}，每座「生产舱」耗 ${PRODUCER_DRAW}。`
      + '电不够就造不出来（按钮会写明还差多少）；万一被打到过载，整站停摆——'
      + '推进器不提速、生产舱不产金。',
    '<b>维生仓</b>：造好之后，<b>半径 3 格</b>内的单位不再吃「恶劣外空环境」'
      + '（护甲不再 ÷5、移动不再减半）。航天员本来就免疫，不用罩。'
      + '覆盖是<b>按格算</b>的：站要长大就得多造几座，围着它布置才划算。'
      + '维生仓自己也是密封模块，所以它自己同样不受影响——攻打一座站时，'
      + '它往往是最难拆的那一块。',
    '<b>推进器舱</b>：必须造在核心舱的<b>下半区</b>（不是正下方，整条下缘都行）。'
      + `每台让这座站的<b>航速</b> +${THRUSTER_SPEED}。`
      + '<b>装了推进器，空间站就是飞船</b>：点核心舱出现「启航 → 目的地」，'
      + '沿航道开到别的星球轨道，站内坐标一格不动，变的只是它挂在哪颗星球上。'
      + '航程 = 航道距离 ÷ 航速（向上取整、至少 1 回合），地月距离 6，'
      + '所以 1 台推进器 3 回合、2 台 2 回合、3 台 2 回合、5 台 1 回合。'
      + '<b>推进器不影响火箭</b>：直飞月球的火箭弹道固定，1 回合到。',
    '<b>星图</b>：左上角面板里点「查看星图」。星图把每颗星球画成一格，'
      + '连线就是航道；点星球能看到轨道上停着哪些站、有没有东西正在飞来，'
      + '还能直接「前往」那张图或那座站。点连线能看到航程与路上的东西。'
      + '只有一张图的局面没有星图可看。',
  ],
  units: [STATION_CORE, STATION_PRODUCER, STATION_SOLAR, STATION_LIFE, STATION_THRUSTER],
  hooks: {
    /** 空间站上的生产舱：每回合给自己主人产金币 */
    onTurnStart: ({ state, player }) => {
      tickProducers(state, player);
      // 在航的站：只推自己的（和火箭同一个规矩）
      tickStationTravel(state, player);
    },

    /**
     * 发射井多出「发射核心舱」这一组业务。
     *
     * 和基础包的「加注 / 发射」并列而不是另起一座建筑：井本来就是发射台，
     * 送人上月球和送舱段入轨是同一件设施的两项业务。
     * 这些按钮**不看燃料**——核心舱不需要加注。
     */
    unitActions: ({ state, unit, viewer }) => {
      if (unit.owner !== viewer) return [];
      const out: UnitActionOption[] = [];

      // 发射井：发射核心舱（还没盖完的井不接活）
      if (unit.type === SILO_ID) {
        if ((unit.buildNeed ?? 0) > (unit.buildDone ?? 0)) return [];
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
      }

      /*
       * 核心舱：启航。
       *
       * 装了推进器，这座站就是**飞船**——可以沿航道去别的星球轨道。
       * 每个相邻节点一个按钮（不是技能）：技能是"选棋盘格"的，
       * 而这里选的是星图节点，两者不是一套交互。
       */
      if (unit.type === STATION_CORE_ID) {
        const rec = stationOf(state, unit);
        if (!rec) return [];
        const problem = stationSailProblem(state, rec);
        for (const d of stationDestinations(state, rec)) {
          out.push({
            id: `station:sail:${d.to}`,
            group: '启航',
            label: `启航 → ${nodeName(state, d.to)}`,
            detail: `航程 ${d.turns} 回合（航速 ${stationSpeed(state, rec)}）`,
            note: problem ?? '条件齐了',
            disabled: !!problem,
          });
        }
        return out;
      }

      return [];
    },

    onUnitAction: ({ state, unit, actionId }) => {
      if (actionId.startsWith('silo:core:')) {
        return launchCore(state, unit, actionId.slice('silo:core:'.length));
      }
      if (actionId.startsWith('station:sail:')) {
        const rec = stationOf(state, unit);
        if (!rec) return '这支部队不在任何空间站上';
        return beginStationSail(state, rec, actionId.slice('station:sail:'.length));
      }
      return `认不出这个操作：${actionId}`;
    },

    getUnitPanelLines: ({ state, unit }) => {
      if (unit.type !== STATION_CORE_ID) return [];
      return stationLines(state, unit);
    },

    /**
     * 站的能量条。
     *
     * 挂在**格子卡**上而不是 `getUnitPanelLines`：那个只能吐纯文本，
     * 而这里要的是一条能一眼看出"用掉多少"的横条（和装配坞的电力条同款）。
     * 点站里的任何一座舱段都能看到——玩家想确认"再加一台推进器会不会过载"，
     * 不该先回去点核心舱。
     */
    getTilePanelHtml: ({ state, unit }) => {
      if (!unit) return null;
      return stationPowerHtml(state, unit);
    },
  },
};

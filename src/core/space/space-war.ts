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
import { nodeName, starmapOf } from './starmap.ts';
import {
  COMM_CAP,
  COMM_PER,
  CORE_DEFS,
  GRAVITY_CAP,
  GRAVITY_PER,
  MATERIAL_CAP,
  MATERIAL_PER,
  STATION_ARMOR,
  STATION_CANNON,
  STATION_CANNON_ID,
  STATION_COMM,
  STATION_DOCK,
  STATION_DOCK_ID,
  STATION_LAUNCH,
  STATION_LAUNCH_ID,
  STATION_LAB_GRAVITY,
  STATION_LAB_MATERIAL,
  STATION_LIFE,
  STATION_LAB_GRAVITY_ID,
  STATION_LAB_MATERIAL_ID,
  STATION_COMM_ID,
  STATION_CORE,
  STATION_CORE_ID,
  STATION_PRODUCER,
  STATION_REMOTE,
  STATION_SOLAR,
  STATION_THRUSTER,
  activeModuleCount,
  CANNON_ATK,
  CORE_POWER,
  PRODUCER_DRAW,
  SOLAR_POWER,
  THRUSTER_DRAW,
  THRUSTER_SPEED,
  beginStationSail,
  buildCost,
  cannonActions,
  combatLines,
  combatUnitAction,
  dockActions,
  launchActions,
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
    '<b>功能舱段</b>：遥感模块、微重力研究室、材料研究室、通讯模块——'
      + '它们<b>必须有一名航天员贴着（上下左右相邻）才会工作</b>，'
      + '没人值守就是一个箱子：不加成、技能也放不出来。'
      + '航天员自己免疫外空环境，所以"派个人上去值班"是这些舱段的前置条件。',
    '<b>遥感模块</b>：技能「星球表面观测」——从轨道上对<b>脚下这颗星球</b>做一次观测，'
      + '选一格，点亮它和上下左右共 5 格，本方从此看得见那片地方（情报永久有效，'
      + '同一座模块再观测会替换上一次）。<b>每回合 1 次</b>，用掉之后要点技能按钮会提示"回一发"。',
    `<b>微重力研究室</b>：每座让本方<b>总金币收入 +${Math.round(GRAVITY_PER * 100)}%</b>，`
      + `多座叠加，上限 +${Math.round(GRAVITY_CAP * 100)}%。`,
    `<b>材料研究室</b>：每座让本方<b>所有单位护甲 +${MATERIAL_PER}</b>，上限 +${MATERIAL_CAP}。`
      + '这条加成是<b>给地球上的部队</b>准备的：站内单位仍在「恶劣外空环境」里，'
      + '那 ÷5 会把它吃掉——空间站里的装甲挡不住没有空气，这不是算错。',
    `<b>通讯模块</b>：每座让本方<b>所有单位视野 +${COMM_PER}</b>，上限 +${COMM_CAP}。`,
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
    /* ── 战斗：P2f ── */
    '<b>看得到的和看不到的</b>：敌方空间站的<b>外形</b>是公开的——甲板铺到了哪、'
      + '哪里被打穿了破口，都画在地图上。但里面装了什么<b>只有核心舱看得见</b>：'
      + '舱段位置、类型、还剩多少血，一律不显示。所以打别人的站，是<b>盲打</b>。',
    '<b>轨道炮舱</b>：功能舱段（要航天员相邻、要电）。技能「轨道轰击」——'
      + '对<b>同一轨道</b>上的一座敌方空间站选一格打一发，每回合 1 次，'
      + `伤害 ${CANNON_ATK}（照常扣护甲）。<b>打不到核心舱</b>（那一格连点都点不亮）。`
      + '同一轨道上有两座以上敌方站时，先在面板上「瞄准」一座；只有一座时自动瞄上。'
      + '打中舱段就结算伤害，<b>打空就把那一格的甲板打穿</b>。',
    '<b>破损舱段</b>：被打穿的甲板。它能走人（一格顶两格）、能人从它旁边继续铺甲板，'
      + '但<b>站不住舱段</b>（地板都没了）。修复走核心舱的「扩建甲板」，价格和铺一格虚空一样。'
      + '想拆一座站，就得先打出一串破口。',
    '<b>太空装甲</b>：不吃电，血厚甲硬（生命 180 / 护甲 14）。它的作用很朴素——'
      + '<b>它站在那儿</b>：轨道轰击选中的格子上只要有东西，就打那个东西。'
      + '所以把装甲铺在要保住的甲板上，炮就只能打在它身上。它自己那格甲板也不会被打穿。',
    '<b>出舱口</b>：把一个<b>相邻</b>的单位打出去，送到同一轨道上：'
      + '<b>我方空间站的入舱口</b>（有空位时），或<b>敌方空间站的破损舱段</b>（就是登船）。'
      + '每座出舱口每回合 1 次。送进破口的人当回合不能动；送进入舱口的人要等一回合才能卸下来。'
      + '舱段（建筑）不能装进舱门——只有人过得去。',
    '<b>入舱口</b>：接收同轨道我方出舱口送来的人，最多<b>缓存 3 个</b>，'
      + '满了就拒绝进入。缓存的人不在棋盘上——看不见、打不到、也不吃外空环境，'
      + '要让他们干活，得点「卸下」放到隔壁的空甲板上（旁边没空位就下不来）。'
      + '舱门被打掉时，里面的人也一起没了。',
  ],
  units: [
    STATION_CORE,
    STATION_PRODUCER,
    STATION_SOLAR,
    STATION_LIFE,
    STATION_THRUSTER,
    STATION_REMOTE,
    STATION_LAB_GRAVITY,
    STATION_LAB_MATERIAL,
    STATION_COMM,
    STATION_CANNON,
    STATION_ARMOR,
    STATION_LAUNCH,
    STATION_DOCK,
  ],
  hooks: {
    /** 空间站上的生产舱：每回合给自己主人产金币 */
    /**
     * 材料研究室：本方**所有单位**护甲 +1/座，上限 +5。
     *
     * 走普通的 `modifyArmor`（和环境除法之前那些加成同一条路）——这条加成
     * **本来就是给地球上的部队用的**：站里那点空间，装甲板再好也挡不住没有空气，
     * 所以它在站内会被「恶劣外空环境」÷5 吃掉，这是有意的，不是漏洞。
     */
    modifyArmor: ({ state, defender, armor }) => {
      const n = Math.min(MATERIAL_CAP, activeModuleCount(state, defender.owner, STATION_LAB_MATERIAL_ID));
      return n > 0 ? armor + n * MATERIAL_PER : armor;
    },

    /** 通讯模块：本方所有单位视野 +1/座，上限 +3 */
    modifyVision: ({ state, player, base }) => {
      const n = Math.min(COMM_CAP, activeModuleCount(state, player, STATION_COMM_ID));
      return n > 0 ? base + n * COMM_PER : base;
    },

    /**
     * 微重力研究室：本方总金币收入 +5%/座，上限 +20%。
     *
     * 按**比例**而不是固定值：收入随城市和地形涨，固定值到后期就等于没有。
     */
    modifyIncome: ({ state, player, income }) => {
      const n = activeModuleCount(state, player, STATION_LAB_GRAVITY_ID);
      if (n <= 0) return income;
      const rate = Math.min(GRAVITY_CAP, GRAVITY_PER * n);
      return Math.round(income * (1 + rate));
    },

    onTurnStart: ({ state, player }) => {
      tickProducers(state, player);
      // 在航的站：只推自己的（和火箭同一个规矩）
      tickStationTravel(state, player);
    },

    /**
     * 敌方空间站：只看得到"壳"，看不到里面装了什么。
     *
     * 甲板铺到哪是公开的（`playerView` 里站内所有格本来就全可见），所以
     * "这座站有多大、哪里有破口"玩家一直知道。但舱段装在哪、装的是什么，
     * 只有核心舱例外——核心舱是整座站的中心，看不见它就没法判断该往哪儿打。
     *
     * 于是轨道轰击是**盲打**：选一格，打中舱段算你运气好，打空就是打穿甲板。
     * 这条规矩把"太空装甲铺在哪"变成了一个真正的决定。
     */
    hideUnit: ({ state, unit, viewer }) => {
      const board = unit.board;
      const st = board ? starmapOf(state)?.stations.find((x) => x.board === board) : undefined;
      if (!st) return false;
      if (st.owner === viewer) return false;
      return unit.type !== STATION_CORE_ID;
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

      // 战斗舱段：炮口转向 / 出舱口发射 / 入舱口卸人
      if (unit.type === STATION_CANNON_ID) return cannonActions(state, unit);
      if (unit.type === STATION_LAUNCH_ID) return launchActions(state, unit);
      if (unit.type === STATION_DOCK_ID) return dockActions(state, unit);

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
      if (actionId.startsWith('station:aim:')) return combatUnitAction(state, unit, actionId);
      if (actionId.startsWith('station:launch:')) return combatUnitAction(state, unit, actionId);
      if (actionId.startsWith('station:unload:')) return combatUnitAction(state, unit, actionId);
      return `认不出这个操作：${actionId}`;
    },

    getUnitPanelLines: ({ state, unit }) => {
      if (unit.type === STATION_CORE_ID) return stationLines(state, unit);
      // 战斗舱段各有各的账（瞄着谁、舱里几个人、本回合还能不能发射）
      return combatLines(state, unit);
    },

    /**
     * 站的能量条。
     *
     * 挂在**格子卡**上而不是 `getUnitPanelLines`：那个只能吐纯文本，
     * 而这里要的是一条能一眼看出"用掉多少"的横条（和装配坞的电力条同款）。
     * 点站里的任何一座舱段都能看到——玩家想确认"再加一台推进器会不会过载"，
     * 不该先回去点核心舱。
     */
    getTilePanelHtml: ({ state, unit, viewer }) => {
      if (!unit) return null;
      /*
       * 只给自己的东西画能量条。
       *
       * 对面站里的舱段本来就不下发（`hideUnit`），于是"按视图状态现算"的能量账
       * 会拿只剩一个核心舱的数据算出"供电 10 / 已用 0"——那不是情报，那是错数。
       * 与其显示一个假的余量，不如不显示。
       */
      if (unit.owner !== viewer) return null;
      const power = stationPowerHtml(state, unit);
      if (!power) return null;
      /*
       * 改名挂在**核心舱的单位卡**上，而不是星图里。
       *
       * 星图上要「点开星图 → 点星球 → 再点改名」，三步才到；而玩家改名的时机
       * 基本是"我正在看这座站"。所以放在它自己的卡片上，和扩建、建舱段在一起。
       * 只给核心舱：站在生产舱上点"改名"，会让人以为改的是那座舱段。
       */
      const rec = stationOf(state, unit);
      const rename =
        rec && unit.type === STATION_CORE_ID && unit.owner === viewer
          ? `<button class="btn btn-sm" data-act="star-rename" data-id="${rec.board}" title="给这座空间站起个名字">给空间站改名</button>`
          : '';
      return power + rename;
    },
  },
};

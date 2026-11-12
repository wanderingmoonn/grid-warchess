/**
 * 「太空时代」——第一个真正跨到地球之外的扩展。
 *
 * 它现在做四件事：
 *   1. **开局生成月球图**（`moon.ts`）；
 *   2. **火箭发射井**（`silo.ts`）：时代 5 的建筑，2×2，装一个地面单位，
 *      加注 3 回合之后把它送上月面着陆点；
 *   3. **月球基地与月壤采样**（`moon-base.ts`）：工程单位落地展开，采样 3 回合取胜；
 *   4. **月面战斗**（2026-11-11 接上）：开火、射程、地形掩护、溅射全部按图结算，
 *      所以对手可以再派一支兵登月、把基地拆掉——登月不再是单向不可逆的。
 *
 * 月球图**不放城市**——所以城市的产兵、升级、胜负判定一行都不用改。
 * 攻城与装卸仍然只认地球：月球上没有城，也没有带 hold 的东西。
 */

import type { Expansion, UnitActionOption } from '../expansions.ts';
import { createMoonBoard, MOON_MIN_SIZE, MOON_SIZE_RATIO } from './moon.ts';
import {
  ROCKET_SILO,
  SILO_FUEL_TURNS,
  SILO_ID,
  announceBuiltSilos,
  launchProblem,
  launchIntoLane,
  siloLines,
  startFueling,
  tickSilos,
} from './silo.ts';
import {
  MOON_BASE,
  MOON_BASE_ID,
  SAMPLE_TURNS,
  deployBase,
  deployProblem,
  interruptSampling,
  lunarWinner,
  moonBaseLines,
  samplingsOf,
  tickMoonBases,
} from './moon-base.ts';
import { boardIdOf } from '../board.ts';
import { MOON_BOARD } from './moon.ts';
import { createStarmap, MOON_LANE_TURNS, starmapOf } from './starmap.ts';
import { tickTransit, transitCountOf } from './transit.ts';

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
  blurb: '月球、发射井与登月胜利：把工程队送上月面。',
  summary:
    '开局在地球之外生成一张<b>月球图</b>：尺寸约为地球的 '
    + `${Math.round(MOON_SIZE_RATIO * 100)}%，最小 ${MOON_MIN_SIZE}×${MOON_MIN_SIZE}；`
    + '地形只有月壤与环形山，没有城市。'
    + '左下角的地图列表可以在两张图之间切换，每张图各记各的相机。'
    + '<b>时代 5 可以修「火箭发射井」</b>（2×2、建在平原）：装一个地面单位，'
    + `加注 ${SILO_FUEL_TURNS} 回合后点火，进入<b>地月航道</b>，${MOON_LANE_TURNS} 回合后落到月面。`
    + '把一支<b>工程单位</b>送上去，它能在月面展开成 2×2 的<b>月球基地</b>；'
    + `基地的主动技能「月壤采样」${SAMPLE_TURNS} 个回合后把结果送回地球——<b>结果一到就赢</b>。`,
  scale: 'large',
  manualNotes: [
    `月球尺寸 = max(${MOON_MIN_SIZE}, round(地球边长 × ${MOON_SIZE_RATIO}))，`
      + '例如 12×12 的地球对应 9×9 的月球、16×16 对应 12×12。',
    '月壤：1 点移动力、无掩护；环形山：2 点移动力、护甲 +2。',
    '月球上不放城市——城市的产兵、升级与"城打光就输"的判定只作用于地球。',
    '<b>火箭发射井</b>：时代 5、2×2、只能建在平原，420 金。它有一个货舱，'
      + '贴着它点「装载」把一个地面单位接进来（船、飞机、建筑上不去）。',
    `加注是<b>计时器</b>：点一下「加注燃料」开始，之后每回合 +1，满 ${SILO_FUEL_TURNS} 回合才能点火。`
      + '发射后燃料清零，要再飞一趟就重新加注。'
      + '<b>进度是公开的</b>：每回合发一条战报（加注 1/3、2/3…），对手读得到你还有几回合就飞。',
    '<b>航道</b>：地球和月球之间连着一条地月航道，点火之后单位进入航道飞 '
      + `${MOON_LANE_TURNS} 个回合——顶栏会出现「红方 火箭 ${MOON_LANE_TURNS}」，双方都看得见。`
      + '在途的单位不在任何棋盘上，<b>打不到</b>：航道只计时，不是战场。'
      + '落地之后当回合不能动。',
    '<b>井藏不住</b>：发射井一建成就会在敌方视野里点亮一整个敌方回合；'
      + '加注期间每回合都会重新点亮（烟柱一直冒）。<b>不加注的旧井不亮</b>——'
      + '所以"建好先放着"是一种真实的欺骗。',
    '落地在<b>离月球中心最近的一块空地</b>，当回合不能再动。发射井与月球都不会被消耗。',
    '<b>登月胜利</b>：工程单位在月面点「展开月球基地」（2×2、200 血、12 甲、视野 5，'
      + '并且<b>四格都得是月壤平地</b>——环形山不算，站错了先挪一格；'
      + '落地那回合不能采样），然后点基地的「月壤采样」；'
      + `${SAMPLE_TURNS} 个<b>自己的</b>回合后结果送回，直接获胜。整局只能做一次。`
      + '顶栏给<b>每一方各显示一条</b>「红方 登月 3」——你能随时读到对手还差几回合。'
      + '<b>基地挨打就作废</b>：采样进度清零、要重新点——所以登月之后必须留人守。',
    '月面上的部队可以正常走动、正常开火：寻路、地形消耗、占格、射程、地形掩护、溅射'
      + '全都按<b>月球那一份</b>算。**地球和月球之间打不到**——坐标再近，中间也隔着一个天空。'
      + '攻城与装卸仍然只在地球（月球上没有城，也没有能装东西的船）。',
    '<b>对手能打回去了</b>：再派一支兵登月、贴到基地边上把它拆掉，采样就作废'
      + '（基地 200 血 12 甲，不是一炮能拆的，所以登月之后要守）。'
      + '反制不止一条路：也可以在<strong>发射之前</strong>拆掉发射井、或者杀掉等舱的那支工程单位。',
  ],
  units: [ROCKET_SILO, MOON_BASE],
  hooks: {
    onMatchStart: ({ state }) => {
      // 会盖房的人先学会盖井（没开太空包的局连这个类型都没有，见上面）
      teachBuilders(state);
      // 已经有月球就别重复生成（导入存档、重开同一局）
      if (!state.boards?.moon) {
        state.boards ??= {};
        state.boards.moon = createMoonBoard(state.w, state.seed);
      }
      /*
       * 星图：月球有了就补一张"地球 ↔ 月球"的图。
       *
       * 老存档（11-12 之前）没有这个字段，`starmapOf` 会在第一次用到时
       * 按现有棋盘补一张——这里先建好，读档之后面板、发射井立刻能用。
       */
      state.starmap ??= createStarmap({ moon: !!state.boards.moon });
      starmapOf(state);
    },

    /**
     * 采样挨打就作废。
     *
     * 走 `onUnitDamaged`（伤害已经写进 hp、死亡还没判）而不是能力钩子：
     * 基地是建筑，没有"能力"，这条是**这个扩张的规则**，不该长在兵种上。
     */
    onUnitDamaged: ({ state, unit, source }) => interruptSampling(state, unit, source),

    /** 加注是"我方后勤"：每回合推进自己那些正在加注的井 */
    onTurnStart: ({ state, player }) => {
      tickSilos(state, player);
      // 在途的火箭：只推自己的（路上的东西归主人管）
      tickTransit(state, player);
      tickMoonBases(state, player);
    },

    /**
     * 回合结束再喊一次"新井立起来了"。
     *
     * 施工可能就在这个回合里完成（对面回合里被补完，或者你刚盖好）。
     * 只在回合开始喊会漏掉它，对手那一整回合都看不见——"井藏不住"就白写了。
     * 这里喊完正好赶上交给下一位：`s.current` 已经换人，点亮立刻生效。
     */
    onTurnEnd: ({ state, player }) => {
      announceBuiltSilos(state, player);
    },

    /**
     * 登月胜利：月球基地的采样结果一送回就赢。
     *
     * **没有就返回 undefined**（不是 null）：核心那句是
     * `if (winner !== undefined) return winner`，返回 null 会把后面的
     * "城打光就输"整个跳过——一个没有基地的局面会因此永远判不出胜负。
     */
    checkWinner: (state) => lunarWinner(state),

    unitActions: ({ state, unit, viewer }) => {
      if (unit.owner !== viewer) return [];

      /*
       * 工程单位在月面上 → 展开基地。
       *
       * 月面还不能施工（位置类动作只认地球），所以这里不走 BUILD，
       * 而是"落地即展开"：消耗这支工程单位，原地长出 2×2 的基地。
       */
      if (boardIdOf(unit) === MOON_BOARD && state.unitTypes[unit.type]?.category === 'builder') {
        const problem = deployProblem(state, unit);
        return [
          {
            id: 'base:deploy',
            group: '月面作业',
            label: '展开月球基地',
            detail: '把这支工程单位并进 2×2 的月球基地；基地落成后可以开始月壤采样',
            note: problem ?? '2×2',
            disabled: !!problem,
          },
        ];
      }

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
          ? `把货舱里的「${state.unitTypes[cargo[0]!.type]?.name ?? cargo[0]!.type}」送进航道`
          : '货舱是空的：先点「装载」接一个地面单位进来',
        note: problem ?? '条件齐了',
        disabled: !!problem,
      });
      return out;
    },

    onUnitAction: ({ state, unit, actionId }) => {
      if (actionId === 'base:deploy') return deployBase(state, unit);
      if (unit.type !== SILO_ID) return '这里没有发射井';
      if (actionId === 'silo:fuel') return startFueling(state, unit);
      if (actionId === 'silo:launch') return launchIntoLane(state, unit);
      return `认不出这个操作：${actionId}`;
    },

    // viewer 要传：给对手看的那份要裁掉"装的是谁"（见 siloLines）
    getUnitPanelLines: ({ state, unit, viewer }) => {
      if (unit.type === MOON_BASE_ID) return moonBaseLines(state, unit, viewer);
      const lines = siloLines(state, unit, viewer);
      // 落在月面的工程单位：提示它能展开基地（否则玩家不知道下一步该干什么）
      if (viewer === unit.owner && boardIdOf(unit) === MOON_BOARD && state.unitTypes[unit.type]?.category === 'builder') {
        const problem = deployProblem(state, unit);
        lines.push(problem ? `这里还不能展开基地：${problem}` : '可以点「展开月球基地」把这一趟变成胜利的第一步');
      }
      return lines;
    },

    /**
     * 顶栏的登月倒计时。
     *
     * 给**双方**看：进攻方要看到自己还剩几回合，防守方要看到一个"再不拦就输了"
     * 的红色提醒——这条压力正是 3 回合窗口存在的意义。
     */
    /**
     * 顶栏倒计时：**每一方一条**。
     *
     * 以前只显示找到的第一座，于是两人同时登月时有一个人的进度是隐形的。
     * 这条胜利条件是"谁先送回谁赢"，两边的倒计时得并排摆着才像一场竞赛。
     * 文本带名字（默认就是"红方/蓝方"，不占几个字）：两个「登月 2」并排
     * 谁也分不清是谁的。
     */
    topbarBadges: ({ state }) => {
      const out: Array<{ id: string; text: string; hint: string }> = [];
      for (const info of samplingsOf(state)) {
        if (info.done) continue;
        const who = state.players[info.owner].name;
        out.push({
          id: `space-lunar-${info.owner}`,
          text: `${who} 登月 ${info.left}`,
          hint:
            `${who}的月壤采样还有 ${info.left} 个回合送回，一到就赢；` +
            '基地一挨打就作废，所以贴上去打一下也是有效的反制',
        });
      }
      /*
       * 在途的火箭也是**公开**的：天上飞着的东西藏不住，
       * 而且对手得读得到"还有几回合到"，才谈得上在落点等它。
       * 每方一条（取最近的那一枚），不按人头刷屏。
       */
      for (const owner of ['A', 'B', 'C', 'D'] as const) {
        if (transitCountOf(state, owner) === 0) continue;
        const trips = (state.transit ?? []).filter((t) => t.owner === owner);
        const soonest = Math.min(...trips.map((t) => Math.max(0, t.left)));
        const who = state.players[owner].name;
        out.push({
          id: `space-transit-${owner}`,
          text: `${who} 火箭 ${soonest}`,
          hint:
            `${who}有 ${trips.length} 枚火箭在航道上，最快 ${soonest} 个回合后落地；` +
            '落点固定写在发射井面板上，可以在那里等它',
        });
      }
      return out;
    },
  },
};

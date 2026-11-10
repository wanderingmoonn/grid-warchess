/**
 * 侧栏面板。
 *
 * 原则：只展示 playerView 过滤后的信息。
 * 迷雾下"敌方还剩几个单位""对方金币多少"这类全局统计一律不显示，
 * 否则迷雾就白做了。城市归属和耐久是公开信息（城墙就在那儿）。
 */

import {
  CATEGORY_NAME,
  CONFIG,
  UNIT_TYPES,
  ORDER_UPGRADE,
  buildCostOf,
  buildPowerOf,
  eraDef,
  navigable,
  passable,
} from '../core/config.ts';
import { canPay, costLabel, resourceShort } from '../core/resources.ts';
import { buildListOf, type BuildList } from '../core/build-list.ts';
import { holdOf } from '../core/carry.ts';
import { carrierBlock } from './carrier-block.ts';
import { draftedCardsHtml } from './draft-panel.ts';
import {
  MODULES,
  canMount,
  canRecharge,
  canUseDevice,
  chargesLeft,
  deviceTargetOf,
  devicesOf,
  energyBreakdown,
  fitsFrame,
  moduleSpecText,
  modulesOf,
  offlineModules,
  rechargeQuote,
  unitDraw,
} from '../core/armor.ts';
import { canProduce, isProducer, produceEveryTurns } from '../core/produce.ts';
import { expansionById, unitSourceOf, activeExpansions } from '../core/expansions.ts';
import { canUseType, eraWindowOk, upgradeUnlocks } from '../core/draft.ts';
import { PACK_ALL, packLabel, packOk, packRow, ERA_ALL, eraChipRow, eraLabel, eraOk } from './packs.ts';
import { buildMatchReport, type ReportSide } from '../core/report.ts';
import type { PlayerView } from '../core/fog.ts';
import {
  describeTerrain,
  describeUnit,
  ELEMENT_EFFECT,
  TERRAIN_INFO,
  unitStatLine,
} from '../core/info.ts';
import {
  airLayer,
  attacksLeftOf,
  attacksPerTurn,
  splashRadiusOf,
  splashRatioOf,
  buildingAt,
  citiesOf,
  cityById,
  cityName,
  cityRegenOf,
  cityTiles,
  disbandRefundOf,
  distToCity,
  effectiveRange,
  effectiveStats,
  elementOf,
  maxHpOf, 
  magicAtkOf,
  magicResOf,
  hasQuit,
  isEliminated,
  orderedStatuses,
  STATUS_REGISTRY,
  heroSkillsOf,
  isAirborne,
  ordersOf,
  produceAt,
  recruitResCost,
  recruitSpawnCells,
  incomeResOf,
  unitYield,
  unitsOf,
  utype,
  adjacentRequirementText,
  hidesInFog,
  hiddenFromAllFoes,
} from '../core/rules.ts';
import { upgradeTargetOf } from '../core/era-routes.ts';
import { seatsOf } from '../core/types.ts';
import { skillsOf } from '../core/query.ts';
import type { GameState, PlayerId, ProduceSource, Unit, UnitTypeDef } from '../core/types.ts';
import { ELEMENT_NAME } from '../core/types.ts';
import { chimeLabel } from './sound.ts';

export interface PanelInput {
  view: PlayerView;
  me: PlayerId;
  selectedUnit: Unit | null;
  selectedCityId: string | null;
  /** 选中的军营（自己的军营点开就是产兵面板） */
  selectedCampId: string | null;
  /** 点空地时选中的地形，用来显示地形说明 */
  selectedTile: { x: number; y: number } | null;
  /**
   * 强制模式的当前档位（null = 没开）。
   *
   * 它是**持续**的模式，不是"给下一次点击上膛"：开着的时候棋盘上的点击
   * 只按这一个动词解释，不选中、不下别的指令，再点一次按钮才退出。
   * 和按住 Alt/Shift 是两条路——键盘党按修饰键（一次性），
   * 触屏和鼠标党点这两个按钮。状态放在 main 里，面板只负责显示"现在是哪一档"。
   */
  forceMode?: 'move' | 'attack' | null;
  /** 撤回栈里还有没有东西（联机局提交过也会清空）；不传按 false 处理 */
  canUndo?: boolean;
  /** 回合提示音的音量（0~1），按钮上直接显示档位 */
  chimeVolume?: number;
  /**
   * 产兵搜索框里的字。
   *
   * 高时代一屏能站四十多个兵种，靠滚动找"长弓手"要翻半天。
   * 这里只做**过滤**，不改变"能买什么"——可买集合仍然由时代和编制决定。
   */
  recruitQuery?: string;
  /**
   * 按扩展包筛选产兵列表。
   *
   * 空串 = 全部；`core` = 原版兵种；其它值是扩展 id。
   * 和搜索框是"与"的关系：搜 "弓" + 只看「奇想·骑士」，就是那个包里名字带弓的。
   */
  recruitPack?: string;
  /**
   * 按时代筛选产兵列表（`ERA_ALL` = 不筛）。
   *
   * 和生产无关：时代窗口决定"能造什么"，这里只决定"看得到什么"。
   * 和扩展包、搜索框都是**与**的关系——三个条件叠在一起才是最终那一屏。
   */
  recruitEra?: number;
  /**
   * 战报用谁的眼睛看：给一个 PlayerId 就只看这一方（+ 公开的战损），
   * 给 null 就是全都看得见。不传按"全都看得见"处理。
   *
   * 为什么要和 `me` 分开：热座是一台机器两个人轮流玩，
   * 谁都没有理由被蒙在鼓里，那时候 me 仍然是某一方，但战报该全给。
   */
  logSide?: PlayerId | null;
  /**
   * 正在给水军选下水点：给的是"正在等位置的那个兵种"。
   *
   * 临水的城挨着好几片水时，光按产兵按钮不知道该从哪片下水，所以先上膛、
   * 把可选格点亮，玩家点哪格就从哪格出。这个字段只用来写提示语。
   */
  spawnPick?: { type: string } | null;
  /**
   * 观战位：两边都不归我。
   *
   * 只有这一条开关是不够的——必须**同时**让 `mine` 全线失效，
   * 否则 me()='A' 会让 A 方的单位长出一整排"产兵/建造/拆除"按钮，
   * 点下去再被规则挡住，体验上等于一个坏掉的界面。
   */
  spectator?: boolean;
  /**
   * 复盘回放：这是在**看别人的棋**，不是在对局里。
   *
   * 行为上等价于观战（`readOnly` 全线生效），但文案要分开：
   * 说"观战中"会让玩家以为有人在对面坐着；复盘里既没有对手也没有回合，
   * 只有"这是第几步"。所以这一位只改提示语，不改权限。
   */
  replay?: boolean;
  /**
   * 指挥官模式：走位与开火归 AI，棋盘只剩"看"。
   *
   * 和 spectator 一样让 `mine` 全线失效（否则己方单位会长出一整排按钮，
   * 点下去再被规则挡住，等于一个坏掉的界面），区别只在提示文案：
   * 观战是"两边都不归我"，指挥官是"归我，但这一手不亲自下"。
   */
  commander?: boolean;
  /**
   * 参谋部正在批量执行（指挥官模式）。
   *
   * 这段里"结束行动"那个按钮要换成进度/中断状态：批处理自己会推进回合，
   * 这时候再让人点一次"结束行动"就是两只手同时推同一扇门。
   */
  commanderRunning?: boolean;
  /** 一批打几个回合：单机 5、联机 1（对面是人的时候只推自己这一回合） */
  commanderRounds?: number;
  /**
   * 双人热座指挥官：两个人轮流用同一台机器，所以底栏那颗按钮是「提交作战计划」，
   * 而不是「执行 5 回合」——两边都交完才开推。
   */
  planHotseat?: boolean;
  /** 自己这一批交了没有（热座模式用来把按钮文案换成「已提交，等对方」） */
  planReady?: boolean;
  /**
   * 结算卡上的「对局数据」区块。只有一局打完才传，别的时候是 undefined。
   *
   * 默认关：上传对局数据这件事必须玩家自己勾、自己点，
   * 而且点之前得先看见"要交出去的是哪些东西"。
   */
  report?: PanelReport;
  /**
   * 这一局打完了，可以出战报卡。
   *
   * 为什么不复用 `report` 那个开关：结算卡有三条排除（沙盒 / 观战位 / 还在打），
   * 其中「沙盒」正是上帝模式——那偏偏是自家玩得最多的地方。把战报卡挂在 `report`
   * 上，等于"越常用的模式越看不到产出"。这两个区块的可见条件本来就不该是同一个。
   */
  battleCard?: boolean;
}

export interface PanelReport {
  /** 「允许上传对局数据」这个开关本身，存在本机、跨对局保留 */
  optedIn: boolean;
  status: 'idle' | 'sending' | 'done' | 'failed';
  /** 上传结果的具体结论，原样显示——不要只说"出错了" */
  note?: string;
  /** 失败之后玩家还能做什么 */
  howTo?: string;
  /**
   * 这一局有没有逐回合摘要，以及规模。
   *
   * 空字符串 = 这局没开详细记录（只交终局快照）。有值时显示成一行，
   * 让玩家知道"我同意交的东西比上次多了什么"，而不是悄无声息地变大。
   */
  detail?: string;
}

/**
 * 侧栏最近一次写下去的 HTML。
 *
 * 一帧里侧栏的开销几乎全在"把这些字符串变成 DOM"上（实测 32×32：整段 1.7ms，
 * 其中拼字符串只有 0.05ms）。而大部分 render 的触发和侧栏无关——棋盘上换了选中、
 * 顶栏换了回合、AI 走了一步但金币和战报都没动。内容一模一样还重写一遍，
 * 等于每帧白扔一百多个节点，还把滚动位置和正在输入的搜索框一起弄没。
 *
 * 所以先拼、后比、一样就不写。判"一样"用的是拼出来的整串，不是另做一份摘要：
 * 摘要漏一个字段就会让面板停在旧内容上，那种 bug 比慢难查得多。
 */
const panelHtmlCache = new WeakMap<HTMLElement, string>();

/**
 * 让缓存作废。
 *
 * 侧栏被别人直接写过之后必须调一次（上帝模式的兵种货架就是这么干的）：
 * 缓存里留着"上一次的普通面板"，下一帧内容碰巧一样就会跳过写入，
 * 货架会一直挂在屏幕上，而状态里一切正常——这类 bug 极难复现。
 */
export function invalidatePanel(el: HTMLElement): void {
  panelHtmlCache.delete(el);
}

export function renderPanel(el: HTMLElement, input: PanelInput): void {
  const html = panelHtml(input);
  // firstChild 一起看：侧栏被清空过（但没走 invalidatePanel）时不能凭缓存跳过
  if (panelHtmlCache.get(el) === html && el.firstChild) return;
  panelHtmlCache.set(el, html);
  el.innerHTML = html;
}

function panelHtml(input: PanelInput): string {
  const { view, me } = input;
  const s = view.state;
  /**
   * 「浓雾蔽野」把"看不清对面"当成规则本身，钱袋也得跟着看不见。
   *
   * 只看数量不给数字：雾里连地形都要走一遍才记得住，隔壁还剩多少钱更不该
   * 摆在 HUD 上——那等于免费送一份"他还能不能再买一队兵"的情报，
   * 玩家照着这个数决定要不要趁现在压过去，雾就白做了。
   * 观战位例外：它本来就是全图视角（顶栏写着"全图视角"），遮一半反而自相矛盾。
   */
  const blackout = s.config.expansionIds.includes('blackout');
  const hideEnemyGold = (p: PlayerId) => blackout && p !== me && input.spectator !== true;

  // HUD 里的资源行：金币永远显示，其余资源只在"真的存在"时出现。
  // 原版只玩金币，多出来的空徽章只会让面板看起来像坏了。
  const resLine = (p: PlayerId) => {
    const ps = s.players[p];
    const parts = [
      hideEnemyGold(p)
        ? '<span title="「浓雾蔽野」下打探不到对面的钱袋">金币 ?</span>'
        : `金币 ${ps.gold}`,
    ];
    for (const [id, n] of Object.entries(ps.res ?? {})) {
      if (!n || n <= 0) continue;
      if (id === 'gold') continue;
      parts.push(`${resourceShort(id)} ${n}`);
    }
    return parts.join(' · ');
  };
  const spectator = input.spectator === true;
  /**
   * 这一席是不是已经认输退出。
   *
   * 三人四人局里认输只退出自己，对局还在继续打（见 rules 的 doSurrender），
   * 所以界面必须能说出"你已经不在这局里了"。以前这块什么都不说：
   * 认输之后顶栏继续写"等待 XXX"，兵和城还在棋盘上（那是对手的战利品），
   * 看上去像卡住了。
   */
  const quit = !spectator && hasQuit(s, me);
  /*
   * 出局的另一种：最后一座城被人接管了。盘上的兵会被规则层撤走（见 rules 的
   * `retireLostSeat`），但界面以前什么也不说——顶栏继续写"等待 XXX"，
   * 玩家盯着一支已经不属于自己的军队，不知道自己在看什么。
   *
   * 只在多人局认这条：两人局城破就是终局，结算画面照旧。
   */
  const lostAll = !spectator && !quit && seatsOf(s).length > 2 && isEliminated(s, me);
  /** 只看不给动：观战位、已退出、城全丢光、指挥官模式都算，后面所有 `mine` 都挂在它上面 */
  const readOnly = spectator || quit || lostAll || input.commander === true;
  const myTurn = !spectator && !quit && !lostAll && s.current === me && !s.winner;


  const turnBadge = s.winner
    ? `<span class="turn-badge">对局结束</span>`
    : spectator
      ? `<span class="turn-badge watching">${input.replay ? '复盘 · 全图视角' : '观战中 · 全图视角'}</span>`
      : quit
        ? `<span class="turn-badge watching">你已认输 · 观战中</span>`
        : lostAll
          ? `<span class="turn-badge watching">你的城全丢了 · 观战中</span>`
          : `<span class="turn-badge active-${s.current}">
         ${s.current === me ? '轮到你行动' : `等待 ${s.players[s.current].name}`}
       </span>`;

  const detail = renderDetail(input, myTurn);
  const logHtml = renderLog(input);

  // 蛋等着落位：这条提示必须显眼。它是"你的回合被暂停了"的状态，
  // 不写在最上面的话，玩家会以为点了没反应。
  const egg = s.pendingEgg;
  const eggMine = !!egg && !readOnly && egg.owner === me && s.current === me;
  const eggBanner = !egg
    ? ''
    : `<div class="card" style="border-color:#c9a227">
         <div class="card-title">${eggMine ? '选一格孵化' : '蛋在等着'}</div>
         <div class="hint">${
           eggMine
             ? `不死鸟的蛋落在 ${String.fromCharCode(65 + egg.x)}${egg.y + 1} 附近。点棋盘上的橙格放它，孵化后带 ${Math.round(egg.hpRatio * 100)}% 生命。`
             : `${s.players[egg.owner].name} 手里还有一枚没孵化的蛋。`
         }</div>
       </div>`;

  const activeNames = s.config.expansionIds
    .map((id) => expansionById(id)?.name)
    .filter((n): n is string => !!n);
  const expansionText = activeNames.length > 0 ? activeNames.join(' · ') : '无';

  /*
   * 席位条：两家时是两行，三家四家时就是三行四行。
   *
   * 以前这里是硬编码的"A vs B"——三人局里第三个人根本不会出现在这一栏里。
   * 换成按席位遍历之后，"这一局有几个人"在界面上是一眼可见的：
   * 行数就是人数，轮到的那个加亮，出局的划掉。
   */
  const seatRows = seatsOf(s)
    .map((p) => {
      /*
       * "（你）"只该标在**真的在玩的那一方**头上。
       *
       * 观战位和复盘都没有"你"：`me` 在那种场合仍然是 A（面板要有个主人才能算视野），
       * 于是这一行一直把红方标成"（你）"——复盘别人的棋时，第一眼就以为自己是其中一方。
       */
      const mine = !spectator && p === me;
      const cities = citiesOf(s, p).length;
      /*
       * 出局有两张脸：主动认输，和最后一座城被人接管。
       * 席位栏只认 `hasQuit` 的话，后一种会一直亮着、显示"城 0"，看上去像还在打。
       */
      const quit = hasQuit(s, p) || isEliminated(s, p);
      const on = p === s.current;
      return `<div class="seat-row${on ? ' active' : ''}${quit ? ' quit' : ''}">
        <span class="vs-dot ${p.toLowerCase()}"></span>
        <b>${escapeHtml(s.players[p].name)}${mine ? '（你）' : ''}</b>
        <span class="seat-stats">${resLine(p)} · 城 ${cities}</span>
      </div>`;
    })
    .join('');

  return `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        ${turnBadge}
        <span class="hint">第 ${s.turn} 次行动</span>
      </div>
      ${
        /*
         * 撤回放在这里，不放在「结束回合」下面。
         *
         * 两颗按钮原来上下紧挨着（结束回合是整行长按钮，撤回就在它正下方），
         * 而它们一个是"这一回合我走完了"、一个是"把最后一步退回来"——
         * 手一抖点错，代价是一次回合交接。挪到顶部信息卡，"结束回合"下面
         * 只剩「认输」和「音效」，中间还隔着一行提示。
         */
        input.replay
          ? ''
          : `<div class="undo-row">
               <button class="btn btn-sm" data-act="undo" ${
                 input.canUndo === true && myTurn ? '' : 'disabled'
               } title="退回上一步（只在同一回合内可用）">撤回一步</button>
               <span class="hint">同一回合内可退，结束回合后就不能了</span>
             </div>`
      }
      <div style="margin-top:12px">
        ${seatRows}
      </div>
      <div class="meta-line">${s.fog ? '迷雾开启' : '迷雾关闭'} · 棋盘 ${s.w}×${s.h}</div>
      <div class="meta-line">扩展：${escapeHtml(expansionText)}</div>
    </div>

    ${eggBanner}

    ${input.battleCard
      ? `<div class="card">
           <div class="card-title">战报卡</div>
           <div class="hint">破城回合、MVP 兵种、关键三步——一张能存下来、也能发出去的卡。</div>
           <button class="btn btn-sm btn-primary" data-act="battle-card">生成战报卡</button>
         </div>`
      : ''}

    ${renderReport(s, input.report)}

    <div class="card">${detail}</div>

    <div class="card">
      <div class="card-title">战报</div>
      ${logHtml}
    </div>

    <div class="side-footer">
      ${
        /*
         * 指挥官模式：这里原来还是「结束行动，交给对方」。
         *
         * 那个按钮只推进**一个**回合，而参谋部是按 5 回合一批走的——两个入口
         * 各推各的，玩家顺手点一下就变成"我走了半批、对面还没走"，批处理的
         * 回合计数和对面看到的局面全都对不齐。所以它在这里换成同一件事：
         * 执行一批（5 回合 / 联机 1 回合）再交还，和顶部那颗按钮同源。
         */
        input.commander === true
          ? `<button class="btn btn-primary btn-block" data-act="${input.planHotseat === true ? 'plan-commit' : 'commander-run'}"
               ${
                 myTurn &&
                 input.commanderRunning !== true &&
                 !(input.planHotseat === true && input.planReady === true)
                   ? ''
                   : 'disabled'
               }>
               ${
                 input.commanderRunning === true
                   ? '参谋部正在执行…'
                   : input.planHotseat === true
                     ? `${input.planReady === true ? '已提交，等对方' : '提交作战计划'}`
                     : `执行 ${input.commanderRounds ?? CONFIG.commanderSlots} 回合，然后交还`
               }
             </button>`
          : `<button class="btn btn-primary btn-block" data-act="end-turn" ${myTurn ? '' : 'disabled'}>
               ${
                 myTurn
                   ? '结束行动，交给对方'
                   : spectator
                     ? input.replay
                       ? '复盘 · 只能看'
                       : '观战中 · 只能看'
                     : quit
                       ? '你已认输 · 只能看'
                       : '等待对方行动中'
               }
             </button>`
      }
      <div class="side-actions"${input.replay ? ' hidden' : ''}>
        <button class="btn btn-sm btn-quiet-danger" data-act="surrender" ${myTurn ? '' : 'disabled'}>
          ${quit ? '已认输' : '认输'}
        </button>
      </div>
      <button class="btn btn-sm btn-block" data-act="chime">${chimeLabel(input.chimeVolume ?? 0.6)}</button>
      <div class="hint" style="text-align:center">
        ${
          input.replay
            ? '复盘是全图视角：当时被雾挡住的部队也画出来了。'
            : spectator
              ? '这是全图视角：双方的伏兵和金币都看得见。别在两个人还在打的时候念出来。'
              : '每一步都会自动存档，随时可以关掉页面'
        }
      </div>
    </div>
  `;
}

/**
 * 结算卡上的「这局的数据要不要捐出来」。
 *
 * 三件事必须同时成立，玩家才可能真的愿意点：
 *   1) 默认是关的，勾选只代表"允许"，点上传才真的发；
 *   2) 发之前把要发什么摊开写清楚——种子、回合数、双方阵容，一条条列；
 *   3) 失败的时候说清楚是哪一步不对（没开通 / 凭据过期 / 网络不通），
 *      并且报告始终能复制、能下载，不会因为传不上去就白打一局。
 *
 * 沙盒和观战位不出现这个区块（数据没意义 / 不是你的对局），由调用方挡掉。
 */
function renderReport(s: GameState, info: PanelInput['report']): string {
  if (!info) return '';
  const rep = buildMatchReport(s);
  // 这里**只写席位字母，不写玩家名**：这张卡列的是"点上传之后真的会发出去的东西"，
  // 而报告里刻意不带名字（见 report.ts 顶上那段）。写名字等于告诉玩家
  // "名字会被上传"——那是假话，也会让"匿名"这条承诺变得不可信。
  const winnerText = rep.winner
    ? `${rep.winner} 方胜${rep.playerCount > 2 ? `（${rep.playerCount} 人局）` : ''}`
    : '还没有胜者';
  const roster = (x: ReportSide): string => {
    const list = Object.entries(x.roster)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id, n]) => `${s.unitTypes[id]?.name ?? id}×${n}`);
    return list.length > 0 ? list.join('、') : '没有兵了';
  };

  const busy = info.status === 'sending';
  const canSend = info.optedIn && !busy && info.status !== 'done';
  const status =
    info.status === 'sending'
      ? '<div class="hint report-status">正在上传…</div>'
      : info.status === 'done'
        ? `<div class="hint report-status done">${escapeHtml(
            info.note ?? '已上传，谢谢。这批数据会用来调 AI 和兵种数值。',
          )}</div>`
        : info.status === 'failed'
          ? `<div class="hint report-status failed">${escapeHtml(info.note ?? '没传上去')}</div>${
              info.howTo ? `<div class="hint report-howto">${escapeHtml(info.howTo)}</div>` : ''
            }`
          : '';

  return `<div class="card report-card">
    <div class="card-title">这局的数据要不要捐出来</div>
    <div class="hint">
      打完的局能帮上忙：哪个兵种偏贵、哪套扩展一开就一边倒，光靠自己打的几十局是看不出来的。
      这些数据只用于<b>调整数值、改进 AI</b>，也可能用于<b>训练模型</b>或发布<b>聚合统计</b>
      （不会公开单条记录）。勾上只是"允许"，点下面的按钮才真的发出去。
    </div>
    <ul class="report-list">
      <li>地图种子 ${rep.seed} · ${rep.board.w}×${rep.board.h} · ${rep.playerCount} 人 · ${rep.turns} 次行动 · ${winnerText}</li>
      <li>${rep.expansions.length > 0 ? `扩展 ${rep.expansions.length} 个` : '没有开扩展'} · 兵种表 ${rep.packSize} 个${
        rep.ai.opponent || rep.ai.ally ? ` · AI ${rep.ai.level === 'basic' ? '初级' : '高级'}` : ''
      }</li>
      <li>${rep.sides
        .map((x) => `${x.side} 方 ${x.cities} 城 / ${x.units} 兵 / 最高时代 ${x.eras[0] ?? '-'}`)
        .join('　')}</li>
      <li>阵容：${rep.sides.map((x) => `${x.side} 方 ${roster(x)}`).join('；')}</li>
    </ul>
    ${
      info.detail
        ? `<div class="hint report-detail">这局还记了逐回合摘要：${escapeHtml(info.detail)}</div>`
        : ''
    }
    <div class="hint report-privacy">
      不含玩家名、房间码、操作流水。会上传一个<b>随机浏览器代号</b>（只用于限流和去重，
      不关联任何账号）。提交后<b>无法单独撤回</b>——系统不知道哪条是你的。
    </div>
    <label class="report-opt">
      <input type="checkbox" data-act="report-opt" ${info.optedIn ? 'checked' : ''} />
      <span>允许上传对局数据（存在本机，随时可以取消）</span>
    </label>
    <div class="report-actions">
      <button class="btn btn-sm btn-primary" data-act="report-upload" ${canSend ? '' : 'disabled'}>${
        info.status === 'done' ? '已上传' : '匿名上传这局'
      }</button>
      <button class="btn btn-sm" data-act="report-copy">复制报告</button>
      <button class="btn btn-sm" data-act="report-download">下载 .json</button>
    </div>
    ${status}
  </div>`;
}

/**
 * 技能菜单。
 *
 * 长得和"可建造""产兵"一样，因为它们回答的是同一类问题：
 * "这一回合，我手上这几个人能做什么"。冷却是灰按钮，不是不显示——
 * 玩家要知道"再等一回合"，而不是以为技能丢了。
 *
 * 名字里的 hero 是历史包袱：这套框架最早只服务奇想的英雄技能，
 * 现在修士、建筑也在用。函数名没改（改起来牵连一堆调用点），
 * 但**给玩家看的字里不许再出现"英雄"**。
 */
function heroSkillBlock(s: GameState, units: Unit[]): string {
  const rows: string[] = [];
  for (const u of units) {
    const def = utype(s, u.type);
    if (!skillsOf(s, u) || skillsOf(s, u).length === 0) continue;
    for (const k of heroSkillsOf(s, u)) {
      // 充能型技能要把"还剩几发"写在脸上：写成"就绪/冷却"会让人以为
      // 只能一次一次地等，而它其实是"攒着可以连开"的那一类。
      const chargeNote = k.chargeMax > 0 ? ` · ${k.charge}/${k.chargeMax} 发` : '';
      let status = '就绪';
      if (!k.ready) {
        if (k.notReadyReason) {
          status = k.notReadyReason; // 优先显示扩展给的原因（比如：攻击次数不足）
        } else if (k.chargeMax > 0 && k.charge <= 0) {
          status = `${k.toNext} 回合回一发`;
        } else if (k.cd > 0) {
          status = `${k.cd} 回合`;
        } else {
          status = '未就绪';
        }
      }
      rows.push(
        `<button class="recruit-btn" data-act="hero-skill" data-id="${u.id}" data-skill="${k.def.id}" ${k.ready ? '' : 'disabled'}>
           <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${def.short}</span>
           <span class="meta"><b>${def.name} · ${k.def.name}${chargeNote}</b><span>${escapeHtml(k.def.summary)}</span></span>
           <span class="price">${status}</span>
         </button>`,
      );
    }
  }
  if (rows.length === 0) return '';
  // 菜单底下原来有一句"技能不占行动，每个英雄每回合最多一次"的总说明。
  // 现在技能五花八门（有的占移动、有的耗灵石、有的能连发），一句话概括不了，
  // 所以删掉——代价与冷却都写在每个按钮自己的小字上了。
  return `<div class="card-title" style="margin-top:14px">技能</div>
    <div class="recruit-list">${rows.join('')}</div>`;
}

/**
 * 扩展声明的"单位操作"按钮（学法术、遗忘法术……）。
 *
 * 核心不知道这些按钮是干什么的：文案、能不能点、右边的短提示全由扩展的
 * `unitActions` 给出，点击只会发一个 `UNIT_ACTION { unitId, actionId }` 回去。
 *
 * 为什么不在核心这里写死"学法术"：那等于让界面认识修真包，而这套代码的
 * 分层是"界面不认识任何扩展"。一个通用的按钮位比一条特例便宜得多，
 * 藏经阁之后的静心阁、宗门研发都能直接复用。
 */
function unitActionBlock(s: GameState, u: Unit, me: PlayerId): string {
  /** 按扩展给的 `group` 分组：同一组一个标题 */
  const groups = new Map<string, string[]>();
  for (const e of activeExpansions(s)) {
    const opts = e.hooks.unitActions?.({ state: s, unit: u, viewer: me }) ?? [];
    for (const o of opts) {
      const title = o.group ?? '研修';
      const rows = groups.get(title) ?? [];
      const confirmAttr = o.confirm ? ` data-confirm="${escapeHtml(o.confirm)}"` : '';
      rows.push(
        `<button class="recruit-btn" data-act="unit-action" data-id="${u.id}" data-action="${escapeHtml(o.id)}"${confirmAttr} ${o.disabled ? 'disabled' : ''}>
           <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${escapeHtml(o.label.slice(0, 1))}</span>
           <span class="meta"><b>${escapeHtml(o.label)}</b>${o.detail ? `<span>${escapeHtml(o.detail)}</span>` : ''}</span>
           <span class="price">${escapeHtml(o.note ?? '')}</span>
         </button>`,
      );
      groups.set(title, rows);
    }
  }
  if (groups.size === 0) return '';
  return [...groups.entries()]
    .map(
      ([title, rows]) =>
        `<div class="card-title" style="margin-top:14px">${escapeHtml(title)}</div>
    <div class="recruit-list">${rows.join('')}</div>`,
    )
    .join('');
}

/**
 * 给上帝模式：把"这一格/这支兵"的**完整**属性卡原样吐出来。
 *
 * 沙盒原来点一下只弹一句"名字 血量"，光环、规则加成、真实数值、技能按钮
 * 全都看不见——而"某支兵站在某条光环里到底剩多少攻"恰恰是摆沙盒最想验证的事。
 * 所以这里不另写一份精简版：**直接复用**正常对局的 renderDetail，
 * 让两个界面的数字天生同源（否则迟早会出现"沙盒说 12、实战打出来是 15"）。
 */
export function detailCardHtml(input: PanelInput, myTurn: boolean): string {
  return `<div class="card">${renderDetail(input, myTurn)}</div>`;
}

/**
 * 扩展往侧栏里插的**成品 HTML**（天气块这类带颜色徽标的）。
 *
 * 和 `getUnitPanelLines` 的分工：那个是纯文本行、核心会转义；这个原样插入，
 * 所以只能由扩展拼——扩展是代码，不是用户输入。
 *
 * `unit` 有值表示"看的是这个单位"，`x/y` 是它脚下那一格：
 * 天气这类按格算的东西，两种卡走同一个入口。
 */
function extPanelHtml(
  s: GameState,
  x: number,
  y: number,
  unit: Unit | undefined,
  me: PlayerId,
): string {
  const parts: string[] = [];
  for (const e of activeExpansions(s)) {
    if (!e.hooks.getTilePanelHtml) continue;
    const html = e.hooks.getTilePanelHtml({ state: s, x, y, unit, viewer: me });
    if (html) parts.push(html);
  }
  return parts.join('');
}

function renderDetail(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedUnit, selectedCityId, selectedCampId, selectedTile } = input;
  const s = view.state;
  /**
   * 这一帧的视野。雾是"看不见就不说"的依据，面板也得守——
   * 棋盘上画着迷雾、侧栏却能把雾里的地形和敌情念出来，那雾就白罩了。
   */
  const seenTiles = s.fog ? new Set(view.visible) : null;

  // 军营：自己点开就是产兵面板，跟城市那套是一回事
  if (selectedCampId) {
    return renderCamp(input, myTurn);
  }

  if (selectedCityId) {
    return renderCity(input, myTurn);
  }

  if (selectedTile) {
    const ti = selectedTile.y * s.w + selectedTile.x;
    const tile = s.tiles[ti];
    if (tile) {
      /*
       * 雾里点一格，到底该知道什么？
       *
       * 三条线，别串：
       *   · 没有雾 → 照旧，地形全图可见；
       *   · 有雾但地形是公开的（基础规则）→ 地形照写，那是地图本来就有的信息；
       *   · **浓雾蔽野**（`view.terrainHidden`）连地形都遮 → 雾外只翻记忆，
       *     记忆里也没有就写「未探明」，别拿"平原"这种默认值骗人。
       *
       * 扩展写在格子上的东西（灵气浓度、脚下天气）是**活数据**，只在看得见时问。
       * 雾外那一格报出的"62（灵田 +15）"，等于替玩家把对面的建筑点了一遍。
       */
      const seen = seenTiles ? seenTiles.has(ti) : true;
      const memo = !seen && view.terrainHidden ? view.rememberedTiles.get(ti) : undefined;
      const fromMemory = memo !== undefined;
      const terrain = seen || !view.terrainHidden ? tile.terrain : memo;
      const coord = `${String.fromCharCode(65 + selectedTile.x)}${selectedTile.y + 1}`;

      if (terrain === undefined) {
        return `
        <div class="unit-head">
          <div class="unit-chip" style="border-radius:8px;background:#5f5a52">?</div>
          <div>
            <div class="unit-title">未探明</div>
            <div class="unit-sub">坐标 ${coord}</div>
          </div>
        </div>
        <div class="unit-notes"><div>· 雾里看不透这一格。派个单位走过去，或者等它进入视野。</div></div>
      `;
      }

      const info = TERRAIN_INFO[terrain];
      const lines = describeTerrain(terrain, s);
      // 扩展写在格子上的东西（灵气浓度之类）：核心不认识，只把盒子递过去——
      // 和单位卡上的 getUnitPanelLines 一个口径。雾外不递（见上面的注释）。
      const extLines: string[] = [];
      if (seen) {
        for (const e of activeExpansions(s)) {
          if (!e.hooks.getTilePanelLines) continue;
          extLines.push(
            ...e.hooks.getTilePanelLines({
              state: s,
              x: selectedTile.x,
              y: selectedTile.y,
              viewer: me,
            }),
          );
        }
      }
      return `
        <div class="unit-head">
          <div class="unit-chip" style="border-radius:8px;background:#8b8477">地</div>
          <div>
            <div class="unit-title">${info.name}</div>
            <div class="unit-sub">坐标 ${coord}${
              fromMemory ? ' · 记忆里的地形（可能有变）' : ''
            }</div>
          </div>
        </div>
        <div class="info-row"><span>进入消耗</span><b>${info.cost}</b></div>
        <div class="info-row"><span>防御加成</span><b>${info.defense}</b></div>
        ${
          extLines.length > 0
            ? `<div class="unit-notes" style="color: #8b7eb6; margin-top: 8px;">${extLines
                .map((l) => `<div>· ${escapeHtml(l)}</div>`)
                .join('')}</div>`
            : ''
        }
        ${seen ? extPanelHtml(s, selectedTile.x, selectedTile.y, undefined, me) : ''}
        <div class="unit-notes">${lines.map((l) => `<div>· ${l}</div>`).join('')}</div>
      `;
    }
  }

  if (selectedUnit) {
    const def = utype(s, selectedUnit.type);
    const ratio = selectedUnit.hp / maxHpOf(s,selectedUnit);
    const spectator = input.spectator === true;
    const readOnly = spectator || input.commander === true;
    const mine = !readOnly && selectedUnit.owner === me;
    // 残兵不给钱，按钮上就得写清楚——"回收 0 金"看着像程序出错
    const refund = disbandRefundOf(s, selectedUnit);
    const status: string[] = [];
    if (spectator) {
      status.push('观战中 · 仅查看');
    } else if (mine) {
      if (!selectedUnit.moved) status.push('可移动');
      if (!selectedUnit.acted) status.push('可攻击');
      if (selectedUnit.moved && selectedUnit.acted) status.push('本回合已行动完毕');
    } else {
      // 别人的单位只给看：兵种一多，临场查对面射程/护甲是刚需，
      // 但这张卡上不该出现任何能按的东西
      status.push(
        input.commander === true && selectedUnit.owner === me
          ? '指挥官模式 · 走位归 AI，可遣散'
          : `${s.players[selectedUnit.owner].name}单位 · 仅查看`,
      );
    }

    // 建造单位：列出它能盖的东西，点了就进选址模式。
    // 名单走 buildListFor 过滤，所以"可建 N 种"和底下 N 个按钮永远是同一个数。
    const buildables = buildListFor(s, def, selectedUnit.owner).ids
      .map((id) => s.unitTypes[id])
      .filter((x): x is UnitTypeDef => !!x);
    const notes = describeUnit(s, def, undefined, selectedUnit);
    const noteBlock =
      notes.length === 0
        ? ''
        : `<div class="unit-notes">${notes.map((n) => `<div>· ${n}</div>`).join('')}</div>`;
    // 收集所有扩展想在这个兵种面板上显示的文字
    const customLines: string[] = [];
    for (const e of activeExpansions(s)) {
      if (e.hooks.getUnitPanelLines) {
        customLines.push(...e.hooks.getUnitPanelLines({ state: s, unit: selectedUnit, viewer: me }));
      }
    }
    const customBlock = customLines.length > 0 
      ? `<div class="unit-notes" style="color: #8b7eb6; margin-top: 8px;">${customLines.map(l => `<div>· ${escapeHtml(l)}</div>`).join('')}</div>` 
      : '';
    /**
     * 遣散：指挥官模式下也留着。
     *
     * 走位和开火归 AI，但"这个兵还留不留"是经济决定——造多了占着路口、
     * 或者想腾出钱去升时代，撤回四成该由玩家自己拍板。规则层本来就允许
     * （只看是不是你的、船里有没有货），先前是界面拿 `mine` 一刀切掉了。
     */
    const canDisband = !spectator && selectedUnit.owner === me && myTurn;
    const canBuildNow = mine && !selectedUnit.acted;
    // 建造清单只在"自己的单位"上出现：对敌方展示一份点不动的建造菜单没有意义
    const buildBlock =
      buildables.length === 0 || !mine
        ? ''
        : `<div class="card-title" style="margin-top:14px">可建造</div>
           <div class="recruit-list">${buildables
             .map((b) => {
               const price = recruitResCost(s, me, b);
               const dis = !canBuildNow || !canPay(s.players[me], price);
               // 选址要求（临水、山边、挨着灵田……）统一由数据生成，
               // 不再为每种条件在这里写一个分支。
               const siteNeed = adjacentRequirementText(
                 b,
                 (id) => s.unitTypes[id]?.name ?? id,
               );
               const tag =
                 (b.bridges
                   // 桥的落点从数据里读（水域 / 沼泽），别在界面上另写一句"水上"
                   ? `架在${(b.buildOn ?? ['water']).map((t) => CONFIG.terrainName[t]).join('/')}上 · 双向通行`
                   : isProducer(b)
                     ? `能产兵${produceEveryTurns(b) > 1 ? `（${produceEveryTurns(b)} 回合一批）` : ''} · ${(
                         b.buildOn ?? []
                       )
                         .map((t) => CONFIG.terrainName[t])
                         .join('/')}`
                     : b.autoAttack
                       ? `自动开火 ${b.range} 格`
                       : b.incomeByTerrain || b.income || b.yield
                         ? `产出 ${yieldShort(b)}`
                         : '工事') + (siteNeed ? ` · ${siteNeed}` : '');
               // 建造难度和驻军是"看不见但决定怎么用"的两条，必须写在按钮上：
               // 一个要投两回合才成型的塔，玩家在第一回合就得知道它现在是块工地。
               // 点数后面跟的是"这个工兵要几回合"，因为玩家真正关心的是工期，
               // 而工期取决于谁去修——这正是建造点数要表达的东西。
               const mods: string[] = [];
               const need = buildCostOf(b);
               const power = buildPowerOf(def);
               mods.push(
                 need <= power
                   ? `建造 ${need} 点 · 当回合完工`
                   : `建造 ${need} 点 · 施工 ${Math.ceil(need / power)} 回合`,
               );
               if ((b.footprint ?? 1) > 1) mods.push('占 2×2');
               if (b.garrison) mods.push('可驻军');
               const tagLine = mods.length > 0 ? `${tag} · ${mods.join(' · ')}` : tag;
               return `<button class="recruit-btn" data-act="build" data-type="${b.id}" ${dis ? 'disabled' : ''}>
                 <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${b.short}</span>
                 <span class="meta"><b>${b.name}</b><span>${unitStatLine(b)} · ${tagLine}</span></span>
                 <span class="price">${costLabel(price)}</span>
               </button>`;
             })
             .join('')}</div>
           <div class="hint" style="margin-top:8px">建造要占掉这个单位的整回合，选址范围 ${CONFIG.buildRange} 格。</div>`;

    // 运输船：装卸是它唯一会做的事，所以单独开一块，写清载了谁、还能装几个
    const cargo = selectedUnit.cargo ?? [];
    // 舱位与准入都读兵种数据：面板不自己算"这条船能装几个"。
    const hold = holdOf(def);
    const cap = hold?.max ?? 0;
    const cargoBlock = !hold
      ? ''
      : `<div class="card-title" style="margin-top:14px">货舱 ${cargo.length} / ${cap}</div>
         <div class="hint">${
           cargo.length === 0
             ? '空船。贴着岸边走，把陆军接上来。'
             : cargo.map((u) => `${utype(s, u.type).name}（${u.hp}）`).join(' · ')
         }</div>
         <div class="recruit-list" style="margin-top:8px">
           <button class="recruit-btn" data-act="load" ${!mine || selectedUnit.acted || cargo.length >= cap ? 'disabled' : ''}>
             <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">装</span>
             <span class="meta"><b>装载</b><span>把贴身的陆军接上船（占掉它这一回合）</span></span>
             <span class="price">—</span>
           </button>
           ${
             cargo.length === 0
               ? ''
               : `<button class="recruit-btn" data-act="unload" ${!mine || selectedUnit.acted ? 'disabled' : ''}>
                    <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">卸</span>
                    <span class="meta"><b>卸载</b><span>放到船边一格空地，下船后本回合不能再动</span></span>
                    <span class="price">—</span>
                  </button>`
           }
         </div>`;

    // 站在自家军营上的兵：点击优先选中兵（否则那个兵会被建筑盖住、再也选不中），
    // 所以军营的产兵面板要在这里留一个入口。
    const under = buildingAt(s, selectedUnit.x, selectedUnit.y);
    const underCampDef = under ? utype(s, under.type) : null;
    const underCamp =
      under && !readOnly && under.owner === me && isProducer(underCampDef) ? under : null;

    // ── 真实数值 ──
    // 面板数字必须和结算同源：effectiveStats 把光环、击杀成长、威吓、
    // 狂暴、哀兵必胜、地形、诅咒、扩展改甲全部算进去，
    // movePower/visionOf 则是移动力和视野的同一个真相源。
    // 面板再也不显示"裸装"数值——玩家对不上账，比没有数字更糟。
    const eff = effectiveStats(s, selectedUnit);
    /*
     * 产出走 unitYield，不是 unitIncome：后者只取金币。
     * unitYield 就是回合结算（settleIncome → incomeResOf）用的那个函数，
     * 地形、临水、扩展的 modifyYield（灵矿邻山 +2 灵石、城郭包折算、海军平台被贴停产）
     * 全都已经算在里面——面板和战报因此永远是同一笔账。
     */
    const yields = unitYield(s, selectedUnit);
    const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
    const modRow = (scope: string, it: { label: string; delta: number }): string =>
      `<div class="info-row stat-mod"><span>${scope} · ${it.label}</span><b class="${
        it.delta >= 0 ? 'up' : 'down'
      }">${signed(it.delta)}</b></div>`;
    const atkChanged = eff.atk !== eff.atkBase;
    const armorChanged = eff.armor !== eff.armorBase;
    const stats = effectiveStats(s, selectedUnit); 
    // 只有一个数被改过时，括号里必须点名是哪一个——不写"甲基础 1"的话，
    // "3 / 4（基础 1）"看起来像是攻击也变成了 1
    const baseNote =
      atkChanged && armorChanged
        ? `（基础 ${eff.atkBase} / ${eff.armorBase}）`
        : atkChanged
          ? `（攻基础 ${eff.atkBase}）`
          : armorChanged
            ? `（甲基础 ${eff.armorBase}）`
            : '';
    const statModBlock =
      eff.atkItems.length + eff.armorItems.length > 0
        ? `<div class="stat-mods">${eff.atkItems.map((it) => modRow('攻', it)).join('')}${eff.armorItems
            .map((it) => modRow('甲', it))
            .join('')}</div>`
        : '';

    // 当前属性（运行时值优先：至尊法师每回合写 u.element）
    const elNow = elementOf(s, selectedUnit);
    const hasMastery = (def.abilities ?? []).includes('element-mastery');
    const canShift = (def.cycle ?? []).length > 1;

    return `
      <div class="unit-head">
        <div class="unit-chip ${selectedUnit.owner === 'A' ? 'a' : 'b'}">${def.short}</div>
        <div>
          <div class="unit-title">${def.name}</div>
          <div class="unit-sub">${s.players[selectedUnit.owner].name} · ${status.join(' / ')}</div>
        </div>
      </div>
      ${
        underCamp
          ? `<button class="btn btn-sm btn-block" data-act="open-camp" data-id="${underCamp.id}" style="margin-top:10px">
              打开脚下的军营（${underCampDef?.name}）
             </button>`
          : ''
      }
      <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
      <div class="info-row"><span>生命</span><b>${selectedUnit.hp} / ${maxHpOf(s, selectedUnit)}</b></div>
      ${statusRow(selectedUnit)}
      ${stealthRow(s, selectedUnit, me)}
      <div class="info-row">
        <span>攻击 / 护甲</span>
        <b>${eff.atk} / ${eff.armor}${baseNote}</b>
      </div>
      ${statModBlock}
      ${
        // 魔法段单独一行：至尊法师的攻击是 0、伤害全在魔法上，
        // 只写"攻击 0"等于告诉玩家这个兵不会打人。
        // 魔攻/魔抗也走"单位现值"而不是兵种表：圣剑觉醒会往上叠 +8 魔攻 / +2 魔抗，
        // 面板若只读 def，玩家会看到"技能说加了，数字没动"。
        magicAtkOf(s, selectedUnit) > 0
          ? `<div class="info-row"><span>魔法攻击 / 魔抗</span><b>${magicAtkOf(
              s,
              selectedUnit,
            )} / ${magicResOf(s, selectedUnit)}</b></div>`
          : ''
      }
      ${
        // 当前属性：至尊法师每回合自己切一次，而属性决定"打出去带什么状态、
        // 暗形态下魔法段还 ×1.5"。不显示就是在让人猜——那个词会变成一枚纯装饰的徽标。
        elNow
          ? `<div class="info-row"><span>当前属性</span><b>${ELEMENT_NAME[elNow]}${
              canShift ? '（可切）' : ''
            }</b></div>${
              hasMastery && ELEMENT_EFFECT[elNow]
                ? `<div class="hint">${ELEMENT_EFFECT[elNow]}${
                    canShift ? ' · 点「转属性」切下一种' : ''
                  }</div>`
                : ''
            }`
          : ''
      }
      <div class="info-row"><span>移动力</span><b>${
        eff.move !== eff.moveBase ? `${eff.move}（基础 ${eff.moveBase}）` : eff.move
      }</b></div>
      <div class="info-row"><span>射程 / 视野</span><b>${effectiveRange(s, selectedUnit)} / ${stats.vision}</b></div>
      ${
        // 装甲素体：插槽与耗电必须写在属性卡上。
        // "这台还能装几件""它吃了多少电"是装配前最先要判断的两件事，
        // 以前只能点进装配坞里数按钮。
        def.armorFrame
          ? `<div class="info-row"><span>插槽</span><b>${slotLine(def, selectedUnit)}</b></div>
             <div class="info-row"><span>耗电</span><b>${unitDraw(s, selectedUnit)} <small style="opacity:.65">（本方余量 ${
               energyBreakdown(s, selectedUnit.owner).headroom
             }）</small></b></div>`
          : ''
      }
      ${extPanelHtml(s, selectedUnit.x, selectedUnit.y, selectedUnit, me)}
      ${
        // 条件看"产出表非空"而不是"金币 > 0"：只产灵石/粮食的单位以前整行都不出现。
        // 施工中的单位 unitYield 返回空表，这一行自然消失，和以前的观感一致。
        Object.keys(yields).length > 0
          ? `<div class="info-row"><span>每回合收入</span><b>${costLabel(yields)}</b></div>`
          : ''
      }
      ${
        // 半径和比例都按"现在这个单位"算，不读兵种表：修真的境界、单位自带的
        // custom.splashRatio 都会改这两项，界面必须和结算走同一个函数
        splashRadiusOf(s, selectedUnit) > 0
          ? `<div class="info-row"><span>溅射</span><b> ${splashRadiusOf(
              s,
              selectedUnit,
            )} 格 · ${Math.round(splashRatioOf(selectedUnit) * 100)}%</b></div>`
          : ''
      }
      ${
        // 多动：一回合能打几次、现在还剩几次。剩的次数少于总数时才看得出
        // "这个单位这回合还没打完"——所以永远显示"剩 / 共"，别只显示总数。
        attacksPerTurn(s, selectedUnit) > 1
          ? `<div class="info-row"><span>攻击次数</span><b>还剩 ${attacksLeftOf(
              s,
              selectedUnit,
            )} / ${attacksPerTurn(s, selectedUnit)} 次</b></div>`
          : ''
      }
      ${mine && myTurn ? heroSkillBlock(s, [selectedUnit]) : ''}
      ${armorBlock(s, selectedUnit, mine && myTurn)}
      ${carrierBlock(s, selectedUnit, mine && myTurn)}
      ${mine && myTurn ? unitActionBlock(s, selectedUnit, me) : ''}
      ${cargoBlock}
      ${buildBlock}
      ${noteBlock}
      ${customBlock} 
      ${
        mine && myTurn
          ? `<div class="force-row">
               <button class="force-btn${input.forceMode === 'move' ? ' armed' : ''}" data-act="force-move">
                 强制移动 <kbd>Alt</kbd>
               </button>
               <button class="force-btn${input.forceMode === 'attack' ? ' armed' : ''}" data-act="force-attack">
                 强制攻击 <kbd>Shift</kbd>
               </button>
             </div>
             <div class="hint" style="margin-top:6px">
               同一格压着多个目标时，<b>连点同一格会在它们之间轮换</b>。
               <br /><br />
               走不上桥、或者点不到身下那格时，按<b>强制移动</b>：期间点棋盘只有移动指令，再点一次按钮才退出。
               按住 <kbd>Alt</kbd> 点可达格是同样的效果，只是只生效一次。
             </div>`
          : ''
      }
      ${
        canDisband
          ? `<button class="btn btn-sm btn-block btn-quiet-danger" data-act="disband" style="margin-top:12px">
               ${refund > 0 ? `拆除（回收 ${refund} 金）` : '拆除（残兵不回收金币）'}
             </button>`
          : ''
      }
    `;
  }

  // 没选中任何东西时的默认页：把自己的英雄技能摆出来。
  const myHeroes =
    input.spectator !== true && myTurn ? unitsOf(s, me).filter((u) => skillsOf(s, u)) : [];
  const heroBlock = heroSkillBlock(s, myHeroes);

  return `
    ${heroBlock}
    <div class="card-title"${heroBlock ? ' style="margin-top:14px"' : ''}>操作</div>
    ${
      /*
       * 复盘：这一段原来照抄对局里的操作说明——"点自己的单位 → 蓝色格子是可移动范围"。
       * 复盘里既没有"我的单位"，也不会画可达格，整段读下来只教人去做点不动的事。
       * 这里换成这一屏真正能做的三件事。
       */
      input.replay
        ? `<div class="hint">
      拖顶部的进度条 → 停到任意一步；也可以用 <kbd>←</kbd> <kbd>→</kbd> 一步一步走，
      <kbd>空格</kbd> 播放 / 暂停，<kbd>Home</kbd> <kbd>End</kbd> 跳两端。<br /><br />
      点棋子、点城市 → 看它<b>在那一刻</b>的属性卡（光环、剩余行动、驻军都在）。<br /><br />
      这里是回放，不能走子：要接着打那局，点复盘条右边的「退出复盘」。
    </div>`
        : `<div class="hint">
      点自己的单位 → 蓝色格子是可移动范围，红框是可攻击目标。<br /><br />
      点自己的城市 → 产兵、以及花钱升级时代。升级后能造更高级的兵种，城市也更硬。<br /><br />
      点对方的城市 → 查看它的时代、耐久和护甲。攻城伤害 = 攻击 − 城市护甲。<br /><br />
      点任何一块空地 → 看这块地形能干什么、适合谁站。<br /><br />
      同一格有好几个东西时，连点会轮换选中；选中自己的兵之后，侧栏有两个模式按钮：<br />
      <b>强制移动</b>（<kbd>Alt</kbd>）—— 点可达格就走上去，无视压在上面的棋子（比如走上桥面）；<br />
      <b>强制攻击</b>（<kbd>Shift</kbd>）—— 打身下的目标。<br />
      点按钮进入的模式会一直扣着，期间棋盘只认这一个动作，<b>再点一次按钮才退出</b>；
      按住修饰键则只对下一次点击生效。
    </div>`
    }
  `;
}

function renderCity(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedCityId } = input;
  const s = view.state;
  const city = selectedCityId ? cityById(s, selectedCityId) : undefined;
  if (!city) return '';

  /*
   * 指挥官模式下，自己的城仍然算"我的"。
   *
   * 原来这里把 readOnly 一刀切成 spectator || commander，于是指挥官模式的产兵面板
   * 整个不渲染——玩家只能在顶端的下拉框里排兵，跟常规模式（点城 → 右边点兵）是两套手感。
   * 现在两种模式共用同一块面板，区别只在**点下去之后**做什么：
   *   常规模式：立刻扣钱出兵；指挥官模式：把这一格排进本回合的生产队列。
   */
  const spectating = input.spectator === true;
  const ordering = input.commander === true;
  const mine = !spectating && city.owner === me;
  const queueFull = ordering && ordersOf(s, me).length >= CONFIG.commanderSlots;
  const ratio = city.hp / city.maxHp;
  const era = eraDef(city.era);
  // 驻军只数**地面**单位。
  //
  // 空中单位和地面单位是一格站两个（见 rules 的 sameLayerAt），
  // 所以"城里有几个人"和"城里还空着几格"是两个数：
  //   · 四架飞机悬在城上空，地面四个位置一个没占，照样能出四个兵；
  //   · 城里塞满四个步兵，天上还是一片空白，照样能出飞机。
  // 以前这两件事共用一个数，于是"人口满了造不出飞机"和"飞机悬着造不出步兵"
  // 两个方向都错。
  const onCityTiles = (u: Unit) => cityTiles(city).some((t) => t.x === u.x && t.y === u.y);
  const garrison = unitsOf(s, city.owner).filter((u) => !isAirborne(s, u) && onCityTiles(u)).length;
  const freeSlots = city.size * city.size - garrison;
  const gold = s.players[me].gold;

  // 水军要下到城边那一格空水面上去；没有就造不了
  const hasPort = cityTiles(city).some((t) =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => {
      const nb = s.tiles[(t.y + dy) * s.w + (t.x + dx)];
      // 港口认"船停得下的水面"：深水、桥面、浅流都算（和 navigable 同一条判定，
      // 不然会出现"规则里能下水、面板偏说需要临水"的两张皮）
      return !!nb && navigable(nb.terrain) && !s.units.some((u) => u.x === t.x + dx && u.y === t.y + dy);
    }),
  );

  // 回血：只有"有驻军 + 城外没有敌人"才成立，所以要把当前状态说清楚，
  // 否则玩家只会看到血条不动而不知道为什么
  const regen = cityRegenOf(s, city);
  const besieged = s.units.some(
    (u) => u.owner !== city.owner && distToCity(u, city) <= 1,
  );
  const regenText =
    regen > 0 ? `每回合 +${regen}` : besieged ? '被围城，无法休整' : '城内没有驻军，不回血';

  /*
   * 升级信息一次问清：升到哪一代、多少钱、还差什么条件，都来自 `upgradeTargetOf`。
   * 写 `eraDef(city.era + 1)` 的话，路线一旦跳级或改道，面板会显示一个
   * 和规则层不同的目标——"写着升到 X，点下去变成 Y"就是这么来的。
   */
  const upgradeTarget = upgradeTargetOf(s, city);
  const upgradeCost = upgradeTarget ? upgradeTarget.cost : null;
  const nextEra = upgradeTarget ? upgradeTarget.era : null;

  // 城里只产"能被派出去的单位"，建筑要用建造单位去盖。
  // 两个判据都问 core/draft：选卡模式下"名单外的造不了"和"旧兵照样能造"
  // 必须和规则层同一口径，否则面板能点、点下去被拒。
  const buildable = Object.values(s.unitTypes).filter(
    (d) =>
      d.category !== 'building' &&
      !d.summonedOnly &&
      // 只能由产兵建筑造的（法器、船坞的船）城市产线不列——规则层也这么挡
      !d.campOnly &&
      eraWindowOk(s, d, city.era) &&
      canUseType(s, city.owner, d.id),
  );
  /*
   * 升级后会解锁什么。
   *
   * 判据在 core/draft.ts 的 `upgradeUnlocks`：它和产兵表共用 `canUseType`，
   * 所以选卡模式下**没选到的卡不会出现**（以前的版本只判时代，于是会列出一串
   * 玩家根本造不了的兵）；经济单位、建造单位、生产性建筑与桥不受选卡影响，
   * 照旧列出来——伐木工、民夫、石桥这些升级解锁是真事。
   */
  const locked = upgradeUnlocks(s, city.owner, city.era);

  // 地面坐满时还起得来几款空军：底部那句提示用得上。
  // 它只回答"是不是真的什么都造不了"，所以按"确实有落点"算，不是按兵种表里有几架。
  const airReady = buildable.filter(
    (d) => airLayer(d) && recruitSpawnCells(s, city.id, undefined, d.id).length > 0,
  ).length;

  const unitButton = (def: UnitTypeDef) => {
    // 三种兵各有各的"有没有地方放"：
    //   水军 → 城边有没有空水面；
    //   空军 → 直接问规则层（它可以悬在地面单位头顶上，所以"地面空位 0"不影响它）；
    //   陆军 → 城里还剩几个地面位置。
    // 前两条不能拿 freeSlots 代替：那个数是按地面算的，空军照着它会被误判成没地方。
    const slotsOk =
      def.domain === 'water'
        ? hasPort
        : airLayer(def)
          ? recruitSpawnCells(s, city.id, undefined, def.id).length > 0
          : freeSlots > 0;
    // 下单模式下"城里有没有空位 / 现在轮不轮得到你"都不作数：那些是 AI 执行那一回合才面对的事
    const disabled = ordering ? queueFull : !myTurn || !slotsOk;

    let extra = '';
    if (def.incomeByTerrain) {
      const best = Object.entries(def.incomeByTerrain).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      if (best) {
        extra = ` · ${CONFIG.terrainName[best[0] as keyof typeof CONFIG.terrainName]} +${best[1]}`;
      }
    } else if (def.income) {
      extra = ` · +${def.income} 金`;
    }
    if (def.domain === 'water') {
      if (!hasPort) extra += ' · 需要临水';
      else {
        // 能下水的水面不止一格时明说"可选"：不说的话，玩家按下去只看到
        // 船凭空出现在某一格上，永远不知道原来可以挑。
        const cells = recruitSpawnCells(s, city.id, undefined, def.id).length;
        extra += cells > 1 ? ` · ${cells} 处水面可选` : ' · 水上';
      }
    }

    return recruitButton(s, me, def, disabled, extra, ordering ? 'order' : 'recruit', city.id, {
      kind: 'city',
      city,
    });
  };

  const q = (input.recruitQuery ?? '').trim();
  const pack = input.recruitPack ?? PACK_ALL;
  const eraFilter = input.recruitEra ?? ERA_ALL;
  const shown = buildable.filter((d) => matchRecruit(d, q) && packOk(d, pack) && eraOk(d, eraFilter));

  const grouped = (['combat', 'economy', 'builder'] as const)
    .map((cat) => {
      const items = shown.filter((d) => d.category === cat);
      if (items.length === 0) return '';
      return `<div class="recruit-group">
        <div class="recruit-group-title">${CATEGORY_NAME[cat]}</div>
        <div class="recruit-list">${items.map(unitButton).join('')}</div>
      </div>`;
    })
    .join('');

  const recruitGroups =
    shown.length === 0
      ? emptyRecruitHint(q, pack, eraFilter, buildable.length, '这座城')
      : grouped;

  const upgradeBlock =
    mine && nextEra && upgradeCost !== null
      ? `<button class="upgrade-btn" data-act="${ordering ? 'order-add' : 'upgrade'}"${
          ordering ? ` data-type="${ORDER_UPGRADE}" data-site="${city.id}"` : ''
        } ${ordering ? (queueFull ? 'disabled' : '') : !myTurn || gold < upgradeCost ? 'disabled' : ''}>
           <span class="upgrade-main">
             <b>升级到「${nextEra.name}」时代</b>
             <span>耐久 ${city.maxHp} → ${nextEra.cityMaxHp} · 护甲 ${city.armor} → ${nextEra.cityArmor} · 收入 ${era.cityIncome} → ${nextEra.cityIncome}</span>
           </span>
           <span class="price">${upgradeCost}</span>
           ${ordering ? '<span class="order-tag">＋队列</span>' : ''}
         </button>`
      : mine
        ? '<div class="hint">已经是最高时代。</div>'
        : '';

  return `
    <div class="unit-head">
      <div class="unit-chip ${city.owner === 'A' ? 'a' : 'b'}" style="border-radius:8px">城</div>
      <div>
        <div class="unit-title">城市 ${cityName(city)}</div>
        <div class="unit-sub">${s.players[city.owner].name} · ${era.name}时代 · 驻军 ${garrison}/${city.size * city.size}</div>
      </div>
    </div>
    <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
    <div class="info-row"><span>耐久</span><b>${city.hp} / ${city.maxHp}</b></div>
    <div class="info-row"><span>护甲</span><b>${city.armor}</b></div>
    <div class="info-row"><span>本城收入</span><b>${era.cityIncome} 金</b></div>
    ${
      /*
       * 本方总收入单独一行，且只在**自己的城**上显示。
       *
       * 一是因为原来的"每回合收入"只写城市基础值：战争经济这类 modifyIncome
       * 会改实际到账，两处对不上，玩家按城卡算账会差一截。
       * 二是因为对敌城显示总收入等于白送一份经济情报，浓雾就白做了。
       */
      mine
        ? `<div class="info-row"><span>本方每回合收入</span><b>${costLabel(incomeResOf(s, city.owner))}</b></div>`
        : ''
    }
    <div class="info-row"><span>驻军休整</span><b>${regenText}</b></div>
    ${upgradeBlock}
    ${
      mine
        ? `<div class="card-title" style="margin-top:14px">${
                    ordering ? `生产 <span class="order-note">点兵种排进本回合队列（${ordersOf(s, me).length}/${CONFIG.commanderSlots}）</span>` : '生产'
                  }</div>
           ${ordering && queueFull ? '<div class="hint">队列已排满，先在上面删两格或者执行一次。</div>' : ''}
           ${packRow(buildable, pack)}
           ${eraChipRow(buildable, eraFilter)}
           ${recruitSearchBox(q, shown.length, buildable.length)}
           ${recruitGroups}
           ${
             input.spawnPick
               ? `<div class="hint" style="margin-top:10px">点棋盘上亮起来的水面，把「${
                   s.unitTypes[input.spawnPick.type]?.name ?? input.spawnPick.type
                 }」放下去。点别处就取消。</div>`
               : ''
           }
           <div class="hint" style="margin-top:10px">
             ${
               ordering
                 ? '排进队列的是「这座城 · 这个兵」，AI 执行那一回合才扣钱出兵；队列可以在顶部随时删。'
                 : freeSlots > 0
                   ? `城内还有 ${freeSlots} 个空位。新兵当回合不能行动，建筑建成即不可移动。`
                   : airReady > 0
                     ? '城内地面位已站满，先让部队挪一挪——空军还能起飞（悬在地面单位上方不占位置）。'
                     : '城内已站满，先让部队挪一挪。'
             }
             ${
               locked.length > 0
                 ? `<br />升级后可解锁：${locked.map((d) => d.name).join('、')}`
                 : ''
             }
           </div>`
        : `<div class="hint" style="margin-top:12px">
             ${
               input.spectator
                 ? `这是${s.players[city.owner].name}的城市（${era.name}时代），耐久 ${city.hp} / ${city.maxHp}。观战不给操作。`
                 : input.commander === true
                   ? `这是${s.players[city.owner].name}的城市（${era.name}时代），耐久 ${city.hp} / ${city.maxHp}。指挥官模式下产兵按你排的序列走。`
                   : `这是${s.players[city.owner].name}的城市（${era.name}时代），耐久打空才能易主。攻城伤害 = 你的攻击 − ${city.armor}。`
             }
             <br />攻陷后会连同它的时代一起接收。
           </div>`
    }
    ${draftedCardsHtml(s, city.owner)}
  `;
}

function barColor(ratio: number): string {
  if (ratio <= 0.3) return '#e07b6b';
  if (ratio <= 0.6) return '#e8c76b';
  return '#7ec47e';
}

/**
 * 兵种来源徽标。
 *
 * 面板里现在同时躺着原版、时代兵和五个奇想包，光看名字分不出"九头蛇"是
 * 哪来的——更要命的是：关掉那个包，它就凭空消失了。标出来最省事。
 * 原版兵种没有徽标（多数，不加噪音）。
 */
function sourceTag(def: UnitTypeDef): string {
  const src = unitSourceOf(def.id);
  if (!src) return '';
  return `<span class="recruit-src" title="来自扩展包「${escapeHtml(src)}」，开局没勾就买不到">${escapeHtml(src)}</span>`;
}

/**
 * 搜兵种：名字、代号、职能、时代、包名都能命中，多词按"且"处理（"奇想 弓"）。
 *
 * 刻意不去搜数值（"攻 20"）：那是筛选器，不是搜索框，两件事混在一起
 * 会让"为什么搜 20 出来一堆"变成新的困惑。
 */
export function matchRecruit(def: UnitTypeDef, q: string): boolean {
  if (!q) return true;
  const hay = [
    def.name,
    def.short,
    def.id,
    CATEGORY_NAME[def.category],
    `${eraDef(def.era).name}时代`,
    unitSourceOf(def.id) ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * 产兵列表空掉时那句话。
 *
 * "搜不到"和"这一档里没有"是两种不同的空：前者玩家会去清搜索框，
 * 后者要去点「全部」。只会说"没有可造的兵"等于让人自己猜。
 *
 * 筛选维度从一维变成两维之后，条件必须**全部写出来**：只提包名不提时代，
 * 玩家会去清搜索框，然后发现还是空的。所以这里把生效的每一维都摆进括号里，
 * 维度之间用「·」隔开（和屏幕上那两行 chip 的排列顺序一致）。
 */
function emptyRecruitHint(
  q: string,
  pack: string,
  era: number,
  total: number,
  subject: string,
): string {
  const only: string[] = [];
  if (pack) only.push(escapeHtml(packLabel(pack)));
  if (era !== ERA_ALL) only.push(eraLabel(era));
  const cond = only.length > 0 ? `（只看「${only.join('」「')}」）` : '';
  const head = q ? `没有匹配「${escapeHtml(q)}」的兵种${cond}` : `这一档没有能造的兵${cond}`;
  // 给一颗**能点的**按钮，而不是只说一句"清掉筛选看全部"。
  // 换到一座时代更低的城时，筛选可能把整页清空；这时如果筛选栏恰好退化消失，
  // 玩家就只剩"刷新页面"这一条路了——那不该是一个筛选项的代价。
  const canClear = !!q || !!pack || era !== ERA_ALL;
  const clear = canClear
    ? `<button class="link-btn" data-act="recruit-clear" type="button">清掉筛选</button>`
    : '';
  return `<div class="hint">${head}。${subject}在售 ${total} 种，${clear || '清掉筛选'}看全部。</div>`;
}

/**
 * 搜索框。
 *
 * 兵种少于 6 个就不显示——早期城市一共四行，摆个搜索框纯属添乱。
 * 输入框的 value 由 PanelInput 回填，重绘之后字还在（光标在末尾）。
 */function recruitSearchBox(q: string, shownCount: number, total: number): string {
  if (total < 6) return '';
  const count = q ? `${shownCount}/${total}` : `共 ${total} 种`;
  return `<div class="recruit-search">
    <input
      type="search"
      class="recruit-search-input"
      data-act="recruit-search"
      value="${escapeHtml(q)}"
      placeholder="搜兵种：名字 / 代号 / 职能 / 包名"
      autocomplete="off"
      spellcheck="false"
    />
    <span class="recruit-search-count">${count}</span>
  </div>`;
}

/** 建造按钮上"产出 X"那半句：只看兵种表里写了什么，不猜运行时换算 */
function yieldShort(def: UnitTypeDef): string {
  // 只写 yield 的建筑（粮仓、砖窑、建材基地……）产多少就是它的全部卖点，
  // 所以这里印数值而不是只印一个"材"字——建造按钮上那行字是玩家唯一会读的地方。
  if (def.yield) {
    const flat = Object.entries(def.yield)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([id, n]) => `+${n}${resourceShort(id)}`)
      .join('·');
    if (flat) return flat;
  }
  const ids = new Set<string>();
  if (def.yield) for (const id of Object.keys(def.yield)) ids.add(id);
  if (def.incomeByTerrain || def.income) ids.add('gold');
  return Array.from(ids).map((id) => resourceShort(id)).join('·') || '资源';
}

/**
 * 本局这个单位能盖什么。
 *
 * `exists` 把本局没启用的建筑过滤掉：以前面板是"查不到就静默丢掉"，
 * 于是属性卡写着可建 10 种、底下只摆得出 8 个按钮。现在数字和名单来自同一次
 * 过滤。规则书没有一局游戏，走的是同一个 buildListOf、只是不传 exists。
 */
function buildListFor(s: GameState, def: UnitTypeDef, seat: PlayerId): BuildList {
  return buildListOf(def, {
    nameOf: (id) => s.unitTypes[id]?.name ?? UNIT_TYPES[id]?.name ?? id,
    /*
     * 两层过滤，缺一个就会"看得到、点不动"：
     *   · `unitTypes` —— 本局没启用这个扩展包，这个建筑根本不存在；
     *   · `canUseType` —— 选卡模式下它没被选进名单（或者被对面禁了）。
     *
     * 第二条以前漏了：按钮和悬停提示都写着"能造"，点下去才弹
     * "名单外的建筑造不出来"。玩家花一个回合把工兵走到位置，
     * 最后一步才被拒——这不是提示不够，是面板在撒谎。
     * 判据必须和 `doBuild` 用的是同一个函数，不是抄一遍。
     */
    exists: (id) => !!s.unitTypes[id] && canUseType(s, seat, id),
    // 高过这个工兵档位的建筑不列（判据在 buildListOf 里，和规则层同一条）
    eraOf: (id) => s.unitTypes[id]?.era,
  });
}

/** 产兵按钮：城市和军营共用一套写法，省得两处的样式慢慢跑偏 */
/**
 * 产兵按钮。
 *
 * `mode === 'order'` 是指挥官模式：点下去不是立刻造，而是**往本回合的生产队列里排一格**。
 * 两种模式共用同一个按钮外观，是因为它们对玩家是同一件事（"我要这个兵"），
 * 只是付钱和出兵的人不同——按钮长得不一样反而要重新学一遍。
 */
function recruitButton(
  s: GameState,
  me: PlayerId,
  def: UnitTypeDef,
  disabled: boolean,
  extra: string,
  mode: 'recruit' | 'order' = 'recruit',
  site = '',
  /** 从哪儿造：定价要和 doRecruit 同源（宗门里招修士收灵石，城里收金币） */
  source?: ProduceSource,
): string {
  const price = recruitResCost(s, me, def, source);
  // 英雄的价钱是"造价 + 首次解锁费"，按钮上必须显示合计：
  // 看到 300 金的按钮却扣了 450，玩家只会觉得算错了。
  const unlockFee =
    def.hero === true && !(s.unlocked?.[me] ?? []).includes(def.id) ? (def.unlockCost ?? 0) : 0;
  const aliveHere = def.hero === true && s.units.some((u) => u.owner === me && u.type === def.id);
  const payCost = unlockFee > 0 ? { ...price, gold: (price.gold ?? 0) + unlockFee } : price;
  // 下单模式下不看"现在够不够钱"：钱是 AI 执行那一回合才花的，
  // 用当下的余额把按钮禁掉，等于逼玩家先把钱攒够再来排计划。
  const blocked =
    mode === 'order' ? disabled || aliveHere : disabled || aliveHere || !canPay(s.players[me], payCost);
  const tag = aliveHere ? ' · 场上已有' : unlockFee > 0 ? ` · 解锁 ${unlockFee}` : '';
  // 血量必须出现在购买清单里：攻甲移射都是"打得怎么样"，血是"挨得怎么样"，
  // 一个新兵站上前线能顶几刀，玩家在按下生产之前就该知道。
  // 数值行只有一处来源（core/info 的 unitStatLine）：里面含「视野」，
  // 以前这里手写的版本漏了它，同一个兵在产兵面板和选卡面板看到的数字不一样。
  const detail = `${unitStatLine(def)}${tag}`;
  const act = mode === 'order' ? 'order-add' : 'recruit';
  const siteAttr = mode === 'order' && site ? ` data-site="${site}"` : '';
  const tail =
    mode === 'order' ? `<span class="order-tag">＋队列</span>` : '';
  /*
   * 悬停详情卡：造出这个工兵**之前**就能看到它能盖什么，不必先花钱造出来、
   * 再点开属性卡，或者去翻规则书。数据写在隐藏节点里，由 main.ts 那套通用
   * 浮层搬去 body 显示——和选卡卡片的详情是同一份样式、同一段定位逻辑。
   */
  const builds = buildListFor(s, def, me);
  const tip = `<span class="hover-tip" hidden>
      <span class="tip-title"><b>${escapeHtml(def.name)}</b><i>${escapeHtml(CATEGORY_NAME[def.category] ?? '')}</i></span>
      <span class="tip-row">${escapeHtml(detail)}</span>
      ${builds.names.length > 0 ? `<span class="tip-row tip-abil">可建造：${escapeHtml(builds.names.join('、'))}（共 ${builds.names.length} 种）</span>` : ''}
    </span>`;
  return `<span class="recruit-wrap" data-hover-tip>${tip}
    <button class="recruit-btn" data-act="${act}" data-type="${def.id}"${siteAttr} ${blocked ? 'disabled' : ''}>
    <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${def.short}</span>
    <span class="meta">
      <b>${def.name}${sourceTag(def)}</b>
      <span>${detail}${extra}</span>
    </span>
    <span class="price">${costLabel(payCost)}</span>${tail}
  </button></span>`;
}

const DIRS_4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 军营面板。
 *
 * 军营就是"能往前推的产兵点"：产兵规则和城市一模一样，唯一的区别是
 * 它自己没有时代——时代跟着最近的那座己方城市走，城丢了兵就补不上。
 * 所以这里要把"补给来自哪座城、是几级"写清楚，否则玩家不知道为什么
 * 忽然造不出高级兵了。
 */
function renderCamp(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedCampId } = input;
  const s = view.state;
  const camp = selectedCampId ? s.units.find((u) => u.id === selectedCampId) : undefined;
  if (!camp) return '';

  const def = utype(s, camp.type);
  // 同城市面板：指挥官模式里军营也是"我的"，产兵列表照常显示，点下去是排进队列
  const ordering = input.commander === true;
  const mine = input.spectator !== true && camp.owner === me;
  const queueFull = ordering && ordersOf(s, me).length >= CONFIG.commanderSlots;
  const ratio = camp.hp / def.maxHp;

  // 产兵建筑按**自己的档位**出兵（2026-11-08 删掉"军工供货"之后）：
  // 想要新时代的兵，就盖新时代的营，或者把旧营拆了重盖。它不再看后方城市。
  const era = def.era;

  // 兵从四邻出来。这两个数字只给下面的提示文案用，**能不能造**一律问规则层：
  // 判据按兵种分（飞行兵能停在水面上），自己数一遍 landSlots 必然和
  // doRecruit 走样——飞过的兵曾经就是这样被判成"没地方出兵"、按钮变灰。
  const waterSlots: Array<{ x: number; y: number }> = [];
  let landOpen = 0;
  for (const [dx, dy] of DIRS_4) {
    const x = camp.x + dx;
    const y = camp.y + dy;
    const t = s.tiles[y * s.w + x];
    if (!t) continue;
    if (s.units.some((u) => u.x === x && u.y === y)) continue;
    if (navigable(t.terrain)) waterSlots.push({ x, y });
    else if (passable(t.terrain)) landOpen += 1;
  }
  /** 这个兵种能不能从这座营出来（和 doRecruit 同一条判据） */
  const slotsOf = (d: { id: string }): number => recruitSpawnCells(s, undefined, camp.id, d.id).length;

  /*
   * 面板的两级过滤，和规则层同一套口径（produceAt）：
   *
   *   · 白名单决定**列不列**——不在 produce.units 里的根本不出现，
   *     否则军营会变成"整张兵种表 + 90% 灰掉"；
   *   · 产地条件决定**灰不灰**——白名单里有、但附近没森林/时代不够的，
   *     照样列出来并写明原因，否则玩家永远不知道自己错过了什么，
   *     也不知道该把炉子挪到哪儿。
   *
   * 以前条件不满足是直接从列表里消失的。炼器炉那种"挨着什么就出什么"的
   * 建筑一旦这么写，玩家连"原来还有一件木器"都看不见。
   */
  const candidates = Object.values(s.unitTypes).filter(
    (d) =>
      d.category !== 'building' &&
      !d.summonedOnly &&
      // 白名单：不在 produce.units 里的根本不出现
      canProduce(def, d).ok &&
      // 档位与选卡：这一档本来就造不到的，不进"还造不出来"那一堆
      // （否则一座空白名单的军营会把整张兵种表都灰着列出来）
      eraWindowOk(s, d, era) &&
      canUseType(s, camp.owner, d.id),
  );
  const verdictOf = (d: UnitTypeDef) => produceAt(s, { kind: 'camp', camp }, d);
  const buildable = candidates.filter((d) => verdictOf(d).ok);
  /** 白名单里有、但现在造不出来的：灰着列出来，附上原因 */
  const gated = candidates.filter((d) => !verdictOf(d).ok);

  const q = (input.recruitQuery ?? '').trim();
  const pack = input.recruitPack ?? PACK_ALL;
  const eraFilter = input.recruitEra ?? ERA_ALL;
  const shown = buildable.filter((d) => matchRecruit(d, q) && packOk(d, pack) && eraOk(d, eraFilter));

  const grouped = (['combat', 'economy', 'builder'] as const)
    .map((cat) => {
      const items = shown.filter((d) => d.category === cat);
      if (items.length === 0) return '';
      return `<div class="recruit-group">
        <div class="recruit-group-title">${CATEGORY_NAME[cat]}</div>
        <div class="recruit-list">${items
          .map((d) => {
            const slotsOk = slotsOf(d) > 0;
            const extra =
              d.domain === 'water'
                ? waterSlots.length > 1
                  ? ` · ${waterSlots.length} 处水面可选`
                  : ' · 下水'
                : '';
            return recruitButton(
              s,
              me,
              d,
              ordering ? queueFull : !myTurn || !slotsOk,
              extra,
              ordering ? 'order' : 'recruit',
              camp.id,
              { kind: 'camp', camp },
            );
          })
          .join('')}</div>
      </div>`;
    })
    .join('');

  /** 白名单里有、但条件不满足的：按乙档灰着列出来，把原因写在按钮上 */
  const gatedGroup =
    gated.length === 0
      ? ''
      : `<div class="recruit-group">
        <div class="recruit-group-title">还造不出来</div>
        <div class="recruit-list">${gated
          .map((d) => {
            const v = verdictOf(d);
            return recruitButton(s, me, d, true, ` · ${v.ok ? '' : v.reason}`);
          })
          .join('')}</div>
      </div>`;

  const groups =
    (buildable.length === 0
      ? emptyRecruitHint(q, pack, eraFilter, buildable.length, '这座营')
      : grouped) + gatedGroup;

  // 档位是这座营自己的，不看后方城市。写清楚是因为玩家会本能地以为"我的城已经五代了，这座营怎么还只出二代兵"。
  const supplyLine = `${eraDef(era).name}`;

  return `
    <div class="unit-head">
      <div class="unit-chip ${camp.owner === 'A' ? 'a' : 'b'}" style="border-radius:8px">${def.short}</div>
      <div>
        <div class="unit-title">${def.name}</div>
        <div class="unit-sub">${s.players[camp.owner].name} · 前线产兵点</div>
      </div>
    </div>
    <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
    <div class="info-row"><span>生命</span><b>${camp.hp} / ${def.maxHp}</b></div>
    <div class="info-row"><span>攻击 / 护甲</span><b>${def.atk} / ${def.armor}</b></div>
    ${
      // 不还手的产兵建筑（宗门大殿：枪口 0）就别写"1 格内每回合 0 点"了
      def.atk > 0
        ? `<div class="info-row"><span>自动开火</span><b>${def.range} 格内每回合 ${def.atk} 点</b></div>`
        : ''
    }
    <div class="info-row"><span>时代</span><b>${supplyLine}</b></div>
    ${
      mine
        ? `<div class="card-title" style="margin-top:14px">${
                    ordering ? `生产 <span class="order-note">点兵种排进本回合队列（${ordersOf(s, me).length}/${CONFIG.commanderSlots}）</span>` : '生产'
                  }</div>
           ${ordering && queueFull ? '<div class="hint">队列已排满，先在上面删两格或者执行一次。</div>' : ''}
           ${packRow(buildable, pack)}
           ${eraChipRow(buildable, eraFilter)}
           ${recruitSearchBox(q, shown.length, buildable.length)}
           ${groups}
           ${
             /*
              * 扩展给这座"营"挂的操作（宗门大殿的研发 / 遗弃）。
              *
              * 必须画在**军营面板**里，不是单位详情卡：产兵建筑点开走的是
              * `renderCamp` 这条支路，压根不会走到 `renderDetail` 的那一份。
              * 以前只画在详情卡上，于是宗门大殿永远只剩"招募弟子"——
              * 研发和遗弃两个按钮根本不存在。
              */
             mine && myTurn ? unitActionBlock(s, camp, me) : ''
           }
           ${
             input.spawnPick
               ? `<div class="hint" style="margin-top:10px">点棋盘上亮起来的水面，把「${
                   s.unitTypes[input.spawnPick.type]?.name ?? input.spawnPick.type
                 }」放下去。点别处就取消。</div>`
               : ''
           }
           <div class="hint" style="margin-top:10px">
             兵从营门四邻的空地出来（当前 ${landOpen} 个空位${
               waterSlots.length > 0 ? `、${waterSlots.length} 格空水面` : ''
             }）。
             <br />这座营按自己的时代出兵。
             ${ordering ? '<br />排进队列之后，AI 执行那一回合才扣钱出兵。' : ''}
           </div>`
        : `<div class="hint" style="margin-top:12px">
             这是${s.players[camp.owner].name}的产兵建筑。
           </div>`
    }
  `;
}

/**
 * 战报。
 *
 * `logSide` 决定"用谁的眼睛看"：
 *   · 一个 PlayerId —— 只看这一方自己的条目，加上棋盘上看得见的战损
 *     （`open` 标记：兵倒下、桥塌、城破）。对面造了什么、走了哪、攒了多少钱，
 *     对己方来说就是免费视野，没理由给——这也是迷雾做了却不做战报过滤时
 *     最容易漏的一个后门。
 *   · null —— 全都看得见：观战位、双 AI 观战、以及一台机器两个人轮流的热座。
 */
function renderLog(input: PanelInput): string {
  const { view, me } = input;
  const scope = input.logSide === undefined ? null : input.logSide;
  const entries = scope ? view.state.log.filter((e) => e.player === scope || e.open === true) : view.state.log;
  if (entries.length === 0) {
    return scope
      ? '<div class="log-empty">还没有己方战报。你做的事和场上的战损会记在这里。</div>'
      : '<div class="log-empty">还没有战报。走第一步吧。</div>';
  }
  const recent = entries.slice(-14).reverse();
  return `<div class="log">${recent
    .map((e) => {
      const side = e.player === 'A' ? 'a' : 'b';
      const label = e.player === me ? '你' : view.state.players[e.player].name;
      // 战损那条挂个"公开"的小标：读的人得知道"这条对面也看得见"
      const open = e.open === true && scope !== null;
      return `<div class="log-item ${side}${open ? ' open' : ''}"><span class="who">${label}</span>${escapeHtml(e.text)}</div>`;
    })
    .join('')}</div>`;
}

/**
 * 状态栏：身上挂着什么、还剩几回合。
 *
 * 为什么非得有：中毒/灼烧/减速/诅咒在结算里是看不见的（效果发生在自己回合
 * 开始的那一刻，玩家只看到"血少了""走不动了"），而诅咒和咒缚还会改护甲，
 * 面板上的护甲数字变了却不知道是谁改的。这一段就是那笔账。
 *
 * 数值口径：`burn` 的值是**层数**，其余状态是**剩余回合**——两者在数据里都是
 * 一个整数，只能按 key 区分。写错单位比不写更糟：一个"中毒 3 层"会让人
 * 以为伤害要乘三。
 */
/** 一条增益徽章的说明：它到底加了什么（悬停时看） */
function buffSummary(buff: NonNullable<Unit['buff']>): string {
  const parts: string[] = [];
  if (buff.armor) parts.push(`护甲 +${buff.armor}`);
  if (buff.armorPct) parts.push(`护甲 +${Math.round(buff.armorPct * 100)}%`);
  if (buff.magicRes) parts.push(`魔抗 +${buff.magicRes}`);
  if (buff.splashImmune) parts.push('免疫溅射');
  return parts.length > 0 ? parts.join('，') : '临时增益';
}

function statusRow(u: Unit): string {
  const chips: string[] = [];
  for (const [key, val] of orderedStatuses(u.status)) {
    const def = STATUS_REGISTRY[key];
    const name = def?.name ?? key;
    const unit = key === 'burn' ? '层' : '回合';
    chips.push(`<span class="status-chip st-${key}" title="${escapeHtml(def?.summary ?? name)}">
        <b>${escapeHtml(name)}</b><i>${val} ${unit}</i>
      </span>`);
  }

  /*
   * 药力 / 技能增益（`u.buff`）也挂在这一排。
   *
   * 它和中毒、减速是同一类东西：**有明确的剩余回合数**，到点自己消失。
   * 以前它只出现在属性下面的修正项里（"甲 +12 护体丹"），那地方读起来
   * 像地形或永久加成——玩家既不知道它会到期，也看不到还剩几回合。
   *
   * 排在减益后面：减益先看（决定这回合该怎么打），增益是"我还剩什么本钱"。
   */
  if (u.buff) {
    const turns = Math.max(1, u.buff.turns ?? 1);
    chips.push(`<span class="status-chip st-buff" title="${escapeHtml(buffSummary(u.buff))}">
        <b>${escapeHtml(u.buff.label ?? '增益')}</b><i>${turns} 回合</i>
      </span>`);
  }

  if (chips.length === 0) return '';
  return `<div class="status-row">${chips.join('')}</div>`;
}

/**
 * 隐匿角标：这条兵此刻藏住了没。
 *
 * 为什么必须有：潜行 / 潜航 / 隐身 2026-11-09 起都是「出手即现形」，
 * 而这条约束在界面上原本一个字都没有。玩家开完一枪只看到战报变了，
 * 不知道自己自此整个敌方回合都露在外面——规则改了却不告诉人，等于没改。
 *
 * 判据不另立一套：能不能藏问 `hidesInFog`，藏住没有问 `hiddenFromAllFoes`，
 * 都是规则层那两个函数。多人局里只要还有一家看得见，就说"已现形"。
 */
function stealthRow(s: GameState, u: Unit, viewer: PlayerId): string {
  if (u.owner !== viewer || !hidesInFog(s, u)) return '';
  const hidden = hiddenFromAllFoes(s, u);
  const title = hidden
    ? '对面看不见它：只有贴到相邻格才会被发现'
    : s.fog === false
      ? '这一局没开迷雾，隐匿不生效'
      : '位置已经暴露：出过手，或者不在森林/丘陵上，或者对面已经贴到身边';
  const chip = hidden
    ? `<span class="status-chip st-stealth" title="${escapeHtml(title)}"><b>隐蔽中</b><i>对面看不见</i></span>`
    : `<span class="status-chip st-exposed" title="${escapeHtml(title)}"><b>已现形</b><i>对面看得见</i></span>`;
  return `<div class="status-row">${chip}</div>`;
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 顶部栏。
 *
 * 这里刻意分成"骨架"和"刷新"两半：骨架只插进 DOM 一次，
 * 之后每一步只改文本、class 和 hidden，**绝不重建按钮节点**。
 *
 * 为什么这么较真：AI 托管时每一步都会 render，如果 topbar.innerHTML 每次重写，
 * 浏览器在 mousedown 和 mouseup 之间就把按钮换成了新节点，
 * 于是 click 事件根本不会派发——表现就是"AI 一跑，什么按钮都点不动"。
 */
export interface TopbarState {
  fog: boolean;
  /** 勾了「浓雾蔽野」：迷雾锁定开启，顶栏那个开关要禁用 */
  blackout: boolean;
  turn: number;
  current: PlayerId;
  currentName: string;
  /** 当前行动方是不是 AI 在走 */
  aiCurrent: boolean;
  /** AI 的档位显示名：'初级 AI' / '高级 AI'。顶栏只有一小块地方，别写全句 */
  aiLevelName: string;
  /** 是否有任一方交给 AI（有才显示暂停/速度） */
  aiAny: boolean;
  paused: boolean;
  speedName: string;
  /** 联机房间码；null 表示本机对局 */
  roomCode: string | null;
  /** 联机里轮到对方了，正在等他提交 */
  waitingForPeer: boolean;
  /** 观战位：既不是等对方，也不是轮到我 */
  spectator?: boolean;
  /**
   * 正在复盘（看一份回放）。
   *
   * 和观战位不是一回事：观战位至少还是**一局活着的棋**，对面可能正在走；
   * 复盘是一段被按停的历史，没有"轮到谁"这回事。所以顶栏要把所有会**改局**的
   * 按钮收起来——暂停 AI / 速度 / 交给 AI / 联机 / 迷雾 / 导出对局。
   * 最后那个尤其要紧：导出的是当前 `state`，而复盘期间 `state` 是别人的棋，
   * 按下去等于把别人的对局当成自己的发出去。
   */
  replay?: boolean;
  /** 上帝模式：全图无雾，两边都归玩家摆，所以"轮到谁"不是重点 */
  god?: boolean;
  /** 指挥官模式：顶栏那颗"交给 AI"要换成"交给参谋部"（同一个动作的另一条入口） */
  commander?: boolean;
  /** 参谋部正在批量执行 */
  commanderRunning?: boolean;
}

/**
 * 顶栏上那个"观战 N 人"。
 *
 * 为什么是由外面塞进来、而不是从 `PlayerView` 里读：观战人数不是对局状态，
 * 它随别人的浏览器开合而变，不该混进存档、也不该参与任何规则计算。
 * 所以它只活在这一层 DOM 上，谁拉到谁写。
 */
export function setWatchCount(n: number): void {
  const el = document.querySelector<HTMLElement>('[data-ref="watch"]');
  if (!el) return;
  const text = n > 0 ? `观战 ${n} 人` : '';
  el.hidden = n <= 0;
  if (el.textContent !== text) el.textContent = text;
}

export function topbarShell(): string {
  return `
    <div class="brand">时代与回旋镖 <small>回合制 · 1v1</small></div>
    <div class="turn-chip" title="当前行动方">
      <b data-ref="turn"></b>
      <span class="side-dot a" data-ref="dot"></span>
      <span data-ref="who"></span>
    </div>
    <!-- 扩展的常驻徽章（季节、以后的潮汐/瘟疫……）：只读文字，由 main 填 -->
    <div class="topbar-badges" data-ref="topbar-badges"></div>
    <!--
      扩展的棋盘视图（灵气、以后的污染/视野……）：chip 由 main 按扩展给的
      定义创建，这里只留容器。没有扩展提供视图时整块不占位。
    -->
    <div class="topbar-ext" data-ref="board-views"></div>
    <button class="room-pill" data-act="online" data-ref="room" title="当前房间" hidden></button>
    <span class="watch-chip" data-ref="watch" title="45 秒内有心跳的观战者人数" hidden></span>
    <div class="topbar-spacer"></div>
    <div class="topbar-actions">
      <button class="btn btn-sm" data-act="ai-pause" data-ref="pause" hidden>暂停 AI</button>
      <button class="btn btn-sm" data-act="ai-speed" data-ref="speed" hidden>速度</button>
      <button class="btn btn-sm" data-act="toggle-ai" data-ref="toggle-ai">交给 AI</button>
      <button class="btn btn-sm" data-act="online" data-ref="online">联机</button>
      <button class="btn btn-sm" data-act="toggle-fog" data-ref="fog">迷雾：开</button>
      <button class="btn btn-sm" data-act="manual">规则书</button>
      <button class="btn btn-sm" data-act="feedback" title="拍下当前局面，报个 bug">反馈</button>
      <button class="btn btn-sm" data-act="export" data-ref="export">导出对局</button>
      <!--
        「兵种编辑器」「导入对局」搬去了开始页面（2026-11-04）：
        这两件事都不是"在对局里做的事"——编辑兵种是先改配置再开局，
        导入是换一局，把它们留在顶栏只会让一排对局操作里混进两个配置入口。
      -->
      <button class="btn btn-sm" data-act="new-game">首页</button>
    </div>
  `;
}

/**
 * 顶栏内容的签名。变了才重写，没变就整段跳过。
 *
 * `render()` 每帧都调它，但顶栏这十几个文字一回合只变几次：回合数、谁在走、
 * 有没有 AI、房间码……全是标量，拼个签名比逐处 `textContent =` 便宜一个数量级。
 *
 * 返回值是"真的改过"，调用方据此决定要不要重新算"顶栏还能不能往两边滚"——
 * 那个判断要读 `scrollWidth`，是一笔强制布局，不能每帧都付。
 */
const topbarSigs = new WeakMap<HTMLElement, string>();

export function updateTopbar(root: HTMLElement, s: TopbarState): boolean {
  const sig = [
    s.turn,
    s.current,
    s.currentName,
    s.aiCurrent ? 1 : 0,
    s.aiLevelName,
    s.aiAny ? 1 : 0,
    s.paused ? 1 : 0,
    s.speedName,
    s.roomCode ?? '',
    s.waitingForPeer ? 1 : 0,
    s.spectator ? 1 : 0,
    s.replay ? 1 : 0,
    s.god ? 1 : 0,
    s.fog ? 1 : 0,
    s.blackout ? 1 : 0,
  ].join('|');
  if (topbarSigs.get(root) === sig) return false;
  topbarSigs.set(root, sig);

  const ref = (name: string) => root.querySelector<HTMLElement>(`[data-ref="${name}"]`);

  const turn = ref('turn');
  if (turn) turn.textContent = `第 ${s.turn} 回合`;

  const dot = ref('dot');
  if (dot) dot.className = `side-dot ${s.current === 'A' ? 'a' : 'b'}`;

  const who = ref('who');
  if (who) {
    who.textContent = s.replay
      ? '复盘 · 全图'
      : s.god
        ? '上帝模式 · 全图'
        : s.spectator
          ? '观战 · 全图'
          : s.waitingForPeer
            ? '等待对方提交'
            : s.currentName + (s.aiCurrent ? ` · ${s.aiLevelName}` : '');
  }

  const room = ref('room');
  if (room) {
    room.hidden = !s.roomCode;
    if (s.roomCode) room.textContent = `${s.spectator ? '观战' : '房间'} ${s.roomCode}`;
  }

  const pause = ref('pause');
  if (pause) {
    // 复盘里没有"AI 在走"这回事：那段棋已经下完了，按钮只剩误触
    pause.hidden = !s.aiAny || s.replay === true;
    pause.textContent = s.paused ? '继续' : '暂停 AI';
  }

  const speed = ref('speed');
  if (speed) {
    speed.hidden = !s.aiAny || s.replay === true;
    speed.textContent = `速度 ${s.speedName}`;
  }

  const ai = ref('toggle-ai');
  if (ai) {
    // 沙盒里"托管某一方"这个开关没有意义：两边本来就归 AI 打，
    // 而顶栏这个按钮会把它变成"回合自动往前跑"，摆兵就摆不安稳了。
    ai.hidden = s.god === true || s.replay === true;
    // 指挥官模式：这一方本来就在 AI 手里，"交给 AI / 收回操作权"没有第二种解释。
    // 这里的按钮改成同一件事的另一个入口——执行一批再交还，和参谋部那颗同源，
    // 顺手点错不会把对面也托管掉。
    ai.textContent = s.commander
      ? s.commanderRunning
        ? '参谋部执行中…'
        : '交给参谋部'
      : s.aiCurrent
        ? '收回操作权'
        : '交给 AI';
    ai.classList.toggle('btn-primary', s.commander ? false : s.aiCurrent);
    (ai as HTMLButtonElement).disabled = s.commander === true && s.commanderRunning === true;
  }

  const fog = ref('fog');
  if (fog) {
    // 浓雾扩展下不给关：这个扩展的全部意义就是"地图本身看不见"，
    // 允许关掉雾等于让它失效
    fog.textContent = s.blackout ? '迷雾：浓雾（锁定）' : `迷雾：${s.fog ? '开' : '关'}`;
    fog.classList.toggle('is-locked', s.blackout);
    // 复盘里这个开关改的是"别人那局"的雾：改了既存不下来，也会把画面调歪
    fog.hidden = s.replay === true;
  }

  /*
   * 复盘：把所有会改局的入口收起来。
   *
   * 不是"禁用了但看得见"——那会让人反复去点。玩家在复盘里能做的事只有
   * 看棋盘、看属性卡、拖进度条、退出，剩下的按钮在这一屏没有第二个意思。
   * 「规则书」「反馈」「首页」留着：它们不碰这一局。
   */
  const online = ref('online');
  if (online) online.hidden = s.replay === true;
  const exp = ref('export');
  if (exp) exp.hidden = s.replay === true;
  return true;
}

export const TERRAIN_NAMES = CONFIG.terrainName;


/**
 * 装甲面板：已装模块 + 可装模块 + 供电读数。
 *
 * 不是装甲素体就返回空串——普通兵的面板一个字都不变。
 * 所有按钮都带着"为什么不能装"的 title：玩家不该为了问一句"为什么点不动"
 * 去翻规则书，这也是这个面板存在的理由。
 */
/** 五个槽位的中文单字（和装配按钮上那枚角标同一套） */
const SLOT_CHAR: Record<string, string> = { main: '主', sub: '副', plate: '甲', system: '统', device: '设' };

/**
 * 这台素体的插槽用了几个 / 一共几个。
 *
 * 以前面板上只有"能装什么"，从不写"还剩几个槽"——玩家装了三件之后
 * 不知道还能不能再装，只能一件件点过去试，被拒了才知道满了。
 */
function slotLine(def: UnitTypeDef, u: Unit): string {
  const caps: Record<string, number> = def.slots ?? {};
  const used: Record<string, number> = {};
  for (const id of modulesOf(u)) {
    const slot = MODULES[id]?.slot;
    if (slot) used[slot] = (used[slot] ?? 0) + 1;
  }
  const order = ['main', 'sub', 'plate', 'system', 'device'];
  const totalCap = order.reduce((n, k) => n + (caps[k] ?? 0), 0);
  const totalUsed = order.reduce((n, k) => n + (used[k] ?? 0), 0);
  const detail = order
    .filter((k) => (caps[k] ?? 0) > 0)
    .map((k) => `${SLOT_CHAR[k]}${used[k] ?? 0}/${caps[k]}`)
    .join(' · ');
  return `${totalUsed}/${totalCap}${detail ? `（${detail}）` : ''}`;
}

/**
 * 电力收支条：一条横条 + 三个数。
 *
 * 纯文字"供电 42 / 需求 26"玩家得自己减；这里直接把"用掉多少"画出来，
 * 过载时整条变红——装配坞最常见的挫败就是"装上去才发现过载"。
 */
function powerBlock(s: GameState, owner: PlayerId): string {
  const bk = energyBreakdown(s, owner);
  const over = bk.headroom < 0;
  const pct = bk.supply > 0 ? Math.min(100, Math.round((bk.demand / bk.supply) * 100)) : bk.demand > 0 ? 100 : 0;
  const gen =
    bk.modulePower > 0
      ? `发电厂 ${bk.plantPower} + 装备 ${bk.modulePower}`
      : `发电厂 ${bk.plantPower}`;
  return `<div class="power-line">
    <div class="power-bar"><i class="${over ? 'over' : ''}" style="width:${pct}%"></i></div>
    <div class="power-nums">
      <span>产能 <b>${bk.supply}</b> <em>${gen}</em></span>
      <span>已用 <b>${bk.demand}</b></span>
      <span class="${over ? 'over' : ''}">${over ? `过载 <b>${-bk.headroom}</b>` : `余量 <b>${bk.headroom}</b>`}</span>
    </div>
  </div>
  <div class="hint">${bk.plants} 座电站 · ${bk.frames} 台装甲在吃电</div>`;
}

function armorBlock(s: GameState, u: Unit, canAct: boolean): string {
  const def = s.unitTypes[u.type];
  if (!def?.armorFrame) return '';
  const off = offlineModules(s, u);
  const mine = modulesOf(u);

  const installed = mine.map((id) => {
    const m = MODULES[id];
    if (!m) return '';
    const dead = off.has(id);
    // 数据特性写在第二行：以前只写"耗能 N"，装甲板/系统槽装了什么都看不见
    return `<button class="recruit-btn" data-act="unmount" data-mod="${id}" ${canAct ? '' : 'disabled'}
      title="${escapeHtml(moduleSpecText(m))}">
      <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">拆</span>
      <span class="meta"><b>${m.name}${dead ? ' · 断电' : ''}</b><span>耗电 ${m.draw} · ${escapeHtml(moduleSpecText(m))}</span></span>
      <span class="price">+${Math.floor(m.cost / 2)}</span>
    </button>`;
  });

  const candidates = Object.values(MODULES)
    .filter((m) => !mine.includes(m.id))
    .filter((m) => fitsFrame(u, def, m))
    .map((m) => {
      const chk = canMount(s, u, m.id);
      const why = chk.ok ? '' : (chk.reason ?? '');
      return `<button class="recruit-btn" data-act="mount" data-mod="${m.id}" ${chk.ok && canAct ? '' : 'disabled'} title="${escapeHtml(why)}">
        <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${m.slot === 'main' ? '主' : m.slot === 'sub' ? '副' : m.slot === 'plate' ? '甲' : m.slot === 'system' ? '统' : '设'}</span>
        <span class="meta"><b>${m.name}</b><span>耗电 ${m.draw} · ${escapeHtml(moduleSpecText(m))}${
          why ? ` · <b style="color:#b4463c">${escapeHtml(why)}</b>` : ''
        }</span></span>
        <span class="price">${m.cost}</span>
      </button>`;
    });

  // ── 设备（P5）：每件一行「用」，整备臂那种要选人的再按友军各出一行 ──
  const chip = u.owner === 'A' ? 'a' : 'b';
  const devRow = (id: string, label: string, sub: string, price: string, act: string, target?: string): string => {
    const chk = canUseDevice(s, u, id);
    const why = chk.ok ? '' : (chk.reason ?? '');
    return `<button class="recruit-btn" data-act="${act}" data-mod="${id}"${target ? ` data-target="${target}"` : ''} ${
      chk.ok && canAct ? '' : 'disabled'
    } title="${escapeHtml(why)}">
      <span class="unit-chip ${chip}" style="width:26px;height:26px;font-size:12px">用</span>
      <span class="meta"><b>${label}</b><span>${escapeHtml(why || sub)}</span></span>
      <span class="price">${price}</span>
    </button>`;
  };

  const deviceRows: string[] = [];
  for (const { id, m } of devicesOf(u)) {
    const left = chargesLeft(u, id);
    const cap = m.charges ?? 0;
    const head = `<div class="hint">${m.name} · 剩 ${left} / ${cap} 次</div>`;
    if (deviceTargetOf(m.device) === 'unit') {
      const allies = s.units.filter(
        (t) =>
          t.owner === u.owner &&
          t.id !== u.id &&
          t.hp > 0 &&
          Math.max(Math.abs(t.x - u.x), Math.abs(t.y - u.y)) <= 1,
      );
      const rows = allies.map((t) =>
        devRow(id, `${m.name} → ${s.unitTypes[t.type]?.name ?? t.type}`, m.note ?? '', '使用', 'use-device', t.id),
      );
      deviceRows.push(head + (rows.length ? rows.join('') : `<div class="hint">身边没有可以整备的友军。</div>`));
      continue;
    }
    const hint =
      deviceTargetOf(m.device) === 'tile' ? '点了之后在地图上选落点（3 格内）' : (m.note ?? '');
    deviceRows.push(head + devRow(id, m.name, hint, '使用', 'use-device'));
  }

  // 整备：按缺口付费，占掉这座坞本回合的名额
  const rc = rechargeQuote(s, u);
  const rcChk = canRecharge(s, u);
  const rechargeRow = `<button class="recruit-btn" data-act="recharge" ${rcChk.ok && canAct ? '' : 'disabled'} title="${escapeHtml(
    rcChk.ok ? '' : (rcChk.reason ?? ''),
  )}">
    <span class="unit-chip ${chip}" style="width:26px;height:26px;font-size:12px">补</span>
    <span class="meta"><b>整备</b><span>${escapeHtml(
      rcChk.ok ? `补满充能与额外生命（${rc.devices} 件设备 · 额外生命 +${rc.hpGap}）` : (rcChk.reason ?? ''),
    )}</span></span>
    <span class="price">${rcChk.ok ? rc.total : '—'}</span>
  </button>`;

  return `<div class="card-title" style="margin-top:14px">装配 · 电力</div>
  ${powerBlock(s, u.owner)}
  <div class="info-row"><span>插槽</span><b>${slotLine(def, u)}</b></div>
  <div class="hint">这台耗电 ${unitDraw(s, u)}（素体 ${def.draw ?? 0} + 模块 ${unitDraw(s, u) - (def.draw ?? 0)}）。装配要贴着装配坞、花掉它整回合；拆卸不花回合、退一半金币。</div>
  ${installed.length > 0 ? `<div class="recruit-list" style="margin-top:8px">${installed.join('')}</div>` : `<div class="hint">还没装任何模块——素体只有撞击。</div>`}
  ${candidates.length > 0 ? `<div class="recruit-list" style="margin-top:8px">${candidates.join('')}</div>` : ''}
  ${
    deviceRows.length > 0
      ? `<div class="card-title" style="margin-top:14px">设备</div>${deviceRows.join('')}`
      : ''
  }
  <div class="recruit-list" style="margin-top:8px">${rechargeRow}</div>`;
}

/**
 * 开局设置面板。
 *
 * 这是给"每次开局想换个玩法"准备的：棋盘多大、开哪些扩展、用哪些兵种。
 * 面板只负责收集选择，真正的校验和构建交给 createMatch。
 */

import { ERAS } from '../core/config.ts';
import { allAvailableUnits } from './unit-editor.ts';
import { EXPANSIONS, availableExpansions, expansionById } from '../core/expansions.ts';
import { MAP_STYLES, MAP_SYMMETRIES, mapStylesFor } from '../core/mapgen.ts';
import {
  BOARD_SIZES,
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  clampBoardSize,
  randomSeed,
} from '../core/setup.ts';
import type { MatchConfig } from '../core/types.ts';

export interface SetupResult {
  config: MatchConfig;
  seed: number;
}

/**
 * 起始时代对应的标准棋盘尺寸。
 *
 * 这是"标准对局"的默认组合：古典配小图打快棋，火药之后配大图拉开战线。
 * 玩家当然可以手动改尺寸——这里只是把默认值调成匹配的。
 */
export function DEFAULT_SIZE_FOR_ERA(era: number): number {
  if (era <= 1) return 12;
  if (era === 2) return 16;
  return 20;
}

/**
 * 这个开关的选择记住在哪。
 *
 * 不放进 state.config 就够了吗？不够——config 跟着**这一局**走，清存档、换浏览器就没了。
 * 玩家说的"只勾一次"是"以后每次开新局都别再让我勾"，所以单独存一份偏好。
 * 优先级：本机偏好 > 上一局 config > 关。
 */
const RECORD_PREF_KEY = 'warchess.setup.record';

function loadRecordPref(): boolean | null {
  try {
    const raw = localStorage.getItem(RECORD_PREF_KEY);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function saveRecordPref(on: boolean): void {
  try {
    localStorage.setItem(RECORD_PREF_KEY, on ? '1' : '0');
  } catch {
    // 隐私模式写不进去：这一次有效，下次回到上一局 config 的值
  }
}

export function openSetupPanel(initial: MatchConfig, seed: number): Promise<SetupResult | null> {
  return new Promise((resolve) => {
    const config: MatchConfig = {
      size: initial.size,
      startEra: initial.startEra,
      aiOpponent: initial.aiOpponent,
      aiAlly: initial.aiAlly,
      aiLevel: initial.aiLevel === 'basic' ? 'basic' : initial.aiLevel === 'tactic' ? 'tactic' : 'advanced',
      mapStyle: initial.mapStyle ?? 'random',
      mapSymmetry: initial.mapSymmetry ?? 'fair',
      expansionIds: [...initial.expansionIds],
      enabledUnits: [...initial.enabledUnits],
      commanderMode: initial.commanderMode === true,
      godMode: initial.godMode === true,
      // 这里也是逐个字段抄的：漏一个，界面上那个开关就等于永远关着。
      // 优先用本机偏好（"只勾一次"），其次沿用上一局的选择，最后才是关。
      recordDetail: loadRecordPref() ?? initial.recordDetail === true,
    };
    let currentSeed = seed;

    const mask = document.createElement('div');
    mask.className = 'modal-mask';

    const close = (result: SetupResult | null) => {
      mask.remove();
      resolve(result);
    };

    const toggleUnit = (id: string) => {
      if (config.enabledUnits.includes(id)) {
        if (config.enabledUnits.length <= 1) return;
        config.enabledUnits = config.enabledUnits.filter((x) => x !== id);
      } else {
        config.enabledUnits.push(id);
      }
    };

    /** 把一颗按钮翻译回选择器，重绘之后靠它把键盘焦点还给同一个按钮 */
    const selectorFor = (el: HTMLElement): string | null => {
      const d = el.dataset;
      if (d.unit) return `[data-unit="${d.unit}"]`;
      if (d.era) return `[data-era="${d.era}"]`;
      if (d.size) return `[data-size="${d.size}"]`;
      if (d.mapstyle) return `[data-mapstyle="${d.mapstyle}"]`;
      if (d.exp) return `[data-exp="${d.exp}"]`;
      if (d.symmetry) return `[data-symmetry="${d.symmetry}"]`;
      if (d.ailevel) return `[data-ailevel="${d.ailevel}"]`;
      if (d.ai !== undefined) return `[data-ai="${d.ai}"]`;
      if (d.act) return `[data-act="${d.act}"]`;
      return null;
    };

    const paint = () => {
      // 面板是整块 innerHTML 换掉的，重绘会把滚动位置和键盘焦点一起清零。
      // 兵种池在面板最下面，点一个兵种就"弹回顶部"就是这么来的——
      // 所以先把两者记下来，画完再搬回去。
      const prevBody = mask.querySelector<HTMLElement>('.modal-body');
      const prevScrollTop = prevBody?.scrollTop ?? 0;
      const prevScrollLeft = prevBody?.scrollLeft ?? 0;
      const prevFocusEl = document.activeElement;
      const prevFocus =
        prevFocusEl instanceof HTMLElement && mask.contains(prevFocusEl)
          ? selectorFor(prevFocusEl)
          : null;

      const eraChips = ERAS.map(
        (e) =>
          `<button class="chip ${config.startEra === e.level ? 'active' : ''}" data-era="${e.level}">${e.name}</button>`,
      ).join('');

      // 地貌跟着扩展走：勾了「地形高差」才多出高原 / 峡谷 / 火山群 / 沼泽 / 群岛 / 大川。
      // 这里每次都按当前勾选重算，所以开关扩展时列表会立刻增减——
      // "勾了才有这些按钮"，不需要另外判断，列表本身就是扩展开关的镜子。
      const styles = mapStylesFor(config.expansionIds);
      const styleChips = styles
        .map(
          (st) =>
            `<button class="chip ${config.mapStyle === st.id ? 'active' : ''}" data-mapstyle="${st.id}" title="${st.note}">${st.name}</button>`,
        )
        .join('');
      // 提示也跟着变：没勾扩展时说清"多出来的地貌去哪了"，勾了就说现在是几种
      const extraStyles = styles.length - MAP_STYLES.length;
      const styleHint =
        extraStyles > 0
          ? `共 ${styles.length} 种：扩展额外解锁了 ${extraStyles} 种；随机＝每局抽一种`
          : '决定天险长什么样；随机＝每局抽一种。勾上带地貌的扩展会在这里多出选项';

      const symChips = MAP_SYMMETRIES.map(
        (sy) =>
          `<button class="chip ${config.mapSymmetry === sy.id ? 'active' : ''}" data-symmetry="${sy.id}" title="${sy.note}">${sy.name}</button>`,
      ).join('');

      // 只在对局里有 AI 的时候才给难度选项：双人热座选它没有意义
      const aiOn = config.aiOpponent || config.aiAlly;
      const aiLevelChips = aiOn
        ? `<div class="chip-row ai-level-row">
            <button class="chip ${config.aiLevel === 'basic' ? 'active' : ''}" data-ailevel="basic" title="只想着往前推：不算对面能打到哪，也不挑交换比">初级 AI</button>
            <button class="chip ${config.aiLevel === 'tactic' ? 'active' : ''}" data-ailevel="tactic" title="在高级的评估之上再挂三套战术：速攻压制、骚扰消耗、弃城爆发——打法会随局面换档">中级 AI</button>
            <button class="chip ${config.aiLevel === 'advanced' ? 'active' : ''}" data-ailevel="advanced" title="威胁范围、换子价值、有效战力、现金预算、英雄技优先级都算，走位与采购按局势定">高级 AI</button>
          </div>
          <div class="field-hint">初级适合熟悉规则；中级会随局面换打法（速攻 / 骚扰 / 弃城）；高级算得最细，走位与采购都稳</div>`
        : '';

      const sizeChips = BOARD_SIZES.map(
        (s) =>
          `<button class="chip ${config.size === s ? 'active' : ''}" data-size="${s}">${s} × ${s}</button>`,
      ).join('');

      // 兵种按时代分组展示：一眼看出哪些是开局就有、哪些要升级城市才能造
      const catalog = allAvailableUnits();
      const unitGroups = ERAS.map((era) => {
        const units = Object.values(catalog).filter((u) => u.era === era.level);
        if (units.length === 0) return '';
        const chips = units
          .map(
            (u) =>
              `<button class="chip ${config.enabledUnits.includes(u.id) ? 'active' : ''}" data-unit="${u.id}">
                 ${u.short} ${u.name}
               </button>`,
          )
          .join('');
        return `<div class="era-group">
          <span class="era-tag">${era.name}</span>
          <div class="chip-row">${chips}</div>
        </div>`;
      }).join('');

      // 前置关系直接写在卡片上：一个"勾了却不生效"的开关比没有这个开关更糟
      const reqLine = (id: string): string => {
        const need = expansionById(id)?.requires ?? [];
        if (need.length === 0) return '';
        const names = need.map((r) => expansionById(r)?.name ?? r).join('、');
        return `<span class="expansion-req">需先开：${names}</span>`;
      };
      // 隐藏的扩展（规则在跑但玩家还选不到）不列出来
      const expItems = availableExpansions().map(
        (e) => `
        <label class="expansion-item ${config.expansionIds.includes(e.id) ? 'on' : ''}">
          <input type="checkbox" data-exp="${e.id}" ${config.expansionIds.includes(e.id) ? 'checked' : ''} />
          <span class="expansion-body">
            <b>${e.name}</b>
            <span>${e.summary}</span>
            ${reqLine(e.id)}
          </span>
        </label>`,
      ).join('');

      mask.innerHTML = `
        <div class="modal">
          <div class="modal-head">
            <h2>新对局</h2>
            <p>选好规则再开局。扩展规则会改变伤害、经济或视野的计算方式。</p>
          </div>

          <div class="modal-body">
            <section class="field">
              <div class="field-label">
                数据收集 <span class="field-hint">会在下次开新局时沿用这次的选择</span>
              </div>
              <label class="expansion-item ${config.recordDetail ? 'on' : ''}">
                <input type="checkbox" data-field="record" ${config.recordDetail ? 'checked' : ''} />
                <span class="expansion-body">
                  <b>结束后上传这局的详细数据</b>
                  <span>
                    每回合记一行压缩数字（双方兵力 / 城防 / 金币 / 军队身价），
                    外加双方的出兵与行动次数——只交终局快照看不出"这局是怎么崩的"。
                    不记玩家名、房间码，也不记每一步走哪儿。
                    勾一次就记住了，之后每次开新局都沿用；想改随时再点一下。
                    勾上之后结算卡的「允许上传」会自动打勾，但实际发送仍然要你点一下。
                  </span>
                </span>
              </label>
            </section>

            <section class="field">
              <div class="field-label">对手 <span class="field-hint">AI 会跟你一样受迷雾限制</span></div>
              ${
                config.godMode
                  ? `<div class="field-hint">上帝模式是纯单人沙盒：两边都归你摆，AI 只在点「交给 AI」时同时操控两边。</div>`
                  : `<div class="chip-row">
                <button class="chip ${!config.aiOpponent && !config.aiAlly ? 'active' : ''}" data-ai="0">双人热座</button>
                <button class="chip ${config.aiOpponent && !config.aiAlly ? 'active' : ''}" data-ai="1">人机对战</button>
                <button class="chip ${config.aiAlly ? 'active' : ''}" data-ai="2">双 AI 观战</button>
              </div>
              ${aiLevelChips}`
              }
            </section>

            <section class="field">
              <div class="field-label">
                起始时代 <span class="field-hint">从哪一级开始；越高一局越短</span>
              </div>
              <div class="chip-row">${eraChips}</div>
            </section>

            <section class="field">
              <div class="field-label">
                棋盘大小 <span class="field-hint">预设之外可以自己填 ${MIN_BOARD_SIZE}~${MAX_BOARD_SIZE}</span>
              </div>
              <div class="chip-row">${sizeChips}</div>
              <div class="size-row">
                <input class="text-input size-input" data-field="size" type="number"
                  min="${MIN_BOARD_SIZE}" max="${MAX_BOARD_SIZE}" step="1"
                  value="${config.size}" inputmode="numeric" aria-label="自定义棋盘边长" />
                <span class="field-hint">边长（格）。${MIN_BOARD_SIZE}×${MIN_BOARD_SIZE} 是"街角斗殴"图，64×64 要配合缩放看。</span>
              </div>
            </section>

            <section class="field">
              <div class="field-label">
                你的角色 <span class="field-hint">指挥官模式：只决定造什么兵，其余交给 AI</span>
              </div>
              <div class="chip-row">
                <button class="chip ${!config.commanderMode && !config.godMode ? 'active' : ''}" data-role="full" title="每个单位都由你自己走、自己打">亲自指挥</button>
                <button class="chip ${config.commanderMode ? 'active' : ''}" data-role="commander" title="你只排接下来几回合造什么，建造、移动、攻击、升级全部由 AI 执行">指挥官模式</button>
                <button class="chip ${config.godMode ? 'active' : ''}" data-role="god" title="纯单人沙盒：不要金币、不看回合，随手摆兵摆城，然后让 AI 同时操控两边打给你看">上帝模式</button>
              </div>
              <div class="field-hint">${
                config.godMode
                  ? '上帝模式下棋盘全图可见：点兵种→点棋盘落子，摆完点「交给 AI · 一回合」看一回合，或者「接管 · 打到全灭」看完整场。'
                  : '指挥官模式下棋盘只看不碰：每回合调好生产序列，点一次就交给参谋部打完。配合「双 AI 观战」可以量出这套限制下 AI 的表现。'
              }</div>
            </section>

            <section class="field">
              <div class="field-label">
                地貌 <span class="field-hint">${styleHint}</span>
              </div>
              <div class="chip-row">${styleChips}</div>
            </section>

            <section class="field">
              <div class="field-label">
                地形对称 <span class="field-hint">地势各异：两侧地形数量相同、分布不同</span>
              </div>
              <div class="chip-row">${symChips}</div>
            </section>

            <section class="field">
              <div class="field-label">
                兵种池 <span class="field-hint">至少留一个；高时代兵种要城市升级后才能生产</span>
              </div>
              ${unitGroups}
            </section>

            <section class="field">
              <div class="field-label">扩展规则 <span class="field-hint">可多选，效果叠加</span></div>
              <div class="expansion-list">${expItems}</div>
            </section>

            <section class="field">
              <div class="field-label">地图种子</div>
              <div class="seed-row">
                <code>${currentSeed}</code>
                <button class="btn btn-sm" data-act="reroll">换一张地图</button>
              </div>
              <div class="field-hint">同一个种子永远生成同一张地图，方便复盘和公平对战。</div>
            </section>
          </div>

          <div class="modal-foot">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn btn-primary" data-act="start">开始对局</button>
          </div>
        </div>
      `;

      // 把滚动位置与焦点搬回重绘前的状态
      const nextBody = mask.querySelector<HTMLElement>('.modal-body');
      if (nextBody) {
        nextBody.scrollTop = prevScrollTop;
        nextBody.scrollLeft = prevScrollLeft;
      }
      if (prevFocus) {
        mask.querySelector<HTMLElement>(prevFocus)?.focus({ preventScroll: true });
      }
    };

    mask.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target === mask) {
        close(null);
        return;
      }

      const aiBtn = target.closest<HTMLElement>('[data-ai]');
      if (aiBtn?.dataset.ai !== undefined) {
        const mode = aiBtn.dataset.ai;
        config.aiAlly = mode === '2';
        config.aiOpponent = mode === '1' || mode === '2';
        // 指挥官模式保留：双 AI 观战时两边都受"一回合一个兵"的限制，
        // 这正是用来量"这套限制下 AI 到底能打成什么样"的场景。
        paint();
        return;
      }

      const roleBtn = target.closest<HTMLElement>('[data-role]');
      if (roleBtn?.dataset.role) {
        const role = roleBtn.dataset.role;
        config.commanderMode = role === 'commander';
        config.godMode = role === 'god';
        // 指挥官模式必须对着 AI 打：热座两边都是人，就没人执行战术了
        if (config.commanderMode) {
          config.aiOpponent = true;
          config.aiAlly = false;
        }
        // 上帝模式是纯单人沙盒：两边都由玩家摆，托管开关留着只会
        // 让某一方在开局就自己跑起来，"摆完再看"这件事就做不到了
        if (config.godMode) {
          config.aiOpponent = false;
          config.aiAlly = false;
          config.commanderMode = false;
        }
        paint();
        return;
      }

      const lvBtn = target.closest<HTMLElement>('[data-ailevel]');
      if (lvBtn?.dataset.ailevel) {
        const lv = lvBtn.dataset.ailevel;
        config.aiLevel = lv === 'basic' ? 'basic' : lv === 'tactic' ? 'tactic' : 'advanced';
        paint();
        return;
      }

      const eraBtn = target.closest<HTMLElement>('[data-era]');
      if (eraBtn?.dataset.era) {
        config.startEra = Number(eraBtn.dataset.era);
        // 选时代会顺手把棋盘换成这个时代的"标准尺寸"：
        // 古典 12×12、中世 16×16、火药/工业/现代 20×20。
        // 理由是实测出来的——小图配现代开局，摆不下几个兵就打成一团；
        // 大图配古典开局，两边要走十个回合才照面。
        config.size = DEFAULT_SIZE_FOR_ERA(config.startEra);
        paint();
        return;
      }

      const sizeBtn = target.closest<HTMLElement>('[data-size]');
      if (sizeBtn?.dataset.size) {
        config.size = Number(sizeBtn.dataset.size);
        paint();
        return;
      }

      const styleBtn = target.closest<HTMLElement>('[data-mapstyle]');
      if (styleBtn?.dataset.mapstyle) {
        config.mapStyle = styleBtn.dataset.mapstyle as NonNullable<MatchConfig['mapStyle']>;
        paint();
        return;
      }

      const symBtn = target.closest<HTMLElement>('[data-symmetry]');
      if (symBtn?.dataset.symmetry) {
        config.mapSymmetry = symBtn.dataset.symmetry as NonNullable<MatchConfig['mapSymmetry']>;
        paint();
        return;
      }

      const unitBtn = target.closest<HTMLElement>('[data-unit]');
      if (unitBtn?.dataset.unit) {
        const id = unitBtn.dataset.unit;
        const before = config.enabledUnits.length;
        toggleUnit(id);
        // 只翻转这一颗 chip 的样式，不重绘整个面板。
        // 兵种池在面板最底下，重绘会把滚动位置清零，点一下就像被弹回顶部；
        // 而且全部重绘还会让 chip 闪一下。和上面扩展勾选是同一套做法。
        if (config.enabledUnits.length !== before) {
          unitBtn.classList.toggle('active', config.enabledUnits.includes(id));
        }
        return;
      }

      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel') close(null);
      if (act === 'start') {
        // 按注册顺序固定下来：同样的勾选组合，不管点击先后，生效顺序都一样。
        // 钩子是有叠加效果的，顺序漂移会让"同一局"算出不同结果。
        // 前置补齐再排序。勾选时已经补过一次，这里再补一次是因为
        // 配置也可能从别处进来（存档、分享的链接），不能假设它自洽。
        const ids = new Set(config.expansionIds);
        for (const id of Array.from(ids)) {
          for (const need of expansionById(id)?.requires ?? []) ids.add(need);
        }
        const ordered = EXPANSIONS.filter((e) => ids.has(e.id)).map((e) => e.id);
        close({ config: { ...config, expansionIds: ordered }, seed: currentSeed });
      }
      if (act === 'reroll') {
        currentSeed = randomSeed();
        paint();
      }
    });

    /**
     * 自定义边长输入。
     *
     * 每敲一下就夹一次范围并立刻生效，但**不重绘面板**——
     * 重绘会把输入框换成新节点，光标和还没输完的数字都会被吞掉
     * （"想输 24，输到 2 就被重绘回 12"）。只同步 chip 的高亮即可。
     */
    const applySizeInput = (input: HTMLInputElement, commit: boolean): void => {
      config.size = clampBoardSize(input.value);
      mask.querySelectorAll<HTMLElement>('[data-size]').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.size) === config.size);
      });
      // commit = 失焦/回车：这时候把夹过的值写回框里，免得留着一个越界的 999
      if (commit) input.value = String(config.size);
    };
    mask.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.field === 'size') applySizeInput(input, false);
    });
    mask.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.field === 'size') {
        applySizeInput(input, true);
        return;
      }
      if (input.dataset.field === 'record') {
        config.recordDetail = input.checked;
        saveRecordPref(input.checked);
        // 只翻转卡片边框，不整块重绘：checkbox 重绘会闪，焦点也会丢
        input.closest('.expansion-item')?.classList.toggle('on', input.checked);
        return;
      }
      const id = input.dataset.exp;
      if (!id) return;
      // 地貌列表是扩展的函数：勾上/取消可能让"地貌"一栏多出或少掉几个 chip。
      // 记下变动前后的选项数，变了就整块重绘（不重绘的话新 chip 要等下次重绘才出现）。
      const stylesBefore = mapStylesFor(config.expansionIds).length;
      if (input.checked) {
        if (!config.expansionIds.includes(id)) config.expansionIds.push(id);
        // 自动补上前置：勾了「骑士团」却没勾「法则」，这包兵根本不会进场。
        for (const need of expansionById(id)?.requires ?? []) {
          if (config.expansionIds.includes(need)) continue;
          config.expansionIds.push(need);
          const box = mask.querySelector<HTMLInputElement>(`[data-exp="${need}"]`);
          if (box) {
            box.checked = true;
            box.closest('.expansion-item')?.classList.add('on');
          }
        }
      } else {
        config.expansionIds = config.expansionIds.filter((x) => x !== id);
      }
      // 关掉「地形高差」之后，原来选中的高原/峡谷必须退回"随机"——
      // 不然会画出一张满地图台地、但规则里没有高度的图。
      const available = mapStylesFor(config.expansionIds);
      if (!available.some((st) => st.id === (config.mapStyle ?? 'random'))) {
        config.mapStyle = 'random';
      }
      // 选项数变了就重绘（地貌 chip 要增删）。其余情况只改边框，避免 checkbox 闪。
      if (available.length !== stylesBefore) {
        paint();
        return;
      }
      // 让卡片边框跟着变，不重绘整个面板（否则 checkbox 会闪）
      input.closest('.expansion-item')?.classList.toggle('on', input.checked);
    });

    paint();
    document.body.appendChild(mask);
  });
}

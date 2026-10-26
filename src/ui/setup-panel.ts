/**
 * 开局设置面板。
 *
 * 这是给"每次开局想换个玩法"准备的：棋盘多大、开哪些扩展、用哪些兵种。
 * 面板只负责收集选择，真正的校验和构建交给 createMatch。
 */

import { ERAS } from '../core/config.ts';
import { allAvailableUnits } from './unit-editor.ts';
import { EXPANSIONS } from '../core/expansions.ts';
import { MAP_STYLES, MAP_SYMMETRIES } from '../core/mapgen.ts';
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

export function openSetupPanel(initial: MatchConfig, seed: number): Promise<SetupResult | null> {
  return new Promise((resolve) => {
    const config: MatchConfig = {
      size: initial.size,
      startEra: initial.startEra,
      aiOpponent: initial.aiOpponent,
      aiAlly: initial.aiAlly,
      aiLevel: initial.aiLevel === 'basic' ? 'basic' : 'advanced',
      mapStyle: initial.mapStyle ?? 'random',
      mapSymmetry: initial.mapSymmetry ?? 'fair',
      expansionIds: [...initial.expansionIds],
      enabledUnits: [...initial.enabledUnits],
      commanderMode: initial.commanderMode === true,
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

      const styleChips = MAP_STYLES.map(
        (st) =>
          `<button class="chip ${config.mapStyle === st.id ? 'active' : ''}" data-mapstyle="${st.id}" title="${st.note}">${st.name}</button>`,
      ).join('');

      const symChips = MAP_SYMMETRIES.map(
        (sy) =>
          `<button class="chip ${config.mapSymmetry === sy.id ? 'active' : ''}" data-symmetry="${sy.id}" title="${sy.note}">${sy.name}</button>`,
      ).join('');

      // 只在对局里有 AI 的时候才给难度选项：双人热座选它没有意义
      const aiOn = config.aiOpponent || config.aiAlly;
      const aiLevelChips = aiOn
        ? `<div class="chip-row ai-level-row">
            <button class="chip ${config.aiLevel === 'basic' ? 'active' : ''}" data-ailevel="basic" title="只想着往前推：不算对面能打到哪，也不挑交换比">初级 AI</button>
            <button class="chip ${config.aiLevel === 'advanced' ? 'active' : ''}" data-ailevel="advanced" title="会算威胁范围、换子价值和兵种搭配，走位明显更刁">高级 AI</button>
          </div>
          <div class="field-hint">初级适合熟悉规则；高级会躲炮口、会挑软的打</div>`
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

      const expItems = EXPANSIONS.map(
        (e) => `
        <label class="expansion-item ${config.expansionIds.includes(e.id) ? 'on' : ''}">
          <input type="checkbox" data-exp="${e.id}" ${config.expansionIds.includes(e.id) ? 'checked' : ''} />
          <span class="expansion-body">
            <b>${e.name}</b>
            <span>${e.summary}</span>
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
              <div class="field-label">对手 <span class="field-hint">AI 会跟你一样受迷雾限制</span></div>
              <div class="chip-row">
                <button class="chip ${!config.aiOpponent && !config.aiAlly ? 'active' : ''}" data-ai="0">双人热座</button>
                <button class="chip ${config.aiOpponent && !config.aiAlly ? 'active' : ''}" data-ai="1">人机对战</button>
                <button class="chip ${config.aiAlly ? 'active' : ''}" data-ai="2">双 AI 观战</button>
              </div>
              ${aiLevelChips}
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
                <button class="chip ${!config.commanderMode ? 'active' : ''}" data-role="full" title="每个单位都由你自己走、自己打">亲自指挥</button>
                <button class="chip ${config.commanderMode ? 'active' : ''}" data-role="commander" title="你只排接下来几回合造什么，建造、移动、攻击、升级全部由 AI 执行">指挥官模式</button>
              </div>
              <div class="field-hint">指挥官模式下棋盘只看不碰：每回合调好生产序列，点一次就交给参谋部打完。配合「双 AI 观战」可以量出这套限制下 AI 的表现。</div>
            </section>

            <section class="field">
              <div class="field-label">
                地貌 <span class="field-hint">决定天险长什么样；随机＝每局抽一种</span>
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
        config.commanderMode = roleBtn.dataset.role === 'commander';
        // 指挥官模式必须对着 AI 打：热座两边都是人，就没人执行战术了
        if (config.commanderMode) {
          config.aiOpponent = true;
          config.aiAlly = false;
        }
        paint();
        return;
      }

      const lvBtn = target.closest<HTMLElement>('[data-ailevel]');
      if (lvBtn?.dataset.ailevel) {
        config.aiLevel = lvBtn.dataset.ailevel === 'basic' ? 'basic' : 'advanced';
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
        const ordered = EXPANSIONS.filter((e) => config.expansionIds.includes(e.id)).map((e) => e.id);
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
      const id = input.dataset.exp;
      if (!id) return;
      if (input.checked) {
        if (!config.expansionIds.includes(id)) config.expansionIds.push(id);
      } else {
        config.expansionIds = config.expansionIds.filter((x) => x !== id);
      }
      // 让卡片边框跟着变，不重绘整个面板（否则 checkbox 会闪）
      input.closest('.expansion-item')?.classList.toggle('on', input.checked);
    });

    paint();
    document.body.appendChild(mask);
  });
}

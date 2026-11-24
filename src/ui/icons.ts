/**
 * 轻量线性战术图标集（16×16 viewBox，统一 1.75px 圆头描边）。
 * 纯内联 SVG，零外部请求、跟随 currentColor 自动适配浅色与深色主题。
 */

export type IconName =
  | 'gold'
  | 'income'
  | 'hp'
  | 'atk'
  | 'armor'
  | 'move'
  | 'range'
  | 'vision'
  | 'undo'
  | 'fog'
  | 'eye'
  | 'ai'
  | 'online'
  | 'settings'
  | 'log'
  | 'iso'
  | 'flat'
  | 'reset'
  | 'fit'
  | 'plus'
  | 'minus'
  | 'ready'
  | 'close'
  | 'flag'
  | 'city'
  | 'book'
  | 'swords'
  | 'chevron';

const PATHS: Record<IconName, string> = {
  gold: '<circle cx="8" cy="8" r="5.8"/><path d="M8 5v6M6.3 6.8c0-.8.8-1.3 1.7-1.3s1.7.5 1.7 1.3c0 1.4-3.4.9-3.4 2.4 0 .8.8 1.3 1.7 1.3s1.7-.5 1.7-1.3"/>',
  income: '<path d="M3 11.5 6.8 7.7l2.5 2.3L13 5.5"/><path d="M9.8 5.5H13v3.2"/>',
  hp: '<path d="M8 13.4s-5.2-3.2-5.2-6.8A3 3 0 0 1 8 4.7a3 3 0 0 1 5.2 1.9c0 3.6-5.2 6.8-5.2 6.8Z"/>',
  atk: '<path d="m12.8 3.2-6.5 6.5M10.2 3.2h2.6v2.6M4.8 8.4l2.8 2.8M3.3 12.7l2.6-2.6"/>',
  armor: '<path d="M8 2.4 13 4.3v3.6c0 3-2 4.8-5 5.8-3-1-5-2.8-5-5.8V4.3L8 2.4Z"/>',
  move: '<path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/>',
  range: '<circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.8"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2"/>',
  vision: '<path d="M1.8 8s2.4-4.2 6.2-4.2S14.2 8 14.2 8s-2.4 4.2-6.2 4.2S1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.8"/>',
  undo: '<path d="M5 6.2H2.5V3.7"/><path d="M3 6a5.2 5.2 0 1 1 .8 5.6"/>',
  fog: '<path d="M3 7.2h10M4.5 10h8M2.5 12.6h9M5.2 4.5a3 3 0 0 1 5.6 0"/>',
  eye: '<path d="M1.8 8s2.4-4.2 6.2-4.2S14.2 8 14.2 8s-2.4 4.2-6.2 4.2S1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.8"/>',
  ai: '<rect x="3.5" y="4.5" width="9" height="7" rx="2"/><path d="M8 2.2v2.3M6.2 8h.1M9.8 8h.1M5.5 13.5h5"/>',
  online: '<circle cx="8" cy="8" r="5.8"/><path d="M2.5 8h11M8 2.2c1.8 1.6 1.8 9.8 0 11.6M8 2.2c-1.8 1.6-1.8 9.8 0 11.6"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.1 1.1M11 11l1.1 1.1M12.1 3.9 11 5M5 11l-1.1 1.1"/>',
  log: '<path d="M4 3.2h8a1 1 0 0 1 1 1v7.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1Z"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/>',
  iso: '<path d="M8 2.2 13.5 5.2 8 8.2 2.5 5.2 8 2.2Z"/><path d="M2.5 5.2v5.4L8 13.6l5.5-3V5.2M8 8.2v5.4"/>',
  flat: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1.5"/><path d="M2.6 8h10.8M8 2.6v10.8"/>',
  reset: '<path d="M12.6 5.4A5 5 0 1 0 13 9"/><path d="M13 2.8v2.8h-2.8"/>',
  fit: '<path d="M2.6 5.8V2.6h3.2M13.4 5.8V2.6h-3.2M2.6 10.2v3.2h3.2M13.4 10.2v3.2h-3.2"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  minus: '<path d="M3.2 8h9.6"/>',
  ready: '<circle cx="8" cy="8" r="4.8"/><path d="m6 8.1 1.4 1.4 2.8-3"/>',
  close: '<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>',
  flag: '<path d="M4 2.6v11M4 3.4h7.8L10 6.2l1.8 2.8H4"/>',
  city: '<path d="M2.6 13.2h10.8M4 13.2V6.8h3.2v6.4M7.2 13.2V3.8h4.8v9.4M9 6.2h1.2M9 8.8h1.2"/>',
  book: '<path d="M2.8 3.5h3.8A2 2 0 0 1 8 5.2a2 2 0 0 1 1.4-1.7h3.8v9H9.4A1.6 1.6 0 0 0 8 13.5a1.6 1.6 0 0 0-1.4-1H2.8v-9Z"/>',
  swords: '<path d="m12.8 3.2-7 7M10.4 3.2h2.4v2.4M3.2 3.2l7 7M5.6 3.2H3.2v2.4M4 12l2-2M12 12l-2-2"/>',
  chevron: '<path d="m5 6.2 3 3.2 3-3.2"/>',
};

export function uiIcon(name: IconName, className = ''): string {
  return `<svg class="ui-ico${className ? ` ${className}` : ''}" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

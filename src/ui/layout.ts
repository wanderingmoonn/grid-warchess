export type UiLayout = 'refined';

export const UI_LAYOUT_EVENT = 'warchess:ui-layout';

export function applyUiLayout(root: HTMLElement = document.documentElement): UiLayout {
  root.dataset.uiLayout = 'refined';
  return 'refined';
}

export function currentUiLayout(_root?: HTMLElement): UiLayout {
  return 'refined';
}

export function setUiLayout(_layout: UiLayout, root: HTMLElement = document.documentElement): void {
  root.dataset.uiLayout = 'refined';
  const win = root.ownerDocument.defaultView;
  if (win) win.dispatchEvent(new win.CustomEvent(UI_LAYOUT_EVENT));
}

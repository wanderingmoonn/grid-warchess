export type UiLayout = 'refined' | 'classic';

export const UI_LAYOUT_EVENT = 'warchess:ui-layout';
const LAYOUT_KEY = 'warchess:ui-layout';

export function applyUiLayout(root: HTMLElement = document.documentElement): UiLayout {
  const win = root.ownerDocument.defaultView;
  let value: string | null = null;
  try {
    value = win ? new URLSearchParams(win.location.search).get('layout') : null;
    if (value !== 'classic' && value !== 'refined') value = win?.localStorage.getItem(LAYOUT_KEY) ?? null;
  } catch {}
  const layout = value === 'classic' ? 'classic' : 'refined';
  root.dataset.uiLayout = layout;
  return layout;
}

export function currentUiLayout(root: HTMLElement): UiLayout {
  return root.dataset.uiLayout === 'classic' ? 'classic' : 'refined';
}

export function setUiLayout(layout: UiLayout, root: HTMLElement = document.documentElement): void {
  const win = root.ownerDocument.defaultView;
  root.dataset.uiLayout = layout;
  try {
    win?.localStorage.setItem(LAYOUT_KEY, layout);
  } catch {}
  try {
    if (win) {
      const url = new URL(win.location.href);
      if (url.searchParams.has('layout')) {
        url.searchParams.set('layout', layout);
        win.history.replaceState(win.history.state, '', url);
      }
    }
  } catch {}
  if (win) win.dispatchEvent(new win.CustomEvent(UI_LAYOUT_EVENT));
}

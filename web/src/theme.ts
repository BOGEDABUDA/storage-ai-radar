/** 主题：auto / light / dark 三态，持久化到 localStorage，跟随系统变化。 */

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'radar-theme';
const listeners = new Set<() => void>();
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function getMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

export function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === 'auto' ? (prefersDark() ? 'dark' : 'light') : mode;
}

function apply(mode: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolve(mode));
  root.setAttribute('data-theme-mode', mode);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function setMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 隐私模式下忽略 */
  }
  apply(mode);
  emit();
}

export const MODE_CYCLE: ThemeMode[] = ['auto', 'light', 'dark'];

export function nextMode(mode: ThemeMode): ThemeMode {
  const index = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length]!;
}

export const MODE_LABEL: Record<ThemeMode, string> = {
  auto: '自动',
  light: '浅色',
  dark: '深色',
};

export function onThemeChange(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** 跟随系统主题变化（仅在 auto 模式下生效）。 */
export function watchSystemTheme(): void {
  const media = window.matchMedia(DARK_QUERY);
  const handler = (): void => {
    if (getMode() === 'auto') {
      apply('auto');
      emit();
    }
  };
  media.addEventListener('change', handler);
}

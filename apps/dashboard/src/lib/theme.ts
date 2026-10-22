// ============================================================================
// Theme util — light / dark with view-transition circle reveal (like prototype)
// ============================================================================

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'lc_theme';

/** Read saved theme from localStorage (client only). */
export function getSavedTheme(): Theme | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY) as Theme | null;
}

/** Default to light unless saved as dark. */
export function getDefaultTheme(): Theme {
  return getSavedTheme() ?? 'light';
}

/** Apply a theme: set `data-theme` attribute + persist to localStorage. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  window.localStorage.setItem(STORAGE_KEY, t);
}

/**
 * Animate theme switch with a circle reveal from the pointer position,
 * matching the prototype's view-transition behaviour. Falls back to instant
 * apply when `startViewTransition` is unsupported or reduced-motion is set.
 */
export function setTheme(t: Theme, e?: MouseEvent): void {
  const apply = () => {
    document.documentElement.dataset.theme = t;
    window.localStorage.setItem(STORAGE_KEY, t);
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('startViewTransition' in document) || reduce) {
    return apply();
  }
  const x = e?.clientX ?? innerWidth / 2;
  const y = e?.clientY ?? 0;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  (document as any).startViewTransition(apply).ready.then(() =>
    document.documentElement.animate(
      {
        clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`],
      },
      {
        duration: 650,
        easing: 'ease-in-out',
        pseudoElement: '::view-transition-new(root)',
      },
    ),
  );
}

import { create } from 'zustand';

interface UiState {
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
  railCollapsed: boolean;
  setRailCollapsed: (collapsed: boolean) => void;
  infoPanelOpen: boolean;
  setInfoPanelOpen: (open: boolean) => void;
  infoCollapsed: boolean;
  setInfoCollapsed: (collapsed: boolean) => void;
  /** localStorage-backed collapsed preference; true = compact/toggle on. */
  readonly compactRails: boolean;
  toggleCompactRails: () => boolean;
}

export const UI_STORAGE_KEY = 'lc_ui_state';

function loadCompact(): boolean {
  try {
    return JSON.parse(localStorage.getItem(UI_STORAGE_KEY) ?? 'false');
  } catch {
    return false;
  }
}

export const useUIStore = create<UiState>()((set, get) => ({
  railOpen: true,
  railCollapsed: false,
  infoPanelOpen: true,
  infoCollapsed: false,
  compactRails: loadCompact(),

  setRailOpen(open: boolean) {
    set({ railOpen: open });
  },

  setRailCollapsed(collapsed: boolean) {
    set({ railCollapsed: collapsed, railOpen: !collapsed });
  },

  setInfoPanelOpen(open: boolean) {
    set({ infoPanelOpen: open });
  },

  setInfoCollapsed(collapsed: boolean) {
    set({ infoCollapsed: collapsed, infoPanelOpen: !collapsed });
  },

  toggleCompactRails() {
    const next = !get().compactRails;
    localStorage.setItem(UI_STORAGE_KEY, String(next));
    set({ compactRails: next });
    return next;
  },
}));

/** Title/prefix panel for the shell, driven by the info panel state. */
export function useInfoPanel() {
  const { infoPanelOpen, setInfoPanelOpen, infoCollapsed, setInfoCollapsed } = useUIStore();
  return { infoPanelOpen, setInfoPanelOpen, infoCollapsed, setInfoCollapsed };
}

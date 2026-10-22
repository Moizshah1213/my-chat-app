import { create } from 'zustand';

/** Drafts: sticky, per-conversation composer text, keyed by conversation id. */
export interface DraftState {
  drafts: Record<string, string>;
  setDraft: (conversationId: string, text: string) => void;
  getDraft: (conversationId: string) => string;
  clearDraft: (conversationId: string) => void;
  clearAll: () => void;
}

const STORAGE_KEY = 'lc_composer_drafts';

function readStorage(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeStorage(drafts: Record<string, string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
}

export const useDraftStore = create<DraftState>()((set, get) => {
  const drafts = readStorage();

  return {
    drafts,
    setDraft(conversationId: string, text: string) {
      set((s) => {
        const next = { ...s.drafts, [conversationId]: text };
        writeStorage(next);
        return { drafts: next };
      });
    },
    getDraft(conversationId: string) {
      return get().drafts[conversationId] ?? '';
    },
    clearDraft(conversationId: string) {
      set((s) => {
        const next = { ...s.drafts };
        delete next[conversationId];
        writeStorage(next);
        return { drafts: next };
      });
    },
    clearAll() {
      set({ drafts: {} });
      writeStorage({});
    },
  };
});

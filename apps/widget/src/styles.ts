/** Shadow-DOM styles — minimalist dark. `--lc-color` is the workspace brand
 *  accent (set from settings); everything else is a flat dark neutral. No
 *  gradients, borders over shadows. */
export const STYLES = `
:host { all: initial; }
.lc-root {
  --lc-color: #4f46e5;
  --lc-surface: #121217;
  --lc-surface-2: #1a1a21;
  --lc-border: #24242c;
  --lc-border-strong: #2e2e38;
  --lc-text: #eaeaef;
  --lc-muted: #8a8a96;
  position: fixed;
  bottom: 20px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--lc-text);
}
.lc-root[data-position='right'] { right: 20px; }
.lc-root[data-position='left'] { left: 20px; }

.lc-launcher {
  display: flex; align-items: center; gap: 8px;
  background: var(--lc-color); color: #fff;
  border: none; border-radius: 999px;
  padding: 12px 18px; font: inherit; font-weight: 600;
  cursor: pointer;
}
.lc-launcher:hover { filter: brightness(1.08); }
.lc-launcher:focus-visible { outline: 2px solid var(--lc-text); outline-offset: 2px; }
.lc-launcher svg { width: 20px; height: 20px; flex: none; }
.lc-badge {
  min-width: 18px; height: 18px; padding: 0 5px;
  background: #ef4444; border-radius: 999px;
  font-size: 11px; font-weight: 700;
  display: none; align-items: center; justify-content: center;
}
.lc-badge[data-show='1'] { display: inline-flex; }

.lc-panel {
  position: absolute; bottom: 60px; right: 0;
  width: 360px; max-width: calc(100vw - 40px); height: 520px; max-height: calc(100vh - 120px);
  background: var(--lc-surface); border: 1px solid var(--lc-border); border-radius: 14px; overflow: hidden;
  display: flex; flex-direction: column;
}
.lc-panel[hidden] { display: none; }
.lc-root[data-position='left'] .lc-panel { right: auto; left: 0; }
@media (max-width: 480px) {
  .lc-root { bottom: 12px; }
  .lc-root[data-position='right'] { right: 12px; }
  .lc-root[data-position='left'] { left: 12px; }
  .lc-panel { width: calc(100vw - 24px); height: calc(100vh - 100px); bottom: 56px; }
}

.lc-header {
  display: flex; align-items: center; gap: 10px;
  background: var(--lc-color); color: #fff;
  padding: 12px 14px;
}
.lc-header img { width: 28px; height: 28px; border-radius: 6px; object-fit: contain; background: #fff; }
.lc-header-title { font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-header-status { font-size: 11px; opacity: 0.85; }
.lc-close { background: none; border: none; color: #fff; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; }

.lc-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: #0a0a0d; }
.lc-msg { max-width: 85%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.lc-msg[data-sender='visitor'] { align-self: flex-end; background: var(--lc-color); color: #fff; border-bottom-right-radius: 4px; }
.lc-msg[data-sender='agent'] { align-self: flex-start; background: var(--lc-surface-2); border: 1px solid var(--lc-border); border-bottom-left-radius: 4px; }
.lc-msg-meta { display: block; font-size: 10px; opacity: 0.55; margin-top: 4px; }
.lc-typing { align-self: flex-start; color: var(--lc-muted); font-style: italic; font-size: 12px; min-height: 16px; }
.lc-empty { margin: auto; color: var(--lc-muted); text-align: center; padding: 0 16px; }

.lc-footer { border-top: 1px solid var(--lc-border); background: var(--lc-surface); }
.lc-offline { padding: 10px 14px; color: #fbbf24; background: rgba(251, 191, 36, 0.12); font-size: 13px; }
.lc-prechat { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.lc-prechat label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--lc-muted); }
.lc-prechat input { padding: 9px 10px; border: 1px solid var(--lc-border); border-radius: 8px; font: inherit; background: var(--lc-surface-2); color: var(--lc-text); }
.lc-prechat input:focus-visible { outline: none; border-color: var(--lc-color); }
.lc-prechat-error { color: #f87171; font-size: 12px; }
.lc-btn {
  background: var(--lc-color); color: #fff; border: none; border-radius: 8px;
  padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer;
}
.lc-btn:disabled { opacity: 0.5; cursor: default; }

.lc-composer { display: flex; gap: 8px; padding: 10px; align-items: flex-end; }
.lc-composer textarea {
  flex: 1; resize: none; font: inherit; padding: 9px 10px;
  border: 1px solid var(--lc-border); border-radius: 8px; max-height: 96px;
  background: var(--lc-surface-2); color: var(--lc-text);
}
.lc-composer textarea:focus-visible { outline: none; border-color: var(--lc-color); }
.lc-composer button { flex: none; }

.lc-error { padding: 10px 14px; color: #f87171; background: rgba(248, 113, 113, 0.12); font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .lc-launcher:hover { filter: none; } }
`;

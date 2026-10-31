/** Shadow-DOM styles for the configurable chat widget. */
export const STYLES = `
:host { all: initial; }
.lc-root {
  --lc-color: #303033;
  --lc-visitor-bubble: #303033;
  --lc-visitor-text: #fff;
  --lc-agent-bubble: #1b1b1c;
  --lc-agent-text: #e6e6e8;
  --lc-button: #f4f4f5;
  --lc-button-text: #111;
  --lc-bg: #000;
  --lc-bg-end: #19191d;
  --lc-highlight: rgba(255,255,255,.075);
  --lc-surface: #1b1b1c;
  --lc-surface-2: #0b0b0c;
  --lc-line: rgba(255,255,255,.11);
  --lc-text: #fff;
  --lc-soft: #e6e6e8;
  --lc-muted: #7a7a80;
  --lc-caret: #b7b7bd;
  --lc-focus-line: rgba(255,255,255,.3);
  position: fixed; bottom: 20px; z-index: 2147483000;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.45; color: var(--lc-text);
  -webkit-font-smoothing: antialiased;
}
.lc-root[data-theme='light'] {
  --lc-surface: #f0f0f2;
  --lc-surface-2: #fff;
  --lc-line: rgba(0,0,0,.12);
  --lc-text: #18181b;
  --lc-soft: #38383d;
  --lc-muted: #73737b;
  --lc-caret: #55555d;
  --lc-focus-line: rgba(0,0,0,.3);
  --lc-highlight: rgba(0,0,0,.025);
}
.lc-root *, .lc-root *::before, .lc-root *::after { box-sizing: border-box; }
.lc-root[data-position='right'] { right: 20px; }
.lc-root[data-position='left'] { left: 20px; }
:where(.lc-root) button { font: inherit; color: inherit; cursor: pointer; }
:where(.lc-root) button:focus-visible { outline: 2px solid var(--lc-caret); outline-offset: 2px; }

/* Launcher: a round black button holding a live orb */
.lc-launcher {
  position: relative; display: block; width: 64px; height: 64px; padding: 0; border: 0; border-radius: 50%;
  background: #000; overflow: visible; box-shadow: 0 10px 30px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.1);
  transition: transform .2s ease;
}
.lc-launcher:hover { transform: scale(1.05); }
.lc-launcher:active { transform: scale(.96); }
.lc-launcher-orb { display: block; width: 100%; height: 100%; border-radius: 50%; }
.lc-badge {
  position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 6px;
  background: #ef4444; color: #fff; border-radius: 999px; font-size: 11px; font-weight: 700;
  display: none; align-items: center; justify-content: center; box-shadow: 0 0 0 2px #fff;
}
.lc-badge[data-show='1'] { display: inline-flex; }

/* Panel */
.lc-panel {
  position: absolute; bottom: 76px; right: 0; width: 380px; max-width: calc(100vw - 40px);
  height: 600px; max-height: calc(100vh - 116px); max-height: calc(100dvh - 116px);
  display: flex; flex-direction: column; overflow: hidden; border-radius: 26px;
  background: radial-gradient(260px 200px at 8% 4%, var(--lc-highlight), transparent 70%), var(--lc-bg);
  box-shadow: 0 30px 80px -10px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08);
  transform-origin: 100% 100%; animation: lc-pop .28s cubic-bezier(.3,.9,.3,1);
}
.lc-panel[hidden] { display: none; }
.lc-root[data-gradient='true'] .lc-panel { background: radial-gradient(260px 200px at 8% 4%, var(--lc-highlight), transparent 70%), linear-gradient(135deg, var(--lc-bg), var(--lc-bg-end)); }
.lc-root[data-position='left'] .lc-panel { right: auto; left: 0; transform-origin: 0 100%; }
@keyframes lc-pop { from { opacity: 0; transform: translateY(14px) scale(.96); } to { opacity: 1; transform: none; } }
@media (max-width: 480px) {
  .lc-root { bottom: 12px; }
  .lc-root[data-position='right'] { right: 12px; }
  .lc-root[data-position='left'] { left: 12px; }
  .lc-panel { width: calc(100vw - 24px); height: calc(100vh - 100px); height: calc(100dvh - 100px); max-height: none; bottom: 72px; }
}

/* Header */
.lc-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 18px 0 22px; flex: none; }
.lc-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.lc-logo { display: block; width: 30px; height: 30px; flex: none; }
.lc-logo canvas, .lc-logo img { width: 30px; height: 30px; display: block; }
.lc-logo img { border-radius: 8px; object-fit: contain; background: #fff; }
.lc-status { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--lc-soft); white-space: nowrap; }
.lc-round {
  width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; padding: 0;
  border: 1px solid rgba(255,255,255,.22); background: linear-gradient(160deg, #2a2a2c, #0c0c0d 70%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.12); transition: transform .15s ease, border-color .2s;
}
.lc-round:hover { border-color: rgba(255,255,255,.4); }
.lc-round:active { transform: scale(.92); }
.lc-round:disabled { opacity: .45; cursor: default; }
.lc-round svg { width: 15px; height: 15px; }
.lc-root[data-theme='light'] .lc-round:not(.lc-send):not(.x-icon) { border-color: var(--lc-line); background: var(--lc-surface); color: var(--lc-text); box-shadow: none; }
.x-icon {
  width: 32px; height: 32px; display: grid; flex: 0 0 auto; place-items: center; padding: 0; color: #f4f4f5;
  border: 1px solid rgba(255,255,255,.22); border-radius: 50%;
  background: linear-gradient(160deg, #2a2a2c, #0c0c0d 70%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.12); transition: transform .15s ease, border-color .2s;
}

/* Tabs */
.lc-tabs { display: flex; gap: 4px; margin: 14px 14px 0; padding: 4px; border-radius: 999px; background: var(--lc-surface-2); border: 1px solid var(--lc-line); flex: none; }
.lc-tabs[hidden] { display: none; }
.lc-tab { flex: 1; height: 32px; border: 0; border-radius: 999px; background: transparent; color: var(--lc-muted); font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 7px; transition: background .2s, color .2s; }
.lc-tab svg { width: 15px; height: 15px; }
.lc-tab:hover { color: var(--lc-soft); }
.lc-tab[aria-selected='true'] { background: var(--lc-surface); color: var(--lc-text); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }

/* Views */
.lc-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.lc-view[hidden] { display: none; }

/* Hero (orb + greeting) */
.lc-hero { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 8px 16px 0; }
.lc-hero canvas { width: 190px; height: 190px; margin: -20px 0 -14px; cursor: pointer; touch-action: manipulation; }
.lc-hero h2 { margin: 0; font-size: 28px; line-height: 1.12; font-weight: 600; letter-spacing: -.025em; overflow-wrap: anywhere; }
.lc-hero p { margin: 6px 0 0; font-size: 16px; font-weight: 400; letter-spacing: -.01em; color: var(--lc-soft); }

/* Intro (name + email) */
.lc-intro { overflow-y: auto; }
.lc-intro-form { padding: 20px 14px 14px; margin-top: auto; }
.lc-form { display: flex; flex-direction: column; gap: 10px; }
.lc-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 500; color: var(--lc-muted); letter-spacing: .01em; }
.lc-field input, .lc-field textarea {
  width: 100%; font: inherit; font-size: 14px; color: var(--lc-text); letter-spacing: -.005em;
  background: var(--lc-surface-2); border: 1px solid var(--lc-line); border-radius: 12px; padding: 11px 13px;
  caret-color: var(--lc-caret); transition: border-color .2s;
}
.lc-field textarea { resize: none; min-height: 104px; line-height: 1.45; }
.lc-field input::placeholder, .lc-field textarea::placeholder { color: var(--lc-muted); }
.lc-field input:focus, .lc-field textarea:focus { outline: none; border-color: var(--lc-focus-line); }
.lc-field[data-invalid='1'] input, .lc-field[data-invalid='1'] textarea { border-color: #f87171; }
.lc-field-error { color: #f87171; font-size: 12px; min-height: 0; }
.lc-form-error { color: #f87171; font-size: 12.5px; }
.lc-form-error:empty { display: none; }
.lc-btn {
  height: 44px; border: 0; border-radius: 999px; background: var(--lc-button); color: var(--lc-button-text); font-weight: 600; font-size: 14px;
  letter-spacing: -.005em; transition: transform .15s ease, opacity .2s; margin-top: 4px;
}
.lc-btn:hover { opacity: .9; }
.lc-btn:active { transform: scale(.98); }
.lc-btn:disabled { opacity: .5; cursor: default; }
.lc-fine { margin: 2px 0 0; font-size: 11.5px; color: var(--lc-muted); text-align: center; }

/* Chat */
.lc-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 14px 10px; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; scrollbar-color: #2a2a2d transparent; }
.lc-body .lc-hero { margin: auto 0; padding-bottom: 8px; }
.lc-body .lc-hero[hidden] { display: none; }
.lc-offline { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 12px; border-radius: 12px; background: rgba(251,191,36,.1); border: 1px solid rgba(251,191,36,.25); color: #fcd34d; font-size: 12.5px; }
.lc-link { border: 0; background: none; padding: 0; color: var(--lc-text); text-decoration: underline; font-size: 12.5px; font-weight: 500; }
.lc-msg { max-width: 86%; padding: 10px 14px; border: 1px solid transparent; border-radius: 18px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
.lc-msg[data-sender='visitor'] { align-self: flex-end; background: var(--lc-visitor-bubble); color: var(--lc-visitor-text); border-bottom-right-radius: 6px; }
.lc-msg[data-sender='agent'], .lc-msg[data-sender='ai'] { align-self: flex-start; background: var(--lc-agent-bubble); border-color: var(--lc-line); color: var(--lc-agent-text); border-bottom-left-radius: 6px; }
.lc-msg-tag { display: block; margin-bottom: 3px; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--lc-muted); }
.lc-msg-meta { display: block; font-size: 10px; opacity: .55; margin-top: 5px; }
.lc-typing { align-self: flex-start; display: flex; align-items: center; gap: 4px; padding: 11px 13px; border: 1px solid var(--lc-line); border-radius: 18px; border-bottom-left-radius: 6px; background: var(--lc-surface); box-shadow: 0 2px 8px rgba(0,0,0,.12); }
.lc-typing-label { margin-right: 4px; color: var(--lc-muted); font-size: 11px; }
.lc-typing i { width: 6px; height: 6px; border-radius: 50%; background: #8a8f98; animation: lc-dot 1.1s ease-in-out infinite; }
.lc-typing i:nth-child(2) { animation-delay: .15s; }
.lc-typing i:nth-child(3) { animation-delay: .3s; }
@keyframes lc-dot { 0%, 60%, 100% { transform: translateY(0); opacity: .45; } 30% { transform: translateY(-4px); opacity: 1; } }

.lc-chips { display: flex; gap: 7px; overflow-x: auto; scrollbar-width: none; padding: 0 14px 9px; flex: none; -webkit-mask-image: linear-gradient(90deg, #000 88%, transparent); mask-image: linear-gradient(90deg, #000 88%, transparent); }
.lc-chips::-webkit-scrollbar { display: none; }
.lc-chips[hidden] { display: none; }
.lc-chip { flex: none; height: 30px; padding: 0 12px; border: 0; border-radius: 999px; background: var(--lc-surface); color: var(--lc-soft); font-size: 12.5px; font-weight: 450; white-space: nowrap; transition: background .2s, transform .15s; }
.lc-chip:hover { background: var(--lc-surface-2); }
.lc-chip:active { transform: scale(.96); }

.lc-error { margin: 0 14px 8px; padding: 9px 12px; border-radius: 10px; color: #fca5a5; background: rgba(248,113,113,.12); font-size: 12.5px; flex: none; }
.lc-error[hidden] { display: none; }

.lc-footer { padding: 0 8px 8px; flex: none; }
.lc-composer { position: relative; height: 82px; background: var(--lc-surface-2); border: 1px solid var(--lc-line); border-radius: 14px; transition: border-color .2s; }
.lc-composer:focus-within { border-color: rgba(255,255,255,.24); }
.lc-composer textarea { display: block; width: 100%; height: 54px; resize: none; border: 0; outline: 0; background: transparent; color: var(--lc-text); font-family: inherit; font-size: 14px; line-height: 1.4; padding: 13px 54px 0 18px; caret-color: var(--lc-caret); }
/* textarea focus is shown by the composer border */
.lc-composer textarea::placeholder { color: #66666b; }
.lc-composer .lc-send { position: absolute; right: 11px; bottom: 11px; width: 32px; height: 32px; }
.lc-composer .lc-send svg { width: 17px; height: 17px; }
.lc-composer .lc-hint { position: absolute; left: 18px; bottom: 11px; font-size: 11px; color: var(--lc-muted); }
.lc-composer.lc-shake { animation: lc-shake .3s; }
@keyframes lc-shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }

/* Query tab */
.lc-query { overflow-y: auto; padding: 18px 14px 14px; }
.lc-query-head h3 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.02em; }
.lc-query-head p { margin: 6px 0 16px; color: var(--lc-muted); font-size: 13.5px; }
.lc-sent { margin: auto 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 10px 12px; }
.lc-sent-icon { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: rgba(52,211,153,.14); border: 1px solid rgba(52,211,153,.4); }
.lc-sent-icon svg { width: 26px; height: 26px; }
.lc-sent h3 { margin: 6px 0 0; font-size: 20px; font-weight: 600; letter-spacing: -.02em; }
.lc-sent p { margin: 0; color: var(--lc-muted); font-size: 13.5px; overflow-wrap: anywhere; }
.lc-sent .lc-btn { width: 100%; margin-top: 12px; background: var(--lc-button); color: var(--lc-button-text); }

@media (prefers-reduced-motion: reduce) {
  .lc-panel { animation: none; }
  .lc-typing i { animation: none; }
  .lc-launcher, .lc-btn, .lc-round, .lc-chip { transition: none; }
}
`;

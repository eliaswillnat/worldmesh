import type { UiOptions } from '../types';

const STYLE_ID = 'worldmesh-overlay-style';

const CSS = `
.wm-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #f2f6fb;
  z-index: 2147483000;
}
.wm-overlay * { box-sizing: border-box; }
.wm-crosshair {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: rgba(255,255,255,0.85);
  box-shadow: 0 0 0 1.5px rgba(0,0,0,0.45);
  opacity: 0;
  transition: opacity .15s ease;
}
.wm-overlay[data-locked="true"] .wm-crosshair { opacity: 1; }
.wm-lock {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  background: rgba(8,11,16,0.55);
  backdrop-filter: blur(3px);
  pointer-events: auto;
  cursor: pointer;
  text-align: center;
  padding: 24px;
}
.wm-overlay[data-locked="true"] .wm-lock { display: none; }
.wm-lock-title {
  font-size: clamp(22px, 4vw, 34px);
  font-weight: 600;
  letter-spacing: .01em;
  margin: 0;
}
.wm-lock-cta {
  font-size: 14px;
  letter-spacing: .14em;
  text-transform: uppercase;
  padding: 10px 20px;
  border: 1px solid rgba(255,255,255,0.35);
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
}
.wm-keys {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px 22px;
  max-width: 560px;
  font-size: 13px;
  opacity: .85;
}
.wm-keys div { display: flex; gap: 8px; align-items: center; justify-content: flex-start; }
.wm-key {
  min-width: 22px;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.28);
  background: rgba(255,255,255,0.08);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}
.wm-prompt {
  position: absolute;
  left: 50%;
  top: 58%;
  transform: translateX(-50%);
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(8,11,16,0.7);
  border: 1px solid rgba(255,255,255,0.16);
  font-size: 14px;
  display: none;
  white-space: nowrap;
}
.wm-overlay[data-locked="true"] .wm-prompt[data-visible="true"] { display: block; }
.wm-badge {
  position: absolute;
  left: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.72);
  text-decoration: none;
  pointer-events: auto;
  padding: 6px 10px;
  border-radius: 7px;
  background: rgba(8,11,16,0.45);
  border: 1px solid rgba(255,255,255,0.12);
}
.wm-badge:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
.wm-badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6cf0ff;
  box-shadow: 0 0 8px #6cf0ff;
}
.wm-hint {
  position: absolute;
  right: 14px;
  bottom: 12px;
  font-size: 11px;
  letter-spacing: .1em;
  color: rgba(255,255,255,0.5);
  opacity: 0;
  transition: opacity .2s ease;
}
.wm-overlay[data-locked="true"] .wm-hint { opacity: 1; }
`;

const KEY_LEGEND: [string, string][] = [
  ['WASD / ↑←↓→', 'Move'],
  ['Mouse', 'Look'],
  ['Space', 'Jump'],
  ['Shift', 'Sprint'],
  ['E', 'Interact'],
  ['V', 'Camera'],
  ['Esc', 'Release cursor'],
];

/**
 * The shared chrome of a WorldMesh world. Every world shows the same
 * click-to-enter panel, the same control legend and the same interact prompt,
 * which is what makes an unfamiliar world navigable on sight.
 */
export class Overlay {
  readonly root: HTMLDivElement;
  private prompt: HTMLDivElement;
  private onEnter: () => void;

  constructor(options: UiOptions & { onEnter: () => void }) {
    injectStyles();
    this.onEnter = options.onEnter;

    this.root = document.createElement('div');
    this.root.className = 'wm-overlay';
    this.root.dataset.locked = 'false';

    if (options.crosshair !== false) {
      const crosshair = document.createElement('div');
      crosshair.className = 'wm-crosshair';
      this.root.appendChild(crosshair);
    }

    const lock = document.createElement('div');
    lock.className = 'wm-lock';
    lock.addEventListener('click', () => this.onEnter());

    const title = document.createElement('h1');
    title.className = 'wm-lock-title';
    title.textContent = options.title ?? 'WorldMesh';
    lock.appendChild(title);

    const cta = document.createElement('div');
    cta.className = 'wm-lock-cta';
    cta.textContent = 'Click to enter';
    lock.appendChild(cta);

    if (options.controlsHint !== false) {
      const keys = document.createElement('div');
      keys.className = 'wm-keys';
      for (const [key, label] of KEY_LEGEND) {
        const row = document.createElement('div');
        const badge = document.createElement('span');
        badge.className = 'wm-key';
        badge.textContent = key;
        const text = document.createElement('span');
        text.textContent = label;
        row.append(badge, text);
        keys.appendChild(row);
      }
      lock.appendChild(keys);
    }
    this.root.appendChild(lock);

    this.prompt = document.createElement('div');
    this.prompt.className = 'wm-prompt';
    this.prompt.dataset.visible = 'false';
    this.root.appendChild(this.prompt);

    if (options.badge !== false) {
      const badge = document.createElement('a');
      badge.className = 'wm-badge';
      badge.href = options.hubUrl ?? 'https://worldmesh.net';
      const dot = document.createElement('span');
      dot.className = 'wm-badge-dot';
      const label = document.createElement('span');
      label.textContent = 'WorldMesh';
      badge.append(dot, label);
      this.root.appendChild(badge);
    }

    const hint = document.createElement('div');
    hint.className = 'wm-hint';
    hint.textContent = 'ESC to release cursor';
    this.root.appendChild(hint);

    document.body.appendChild(this.root);
  }

  setLocked(locked: boolean): void {
    this.root.dataset.locked = String(locked);
  }

  setPrompt(text: string | null): void {
    if (!text) {
      this.prompt.dataset.visible = 'false';
      return;
    }
    this.prompt.textContent = text;
    this.prompt.dataset.visible = 'true';
  }

  dispose(): void {
    this.root.remove();
  }
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

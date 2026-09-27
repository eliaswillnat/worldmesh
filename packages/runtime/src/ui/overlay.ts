import type { UiOptions } from '../types';
import { isTouchDevice } from '../controls/touch';

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
  justify-content: flex-start;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  background: rgba(8,11,16,0.72);
  backdrop-filter: blur(6px);
  pointer-events: auto;
  cursor: pointer;
  text-align: center;
  padding: max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}
.wm-overlay[data-locked="true"] .wm-lock { display: none; }
.wm-lock-content {
  margin: auto 0;
  width: 100%;
  max-width: 440px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 8px 0;
  box-sizing: border-box;
}
.wm-lock-title {
  font-size: clamp(22px, 5vw, 34px);
  font-weight: 600;
  letter-spacing: .01em;
  margin: 0;
}
.wm-lock-cta {
  font-size: 13.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  padding: 12px 28px;
  border: 1px solid rgba(255,255,255,0.35);
  border-radius: 999px;
  background: rgba(255,255,255,0.1);
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: all .15s ease;
}
.wm-lock-cta:hover, .wm-lock-cta:active {
  background: rgba(255,255,255,0.22);
  border-color: rgba(255,255,255,0.6);
  transform: scale(1.02);
}
.wm-keys {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 14px;
  width: 100%;
  max-width: 420px;
  font-size: 13px;
  opacity: .9;
  box-sizing: border-box;
  padding: 0 4px;
}
.wm-keys-item {
  display: flex;
  gap: 7px;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;
}
.wm-key {
  flex-shrink: 0;
  min-width: 20px;
  padding: 2.5px 6px;
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.28);
  background: rgba(255,255,255,0.08);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
  line-height: 1.25;
}
.wm-key-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: rgba(255,255,255,0.85);
}
.wm-prompt {
  position: absolute;
  left: 50%;
  top: 58%;
  transform: translateX(-50%);
  padding: 10px 18px;
  border-radius: 999px;
  background: rgba(8,11,16,0.85);
  border: 1px solid rgba(255,255,255,0.3);
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  font-size: 14px;
  display: none;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  transition: transform .12s ease, border-color .12s ease;
}
.wm-prompt:hover, .wm-prompt:active {
  transform: translateX(-50%) scale(1.04);
  border-color: rgba(255,255,255,0.6);
}
.wm-overlay[data-locked="true"] .wm-prompt[data-visible="true"] { display: block; }
.wm-badge {
  position: absolute;
  left: max(14px, env(safe-area-inset-left));
  bottom: max(12px, env(safe-area-inset-bottom));
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
  right: max(14px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  font-size: 11px;
  letter-spacing: .1em;
  color: rgba(255,255,255,0.5);
  opacity: 0;
  transition: opacity .2s ease;
}
.wm-overlay[data-locked="true"] .wm-hint { opacity: 1; }

@media (max-width: 400px) {
  .wm-lock {
    padding: max(14px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  }
  .wm-lock-content {
    gap: 12px;
  }
  .wm-lock-title {
    font-size: 20px;
  }
  .wm-lock-cta {
    padding: 10px 22px;
    font-size: 12px;
  }
  .wm-keys {
    gap: 6px 8px;
  }
  .wm-keys-item {
    gap: 5px;
  }
  .wm-key {
    font-size: 10px;
    padding: 2px 5px;
  }
  .wm-key-desc {
    font-size: 11px;
  }
}

@media (max-height: 520px) {
  .wm-lock {
    padding: max(8px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left));
  }
  .wm-lock-content {
    gap: 10px;
  }
  .wm-lock-title {
    font-size: 18px;
  }
  .wm-lock-cta {
    padding: 8px 20px;
    font-size: 12px;
  }
  .wm-keys {
    gap: 4px 10px;
  }
  .wm-key {
    font-size: 9.5px;
    padding: 2px 4px;
  }
  .wm-key-desc {
    font-size: 11px;
  }
}
`;

const KEY_LEGEND: [string, string][] = [
  ['WASD / ↑←↓→', 'Move'],
  ['Mouse / Drag', 'Look'],
  ['Space / ▲', 'Jump'],
  ['Shift', 'Sprint'],
  ['E', 'Interact'],
  ['V', 'Camera'],
  ['Esc / ⏸', 'Menu / Pause'],
];

/**
 * The shared chrome of a WorldMesh world. Every world shows the same
 * click/tap-to-enter panel, the same control legend and the same interact prompt,
 * which is what makes an unfamiliar world navigable on sight across desktop and mobile.
 */
export class Overlay {
  readonly root: HTMLDivElement;
  private prompt: HTMLDivElement;
  private onEnter: (touch?: boolean) => void;

  constructor(
    options: UiOptions & {
      onEnter: (touch?: boolean) => void;
      onInteract?: () => void;
    },
  ) {
    injectStyles();
    this.onEnter = options.onEnter;

    const isTouch = isTouchDevice();

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

    const content = document.createElement('div');
    content.className = 'wm-lock-content';

    const title = document.createElement('h1');
    title.className = 'wm-lock-title';
    title.textContent = options.title ?? 'WorldMesh';
    content.appendChild(title);

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'wm-lock-cta';
    cta.textContent = isTouch ? 'Tap to enter' : 'Click to enter';
    content.appendChild(cta);

    const handleEnter = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const touchInitiated =
        ('pointerType' in e && (e as PointerEvent).pointerType === 'touch') ||
        e.type === 'touchend' ||
        isTouch;
      this.onEnter(touchInitiated);
    };

    cta.addEventListener('click', handleEnter);
    cta.addEventListener('pointerup', handleEnter);
    lock.addEventListener('click', handleEnter);

    if (options.controlsHint !== false) {
      const keys = document.createElement('div');
      keys.className = 'wm-keys';
      const legend = isTouch
        ? [...KEY_LEGEND, ['Touch', 'On-screen controls'] as [string, string]]
        : KEY_LEGEND;
      for (const [key, label] of legend) {
        const row = document.createElement('div');
        row.className = 'wm-keys-item';
        const badge = document.createElement('span');
        badge.className = 'wm-key';
        badge.textContent = key;
        const text = document.createElement('span');
        text.className = 'wm-key-desc';
        text.textContent = label;
        row.append(badge, text);
        keys.appendChild(row);
      }
      content.appendChild(keys);
    }
    lock.appendChild(content);
    this.root.appendChild(lock);

    this.prompt = document.createElement('div');
    this.prompt.className = 'wm-prompt';
    this.prompt.dataset.visible = 'false';
    this.prompt.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onInteract?.();
    });
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
    hint.textContent = isTouch ? 'Tap ⏸ to pause' : 'ESC to release cursor';
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

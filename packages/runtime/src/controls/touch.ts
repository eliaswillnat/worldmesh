import type { InputAction } from '../types';

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
  );
}

const TOUCH_STYLE_ID = 'worldmesh-touch-style';

const TOUCH_CSS = `
.wm-touch-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147482990;
  user-select: none;
  -webkit-user-select: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wm-touch-joystick-base {
  position: absolute;
  width: 96px;
  height: 96px;
  margin: -48px 0 0 -48px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.28);
  background: rgba(8, 11, 16, 0.4);
  backdrop-filter: blur(4px);
  pointer-events: none;
  display: none;
  will-change: transform;
}
.wm-touch-joystick-knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.65);
  box-shadow: 0 0 12px rgba(255, 255, 255, 0.35);
  pointer-events: none;
  will-change: transform;
}
.wm-touch-buttons {
  position: absolute;
  right: 20px;
  bottom: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  pointer-events: none;
}
.wm-touch-btn {
  pointer-events: auto;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.32);
  background: rgba(8, 11, 16, 0.65);
  backdrop-filter: blur(4px);
  color: #fff;
  font-family: inherit;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
  transition: transform .08s ease, background .08s ease;
  padding: 0;
}
.wm-touch-btn:active {
  background: rgba(255, 255, 255, 0.25);
  transform: scale(0.92);
}
.wm-btn-jump {
  width: 58px;
  height: 58px;
  font-size: 18px;
}
.wm-btn-interact {
  width: 48px;
  height: 48px;
  font-size: 14px;
  letter-spacing: .05em;
}
.wm-btn-view {
  width: 40px;
  height: 40px;
  font-size: 14px;
  opacity: 0.85;
}
.wm-touch-menu-btn {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(8, 11, 16, 0.6);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
}
.wm-touch-menu-btn:active {
  background: rgba(255, 255, 255, 0.22);
}
`;

function injectTouchStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(TOUCH_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TOUCH_STYLE_ID;
  style.textContent = TOUCH_CSS;
  document.head.appendChild(style);
}

export interface TouchControlsOptions {
  element?: HTMLElement;
  onExit?: () => void;
}

export class TouchControls {
  private root: HTMLDivElement;
  private joystickBase: HTMLDivElement;
  private joystickKnob: HTMLDivElement;
  private onExit?: () => void;

  private movePointerId: number | null = null;
  private moveStart = { x: 0, y: 0 };
  private moveAxis = { x: 0, z: 0 };

  private lookPointerId: number | null = null;
  private lookPrev = { x: 0, y: 0 };
  private lookDelta = { dx: 0, dy: 0 };

  private actionsDown = new Set<InputAction>();
  private justPressed = new Set<InputAction>();

  private disposed = false;
  private visible = false;

  constructor(options: TouchControlsOptions) {
    this.onExit = options.onExit;

    injectTouchStyles();

    this.root = document.createElement('div');
    this.root.className = 'wm-touch-root';
    this.root.style.display = 'none';

    // Joystick UI
    this.joystickBase = document.createElement('div');
    this.joystickBase.className = 'wm-touch-joystick-base';
    this.joystickKnob = document.createElement('div');
    this.joystickKnob.className = 'wm-touch-joystick-knob';
    this.joystickBase.appendChild(this.joystickKnob);
    this.root.appendChild(this.joystickBase);

    // Action buttons (bottom right)
    const buttons = document.createElement('div');
    buttons.className = 'wm-touch-buttons';

    const viewBtn = this.createActionButton('V', 'toggleView', 'wm-btn-view', 'Camera mode');
    const interactBtn = this.createActionButton('E', 'interact', 'wm-btn-interact', 'Interact');
    const jumpBtn = this.createActionButton('▲', 'jump', 'wm-btn-jump', 'Jump');

    buttons.append(viewBtn, interactBtn, jumpBtn);
    this.root.appendChild(buttons);

    // Menu / Pause button (top right)
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'wm-touch-menu-btn';
    menuBtn.textContent = '⏸';
    menuBtn.title = 'Menu / Pause';
    menuBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.onExit?.();
    });
    this.root.appendChild(menuBtn);

    document.body.appendChild(this.root);

    window.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
  }

  private createActionButton(
    label: string,
    action: InputAction,
    className: string,
    title: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `wm-touch-btn ${className}`;
    btn.textContent = label;
    btn.title = title;

    const onDown = (e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      this.actionsDown.add(action);
      this.justPressed.add(action);
    };

    const onUp = (e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      this.actionsDown.delete(action);
    };

    btn.addEventListener('pointerdown', onDown);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);

    return btn;
  }

  private handlePointerDown = (e: PointerEvent): void => {
    if (!this.visible || this.disposed) return;
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;

    const target = e.target as HTMLElement | null;
    if (target?.closest('.wm-touch-btn, .wm-touch-menu-btn, .wm-prompt, .wm-badge, .wm-lock')) {
      return;
    }

    const halfWidth = window.innerWidth * 0.5;

    // Left half: movement joystick
    if (this.movePointerId === null && e.clientX < halfWidth) {
      this.movePointerId = e.pointerId;
      this.moveStart = { x: e.clientX, y: e.clientY };
      this.moveAxis = { x: 0, z: 0 };
      this.joystickBase.style.left = `${e.clientX}px`;
      this.joystickBase.style.top = `${e.clientY}px`;
      this.joystickBase.style.display = 'block';
      this.joystickKnob.style.transform = '';
      return;
    }

    // Right half (or secondary touch): camera look
    if (this.lookPointerId === null && e.clientX >= halfWidth * 0.8) {
      this.lookPointerId = e.pointerId;
      this.lookPrev = { x: e.clientX, y: e.clientY };
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.visible || this.disposed) return;

    if (e.pointerId === this.movePointerId) {
      const dx = e.clientX - this.moveStart.x;
      const dy = e.clientY - this.moveStart.y;
      const dist = Math.hypot(dx, dy);
      const maxRadius = 45;
      const clampedDist = Math.min(dist, maxRadius);
      const angle = Math.atan2(dy, dx);

      const knobX = Math.cos(angle) * clampedDist;
      const knobY = Math.sin(angle) * clampedDist;
      this.joystickKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;

      this.moveAxis.x = clampedDist > 0 ? knobX / maxRadius : 0;
      this.moveAxis.z = clampedDist > 0 ? knobY / maxRadius : 0;
      return;
    }

    if (e.pointerId === this.lookPointerId) {
      const dx = e.clientX - this.lookPrev.x;
      const dy = e.clientY - this.lookPrev.y;
      this.lookPrev = { x: e.clientX, y: e.clientY };
      this.lookDelta.dx += dx * 1.4;
      this.lookDelta.dy += dy * 1.4;
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.movePointerId) {
      this.movePointerId = null;
      this.moveAxis = { x: 0, z: 0 };
      this.joystickBase.style.display = 'none';
      this.joystickKnob.style.transform = '';
    }
    if (e.pointerId === this.lookPointerId) {
      this.lookPointerId = null;
    }
  };

  getMoveAxis(): { x: number; z: number } {
    return this.moveAxis;
  }

  readLook(): { dx: number; dy: number } {
    const res = { dx: this.lookDelta.dx, dy: this.lookDelta.dy };
    this.lookDelta = { dx: 0, dy: 0 };
    return res;
  }

  isDown(action: InputAction): boolean {
    return this.actionsDown.has(action);
  }

  consume(action: InputAction): boolean {
    if (!this.justPressed.has(action)) return false;
    this.justPressed.delete(action);
    return true;
  }

  triggerAction(action: InputAction): void {
    this.justPressed.add(action);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.style.display = visible ? 'block' : 'none';
    if (!visible) {
      this.reset();
    }
  }

  reset(): void {
    this.movePointerId = null;
    this.lookPointerId = null;
    this.moveAxis = { x: 0, z: 0 };
    this.lookDelta = { dx: 0, dy: 0 };
    this.actionsDown.clear();
    this.justPressed.clear();
    this.joystickBase.style.display = 'none';
    this.joystickKnob.style.transform = '';
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
    this.root.remove();
  }
}

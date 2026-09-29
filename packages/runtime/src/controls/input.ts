import type { InputAction, Keymap } from '../types.js';
import { resolveKeymap } from './keymap.js';
import { TouchControls, isTouchDevice } from './touch.js';

export interface InputOptions {
  /** The element that receives pointer lock. */
  element: HTMLElement;
  keymap?: Partial<Keymap>;
  onPointerLockChange?: (locked: boolean) => void;
}

/**
 * Keyboard + pointer-lock mouse input with mobile touch controls support.
 * This is the only place in WorldMesh that reads raw browser events, so the
 * control convention lives in one file instead of being copy-pasted into every world.
 */
export class Input {
  readonly keymap: Keymap;
  /** Accumulated mouse movement since the last read, in pixels. */
  mouseDeltaX = 0;
  mouseDeltaY = 0;
  /** Accumulated wheel movement since the last read. */
  wheelDelta = 0;
  locked = false;

  private element: HTMLElement;
  private pressed = new Set<string>();
  /** Actions that went down this frame and have not been consumed yet. */
  private justPressed = new Set<InputAction>();
  /** The last number key pressed this frame, if any. */
  private pendingDigit: number | null = null;
  private codeToActions = new Map<string, InputAction[]>();
  private onPointerLockChange?: (locked: boolean) => void;
  private touch?: TouchControls;
  private disposed = false;

  constructor(options: InputOptions) {
    this.element = options.element;
    this.keymap = resolveKeymap(options.keymap);
    this.onPointerLockChange = options.onPointerLockChange;

    for (const action of Object.keys(this.keymap) as InputAction[]) {
      for (const code of this.keymap[action]) {
        const list = this.codeToActions.get(code) ?? [];
        list.push(action);
        this.codeToActions.set(code, list);
      }
    }

    // Touch controls on mobile / touchscreens
    this.element.style.touchAction = 'none';
    if (typeof window !== 'undefined') {
      this.touch = new TouchControls({
        element: this.element,
        onExit: () => this.exitPointerLock(),
      });
    }

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);
    this.element.addEventListener('mousemove', this.handleMouseMove);
    this.element.addEventListener('wheel', this.handleWheel, { passive: true });
  }

  requestPointerLock(touchTriggered = false): void {
    if (this.disposed || this.locked) return;

    // Mobile / touch devices do not support pointer lock. Enter directly.
    if (touchTriggered || isTouchDevice()) {
      this.setLocked(true);
      return;
    }

    if (typeof this.element.requestPointerLock === 'function') {
      try {
        const promise = this.element.requestPointerLock();
        if (promise && typeof (promise as unknown as Promise<void>).then === 'function') {
          (promise as unknown as Promise<void>).catch(() => {
            // Pointer lock rejected (e.g. mobile Safari, tablet, iframe restrictions)
            this.setLocked(true);
          });
          return;
        }
      } catch {
        this.setLocked(true);
        return;
      }
    } else {
      this.setLocked(true);
    }
  }

  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    if (!locked) {
      this.pressed.clear();
      this.justPressed.clear();
      this.touch?.reset();
    }
    this.touch?.setVisible(locked && isTouchDevice());
    this.onPointerLockChange?.(this.locked);
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.element) {
      document.exitPointerLock();
    }
    this.setLocked(false);
  }

  triggerAction(action: InputAction): void {
    this.justPressed.add(action);
  }

  isDown(action: InputAction): boolean {
    if (this.touch?.isDown(action)) return true;
    for (const code of this.keymap[action]) if (this.pressed.has(code)) return true;
    return false;
  }

  /** True once per key press. Reading it clears the flag. */
  consume(action: InputAction): boolean {
    if (this.touch?.consume(action)) return true;
    if (!this.justPressed.has(action)) return false;
    this.justPressed.delete(action);
    return true;
  }

  /** The number key (0–9) pressed this frame, once. Reading it clears it. */
  consumeDigit(): number | null {
    const digit = this.pendingDigit;
    this.pendingDigit = null;
    return digit;
  }

  /** Movement intent on the local XZ plane, already normalized. */
  getMoveAxis(): { x: number; z: number } {
    let x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let z = (this.isDown('backward') ? 1 : 0) - (this.isDown('forward') ? 1 : 0);

    if (this.touch) {
      const touchAxis = this.touch.getMoveAxis();
      x += touchAxis.x;
      z += touchAxis.z;
    }

    const length = Math.hypot(x, z);
    if (length === 0) return { x: 0, z: 0 };
    if (length > 1) return { x: x / length, z: z / length };
    return { x, z };
  }

  /** Read and reset the mouse/wheel/touch accumulators. Call once per frame. */
  readLook(): { dx: number; dy: number; wheel: number } {
    let dx = this.mouseDeltaX;
    let dy = this.mouseDeltaY;
    if (this.touch) {
      const touchLook = this.touch.readLook();
      dx += touchLook.dx;
      dy += touchLook.dy;
    }
    const look = { dx, dy, wheel: this.wheelDelta };
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
    return look;
  }

  /** Drop stale edge-triggers at the end of a frame. */
  endFrame(): void {
    this.justPressed.clear();
    this.pendingDigit = null;
  }

  dispose(): void {
    this.disposed = true;
    this.touch?.dispose();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);
    this.element.removeEventListener('mousemove', this.handleMouseMove);
    this.element.removeEventListener('wheel', this.handleWheel);
    this.pressed.clear();
    this.justPressed.clear();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (isTypingTarget(event.target)) return;
    const actions = this.codeToActions.get(event.code);
    if (!actions) {
      // Unbound number keys pick a face for the avatar.
      const digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
      if (digit) this.pendingDigit = Number(digit[1]);
      return;
    }
    // Space and the arrow keys scroll the page otherwise.
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    this.pressed.add(event.code);
    for (const action of actions) this.justPressed.add(action);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  /** Losing focus must not leave a key stuck down. */
  private handleBlur = (): void => {
    this.pressed.clear();
    this.justPressed.clear();
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.locked) return;
    this.wheelDelta += event.deltaY;
  };

  private handlePointerLockChange = (): void => {
    const isLocked = document.pointerLockElement === this.element;
    if (isLocked) {
      this.setLocked(true);
    } else if (!isTouchDevice()) {
      // On non-touch desktop, losing pointer lock releases controls
      this.setLocked(false);
    }
  };

  private handlePointerLockError = (): void => {
    // If pointer lock failed on desktop / iframe, still let the user enter
    if (!this.locked) {
      this.setLocked(true);
    }
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

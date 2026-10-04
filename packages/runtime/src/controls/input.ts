import type { InputAction, Keymap } from '../types.js';
import { resolveKeymap } from './keymap.js';
import { TouchControls, isTouchDevice } from './touch.js';

export interface InputOptions {
  /** The element that receives pointer lock. */
  element: HTMLElement;
  keymap?: Partial<Keymap>;
  /** Keyboard and joysticks work before the cursor is captured. */
  moveBeforeLock?: boolean;
  onPointerLockChange?: (locked: boolean) => void;
  /**
   * Escape toggles the pause screen. Return true when this press captures
   * the mouse again, so the key's usual "show the cursor" action can be cancelled.
   */
  onEscape?: () => boolean | void;
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
  private moveBeforeLock: boolean;
  private pressed = new Set<string>();
  /** Actions that went down this frame and have not been consumed yet. */
  private justPressed = new Set<InputAction>();
  /** The last number key pressed this frame, if any. */
  private pendingDigit: number | null = null;
  private codeToActions = new Map<string, InputAction[]>();
  private onPointerLockChange?: (locked: boolean) => void;
  private onEscape?: () => boolean | void;
  private touch?: TouchControls;
  private disposed = false;
  private xrSession: XRSession | null = null;
  private xrMoveX = 0;
  private xrMoveZ = 0;
  private xrTurn = 0;
  private xrSprint = false;
  private xrJumpHeld = false;
  private xrInteractHeld = false;

  constructor(options: InputOptions) {
    this.element = options.element;
    this.moveBeforeLock = options.moveBeforeLock === true;
    this.keymap = resolveKeymap(options.keymap);
    this.onPointerLockChange = options.onPointerLockChange;
    this.onEscape = options.onEscape;

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

    window.addEventListener('keydown', this.handleEscape, true);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);
    this.element.addEventListener('mousemove', this.handleMouseMove);
    this.element.addEventListener('wheel', this.handleWheel, { passive: true });
    this.element.addEventListener('pointerdown', this.handlePointerDown);
    // The sticks are on screen from the start, so the first touch moves instead of "entering".
    if (this.moveBeforeLock && isTouchDevice()) this.touch?.setVisible(true);
  }

  requestPointerLock(touchTriggered = false): void {
    if (this.disposed || this.locked || this.xrSession) return;

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
    if (this.locked) this.setLocked(false);
    else {
      // Never captured, but the pause screen is coming up: drop the sticks and any held keys.
      this.pressed.clear();
      this.justPressed.clear();
      this.touch?.reset();
      this.touch?.setVisible(false);
      this.onPointerLockChange?.(false);
    }
  }

  triggerAction(action: InputAction): void {
    this.justPressed.add(action);
  }

  /** WebXR controllers join the same move / jump / interact actions as the keyboard. */
  setXrSession(session: XRSession | null): void {
    this.xrSession = session;
    this.xrMoveX = 0;
    this.xrMoveZ = 0;
    this.xrTurn = 0;
    this.xrSprint = false;
    this.xrJumpHeld = false;
    this.xrInteractHeld = false;
    if (session) this.touch?.setVisible(false);
    else this.touch?.setVisible(this.locked && isTouchDevice());
  }

  /**
   * Read XR gamepads for this frame. Left stick walks, right stick turns,
   * trigger or A/X jumps, squeeze interacts.
   */
  pollXr(dt: number): void {
    this.xrMoveX = 0;
    this.xrMoveZ = 0;
    this.xrTurn = 0;
    this.xrSprint = false;
    let jump = false;
    let interact = false;
    if (this.xrSession) {
      for (const source of this.xrSession.inputSources) {
        const pad = source.gamepad;
        if (!pad) continue;
        const stick = readThumbstick(pad);
        if (source.handedness === 'right') {
          this.xrTurn += stick.x * XR_TURN_SPEED * dt;
        } else {
          this.xrMoveX += stick.x;
          this.xrMoveZ += stick.y;
        }
        if (pad.buttons[0]?.pressed || pad.buttons[4]?.pressed) jump = true;
        if (pad.buttons[1]?.pressed) interact = true;
        if (pad.buttons[3]?.pressed) this.xrSprint = true;
      }
      const length = Math.hypot(this.xrMoveX, this.xrMoveZ);
      if (length > 1) {
        this.xrMoveX /= length;
        this.xrMoveZ /= length;
      }
    }
    if (jump && !this.xrJumpHeld) this.justPressed.add('jump');
    if (interact && !this.xrInteractHeld) this.justPressed.add('interact');
    this.xrJumpHeld = jump;
    this.xrInteractHeld = interact;
  }

  /** Radians to apply to the XR play-space this frame (right stick). */
  readXrTurn(): number {
    const turn = this.xrTurn;
    this.xrTurn = 0;
    return turn;
  }

  isDown(action: InputAction): boolean {
    if (this.touch?.isDown(action)) return true;
    if (action === 'sprint' && this.xrSprint) return true;
    if (action === 'jump' && this.xrJumpHeld) return true;
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
    x += this.xrMoveX;
    z += this.xrMoveZ;

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
    window.removeEventListener('keydown', this.handleEscape, true);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);
    this.element.removeEventListener('mousemove', this.handleMouseMove);
    this.element.removeEventListener('wheel', this.handleWheel);
    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.pressed.clear();
    this.justPressed.clear();
  }

  /**
   * Escape toggles the pause screen. The browser's own Esc action is what
   * puts the cursor back, so that is left alone. It is cancelled only when
   * this press captures the mouse again, or the cursor would vanish immediately.
   */
  private handleEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.repeat || this.disposed || !this.onEscape) return;
    if (document.querySelector('dialog[open]')) return;
    const relock = this.onEscape() === true;
    if (relock) event.preventDefault();
  };

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
    this.touch?.reset();
  };

  /**
   * A click captures the cursor for looking. Touch is left alone: the joysticks
   * already have the finger, and they do not need a tap before they work.
   */
  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.moveBeforeLock || this.locked || this.disposed || event.button !== 0) return;
    if (event.pointerType === 'touch' || event.pointerType === 'pen') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button, a, input, textarea, select, label, dialog, .wm-lock, .walk-pause-actions')) return;
    this.requestPointerLock();
  };

  /**
   * Captured: every movement turns the camera. Before the first click, with
   * moveBeforeLock, the visible cursor turns it too, so looking works from the start.
   */
  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked && !this.hoverLook(event)) return;
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private hoverLook(event: MouseEvent): boolean {
    if (!this.moveBeforeLock || this.disposed || isTouchDevice()) return false;
    // A held button is a drag on something else, not a look.
    return event.buttons === 0;
  }

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

const XR_TURN_SPEED = 2.4;
const XR_DEADZONE = 0.18;

function readThumbstick(pad: Gamepad): { x: number; y: number } {
  const x = pad.axes.length >= 4 ? pad.axes[2] : (pad.axes[0] ?? 0);
  const y = pad.axes.length >= 4 ? pad.axes[3] : (pad.axes[1] ?? 0);
  if (Math.hypot(x, y) < XR_DEADZONE) return { x: 0, y: 0 };
  return { x, y };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

import type { InputAction, Keymap } from '../types';
import { resolveKeymap } from './keymap';

export interface InputOptions {
  /** The element that receives pointer lock. */
  element: HTMLElement;
  keymap?: Partial<Keymap>;
  onPointerLockChange?: (locked: boolean) => void;
}

/**
 * Keyboard + pointer-lock mouse input. This is the only place in WorldMesh
 * that reads raw browser events, so the control convention lives in one file
 * instead of being copy-pasted into every world.
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
  private codeToActions = new Map<string, InputAction[]>();
  private onPointerLockChange?: (locked: boolean) => void;
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

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    this.element.addEventListener('mousemove', this.handleMouseMove);
    this.element.addEventListener('wheel', this.handleWheel, { passive: true });
  }

  requestPointerLock(): void {
    if (this.disposed || this.locked) return;
    // Some embedders refuse pointer lock; a rejected promise must not surface
    // as an uncaught error in the world's console.
    Promise.resolve(this.element.requestPointerLock?.()).catch(() => {});
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  isDown(action: InputAction): boolean {
    for (const code of this.keymap[action]) if (this.pressed.has(code)) return true;
    return false;
  }

  /** True once per key press. Reading it clears the flag. */
  consume(action: InputAction): boolean {
    if (!this.justPressed.has(action)) return false;
    this.justPressed.delete(action);
    return true;
  }

  /** Movement intent on the local XZ plane, already normalized. */
  getMoveAxis(): { x: number; z: number } {
    const x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    const z = (this.isDown('backward') ? 1 : 0) - (this.isDown('forward') ? 1 : 0);
    const length = Math.hypot(x, z);
    if (length === 0) return { x: 0, z: 0 };
    return { x: x / length, z: z / length };
  }

  /** Read and reset the mouse/wheel accumulators. Call once per frame. */
  readLook(): { dx: number; dy: number; wheel: number } {
    const look = { dx: this.mouseDeltaX, dy: this.mouseDeltaY, wheel: this.wheelDelta };
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
    return look;
  }

  /** Drop stale edge-triggers at the end of a frame. */
  endFrame(): void {
    this.justPressed.clear();
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    this.element.removeEventListener('mousemove', this.handleMouseMove);
    this.element.removeEventListener('wheel', this.handleWheel);
    this.pressed.clear();
    this.justPressed.clear();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (isTypingTarget(event.target)) return;
    const actions = this.codeToActions.get(event.code);
    if (!actions) return;
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
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) {
      this.pressed.clear();
      this.justPressed.clear();
    }
    this.onPointerLockChange?.(this.locked);
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

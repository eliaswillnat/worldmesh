import type { Keymap } from '../types.js';

/**
 * The WorldMesh control convention. Every world ships these bindings so that
 * moving through an unfamiliar world feels like moving through a familiar one.
 */
export const DEFAULT_KEYMAP: Keymap = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE'],
  toggleView: ['KeyV'],
  crouch: ['KeyC'],
  fly: ['KeyF'],
  dash: ['KeyQ'],
};

export function resolveKeymap(overrides: Partial<Keymap> = {}): Keymap {
  return { ...DEFAULT_KEYMAP, ...overrides };
}

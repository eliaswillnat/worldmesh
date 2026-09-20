import type { Abilities } from '../types';

export const DEFAULT_ABILITIES: Abilities = {
  doubleJump: false,
  flying: false,
  crouching: false,
  dash: false,
  climbing: false,
  swimming: false,
  vehicles: false,
};

const RESERVED: (keyof Abilities)[] = ['climbing', 'swimming', 'vehicles'];

/**
 * Merge a world's declared abilities over the defaults. Abilities are pure
 * configuration: the shared controller reads these flags, so a world never
 * has to fork the movement code to add one.
 */
export function resolveAbilities(declared: Partial<Abilities> = {}): Abilities {
  const abilities: Abilities = { ...DEFAULT_ABILITIES, ...declared };
  for (const key of RESERVED) {
    if (abilities[key]) {
      console.warn(
        `[worldmesh] ability "${key}" is reserved in the standard but not implemented yet; it will have no effect.`,
      );
    }
  }
  return abilities;
}

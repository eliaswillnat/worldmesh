/**
 * Deterministic randomness for the city. Everything that decides what stands
 * where is seeded from shared inputs (tower, slot, rotation window), never
 * from Math.random, so every visitor and every future multiplayer instance
 * sees the same city during the same rotation window.
 */

/** FNV-1a over a string. */
export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One hash from several parts, order-sensitive. */
export function hashParts(...parts: (string | number)[]): number {
  return hashString(parts.join('␟'));
}

/** A hash mapped to [0, 1). */
export function unitHash(...parts: (string | number)[]): number {
  // Mix once more: FNV's low bits are weak for short, similar inputs.
  let t = hashParts(...parts) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Small seeded generator (mulberry32). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

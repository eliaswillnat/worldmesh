import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, type Object3D } from 'three';

/**
 * The handful of materials the whole city shares. Every slab, frame, deck
 * and platform uses one of these, so the city's material count stays flat
 * however many floors are loaded.
 */
export interface CityMaterials {
  /** Slabs, decks, platforms: dark or warm-grey structure. */
  structure: MeshStandardMaterial;
  /** Door frames, lift doors, jambs: a shade apart from the structure. */
  frame: MeshStandardMaterial;
  /** Thin light lines. */
  trim: MeshBasicMaterial;
  /** Railing glass. */
  glass: MeshBasicMaterial;
  /** Category accent lines, one per colour. */
  accent(color: string): MeshBasicMaterial;
  setTheme(light: boolean): void;
  dispose(): void;
}

export interface CityPalette {
  structure: number;
  /** Lift for the undersides of slabs and decks, which the sky light never reaches. */
  structureGlow: number;
  frame: number;
  trim: number;
  glass: number;
  /** Tower shell body, joints, lit windows. */
  shell: number;
  shellLine: number;
  shellGlow: number;
  /** Interior wall. */
  interior: number;
  shutter: number;
  night: number;
}

export const PALETTES: Record<'dark' | 'light', CityPalette> = {
  dark: {
    structure: 0x2a2c31,
    structureGlow: 0x131417,
    frame: 0x3a3c42,
    trim: 0xf1e7d0,
    glass: 0x9fb4c8,
    shell: 0x24262b,
    shellLine: 0x121316,
    shellGlow: 0xf0d9a8,
    interior: 0x2c2e33,
    shutter: 0x4a4d54,
    night: 1,
  },
  light: {
    structure: 0xb9b6ae,
    structureGlow: 0x2a2a28,
    frame: 0x8f8d88,
    trim: 0x2b2d33,
    glass: 0x5d7188,
    shell: 0xc4c1b9,
    shellLine: 0x8a877f,
    shellGlow: 0x2e3440,
    interior: 0xcfccc4,
    shutter: 0x7c7f86,
    night: 0,
  },
};

export function createCityMaterials(light: boolean): CityMaterials {
  const structure = new MeshStandardMaterial({ roughness: 0.82, metalness: 0.05 });
  const frame = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 });
  const trim = new MeshBasicMaterial({ toneMapped: false });
  const glass = new MeshBasicMaterial({ transparent: true, opacity: 0.14, depthWrite: false, side: DoubleSide });
  const accents = new Map<string, MeshBasicMaterial>();
  let isLight = light;

  const materials: CityMaterials = {
    structure,
    frame,
    trim,
    glass,
    accent(color) {
      let material = accents.get(color);
      if (!material) {
        material = new MeshBasicMaterial({ color: new Color(color), toneMapped: false });
        if (isLight) material.color.multiplyScalar(0.7);
        accents.set(color, material);
      }
      return material;
    },
    setTheme(next) {
      isLight = next;
      const palette = PALETTES[next ? 'light' : 'dark'];
      structure.color.set(palette.structure);
      structure.emissive.set(palette.structureGlow);
      frame.color.set(palette.frame);
      trim.color.set(palette.trim);
      glass.color.set(palette.glass);
      glass.opacity = next ? 0.22 : 0.14;
      for (const [color, material] of accents) {
        material.color.set(color);
        if (next) material.color.multiplyScalar(0.7);
      }
    },
    dispose() {
      structure.dispose();
      frame.dispose();
      trim.dispose();
      glass.dispose();
      for (const material of accents.values()) material.dispose();
    },
  };
  materials.setTheme(light);
  return materials;
}

/**
 * Draw an object only with the main camera: interiors never show in the
 * lobby's floor mirror, which would otherwise render them a second time.
 */
export function setLayer(object: Object3D, layer: number): void {
  object.traverse((child) => child.layers.set(layer));
}

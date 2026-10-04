import { ExtrudeGeometry, Shape, type BufferGeometry } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Gallery cards round every corner by 16px on a 240px-wide tile. Doors use
 * the same amount, on the top-left and top-right only, so they sit flat on
 * the floor.
 */
export const GALLERY_CORNER = 16 / 240;

/**
 * `uv` is 0–1 across the doorway. `r` is the corner radius as a fraction of
 * width. `aspect` is width / height, so the same radius in metres is
 * `r * aspect` of the height — a circle, the way CSS border-radius is.
 * Returns 0 at the middle and 1 on the rim; outside the rounded top the
 * value is greater than 1.
 */
export const ROUNDED_TOP_GLSL = /* glsl */ `
float roundedTopEdge(vec2 uv, float r, float aspect) {
  float ry = max(r * aspect, 1e-5);
  vec2 p = uv - 0.5;
  float box = max(abs(p.x) * 2.0, abs(p.y) * 2.0);
  if (uv.y <= 1.0 - ry || (uv.x >= r && uv.x <= 1.0 - r)) return box;
  vec2 c = vec2(uv.x < 0.5 ? r : 1.0 - r, 1.0 - ry);
  return length((uv - c) / vec2(r, ry));
}
`;

/** How far the frame continues under the floor, so its end is not a lip on the ground. */
const BURY = 0.06;

/**
 * Top-corner radii of the opening, in metres. A circle of the gallery-card
 * radius, the same curve the doorway shader clips to.
 */
export function openingCorner(width: number, height: number): { rx: number; ry: number } {
  const radius = Math.min(width * GALLERY_CORNER, width / 2, height);
  return { rx: radius, ry: radius };
}

/** Outer top-corner radii of a frame, the curve the wall opening is cut to. */
export function frameOuterCorner(width: number, height: number, thickness: number): { rx: number; ry: number } {
  const { rx, ry } = openingCorner(width, height);
  return { rx: rx + thickness, ry: ry + thickness };
}

/**
 * A door frame in XY, extruded along Z and centred on z = 0. The opening's
 * top corners, and the frame's own top corners, follow one smooth curve.
 * The posts run a little under the floor instead of ending on it.
 */
export function doorFrameGeometry(
  innerW: number,
  innerH: number,
  thickness: number,
  depth: number,
  sill = 0,
  cap = thickness,
): BufferGeometry {
  const { rx, ry } = openingCorner(innerW, innerH);
  const left = -innerW / 2;
  const right = innerW / 2;
  const top = sill + innerH;
  const y0 = -BURY;
  const outerL = left - thickness;
  const outerR = right + thickness;
  const border = Math.min(cap, thickness);
  const cxL = left + rx;
  const cxR = right - rx;
  const cy = top - ry;
  const orx = rx + thickness;
  const ory = ry + border;
  const crown = top + border;

  // Outer top, shared by both outlines: up the right side, around the corner, across, down the left.
  const outerTop = (shape: Shape) => {
    shape.lineTo(outerR, cy);
    shape.absellipse(cxR, cy, orx, ory, 0, Math.PI / 2, false);
    if (cap > border + 1e-4) {
      const housing = top + cap;
      shape.lineTo(outerR, crown);
      shape.lineTo(outerR, housing);
      shape.lineTo(outerL, housing);
      shape.lineTo(outerL, crown);
    }
    shape.lineTo(cxL, crown);
    shape.absellipse(cxL, cy, orx, ory, Math.PI / 2, Math.PI, false);
  };

  const shape = new Shape();
  if (sill > 0) {
    // A threshold across the bottom, with the opening cut out above it.
    shape.moveTo(outerL, y0);
    shape.lineTo(outerR, y0);
    outerTop(shape);
    shape.lineTo(outerL, y0);
    shape.closePath();
    const hole = new Shape();
    hole.moveTo(left, sill);
    hole.lineTo(right, sill);
    hole.lineTo(right, cy);
    hole.absellipse(cxR, cy, rx, ry, 0, Math.PI / 2, false);
    hole.lineTo(cxL, top);
    hole.absellipse(cxL, cy, rx, ry, Math.PI / 2, Math.PI, false);
    hole.closePath();
    shape.holes.push(hole);
  } else {
    // No threshold. The posts run under the floor, and the opening meets it.
    shape.moveTo(outerL, y0);
    shape.lineTo(left, y0);
    shape.lineTo(left, cy);
    shape.absellipse(cxL, cy, rx, ry, Math.PI, Math.PI / 2, true);
    shape.lineTo(cxR, top);
    shape.absellipse(cxR, cy, rx, ry, Math.PI / 2, 0, true);
    shape.lineTo(right, y0);
    shape.lineTo(outerR, y0);
    outerTop(shape);
    shape.lineTo(outerL, y0);
    shape.closePath();
  }

  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
  geometry.translate(0, 0, -depth / 2);
  const smooth = mergeVertices(geometry, 1e-4);
  geometry.dispose();
  smooth.computeVertexNormals();
  return smooth;
}

/** The filled opening: flat on the floor, rounded at the top like the doorway. */
export function roundedOpeningGeometry(width: number, height: number, depth: number): BufferGeometry {
  const { rx, ry } = openingCorner(width, height);
  const left = -width / 2;
  const right = width / 2;
  const shape = new Shape();
  shape.moveTo(left, 0);
  shape.lineTo(left, height - ry);
  shape.absellipse(left + rx, height - ry, rx, ry, Math.PI, Math.PI / 2, true);
  shape.lineTo(right - rx, height);
  shape.absellipse(right - rx, height - ry, rx, ry, Math.PI / 2, 0, true);
  shape.lineTo(right, 0);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

import { hash } from "@/lib/anim/hash";

export interface Ring {
  id: number;
  rx: number;
  ry: number;
  strokeWidth: number;
  opacity: number;
  dashArray?: string;
  dashOffset: number;
  animationDelay: number;
  animationDuration: number;
}

// The source artwork draws the water as concentric rings around the tiger's
// raised paw. This continues that field outward across the whole viewport so
// the page reads as the same surface the animal is standing in, rather than a
// backdrop the artwork was placed on.
//
// Two details do the heavy lifting:
//   * the rings are ellipses (flattened vertically), because we are looking
//     at a surface at an angle — perfect circles read as a target, not water;
//   * the outer rings are broken into dashed arcs, because unbroken
//     concentric rings also read as a target. Water ripples are discontinuous.
export function generateRippleField(count = 22): Ring[] {
  const rings: Ring[] = [];

  const BASE = 46;
  const GROWTH = 1.205;
  const SQUASH = 0.42;

  for (let i = 0; i < count; i++) {
    const rx = BASE * Math.pow(GROWTH, i);
    const t = i / (count - 1);

    const h1 = hash(i * 5 + 1);
    const h2 = hash(i * 5 + 2);
    const h3 = hash(i * 5 + 3);

    // Brightest near the paw, fading out — the disturbance loses energy.
    const opacity = 0.34 * Math.pow(1 - t, 1.35) + 0.035;
    const strokeWidth = 1.7 * (1 - t) + 0.55;

    // Inner rings stay whole (closest to the impact, still coherent); outer
    // ones break up progressively.
    const dashArray =
      i < 5
        ? undefined
        : `${(10 + h1 * 46).toFixed(1)} ${(9 + h2 * 30).toFixed(1)}`;

    rings.push({
      id: i,
      rx,
      ry: rx * SQUASH,
      strokeWidth,
      opacity,
      dashArray,
      dashOffset: h3 * 240,
      animationDelay: h1 * 6,
      animationDuration: 5.5 + h2 * 4.5,
    });
  }

  return rings;
}

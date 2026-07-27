import { roundedRectPoint } from "@/lib/geometry/roundedRect";
import { hash } from "@/lib/anim/hash";

export interface Blade {
  id: number;
  d: string;
  opacity: number;
  animationDelay: number;
  animationDuration: number;
  swayDeg: number;
  originX: number;
  originY: number;
}

export interface Blossom {
  id: number;
  cx: number;
  cy: number;
  rotation: number;
  scale: number;
  animationDelay: number;
  animationDuration: number;
  detach: boolean;
}

export interface GrassField {
  blades: Blade[];
  blossoms: Blossom[];
  viewBoxSize: { width: number; height: number };
}

// Local outward normal at perimeter position t, via finite-difference tangent
// — same technique as the liquid-metal border's tube sweep.
function outwardNormal(t: number, halfW: number, halfH: number, r: number): [number, number] {
  const [x1, y1] = roundedRectPoint(t, halfW, halfH, r);
  const [x2, y2] = roundedRectPoint(t + 0.002, halfW, halfH, r);
  let tx = x2 - x1;
  let ty = y2 - y1;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len;
  ty /= len;
  // Two perpendiculars; pick the one pointing away from the rect's center.
  const nx = -ty;
  const ny = tx;
  const dot = nx * x1 + ny * y1;
  return dot < 0 ? [-nx, -ny] : [nx, ny];
}

// Landmark t-values for the four corner midpoints and two edge midpoints,
// following the same segment walk order as roundedRectPoint (top edge → TR
// arc → right edge → BR arc → bottom edge → BL arc → left edge → TL arc).
function blossomLandmarks(halfW: number, halfH: number, r: number): number[] {
  const w = Math.max(halfW - r, 0);
  const h = Math.max(halfH - r, 0);
  const straightH = 2 * w;
  const straightV = 2 * h;
  const arc = (Math.PI / 2) * r;
  const perimeter = 2 * straightH + 2 * straightV + 4 * arc || 1;

  const topEdgeMid = straightH / 2;
  const trArcMid = straightH + arc / 2;
  const brArcMid = straightH + arc + straightV + arc / 2;
  const bottomStart = straightH + arc + straightV + arc;
  const bottomEdgeMid = bottomStart + straightH / 2;
  const blArcMid = bottomStart + straightH + arc / 2;
  const leftStart = bottomStart + straightH + arc;
  const tlArcMid = leftStart + straightV + arc / 2;

  return [trArcMid, brArcMid, blArcMid, tlArcMid, topEdgeMid, bottomEdgeMid].map((d) => d / perimeter);
}

export function generateGrassField(
  halfW: number,
  halfH: number,
  radius: number,
  bleed: number,
  bladeCount = 90,
): GrassField {
  const blades: Blade[] = [];

  for (let i = 0; i < bladeCount; i++) {
    const t = i / bladeCount;
    const [bx, by] = roundedRectPoint(t, halfW, halfH, radius);
    const [nx, ny] = outwardNormal(t, halfW, halfH, radius);

    const h1 = hash(i * 7 + 1);
    const h2 = hash(i * 7 + 2);
    const h3 = hash(i * 7 + 3);
    const h4 = hash(i * 7 + 4);
    const h5 = hash(i * 7 + 5);

    // Wide height spread so the field has an understory instead of reading as
    // one combed fringe.
    const height = bleed * (0.28 + h1 * h1 * 1.05);
    // Blades mostly bow the same rotational direction (one prevailing wind),
    // but roughly a quarter lean back against it — without those the border
    // looks like a repeated stamp rather than grass.
    const bendDir = h5 > 0.74 ? -1 : 1;
    const bend = bendDir * height * (0.12 + h2 * 0.75);
    // Perpendicular to the normal, for the blade's sideways lean/bend.
    const px = -ny;
    const py = nx;

    const tipX = bx + nx * height + px * bend;
    const tipY = by + ny * height + py * bend;
    // Control point kept low and near-normal so the blade leaves the edge
    // straight and only curls near the tip — how a real blade bends.
    const ctrlX = bx + nx * height * 0.62 + px * bend * 0.12;
    const ctrlY = by + ny * height * 0.62 + py * bend * 0.12;

    // Filled tapered shape rather than a stroke: a blade is wide at the root
    // and comes to a point, which a uniform-width stroke cannot express.
    const halfBase = 0.7 + h3 * 1.0;
    const f = (n: number) => n.toFixed(1);
    const d = [
      `M ${f(bx - px * halfBase)} ${f(by - py * halfBase)}`,
      `Q ${f(ctrlX - px * halfBase * 0.5)} ${f(ctrlY - py * halfBase * 0.5)} ${f(tipX)} ${f(tipY)}`,
      `Q ${f(ctrlX + px * halfBase * 0.5)} ${f(ctrlY + py * halfBase * 0.5)} ${f(bx + px * halfBase)} ${f(by + py * halfBase)}`,
      "Z",
    ].join(" ");

    blades.push({
      id: i,
      d,
      opacity: 0.3 + h4 * 0.4,
      animationDelay: h1 * 3.2,
      animationDuration: 2.6 + h2 * 1.8,
      swayDeg: 3 + h3 * 5,
      originX: bx,
      originY: by,
    });
  }

  const landmarks = blossomLandmarks(halfW, halfH, radius);
  const blossoms: Blossom[] = landmarks.map((t, i) => {
    const [bx, by] = roundedRectPoint(t, halfW, halfH, radius);
    const [nx, ny] = outwardNormal(t, halfW, halfH, radius);
    const reach = bleed * 0.5;
    const h1 = hash(i * 11 + 5);
    const h2 = hash(i * 11 + 6);
    return {
      id: i,
      cx: bx + nx * reach,
      cy: by + ny * reach,
      rotation: h1 * 360,
      scale: 1.5 + h2 * 0.9,
      animationDelay: h1 * 4,
      animationDuration: 5 + h2 * 3,
      detach: i % 2 === 0,
    };
  });

  return {
    blades,
    blossoms,
    viewBoxSize: { width: (halfW + bleed) * 2, height: (halfH + bleed) * 2 },
  };
}

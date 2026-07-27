import { roundedRectPoint } from "@/lib/geometry/roundedRect";
import { hash } from "@/lib/anim/hash";

export interface Placement {
  id: number;
  x: number;
  y: number;
  rot: number;
  scale: number;
  delay: number;
  duration: number;
}

export interface Blade {
  id: number;
  d: string;
  veinD: string;
  opacity: number;
  delay: number;
  duration: number;
  swayDeg: number;
  originX: number;
  originY: number;
}

export interface BorderField {
  branchD: string;
  barkTicks: Array<{ id: number; x1: number; y1: number; x2: number; y2: number }>;
  blossoms: Placement[];
  buds: Placement[];
  leaves: Placement[];
  blades: Blade[];
  viewBox: { w: number; h: number };
}

function outwardNormal(t: number, halfW: number, halfH: number, r: number): [number, number] {
  const [x1, y1] = roundedRectPoint(t, halfW, halfH, r);
  const [x2, y2] = roundedRectPoint(t + 0.002, halfW, halfH, r);
  let tx = x2 - x1;
  let ty = y2 - y1;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len;
  ty /= len;
  const nx = -ty;
  const ny = tx;
  return nx * x1 + ny * y1 < 0 ? [-nx, -ny] : [nx, ny];
}

// Where the plant life bunches up. Real branches flower in clusters with bare
// stretches between; evenly spaced blossoms are the single clearest tell of a
// machine-made border, so spacing stays deliberately uneven — but there are
// enough clusters that no long run of the frame reads as bare, which is the
// failure mode on tall portrait panels where the side edges dominate the
// perimeter.
const CLUSTERS = [
  0.02, 0.075, 0.14, 0.205, 0.275, 0.335, 0.40, 0.455,
  0.525, 0.59, 0.655, 0.72, 0.785, 0.85, 0.905, 0.965,
];

export function generateBorderField(
  halfW: number,
  halfH: number,
  radius: number,
  bleed: number,
  density = 1,
): BorderField {
  // The branch: a closed loop just outside the panel edge that everything
  // else grows off. Blossoms attached to a twig read as a plant; blossoms
  // floating on their own read as clip-art.
  const branchOffset = bleed * 0.3;
  const branchPts: string[] = [];
  const barkTicks: BorderField["barkTicks"] = [];
  const SAMPLES = 220;

  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const [px, py] = roundedRectPoint(t, halfW, halfH, radius);
    const [nx, ny] = outwardNormal(t, halfW, halfH, radius);
    // Gentle waver so the twig isn't a perfect offset outline.
    const waver = Math.sin(t * Math.PI * 14) * bleed * 0.05 + (hash(i) - 0.5) * 1.6;
    const bx = px + nx * (branchOffset + waver);
    const by = py + ny * (branchOffset + waver);
    branchPts.push(`${i === 0 ? "M" : "L"} ${bx.toFixed(1)} ${by.toFixed(1)}`);

    if (i % 5 === 2) {
      const h = hash(i * 3 + 7);
      const len = 2 + h * 3.4;
      barkTicks.push({
        id: i,
        x1: bx - nx * len * 0.4,
        y1: by - ny * len * 0.4,
        x2: bx + nx * len * 0.6,
        y2: by + ny * len * 0.6,
      });
    }
  }

  const blossoms: Placement[] = [];
  const buds: Placement[] = [];
  const leaves: Placement[] = [];
  let idc = 0;

  CLUSTERS.forEach((ct, ci) => {
    const blossomCount = Math.max(1, Math.round((3 + Math.floor(hash(ci * 9 + 1) * 3)) * density));
    const budCount = Math.max(1, Math.round((3 + Math.floor(hash(ci * 9 + 2) * 4)) * density));
    const leafCount = Math.max(1, Math.round((3 + Math.floor(hash(ci * 9 + 3) * 4)) * density));

    const place = (
      seed: number,
      spreadT: number,
      reachLo: number,
      reachHi: number,
      scaleLo: number,
      scaleHi: number,
    ): Placement => {
      const h1 = hash(seed * 7 + 1);
      const h2 = hash(seed * 7 + 2);
      const h3 = hash(seed * 7 + 3);
      const h4 = hash(seed * 7 + 4);
      const t = ct + (h1 - 0.5) * spreadT;
      const [px, py] = roundedRectPoint(t, halfW, halfH, radius);
      const [nx, ny] = outwardNormal(t, halfW, halfH, radius);
      const reach = bleed * (reachLo + h2 * (reachHi - reachLo));
      return {
        id: idc++,
        x: px + nx * reach,
        y: py + ny * reach,
        rot: h3 * 360,
        scale: scaleLo + h4 * (scaleHi - scaleLo),
        delay: h1 * 5,
        duration: 5 + h2 * 4,
      };
    };

    for (let i = 0; i < blossomCount; i++) blossoms.push(place(ci * 100 + i, 0.075, 0.34, 0.78, 0.85, 1.45));
    for (let i = 0; i < budCount; i++) buds.push(place(ci * 100 + 40 + i, 0.09, 0.26, 0.85, 0.7, 1.15));
    for (let i = 0; i < leafCount; i++) leaves.push(place(ci * 100 + 70 + i, 0.1, 0.22, 0.8, 0.8, 1.3));
  });

  // Reeds along the lower edge, wrapping round both bottom corners and part
  // way up the sides — grass grows from the ground, so it thins out as it
  // climbs rather than ringing the panel evenly.
  const blades: Blade[] = [];
  const bladeCount = Math.round(78 * density);
  const T_START = 0.34;
  const T_SPAN = 0.46;
  for (let i = 0; i < bladeCount; i++) {
    // t 0.34..0.80 covers the bottom run plus both corners and a little of
    // each side.
    const t = T_START + (i / bladeCount) * T_SPAN;
    const [bx, by] = roundedRectPoint(t, halfW, halfH, radius);
    const [nx, ny] = outwardNormal(t, halfW, halfH, radius);
    const px = -ny;
    const py = nx;

    const h1 = hash(i * 11 + 1);
    const h2 = hash(i * 11 + 2);
    const h3 = hash(i * 11 + 3);
    const h4 = hash(i * 11 + 4);

    // Fade the reeds out toward both ends of the run, so the band tapers off
    // instead of stopping dead where the corner turns.
    const along = i / (bladeCount - 1);
    const falloff = Math.sin(Math.PI * along) ** 0.55;
    const height = bleed * (0.35 + h1 * h1 * 1.0) * (0.35 + 0.65 * falloff);
    const bend = (h4 > 0.72 ? -1 : 1) * height * (0.15 + h2 * 0.7);
    const halfBase = 1.5 + h3 * 2.0;

    const tipX = bx + nx * height + px * bend;
    const tipY = by + ny * height + py * bend;
    const cX = bx + nx * height * 0.6 + px * bend * 0.12;
    const cY = by + ny * height * 0.6 + py * bend * 0.12;
    const f = (n: number) => n.toFixed(1);

    blades.push({
      id: i,
      d: [
        `M ${f(bx - px * halfBase)} ${f(by - py * halfBase)}`,
        `Q ${f(cX - px * halfBase * 0.45)} ${f(cY - py * halfBase * 0.45)} ${f(tipX)} ${f(tipY)}`,
        `Q ${f(cX + px * halfBase * 0.45)} ${f(cY + py * halfBase * 0.45)} ${f(bx + px * halfBase)} ${f(by + py * halfBase)}`,
        "Z",
      ].join(" "),
      veinD: `M ${f(bx)} ${f(by)} Q ${f(cX)} ${f(cY)} ${f(tipX)} ${f(tipY)}`,
      opacity: 0.3 + h4 * 0.38,
      delay: h1 * 3,
      duration: 2.8 + h2 * 1.8,
      swayDeg: 2.5 + h3 * 4.5,
      originX: bx,
      originY: by,
    });
  }

  return {
    branchD: branchPts.join(" ") + " Z",
    barkTicks,
    blossoms,
    buds,
    leaves,
    blades,
    viewBox: { w: (halfW + bleed) * 2, h: (halfH + bleed) * 2 },
  };
}

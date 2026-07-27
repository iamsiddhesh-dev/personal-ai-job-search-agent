// Maps a normalized perimeter position t∈[0,1) to an (x,y) point on a rounded
// rectangle's edge (half-extents halfW/halfH, corner radius r), walking the
// loop clockwise: top edge → TR corner → right edge → BR corner → bottom edge
// → BL corner → left edge → TL corner.
export function roundedRectPoint(t: number, halfW: number, halfH: number, r: number): [number, number] {
  const w = Math.max(halfW - r, 0);
  const h = Math.max(halfH - r, 0);
  const straightH = 2 * w;
  const straightV = 2 * h;
  const arc = (Math.PI / 2) * r;
  const perimeter = 2 * straightH + 2 * straightV + 4 * arc || 1;
  let d = (((t % 1) + 1) % 1) * perimeter;

  if (d < straightH) return [-w + d, -halfH];
  d -= straightH;
  if (d < arc) {
    const a = -Math.PI / 2 + (d / arc) * (Math.PI / 2);
    return [w + r * Math.cos(a), -h + r * Math.sin(a)];
  }
  d -= arc;
  if (d < straightV) return [halfW, -h + d];
  d -= straightV;
  if (d < arc) {
    const a = 0 + (d / arc) * (Math.PI / 2);
    return [w + r * Math.cos(a), h + r * Math.sin(a)];
  }
  d -= arc;
  if (d < straightH) return [w - d, halfH];
  d -= straightH;
  if (d < arc) {
    const a = Math.PI / 2 + (d / arc) * (Math.PI / 2);
    return [-w + r * Math.cos(a), h + r * Math.sin(a)];
  }
  d -= arc;
  if (d < straightV) return [-halfW, h - d];
  d -= straightV;
  const a = Math.PI + (d / arc) * (Math.PI / 2);
  return [-w + r * Math.cos(a), -h + r * Math.sin(a)];
}

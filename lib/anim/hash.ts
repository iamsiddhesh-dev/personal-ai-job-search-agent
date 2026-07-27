// Deterministic hash instead of Math.random() — render must stay pure, and
// this only needs to look scattered, not be truly random.
export function hash(i: number): number {
  const v = Math.sin(i * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

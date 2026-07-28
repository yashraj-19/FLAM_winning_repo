/**
 * Chart palette, dark surface.
 *
 * These six hues were run through a colour-blindness validator rather than
 * picked by eye. On the *adjacent* pairlist - which is what line, bar and
 * heatmap use, since neighbouring series are what a reader compares - every
 * gate passes: worst adjacent CVD separation is dE 8.4 (yellow vs aqua under
 * protanopia), worst normal-vision separation dE 19.3, and all six clear 3:1
 * contrast against the #1a1a19 surface.
 *
 * Under the stricter *all-pairs* rule the same six fail: magenta vs aqua
 * collapses to dE 1.6 under deuteranopia. That rule is the relevant one for a
 * scatter plot, where any two categories can end up side by side with no
 * ordering to lean on. Rather than cut the series list, the scatter carries a
 * second encoding - a distinct marker shape per category - so identity never
 * rests on hue alone. See SHAPES below.
 */

export const SERIES_COLORS = [
  '#3987e5', // cpu        - blue
  '#d95926', // memory     - orange
  '#199e70', // network    - aqua
  '#c98500', // disk       - yellow
  '#d55181', // latency    - magenta
  '#008300', // throughput - green
] as const;

/** Marker shapes for the scatter plot: the secondary encoding for CVD safety. */
export const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'plus', 'cross'] as const;
export type Shape = (typeof SHAPES)[number];

/** Chart chrome. Kept here so canvas and CSS cannot drift apart. */
export const CHROME = {
  surface: '#1a1a19',
  plane: '#0d0d0d',
  textPrimary: '#ffffff',
  textSecondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  border: 'rgba(255,255,255,0.10)',
} as const;

/** Sequential blue ramp, light to dark. Used for heatmap cell magnitude. */
export const SEQUENTIAL = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
] as const;

/**
 * Pre-parsed RGB triples for the sequential ramp.
 *
 * The heatmap picks a colour per cell, thousands of times per frame. Parsing
 * "#3987e5" into channels on every cell would mean thousands of string
 * operations and substring allocations inside the draw loop. Doing it once at
 * module load costs nothing and the hot path becomes array indexing.
 */
export const SEQUENTIAL_RGB: Array<[number, number, number]> = SEQUENTIAL.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

/** Map a 0..1 magnitude onto the sequential ramp. */
export function rampColor(t: number): string {
  const i = Math.min(SEQUENTIAL_RGB.length - 1, Math.max(0, Math.round(t * (SEQUENTIAL_RGB.length - 1))));
  const [r, g, b] = SEQUENTIAL_RGB[i];
  return `rgb(${r},${g},${b})`;
}

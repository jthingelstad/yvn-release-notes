// The shared Release Notes mark: a version, its dot, and two written lines.
// Both the header and scripts/make_icons.mjs use these font-independent shapes.
export const BRAND_MARK = {
  viewBox: '0 0 100 100',
  version: 'M12 12h19l14 38 14-38h19L57 64H33Z',
  dot: 'M89 54a11 11 0 1 1-22 0 11 11 0 0 1 22 0',
  notes: 'M18 72h68a3 3 0 0 1 0 6H18a3 3 0 0 1 0-6ZM18 85h46a3 3 0 0 1 0 6H18a3 3 0 0 1 0-6Z'
} as const;

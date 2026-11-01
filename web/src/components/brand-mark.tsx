import { BRAND_MARK } from '../lib/brand-mark.ts';

// Decorative beside the name, so the link still reads just "Release Notes".
// The tile keeps the icon's colours in both themes, as the tab icon does.
export function BrandMark() {
  const { colors, dot } = BRAND_MARK;
  return (
    <svg className="brand-mark" viewBox={BRAND_MARK.viewBox} aria-hidden="true" focusable="false">
      <rect width="100" height="100" rx={BRAND_MARK.radius} fill={colors.tile} />
      <path fill={colors.version} d={BRAND_MARK.version} />
      <circle fill={colors.dot} cx={dot.cx} cy={dot.cy} r={dot.r} />
    </svg>
  );
}

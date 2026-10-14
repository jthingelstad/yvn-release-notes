import { BRAND_MARK } from '../lib/brand-mark.ts';

// Decorative beside the name, so the link still reads just "Release Notes".
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox={BRAND_MARK.viewBox} aria-hidden="true" focusable="false">
      <path className="brand-mark-blue" d={BRAND_MARK.version} />
      <path className="brand-mark-dot" d={BRAND_MARK.dot} />
      <path className="brand-mark-blue" d={BRAND_MARK.notes} />
    </svg>
  );
}

/** A book's limits, shared by the API, the worker and the web page. */

/** The most photos one book takes: each is fetched and resized in the export
 * worker's fifteen minutes. */
export const MAX_PHOTOS = 1000;
/** A title is at most this many characters. */
export const MAX_TITLE = 80;
/** The page sizes a book is set at (Jamie, 2026-10-25: "pick US Letter or
 * 6x9 for printing"): 6 by 9 inches, a trade book's trim, or US Letter, for
 * a home printer. The first is the default. */
export const PAGE_SIZES = ['6x9', 'letter'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const isPageSize = (value: unknown): value is PageSize => PAGE_SIZES.includes(value as PageSize);
/** Commentary by Claude (Jamie, 2026-10-25: "As annotation and commentary
 * yes." and "how about 10 books a year (aka, major verison?)"): at most this
 * many finished books with it in each release, a year of life, birthday to
 * birthday. A book that fails doesn't count. */
export const COMMENTARY_PER_RELEASE = 10;
/** Claude comments on at most a year of days at once. */
export const COMMENTARY_DAYS = 366;

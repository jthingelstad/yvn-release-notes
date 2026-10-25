/** A book's limits, shared by the API, the worker and the web page. */

/** The most photos one book takes: each is fetched and resized in the export
 * worker's fifteen minutes. */
export const MAX_PHOTOS = 1000;
/** A title is at most this many characters. */
export const MAX_TITLE = 80;

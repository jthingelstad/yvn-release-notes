/** The card a link to Release Notes shows where it is shared: the picture,
 * its alt text, and the kind of X card. The front page and every address the
 * app serves get it from vite.config.ts, which adds these tags to
 * index.html's head, and each public page from its shell (web/src/site.tsx),
 * so a new card is a change here alone. Today it is the logo on paper, a
 * square, so X shows a `summary` card; a wide picture would be
 * `summary_large_image`. */
export const SHARE_CARD = {
  image: 'https://notes.yourversionnumber.com/brand/release-notes-paper-512.png',
  alt: 'The Release Notes mark: a blue V and an orange dot over two lines',
  twitterCard: 'summary'
} as const;

/** The card's tags, in order, as [attribute, name, content]. */
export const shareTags = (): [attribute: 'property' | 'name', name: string, content: string][] => [
  ['property', 'og:image', SHARE_CARD.image],
  ['property', 'og:image:alt', SHARE_CARD.alt],
  ['name', 'twitter:card', SHARE_CARD.twitterCard],
  ['name', 'twitter:image', SHARE_CARD.image],
  ['name', 'twitter:image:alt', SHARE_CARD.alt]
];

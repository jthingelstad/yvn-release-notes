// The public pages (site/, drawn by web/src/site.tsx) as a row of links, at
// the foot of the front page and of each of those pages. Plain links, never
// the router's: each is a page of its own, outside the app.
export const SITE_LINKS = [
  ['/how-it-works/', 'How it works'],
  ['/guide/', 'Guide'],
  ['/faq/', 'FAQ'],
  ['/privacy/', 'Privacy']
] as const;

export function SiteLinks({ current = '', hidden, id }: { current?: string; hidden?: boolean; id?: string }) {
  return (
    <nav className="site-links" aria-label="About Release Notes" id={id} hidden={hidden}>
      {SITE_LINKS.map(([href, name]) => (
        <a key={href} href={href} aria-current={current.startsWith(href) ? 'page' : undefined}>
          {name}
        </a>
      ))}
    </nav>
  );
}

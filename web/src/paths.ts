// Every page's address and title. The build writes index.html into each
// one's folder too, with that title (vite.config.ts), since the web bucket
// serves /today/ from today/index.html (CloudFront's index function, and
// scripts/dev_server.py, do as a static host does).
export const PAGES = [
  ['/', ''],
  ['/signin/', 'Sign in'],
  ['/setup/', 'Set up'],
  ['/settings/', 'Settings'],
  ['/today/', 'Today'],
  ['/timeline/', 'Timeline'],
  ['/day/', 'Another day'],
  ['/pause/', 'Pause'],
  ['/delete/', 'Delete account'],
  ['/tag/', 'Tags'],
  ['/search/', 'Search'],
  ['/unsubscribe/', 'Unsubscribe']
] as const;

export type PagePath = (typeof PAGES)[number][0];

export const titleOf = (title: string) => (title ? `${title}: Release Notes` : 'Release Notes');

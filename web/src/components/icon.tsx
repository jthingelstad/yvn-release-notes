// Small local line icons. Text beside every control supplies its accessible name.
export type IconName = 'today' | 'archive' | 'upcoming' | 'search' | 'settings' | 'files' | 'record' | 'where' | 'out';
const paths: Record<IconName, string> = {
  today: 'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h3',
  archive: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4',
  upcoming: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M9 15h6 M12 12v6',
  search: 'M17 17l4 4 M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  files: 'M8 13l7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9 M6 15l9-9',
  record: 'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  where: 'M12 22s8-9 8-14a8 8 0 1 0-16 0c0 5 8 14 8 14 M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  out: 'M9 3H4v18h5 M11 12h11 M17 7l5 5-5 5'
};
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}

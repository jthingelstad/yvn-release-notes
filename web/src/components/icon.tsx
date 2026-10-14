// Lucide glyphs are bundled locally, with a fixed import list so unused icons
// stay out of the build. The surrounding control supplies its accessible name.
import {
  Archive,
  Cake,
  CalendarDays,
  CalendarPlus,
  LogOut,
  MapPin,
  Mic,
  NotebookPen,
  Paperclip,
  PartyPopper,
  Pencil,
  Plane,
  Search,
  Settings,
  SquarePen,
  Trash2
} from 'lucide-react';

const icons = {
  today: NotebookPen,
  archive: Archive,
  upcoming: CalendarPlus,
  search: Search,
  settings: Settings,
  files: Paperclip,
  record: Mic,
  where: MapPin,
  out: LogOut,
  edit: Pencil,
  delete: Trash2,
  write: SquarePen,
  birthday: Cake,
  anniversary: PartyPopper,
  trip: Plane,
  event: CalendarDays
};
export type IconName = keyof typeof icons;

export function Icon({ name }: { name: IconName }) {
  const Glyph = icons[name];
  return <Glyph className="icon" strokeWidth={1.75} aria-hidden="true" focusable="false" />;
}

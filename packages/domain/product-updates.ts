/** Product news travels in the daily email, separately from anyone's notes.
 * One immutable scheduled snapshot per subscriber-local date; no catch-up mail.
 * Drafts contain plain text and named links, never markup or attachments. */
import type { Link } from '../backend/links.ts';
export const UPDATE_LABEL = 'Release Notes about Release Notes';
export const UPDATE_TITLE_MAX = 120,
  UPDATE_TEXT_MAX = 2000;
export interface ProductUpdate {
  id: string;
  title: string;
  text: string;
  links: Link[];
  revision: number;
  status: 'draft' | 'scheduled';
  date: string | null;
  created_at: string;
  updated_at: string;
}

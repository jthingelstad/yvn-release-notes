// Words for Upcoming kinds and API problems, shared by the list and the text editor.
import type { UpcomingKind } from '../../../packages/domain/upcoming.ts';

export const NAMES: Record<UpcomingKind, string> = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  trip: 'Trip',
  event: 'One-time event'
};
export const PROBLEMS: Record<string, string> = {
  'upcoming-title': 'Add a name or title, up to 120 characters, on one line.',
  'upcoming-tag': 'Use one tag, up to 50 characters, with letters, numbers and hyphens. For example, #sps.',
  'upcoming-date': 'Choose a valid date.',
  'upcoming-year': 'Use a valid original year and date, no later than today. You can leave the year empty.',
  'upcoming-end': 'Choose an end date on or after the start date.',
  'upcoming-place': 'Choose a destination from the city search.',
  'upcoming-reminders': 'Use up to six different numbers from 0 to 365. Zero means on the day.',
  'upcoming-changed':
    'This entry changed in another window. Reload the list and choose Edit again to use the latest version.',
  'upcoming-conflict':
    'Couldn’t save. Reload the list: this entry may have changed, or you may have reached 200 saved dates.',
  'upcoming-missing': 'This entry was removed in another window. Reload the list.',
  'upcoming-limit': 'That would be more than 200 saved dates. Remove some first.',
  'places-failed': 'The city search isn’t answering. Try again shortly.'
};
export const problemFor = (error?: string) => PROBLEMS[error ?? ''] ?? 'Couldn’t save this date. Please try again.';

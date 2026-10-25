// Release Notes comes with a Weekly Thing subscription (AGENTS.md,
// Subscribers and accounts). The server asks the Librarian and can add the
// signed-in address; these links say what the Weekly Thing is and what
// membership is. The ref names Release Notes in the Weekly Thing's sources.
import { api } from './api.ts';
import type { WeeklyThing } from './types.ts';

export const WEEKLY_THING_URL = 'https://weekly.thingelstad.com/?ref=release-notes';
export const MEMBERS_URL = 'https://weekly.thingelstad.com/members/';

/** Adds this session's verified address to the Weekly Thing through the
 * Librarian, or sends its confirmation email again (POST /api/me/weekly-thing). */
export const subscribeWeeklyThing = () => api<{ weekly_thing: WeeklyThing }>('POST', '/api/me/weekly-thing');

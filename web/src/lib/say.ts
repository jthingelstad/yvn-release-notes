// What the pages say for each error the API (or the page) gives.
import { COMMENTARY_PER_RELEASE, MAX_PHOTOS, MAX_TITLE } from '../../../packages/book/limits.ts';
import { MEMBERS_URL } from './weekly-thing.ts';

// A line: text, or strings and links. A link with `back` comes back to this
// page after signing in again.
export interface LinkPart {
  href: string;
  text: string;
  back?: boolean;
}
export type Line = string | (string | LinkPart)[];

export const SAY: Record<string, Line> = {
  email: 'That doesn’t look like an email address.',
  limited: 'That’s a lot of sign-in emails for one hour. Try again a little later.',
  'mail-failed': 'We couldn’t send the email just now. Try again in a minute.',
  turnstile: 'We couldn’t check that a person asked for this email. Reload the page and try again.',
  'email-and-code': 'Type the six digits from the email.',
  'wrong-code': 'That code doesn’t match.',
  'too-many-tries': 'Too many wrong codes. Send yourself a new one.',
  'code-expired': 'That code has expired. Send yourself a new one.',
  'code-used': 'That code has been used. Send yourself a new one.',
  'link-used-or-expired': 'This link has been used or has expired. Links work once, for 15 minutes.',
  network: 'Couldn’t reach Release Notes. Check your connection and try again.',
  birthday: 'Type your birthday: a real date, not in the future.',
  place: 'Pick your city from the list.',
  'send-time': 'Pick a time for your email.',
  transcribe: 'That didn’t save. Try again.',
  describe: 'That didn’t save. Try again.',
  here: 'That didn’t save. Try again.',
  'places-failed': 'The city search isn’t answering. Try again in a minute.',
  token: ['This link isn’t one we sent. ', { href: '/#sign-in', text: 'Sign in to manage your emails' }, '.'],
  origin: 'That came from outside notes.yourversionnumber.com. Open Release Notes there and try again.',
  date: 'Pick a day between your birthday and today.',
  text: 'Write something first.',
  'too-long': 'That’s longer than one note can hold. Split it in two.',
  'too-large': 'That’s longer than one note can hold. Split it in two.',
  note: 'That note isn’t here any more. Reload the page.',
  days: 'Pick how long to pause.',
  through: 'Pick a day within the next 60.',
  stopped: 'Your emails are stopped. Start them again in settings first.',
  'delete-failed': 'Couldn’t delete everything just now. Nothing is lost; try again in a minute.',
  query: 'Type a word to look for.',
  'query-too-long': 'That’s more than one search takes. Try fewer words.',
  'file-type': 'isn’t a photo, recording or PDF, so it can’t be added.',
  'file-size': 'is empty.',
  'file-too-big': 'is over 50 MB, more than one file can be.',
  upload: 'didn’t finish sending. Try again.',
  'photo-decode': 'This browser can’t open that picture. Try a JPEG or PNG.',
  'photo-small': 'That picture is too small for a profile photo. Pick one at least 128 pixels across.',
  'photo-type': 'That isn’t a photo this page made. Try again.',
  'photo-too-big': 'That photo came out too large to keep. Try another.',
  'photo-size': 'That photo isn’t the shape this page makes. Try again.',
  photo: 'There’s no profile photo yet.',
  'try-again': 'That didn’t save. Try again.',
  'token-fields': 'Name the token and tick what it may do.',
  'token-name': 'Name the token in up to 40 characters.',
  'token-name-taken': 'You already have a token with that name. Pick another.',
  'token-scopes': 'Tick what the token may do.',
  'token-expiry': 'Pick when the token expires.',
  'token-limit': 'That’s 20 tokens, the most an account can have. Revoke one first.',
  'token-gone': 'That token is already gone. Reload the page.',
  'too-many-files': 'A note holds up to 20 files.',
  'upload-limit': 'That’s more files than one day takes. Try again tomorrow.',
  busy: 'That note just changed. Reload the page and try again.',
  microphone:
    'Release Notes can’t use the microphone. Allow it for this site in your browser’s settings, then try again.',
  location: 'Couldn’t tell where you are just now. Try again, or pick a city.',
  'location-denied':
    'Release Notes can’t use your location. Allow it for this site in your browser’s settings, then try again.',
  'place-unnamed': 'Couldn’t find a city for where you are. Pick one instead.',
  'weekly-thing': 'Release Notes comes with the Weekly Thing, and this address isn’t subscribed yet.',
  'weekly-thing-unconfirmed':
    'Your Weekly Thing subscription isn’t confirmed yet. Open the email it sent you, confirm, then try again.',
  'weekly-thing-busy': 'Couldn’t reach the Weekly Thing just now. Try again in a minute.',
  'weekly-thing-review':
    'The Weekly Thing’s list is holding this address for review, so it isn’t subscribed yet. If it’s yours, email jamie@thingelstad.com.',
  'weekly-thing-by-hand':
    'This address was on the Weekly Thing before and can’t be added again automatically. Email jamie@thingelstad.com to be added by hand.',
  'weekly-thing-off': 'The Weekly Thing isn’t asked about here. Try again later.',
  'book-page': 'Pick a page size: 6 by 9 inches or US Letter.',
  'book-empty': 'There are no notes in those days.',
  'book-photos': `Those days have more photos than one book holds (${MAX_PHOTOS.toLocaleString('en-US')}). Pick fewer days.`,
  'book-failed': 'Couldn’t start the book just now. Try again in a minute.',
  'book-commentary-members': [
    'Commentary by Claude is for Weekly Thing Supporting Members, whose membership goes 100% to a nonprofit. ',
    { href: MEMBERS_URL, text: 'Become a Supporting Member' },
    '.'
  ],
  'book-commentary-days': 'Claude comments on up to a year of days at once. Pick fewer days, or leave it off.',
  'book-commentary-left': `That’s this release’s ${COMMENTARY_PER_RELEASE} books with commentary. More come with your birthday.`,
  title: `A title is one line of at most ${MAX_TITLE} characters.`
};

const FALLBACK = 'Something went wrong. Try again.';

// Signed out mid-write (the session ran out in another tab, or a sign-out
// elsewhere). `draft` says what happened to what was being written: 'kept'
// (the note form keeps it in this tab) or 'copy' (an edit, which doesn't).
export function signedOutLine(draft?: 'kept' | 'copy'): Line {
  const again = (text: string): LinkPart => ({ href: '/#sign-in', text, back: true });
  if (draft === 'kept') return ['You’ve been signed out. Your note is kept here; ', again('sign in again'), '.'];
  if (draft === 'copy')
    return ['You’ve been signed out. ', again('Sign in again'), '; copy your note first if you were writing one.'];
  return ['You’ve been signed out. ', again('Sign in again'), '.'];
}

export interface Problem {
  error?: string;
  // The file it is about, when it is about one.
  file?: string;
  draft?: 'kept' | 'copy';
  tries_left?: number;
}

// What to say for a problem. An error about one file starts with its name,
// and a wrong code says how many tries are left.
export function sayFor(p: Problem, fallback: Line = FALLBACK): Line {
  if (p.error === 'signed-out') return signedOutLine(p.draft);
  const said = (p.error && SAY[p.error]) || fallback;
  if (typeof said !== 'string') return said;
  let text = p.file && /^[a-z]/.test(said) ? `${p.file} ${said}` : said;
  if (p.error === 'wrong-code' && p.tries_left !== undefined) {
    text += p.tries_left === 1 ? ' One try left.' : ` ${p.tries_left} tries left.`;
  }
  return text;
}

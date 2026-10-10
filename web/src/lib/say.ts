// What the pages say for each error the API (or the page) gives.

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
  'too-many-files': 'A note holds up to 20 files.',
  'upload-limit': 'That’s more files than one day takes. Try again tomorrow.',
  busy: 'That note just changed. Reload the page and try again.',
  microphone:
    'Release Notes can’t use the microphone. Allow it for this site in your browser’s settings, then try again.'
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

// What the shared pieces draw.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ownMorning, type Morning } from '../lib/sample.ts';
import type { Note } from '../lib/types.ts';
import { MEMBERS_URL, WEEKLY_THING_URL } from '../lib/weekly-thing.ts';
import { LineText, placeOf, splitHref } from './common.tsx';
import { StreakLine } from './days.tsx';
import { mapHref, Marked, NoteBody, NoteMeta, NoteMoment, noteText } from './notes.tsx';
import { Tour } from './tour.tsx';
import { answered } from './where.tsx';

afterEach(cleanup);

describe('NoteMeta agent provenance', () => {
  it.each(['Claude', 'ChatGPT', 'Codex'])('shows the connected %s name', (client) => {
    const { container } = render(
      <NoteMeta
        n={{ id: 'a-1', source: 'agent', author: 'assistant', client, text: '' }}
        day="2026-10-06"
        tz="America/Chicago"
        cls="meta"
      />
    );
    expect(container.textContent).toBe(`added by ${client}`);
  });
});

describe('NoteMoment', () => {
  const n: Note = {
    id: 't-1',
    source: 'api',
    text: 'A walk',
    moment: {
      items: [
        { kind: 'workout', activity: 'cycling', distance_m: 32000, duration_s: 3600 },
        { kind: 'song', title: '<b>A Song</b>', artist: 'A Band' },
        { kind: 'people', names: ['Ana', 'Ben'] }
      ]
    }
  };

  it('draws a quiet line a piece, each with its glyph, as text', () => {
    const { container } = render(<NoteMoment n={n} miles={true} />);
    const lines = [...container.querySelectorAll('.moment li')].map((li) => li.textContent);
    expect(lines).toEqual(['Ride · 19.9 mi · 1 hr', '<b>A Song</b> · A Band', 'With Ana and Ben']);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelectorAll('.moment li svg[aria-hidden="true"]').length).toBe(3);
    expect(container.querySelector('.moment')?.getAttribute('aria-label')).toBe('Moment');
  });

  it('uses kilometres away from miles, and draws nothing for a note without one', () => {
    expect(render(<NoteMoment n={n} miles={false} />).container.textContent).toContain('Ride · 32 km · 1 hr');
    cleanup();
    expect(render(<NoteMoment n={{ ...n, moment: undefined }} miles={true} />).container.innerHTML).toBe('');
  });
});

describe('mapHref', () => {
  it('opens our map on the note, the day and id in the #', () => {
    const href = mapHref('2026-10-06', 'w-a&b');
    expect(href).toBe('/map/#d=2026-10-06&n=w-a%26b');
    expect(splitHref(href)).toEqual({ to: '/map/', search: {}, hash: 'd=2026-10-06&n=w-a%26b' });
  });
});

describe('StreakLine', () => {
  const line = (current: number, longest: number, today: boolean) =>
    render(<StreakLine s={{ current, longest, today }} />).container.textContent;

  it('starts with no streak', () => {
    expect(line(0, 0, false)).toBe('Every note starts a streak.');
    expect(line(0, 4, false)).toBe('Every note starts a streak. Your longest is 4 days.');
  });

  it('says a longest yet only once today counts', () => {
    expect(line(5, 5, true)).toBe('5 days in a row, your longest yet.');
    expect(line(5, 5, false)).toBe('5 days in a row. A note today makes it 6.');
    expect(line(2, 9, true)).toBe('2 days in a row. Your longest is 9 days.');
    expect(line(1, 1, true)).toBe('1 day in a row.');
  });
});

describe('NoteBody', () => {
  const note = (more: Partial<Note>): Note => ({ id: 'w-1', source: 'web', text: '', ...more });

  it('draws text as text, never as markup', () => {
    const { container } = render(<NoteBody n={note({ text: '<img src=x onerror=alert(1)> & <b>hi</b>' })} />);
    expect(container.querySelector('img, b')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> & <b>hi</b>');
  });

  it('shows links by name from the parts, and only http(s) ones', () => {
    const { container } = render(
      <NoteBody
        n={note({
          text: 'see https://example.com/a and javascript:alert(1)',
          parts: [
            'see ',
            { url: 'https://example.com/a', label: 'A page', site: 'Example' },
            ' and ',
            { url: 'javascript:alert(1)', label: 'bad' }
          ]
        })}
      />
    );
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/a');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0].textContent).toBe('A page');
    expect(container.textContent).toBe('see A page · Example and ');
  });

  it('lets the words set their own direction, so a right-to-left note reads as typed', () => {
    const { container } = render(<NoteBody n={note({ text: 'שלום עולם #שלום' })} />);
    expect(container.querySelector('p')!.getAttribute('dir')).toBe('auto');
  });

  it('links bare addresses when there are no parts', () => {
    const { container } = render(<NoteBody n={note({ text: 'read https://www.example.com/x/.' })} />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://www.example.com/x/');
    expect(container.textContent).toBe('read example.com/x.');
  });

  it('draws a rich note as paragraphs, lists and quotes, with bold, italic and links', () => {
    const { container } = render(
      <NoteBody
        mark={/(lake)/i}
        n={note({
          markup: 'rich',
          text: 'unused: parts win',
          parts: [
            'A **long** day at the *lake*, <b>raw</b>.\n\n- towels\n- paddles\n\n3. three\n\n> see ',
            { url: 'https://example.com/a', label: 'A page' },
            ' and _this_'
          ]
        })}
      />
    );
    const body = container.firstElementChild!;
    expect(body.className).toBe('text rich');
    expect([...body.children].map((e) => e.tagName)).toEqual(['P', 'UL', 'OL', 'BLOCKQUOTE']);
    expect(body.querySelector('strong')!.textContent).toBe('long');
    expect(body.querySelector('em mark')!.textContent).toBe('lake');
    expect(body.querySelector('b')).toBeNull();
    expect(body.querySelector('p')!.textContent).toBe('A long day at the lake, <b>raw</b>.');
    expect([...body.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['towels', 'paddles', 'three']);
    expect(body.querySelector('ol')!.getAttribute('start')).toBe('3');
    expect(body.querySelector('blockquote a')!.getAttribute('href')).toBe('https://example.com/a');
    expect(body.querySelector('blockquote em')!.textContent).toBe('this');
  });

  it('keeps a plain note’s stars and dashes as typed', () => {
    const { container } = render(
      <NoteBody n={note({ text: '**not bold**\n- not a list', parts: ['**not bold**\n- not a list'] })} />
    );
    expect(container.querySelector('strong, ul')).toBeNull();
    expect(container.textContent).toBe('**not bold**\n- not a list');
  });

  it('reads a rich note’s own text while it has no parts yet', () => {
    const { container } = render(
      <NoteBody n={note({ markup: 'rich', text: '**Saved** at https://www.example.com/x.' })} />
    );
    expect(container.querySelector('strong')!.textContent).toBe('Saved');
    expect(container.querySelector('a')!.getAttribute('href')).toBe('https://www.example.com/x');
    expect(container.textContent).toBe('Saved at example.com/x.');
  });

  it('says what a note without words holds', () => {
    expect(noteText(note({ source: 'email' }))).toBe('Attachments only. They are in the original email.');
    expect(noteText(note({}))).toBe('Nothing written.');
    expect(noteText(note({ media: [{ n: 0, kind: 'image', type: 'image/jpeg' }] }))).toBe('');
  });
});

describe('Marked', () => {
  it('marks what a search found', () => {
    const { container } = render(<Marked text="A canoe, two Canoes" mark={/(canoe)/i} />);
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['canoe', 'Canoe']);
    expect(container.textContent).toBe('A canoe, two Canoes');
  });
});

describe('answered', () => {
  it('is the day changed, and Today only while it is that day', () => {
    expect(answered(['day', '2026-09-12'], undefined, '2026-09-12')).toBe(true);
    expect(answered(['day', '2026-09-13'], undefined, '2026-09-12')).toBe(false);
    expect(answered(['today'], { date: '2026-09-12' }, '2026-09-12')).toBe(true);
    expect(answered(['today'], { date: '2026-10-12' }, '2026-09-12')).toBe(false);
    expect(answered(['days'], undefined, '2026-09-12')).toBe(false);
  });
});

describe('placeOf', () => {
  it('marks the tab, or the header search, each page belongs to', () => {
    const places = Object.fromEntries(
      [
        '/today/',
        '/timeline/',
        '/day/',
        '/release/',
        '/map/',
        '/upcoming/',
        '/search/',
        '/tag/',
        '/you/',
        '/badges/',
        '/activity/',
        '/settings/',
        '/connect/',
        '/pause/',
        '/delete/',
        '/admin/',
        '/admin-users/',
        '/book/'
      ].map((p) => [p, placeOf(p)])
    );
    expect(places).toEqual({
      '/today/': '/today/',
      '/timeline/': '/timeline/',
      '/day/': '/timeline/',
      '/release/': '/timeline/',
      '/map/': '/map/',
      '/upcoming/': '/upcoming/',
      '/search/': '/search/',
      '/tag/': '/search/',
      '/you/': '/you/',
      '/badges/': '/you/',
      '/activity/': '/you/',
      '/settings/': '/you/',
      '/connect/': '/you/',
      '/pause/': '/you/',
      '/delete/': '/you/',
      '/admin/': '/you/',
      '/admin-users/': '/you/',
      '/book/': '/book/'
    });
    // On a phone a book is the Archive's: the tab bar has no place for it.
    expect(placeOf('/book/', false)).toBe('/timeline/');
    expect(placeOf('/map/', false)).toBe('/map/');
  });
});

describe('the Weekly Thing', () => {
  it('links a line to another site whole, in a new tab', () => {
    const { container } = render(<LineText line={['See ', { href: WEEKLY_THING_URL, text: 'the Weekly Thing' }]} />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe(WEEKLY_THING_URL);
    expect(a.target).toBe('_blank');
    expect(WEEKLY_THING_URL).toContain('ref=release-notes');
  });

  it('closes the tour with how to subscribe and what membership is', () => {
    const { container } = render(<Tour hidden={false} />);
    const hrefs = [...container.querySelectorAll('#tour-free ~ p a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([WEEKLY_THING_URL, MEMBERS_URL]);
    expect(container.textContent).toContain('Free with the Weekly Thing.');
  });
});

describe('the tour’s sample email', () => {
  const text = (morning?: Morning) => {
    const { container } = render(<Tour hidden={false} morning={morning} />);
    const say = (id: string) => container.querySelector(`#${id}`)!.textContent!.replace(/\s+/g, ' ').trim();
    return { say, all: container.querySelector('#sample')!.textContent! };
  };

  it('is a made-up morning at 5.2.113 before a birthday is typed', () => {
    const { say, all } = text();
    expect(say('sample-cap')).toBe('A morning’s email');
    expect(say('sample-v')).toBe('5.2.113');
    expect(say('sample-day')).toBe('Tuesday, October 27');
    expect(say('sample-next')).toBe('5.3.0 ships in 252 days.');
    expect(all).toContain('5.1.113 First snow.');
    expect(all).toContain('5.0.113 Started the new job.');
    expect(say('sample-note')).toBe('A made-up morning. Yours fills in from your own notes.');
  });

  it('is drawn with the visitor’s own number once a birthday is typed', () => {
    const sample = { version: '4.5.137', age: '45', next: { version: '4.6.0', date: '2027-06-14', days: 228 } };
    const { say, all } = text(ownMorning('1981-06-14', sample)!);
    expect(say('sample-cap')).toBe('Your morning’s email');
    expect(say('sample-v')).toBe('4.5.137');
    expect(say('sample-day')).toBe('Thursday, October 29');
    expect(say('sample-next')).toBe('4.6.0 ships in 228 days.');
    expect(all).toContain('becomes the release notes for 4.5.137.');
    expect(all).toContain('Reply today and 4.5.137 makes it 13.');
    expect(all).toContain('4.4.137 First snow.');
    expect(all).toContain('4.3.137 Started the new job.');
    expect(all).not.toContain('5.2.113');
    expect(say('sample-note')).toMatch(
      /^Your number, your day and your own patches\. The notes, the weather and the streak are made up/
    );
  });

  it('leaves out On this day before a second release', () => {
    const sample = { version: '0.0.0', age: '0', next: { version: '0.1.0', date: '2027-10-29', days: 365 } };
    const { all } = text(ownMorning('2026-10-29', sample)!);
    expect(all).not.toContain('On this day');
    expect(all).toContain('0.1.0 ships in 365 days.');
  });
});

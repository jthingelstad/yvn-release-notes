// What the shared pieces draw.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Note } from '../lib/types.ts';
import { placeOf } from './common.tsx';
import { StreakLine } from './days.tsx';
import { Marked, NoteBody, NoteMeta, noteText } from './notes.tsx';
import { answered } from './where.tsx';

afterEach(cleanup);

describe('NoteMeta agent provenance', () => {
  it.each(['Claude', 'ChatGPT', 'Codex'])('shows the connected %s name', (client) => {
    const { container } = render(
      <NoteMeta
        n={{ id: 'a-1', source: 'agent', author: 'assistant', client, text: '' }}
        tz="America/Chicago"
        cls="meta"
      />
    );
    expect(container.textContent).toBe(`added by ${client}`);
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

  it('links bare addresses when there are no parts', () => {
    const { container } = render(<NoteBody n={note({ text: 'read https://www.example.com/x/.' })} />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://www.example.com/x/');
    expect(container.textContent).toBe('read example.com/x.');
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
        '/admin-users/'
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
      '/admin-users/': '/you/'
    });
  });
});

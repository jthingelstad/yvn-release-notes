// What the shared pieces draw.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Note } from '../lib/types.ts';
import { StreakLine } from './days.tsx';
import { Marked, NoteBody, noteText } from './notes.tsx';

afterEach(cleanup);

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

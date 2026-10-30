import { describe, expect, it } from 'vitest';
import { applied, keyMark, lines, wrap, type Edit } from './markup.ts';

// The text after an edit, with the selection as [ and ].
const after = (text: string, e: Edit) => {
  const t = applied(text, e);
  return t.slice(0, e.start) + '[' + t.slice(e.start, e.end) + ']' + t.slice(e.end);
};
const at = (marked: string) => {
  const start = marked.indexOf('['),
    end = marked.indexOf(']') - 1;
  return { text: marked.replace('[', '').replace(']', ''), start, end };
};
const run = (marked: string, make: (t: string, s: number, e: number) => Edit) => {
  const { text, start, end } = at(marked);
  return after(text, make(text, start, end));
};

describe('bold and italic', () => {
  const bold = (t: string, s: number, e: number) => wrap(t, s, e, 'strong'),
    italic = (t: string, s: number, e: number) => wrap(t, s, e, 'em');

  it('wraps the selection, leaving its spaces outside', () => {
    expect(run('a [long ]day', bold)).toBe('a **[long]** day');
    expect(run('a [lake] day', italic)).toBe('a *[lake]* day');
  });

  it('puts in a pair with the caret between when nothing is selected', () => {
    expect(run('a []', bold)).toBe('a **[]**');
  });

  it('takes the marks off again, inside or outside the selection', () => {
    expect(run('a **[long]** day', bold)).toBe('a [long] day');
    expect(run('a [**long**] day', bold)).toBe('a [long] day');
    expect(run('a *[lake]* day', italic)).toBe('a [lake] day');
  });

  it('tells bold from italic', () => {
    expect(run('a **[long]** day', italic)).toBe('a ***[long]*** day');
    expect(run('a ***[both]*** day', italic)).toBe('a **[both]** day');
    expect(run('a *[lake]* day', bold)).toBe('a ***[lake]*** day');
  });
});

describe('lists and quotes', () => {
  it('marks every line the selection touches, numbering in order and skipping blank lines', () => {
    expect(run('[towels\npaddles\n\nbag]', (t, s, e) => lines(t, s, e, 'numbers'))).toBe(
      '[1. towels\n2. paddles\n\n3. bag]'
    );
    expect(run('Packed:\nto[wels\npad]dles', (t, s, e) => lines(t, s, e, 'bullets'))).toBe(
      'Packed:\n[- towels\n- paddles]'
    );
  });

  it('takes the marks off when every line has them, and swaps one kind for another', () => {
    expect(run('[- towels\n- paddles]', (t, s, e) => lines(t, s, e, 'bullets'))).toBe('[towels\npaddles]');
    expect(run('[- towels\n2. paddles]', (t, s, e) => lines(t, s, e, 'quote'))).toBe('[> towels\n> paddles]');
  });

  it('starts a list on an empty line with the caret after its mark', () => {
    expect(run('Packed:\n[]', (t, s, e) => lines(t, s, e, 'bullets'))).toBe('Packed:\n- []');
  });
});

describe('keys', () => {
  const key = (k: string, more: Partial<Parameters<typeof keyMark>[0]> = {}) =>
    keyMark({ key: k, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...more });
  it('reads ⌘B and ⌘I, or Ctrl, and nothing else', () => {
    expect(key('b')).toBe('strong');
    expect(key('I')).toBe('em');
    expect(key('b', { metaKey: false, ctrlKey: true })).toBe('strong');
    expect(key('b', { shiftKey: true })).toBeNull();
    expect(key('u')).toBeNull();
    expect(key('b', { metaKey: false })).toBeNull();
  });
});

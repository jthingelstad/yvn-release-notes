// The formatting row under a note's box (docs/RICH-TEXT.md): bold, italic,
// a list, a numbered list and a quote, put in as the marks they are typed
// as, and a line on how to type them. ⌘B and ⌘I (Ctrl on other systems) do
// bold and italic from the keyboard.
import { useState, type KeyboardEvent, type RefObject } from 'react';
import { applied, keyMark, lines, wrap, type Edit } from '../lib/markup.ts';
import { Icon, type IconName } from './icon.tsx';

type Box = RefObject<HTMLTextAreaElement | null>;

// An edit made as typing is, so the browser's Undo takes it back; where it
// can't be (a test's DOM), the text is set instead.
function put(el: HTMLTextAreaElement | null, text: string, e: Edit, onText: (t: string) => void) {
  const next = applied(text, e);
  if (el) {
    el.focus();
    el.setSelectionRange(e.from, e.to);
    const typed = typeof document.execCommand === 'function' && document.execCommand('insertText', false, e.insert);
    if (!typed || el.value !== next) onText(next);
    requestAnimationFrame(() => el.setSelectionRange(e.start, e.end));
  } else onText(next);
}

function run(area: Box, text: string, onText: (t: string) => void, make: (s: number, e: number) => Edit) {
  const el = area.current;
  put(el, text, make(el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length), onText);
}

// The box's keys: ⌘B and ⌘I.
export function formatKey(e: KeyboardEvent<HTMLTextAreaElement>, area: Box, text: string, onText: (t: string) => void) {
  const mark = keyMark(e);
  if (!mark) return;
  e.preventDefault();
  run(area, text, onText, (s, en) => wrap(text, s, en, mark));
}

const BUTTONS: { name: IconName; label: string; make: (t: string, s: number, e: number) => Edit }[] = [
  { name: 'bold', label: 'Bold', make: (t, s, e) => wrap(t, s, e, 'strong') },
  { name: 'italic', label: 'Italic', make: (t, s, e) => wrap(t, s, e, 'em') },
  { name: 'bullets', label: 'List', make: (t, s, e) => lines(t, s, e, 'bullets') },
  { name: 'numbers', label: 'Numbered list', make: (t, s, e) => lines(t, s, e, 'numbers') },
  { name: 'quote', label: 'Quote', make: (t, s, e) => lines(t, s, e, 'quote') }
];

export function FormatBar({
  area,
  text,
  onText,
  disabled = false
}: {
  area: Box;
  text: string;
  onText: (t: string) => void;
  disabled?: boolean;
}) {
  const [help, setHelp] = useState(false);
  return (
    <div className="format-bar">
      <div className="row" role="group" aria-label="Formatting">
        {BUTTONS.map((b) => (
          <button
            key={b.name}
            className="quiet icon-button"
            type="button"
            aria-label={b.label}
            disabled={disabled}
            // Keep the box's selection: the button acts on it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(area, text, onText, (s, e) => b.make(text, s, e))}
          >
            <Icon name={b.name} />
          </button>
        ))}
        <button className="quiet format-how" type="button" aria-expanded={help} onClick={() => setHelp(!help)}>
          How to format
        </button>
      </div>
      <p className="hint" hidden={!help}>
        Two stars around words make them bold (**like this**), one makes them italic (*like this*), or press ⌘B and ⌘I.
        A line that starts with - or 1. is a list, and &gt; makes a quote. A star with a space after it, or inside a
        word, stays a star.
      </p>
    </div>
  );
}

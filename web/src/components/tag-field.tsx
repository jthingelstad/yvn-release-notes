// The tags field (docs/TAGS.md; Jamie, 2026-11-08): a note's, an Upcoming
// date's, a check-in's or a remembered place's tags as chips, each with its
// own remove button, and a box to type one more. Enter, Tab or leaving the box
// adds what is typed; a leading # is dropped, and spaces and emoji are kept
// ("Road Trip", "🚗 Lake"). It refuses a tag over 50 characters, a 21st tag,
// commas and line breaks, saying why (call 4). A tag already there by any
// spelling is left as it is. What a chip's removal does is the page's: a
// note's #words leave its text too (call 1).
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { adding, TAG_SAY, type Tag } from '../lib/tags.ts';
import { ErrorLine } from './common.tsx';
import { Icon } from './icon.tsx';

interface Props {
  tags: readonly Tag[];
  onAdd: (tag: Tag) => void;
  onRemove: (tag: Tag) => void;
  /** Names to offer as it is typed: the tags used before. */
  offer?: readonly string[];
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** Saving the last change, on a page that saves each one: the box keeps
   * what is typed, and its focus, until it is done. */
  busy?: boolean;
}

export function TagField({
  tags,
  onAdd,
  onRemove,
  offer = [],
  label = 'Tags',
  hint,
  disabled = false,
  busy = false
}: Props) {
  const id = useId();
  const box = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // What is typed becomes a chip, or stays in the box with why not.
  const commit = (): boolean => {
    if (!typed.trim() || busy) return false;
    const r = adding(tags, typed);
    if ('refused' in r) {
      setProblem(TAG_SAY[r.refused]);
      return false;
    }
    setProblem(null);
    setTyped('');
    if (r.added) onAdd(r.added);
    return true;
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter adds the tag and never sends the form; Tab adds it and moves on,
    // unless it was refused.
    if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && typed.trim())) {
      if (e.nativeEvent.isComposing) return;
      const took = commit();
      if (e.key === 'Enter' || (!took && !busy)) e.preventDefault();
    }
  };
  const shown = offer.filter((name) => !tags.some((t) => t.name === name));
  return (
    <div className="tag-field" role="group" aria-labelledby={`${id}-label`} aria-busy={busy || undefined}>
      <label id={`${id}-label`} htmlFor={`${id}-box`}>
        {label}
      </label>
      {tags.length > 0 && (
        <ul className="tag-chips" aria-label={label}>
          {tags.map((t) => (
            <li key={t.key} className="tag-chip">
              <span dir="auto">{t.name}</span>
              <button
                type="button"
                className="quiet icon-button"
                aria-label={`Remove tag ${t.name}`}
                title="Remove"
                disabled={disabled || busy}
                onClick={() => {
                  setProblem(null);
                  onRemove(t);
                  box.current?.focus();
                }}
              >
                <Icon name="remove" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={box}
        id={`${id}-box`}
        name="tag"
        dir="auto"
        value={typed}
        autoComplete="off"
        enterKeyHint="done"
        list={shown.length ? `${id}-offer` : undefined}
        placeholder={tags.length ? 'Add another' : 'Add a tag'}
        aria-describedby={hint ? `${id}-hint` : undefined}
        aria-invalid={problem ? true : undefined}
        disabled={disabled}
        onChange={(e) => {
          setProblem(null);
          setTyped(e.target.value);
        }}
        onKeyDown={key}
        onBlur={() => void commit()}
      />
      {shown.length > 0 && (
        <datalist id={`${id}-offer`}>
          {shown.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      <ErrorLine line={problem} />
    </div>
  );
}

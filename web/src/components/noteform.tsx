// The form that adds a note to a day, with files from this device and
// recordings made here. What is being written is kept in this tab, by day,
// until it is saved, so a sign-out mid-note (or a reload) doesn't lose it.
// Once any files are sent, the note shows in the list at once ("Saving…")
// and the form empties; a write that fails puts it all back. "Where" is
// optional (where.tsx), and with "Add where I am" on, Today's form adds
// where the device is as a note is saved. Under the box, its tags as chips
// (tag-field.tsx): the ones added there, kept with the draft, and the #words
// typed in the text, whose chip takes the #word out too (Jamie's call 1). The
// tag row (tag-row.tsx) adds a pinned or recent tag or takes it off. What a
// saved note earned shows under the form (unlock.tsx).
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { browserZone } from '../lib/format.ts';
import { FILES, sendFiles } from '../lib/files.ts';
import { addPending, dropNote } from '../lib/notecache.ts';
import { store } from '../lib/storage.ts';
import type { Place, Unlocked } from '../lib/types.ts';
import { ErrorLine, useBusy, useProblem } from './common.tsx';
import { useRefresh } from './notelist.tsx';
import { canRecord, recordClock, useRecorder } from './recorder.ts';
import { RecordWave } from './recordwave.tsx';
import { Icon } from './icon.tsx';
import { UnlockLine } from './unlock.tsx';
import { NoteWhere } from './where.tsx';
import { TagRow, useTagNames } from './tag-row.tsx';
import { TagField } from './tag-field.tsx';
import { FormatBar, formatKey } from './format-bar.tsx';
import { canLocate, kept, whereAmI } from '../lib/here.ts';
import { noteChips, removingNoteTag, TAG_SAY, type Tag } from '../lib/tags.ts';
import { MAX_TAGS, mergeTags, spelling } from '../../../packages/domain/tags.ts';

interface Props {
  day: string;
  label: ReactNode;
  placeholder: string;
  submit: ReactNode;
  // Tags to start the note with, by any spelling: an Upcoming date's.
  initialTags?: readonly string[];
  // "Add where I am" (Settings): a note saved with no place gets Here's
  here?: boolean;
}

// A place waiting for a day's next note (this tab only, as a draft is).
export const carryPlace = (day: string, place: Place | null) =>
  place ? store.set(`rn-draft-place-${day}`, JSON.stringify(place)) : store.drop(`rn-draft-place-${day}`);
function carriedPlace(day: string): Place | null {
  try {
    return JSON.parse(store.get(`rn-draft-place-${day}`) ?? 'null') as Place | null;
  } catch {
    return null;
  }
}

// The tags added to a day's draft in its field, kept in this tab as its words are.
const fieldKey = (day: string) => `rn-draft-tags-${day}`;
function keptField(day: string): Tag[] {
  try {
    const names: unknown = JSON.parse(store.get(fieldKey(day)) ?? '[]');
    return Array.isArray(names) ? mergeTags(names.map(spelling).filter((t): t is Tag => typeof t !== 'string')) : [];
  } catch {
    return [];
  }
}
const keepField = (day: string, field: readonly Tag[]) =>
  field.length ? store.set(fieldKey(day), JSON.stringify(field.map((t) => t.name))) : store.drop(fieldKey(day));

// Give it a `key` of the day, so another day starts with that day's draft.
export function NoteForm({ day, label, placeholder, submit, initialTags = [], here = false }: Props) {
  const key = `rn-draft-${day}`;
  const [text, setText] = useState(() => store.get(key) || '');
  // Tags travel in the fragment, never a server-visible query or request.
  // They join the draft's, and one it has already, by any spelling, stays.
  const [field, setField] = useState<Tag[]>(() => {
    const draft = store.get(key) || '',
      had = keptField(day),
      given = initialTags.map(spelling).filter((t): t is Tag => typeof t !== 'string'),
      chips = noteChips(draft, had);
    return mergeTags(
      had,
      given.filter((t) => !chips.some((c) => c.key === t.key))
    );
  });
  const names = useTagNames();
  const [chosen, setChosen] = useState<string>('');
  // A place brought along, as "Write about this" on a check-in brings its own.
  const [place, setPlace] = useState<Place | null>(() => carriedPlace(day));
  // "Not there" on this note: it is saved with no place.
  const [notThere, setNotThere] = useState(false);
  const [locating, setLocating] = useState(false);
  // From Save until the form empties (the location, the files), the draft
  // is what is being saved, so it can't be changed: an edit then would be
  // emptied with it, unsaved.
  const [held, setHeld] = useState(false);
  // Each new note starts its "Where" over, Here's "Not there" included.
  const [round, setRound] = useState(0);
  const [won, setWon] = useState<Unlocked[]>([]);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const area = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const refresh = useRefresh();
  const client = useQueryClient();
  const { show } = problem;
  const refused = useCallback(() => show({ error: 'microphone' }, recordButton.current), [show]);
  const rec = useRecorder(refused);

  // Leaving for another page here would drop a recording not yet saved.
  useBlocker({
    shouldBlockFn: () => rec.unsaved() && !window.confirm('Your recording isn’t saved yet. Leave without it?'),
    enableBeforeUnload: false
  });

  // Typed, or a #word's chip taken off: the draft is kept as it changes.
  const write = (next: string) => {
    problem.clear();
    setText(next);
    if (next.trim()) store.set(key, next);
    else store.drop(key);
  };
  const setTags = (next: Tag[]) => {
    problem.clear();
    setField(next);
    keepField(day, next);
  };
  const chips = noteChips(text, field);
  // The field refuses a 21st tag itself; the tag row's taps are told here.
  const addTag = (t: Tag) => (chips.length >= MAX_TAGS ? problem.show(TAG_SAY.many) : setTags([...field, t]));
  const removeTag = (t: Tag) => {
    const next = removingNoteTag(text, field, t.key);
    if (next.text !== text) write(next.text);
    setTags(next.field);
  };

  const showChosen = () => {
    const names = [...(pick.current?.files || [])].map((f) => f.name);
    setChosen(names.length ? `With ${names.join(', ')}` : '');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      setWon([]);
      const files = [...(pick.current?.files || []), ...(await rec.files())];
      if (!text.trim() && !files.length) return problem.show({ error: 'text' }, area.current);
      setHeld(true);
      try {
        await save(files);
      } finally {
        setHeld(false);
      }
    });
  };
  const save = async (files: File[]) => {
    // "Add where I am" asks the browser now, as the note is saved, never
    // as the page opens (Jamie, 2026-10-24: "Do it when we know that we
    // need the location"). The note is saved without it when the browser
    // can't or won't say, and its Where can add one after.
    let at = place;
    if (!at && here && !notThere && canLocate()) {
      setLocating(true);
      const found = await whereAmI({ timeout: 10_000, cap: 20_000 }).finally(() => setLocating(false));
      if ('place' in found) at = found.place;
    }
    // The zone it is being written in, so its time reads as it did here.
    // Written here, it is rich text (docs/RICH-TEXT.md).
    const body: { text: string; tz: string; markup: 'rich'; uploads?: unknown; place?: Place; tags?: string[] } = {
      text,
      tz: browserZone(),
      markup: 'rich'
    };
    // The field's tags; the #words in the text come after them.
    const tags = field;
    if (tags.length) body.tags = tags.map((t) => t.name);
    if (at) body.place = kept(at);
    if (files.length) {
      const out = await sendFiles(files, setChosen);
      showChosen();
      if (out.problem) {
        store.set(key, text);
        return problem.show({ ...out.problem, draft: 'kept' }, pick.current);
      }
      body.uploads = out.sent;
    }
    const pending = await addPending(client, day, text);
    store.drop(key);
    keepField(day, []);
    carryPlace(day, null);
    setText('');
    setField([]);
    if (pick.current) pick.current.value = '';
    showChosen();
    rec.clear();
    setPlace(null);
    setNotThere(false);
    setRound((n) => n + 1);
    // Empty: the next note can be written while this one is sent.
    setHeld(false);
    const r = await api<{ unlocked?: Unlocked[] }>('POST', `/api/days/${day}/notes`, body);
    if (!r.ok) {
      await dropNote(client, day, pending);
      setText(text);
      store.set(key, text);
      setField(tags);
      keepField(day, tags);
      putBack(pick.current, files);
      showChosen();
      setPlace(at);
      setNotThere(notThere);
      return problem.show({ ...r.data, draft: 'kept' }, area.current);
    }
    setWon(r.data.unlocked || []);
    await refresh();
  };

  return (
    <>
      <form id="note-form" className="note-form" noValidate onSubmit={onSubmit}>
        <label className="write-label">
          <span>{label}</span>
          <textarea
            ref={area}
            name="text"
            dir="auto"
            rows={3}
            placeholder={placeholder}
            value={text}
            readOnly={held}
            onChange={(e) => write(e.target.value)}
            onKeyDown={(e) => formatKey(e, area, text, write)}
          />
        </label>
        <FormatBar area={area} text={text} onText={write} disabled={held} />
        <TagField
          tags={chips}
          offer={names}
          onAdd={addTag}
          onRemove={removeTag}
          disabled={held}
          hint="Tags can have spaces and emoji, like Road Trip. A #word in the note is a tag too."
        />
        <TagRow
          chips={chips}
          onToggle={(t) => (chips.some((c) => c.key === t.key) ? removeTag(t) : addTag(t))}
          disabled={held}
        />
        <p className="hint chosen" role="status" hidden={!chosen}>
          {chosen}
        </p>
        <div className="recordings">
          {rec.kept.map((r) => (
            <div className="recording" key={r.url}>
              <audio controls src={r.url} aria-label={r.file.name} />
              <button className="quiet" type="button" onClick={() => rec.remove(r)}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="row note-tools">
          <label className="quiet picker">
            <Icon name="files" /> Add files
            <input
              ref={pick}
              type="file"
              name="files"
              multiple
              accept={FILES}
              disabled={held}
              onChange={() => {
                problem.clear();
                showChosen();
              }}
            />
          </label>
          <button
            ref={recordButton}
            className="quiet record"
            type="button"
            aria-pressed={rec.seconds !== null}
            hidden={!canRecord()}
            disabled={held}
            onClick={() => {
              problem.clear();
              rec.toggle();
            }}
          >
            <Icon name="record" /> {rec.seconds === null ? 'Record' : `Stop · ${recordClock(rec.seconds)}`}
          </button>
          {rec.analyser && <RecordWave analyser={rec.analyser} />}
          <NoteWhere
            key={round}
            place={place}
            onPick={(next) => {
              setPlace(next);
              carryPlace(day, null);
            }}
            onProblem={show}
            onNotThere={() => setNotThere(true)}
            disabled={held}
          />
          <button className="go" type="submit" disabled={busy}>
            {submit}
          </button>
        </div>
        {locating && (
          <p className="hint" role="status">
            Finding where you are…
          </p>
        )}
        <ErrorLine line={problem.line} />
      </form>
      <UnlockLine items={won} />
    </>
  );
}

// The files a failed note was sent with, back in the picker (recordings made
// here come back as files), where the browser allows it.
function putBack(input: HTMLInputElement | null, files: File[]) {
  if (!input || !files.length) return;
  try {
    const all = new DataTransfer();
    for (const f of files) all.items.add(f);
    input.files = all.files;
  } catch {
    /* the browser keeps the picker's files to itself */
  }
}

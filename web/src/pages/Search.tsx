// Every tag, most used first, and the notes with some words. The words
// live in the address's # (#q=), so back and reload work and no server,
// CloudFront's logs included, ever sees them.
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AppLink, Bar, ErrorLine, Failed, Loading, useProblem, useTitle } from '../components/common.tsx';
import { DayList } from '../components/days.tsx';
import { ApiError, get, load } from '../lib/api.ts';
import { count } from '../lib/format.ts';
import { useHashParam } from '../lib/nav.ts';
import { sayFor, type Problem } from '../lib/say.ts';
import type { SearchResult } from '../lib/types.ts';

export function Search() {
  const navigate = useNavigate();
  const q = (useHashParam('q') || '').trim();
  useTitle(q ? `${q}: Search` : 'Search');

  const found = useQuery({
    queryKey: ['search', q],
    queryFn: () => load<SearchResult>('POST', '/api/search', { q }),
    enabled: !!q
  });
  const tags = useQuery({
    queryKey: ['tags'],
    queryFn: () => get<{ tags: { tag: string; days: number }[] }>('/api/tags')
  });
  // Words the API refuses (too many) say so at the box.
  const refused = found.error instanceof ApiError && found.error.answer.status === 400 ? found.error.answer.data : null;

  const d = found.data;
  const mark = useMemo(() => {
    if (!d?.terms.length) return null;
    const escaped = d.terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(${escaped.join('|')})`, 'gi');
  }, [d]);

  return (
    <>
      <Bar />
      <h1>Search</h1>
      {/* The box starts again from the words in the address, after back and
          forward too. */}
      <SearchForm
        key={q}
        q={q}
        refused={refused}
        search={(words) => {
          if (words === q) found.refetch();
          else navigate({ to: '/search/', hash: `q=${encodeURIComponent(words)}` });
        }}
        cleared={() => navigate({ to: '/search/' })}
      />
      <p className="hint spaced" id="search-lede" role="status" hidden={!q || !d}>
        {d &&
          (!d.notes
            ? 'No notes have all of those words.'
            : `${count(d.notes, 'note', 'notes')} on ${count(d.day_count, 'day', 'days')}` +
              (d.day_count > d.days.length
                ? `. The newest ${d.days.length} days are here; more words narrow it.`
                : '.'))}
      </p>
      {q && found.isPending && <Loading />}
      {q && found.isError && !refused && <Failed />}
      {q && d ? <DayList data={d} mark={mark} id="results" /> : <div className="days" id="results" />}

      <section id="every-tag-list" hidden={!!q}>
        <h2 className="big">Tags</h2>
        <p className="hint spaced" id="tags-lede">
          {tags.data &&
            (tags.data.tags.length
              ? 'Every hashtag in your notes. Write one, like #cabin, in an email or here, and the note has that tag.'
              : 'No tags yet. Write a hashtag, like #cabin, in a note or a reply, and it shows here.')}
        </p>
        {tags.isError && <Failed />}
        {tags.data && (
          <ul className="tags">
            {tags.data.tags.map((t) => (
              <li key={t.tag}>
                <AppLink className="tag" href={`/tag/?t=${encodeURIComponent(t.tag)}`}>
                  #{t.tag}
                </AppLink>
                <span className="hint"> {count(t.days, 'day', 'days')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function SearchForm({
  q,
  refused,
  search,
  cleared
}: {
  q: string;
  refused: Problem | null;
  search: (words: string) => void;
  cleared: () => void;
}) {
  const [text, setText] = useState(q);
  const problem = useProblem();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (refused) input.current?.focus();
  }, [refused]);

  // Clearing the box with its own × goes back to the tags. (The same event
  // comes with Enter, which the submit handles.)
  useEffect(() => {
    const box = input.current!;
    const onSearch = () => {
      if (!box.value && q) cleared();
    };
    box.addEventListener('search', onSearch);
    return () => box.removeEventListener('search', onSearch);
  }, [q, cleared]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const words = text.trim();
    if (!words) return problem.show({ error: 'query' }, input.current);
    search(words);
  };

  return (
    <form id="search-form" className="search-form" role="search" noValidate onSubmit={submit}>
      <label>
        Words in your notes
        <input
          ref={input}
          type="search"
          name="q"
          maxLength={200}
          autoComplete="off"
          enterKeyHint="search"
          placeholder={'cabin, "first snow"'}
          value={text}
          onChange={(e) => {
            problem.clear();
            setText(e.target.value);
          }}
        />
      </label>
      <button className="go" type="submit">
        Search
      </button>
      <ErrorLine line={problem.line || (refused && sayFor(refused))} />
    </form>
  );
}

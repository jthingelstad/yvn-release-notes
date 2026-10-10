// Notes as every page shows them: the words with links by name and tags,
// the photos, recordings and files, and the line saying when and how.
import { Fragment, useState, type ReactNode } from 'react';
import { absolute, LINK_MS, mediaPath } from '../lib/files.ts';
import { zoneName, zoneShortDate, zoneTime } from '../lib/format.ts';
import type { Media, Note } from '../lib/types.ts';
import { AppLink } from './common.tsx';
import { useViewer } from './viewer.tsx';

export function noteText(n: Note): string {
  if (n.text) return n.text;
  if (n.media && n.media.length) return '';
  return n.source === 'email' ? 'Attachments only. They are in the original email.' : 'Nothing written.';
}

// Text with what a search found (`mark`, a RegExp with one group) in <mark>.
export function Marked({ text, mark }: { text: string; mark?: RegExp | null }) {
  if (!mark) return <>{text}</>;
  return (
    <>
      {text
        .split(mark)
        .map((piece, i) => (piece ? i % 2 ? <mark key={i}>{piece}</mark> : <span key={i}>{piece}</span> : null))}
    </>
  );
}

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

// A note's text as a paragraph, links by name: the API's `parts` (strings,
// {url, label, site} and {tag, text}), the same as the email's
// (links.segments). Bare web addresses still link if `parts` is missing.
export function NoteBody({ n, cls = 'text', mark }: { n: Note; cls?: string; mark?: RegExp | null }) {
  const text = noteText(n);
  let body: ReactNode[];
  if (n.text && Array.isArray(n.parts)) {
    body = n.parts.map((part, i) => {
      if (typeof part === 'string') return <Marked key={i} text={part} mark={mark} />;
      if ('tag' in part) {
        // A hashtag: its tag's page (tags.py).
        return (
          <AppLink key={i} className="tag" href={`/tag/?t=${encodeURIComponent(part.tag)}`}>
            {part.text}
          </AppLink>
        );
      }
      if (/^https?:\/\//i.test(part.url || '')) {
        return (
          <span key={i}>
            <OutLink href={part.url}>{part.label || part.url}</OutLink>
            {part.site && <span className="site"> · {part.site}</span>}
          </span>
        );
      }
      return null;
    });
  } else {
    body = [];
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?'")\]}]+$/, '');
      body.push(text.slice(last, m.index));
      body.push(
        <OutLink key={m.index} href={url}>
          {url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}
        </OutLink>
      );
      last = (m.index ?? 0) + url.length;
    }
    body.push(text.slice(last));
  }
  return (
    <p className={cls} hidden={!text}>
      {body}
    </p>
  );
}

// Where a note came from, as the note's line says it.
function sourceName(n: Note): string {
  if (n.source === 'web') return 'on the web';
  if (n.source === 'import') return `from ${n.from || 'an import'}`;
  return 'by email';
}

// The time reads in the zone the note was written in (n.tz), named when it
// isn't the subscriber's own.
export function NoteMeta({ n, tz, cls }: { n: Note; tz: string; cls: string }) {
  const zone = n.tz || tz;
  let when = '';
  if (n.at) {
    when = n.late ? `${zoneShortDate(n.at, zone)}, ${zoneTime(n.at, zone)}` : zoneTime(n.at, zone);
    if (zone !== tz) {
      const name = zoneName(n.at, zone);
      if (name) when += ` ${name}`;
    }
  }
  const parts: ReactNode[] = [
    when,
    n.place && n.map ? (
      <OutLink key="place" href={n.map}>
        {n.place}
      </OutLink>
    ) : (
      n.place
    ),
    sourceName(n)
  ];
  if (n.attachments)
    parts.push(n.attachments === 1 ? '1 attachment in the email' : `${n.attachments} attachments in the email`);
  if (n.edited_at) parts.push('edited');
  return (
    <p className={cls}>
      {parts.filter(Boolean).map((x, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {x}
        </span>
      ))}
    </p>
  );
}

// One photo: a link to open it, drawn from its signed link. A plain click
// opens it over the page; a click meant for a new tab or a download still
// follows the link.
function Photo({ n, m, src, link, version }: Props & { m: Media; src: string; link: () => string }) {
  const view = useViewer();
  const [broken, setBroken] = useState(false);
  // Described for those who turned it on (describe.py).
  const alt = m.description || (version ? `Photo from ${version}` : 'Photo');
  if (broken) {
    return (
      <p className="hint">
        This photo couldn’t load. Reload, or sign in again if you’ve been signed out.
        {n.source === 'email' || !n.source ? ' It’s also in the original email.' : ''}
      </p>
    );
  }
  return (
    <a
      href={link()}
      target="_blank"
      rel="noopener noreferrer"
      {...fresh(link)}
      onClick={(e) => {
        e.currentTarget.href = link();
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !window.HTMLDialogElement) return;
        e.preventDefault();
        view({ href: link(), fallback: src, alt });
      }}
    >
      <img
        src={m.url || src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={(e) => {
          // A signed link that has run out tries the API's address once.
          // After that, a session that has run out or a HEIC outside Safari:
          // say so rather than show a broken image.
          const img = e.currentTarget;
          if (m.url && img.src !== absolute(src)) img.src = src;
          else setBroken(true);
        }}
      />
    </a>
  );
}

// A link to open: its address is checked again as it is used.
function fresh(link: () => string) {
  const update = (e: { currentTarget: HTMLAnchorElement }) => {
    e.currentTarget.href = link();
  };
  return { onPointerDown: update, onFocus: update };
}

function Recording({ src, link }: { src: string; link: () => string }) {
  // Nothing loads until play, so a link may be old by then: swap it before
  // playing, and once more if it fails anyway.
  const swap = (e: { currentTarget: HTMLAudioElement }) => {
    const audio = e.currentTarget;
    if (audio.paused && audio.currentTime === 0 && audio.src !== absolute(link())) audio.src = link();
  };
  return (
    <audio
      controls
      preload="none"
      src={link()}
      aria-label="Recording"
      onPointerDown={swap}
      onKeyDown={swap}
      onError={(e) => {
        const audio = e.currentTarget;
        if (audio.src !== absolute(src)) {
          audio.src = src;
          audio.play().catch(() => {});
        }
      }}
    />
  );
}

interface Props {
  day: string;
  n: Note;
  version?: string;
  mark?: RegExp | null;
}

// When a note's links came, by the list they came in: a refetch with new
// links is a new list (TanStack Query keeps an unchanged one as it was).
const came = new WeakMap<Media[], number>();
function cameAt(media: Media[]): number {
  let at = came.get(media);
  if (at === undefined) {
    at = Date.now();
    came.set(media, at);
  }
  return at;
}

// A note's photos, recordings and files, each from the signed link the API
// put on it. Past nine minutes, or when a link fails, they use the API's own
// address instead (files.ts).
export function NoteMedia({ day, n, version, mark }: Props) {
  if (!n.media || !n.media.length) return null;
  const given = cameAt(n.media);
  return (
    <div className="media">
      {n.media.map((m) => {
        const src = mediaPath(day, n.id, m.n);
        const link = () => (m.url && Date.now() - given < LINK_MS ? m.url : src);
        if (m.kind === 'image') {
          return (
            <Fragment key={m.n}>
              <Photo n={n} m={m} src={src} link={link} version={version} day={day} />
              {/* Shown only in search results, and only when the search found
                  it there (Jamie: "descriptions only on search results"). */}
              {mark && m.description && m.description.split(mark).length > 1 && (
                <p className="said">
                  <Marked text={m.description} mark={mark} />
                </p>
              )}
            </Fragment>
          );
        }
        if (m.kind === 'file') {
          // A PDF or any other file: a link that opens it.
          return (
            <a key={m.n} className="file" href={link()} target="_blank" rel="noopener noreferrer" {...fresh(link)}>
              {m.name || (m.type === 'application/pdf' ? 'PDF' : 'File')}
            </a>
          );
        }
        return (
          <Fragment key={m.n}>
            <Recording src={src} link={link} />
            {/* What was said, for those who turned it on (transcribe.py). */}
            {m.transcript ? (
              <p className="said">
                <Marked text={m.transcript} mark={mark} />
              </p>
            ) : m.writing ? (
              <p className="hint said">Writing this out. It shows up here in a minute or two.</p>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

// A recording still being written out, anywhere in these notes.
export const writingOut = (notes: Note[] | undefined) => !!notes?.some((n) => (n.media || []).some((m) => m.writing));

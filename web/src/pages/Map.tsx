// Every note with a place of its own, on a map (Jamie, 2026-10-24: "a Map
// view for my notes"). A note showing its day's or home's city has no spot,
// so it is left off. The base map is Amazon Location's, passed through /api
// (packages/backend/maps.ts): the page asks no one else. Pins gather as you
// zoom out; choosing a pin or a group lists its notes under the map, each
// linked to its day. A note's place links here as #d=<day>&n=<id>: the map
// opens on its spot with the notes there listed. The email links a day's
// own place as #d=<day>&ll=<lat>,<lon>: the map opens on that day's notes,
// or on the place alone when none of them has a spot.
//
// Words, a tag and a release narrow the pins (#q=, #tag=, #v=, the
// release's name as on /release/?v=). The words are found as the Search
// page finds them, by POST, so they stay in the #; the tag and the release
// are read from the pins. Each menu offers what the other filters leave.
//
// Check-ins (docs/CHECK-INS.md) are on the map too, with their own mark and
// their own groups, so they never read as notes (Jamie's call 6), and a menu
// (#show=) shows notes, check-ins or both. A release narrows them as it does
// notes. A tag or words keep notes alone, since a check-in has neither. Only
// marks here: a check-in's real circle shows when it is opened. A check-in's
// page links here as #c=<id>.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, LngLatBounds, Map as MapLibre } from 'maplibre-gl';
import { AppLink, Bar, Digits, ErrorLine, Failed, Loading, useTitle } from '../components/common.tsx';
import { dayHref } from '../components/days.tsx';
import { NoteBody } from '../components/notes.tsx';
import { MAX_QUERY, searchTerms } from '../../../packages/domain/search.ts';
import { releaseAge } from '../../../packages/domain/version.ts';
import { ApiError, load } from '../lib/api.ts';
import { checkInHref, stayLine, stopName } from '../lib/check-ins.ts';
import { count, dayName } from '../lib/format.ts';
import { useHashParam } from '../lib/nav.ts';
import { checkInsQuery, mapQuery } from '../lib/queries.ts';
import { sayFor } from '../lib/say.ts';
import type { MapSearch, Pin, Stay } from '../lib/types.ts';

const keyOf = (p: { date: string; id: string }) => p.date + '#' + p.id;

export interface Sieve {
  tag: string;
  release: string;
  /** The pins with the words, by key; null when no words are asked. */
  found: Set<string> | null;
}
export interface Sifted {
  shown: Pin[];
  tags: { tag: string; notes: number }[];
  releases: { release: string; notes: number }[];
}
/** The pins every filter keeps, and what each menu can offer: the tags
 * among the pins the words and release keep, and the releases among those
 * the words and tag keep, most used and newest first. A choice that keeps
 * nothing stays on its menu. */
export function sift(pins: readonly Pin[], sieve: Sieve): Sifted {
  const words = (p: Pin) => !sieve.found || sieve.found.has(keyOf(p)),
    tagged = (p: Pin) => !sieve.tag || p.tags.includes(sieve.tag),
    dated = (p: Pin) => !sieve.release || p.release === sieve.release,
    tags = new Map<string, number>(),
    releases = new Map<string, number>(),
    shown: Pin[] = [];
  if (sieve.tag) tags.set(sieve.tag, 0);
  if (sieve.release) releases.set(sieve.release, 0);
  for (const p of pins) {
    if (!words(p)) continue;
    if (dated(p)) for (const t of new Set(p.tags)) tags.set(t, (tags.get(t) ?? 0) + 1);
    if (tagged(p)) releases.set(p.release, (releases.get(p.release) ?? 0) + 1);
    if (dated(p) && tagged(p)) shown.push(p);
  }
  return {
    shown,
    tags: [...tags]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, notes]) => ({ tag, notes })),
    // 10.0 after 9.9: by age, not by spelling.
    releases: [...releases]
      .sort(([a], [b]) => (releaseAge(b) ?? -1) - (releaseAge(a) ?? -1))
      .map(([release, notes]) => ({ release, notes }))
  };
}

/** The check-ins these filters keep (see the top of this file). */
export function siftStays(
  stays: readonly Stay[],
  sieve: { show: string; tag: string; release: string; asked: boolean }
) {
  if (sieve.show === 'notes' || sieve.tag || sieve.asked) return [];
  return stays.filter((s) => !sieve.release || s.release === sieve.release);
}
/** The line over the map: what is on it, of how many. */
export function mapLede(notes: number, shown: number | undefined, stays: number, stayed: number, filtering: boolean) {
  const own = (n: number) => `with a place of ${n === 1 ? 'its' : 'their'} own`,
    ofNotes = filtering && shown !== undefined ? `${shown} of ` : '',
    ofStays = filtering ? `${stayed} of ` : '',
    notesLine = `${ofNotes}${count(notes, 'note', 'notes')} ${own(notes)}`,
    staysLine = `${ofStays}${count(stays, 'check-in', 'check-ins')}`;
  if (!notes && !stays) return 'No note has a place of its own yet. Add one with Where, or Here on a note.';
  if (filtering && !(shown ?? 1) && !stayed) {
    const of = [
      notes ? `your ${notesLine.slice(ofNotes.length)}` : '',
      stays ? `your ${count(stays, 'check-in', 'check-ins')}` : ''
    ]
      .filter(Boolean)
      .join(' or ');
    return `None of ${of} ${notes + stays === 1 ? 'matches' : 'match'}.`;
  }
  if (!stays) return `${notesLine}.`;
  return notes ? `${notesLine}, and ${staysLine}.` : `${staysLine}.`;
}

/** The release menu: the notes' and the check-ins' releases by age, each with
 * how many. `stays` come by the other filters only, as sift's list does, or
 * choosing a release would take the rest off the menu. */
export function releaseMenu(
  notes: readonly { release: string; notes: number }[],
  stays: readonly Pick<Stay, 'release'>[],
  chosen: string
) {
  const tally = new Map(notes.map((r) => [r.release, r.notes]));
  if (chosen) tally.set(chosen, tally.get(chosen) ?? 0);
  for (const s of stays) tally.set(s.release, (tally.get(s.release) ?? 0) + 1);
  return [...tally]
    .sort(([a], [b]) => (releaseAge(b) ?? -1) - (releaseAge(a) ?? -1))
    .map(([release, notes]) => ({ release, notes }));
}

export function MapPage() {
  useTitle('Map');
  const navigate = useNavigate();
  const found = useQuery(mapQuery);
  const d = found.data;
  const day = useHashParam('d'),
    id = useHashParam('n'),
    ll = useHashParam('ll'),
    q = (useHashParam('q') || '').trim(),
    tag = useHashParam('tag') || '',
    release = useHashParam('v') || '',
    show = useHashParam('show') || '',
    stayId = useHashParam('c');
  const stays = useQuery({ ...checkInsQuery, meta: { bounce: false } }).data?.stays;
  // Words with no terms in them (a pair of quotes) are no search.
  const asked = searchTerms(q).length > 0;
  const searched = useQuery({
    queryKey: ['map-search', q],
    queryFn: () => load<MapSearch>('POST', '/api/map/search', { q }),
    enabled: asked,
    // Typing on narrows from what the last words found.
    placeholderData: keepPreviousData
  });
  const refused =
    searched.error instanceof ApiError && searched.error.answer.status === 400 ? searched.error.answer.data : null;
  const words = useMemo(
    () => (asked && searched.data ? new Set(searched.data.found.map(keyOf)) : null),
    [asked, searched.data]
  );
  const noted = useMemo(() => d && sift(d.pins, { tag, release, found: words }), [d, tag, release, words]);
  const stayed = useMemo(
    () => siftStays(stays ?? [], { show, tag, release, asked }),
    [stays, show, tag, release, asked]
  );
  const sifted = useMemo(() => {
    if (!noted) return noted;
    return {
      ...noted,
      shown: show === 'check-ins' ? [] : noted.shown,
      // The release menu offers what shows: the notes, the check-ins or both.
      releases: releaseMenu(
        show === 'check-ins' ? [] : noted.releases,
        siftStays(stays ?? [], { show, tag, release: '', asked }),
        release
      )
    };
  }, [noted, stays, show, tag, release, asked]);
  // A menu shows when there is something to choose at all, whatever the
  // other filters leave, so it never comes and goes.
  const menus = useMemo(
    () =>
      d && {
        tags: d.pins.some((p) => p.tags.length),
        releases: new Set([...d.pins.map((p) => p.release), ...(stays ?? []).map((s) => s.release)]).size > 1
      },
    [d, stays]
  );
  const narrowed = Boolean(q || tag || release),
    filtering = narrowed || Boolean(show);
  // The map moves to what the filters keep once the words are found.
  const view = asked && (searched.isPending || searched.isPlaceholderData) ? null : [q, tag, release].join('\n');

  // A filter replaces the note a place link asked for.
  const filter = useCallback(
    (next: Partial<Record<'q' | 'tag' | 'v' | 'show', string>>) => {
      const hash = new URLSearchParams();
      for (const [k, v] of Object.entries({ q, tag, v: release, show, ...next })) if (v) hash.set(k, v);
      navigate({ to: '/map/', hash: hash.toString(), replace: true });
    },
    [navigate, q, tag, release, show]
  );
  // The words go in a moment after the last key, not with every one. The
  // box follows the address when something else changes it (the Map tab,
  // Clear filters), never back to words it has just sent.
  const [text, setText] = useState(q);
  const [sent, setSent] = useState(q);
  if (q !== sent) {
    setSent(q);
    setText(q);
  }
  const send = useCallback(
    (words: string) => {
      setSent(words);
      filter({ q: words });
    },
    [filter]
  );
  useEffect(() => {
    const words = text.trim();
    if (words === q) return;
    const wait = setTimeout(() => send(words), 400);
    return () => clearTimeout(wait);
  }, [text, q, send]);

  const shown = sifted?.shown;
  // A day's own place (the email's link for it), which no pin need mark.
  const at = useMemo(() => {
    const [lat, lon] = (ll ?? '').split(',').map(Number);
    return ll && Math.abs(lat!) <= 90 && Math.abs(lon!) <= 180 ? ([lon, lat] as [number, number]) : null;
  }, [ll]);
  // A note's link lists the notes at its spot, a day's that day's; the map
  // stays in view rather than the list taking focus, a pin chosen after
  // replaces them, and a filter clears them.
  const linked = useMemo(() => {
    const ofDay = shown && day ? shown.filter((p) => p.date === day) : [],
      focus = id ? ofDay.find((p) => p.id === id) : null;
    if (focus) return shown!.filter((p) => p.lat === focus.lat && p.lon === focus.lon);
    return !id && ofDay.length ? ofDay : null;
  }, [shown, day, id]);
  // A check-in's page asks for it, with whatever else is at its spot.
  const linkedStays = useMemo(() => {
    const focus = stayId ? stayed.find((s) => s.id === stayId || s.ids.includes(stayId)) : null;
    return focus ? stayed.filter((s) => s.lat === focus.lat && s.lon === focus.lon) : null;
  }, [stayed, stayId]);
  const linkedMarks = useMemo(
    () => (linked || linkedStays ? { pins: linked ?? [], stays: linkedStays ?? [] } : null),
    [linked, linkedStays]
  );
  const link = linked || linkedStays || at ? `${day}#${id ?? ''}#${ll ?? ''}#${stayId ?? ''}` : '',
    here = [link, q, tag, release, show].join('\n');
  const [chosen, setChosen] = useState<{ marks: Marks; under: string } | null>(null);
  const pick = useCallback((marks: Marks | null) => setChosen(marks && { marks, under: here }), [here]);
  const picked = chosen && chosen.under === here ? chosen.marks : linkedMarks;
  const total = d?.pins.length ?? 0,
    stayTotal = stays?.length ?? 0;
  return (
    <>
      <Bar />
      <h1>Map</h1>
      {found.isPending && <Loading />}
      {found.isError && !d && <Failed />}
      {d && (
        <p className="lede" role="status">
          {mapLede(
            show === 'check-ins' ? 0 : total,
            narrowed ? shown?.length : undefined,
            show === 'notes' ? 0 : stayTotal,
            stayed.length,
            narrowed
          )}
        </p>
      )}
      {sifted && (total > 0 || stayTotal > 0 || at) && (
        <>
          {(total > 0 || stayTotal > 0) && (
            <>
              <div className="map-filters">
                {total > 0 && stayTotal > 0 && (
                  <label>
                    Show
                    <select
                      name="show"
                      value={show}
                      // A check-in has no words or tag, so they don't stay on.
                      onChange={(e) =>
                        filter(
                          e.target.value === 'check-ins'
                            ? { show: 'check-ins', q: '', tag: '' }
                            : { show: e.target.value }
                        )
                      }
                    >
                      <option value="">Everything</option>
                      <option value="notes">Notes</option>
                      <option value="check-ins">Check-ins</option>
                    </select>
                  </label>
                )}
                {total > 0 && show !== 'check-ins' && (
                  <label className="map-search">
                    Words
                    <input
                      type="search"
                      name="q"
                      maxLength={MAX_QUERY}
                      autoComplete="off"
                      enterKeyHint="search"
                      placeholder={'cabin, "first snow"'}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && send(text.trim())}
                    />
                  </label>
                )}
                {show !== 'check-ins' && (menus?.tags || tag) && (
                  <label>
                    Tag
                    <select value={tag} onChange={(e) => filter({ tag: e.target.value })}>
                      <option value="">All tags</option>
                      {sifted.tags.map((t) => (
                        <option key={t.tag} value={t.tag}>
                          #{t.tag} ({t.notes})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {(menus?.releases || release) && (
                  <label>
                    Release
                    <select value={release} onChange={(e) => filter({ v: e.target.value })}>
                      <option value="">All releases</option>
                      {sifted.releases.map((r) => (
                        <option key={r.release} value={r.release}>
                          {r.release} ({r.notes})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {filtering && (
                  <button
                    className="quiet"
                    type="button"
                    onClick={() => {
                      setText('');
                      setSent('');
                      filter({ q: '', tag: '', v: '', show: '' });
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
              <ErrorLine line={refused && sayFor(refused)} />
              {asked && searched.isError && !refused && <Failed />}
            </>
          )}
          <Basemap
            pins={sifted.shown}
            stays={stayed}
            linked={linkedMarks}
            at={at}
            link={link}
            view={view}
            pick={pick}
          />
          <Picked marks={picked} linked={picked === linkedMarks} anyStays={stayTotal > 0} />
        </>
      )}
    </>
  );
}

const THIS_YEAR = new Date().getFullYear();

/** What a tap or a link lists: the notes and the check-ins there. */
interface Marks {
  pins: Pin[];
  stays: Stay[];
}
/** The heading over a list, with a place's name when they share one. */
export function pickedHead({ pins, stays }: Marks): string {
  const places = [...new Set([...pins.map((p) => p.place), ...stays.map((s) => stopName(s.label))])],
    what = [
      pins.length ? count(pins.length, 'note', 'notes') : '',
      stays.length ? count(stays.length, 'check-in', 'check-ins') : ''
    ]
      .filter(Boolean)
      .join(' and ');
  return `${what} ${pins.length ? 'in' : 'at'} ${places.length === 1 ? places[0] : count(places.length, 'place', 'places')}`;
}

function Picked({ marks, linked, anyStays }: { marks: Marks | null; linked?: boolean; anyStays: boolean }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (marks && !linked) head.current?.focus();
  }, [marks, linked]);
  if (!marks)
    return (
      <p className="meta map-picked-hint">
        {anyStays
          ? 'Choose a mark or a group to list what’s there. A dot is a note, a ring a check-in.'
          : 'Choose a pin or a group to list its notes here. Each version number opens its day.'}
      </p>
    );
  // Newest first, whichever kind.
  const rows = [
    ...marks.pins.map((p) => ({ day: p.date, key: p.date + p.id, pin: p as Pin | null, stay: null as Stay | null })),
    ...marks.stays.map((s) => ({ day: s.day, key: s.id, pin: null as Pin | null, stay: s as Stay | null }))
  ].sort((a, b) => b.day.localeCompare(a.day));
  const both = marks.pins.length > 0 && marks.stays.length > 0;
  return (
    <section className="map-picked" aria-labelledby="map-picked">
      <h2 className="big" id="map-picked" tabIndex={-1} ref={head}>
        {pickedHead(marks)}
      </h2>
      {/* Each note as a note reads elsewhere: its day's version, linked to the
          day, the words, and where. Each check-in opens its own page. */}
      <ul className="map-notes">
        {rows.map(({ key, pin: p, stay: s }) =>
          p ? (
            <li key={key} className="tday">
              <AppLink className="tday-head" href={dayHref(p.date, '')}>
                {both && <span className="map-mark note" role="img" aria-label="Note" />}
                <span className="vnum small">
                  <Digits v={p.version} named />
                </span>
                <span className="when">{dayName(p.date, THIS_YEAR)}</span>
              </AppLink>
              <NoteBody n={{ id: p.id, source: 'web', text: p.text, parts: p.parts }} />
              <p className="meta">{p.place}</p>
            </li>
          ) : (
            <li key={key} className="tday">
              <AppLink className="tday-head" href={checkInHref(s!.id)}>
                <span className="map-mark stay" role="img" aria-label="Check-in" />
                <span className="vnum small">
                  <Digits v={s!.version} named />
                </span>
                <span className="when">{dayName(s!.day, THIS_YEAR)}</span>
              </AppLink>
              <p>Checked in at {stopName(s!.label)}</p>
              <p className="meta">{stayLine(s!, s!.time_zone)}</p>
            </li>
          )
        )}
      </ul>
    </section>
  );
}

// Colours from the page's own tokens, so the pins follow light and dark.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const points = (
  marks: readonly { lat: number; lon: number; key: string }[]
): Parameters<GeoJSONSource['setData']>[0] => ({
  type: 'FeatureCollection',
  features: marks.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { key: p.key }
  }))
});
const pinPoints = (pins: readonly Pin[]) => points(pins.map((p) => ({ lat: p.lat, lon: p.lon, key: keyOf(p) })));
const stayPoints = (stays: readonly Stay[]) => points(stays.map((s) => ({ lat: s.lat, lon: s.lon, key: s.id })));
/** A spot on the map: a note's, or a check-in's, which is always a real one. */
interface Spot {
  lat: number;
  lon: number;
  exact?: boolean;
}
type Lib = typeof import('maplibre-gl');
type Frame = { center: [number, number]; zoom: number } | { bounds: LngLatBounds; padding: number; maxZoom: number };
// Every pin, or what a place link asked for: close in on a spot, the city
// for a chosen city or a day's own place.
function frame(lib: Lib, pins: readonly Spot[], linked?: Spot[] | null, at?: [number, number] | null): Frame | null {
  if (at) return { center: at, zoom: 11 };
  const shown = linked ?? pins,
    [first] = shown;
  if (!first) return null;
  if (linked && shown.every((p) => p.lat === first.lat && p.lon === first.lon))
    return { center: [first.lon, first.lat], zoom: first.exact === false ? 11 : 15 };
  const bounds = new lib.LngLatBounds();
  for (const p of shown) bounds.extend([p.lon, p.lat]);
  return { bounds, padding: 48, maxZoom: linked ? 15 : 11 };
}

/** The map is made once. The pins the filters keep, the view they ask for
 * (`view`, null while the words are still being found) and what a place
 * link asks for (`link`, naming it) change it in place, so the tiles stay. */
function Basemap({
  pins,
  stays,
  linked,
  at,
  link,
  view,
  pick
}: {
  pins: Pin[];
  stays: Stay[];
  linked: Marks | null;
  at: [number, number] | null;
  link: string;
  view: string | null;
  pick: (m: Marks | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const live = useRef({
    pins,
    stays,
    linked,
    at,
    link,
    view,
    pick,
    map: undefined as MapLibre | undefined,
    lib: undefined as Lib | undefined,
    // What the map was last moved to show: a view, and a link.
    framed: view,
    centred: link
  });
  // Read by the map's own handlers, so kept current after each render.
  useEffect(() => {
    Object.assign(live.current, { pins, stays, linked, at, link, view, pick });
  });
  // A tile that will not come leaves a gap; a style that will not, no map.
  useEffect(() => {
    const now = live.current;
    let gone = false,
      made: MapLibre | undefined;
    (async () => {
      const [maplibre, { default: worker }] = await Promise.all([
        import('maplibre-gl'),
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
        import('maplibre-gl/dist/maplibre-gl.css')
      ]);
      if (gone || !box.current) return;
      maplibre.setWorkerUrl(worker);
      const dark = matchMedia('(prefers-color-scheme: dark)').matches,
        start = frame(maplibre, spotsOf(now), linkedSpots(now.linked), now.at);
      let m: MapLibre;
      try {
        m = made = new maplibre.Map({
          container: box.current,
          style: `${location.origin}/api/map/style/${dark ? 'Dark' : 'Light'}`,
          ...(start && 'bounds' in start
            ? { bounds: start.bounds, fitBoundsOptions: { padding: start.padding, maxZoom: start.maxZoom } }
            : (start ?? { center: [0, 20] as [number, number], zoom: 1 })),
          attributionControl: { compact: true },
          cooperativeGestures: true,
          // A flat map that stays north up: no tilting, no turning.
          maxPitch: 0,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false
        });
      } catch {
        return setBroken(true);
      }
      Object.assign(now, { framed: now.view, centred: now.link });
      m.touchZoomRotate.disableRotation();
      m.keyboard.disableRotation();
      // Flat whatever the style says: the browser keeps the style a day
      // (map-routes.ts), so one fetched while it still asked for a globe
      // would keep drawing one.
      m.on('style.load', () => m.setProjection({ type: 'mercator' }));
      m.addControl(new maplibre.NavigationControl({ showCompass: false }));
      const marksOf = (features: { properties?: Record<string, unknown> | null }[]): Marks => {
        const keys = new Set(features.map((f) => String(f.properties?.key)));
        return { pins: now.pins.filter((p) => keys.has(keyOf(p))), stays: now.stays.filter((s) => keys.has(s.id)) };
      };
      let drawn = false;
      m.on('error', () => !drawn && !gone && setBroken(true));
      m.on('load', () => {
        drawn = true;
        const orange = token('--orange') || '#ff5a1f',
          paper = token('--paper') || '#fffbf2',
          ink = token('--on-orange') || '#14163a',
          ring = token('--ink') || '#14163a';
        // Check-ins first, so a note's pin sits over them: their own source,
        // so a group is only ever one kind. A ring, and groups in ink.
        m.addSource('check-ins', {
          type: 'geojson',
          cluster: true,
          clusterRadius: 36,
          clusterMaxZoom: 16,
          data: stayPoints(now.stays)
        });
        m.addLayer({
          id: 'stay-groups',
          type: 'circle',
          source: 'check-ins',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': ring,
            'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 100, 22],
            'circle-stroke-color': paper,
            'circle-stroke-width': 2
          }
        });
        m.addLayer({
          id: 'stay-group-counts',
          type: 'symbol',
          source: 'check-ins',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['Amazon Ember Bold,Noto Sans Bold'],
            'text-size': 12,
            'text-allow-overlap': true
          },
          paint: { 'text-color': paper }
        });
        m.addLayer({
          id: 'stays',
          type: 'circle',
          source: 'check-ins',
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': paper,
            'circle-radius': 6,
            'circle-stroke-color': ring,
            'circle-stroke-width': 3
          }
        });
        m.addSource('notes', {
          type: 'geojson',
          cluster: true,
          clusterRadius: 36,
          clusterMaxZoom: 16,
          data: pinPoints(now.pins)
        });
        m.addLayer({
          id: 'groups',
          type: 'circle',
          source: 'notes',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': orange,
            'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 100, 22],
            'circle-stroke-color': paper,
            'circle-stroke-width': 2
          }
        });
        m.addLayer({
          id: 'group-counts',
          type: 'symbol',
          source: 'notes',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['Amazon Ember Bold,Noto Sans Bold'],
            'text-size': 12,
            'text-allow-overlap': true
          },
          paint: { 'text-color': ink }
        });
        m.addLayer({
          id: 'pins',
          type: 'circle',
          source: 'notes',
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': orange,
            'circle-radius': 7,
            'circle-stroke-color': paper,
            'circle-stroke-width': 2
          }
        });
        // A finger is wider than a pin: a tap within 22px of one counts, and
        // everything under it comes, not just the top one. A group lists every
        // note or check-in in it (Jamie, 2026-10-24: "it should work for groups
        // of notes too"), both kinds when both are there; + and − or a double
        // tap zoom.
        const LAYERS = ['groups', 'pins', 'stay-groups', 'stays'];
        m.on('click', async (e) => {
          const { x, y } = e.point,
            under = m.queryRenderedFeatures(
              [
                [x - 22, y - 22],
                [x + 22, y + 22]
              ],
              { layers: LAYERS }
            );
          if (!under.length) return;
          const leaves = await Promise.all(
            under.map((f) =>
              f.properties?.cluster_id == null
                ? [f]
                : (m.getSource(f.source) as GeoJSONSource).getClusterLeaves(
                    Number(f.properties.cluster_id),
                    Infinity,
                    0
                  )
            )
          );
          now.pick(marksOf(leaves.flat()));
        });
        for (const layer of LAYERS) {
          m.on('mouseenter', layer, () => (m.getCanvas().style.cursor = 'pointer'));
          m.on('mouseleave', layer, () => (m.getCanvas().style.cursor = ''));
        }
        Object.assign(now, { map: m, lib: maplibre });
        // What changed while the map was coming.
        moved(now);
      });
    })().catch(() => !gone && setBroken(true));
    return () => {
      gone = true;
      now.map = undefined;
      made?.remove();
    };
  }, []);
  // The pins the filters keep, drawn in place.
  useEffect(() => {
    const m = live.current.map;
    (m?.getSource('notes') as GeoJSONSource | undefined)?.setData(pinPoints(pins));
  }, [pins]);
  useEffect(() => {
    const m = live.current.map;
    (m?.getSource('check-ins') as GeoJSONSource | undefined)?.setData(stayPoints(stays));
  }, [stays]);
  // Then the map moves to them, or to the note a link asked for.
  useEffect(() => {
    moved(live.current);
  }, [view, link]);
  if (broken) return <p className="hint spaced">This browser can't draw the map.</p>;
  return <div className="map" ref={box} role="region" aria-label="Map of your notes and check-ins" />;
}

const spotsOf = (now: { pins: readonly Spot[]; stays?: readonly Spot[] }): Spot[] => [
  ...now.pins,
  ...(now.stays ?? [])
];
const linkedSpots = (marks: Marks | null): Spot[] | null => marks && [...marks.pins, ...marks.stays];

export interface Live {
  pins: Pin[];
  stays?: Stay[];
  linked: Marks | null;
  at: [number, number] | null;
  link: string;
  view: string | null;
  map?: MapLibre;
  lib?: Lib;
  framed: string | null;
  centred?: string;
}
/** Moves the map to a link it has not shown, or else to the pins once the
 * filters change or a link it showed is gone (the Map tab after a place
 * link): never again to what it already shows. */
export function moved(now: Live) {
  const { map: m, lib } = now;
  if (!m || !lib) return;
  let to: Frame | null;
  if (now.link && now.link !== now.centred) to = frame(lib, spotsOf(now), linkedSpots(now.linked), now.at);
  else if (now.view !== null && (now.view !== now.framed || now.link !== now.centred)) to = frame(lib, spotsOf(now));
  else return;
  if (to && 'center' in to) m.easeTo(to);
  else if (to) m.fitBounds(to.bounds, { padding: to.padding, maxZoom: to.maxZoom });
  Object.assign(now, { centred: now.link, framed: now.view ?? now.framed });
}

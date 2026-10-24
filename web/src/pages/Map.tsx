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
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, LngLatBounds, Map as MapLibre } from 'maplibre-gl';
import { AppLink, Bar, ErrorLine, Failed, Loading, useTitle } from '../components/common.tsx';
import { dayHref } from '../components/days.tsx';
import { NoteBody } from '../components/notes.tsx';
import { MAX_QUERY, searchTerms } from '../../../packages/domain/search.ts';
import { releaseAge } from '../../../packages/domain/version.ts';
import { ApiError, load } from '../lib/api.ts';
import { count, dayName } from '../lib/format.ts';
import { useHashParam } from '../lib/nav.ts';
import { mapQuery } from '../lib/queries.ts';
import { sayFor } from '../lib/say.ts';
import type { MapSearch, Pin } from '../lib/types.ts';

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
    release = useHashParam('v') || '';
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
  const sifted = useMemo(() => d && sift(d.pins, { tag, release, found: words }), [d, tag, release, words]);
  // A menu shows when there is something to choose at all, whatever the
  // other filters leave, so it never comes and goes.
  const menus = useMemo(
    () => d && { tags: d.pins.some((p) => p.tags.length), releases: new Set(d.pins.map((p) => p.release)).size > 1 },
    [d]
  );
  const filtering = Boolean(q || tag || release);
  // The map moves to what the filters keep once the words are found.
  const view = asked && (searched.isPending || searched.isPlaceholderData) ? null : [q, tag, release].join('\n');

  // A filter replaces the note a place link asked for.
  const filter = useCallback(
    (next: Partial<Record<'q' | 'tag' | 'v', string>>) => {
      const hash = new URLSearchParams();
      for (const [k, v] of Object.entries({ q, tag, v: release, ...next })) if (v) hash.set(k, v);
      navigate({ to: '/map/', hash: hash.toString(), replace: true });
    },
    [navigate, q, tag, release]
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
  const link = linked || at ? `${day}#${id ?? ''}#${ll ?? ''}` : '',
    here = [link, q, tag, release].join('\n');
  const [chosen, setChosen] = useState<{ pins: Pin[]; under: string } | null>(null);
  const pick = useCallback((pins: Pin[] | null) => setChosen(pins && { pins, under: here }), [here]);
  const picked = chosen && chosen.under === here ? chosen.pins : linked;
  const total = d?.pins.length ?? 0,
    own = (n: number) => `with a place of ${n === 1 ? 'its' : 'their'} own`;
  return (
    <>
      <Bar />
      <h1>Map</h1>
      {found.isPending && <Loading />}
      {found.isError && !d && <Failed />}
      {d && (
        <p className="lede" role="status">
          {!total
            ? 'No note has a place of its own yet. Add one with Where, or Here on a note.'
            : !filtering || !shown
              ? `${count(total, 'note', 'notes')} ${own(total)}.`
              : shown.length
                ? `${shown.length} of ${count(total, 'note', 'notes')} ${own(total)}.`
                : `None of your ${count(total, 'note', 'notes')} ${own(total)} ${total === 1 ? 'matches' : 'match'}.`}
        </p>
      )}
      {sifted && (total > 0 || at) && (
        <>
          {total > 0 && (
            <>
              <div className="map-filters">
                <label className="map-search">
                  Search notes
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
                {(menus?.tags || tag) && (
                  <label>
                    Filter by tag
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
                    Filter by release
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
                      filter({ q: '', tag: '', v: '' });
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
          <Basemap pins={sifted.shown} linked={linked} at={at} link={link} view={view} pick={pick} />
          <Picked pins={picked} linked={picked === linked} />
        </>
      )}
    </>
  );
}

const ORDER = (a: Pin, b: Pin) => b.date.localeCompare(a.date),
  THIS_YEAR = new Date().getFullYear();

function Picked({ pins, linked }: { pins: Pin[] | null; linked?: boolean }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (pins && !linked) head.current?.focus();
  }, [pins, linked]);
  if (!pins) return <p className="hint spaced">Choose a pin or a group to see its notes.</p>;
  const places = [...new Set(pins.map((p) => p.place))];
  return (
    <section className="map-picked" aria-labelledby="map-picked">
      <h2 className="big" id="map-picked" tabIndex={-1} ref={head}>
        {places.length === 1 ? places[0] : count(places.length, 'place', 'places')}
      </h2>
      {pins.length > 1 && <p className="hint">{count(pins.length, 'note', 'notes')}, newest first.</p>}
      <ul className="map-notes">
        {[...pins].sort(ORDER).map((p) => (
          <li key={p.date + p.id}>
            <AppLink href={dayHref(p.date, '')}>{dayName(p.date, THIS_YEAR)}</AppLink>
            {places.length > 1 && <span className="hint"> · {p.place}</span>}
            <NoteBody n={{ id: p.id, source: 'web', text: p.text, parts: p.parts }} cls="map-text" />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Colours from the page's own tokens, so the pins follow light and dark.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const points = (pins: readonly Pin[]): Parameters<GeoJSONSource['setData']>[0] => ({
  type: 'FeatureCollection',
  features: pins.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { key: keyOf(p) }
  }))
});
type Lib = typeof import('maplibre-gl');
type Frame = { center: [number, number]; zoom: number } | { bounds: LngLatBounds; padding: number; maxZoom: number };
// Every pin, or what a place link asked for: close in on a spot, the city
// for a chosen city or a day's own place.
function frame(lib: Lib, pins: readonly Pin[], linked?: Pin[] | null, at?: [number, number] | null): Frame | null {
  if (at) return { center: at, zoom: 11 };
  const shown = linked ?? pins,
    [first] = shown;
  if (!first) return null;
  if (linked && shown.every((p) => p.lat === first.lat && p.lon === first.lon))
    return { center: [first.lon, first.lat], zoom: first.exact ? 15 : 11 };
  const bounds = new lib.LngLatBounds();
  for (const p of shown) bounds.extend([p.lon, p.lat]);
  return { bounds, padding: 48, maxZoom: linked ? 15 : 11 };
}

/** The map is made once. The pins the filters keep, the view they ask for
 * (`view`, null while the words are still being found) and what a place
 * link asks for (`link`, naming it) change it in place, so the tiles stay. */
function Basemap({
  pins,
  linked,
  at,
  link,
  view,
  pick
}: {
  pins: Pin[];
  linked: Pin[] | null;
  at: [number, number] | null;
  link: string;
  view: string | null;
  pick: (p: Pin[] | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const live = useRef({
    pins,
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
    Object.assign(live.current, { pins, linked, at, link, view, pick });
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
        start = frame(maplibre, now.pins, now.linked, now.at);
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
      m.addControl(new maplibre.NavigationControl({ showCompass: false }));
      const pinsOf = (features: { properties?: Record<string, unknown> | null }[]) => {
        const byKey = new Map(now.pins.map((p) => [keyOf(p), p]));
        return features.map((f) => byKey.get(String(f.properties?.key))!).filter(Boolean);
      };
      let drawn = false;
      m.on('error', () => !drawn && !gone && setBroken(true));
      m.on('load', () => {
        drawn = true;
        const orange = token('--orange') || '#ff5a1f',
          paper = token('--paper') || '#fffbf2',
          ink = token('--on-orange') || '#14163a';
        m.addSource('notes', {
          type: 'geojson',
          cluster: true,
          clusterRadius: 36,
          clusterMaxZoom: 16,
          data: points(now.pins)
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
        // A finger is wider than a pin: a tap within 22px of one counts, a
        // group first, and every pin under it comes, not just the top one.
        // A group lists every note in it (Jamie, 2026-10-24: "it should
        // work for groups of notes too"); + and − or a double tap zoom.
        m.on('click', async (e) => {
          const { x, y } = e.point,
            near = (layers: string[]) =>
              m.queryRenderedFeatures(
                [
                  [x - 22, y - 22],
                  [x + 22, y + 22]
                ],
                { layers }
              ),
            group = near(['groups'])[0];
          if (!group) {
            const here = near(['pins']);
            if (here.length) now.pick(pinsOf(here));
            return;
          }
          const source = m.getSource('notes') as GeoJSONSource;
          now.pick(pinsOf(await source.getClusterLeaves(Number(group.properties?.cluster_id), Infinity, 0)));
        });
        for (const layer of ['pins', 'groups']) {
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
    (m?.getSource('notes') as GeoJSONSource | undefined)?.setData(points(pins));
  }, [pins]);
  // Then the map moves to them, or to the note a link asked for.
  useEffect(() => {
    moved(live.current);
  }, [view, link]);
  if (broken) return <p className="hint spaced">This browser can't draw the map.</p>;
  return <div className="map" ref={box} role="region" aria-label="Map of your notes" />;
}

export interface Live {
  pins: Pin[];
  linked: Pin[] | null;
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
  if (now.link && now.link !== now.centred) to = frame(lib, now.pins, now.linked, now.at);
  else if (now.view !== null && (now.view !== now.framed || now.link !== now.centred)) to = frame(lib, now.pins);
  else return;
  if (to && 'center' in to) m.easeTo(to);
  else if (to) m.fitBounds(to.bounds, { padding: to.padding, maxZoom: to.maxZoom });
  Object.assign(now, { centred: now.link, framed: now.view ?? now.framed });
}

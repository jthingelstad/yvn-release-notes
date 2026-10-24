// Every note with a place of its own, on a map (Jamie, 2026-10-24: "a Map
// view for my notes"). A note showing its day's or home's city has no spot,
// so it is left off. The base map is Amazon Location's, passed through /api
// (packages/backend/maps.ts): the page asks no one else. Pins gather as you
// zoom out; choosing one, or a group that will not part (notes in the same
// city), lists its notes under the map, each linked to its day. A note's
// place links here as #d=<day>&n=<id>: the map opens on its spot with the
// notes there listed. The email links a day's own place as #d=<day>: the
// map opens on that day's notes.
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibre } from 'maplibre-gl';
import { AppLink, Bar, Failed, Loading, useTitle } from '../components/common.tsx';
import { dayHref } from '../components/days.tsx';
import { NoteBody } from '../components/notes.tsx';
import { count, dayName } from '../lib/format.ts';
import { useHashParam } from '../lib/nav.ts';
import { mapQuery } from '../lib/queries.ts';
import type { Pin } from '../lib/types.ts';

export function MapPage() {
  useTitle('Map');
  const found = useQuery(mapQuery);
  const d = found.data;
  const day = useHashParam('d'),
    id = useHashParam('n'),
    ll = useHashParam('ll');
  // A day's own place (the email's link for it), which no pin need mark.
  const at = useMemo(() => {
    const [lat, lon] = (ll ?? '').split(',').map(Number);
    return ll && Math.abs(lat!) <= 90 && Math.abs(lon!) <= 180 ? ([lon, lat] as [number, number]) : null;
  }, [ll]);
  // A note's link lists the notes at its spot, a day's that day's; the map
  // stays in view rather than the list taking focus, and a pin chosen after
  // replaces them.
  const linked = useMemo(() => {
    const ofDay = d && day ? d.pins.filter((p) => p.date === day) : [],
      focus = id ? ofDay.find((p) => p.id === id) : null;
    if (focus) return d!.pins.filter((p) => p.lat === focus.lat && p.lon === focus.lon);
    return !id && ofDay.length ? ofDay : null;
  }, [d, day, id]);
  const here = linked || at ? `${day}#${id ?? ''}#${ll ?? ''}` : '';
  const [chosen, setChosen] = useState<{ pins: Pin[]; under: string } | null>(null);
  const pick = useCallback((pins: Pin[] | null) => setChosen(pins && { pins, under: here }), [here]);
  const picked = chosen && chosen.under === here ? chosen.pins : linked;
  return (
    <>
      <Bar />
      <h1>Map</h1>
      {found.isPending && <Loading />}
      {found.isError && !d && <Failed />}
      {d && (
        <p className="lede">
          {d.pins.length
            ? `${count(d.pins.length, 'note', 'notes')} with a place of ${d.pins.length === 1 ? 'its' : 'their'} own.`
            : 'No note has a place of its own yet. Add one with Where, or Here on a note.'}
        </p>
      )}
      {d && (d.pins.length > 0 || at) && (
        <>
          <Basemap pins={d.pins} focus={linked} at={at} pick={pick} />
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
  if (!pins) return <p className="hint spaced">Choose a pin to see its notes.</p>;
  const places = [...new Set(pins.map((p) => p.place))];
  return (
    <section className="map-picked" aria-labelledby="map-picked">
      <h2 className="big" id="map-picked" tabIndex={-1} ref={head}>
        {places.length === 1 ? places[0] : count(places.length, 'place', 'places')}
      </h2>
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

function Basemap({
  pins,
  focus,
  at,
  pick
}: {
  pins: Pin[];
  focus: Pin[] | null;
  at: [number, number] | null;
  pick: (p: Pin[] | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let map: MapLibre | undefined,
      gone = false;
    (async () => {
      const [maplibre, { default: worker }] = await Promise.all([
        import('maplibre-gl'),
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
        import('maplibre-gl/dist/maplibre-gl.css')
      ]);
      if (gone || !box.current) return;
      maplibre.setWorkerUrl(worker);
      const dark = matchMedia('(prefers-color-scheme: dark)').matches,
        frame = focus ?? pins,
        [first] = frame,
        one = !!focus && frame.every((p) => p.lat === first!.lat && p.lon === first!.lon),
        bounds = new maplibre.LngLatBounds();
      for (const p of frame) bounds.extend([p.lon, p.lat]);
      let m: MapLibre;
      try {
        m = map = new maplibre.Map({
          container: box.current,
          style: `${location.origin}/api/map/style/${dark ? 'Dark' : 'Light'}`,
          // Every pin, or what a place link asked for: close in on a spot,
          // the city for a chosen city or a day's own place.
          ...(at
            ? { center: at, zoom: 11 }
            : one
              ? { center: [first!.lon, first!.lat] as [number, number], zoom: first!.exact ? 15 : 11 }
              : { bounds, fitBoundsOptions: { padding: 48, maxZoom: focus ? 15 : 11 } }),
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
      m.touchZoomRotate.disableRotation();
      m.keyboard.disableRotation();
      m.addControl(new maplibre.NavigationControl({ showCompass: false }));
      const byKey = new Map(pins.map((p) => [p.date + '#' + p.id, p]));
      const pinsOf = (features: { properties?: Record<string, unknown> | null }[]) =>
        features.map((f) => byKey.get(String(f.properties?.key))!).filter(Boolean);
      // A tile that will not come leaves a gap; a style that will not, no map.
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
          data: {
            type: 'FeatureCollection',
            features: pins.map((p) => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
              properties: { key: p.date + '#' + p.id }
            }))
          }
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
            if (here.length) pick(pinsOf(here));
            return;
          }
          const source = m.getSource('notes') as GeoJSONSource,
            id = Number(group.properties?.cluster_id),
            zoom = await source.getClusterExpansionZoom(id);
          if (zoom <= 16 && zoom > m.getZoom())
            m.easeTo({ center: (group.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom });
          else pick(pinsOf(await source.getClusterLeaves(id, Infinity, 0)));
        });
        for (const layer of ['pins', 'groups']) {
          m.on('mouseenter', layer, () => (m.getCanvas().style.cursor = 'pointer'));
          m.on('mouseleave', layer, () => (m.getCanvas().style.cursor = ''));
        }
      });
    })().catch(() => !gone && setBroken(true));
    return () => {
      gone = true;
      map?.remove();
    };
  }, [pins, focus, at, pick]);
  if (broken) return <p className="hint spaced">This browser can't draw the map.</p>;
  return <div className="map" ref={box} role="region" aria-label="Map of your notes" />;
}

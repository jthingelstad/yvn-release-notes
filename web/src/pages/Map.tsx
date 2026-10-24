// Every note with a place of its own, on a map (Jamie, 2026-10-24: "a Map
// view for my notes"). A note showing its day's or home's city has no spot,
// so it is left off. The base map is Amazon Location's, passed through /api
// (packages/backend/maps.ts): the page asks no one else. Pins gather as you
// zoom out; choosing one, or a group that will not part (notes in the same
// city), lists its notes under the map, each linked to its day. A note's
// place links here as #d=<day>&n=<id>: the map opens on its spot with the
// notes there listed.
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
    id = useHashParam('n');
  const focus = useMemo(() => d?.pins.find((p) => p.date === day && p.id === id), [d, day, id]);
  const here = focus ? `${focus.date}#${focus.id}` : '';
  // A note's link lists the notes at its spot, and the map stays in view
  // rather than the list taking focus; a pin chosen after replaces them.
  const linked = useMemo(
    () => (focus && d ? d.pins.filter((p) => p.lat === focus.lat && p.lon === focus.lon) : null),
    [focus, d]
  );
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
      {d && d.pins.length > 0 && (
        <>
          <Basemap pins={d.pins} focus={focus} pick={pick} />
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

function Basemap({ pins, focus, pick }: { pins: Pin[]; focus?: Pin; pick: (p: Pin[] | null) => void }) {
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
        bounds = new maplibre.LngLatBounds();
      for (const p of pins) bounds.extend([p.lon, p.lat]);
      let m: MapLibre;
      try {
        m = map = new maplibre.Map({
          container: box.current,
          style: `${location.origin}/api/map/style/${dark ? 'Dark' : 'Light'}`,
          // Every pin, or the one a note's place link asked for: close in
          // on a spot, the city for a chosen city.
          ...(focus
            ? { center: [focus.lon, focus.lat] as [number, number], zoom: focus.exact ? 15 : 11 }
            : { bounds, fitBoundsOptions: { padding: 48, maxZoom: 11 } }),
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
  }, [pins, focus, pick]);
  if (broken) return <p className="hint spaced">This browser can't draw the map.</p>;
  return <div className="map" ref={box} role="region" aria-label="Map of your notes" />;
}

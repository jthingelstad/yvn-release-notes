// One check-in's spot, with its real circle (docs/CHECK-INS.md: "Check-ins use
// their real circle only when opened"), on the same base map as the Map page.
import { useEffect, useRef, useState } from 'react';
import type { Map as MapLibre } from 'maplibre-gl';
import { circleAround } from '../lib/check-ins.ts';
import type { Stay } from '../lib/types.ts';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function SpotMap({ stay }: { stay: Pick<Stay, 'lat' | 'lon' | 'accuracy_m'> }) {
  const box = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const { lat, lon, accuracy_m: accuracy } = stay;
  useEffect(() => {
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
        ring = accuracy ? circleAround(lat, lon, accuracy) : null,
        bounds = new maplibre.LngLatBounds([lon, lat], [lon, lat]);
      for (const point of ring ?? []) bounds.extend(point);
      const m = (made = new maplibre.Map({
        container: box.current,
        style: `${location.origin}/api/map/style/${dark ? 'Dark' : 'Light'}`,
        bounds,
        fitBoundsOptions: { padding: 48, maxZoom: 16 },
        attributionControl: { compact: true },
        cooperativeGestures: true,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false
      }));
      m.touchZoomRotate.disableRotation();
      m.keyboard.disableRotation();
      m.on('style.load', () => m.setProjection({ type: 'mercator' }));
      m.addControl(new maplibre.NavigationControl({ showCompass: false }));
      let drawn = false;
      m.on('error', () => !drawn && !gone && setBroken(true));
      m.on('load', () => {
        drawn = true;
        const ink = token('--ink') || '#14163a',
          paper = token('--paper') || '#fffbf2';
        if (ring) {
          m.addSource('circle', {
            type: 'geojson',
            data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }
          });
          m.addLayer({
            id: 'circle',
            type: 'fill',
            source: 'circle',
            paint: { 'fill-color': ink, 'fill-opacity': 0.12 }
          });
          m.addLayer({
            id: 'circle-edge',
            type: 'line',
            source: 'circle',
            paint: { 'line-color': ink, 'line-width': 1 }
          });
        }
        m.addSource('spot', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } }
        });
        m.addLayer({
          id: 'spot',
          type: 'circle',
          source: 'spot',
          paint: { 'circle-color': paper, 'circle-radius': 6, 'circle-stroke-color': ink, 'circle-stroke-width': 3 }
        });
      });
    })().catch(() => !gone && setBroken(true));
    return () => {
      gone = true;
      made?.remove();
    };
  }, [lat, lon, accuracy]);
  if (broken) return <p className="hint spaced">This browser can’t draw the map.</p>;
  return <div className="map map-spot" ref={box} role="region" aria-label="Where this check-in was" />;
}

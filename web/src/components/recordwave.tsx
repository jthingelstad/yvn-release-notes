// The bars beside Stop while the page records: the microphone's loudness
// lately, newest at the right, older ones moving off to the left, as
// Changelog's voice memo draws them. Silence is a row of dots, so a flat
// line says the microphone hears nothing, not that recording stopped.
// Decoration only: the button already says it is recording and for how long.
import { useEffect, useRef } from 'react';

const EVERY_MS = 50; // a bar each
const STEP = 5; // CSS pixels from one bar to the next
const BAR = 3;

/** An RMS level in decibels as 0 to 1, as the iPhone app reads its meter. */
export function level(rms: number): number {
  const floor = -50;
  const db = 20 * Math.log10(rms);
  if (!Number.isFinite(db) || db <= floor) return 0;
  return Math.sqrt(Math.min(1, (db - floor) / -floor));
}

export function RecordWave({ analyser }: { analyser: AnalyserNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const samples = new Float32Array(analyser.fftSize);
    const levels: number[] = [];
    let last = 0;
    let frame = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < EVERY_MS) return;
      last = now;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      levels.push(level(Math.sqrt(sum / samples.length)));

      const ratio = window.devicePixelRatio || 1;
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (el.width !== Math.round(width * ratio) || el.height !== Math.round(height * ratio)) {
        el.width = Math.round(width * ratio);
        el.height = Math.round(height * ratio);
      }
      const count = Math.floor(width / STEP);
      if (levels.length > count) levels.splice(0, levels.length - count);
      const gap = count - levels.length;
      const color = getComputedStyle(el).color;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < count; i++) {
        const on = i >= gap;
        const h = Math.max(BAR, height * (on ? levels[i - gap] : 0));
        ctx.globalAlpha = on ? 1 : 0.2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(i * STEP + (STEP - BAR) / 2, (height - h) / 2, BAR, h, BAR / 2);
        ctx.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return <canvas ref={canvas} className="record-wave" aria-hidden="true" />;
}

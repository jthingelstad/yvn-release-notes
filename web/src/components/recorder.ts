// The note form's Record button: the microphone through MediaRecorder
// (Jamie, 2026-10-09), each recording kept on the page, to listen to or
// remove, until the note is saved. files() stops one still going and gives
// them all as files to send.
import { useCallback, useEffect, useRef, useState } from 'react';

// In the first of these the browser records: Safari and newer Chrome make
// MP4, older Chrome WebM, Firefox Ogg. Each is a type media.py keeps.
const RECORD_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const MAX_RECORDING = 30 * 60; // seconds

export interface Kept {
  file: File;
  url: string;
}

export const canRecord = () =>
  !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export function useRecorder(onRefused: () => void) {
  const [kept, setKept] = useState<Kept[]>([]);
  const [seconds, setSeconds] = useState<number | null>(null); // null: not recording
  const keptRef = useRef<Kept[]>([]);
  const live = useRef<{ rec: MediaRecorder; done: Promise<void> } | null>(null);

  const keep = (next: Kept[]) => {
    keptRef.current = next;
    setKept(next);
  };

  const start = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onRefused();
      return;
    }
    const type = RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
    const chunks: Blob[] = [];
    const started = Date.now();
    const elapsed = () => Math.round((Date.now() - started) / 1000);
    const done = new Promise<void>((resolve) =>
      rec.addEventListener('stop', () => {
        clearInterval(tick);
        stream.getTracks().forEach((t) => t.stop());
        const t = rec.mimeType || type || 'audio/webm';
        if (chunks.length) {
          const ext = t.startsWith('audio/mp4') ? 'm4a' : t.startsWith('audio/ogg') ? 'ogg' : 'webm';
          const at = new Date(started).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':', '.');
          const file = new File(chunks, `Recording ${at}.${ext}`, { type: t });
          keep([...keptRef.current, { file, url: URL.createObjectURL(file) }]);
        }
        live.current = null;
        setSeconds(null);
        resolve();
      })
    );
    rec.addEventListener('dataavailable', (e) => {
      if (e.data.size) chunks.push(e.data);
    });
    rec.start(1000);
    live.current = { rec, done };
    setSeconds(0);
    const tick = setInterval(() => {
      setSeconds(elapsed());
      if (elapsed() >= MAX_RECORDING) rec.stop();
    }, 1000);
  }, [onRefused]);

  const toggle = useCallback(() => (live.current ? live.current.rec.stop() : start()), [start]);

  const remove = (r: Kept) => {
    URL.revokeObjectURL(r.url);
    keep(keptRef.current.filter((k) => k !== r));
  };

  const files = async () => {
    if (live.current) {
      live.current.rec.stop();
      await live.current.done;
    }
    return keptRef.current.map((r) => r.file);
  };

  const clear = () => {
    keptRef.current.forEach((r) => URL.revokeObjectURL(r.url));
    keep([]);
  };

  // A recording not yet saved lives only on this page.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (live.current || keptRef.current.length) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Leaving the page stops the microphone.
  useEffect(() => () => live.current?.rec.stop(), []);

  return { kept, seconds, toggle, remove, files, clear, unsaved: () => !!live.current || !!keptRef.current.length };
}

export const recordClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

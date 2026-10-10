// Files from this device: what the pickers offer, and how they reach the
// bucket (media.py has the design).
import { api } from './api.ts';
import type { Problem } from './say.ts';

// What the file pickers offer: photos, recordings and PDFs.
export const FILES = 'image/*,audio/*,application/pdf,.heic,.heif,.m4a,.pdf';

export interface Sent {
  upload: string;
  type: string;
  name: string;
}

// Each file sent straight to the bucket with a form the API signs for its
// type and size. Returns { sent }, what a note takes, or a problem naming
// the first file that failed. tell(text) says how far it has got.
export async function sendFiles(
  files: File[],
  tell: (text: string) => void
): Promise<{ sent: Sent[]; problem?: undefined } | { problem: Problem; sent?: undefined }> {
  const sent: Sent[] = [];
  for (const [i, f] of files.entries()) {
    tell(files.length > 1 ? `Sending ${i + 1} of ${files.length}…` : 'Sending the file…');
    const r = await api<{ url: string; fields: Record<string, string>; upload: string; type: string }>(
      'POST',
      '/api/uploads',
      { name: f.name, type: f.type, size: f.size }
    );
    if (!r.ok) return { problem: { error: r.data.error, file: f.name } };
    const form = new FormData();
    for (const [k, v] of Object.entries(r.data.fields)) form.append(k, v);
    form.append('file', f); // last: S3 reads the fields before the file
    let ok = false;
    try {
      ok = (await fetch(r.data.url, { method: 'POST', body: form })).ok;
    } catch {
      ok = false;
    }
    if (!ok) return { problem: { error: 'upload', file: f.name } };
    sent.push({ upload: r.data.upload, type: r.data.type, name: f.name });
  }
  return { sent };
}

// A note's file, opened from the signed link the API put on it (`url`,
// good for ten minutes at least), so a page of them is not a call to the
// API each. Past nine minutes, or when a link fails, they use the API's own
// address instead, which checks the session and redirects to a fresh link.
export const LINK_MS = 9 * 60 * 1000;

export const mediaPath = (day: string, noteId: string, n: number) =>
  `/api/days/${day}/notes/${encodeURIComponent(noteId)}/media/${n}`;

export const absolute = (href: string) => new URL(href, location.href).href;

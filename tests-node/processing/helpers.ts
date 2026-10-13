import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeInvocations } from '../../packages/testing/services.ts';
import { testImage, type Model } from '../../packages/backend/describe.ts';
import type { Item } from '../../packages/backend/store.ts';
import type { Services } from '../../workers/describe.ts';
import { marshall } from '@aws-sdk/util-dynamodb';
export const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  day = '2026-10-12',
  id = 'w-note',
  user = 'u';
export const audio = (n = 0) => ({
  n,
  key: `media/u/${day}/${id}/${n}.mp3`,
  kind: 'audio',
  type: 'audio/mpeg',
  size: 1024
});
export const photo = (n = 0) => ({
  n,
  key: `media/u/${day}/${id}/${n}.png`,
  kind: 'image',
  type: 'image/png',
  size: 1000
});
export function setup(media: Item[] = [photo()], settings: Item = { describe: true, transcribe: true }) {
  const profile = {
    pk: 'USER#u',
    sk: 'PROFILE',
    email: 'ada@example.com',
    birthday: '1972-03-05',
    tz: 'America/Chicago',
    ...settings
  };
  const note = { pk: 'USER#u', sk: `NOTE#${day}#${id}`, text: 'A synthetic fixture', media };
  const store = new FakeStore([profile, note], 'T'),
    objects = new FakeObjects(),
    invocations = new FakeInvocations(),
    calls: Item[] = [],
    logs: Item[] = [];
  const model: Model = async (body) => {
    calls.push(body);
    return { content: [{ type: 'text', text: 'A blue square.' }] };
  };
  const services: Services = {
    store,
    objects,
    invocations,
    self: 'describe:live',
    clock: () => now,
    model: async () => model,
    maker: async () => ({ body: Buffer.from('synthetic thumb'), width: 64, height: 64 }),
    log: (fields) => logs.push(fields)
  };
  return { store, objects, invocations, calls, logs, services, note, profile };
}
export async function seedPhoto(s: ReturnType<typeof setup>, n = 0) {
  await s.objects.put(String(photo(n).key), testImage(), { type: 'image/png' });
}
export const stream = (row: Item, old: Item = {}) => ({
  dynamodb: { NewImage: marshall(row), OldImage: marshall(old) }
});

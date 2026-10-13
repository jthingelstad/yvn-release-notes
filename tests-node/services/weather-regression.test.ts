/** Legacy weather replacement/rename races: provider results may never move
 * a day back to a stale place or erase a newer reading. No network is used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from '../../packages/testing/store.ts';
import * as w from '../../packages/backend/weather.ts';
import type { Item } from '../../packages/backend/store.ts';
const day = '2026-10-11',
  today = '2026-10-13',
  tz = 'America/Chicago',
  at = '2026-10-13T12:00:00Z';
const home = { city: 'Home', region: '', country: 'United States', lat: 44, lon: -93, tz };
const away = { city: 'Away', region: '', country: 'United States', lat: 46, lon: -92, tz };
const answer = { daily: { time: [day], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [2] } };
const sky = (place = home) => ({ ...place, high_c: 20, low_c: 10, code: 2 });
async function setup() {
  const store = new FakeStore();
  await store.setDayPlace('u', day, away);
  await store.putWeather('u', day, sky(home));
  return store;
}
const keep = (store: FakeStore, fetch: () => Promise<Item> = async () => answer) =>
  w.keepDay(store, 'u', home, tz, day, today, fetch, at, true);
test('weather priority keeps ordinary history, renames identical coordinates without fetch, and waits for today', async () => {
  const s = await setup();
  let calls = 0;
  const fetch = async () => {
    calls++;
    return answer;
  };
  await keep(s, fetch);
  assert.equal((await s.weatherBetween('u', day, day))[day]?.city, 'Away');
  await s.setDayPlace('u', day, { ...away, city: 'Renamed' });
  assert.equal(await keep(s, fetch), 'renamed');
  assert.equal(calls, 1);
  await s.clearDayPlace('u', day);
  assert.equal(await w.keepDay(s, 'u', { ...home, city: 'Moved home' }, tz, day, today, fetch, at), 'kept');
  assert.equal(calls, 1);
  assert.equal(await w.keepDay(s, 'u', home, tz, today, today, fetch, at, true), 'not-yet');
  assert.equal(calls, 1);
});
test('weather ignores a stale read, rechecks a place changed during fetch, and reconciles changes just before write', async () => {
  const stale = await setup(),
    read = stale.weatherBetween.bind(stale);
  let once = true;
  stale.weatherBetween = async (...args) => {
    if (once) {
      once = false;
      return {};
    }
    return read(...args);
  };
  assert.equal(await keep(stale), 'fetched');
  assert.equal((await read('u', day, day))[day]?.city, 'Away');
  const moved = await setup();
  assert.equal(
    await keep(moved, async () => {
      await moved.clearDayPlace('u', day);
      await moved.replaceWeather('u', day, sky(home));
      return answer;
    }),
    'moved'
  );
  assert.equal((await moved.weatherBetween('u', day, day))[day]?.city, 'Home');
  const late = await setup(),
    replace = late.replaceWeather.bind(late);
  once = true;
  let calls = 0;
  late.replaceWeather = async (...args) => {
    if (once) {
      once = false;
      await late.clearDayPlace('u', day);
      await replace('u', day, sky(home));
    }
    await replace(...args);
  };
  await keep(late, async () => {
    calls++;
    return answer;
  });
  assert.equal((await late.weatherBetween('u', day, day))[day]?.city, 'Home');
  assert.equal(calls, 2);
});
test('weather rename CAS preserves newer reading/name and repairs a rename immediately after its own commit', async () => {
  for (const phase of ['before-reading', 'before-name', 'after-name'] as const) {
    const s = await setup();
    await keep(s);
    await s.setDayPlace('u', day, { ...away, city: 'Requested' });
    const rename = s.renameWeather.bind(s);
    let once = true;
    s.renameWeather = async (...args) => {
      if (!once) return rename(...args);
      once = false;
      if (phase === 'before-reading') {
        await s.clearDayPlace('u', day);
        await s.replaceWeather('u', day, { ...sky(home), high_c: 1 });
        return rename(...args);
      }
      if (phase === 'before-name') {
        await s.setDayPlace('u', day, { ...away, city: 'Newer' });
        await rename('u', day, args[2], { city: 'Newer', region: '', country: 'United States' });
        return rename(...args);
      }
      const result = await rename(...args);
      await s.setDayPlace('u', day, { ...away, city: 'Newer' });
      return result;
    };
    await keep(s, async () => {
      throw new Error('Rename must not fetch');
    });
    const reading = (await s.weatherBetween('u', day, day))[day]!;
    assert.equal(reading.city, phase === 'before-reading' ? 'Home' : 'Newer');
    assert.equal(reading.high_c, phase === 'before-reading' ? 1 : 20);
  }
});
test('failed or empty weather removes only obsolete location; a concurrently refreshed reading survives', async () => {
  for (const failed of [false, true]) {
    const s = await setup();
    await keep(s);
    await s.clearDayPlace('u', day);
    try {
      await keep(s, async () => {
        if (failed) throw new Error('Provider unavailable');
        return {};
      });
    } catch {
      assert.ok(failed);
    }
    assert.deepEqual(await s.weatherBetween('u', day, day), {});
  }
  const s = await setup();
  await keep(s);
  await s.clearDayPlace('u', day);
  await assert.rejects(
    keep(s, async () => {
      await s.replaceWeather('u', day, { ...sky(home), high_c: 1 });
      throw new Error('Unavailable');
    })
  );
  assert.equal((await s.weatherBetween('u', day, day))[day]?.high_c, 1);
});

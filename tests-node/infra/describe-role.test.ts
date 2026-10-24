/** The describe function's role grants what its stream, describe_all and
 * thumbs_all runs request: thumbnails staged, tagged, or removed when the note
 * went away, a missing file skipped; the photo's place named and its weather kept; the key read from
 * the runtime secret; descriptions leased and kept; and each hand-on to itself
 * (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeInvocations } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store.ts';
import * as describe from '../../packages/backend/describe.ts';
import { namePhoto } from '../../packages/backend/places.ts';
import * as worker from '../../workers/describe.ts';
import { stream } from '../processing/helpers.ts';
import { Recorder, REGION, ACCOUNT } from './grants.ts';

const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  day = '2026-10-12';
const photo = (id: string, n = 0) => ({
  n,
  key: `media/u/${day}/${id}/${n}.png`,
  kind: 'image',
  type: 'image/png',
  size: 1000,
  place: { lat: 40, lon: -75 }
});
const note = (id: string, media: Item[] = [photo(id)]): Item => ({
  pk: 'USER#u',
  sk: `NOTE#${day}#${id}`,
  text: 'A synthetic fixture',
  media
});
const forecast = { daily: { time: [day], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [2] } };

test('the describe role grants every request a stream record, describe_all and thumbs_all make', async () => {
  const aws = new Recorder('DescribeFunction'),
    profile = {
      pk: 'USER#u',
      sk: 'PROFILE',
      email: 'ada@example.com',
      birthday: '1972-03-05',
      tz: 'America/Chicago',
      city: 'Home',
      lat: 44,
      lon: -93
    },
    store = new FakeStore([
      { ...profile, describe: true },
      note('a'),
      note('b'),
      note('c'),
      note('gone'),
      note('lost')
    ]),
    files = new FakeObjects(),
    // The real secret and geocoding adapters, over clients that record each
    // command as IAM authorizes it. The secret is a made-up string.
    secrets = worker.createSecretSource({
      async send(command: { input: { SecretId: string } }) {
        aws.add(
          'secrets.get',
          'secretsmanager:GetSecretValue',
          `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${command.input.SecretId}-AbCdEf`
        );
        return { SecretString: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-synthetic' }) };
      }
    } as never),
    geo = {
      async send() {
        aws.add('places.namePhoto', 'geo-places:ReverseGeocode', `arn:aws:geo-places:${REGION}::provider/default`);
        return { ResultItems: [{ Address: { Locality: 'Example', Country: { Code2: 'US' } } }] };
      }
    },
    invocations = new FakeInvocations(),
    gone = { pending: false },
    services: worker.Services = {
      store: aws.watch(store),
      objects: aws.objects(files),
      invocations: aws.invocations(invocations),
      self: aws.env.SELF!,
      clock: () => now,
      maker: async () => {
        // A note deleted while its thumbnail is made: the thumbnail goes too.
        if (gone.pending) await aws.aside(store, null, () => store.deleteNote('u', day, 'gone'));
        return { body: Buffer.from('synthetic thumb'), width: 64, height: 64 };
      },
      geocode: (lat, lon) => namePhoto(lat, lon, geo as never),
      weatherFetch: async () => forecast,
      model: async () => {
        await describe.keyFrom(secrets, aws.env.SECRET!);
        return async () => ({ content: [{ type: 'text', text: 'A blue square.' }] });
      }
    };
  for (const id of ['a', 'b', 'c', 'gone']) await files.put(photo(id).key, describe.testImage(), { type: 'image/png' });

  await worker.runEvent({ Records: [stream(note('a'))] }, {}, services);
  const a = store.memory.read({ pk: 'USER#u', sk: `NOTE#${day}#a` })!,
    [shown] = a.media as Item[];
  assert.equal(shown?.description, 'A blue square.');
  assert.equal((shown!.thumb as Item).key, `media/u/${day}/a/0.thumb.jpg`);
  assert.equal((a.place as Item).city, 'Example');
  assert.ok(store.memory.read({ pk: 'USER#u', sk: `WEATHER#${day}` }));
  // A photo whose file is missing reads as 404 and is skipped.
  await worker.runEvent({ Records: [stream(note('lost'))] }, {}, services);
  gone.pending = true;
  await worker.runEvent({ Records: [stream(note('gone'))] }, {}, services);
  gone.pending = false;
  assert.ok(files.calls.some((c) => c.operation === 'remove' && c.key === `media/u/${day}/gone/0.thumb.jpg`));
  // Turning descriptions on hands describe_all to itself; with little time
  // left it hands on again.
  await worker.runEvent({ Records: [stream({ ...profile, describe: true }, profile)] }, {}, services);
  await worker.runEvent({ describe_all: 'u' }, { getRemainingTimeInMillis: () => 1000 }, services);
  await worker.runEvent({ describe_all: 'u' }, {}, services);
  await worker.runEvent({ thumbs_all: '*', dry_run: true }, {}, services);
  await worker.runEvent({ thumbs_all: '*' }, {}, services);
  assert.deepEqual(
    invocations.calls.map((c) => Object.keys(c.payload as Item)[0]),
    ['describe_all', 'describe_all']
  );

  const made = aws.granted(),
    actions = new Set(made.map((r) => r.action));
  for (const action of [
    's3:GetObject',
    's3:PutObject',
    's3:PutObjectTagging',
    's3:DeleteObject',
    'secretsmanager:GetSecretValue',
    'geo-places:ReverseGeocode',
    'lambda:InvokeFunction',
    'dynamodb:Scan',
    'dynamodb:ConditionCheckItem',
    'dynamodb:GetRecords'
  ])
    assert.ok(actions.has(action), action);
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});

/** Manual owner-requested archive output only. This prints note text locally;
 * agents must never invoke it to inspect live subscribers or copy output to logs. */
import { combine, writtenAt } from '../packages/domain/notes.ts';
import { parseDay } from '../packages/domain/dates.ts';
import type { Store, Item } from '../packages/backend/store.ts';
import { argumentsFor, invoked, launch, runtime, subscriber, query, OperatorError } from './operator.ts';
export async function report(store: Store, user: string, day?: string): Promise<string> {
  if (day) parseDay(day);
  const items = await query(store, user, day ? `NOTE#${day}#` : 'NOTE#', {
      ProjectionExpression: 'sk, #t, #v, written_at, received_at, author, client',
      ExpressionAttributeNames: { '#t': 'text', '#v': 'version' }
    }),
    days = new Map<string, Item[]>();
  for (const item of items) {
    const day = String(item.sk).split('#')[1]!;
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  if (!days.size) return 'no notes';
  const blocks: string[] = [];
  for (const [day, notes] of [...days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    notes.sort((a, b) =>
      writtenAt(a) < writtenAt(b) ? -1 : writtenAt(a) > writtenAt(b) ? 1 : String(a.sk) < String(b.sk) ? -1 : 1
    );
    blocks.push(
      `${notes[0]?.version ?? '?'}  ${day}  (${notes.length > 1 ? `${notes.length} replies` : '1 reply'})\n\n${combine(notes) || '(no text)'}\n`
    );
  }
  return blocks.join('\n');
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args);
  if (values.help) {
    console.log('tools/read-notes.ts EMAIL [YYYY-MM-DD] — private owner-requested text (read only)');
    return;
  }
  if (positionals.length < 1 || positionals.length > 2 || values.write)
    throw new OperatorError('Usage: tools/read-notes.ts EMAIL [YYYY-MM-DD]');
  const s = await runtime(),
    [user] = await subscriber(s.store, positionals[0]!);
  console.log(await report(s.store, user, positionals[1]));
}
if (invoked(import.meta.url)) await launch(main);

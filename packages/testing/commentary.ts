/** A fictional Claude for the dev server and browser tests: commentary made
 * from the book's shape alone (its months and dates), never from its words,
 * and no call to any service. */
import type { Writer } from '../book/commentary.ts';

export const fakeWriter: Writer = async (request) => {
  const content = String(request.messages[0]?.content ?? ''),
    book = JSON.parse(content.slice(content.indexOf('{'))) as {
      months: { month: string; days: { date: string }[] }[];
    },
    days = book.months.flatMap((m) => m.days);
  return {
    text: JSON.stringify({
      introduction: `A fictional introduction to ${days.length} ${days.length === 1 ? 'day' : 'days'}.\n\nWritten by the dev server, not by Claude.`,
      months:
        book.months.length > 1
          ? book.months.map((m) => ({ month: m.month, opening: `A fictional opening for ${m.month}.` }))
          : [],
      days: days.slice(0, 1).map((d) => ({ date: d.date, note: 'A fictional note beside this day.' })),
      afterword: 'A fictional afterword.'
    }),
    stop: 'end_turn',
    usage: { input: content.length, output: 100 }
  };
};

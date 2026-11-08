// The tags field: Enter or Tab makes a chip, a refusal says why, and each
// chip's remove button is named for assistive technology.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '../lib/tags.ts';
import { TagField } from './tag-field.tsx';

afterEach(cleanup);

function Field({ start = [], onSubmit }: { start?: Tag[]; onSubmit?: () => void }) {
  const [tags, setTags] = useState<Tag[]>(start);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <TagField
        tags={tags}
        onAdd={(t) => setTags([...tags, t])}
        onRemove={(t) => setTags(tags.filter((x) => x.key !== t.key))}
      />
      <input name="next" aria-label="Next" />
    </form>
  );
}
const chips = () => screen.queryAllByRole('listitem').map((li) => li.textContent);

describe('TagField', () => {
  it('makes a chip on Enter, without its #, and never sends the form', async () => {
    const sent = vi.fn();
    render(<Field onSubmit={sent} />);
    const box = screen.getByRole('textbox', { name: 'Tags' });
    await userEvent.type(box, '#Road Trip{Enter}');
    expect(chips()).toEqual(['Road Trip']);
    expect(box).toHaveProperty('value', '');
    await userEvent.type(box, '{Enter}');
    expect(sent).not.toHaveBeenCalled();
  });

  it('makes a chip on Tab and moves on', async () => {
    render(<Field />);
    const box = screen.getByRole('textbox', { name: 'Tags' });
    await userEvent.type(box, 'lake');
    await userEvent.tab();
    expect(chips()).toEqual(['lake']);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Next' }));
  });

  it('keeps one already there, by any spelling, as it is', async () => {
    render(<Field start={[{ key: 'road-trip', name: 'Road Trip' }]} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Tags' }), 'road trip{Enter}');
    expect(chips()).toEqual(['Road Trip']);
  });

  it('says why it refuses one, and keeps what was typed', async () => {
    render(<Field />);
    const box = screen.getByRole('textbox', { name: 'Tags' });
    await userEvent.type(box, 'lake, cabin{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('A tag has no commas. Add each tag on its own.');
    expect(box).toHaveProperty('value', 'lake, cabin');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(chips()).toEqual([]);
    await userEvent.clear(box);
    await userEvent.type(box, 'x'.repeat(51));
    await userEvent.tab();
    expect(screen.getByRole('alert').textContent).toBe('A tag is at most 50 characters.');
    expect(document.activeElement).toBe(box);
  });

  it('refuses a 21st tag', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ key: `t${i}`, name: `t${i}` }));
    render(<Field start={twenty} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Tags' }), 'one more{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('That’s 20 tags, the most one can have. Take one off first.');
    expect(chips()).toHaveLength(20);
  });

  it('names each remove button for its tag, and goes back to the box', async () => {
    render(
      <Field
        start={[
          { key: 'road-trip', name: 'Road Trip' },
          { key: 'lake', name: 'lake' }
        ]}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove tag Road Trip' }));
    expect(chips()).toEqual(['lake']);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Tags' }));
  });
});

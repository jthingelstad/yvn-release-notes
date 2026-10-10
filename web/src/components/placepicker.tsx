// The city field on setup and settings: a search over /api/places, as a
// React Aria autocomplete. The arrow keys move through the places, Enter
// picks, and a screen reader hears each one (the field points at the
// active place). The places stay on the page under the field; React Aria's
// ComboBox would want a popover, and hides the rest of the page while open.
// Calls onPick(place) with the choice, and onClear() when the text changes
// after a pick. "No city by that name" and failures go to the picker's
// status line, outside the listbox. A new `key` starts it over.
import { useEffect, useRef, useState } from 'react';
import { Autocomplete, Input, type Key, Label, ListBox, ListBoxItem, TextField } from 'react-aria-components';
import { api } from '../lib/api.ts';
import { SAY, signedOutLine, type Line } from '../lib/say.ts';
import type { Place } from '../lib/types.ts';
import { LineText } from './common.tsx';

const placeKey = (p: Place) => [p.name, p.region, p.country, p.tz].join('|');

export function PlacePicker({
  label,
  placeholder,
  required,
  inputRef,
  onPick,
  onClear = () => {}
}: {
  label: string;
  placeholder: string;
  required?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onPick: (p: Place) => void;
  onClear?: () => void;
}) {
  const [q, setQ] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [picked, setPicked] = useState<Place | null>(null);
  const [status, setStatus] = useState<Line>('');
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const type = (value: string) => {
    // A pick puts the place's name in the field: that is not typing.
    if (picked && value === picked.name) return setQ(value);
    setQ(value);
    clearTimeout(timer.current);
    if (picked) {
      setPicked(null);
      onClear();
    }
    setStatus('');
    const query = value.trim();
    if (query.length < 2) {
      ++asked.current;
      setPlaces([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const mine = ++asked.current;
      const r = await api<{ places: Place[] }>('GET', '/api/places?q=' + encodeURIComponent(query));
      if (mine !== asked.current) return; // a later search has gone out
      if (!r.ok) {
        setPlaces([]);
        setStatus(
          r.data.error === 'signed-out' ? signedOutLine() : (r.data.error && SAY[r.data.error]) || SAY['places-failed']
        );
        return;
      }
      if (!r.data.places.length) {
        setPlaces([]);
        setStatus('No city by that name. Try the nearest larger one.');
        return;
      }
      setPlaces(r.data.places);
    }, 300);
  };

  const pick = (key: Key | null) => {
    const p = places.find((p) => placeKey(p) === key);
    if (!p) return;
    setPicked(p);
    setQ(p.name);
    onPick(p);
  };

  return (
    // The places come a moment after the typing, so nothing is focused for
    // the keyboard until an arrow key: the first one is the first place.
    <Autocomplete inputValue={q} onInputChange={type} disableAutoFocusFirst>
      <TextField className="place-field" isRequired={required}>
        <Label>
          {label}
          <Input ref={inputRef} name="city" placeholder={placeholder} />
        </Label>
      </TextField>
      <div>
        <ListBox
          className="places"
          aria-label="Places"
          items={places}
          selectionMode="single"
          selectedKeys={picked ? [placeKey(picked)] : []}
          onSelectionChange={(keys) => keys !== 'all' && pick([...keys][0] ?? null)}
        >
          {(p: Place) => (
            <ListBoxItem id={placeKey(p)} className="place" textValue={p.name}>
              {({ isSelected }) => (
                <>
                  <span className="mark">{isSelected ? '•' : ''}</span>
                  <span>
                    <span className="name">{p.name}</span>
                    <span className="where">{[p.region, p.country].filter(Boolean).join(', ')}</span>
                  </span>
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
        <p className="hint places-status" role="status">
          <LineText line={status} />
        </p>
      </div>
    </Autocomplete>
  );
}

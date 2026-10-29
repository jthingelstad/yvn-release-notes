// The owner's profile photo where the page shows who is signed in (the You
// tab, the You page, Settings), or the "you" glyph when there is none or it
// fails to load. The picture is decoration: whatever it sits beside names it.
import { useState } from 'react';
import { photoSrc } from '../lib/photo.ts';
import { Icon } from './icon.tsx';

export function Avatar({ photo, className = '' }: { photo?: { at: string }; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!photo || failed === photo.at) return <Icon name="you" />;
  return (
    <img
      className={`avatar ${className}`.trim()}
      src={photoSrc(photo)}
      alt=""
      width={512}
      height={512}
      decoding="async"
      onError={() => setFailed(photo.at)}
    />
  );
}

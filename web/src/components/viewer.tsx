// A photo opened over the page, as large as the window allows, with Close
// (Jamie, 2026-10-09: "a popup at a larger size with a 'close' option to
// not lose the current page"). One <dialog> for every photo: Escape and a
// click outside the photo close it too, and focus goes back to the photo
// that opened it. A link that has run out tries the API's address once.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { absolute } from '../lib/files.ts';

interface Shown {
  href: string;
  fallback: string;
  alt: string;
}

const ViewerContext = createContext<(photo: Shown) => void>(() => {});

export const useViewer = () => useContext(ViewerContext);

export function ViewerProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const open = useCallback((photo: Shown) => {
    setShown(photo);
    dialog.current?.showModal();
  }, []);
  const close = () => dialog.current?.close();
  return (
    <ViewerContext.Provider value={open}>
      {children}
      <dialog
        ref={dialog}
        className="viewer"
        aria-label="Photo"
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
        onClose={() => setShown(null)}
      >
        <button className="close" type="button" onClick={close}>
          Close
        </button>
        {shown && (
          <img
            src={shown.href}
            alt={shown.alt}
            onError={(e) => {
              const img = e.currentTarget;
              const api = absolute(shown.fallback);
              if (img.src && img.src !== api) img.src = api;
            }}
          />
        )}
      </dialog>
    </ViewerContext.Provider>
  );
}

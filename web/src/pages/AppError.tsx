// What a page shows when it breaks: a render that threw, or a page's code
// that would not load. Nothing technical, just a way on, and both ways load
// the app afresh. Loaded with the
// app itself, since its own code failing to load is one of the reasons.
import type { ErrorComponentProps } from '@tanstack/react-router';
import { Bar, useTitle } from '../components/common.tsx';

export function AppError(_: ErrorComponentProps) {
  useTitle('Something went wrong');
  return (
    <>
      <Bar nav={false} />
      <h1 className="top">Something went wrong.</h1>
      <p className="lede">
        This page didn’t load properly. Your notes are safe. Try again, or <a href="/today/">go to today</a>.
      </p>
      <div className="row">
        <button className="go" type="button" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    </>
  );
}

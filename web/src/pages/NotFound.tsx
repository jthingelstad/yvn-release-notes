// An address that is no page here.
import { AppLink, Bar, useTitle } from '../components/common.tsx';

export function NotFound() {
  useTitle('Not found');
  return (
    <>
      <Bar nav={false} />
      <h1 className="top">Nothing here.</h1>
      <p className="lede">
        That address isn’t a page of Release Notes. <AppLink href="/">Start at the front page</AppLink>.
      </p>
    </>
  );
}

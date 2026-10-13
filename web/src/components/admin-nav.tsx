// The two administrator pages share the same session and API authorization.
import { AppLink } from './common.tsx';
export function AdminNav({ current }: { current: 'updates' | 'users' }) {
  return (
    <nav className="row admin-nav" aria-label="Administration">
      <AppLink href="/admin/" aria-current={current === 'updates' ? 'page' : undefined}>
        Product updates
      </AppLink>
      <AppLink href="/admin-users/" aria-current={current === 'users' ? 'page' : undefined}>
        Users
      </AppLink>
      <AppLink href="/settings/">Back to settings</AppLink>
    </nav>
  );
}

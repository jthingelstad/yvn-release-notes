// Native disclosures keep the page navigable by keyboard and reveal one set
// of decisions at a time. Opening a group never changes a stored setting.
import type { ReactNode } from 'react';

export function SettingsGroup({
  id,
  title,
  description,
  defaultOpen = false,
  children
}: {
  id: string;
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="settings-group" id={id} open={defaultOpen || undefined}>
      <summary>
        <svg className="settings-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="settings-group-label">
          <h2>{title}</h2>
          <span className="hint">{description}</span>
        </span>
      </summary>
      <div className="settings-group-body">{children}</div>
    </details>
  );
}

// The emailed link's page says whose account it opens (SIGNIN-3).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkAccount } from './SignIn.tsx';

afterEach(cleanup);

describe('LinkAccount', () => {
  it('names the address the link signs in, with no warning when the browser is in no other account', () => {
    render(<LinkAccount email="ada@example.com" signed_in_as={null} />);
    expect(screen.getByText(/^This link signs in as/).textContent).toBe('This link signs in as ada@example.com.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('says nothing more when the browser is already in that account', () => {
    render(<LinkAccount email="ada@example.com" signed_in_as="ada@example.com" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('warns when the browser is in another account', () => {
    render(<LinkAccount email="eve@example.com" signed_in_as="ada@example.com" />);
    expect(screen.getByRole('alert').textContent).toBe(
      'This browser is signed in as ada@example.com. Signing in here switches it to eve@example.com. If you didn’t ask for this link, don’t use it.'
    );
  });
});

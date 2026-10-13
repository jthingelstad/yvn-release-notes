import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as auth from '../../packages/backend/auth.ts';

test('legacy ownership hashes, tokens, cookie and IPv6 network keys remain compatible', () => {
  assert.equal(auth.digest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const token = auth.newToken();
  assert.equal(auth.validToken(token), token);
  assert.equal(auth.cookieToken(auth.sessionCookie(token).split(';')), token);
  assert.equal(auth.normalEmail(' Ada+work@Example.COM '), 'ada+work@example.com');
  assert.equal(auth.limitAddress('ada+work@example.com'), 'ada@example.com');
  assert.equal(auth.network('2001:db8:abcd:1234:5678::1'), '2001:db8:abcd:1234::/64');
  assert.equal(auth.network('2001:db8:abcd:1234:5678::1', 48), '2001:db8:abcd::/48');
  assert.equal(auth.network('198.51.100.12'), '198.51.100.12');
  assert.equal(auth.validCode('012 345'), '012345');
  assert.equal(auth.validCode('１２３４５６'), null);
  assert.equal(auth.same('token', 'token'), true);
  assert.equal(auth.same('token', 'tokens'), false);
});

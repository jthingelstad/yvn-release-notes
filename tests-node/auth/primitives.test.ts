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
test('only plain addresses pass, and Gmail’s dots and googlemail.com count as one address', () => {
  for (const odd of [
    'junk,victim@example.com',
    '1<victim@example.com>',
    '"a b"@example.com',
    'a..b@example.com',
    '.a@example.com',
    'a@example',
    'a@192.0.2.1',
    'a@-example.com',
    'ädä@example.com',
    'a@exämple.com',
    'a(c)@example.com',
    'a@b@example.com',
    `${'x'.repeat(65)}@example.com`
  ])
    assert.equal(auth.normalEmail(odd), null, odd);
  assert.equal(auth.normalEmail(" O'Brien@Example.co.uk "), "o'brien@example.co.uk");
  assert.equal(auth.normalEmail('a@xn--bcher-kva.example'), 'a@xn--bcher-kva.example');
  assert.equal(auth.limitAddress('a.d.a+news@googlemail.com'), 'ada@gmail.com');
  assert.equal(auth.limitAddress('A.da@gmail.com'.toLowerCase()), 'ada@gmail.com');
  assert.equal(auth.limitAddress('a.da+x@example.com'), 'a.da@example.com');
  assert.equal(auth.bounceKey('x@googlemail.com'), auth.bounceKey('y@gmail.com'));
  assert.equal(auth.bounceKey('x@example.com'), 'bounces:' + auth.digest('example.com'));
});

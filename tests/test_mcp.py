"""Connection boundary tests, using fictional accounts only."""
import base64
import hashlib
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs
from unittest.mock import patch

from release_notes import auth, capture, mcp, oauth, web
from test_web import WebCase, request, ORIGIN
from test_store import Store, FakeTable, FakeClient, Cancelled


class ConnectionCase(WebCase):
    def setUp(self):
        super().setUp()
        self.subscribe()
        self.cookie = self.signed_in()
        self.verifier = 'v' * 43
        self.challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip('=')
        self.redirect = 'https://claude.ai/api/mcp/auth_callback'
        self.target = ORIGIN + '/mcp'

    def protocol(self, method, path, body=None, query=None):
        event = request(method, path, body, query=query, origin=None)
        if path in ('/oauth/token', '/oauth/revoke'):
            event['body'] = urlencode(body or {})
            event['headers']['content-type'] = 'application/x-www-form-urlencoded'
        with redirect_stdout(self.out):
            r = web.handler(event, None, store=self.store, ses=self.ses, s3=self.s3, clock=lambda: self.now)
        return r, json.loads(r['body']) if r['body'] else {}

    def pending(self, scope='notes:read media:read', client_name='Claude'):
        r, client = self.protocol('POST', '/oauth/register', {'client_name': client_name, 'redirect_uris': [self.redirect]})
        self.assertEqual(r['statusCode'], 201)
        cid = client['client_id']
        r, _ = self.protocol('GET', '/oauth/authorize', query={'client_id': cid, 'redirect_uri': self.redirect,
            'response_type': 'code', 'resource': self.target, 'scope': scope, 'state': 'state-123',
            'code_challenge_method': 'S256', 'code_challenge': self.challenge})
        self.assertEqual(r['statusCode'], 303)
        pending = parse_qs(urlsplit(r['headers']['location']).fragment)['request'][0]
        return cid, pending

    def consent(self, media=True, write=False, client_name='Claude'):
        cid, pending = self.pending('notes:read media:read notes:write' if write else 'notes:read media:read', client_name)
        r, b = self.call('POST', '/api/mcp/authorize', {'request': pending, 'approve': True, 'media': media, 'write': write}, cookies=[self.cookie])
        self.assertEqual(r['statusCode'], 200)
        query = parse_qs(urlsplit(b['redirect']).query)
        self.assertEqual(query['state'], ['state-123'])
        return {'grant_type': 'authorization_code', 'code': query['code'][0], 'client_id': cid,
                'resource': self.target, 'redirect_uri': self.redirect, 'code_verifier': self.verifier}

    def connected(self, media=True, write=False, client_name='Claude'):
        code = self.consent(media, write, client_name)
        r, tokens = self.protocol('POST', '/oauth/token', code)
        self.assertEqual(r['statusCode'], 200, tokens)
        return tokens, code['client_id']

    def rpc(self, token, method='tools/call', name='notes_context', arguments=None, **extra):
        event = request('POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': method,
            'params': {'name': name, 'arguments': arguments or {}} if method == 'tools/call' else extra}, origin=None)
        event['headers'].update(authorization='Bearer ' + token, **{'content-type': 'application/json'})
        with redirect_stdout(self.out):
            r = mcp.handler(event, None, store=self.store, s3=self.s3, clock=lambda: self.now,
                writer=lambda e: capture.handler(e, None, store=self.store, clock=lambda: self.now, fetch=lambda url: None))
        body = json.loads(r['body'])
        if r['statusCode'] == 200 and method == 'tools/call' and 'structuredContent' in body.get('result', {}):
            schema = next((t['outputSchema'] for t in mcp.TOOLS if t['name'] == name), None)
            if schema:
                output = body['result']['structuredContent']
                self.assertLessEqual(set(output), set(schema['properties']))
                for key, value in output.items():
                    kinds = schema['properties'][key]['type']
                    kinds = [kinds] if isinstance(kinds, str) else kinds
                    types = {'string': str, 'integer': int, 'boolean': bool, 'array': list, 'object': dict, 'null': type(None)}
                    self.assertIn(type(value), [types[k] for k in kinds])
        return r, body

    def add_note(self, text='Café by the lake #Maine-2016', day='2026-10-07', id='w-first', **fields):
        self.store.add_note('u1', day, id, text=text, written_at=day + 'T12:00:00Z', **fields)


class OAuthTests(ConnectionCase):
    def test_discovery_and_unauthenticated_challenge(self):
        for path in ('/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp'):
            r, body = self.protocol('GET', path)
            self.assertEqual(r['statusCode'], 200)
            self.assertIn('notes:read', body['scopes_supported'])
        r = mcp.handler(request('POST', '/mcp'), None, store=self.store, clock=lambda: self.now)
        self.assertEqual(r['statusCode'], 401)
        self.assertIn('resource_metadata', r['headers']['www-authenticate'])

    def test_registration_rejects_unsafe_redirects_and_secrets(self):
        for uri in ('http://example.com/cb', 'https://user:pass@example.com/cb', 'javascript:alert(1)', 'https://example.com/cb#fragment', 'https://example.com/cb#', 'https://example.com:99999/cb', 'https://example.com/\ncb'):
            self.assertEqual(self.protocol('POST', '/oauth/register', {'redirect_uris': [uri]})[0]['statusCode'], 400)
        self.assertEqual(self.protocol('POST', '/oauth/register', {'redirect_uris': [self.redirect], 'token_endpoint_auth_method': 'client_secret_post'})[0]['statusCode'], 400)
        self.assertEqual(self.protocol('POST', '/oauth/register', {'redirect_uris': ['http://127.0.0.1:9999/cb']})[0]['statusCode'], 201)

    def test_authorize_rejects_redirect_scope_resource_pkce(self):
        cid, _ = self.pending()
        good = {'client_id': cid, 'redirect_uri': self.redirect, 'response_type': 'code', 'resource': self.target,
                'scope': 'notes:read', 'code_challenge_method': 'S256', 'code_challenge': self.challenge}
        for change in ({'redirect_uri': 'https://evil.example/cb'}, {'resource': ORIGIN + '/api/me'}, {'scope': 'notes:write'},
                       {'code_challenge_method': 'plain'}, {'code_challenge': 'short'}):
            r, _ = self.protocol('GET', '/oauth/authorize', query={**good, **change})
            self.assertEqual(r['statusCode'], 400)
            self.assertNotIn('location', r['headers'])

    def test_consent_requires_session_origin_and_single_use(self):
        _, pending = self.pending()
        b = {'request': pending, 'approve': True}
        self.assertEqual(self.call('POST', '/api/mcp/authorize', b)[0]['statusCode'], 401)
        self.assertEqual(self.call('POST', '/api/mcp/authorize', b, cookies=[self.cookie], origin='https://evil.example')[0]['statusCode'], 403)
        self.assertEqual(self.call('POST', '/api/mcp/authorize', b, cookies=[self.cookie])[0]['statusCode'], 200)
        self.assertEqual(self.call('POST', '/api/mcp/authorize', b, cookies=[self.cookie])[0]['statusCode'], 400)

    def test_deny_and_pending_expiry(self):
        _, pending = self.pending()
        _, b = self.call('POST', '/api/mcp/authorize', {'request': pending, 'approve': False}, cookies=[self.cookie])
        self.assertIn('error=access_denied', b['redirect'])
        self.assertFalse(any(k[0].startswith('OAUTHFAMILY#') for k in self.store.mcp_items))
        _, pending = self.pending()
        self.now += 601
        self.assertEqual(self.call('POST', '/api/mcp/authorize', {'request': pending}, cookies=[self.cookie])[0]['statusCode'], 400)

    def test_pkce_resource_client_redirect_and_code_single_use(self):
        code = self.consent()
        for change in ({'resource': ORIGIN + '/wrong'}, {'client_id': 'wrong'}, {'redirect_uri': self.redirect + '/wrong'}, {'code_verifier': 'x' * 43}):
            self.assertEqual(self.protocol('POST', '/oauth/token', {**code, **change})[0]['statusCode'], 400)
        r, tokens = self.protocol('POST', '/oauth/token', code)
        self.assertEqual(r['statusCode'], 200)
        self.assertEqual(self.protocol('POST', '/oauth/token', code)[0]['statusCode'], 400)
        stored = json.dumps(list(self.store.mcp_items.values()))
        for secret in (tokens['access_token'], tokens['refresh_token'], code['code']):
            self.assertNotIn(secret, stored)
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 200)

    def test_code_and_access_expiry_do_not_depend_on_ttl(self):
        code = self.consent()
        self.now += 301
        self.assertEqual(self.protocol('POST', '/oauth/token', code)[0]['statusCode'], 400)
        tokens, _ = self.connected()
        self.now += 3601
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 401)

    def test_refresh_rotation_replay_and_index_expiry(self):
        tokens, cid = self.connected()
        self.now += 100
        refresh = {'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token'], 'client_id': cid, 'resource': self.target}
        r, second = self.protocol('POST', '/oauth/token', refresh)
        self.assertEqual(r['statusCode'], 200)
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 401)
        self.assertEqual(self.rpc(second['access_token'])[0]['statusCode'], 200)
        family = oauth.bearer(web.App(self.store, None, self.now), second['access_token'])
        index = self.store.mcp_get('OAUTHUSER#u1', 'ROW#OAUTHFAMILY#' + family['id'])
        self.assertEqual(index['expires_at'], family['expires_at'])
        self.assertEqual(self.protocol('POST', '/oauth/token', refresh)[0]['statusCode'], 400)
        self.assertEqual(self.rpc(second['access_token'])[0]['statusCode'], 401)

    def test_refresh_atomic_conflict_revokes_winner(self):
        tokens, cid = self.connected()
        original = self.store.mcp_commit
        def conflict(changes, uid=None):
            if any(r['pk'].startswith('OAUTHREFRESH#') and r.get('used') for r, _ in changes):
                return False
            return original(changes, uid)
        with patch.object(self.store, 'mcp_commit', side_effect=conflict):
            r, _ = self.protocol('POST', '/oauth/token', {'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token'], 'client_id': cid, 'resource': self.target})
        self.assertEqual(r['statusCode'], 400)
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 401)

    def test_disconnect_owner_only_and_no_web_bearer_writes(self):
        tokens, _ = self.connected()
        _, listed = self.call('GET', '/api/mcp/connections', cookies=[self.cookie])
        fid = listed['connections'][0]['id']
        self.subscribe('bea@example.com', 'u2')
        other = self.signed_in('bea@example.com')
        self.call('DELETE', '/api/mcp/connections/' + fid, cookies=[other])
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 200)
        event = request('PUT', '/api/me', {'transcribe': True})
        event['headers']['authorization'] = 'Bearer ' + tokens['access_token']
        self.assertEqual(web.handler(event, None, store=self.store, clock=lambda: self.now)['statusCode'], 401)
        self.call('DELETE', '/api/mcp/connections/' + fid, cookies=[self.cookie])
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 401)

    def test_deleted_and_deleting_accounts_fail_closed_and_purge(self):
        tokens, _ = self.connected()
        self.rpc(tokens['access_token'])
        app = web.App(self.store, None, self.now)
        oauth.delete_user(app, 'u1')
        self.assertTrue(self.store.profile('u1')['mcp_deleting'])
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 401)
        self.assertFalse(any(k[0].startswith(('OAUTHACCESS#', 'OAUTHREFRESH#', 'OAUTHFAMILY#', 'OAUTHCODE#', 'OAUTHUSER#', 'MCPMETA#')) for k in self.store.mcp_items))
        self.assertFalse(self.store.mcp_commit([(oauth.row('MCPMETA#u1', expires_at=self.now + 1), None)], 'u1'))
        del self.store.profiles['u1']
        self.assertFalse(self.store.mcp_commit([(oauth.row('OAUTHFAMILY#later'), None)], 'u1'))

    def test_stopped_subscriber_can_read_without_processing_changes(self):
        tokens, _ = self.connected(False)
        self.store.update_profile('u1', {'status': 'stopped', 'transcribe': False, 'describe': False})
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 200)
        self.assertFalse(self.store.profile('u1')['transcribe'])
        self.assertFalse(self.store.profile('u1')['describe'])

    def test_actual_account_delete_removes_all_grants(self):
        tokens, _ = self.connected()
        self.rpc(tokens['access_token'])
        self.call('POST', '/api/me/delete-code', cookies=[self.cookie])
        from email import message_from_bytes
        from email.policy import default
        import re
        msg = message_from_bytes(self.ses.sent[-1]['Content']['Raw']['Data'], policy=default)
        code = re.search(r"(\d{6})", msg['Subject']).group(1)
        r, _ = self.call('DELETE', '/api/me', {'code': code}, cookies=[self.cookie])
        self.assertEqual(r['statusCode'], 200)
        self.assertIsNone(self.store.profile('u1'))
        self.assertEqual(self.rpc(tokens['access_token'])[0]['statusCode'], 401)
        self.assertFalse(self.store.mcp_rows('OAUTHUSER#u1'))
        self.assertFalse(self.store.mcp_rows('MCPMETA#u1'))

    def test_origin_proof_even_for_discovery(self):
        with patch.dict(os.environ, {'ORIGIN_SECRET': 'fictional-origin-proof'}):
            self.assertEqual(self.protocol('GET', '/.well-known/oauth-authorization-server')[0]['statusCode'], 403)
            self.assertEqual(mcp.handler(request('POST', '/mcp'), None, store=self.store)['statusCode'], 403)


class ReaderTests(ConnectionCase):
    def test_list_search_day_note_context_tags_and_order(self):
        self.add_note(place={'city': 'Boston'}, media=[{'n': 1, 'kind': 'audio', 'type': 'audio/wav', 'key': 'media/u1/a.wav', 'transcript': 'A canoe crossing'}])
        self.add_note('Old words #Maine-2016', day='2016-06-14', id='imported')
        self.store.add_note('u1', '2026-10-07', 'w-last', text='Second note', written_at='2026-10-07T23:00:00Z')
        tokens, _ = self.connected()
        token = tokens['access_token']
        def read(name, args=None):
            r, b = self.rpc(token, name=name, arguments=args)
            self.assertEqual(r['statusCode'], 200, b)
            self.assertNotIn('isError', b['result'], b)
            return b['result']['structuredContent']
        context = read('notes_context')
        self.assertEqual(context['first_note_day'], '2016-06-14')
        self.assertNotIn('email', context)
        self.assertNotIn('birthday', context)
        for q in ('cafe', 'canoe', 'Boston', '"by the lake"'):
            self.assertEqual(read('notes_search', {'q': q})['total'], 1)
        self.assertEqual(read('notes_search', {'tag': 'maine-2016'})['total'], 2)
        listed = read('notes_list', {'limit': 1})
        self.assertEqual(listed['notes'][0]['id'], 'w-last')
        self.assertIsNotNone(listed['next_cursor'])
        next_page = read('notes_list', {'limit': 1, 'cursor': listed['next_cursor']})
        self.assertEqual(next_page['notes'][0]['id'], 'w-first')
        day = read('notes_get_day', {'date': '2026-10-07'})
        self.assertEqual([n['id'] for n in day['notes']], ['w-first', 'w-last'])
        note = read('notes_get_note', {'date': '2026-10-07', 'id': 'w-first'})['note']
        self.assertTrue(note['media'][0]['has_transcript'])
        self.assertNotIn('key', note['media'][0])
        self.assertEqual(read('notes_tags')['tags'], [{'tag': 'maine-2016', 'notes': 2}])
        self.assertEqual(read('notes_list', {'release': '3.5'})['total'], 1)

    def test_arguments_cannot_select_another_account_or_unknown_fields(self):
        self.add_note()
        self.subscribe('bea@example.com', 'u2')
        self.store.add_note('u2', '2026-10-07', 'secret', text='not yours')
        tokens, _ = self.connected()
        for name, args in [('notes_list', {'user_id': 'u2'}), ('notes_list', {'limit': True}), ('notes_search', {'q': 'x' * 201}),
                           ('notes_get_note', {'date': '2026-10-07', 'id': 'secret'}), ('notes_get_day', {'date': '2026-02-30'}),
                           ('notes_list', {'from': '2026-10-07', 'release': '4.5'}), ('notes_write', {})]:
            _, b = self.rpc(tokens['access_token'], name=name, arguments=args)
            self.assertTrue(b['result']['isError'], b)
            self.assertNotIn('not yours', json.dumps(b))

    def test_cursors_bound_to_account_and_filters(self):
        self.add_note()
        self.add_note('another', id='another')
        token = self.connected()[0]['access_token']
        _, b = self.rpc(token, name='notes_list', arguments={'limit': 1})
        cursor = b['result']['structuredContent']['next_cursor']
        for bad in ({'cursor': cursor, 'from': '2026-10-07'}, {'cursor': 'malformed'}):
            _, b = self.rpc(token, name='notes_list', arguments=bad)
            self.assertEqual(b['result']['structuredContent']['error'], 'invalid_cursor')

    def test_release_filter_rejects_unrepresentable_anniversaries(self):
        token = self.connected()[0]['access_token']
        # Birthday is 1981: age 8018 starts in 9999 but its next birthday
        # is unrepresentable. Age 8017 is representable, though in the future.
        for name in ('notes_list', 'notes_search'):
            for release in ('801.8', '999.9'):
                with self.subTest(name=name, release=release):
                    r, b = self.rpc(token, name=name, arguments={'release': release, 'q': 'lake'} if name == 'notes_search' else {'release': release})
                    self.assertEqual(r['statusCode'], 200)
                    self.assertTrue(b['result']['isError'])
                    self.assertEqual(b['result']['structuredContent']['error'], 'invalid_arguments')
        _, b = self.rpc(token, name='notes_list', arguments={'release': '801.7'})
        self.assertEqual(b['result']['structuredContent']['error'], 'invalid_date')
        self.assertNotIn('mcp-error', self.out.getvalue())

    def test_store_file_and_activity_failures_escape_without_private_exception_details(self):
        token = self.connected()[0]['access_token']
        self.add_note(media=[{'n': 1, 'kind': 'image', 'type': 'image/jpeg',
                             'thumb': {'key': 'media/u1/thumb.jpg'}}])
        private = 'private-note ada@example.com media/u1/private-file ' + token
        original_get, original_commit = self.store.mcp_get, self.store.mcp_commit

        def fail_activity_read(pk, sk='STATE'):
            if sk.startswith('USE#'):
                raise OSError(private)
            return original_get(pk, sk)

        def fail_activity_write(changes, uid=None):
            if any(row['sk'].startswith('LOG#') for row, _ in changes):
                raise OSError(private)
            return original_commit(changes, uid)

        cases = ((self.store, 'note_days', 'notes_context', {}, OSError(private)),
                 (self.s3, 'get_object', 'notes_view_photo', {'date': '2026-10-07', 'id': 'w-first', 'n': 1}, OSError(private)),
                 (self.store, 'mcp_get', 'notes_context', {}, fail_activity_read),
                 (self.store, 'mcp_commit', 'notes_context', {}, fail_activity_write))
        for target, method, tool, arguments, failure in cases:
            with self.subTest(method=method), patch.object(target, method, side_effect=failure):
                r, b = self.rpc(token, name=tool, arguments=arguments)
                self.assertEqual(r['statusCode'], 200)
                self.assertTrue(b['result']['isError'])
                self.assertEqual(b['result']['structuredContent']['error'], 'temporarily_unavailable')
                for secret in ('private-note', 'ada@example.com', 'media/u1/private-file', token):
                    self.assertNotIn(secret, json.dumps(b) + self.out.getvalue())
        errors = [json.loads(line) for line in self.out.getvalue().splitlines() if 'mcp-error' in line]
        self.assertEqual(errors, [{'event': 'mcp-error', 'user': 'u1', 'error': 'OSError'}] * 4)
        metrics = [json.loads(line) for line in self.out.getvalue().splitlines() if 'McpFailures' in line]
        self.assertEqual([m['McpFailures'] for m in metrics], [1] * 4)

    def test_long_unicode_note_and_transcript_continuations(self):
        words = '🎵' * 20000
        self.add_note(words, media=[{'n': 1, 'kind': 'audio', 'type': 'audio/wav', 'transcript': 't' * 19000}])
        token = self.connected()[0]['access_token']
        collected, offset = '', 0
        for _ in range(30):
            _, b = self.rpc(token, name='notes_get_note', arguments={'date': '2026-10-07', 'id': 'w-first', 'offset': offset})
            self.assertNotIn('isError', b['result'], b)
            value = b['result']['structuredContent']
            self.assertLessEqual(len(mcp.dumps(value)), mcp.MAX_CHARS)
            collected += value['note']['text']
            offset = value['note']['next_offset']
            if offset is None:
                break
        self.assertEqual(collected, words)
        _, b = self.rpc(token, name='notes_get_audio', arguments={'date': '2026-10-07', 'id': 'w-first', 'n': 1})
        self.assertEqual(b['result']['structuredContent']['next_offset'], 8000)

    def test_media_scopes_prefix_guards_and_inline_results(self):
        self.add_note(media=[{'n': 1, 'kind': 'image', 'type': 'image/png', 'key': 'media/u1/a.png', 'description': 'A fictional lake', 'thumb': {'key': 'media/u1/a.thumb.jpg'}},
            {'n': 2, 'kind': 'audio', 'type': 'audio/wav', 'key': 'media/u1/a.wav', 'size': 4, 'transcript': 'Hello'},
            {'n': 3, 'kind': 'image', 'type': 'image/png', 'key': 'media/u2/private.png'}])
        for key in ('media/u1/a.png', 'media/u1/a.thumb.jpg', 'media/u1/a.wav'):
            self.s3.put_object(Bucket='mail-bucket', Key=key, Body=b'data')
        text_token = self.connected(False)[0]['access_token']
        args = {'date': '2026-10-07', 'id': 'w-first', 'n': 1}
        _, b = self.rpc(text_token, name='notes_view_photo', arguments=args)
        self.assertEqual(b['result']['structuredContent']['error'], 'scope_required')
        _, caption = self.rpc(text_token, name='notes_view_photo', arguments={**args, 'description_only': True})
        self.assertEqual(caption['result']['structuredContent']['description'], 'A fictional lake')
        _, b = self.rpc(text_token, name='notes_get_audio', arguments={**args, 'n': 2})
        self.assertEqual(b['result']['structuredContent']['transcript'], 'Hello')
        token = self.connected()[0]['access_token']
        _, b = self.rpc(token, name='notes_view_photo', arguments=args)
        self.assertEqual(b['result']['content'][1]['type'], 'image')
        self.assertEqual(base64.b64decode(b['result']['content'][1]['data']), b'data')
        _, b = self.rpc(token, name='notes_get_audio', arguments={**args, 'n': 2, 'inline': True})
        self.assertEqual(b['result']['content'][1]['type'], 'audio')
        _, b = self.rpc(token, name='notes_view_photo', arguments={**args, 'n': 3, 'original': True})
        self.assertEqual(b['result']['structuredContent']['error'], 'file_unavailable')

    def test_large_audio_download_missing_transcript_and_no_processing(self):
        self.add_note(media=[{'n': 1, 'kind': 'audio', 'type': 'audio/wav', 'key': 'media/u1/a.wav', 'size': mcp.MAX_MEDIA + 1}])
        token = self.connected()[0]['access_token']
        _, b = self.rpc(token, name='notes_get_audio', arguments={'date': '2026-10-07', 'id': 'w-first', 'n': 1, 'inline': True})
        result = b['result']['structuredContent']
        self.assertFalse(result['transcript_available'])
        self.assertIn('download', result)
        self.assertEqual(result['expires_in'], 600)
        self.assertEqual(self.lam.invoked, [])

    def test_activity_contains_no_queries_results_or_addresses(self):
        self.add_note('uniquely-private-note')
        token = self.connected()[0]['access_token']
        self.rpc(token, name='notes_search', arguments={'q': 'uniquely-private-note'})
        _, activity = self.call('GET', '/api/mcp/activity', cookies=[self.cookie])
        self.assertEqual(activity['activity'][0]['tool'], 'notes_search')
        combined = json.dumps(self.store.mcp_rows('MCPMETA#u1')) + self.out.getvalue()
        for secret in ('uniquely-private-note', 'ada@example.com', token):
            self.assertNotIn(secret, combined)

    def test_budget_pagination_returns_every_item_and_unicode_audio(self):
        for i in range(25):
            self.add_note('🎵' * 800, id=f'w-{i:02d}')
        token = self.connected()[0]['access_token']
        seen, cursor = [], None
        for _ in range(25):
            args = {'limit': 50, **({'cursor': cursor} if cursor else {})}
            _, b = self.rpc(token, name='notes_list', arguments=args)
            value = b['result']['structuredContent']
            self.assertLessEqual(len(mcp.dumps(value)), mcp.MAX_CHARS)
            self.assertGreater(len(value['notes']), 0)
            seen += [i['id'] for i in value['notes']]
            cursor = value['next_cursor']
            if cursor is None:
                break
        self.assertEqual(len(seen), 25)
        self.assertEqual(len(set(seen)), 25)
        self.add_note('recording', id='audio', media=[{'n': 1, 'kind': 'audio', 'type': 'audio/wav', 'transcript': '🎵' * 19000}])
        _, b = self.rpc(token, name='notes_get_audio', arguments={'date': '2026-10-07', 'id': 'audio', 'n': 1})
        value = b['result']['structuredContent']
        self.assertLessEqual(len(mcp.dumps(value)), mcp.MAX_CHARS)
        self.assertEqual(value['next_offset'], len(value['transcript']))

    def test_dynamodb_decimal_fields_render_as_json_numbers(self):
        from decimal import Decimal
        token = self.connected()[0]['access_token']
        self.rpc(token)
        for i in self.store.mcp_items.values():
            for key, value in list(i.items()):
                if type(value) is int:
                    i[key] = Decimal(value)
        r, connections = self.call('GET', '/api/mcp/connections', cookies=[self.cookie])
        self.assertEqual(r['statusCode'], 200)
        self.assertEqual(type(connections['connections'][0]['last_used']), int)
        r, activity = self.call('GET', '/api/mcp/activity', cookies=[self.cookie])
        self.assertEqual(r['statusCode'], 200)
        self.assertEqual(type(activity['activity'][0]['at']), int)
        self.store.put_weather('u1', '2026-10-07', {'code': Decimal(3), 'high_c': Decimal('17.5'), 'low_c': Decimal('5.5'), 'city': 'Boston'})
        _, b = self.rpc(token, name='notes_get_day', arguments={'date': '2026-10-07'})
        self.assertEqual(b['result']['structuredContent']['weather']['code'], 3)

    def test_hourly_and_daily_quota(self):
        token = self.connected()[0]['access_token']
        for period, cap in ((3600, 300), (86400, 500)):
            self.store.mcp_items[("MCPMETA#u1", f"RATE#{period}#{self.now // period}")] = {
                'pk': 'MCPMETA#u1', 'sk': f'RATE#{period}#{self.now // period}', 'n': cap, 'revision': 1}
            _, b = self.rpc(token)
            self.assertEqual(b['result']['structuredContent']['error'], 'rate_limited')
            self.store.mcp_items.pop(("MCPMETA#u1", f"RATE#{period}#{self.now // period}"))

    def test_protocol_shapes_negotiation_and_notifications(self):
        token = self.connected()[0]['access_token']
        _, b = self.rpc(token, method='initialize', protocolVersion='2026-new')
        self.assertEqual(b['result']['protocolVersion'], '2025-06-18')
        _, b = self.rpc(token, method='tools/list')
        self.assertEqual(len(b['result']['tools']), 10)
        self.assertTrue(all(t['annotations']['readOnlyHint'] == (t['name'] not in mcp.WRITE_TOOLS) and t['inputSchema']['additionalProperties'] is False for t in b['result']['tools']))
        _, b = self.rpc(token, method='unknown')
        self.assertEqual(b['error']['code'], -32601)
        event = request('POST', '/mcp', {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, origin=None)
        event['headers'].update(authorization='Bearer ' + token, **{'content-type': 'application/json'})
        self.assertEqual(mcp.handler(event, None, store=self.store, clock=lambda: self.now)['statusCode'], 202)
        event['requestContext']['http']['method'] = 'GET'
        self.assertEqual(mcp.handler(event, None, store=self.store, clock=lambda: self.now)['statusCode'], 405)


class StorageContractTests(WebCase):
    def test_native_transaction_conditions_and_failures(self):
        client = FakeClient()
        store = Store(FakeTable(client))
        item = oauth.row('OAUTHACCESS#hash', user_id='u1', expires_at=123)
        self.assertTrue(store.mcp_commit([(item, None), ({**item, 'pk': 'MCPMETA#u1'}, 3)], 'u1'))
        ops = client.calls[0]['TransactItems']
        self.assertEqual(ops[0]['ConditionCheck'], {'TableName': 'release-notes', 'Key': {'pk': 'USER#u1', 'sk': 'PROFILE'},
            'ConditionExpression': 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'})
        self.assertEqual(ops[1]['Put']['Item'], {**item, 'revision': 1})
        self.assertEqual(ops[1]['Put']['ConditionExpression'], 'attribute_not_exists(pk)')
        self.assertEqual(ops[2]['Put']['ExpressionAttributeValues'], {':r': 3})
        self.assertEqual(ops[2]['Put']['Item']['revision'], 4)
        self.assertFalse(Store(FakeTable(FakeClient(Cancelled('None', 'ConditionalCheckFailed')))).mcp_commit([(item, None)]))
        self.assertFalse(Store(FakeTable(FakeClient(Cancelled('None', 'TransactionConflict')))).mcp_commit([(item, None)]))
        with self.assertRaises(Cancelled):
            Store(FakeTable(FakeClient(Cancelled('ValidationError')))).mcp_commit([(item, None)])

    def test_strong_reads_and_delete_barrier_shape(self):
        table = FakeTable()
        store = Store(table)
        store.mcp_profile('u1')
        self.assertEqual(table.calls[-1], ('get_item', {'Key': {'pk': 'USER#u1', 'sk': 'PROFILE'}, 'ConsistentRead': True}))
        store.mcp_rows('OAUTHUSER#u1')
        self.assertTrue(table.calls[-1][1]['ConsistentRead'])
        store.mcp_block('u1')
        self.assertEqual(table.calls[-1][1]['ConditionExpression'], 'attribute_exists(pk)')

    def test_generated_contract_matches_declarations(self):
        actual = json.loads((Path(__file__).resolve().parent.parent / 'contracts/mcp-surface.json').read_text())
        self.assertEqual(actual, {'server_version': mcp.VERSION, 'protocol_versions': list(mcp.PROTOCOLS), 'tools': mcp.TOOLS})

    def test_mcp_role_has_only_metadata_writes_and_media_reads(self):
        # PyYAML is not a product dependency; use the existing template text
        # boundary to prove forbidden AWS actions cannot sneak into this role.
        text = (Path(__file__).resolve().parent.parent / 'infra/template.yaml').read_text()
        role = text.split('  McpRole:', 1)[1].split('  McpFunction:', 1)[0]
        self.assertIn('dynamodb:LeadingKeys: ["MCPMETA#*"]', role)
        self.assertIn('Action: [dynamodb:PutItem]', role)
        self.assertIn('${MailBucket.Arn}/media/*', role)
        self.assertIn('Action: lambda:InvokeFunction\n                Resource: !GetAtt CaptureFunction.Arn', role)
        for forbidden in ('UpdateItem', 'DeleteItem', 'BatchWriteItem', 'PutObject', 'DeleteObject', 'ses:', 'bedrock:', '/raw/', '/exports/'):
            self.assertNotIn(forbidden, role)

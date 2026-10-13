"""Owner-delegated capture, races, receipts and imported reads; fictional data."""
import json
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from release_notes import capture, dayone, importer, mcp, oauth
from test_mcp import ConnectionCase
from test_store import Store, FakeTable, FakeClient, Cancelled


class CaptureTests(ConnectionCase):
    def setUp(self):
        super().setUp()
        self.tokens, self.client_id = self.connected(write=True)
        self.token = self.tokens['access_token']

    def write(self, tool='notes_create', key='operation-1', **args):
        r, b = self.rpc(self.token, name=tool, arguments={'idempotency_key': key, 'text': 'Dinner by the lake #Cabin', **args})
        self.assertEqual(r['statusCode'], 200)
        return b['result']['structuredContent']

    def test_create_append_replay_original_results_and_audit(self):
        first = self.write(date='2026-10-07')
        note = first['note']
        self.assertTrue(note['late'])
        self.assertEqual((note['source'], note['author'], note['client'], note['tags']), ('agent', 'assistant', 'Claude', ['cabin']))
        self.assertEqual(note['on_behalf_of'], 'u1')
        self.assertEqual(self.write(date='2026-10-07'), {**first, 'replayed': True})
        appended = self.write('notes_append', 'append-1', date=note['date'], id=note['id'], text='And a walk #Evening')
        self.assertEqual(appended['note']['text'], 'Dinner by the lake #Cabin\n\nAnd a walk #Evening')
        self.assertEqual(self.write('notes_append', 'append-1', date=note['date'], id=note['id'], text='And a walk #Evening'), {**appended, 'replayed': True})
        # Creating's receipt returns its original note, even after an append.
        self.assertEqual(self.write(date='2026-10-07'), {**first, 'replayed': True})
        self.assertEqual(len(self.store.all_notes('u1')), 1)
        self.assertEqual(self.write(text='different')['error'], 'duplicate_idempotency_key')
        _, activity = self.call('GET', '/api/mcp/activity', cookies=[self.cookie])
        writes = [a for a in activity['activity'] if a['outcome'] == 'ok']
        self.assertEqual(len(writes), 2)
        self.assertEqual({a['note_id'] for a in writes}, {note['id']})
        self.assertTrue(all(a['client'] == 'Claude' for a in writes))
        self.assertNotIn('Dinner', json.dumps(activity))

    def test_no_implicit_write_consent_or_web_write_authentication(self):
        read_token = self.connected(write=False)[0]['access_token']
        _, b = self.rpc(read_token, name='notes_create', arguments={'text': 'Refused', 'idempotency_key': 'r'})
        self.assertEqual(b['result']['structuredContent']['error'], 'scope_required')
        self.assertEqual(self.store.all_notes('u1'), [])
        self.assertEqual(capture.handler({'token': read_token, 'tool': 'notes_create', 'arguments': {'text': 'Refused', 'idempotency_key': 'r'}}, None, store=self.store, clock=lambda: self.now)['error'], 'scope_required')
        self.assertEqual(self.call('POST', '/api/days/2026-10-07/notes', {'text': 'Refused'})[0]['statusCode'], 401)
        cid, pending = self.pending('notes:read')
        r, _ = self.call('POST', '/api/mcp/authorize', {'request': pending, 'approve': True, 'write': True}, cookies=[self.cookie])
        self.assertEqual(r['statusCode'], 400)

    def test_cannot_append_to_user_other_connection_or_other_account(self):
        self.add_note(id='human')
        for source in ('web', 'email', 'import'):
            self.store.note('u1', '2026-10-07', 'human')['source'] = source
            self.assertEqual(self.write('notes_append', source, date='2026-10-07', id='human')['error'], 'forbidden_not_author')
        note = self.write()['note']
        self.token = self.connected(write=True)[0]['access_token']
        self.assertEqual(self.write('notes_append', 'other', date=note['date'], id=note['id'])['error'], 'forbidden_not_author')
        self.assertEqual(self.write('notes_create', 'forge', author='user')['error'], 'invalid_arguments')
        self.assertEqual(self.write('notes_update', 'edit')['error'], 'unknown_tool')
        self.assertEqual(self.write('notes_delete', 'delete')['error'], 'unknown_tool')
        self.subscribe('bea@example.com', 'u2')
        self.store.add_note('u2', '2026-10-07', 'private', text='other account')
        self.assertEqual(self.write('notes_append', 'cross-user', date='2026-10-07', id='private')['error'], 'not_found')

    def test_dates_length_hashtags_and_large_unicode_requests(self):
        self.assertEqual(self.write(date='2027-01-01')['error'], 'invalid_date')
        self.assertEqual(self.write(date='2026-02-30')['error'], 'invalid_date')
        self.assertEqual(self.write(text=' ')["error"], 'invalid_arguments')
        self.assertEqual(self.write(text='x' * 20001)['error'], 'invalid_arguments')
        unicode_text = chr(0x1f4a1) * 20000
        note = self.write('notes_create', 'unicode', text=unicode_text)['note']
        self.assertIsNotNone(note['next_offset'])
        self.assertEqual(self.store.note('u1', note['date'], note['id'])['text'], unicode_text)
        self.assertEqual(self.write('notes_append', 'overflow', date=note['date'], id=note['id'], text='x')['error'], 'too_long')

    def test_revoking_only_write_scope_preserves_read_and_refresh_cannot_restore_it(self):
        note = self.write()['note']
        r, _ = self.call('DELETE', '/api/mcp/connections/' + note['connection'], query={'write_only': 'true'}, cookies=[self.cookie])
        self.assertEqual(r['statusCode'], 200)
        _, b = self.rpc(self.token)
        self.assertNotIn('notes:write', b['result']['structuredContent']['scope'])
        self.assertEqual(self.write(key='blocked')['error'], 'scope_required')
        r, refreshed = self.protocol('POST', '/oauth/token', {'grant_type': 'refresh_token',
            'refresh_token': self.tokens['refresh_token'], 'client_id': self.client_id, 'resource': self.target})
        self.assertEqual(r['statusCode'], 200)
        self.assertNotIn('notes:write', refreshed['scope'])
        self.token = refreshed['access_token']
        self.assertEqual(self.write(key='still-blocked')['error'], 'scope_required')
        self.assertEqual(len(self.store.all_notes('u1')), 1)

    def test_lost_response_retries_committed_result_and_expired_receipt_can_be_reused(self):
        # A network failure after commit must not turn a retry into a new note.
        from test_web import request
        event = request('POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
            'params': {'name': 'notes_create', 'arguments': {'text': 'Dinner by the lake #Cabin', 'idempotency_key': 'operation-1'}}}, origin=None)
        event['headers'].update(authorization='Bearer ' + self.token, **{'content-type': 'application/json'})
        def lost(e):
            capture.handler(e, None, store=self.store, clock=lambda: self.now, fetch=lambda url: None)
            raise OSError('Lost response')
        response = mcp.handler(event, None, store=self.store, clock=lambda: self.now, writer=lost)
        self.assertEqual(json.loads(response['body'])['result']['structuredContent']['error'], 'temporarily_unavailable')
        replay = self.write()
        self.assertTrue(replay['replayed'])
        self.assertEqual(len(self.store.all_notes('u1')), 1)
        _, activity = self.call('GET', '/api/mcp/activity', cookies=[self.cookie])
        self.assertEqual(len([a for a in activity['activity'] if a['outcome'] == 'ok']), 1)
        receipt = next(i for i in self.store.items['u1'] if i['sk'].startswith('CAPTURE#'))
        receipt['expires_at'] = self.now
        fresh = self.write()
        self.assertFalse(fresh['replayed'])
        self.assertNotEqual(fresh['note']['id'], replay['note']['id'])
        self.assertEqual(len(self.store.all_notes('u1')), 2)

    def test_conflicted_creates_fetch_each_link_title_only_once(self):
        calls = []
        original = self.store.capture_commit
        attempts = []
        def conflict_once(*args):
            attempts.append(True)
            return False if len(attempts) == 1 else original(*args)
        with patch.object(self.store, 'capture_commit', side_effect=conflict_once):
            result = capture.handler({'token': self.token, 'tool': 'notes_create',
                'arguments': {'text': 'Dinner https://pier.example/', 'idempotency_key': 'link-retry'}}, None,
                store=self.store, clock=lambda: self.now, fetch=lambda url: calls.append(url) or {'title': 'Pier', 'site': 'example'})
        self.assertNotIn('error', result)
        self.assertEqual(calls, ['https://pier.example/'])

    def test_note_quota_and_exact_retries(self):
        first = self.write()
        key = 'WRITERATE#notes_create#' + str(self.now // 86400)
        self.store.mcp_items[('MCPMETA#u1', key)]['n'] = 20
        self.assertEqual(self.write(key='new')['error'], 'rate_limited')
        self.assertEqual(self.write(), {**first, 'replayed': True})
        self.assertEqual(len(self.store.all_notes('u1')), 1)

    def test_revocation_and_deletion_races_commit_nothing(self):
        original = self.store.capture_commit
        family = next(i for i in self.store.mcp_items.values() if i['pk'].startswith('OAUTHFAMILY#') and 'notes:write' in i['scope'])
        for change in ('revocation', 'deletion'):
            with self.subTest(change=change):
                def raced(*args):
                    if change == 'revocation':
                        family['revoked'] = True
                    else:
                        self.store.profiles['u1']['mcp_deleting'] = True
                    return original(*args)
                with patch.object(self.store, 'capture_commit', side_effect=raced):
                    self.assertEqual(self.write(key=change)['error'], 'scope_required')
                family.pop('revoked', None)
                self.store.profiles['u1'].pop('mcp_deleting', None)
                self.assertEqual(self.store.all_notes('u1'), [])
                self.assertFalse(any(i['sk'].startswith('CAPTURE#') for i in self.store.items.get('u1', [])))

    def test_conflicts_and_owner_changes_preserve_media_and_do_not_duplicate(self):
        note = self.write()['note']
        original = self.store.capture_commit
        calls = []
        def race(*args):
            calls.append(True)
            if len(calls) == 1:
                stored = self.store.note('u1', note['date'], note['id'])
                stored.update(text='Owner edited', updated_at='2026-10-07T13:00:00Z', media=[{'n': 1, 'kind': 'file', 'type': 'application/pdf'}])
            return original(*args)
        with patch.object(self.store, 'capture_commit', side_effect=race):
            appended = self.write('notes_append', 'raced', date=note['date'], id=note['id'], text='Append')
        stored = self.store.note('u1', note['date'], note['id'])
        self.assertEqual(appended['note']['text'], 'Owner edited\n\nAppend')
        self.assertEqual(stored['media'][0]['kind'], 'file')
        self.assertEqual(len(self.store.all_notes('u1')), 1)
        self.assertEqual(len(calls), 2)

    def test_reads_include_provenance_and_can_exclude_agent_notes(self):
        self.add_note(day='2026-10-07')
        note = self.write(date='2026-10-07')['note']
        for tool, args in [('notes_list', {}), ('notes_search', {'q': 'lake'}), ('notes_get_day', {'date': '2026-10-07'})]:
            _, b = self.rpc(self.token, name=tool, arguments=args)
            notes = b['result']['structuredContent']['notes']
            self.assertEqual({n['author'] for n in notes}, {'user', 'assistant'})
            _, b = self.rpc(self.token, name=tool, arguments={**args, 'include_assistant': False})
            self.assertEqual(len(b['result']['structuredContent']['notes']), 1)
        r, day = self.call('GET', '/api/days/2026-10-07', cookies=[self.cookie])
        self.assertEqual(r['statusCode'], 200)
        self.assertEqual(next(n for n in day['notes'] if n['id'] == note['id'])['client'], 'Claude')
        # MCP's note response exposes the same provenance as the web renderer.
        self.assertEqual(note['author'], 'assistant')

    def test_private_writer_storage_failures_are_sanitized_and_counted(self):
        with patch.object(self.store, 'capture_commit', side_effect=OSError('private note ada@example.com')):
            self.assertEqual(self.write()['error'], 'temporarily_unavailable')
        self.assertNotIn('private note', self.out.getvalue())
        self.assertEqual(self.store.all_notes('u1'), [])
        self.assertIn('"McpFailures":1', self.out.getvalue())


class ImportedReaderTests(ConnectionCase):
    def test_every_fixture_import_is_listed_searched_and_fetched_with_continuations(self):
        # Use the real planner and writer; no subscriber export or live data.
        word = chr(0x1f4a1)
        entries = [{"uuid": f"{i:032X}", "creationDate": f"2021-05-{14+i:02d}T12:00:00Z", "timeZone": "America/Chicago",
                    "text": text} for i, text in enumerate(("Fixture short", "Fixture curly ‘quotes’ — café " + word * 18000,
                    "Fixture " + '#Cabin ' * 2400, 'Fixture ' + '[pier](https://pier.example/) ' * 300))]
        plan = dayone.plan('Journal', entries, {}, self.store.profile('u1'), 'u1')
        importer.write([(plan, lambda path: b'')], 'u1', store=self.store, s3=self.s3, bucket='b',
                       today=date(2026, 10, 7), at='2026-10-07T12:00:00Z', fetch_title=lambda url: None)
        token = self.connected()[0]['access_token']
        for tool, args in [('notes_list', {}), ('notes_search', {'q': 'Fixture'})]:
            _, listed = self.rpc(token, name=tool, arguments=args)
            self.assertEqual(listed['result']['structuredContent']['total'], len(entries))
            for note in listed['result']['structuredContent']['notes']:
                chunks, offset = [], 0
                for _ in range(100):
                    _, answer = self.rpc(token, name='notes_get_note', arguments={'date': note['date'], 'id': note['id'], 'offset': offset})
                    self.assertNotIn('isError', answer['result'])
                    part = answer['result']['structuredContent']['note']
                    chunks.append(part['text'])
                    following = part['next_offset']
                    if following is None:
                        break
                    self.assertGreater(following, offset)
                    offset = following
                else:
                    self.fail('Continuation did not finish')
                self.assertEqual(''.join(chunks), self.store.note('u1', note['date'], note['id'])['text'])

    def test_transcript_only_does_not_touch_audio_or_lambda(self):
        self.add_note(media=[{'n': Decimal(1), 'kind': 'audio', 'type': 'audio/mp4', 'transcript': 'Words', 'size': Decimal(999999)}])
        token = self.connected(media=False)[0]['access_token']
        with patch.object(self.s3, 'get_object', side_effect=AssertionError('Audio read')), patch.object(self.lam, 'invoke', side_effect=AssertionError('Lambda invocation')):
            _, b = self.rpc(token, name='notes_get_audio', arguments={'date': '2026-10-07', 'id': 'w-first', 'n': 1, 'inline': False})
        self.assertEqual(b['result']['structuredContent']['transcript'], 'Words')


class CaptureRequestShapeTests(ConnectionCase):
    def test_exact_transaction_proves_consent_receipt_note_and_audit_together(self):
        token = self.connected(write=True)[0]['access_token']
        family = oauth.bearer(mcp.App(self.store, None, self.now), token)
        args = {'text': 'Example', 'idempotency_key': 'shape'}
        committed = []
        def inspect(*values):
            committed.append(values)
            return False
        with patch.object(self.store, 'capture_commit', side_effect=inspect):
            capture.handler({'token': token, 'tool': 'notes_create', 'arguments': args}, None,
                            store=self.store, clock=lambda: self.now, fetch=lambda url: None)
        client = FakeClient()
        Store(FakeTable(client)).capture_commit(*committed[0])
        ops = client.calls[0]['TransactItems']
        self.assertEqual(len(ops), 6)
        self.assertIn('attribute_not_exists(mcp_deleting)', ops[0]['ConditionCheck']['ConditionExpression'])
        self.assertIn('contains(#s, :write)', ops[1]['ConditionCheck']['ConditionExpression'])
        self.assertEqual(ops[1]['ConditionCheck']['ExpressionAttributeValues'][':revision'], family['revision'])
        self.assertEqual(ops[2]['Put']['Item']['author'], 'assistant')
        self.assertEqual(ops[2]['Put']['ConditionExpression'], 'attribute_not_exists(pk)')
        self.assertEqual(ops[3]['Put']['ConditionExpression'], 'attribute_not_exists(pk) OR expires_at <= :now')
        self.assertEqual(ops[4]['Put']['Item']['tool'], 'notes_create')
        self.assertEqual(ops[5]['Put']['Item']['n'], 1)
        self.assertFalse(Store(FakeTable(FakeClient(Cancelled('TransactionConflict')))).capture_commit(*committed[0]))
        with self.assertRaises(Cancelled):
            Store(FakeTable(FakeClient(Cancelled('ValidationError')))).capture_commit(*committed[0])

    def test_append_request_preserves_files_and_guards_owner_edits(self):
        token = self.connected(write=True)[0]['access_token']
        first = capture.handler({'token': token, 'tool': 'notes_create', 'arguments': {'text': 'First', 'idempotency_key': 'first'}},
                                None, store=self.store, clock=lambda: self.now, fetch=lambda url: None)['note']
        day, id = first['sk'].split('#')[1:]
        committed = []
        with patch.object(self.store, 'capture_commit', side_effect=lambda *values: committed.append(values) or False):
            capture.handler({'token': token, 'tool': 'notes_append', 'arguments': {'date': day, 'id': id, 'text': 'Next', 'idempotency_key': 'next'}},
                            None, store=self.store, clock=lambda: self.now, fetch=lambda url: None)
        client = FakeClient()
        Store(FakeTable(client)).capture_commit(*committed[0])
        update = client.calls[0]['TransactItems'][2]['Update']
        self.assertEqual(update['Key'], {'pk': 'USER#u1', 'sk': first['sk']})
        self.assertEqual(update['UpdateExpression'], 'SET #t = :text, tags = :tags, links = :links, updated_at = :updated_at, #r = :next')
        self.assertEqual(update['ExpressionAttributeNames'], {'#t': 'text', '#r': 'revision', '#c': 'connection'})
        self.assertEqual(update['ExpressionAttributeValues'][':text'], 'First\n\nNext')
        self.assertIn('#c = :connection', update['ConditionExpression'])
        self.assertIn('#t = :old', update['ConditionExpression'])
        self.assertIn('attribute_not_exists(updated_at)', update['ConditionExpression'])

    def test_writer_has_no_public_route_or_data_deletion_permission(self):
        from pathlib import Path
        template = (Path(__file__).resolve().parent.parent / 'infra/template.yaml').read_text()
        role = template.split('  CaptureRole:', 1)[1].split('  CaptureFunction:', 1)[0]
        for forbidden in ('DeleteItem', 'BatchWriteItem', 's3:', 'ses:', 'bedrock:', 'InvokeFunction'):
            self.assertNotIn(forbidden, role)
        self.assertIn('dynamodb:LeadingKeys: ["USER#*", "MCPMETA#*"]', role)
        self.assertNotIn('FunctionName: !Ref CaptureFunction\n      Action: lambda:InvokeFunction', template)
        self.assertIn('Expression: SUM(METRICS())', template)
        self.assertIn('MetricName: McpFailures', template)

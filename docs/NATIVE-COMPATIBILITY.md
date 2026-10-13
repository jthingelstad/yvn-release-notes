# Native compatibility ledger

This is the retirement record for the Python implementation. The inventory is pinned to legacy commit `79ca1c08e5ac1e12f1a113db78b23b8893581d74` (685 `unittest` methods in 28 files). Native witnesses were reviewed against cleanup commit `47daa07` and the focused regressions added with this ledger. It is a local fictional-data audit, not evidence of a production sign-in, send, import, or subscriber read.

**Disposition:** `replacement` means the listed native cases cover the legacy behavior as grouped scenarios or independent cross-language goldens. They do not copy every old assertion, Python fixture builder, mock shape, or test method one for one. `obsolete` applies only to the seven custom origin-secret/adapter methods and two optional-Pillow availability methods listed below. All other 676 methods have a semantic replacement. Native tests also add atomic consent/deletion/concurrency proofs which the old suite did not provide.

The inventory was extracted from each legacy class method named `test_*`, then reviewed against source assertions and native cases. Each original method appears once below under its original class. The witness list belongs to **all specifically enumerated class/method groups in that module**, unless an obsolete exception is named. Historical source remains available from the pinned Git commit after cleanup.

Run `npm run verify` for the native application and workers. Browser coverage remains `npm run e2e` against the fictional Node harness; it is complementary to these server/domain witnesses. No test in this ledger requires network fetches or live AWS access.

## Inventory totals

| Legacy module  | Methods | Disposition                                                |
| -------------- | ------: | ---------------------------------------------------------- |
| `capture`      |      21 | replacement                                                |
| `census`       |      11 | replacement                                                |
| `compose`      |      48 | replacement                                                |
| `dayone`       |      23 | replacement                                                |
| `describe`     |      23 | replacement                                                |
| `docs`         |       4 | replacement                                                |
| `event_bridge` |       7 | replacement                                                |
| `exif`         |      11 | replacement                                                |
| `export_zip`   |      15 | replacement                                                |
| `handlers`     |     100 | replacement                                                |
| `importer`     |       6 | replacement                                                |
| `links`        |      27 | replacement                                                |
| `mcp`          |      31 | replacement                                                |
| `media`        |      10 | replacement                                                |
| `notes`        |      10 | replacement                                                |
| `origin`       |       7 | obsolete mechanism; origin/privacy replacement             |
| `parse`        |      14 | replacement                                                |
| `pause_delete` |      25 | replacement                                                |
| `signup`       |      23 | replacement                                                |
| `store`        |      58 | replacement                                                |
| `streak`       |      10 | replacement                                                |
| `tags`         |       8 | replacement                                                |
| `thumbs`       |      24 | 22 replacement; 2 obsolete dependency assumptions          |
| `transcribe`   |      14 | replacement                                                |
| `version`      |       7 | replacement                                                |
| `weather`      |      36 | replacement                                                |
| `web`          |      40 | replacement                                                |
| `web_notes`    |      72 | replacement                                                |
| **Total**      | **685** | **676 replacement; 9 obsolete implementation assumptions** |

## Semantic mapping

The exact literal-output fixtures are independent legacy outputs, not expectations built by calling the native code: email bodies (8 combinations), JSON/Markdown export (16 combinations), HTTP readers (19 combinations), MIME/body stripping, Day One full plans/plain text, 509 JPEG metadata inputs, all sibling-site version fixtures, and a digest covering every Unicode scalar/code point in the Python Unicode 16 fold oracle. Named tests below identify the checked surface; native fixture arrays retain the individual variants.

New grouped regressions close audit gaps in composed auth limits and sliding sessions, pause history/restart failure handling, optional email read failures, copy/cut branches, real thumbnail transparency/pixel bounds, weather CAS interleavings and count-only dashboard assertions. This mapping records behavioral scope, not a claim that the new suite has 685 independent tests.

### capture: Delegated writer (21 methods)

Live account/family/scope proof, exact-connection append ownership, code-point limits, changed-argument refusal, legacy ASCII-sorted fingerprints, quota, receipt lifetime, conflict retries, safe DTOs and content-free audit.

Native witnesses:

- [capture/capture.test.ts](../tests-node/capture/capture.test.ts): `create/append and exact retries preserve original safe result and content-free audit`.
- [capture/capture.test.ts](../tests-node/capture/capture.test.ts): `legacy fingerprints keep sorted ASCII JSON and receipt retries after language migration`.
- [capture/capture.test.ts](../tests-node/capture/capture.test.ts): `live revocation, scope removal and account deletion races commit no note, receipt or audit`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `capture exact request proves owner, live scope, receipt, quota and audit in one transaction`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **CaptureTests (16):** `test_initialization_permits_separately_approved_capture_at_user_request`, `test_each_agent_records_its_own_registered_name`, `test_markdown_export_retains_agent_names_and_escapes_client_markup`, `test_create_append_replay_original_results_and_audit`, `test_no_implicit_write_consent_or_web_write_authentication`, `test_cannot_append_to_user_other_connection_or_other_account`, `test_dates_length_hashtags_and_large_unicode_requests`, `test_revoking_only_write_scope_preserves_read_and_refresh_cannot_restore_it`, `test_lost_response_retries_committed_result_and_expired_receipt_can_be_reused`, `test_conflicted_creates_fetch_each_link_title_only_once`, `test_note_quota_and_exact_retries`, `test_revocation_and_deletion_races_commit_nothing`, `test_conflicts_and_owner_changes_preserve_media_and_do_not_duplicate`, `test_append_response_and_exact_replay_include_complete_safe_metadata`, `test_reads_include_provenance_and_can_exclude_agent_notes`, `test_private_writer_storage_failures_are_sanitized_and_counted`.
- **ImportedReaderTests (2):** `test_every_fixture_import_is_listed_searched_and_fetched_with_continuations`, `test_transcript_only_does_not_touch_audio_or_lambda`.
- **CaptureRequestShapeTests (3):** `test_exact_transaction_proves_consent_receipt_note_and_audit_together`, `test_append_request_preserves_files_and_guards_owner_edits`, `test_writer_has_no_public_route_or_data_deletion_permission`.

### census: Count-only operations (11 methods)

Subscriber state, local overdue windows, pauses, all channels including imports/orphans, unique writers/days, reply-rate rounding and EMF units; dashboard grid, emitted metrics and private-log exclusions.

Native witnesses:

- [census.test.ts](../tests-node/census.test.ts): `subscriber state, pauses, local overdue grace and already sent semantics match Python`.
- [census.test.ts](../tests-node/census.test.ts): `every channel and orphan note counts, media empty arrays do not`.
- [census.test.ts](../tests-node/census.test.ts): `EMF shape emits count/percent units and never copies input fields`.
- [docs/dashboard.test.ts](../tests-node/docs/dashboard.test.ts): `dashboard widgets fit without overlap, use emitted count metrics and never query private content`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Counts (8):** `test_states`, `test_overdue_after_half_an_hour_and_not_while_paused_or_stopped`, `test_today_is_the_subscribers_own`, `test_notes_by_source_and_media`, `test_writers_by_their_notes_days`, `test_reply_rate_over_the_30_days_before_today`, `test_no_reply_rate_without_emails`, `test_the_line_is_embedded_metrics_with_numbers_only`.
- **Dashboard (3):** `test_widgets_fit_the_grid_without_overlap`, `test_every_census_metric_it_shows_is_one_the_sender_puts_out`, `test_log_queries_never_ask_for_text_or_addresses`.

### compose: Email presentation (48 methods)

Plain/HTML alternatives, literal historical copy, welcome/birthday/countdown/24 dots, all streak branches, yesterday before history, version-based earlier years, links/tags/places, sentence/word/URL cuts, singular counts, bounded CID-only photos, escaped ASCII HTML and threaded late notices.

Native witnesses:

- [mail/compose.test.ts](../tests-node/mail/compose.test.ts): `legacy email rendering parity: ${row.name}`.
- [mail/compose.test.ts](../tests-node/mail/compose.test.ts): `MIME carries related inline thumbnails, no URLs; named sender and unsubscribe`.
- [mail/compose.test.ts](../tests-node/mail/compose.test.ts): `late MIME is automatic, optionally threaded, and account messages have no unsubscribe`.
- [mail/compose-boundaries.test.ts](../tests-node/mail/compose-boundaries.test.ts): `streak copy preserves first, broken, singular, record and below-record branches without calling out a break`.
- [mail/compose-boundaries.test.ts](../tests-node/mail/compose-boundaries.test.ts): `yesterday falls back to whole words, excludes overlong URLs and places a cut marker outside a complete link`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Email (12):** `test_plain_and_html_alternatives`, `test_pause_or_manage_and_one_click_unsubscribe`, `test_a_visible_unsubscribe_link_to_the_page_that_asks`, `test_says_reply_as_often_as_you_like`, `test_says_photos_and_voice_memos_work`, `test_welcome_only_when_asked`, `test_nothing_remote`, `test_type_on_paper_no_boxes`, `test_birthday_and_countdown`, `test_number_stands_alone`, `test_html_stays_ascii`, `test_year_dots`.
- **StreakCopy (8):** `test_first_ever`, `test_after_a_break_shows_the_longest`, `test_one_day`, `test_longest_yet`, `test_below_the_longest`, `test_email_shows_the_run_by_patch_number`, `test_no_number_row_without_a_run`, `test_no_streak_section_without_a_streak`.
- **AYearAgo (8):** `test_the_section`, `test_still_type_on_paper_and_ascii`, `test_note_text_is_escaped_and_only_web_addresses_link`, `test_links_show_by_name`, `test_long_notes_are_cut_between_words`, `test_no_section_without_notes`, `test_every_year_shares_the_length_newest_first`, `test_tags_have_their_own_line_of_links`.
- **YesterdayBlock (12):** `test_the_block`, `test_no_block_without_notes`, `test_files_have_a_short_line`, `test_attachments_left_in_the_email_still_show`, `test_a_long_day_is_cut_at_a_sentence`, `test_one_long_sentence_is_cut_between_words`, `test_an_address_longer_than_the_cut_is_left_out_not_cut`, `test_a_cut_right_after_an_address_keeps_the_link_whole`, `test_tags_have_their_line_and_show_once`, `test_under_the_streak_before_on_this_day`, `test_where_it_was_as_the_web_shows_it`, `test_still_type_on_paper_ascii_and_escaped`.
- **Photos (3):** `test_inline_by_content_id_still_type_on_paper_and_ascii`, `test_one_photo_full_width_two_side_by_side`, `test_the_message_carries_them_as_related_parts`.
- **LifetimeLine (2):** `test_under_the_streak`, `test_singular_and_no_photos`.
- **LateReply (3):** `test_says_too_late_and_links_to_the_day`, `test_type_on_paper_nothing_remote_ascii`, `test_threads_only_under_a_well_formed_message_id`.

### dayone: Untrusted archive planning (23 methods)

Plain text, original zone/date/place/app, canonical media references and MIME, stable public IDs, skip accounting, journal validation and read-only plan generation. ZIP limits, CRC and path/symlink rules are stronger native checks.

Native witnesses:

- [operator/dayone.test.ts](../tests-node/operator/dayone.test.ts): `DayOne plain exact Python fictional parity ${i}`.
- [operator/dayone.test.ts](../tests-node/operator/dayone.test.ts): `DayOne full plan exact Python fictional parity ${row.name}`.
- [operator/dayone.test.ts](../tests-node/operator/dayone.test.ts): `bounded ZIP reader returns journal and canonical member sizes/content without extraction`.
- [operator/dayone.test.ts](../tests-node/operator/dayone.test.ts): `ZIP detects corrupted member CRC and refuses canonical path escape`.
- [operator/dayone.test.ts](../tests-node/operator/dayone.test.ts): `ZIP refuses symlink, encrypted, unsupported and duplicate central directory members`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **PlainTest (3):** `test_markdown_becomes_plain_text`, `test_entry_links_go_to_their_day_and_app_links_keep_their_words`, `test_awkward_markdown_keeps_its_content`.
- **WhenAndWhereTest (4):** `test_the_day_is_in_the_entrys_zone_and_old_zone_names_are_renamed`, `test_a_place_keeps_all_day_one_knew`, `test_a_street_address_is_an_address_and_a_label_is_the_writers`, `test_places_fall_back_from_entry_to_photo_to_day_to_home`.
- **FilesTest (2):** `test_files_are_found_by_md5_whatever_their_extension`, `test_media_keys_follow_the_note`.
- **PlanTest (11):** `test_an_entry_becomes_a_note_like_any_other`, `test_another_journals_name_is_a_tag`, `test_a_long_entry_is_cut_before_its_tags`, `test_an_entry_of_only_videos_is_counted_not_lost_quietly`, `test_files_to_copy_are_listed_apart_from_the_note`, `test_day_ones_own_guide_is_left_out`, `test_an_all_day_entry_is_a_note_at_midnight_on_its_date`, `test_empty_entries_are_left_out`, `test_an_entry_whose_id_is_not_day_ones_is_left_out_and_counted`, `test_only_export_shaped_file_names_are_looked_up`, `test_weather_takes_the_days_first_real_place_across_journals`.
- **ReadTest (3):** `test_reads_the_journal_and_every_file_size`, `test_refuses_a_journal_too_big_unpacked_before_reading_it`, `test_refuses_a_zip_with_no_journal`.

### describe: Opt-in photo model processing (23 methods)

No secret/model resolution without unfinished opted-in photos; immutable media/live consent rechecks; fixed prompt and provider error classification; empty/refused/oversized outputs, code-point truncation, one key per run; backfill lease, resume, failure release, opt-out, stream retries and synthetic check.

Native witnesses:

- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `model request is exact fixed photo+prompt; text-only answer normalizes and truncates Unicode`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `opt-out/no account/deleting account never resolves model; changed media completion rejected`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `backfill chain hands on near limit, other chain refuses, same chain resumes and releases USER lock`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `failed describe backfill releases chain lock and retry succeeds; opt-out stops each next photo`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `synthetic model check writes nothing and logs no returned words`.
- [processing/proofs.test.ts](../tests-node/processing/proofs.test.ts): `processing exact document transaction proves consent, media source, lease and quota`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **StreamTest (11):** `test_a_note_with_photos_has_each_described_and_nothing_else_sent`, `test_nothing_is_sent_unless_its_owner_turned_it_on`, `test_an_old_record_of_a_note_since_described_sends_nothing`, `test_too_big_to_send_is_left_alone`, `test_wider_than_the_model_takes_is_done_with_no_words`, `test_a_photo_the_model_cannot_read_gets_no_words_and_is_not_tried_again`, `test_rate_limited_overloaded_or_refused_key_is_raised_so_the_stream_tries_again`, `test_a_request_the_api_refuses_for_every_photo_leaves_them_waiting`, `test_a_refusal_or_thinking_that_used_every_token_gets_no_words`, `test_long_words_are_cut_and_runs_of_space_closed_up`, `test_turning_it_on_starts_describe_all_and_nothing_else`.
- **DescribeAllTest (7):** `test_every_photo_already_kept_is_described`, `test_short_on_time_it_hands_the_rest_to_another_pass`, `test_turned_off_meanwhile_it_stops`, `test_one_chain_at_a_time_however_often_it_is_turned_on`, `test_a_failed_pass_lets_go_and_its_retry_takes_the_lock_back`, `test_a_photo_described_meanwhile_is_not_sent_again`, `test_a_photo_gone_from_the_bucket_is_skipped`.
- **KeyTest (3):** `test_the_placeholder_sends_nothing_and_leaves_photos_waiting`, `test_no_photo_waiting_reads_no_key`, `test_a_real_key_goes_in_the_header_once_a_run`.
- **CheckTest (2):** `test_a_check_describes_a_made_up_image_and_writes_nothing`, `test_a_check_says_what_went_wrong`.

### docs: Executable documentation inventory (4 methods)

API method/path, frontend pages, MCP generated schemas, every persisted prefix and operator/build script. Python file/module naming is replaced by the native source inventory, not retained as an application requirement.

Native witnesses:

- [docs/inventory.test.ts](../tests-node/docs/inventory.test.ts): `native API table documents every method/path and has no stale route`.
- [docs/inventory.test.ts](../tests-node/docs/inventory.test.ts): `every native frontend route appears in the documented Pages list`.
- [docs/inventory.test.ts](../tests-node/docs/inventory.test.ts): `agent guide names every native operator/build tool and retained script`.
- [docs/inventory.test.ts](../tests-node/docs/inventory.test.ts): `Store design documents every persisted key prefix used by archive and MCP services`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Docs (4):** `test_every_route_is_in_the_api_table_and_no_more`, `test_every_page_is_in_the_pages_list`, `test_every_key_prefix_is_in_the_store_layout`, `test_every_module_and_script_is_in_agents_md`.

### event_bridge: Delivery-event privacy and deduplication (7 methods)

Hard bounce/complaint receipt + live-profile stop + tally in one transaction, duplicate receipt retained after restart, unknown failures/retries, soft events and strangers unchanged, scrubbed ops-only messages.

Native witnesses:

- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `SNS concurrent duplicate hard bounce stops/tallies once, retained receipt survives restart`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `complaints stop; transient bounce and routine delay do not; unknown mail yields scrubbed line`.
- [mail/proofs.test.ts](../tests-node/mail/proofs.test.ts): `SNS exact native SDK transaction combines receipt, profile barrier and monthly ADD`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `SNS failure retries safely, missing message ID refuses non-deduplicated account mutation`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Bridge (7):** `test_parallel_old_new_subscription_deliveries_apply_once`, `test_duplicate_after_owner_restart_does_not_stop_again`, `test_deleted_or_deleting_account_never_recreated_or_counted`, `test_missing_message_id_refuses_account_write`, `test_sns_publish_failure_retries_receipt_without_second_tally`, `test_expired_receipt_is_refreshable_and_content_free`, `test_logs_and_ops_notice_preserve_private_boundary`.

### exif: JPEG metadata (11 methods)

Endian/layout/rational/tag parsing, signed coordinates, original timestamp/offset, malformed/unknown data, and ordinary Pillow-produced JPEG EXIF format. Native fixture decoder preserves the format rather than importing Pillow to generate it during tests.

Native witnesses:

- [services/services.test.ts](../tests-node/services/services.test.ts): `JPEG metadata agrees with 509 synthetic originals and malformed variants`.
- [services/services.test.ts](../tests-node/services/services.test.ts): `real thumbnail is upright, bounded, and contains no EXIF GPS or original metadata`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `photo place naming sends coordinates only, guards deletion and weather failure remains nicety`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Read (10):** `test_time_and_place`, `test_either_byte_order`, `test_after_a_jfif_segment`, `test_south_and_east`, `test_only_what_is_there`, `test_no_fix_is_no_place`, `test_bad_values_are_left_out`, `test_anything_else_is_nothing`, `test_a_pointer_past_the_end_is_nothing`, `test_never_raises_on_noise`.
- **FromPillow (1):** `test_reads_what_pillow_wrote`.

### export_zip: Private file export lifecycle (15 methods)

Owner-only safe archive paths, original files alongside JSON/Markdown, missing-file accounting, build/ready/expiry/replacement states, failure status, ZIP object access, immutable build ownership and deletion race cleanup.

Native witnesses:

- [export/export.test.ts](../tests-node/export/export.test.ts): `JSON and Markdown owner exports match 16 independent Python goldens`.
- [export/export.test.ts](../tests-node/export/export.test.ts): `disk zip contains complete data and original files; missing files remain counted only`.
- [export/export.test.ts](../tests-node/export/export.test.ts): `replaced or deleting builds cannot publish an export`.
- [export/export.test.ts](../tests-node/export/export.test.ts): `atomic completion refuses a deletion that starts after the final profile read`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `export words and zip status/download keep owner-private wire contracts`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **FilePathsTest (1):** `test_numbered_through_each_day_in_order`.
- **JobTest (14):** `test_start_build_download`, `test_the_zip_holds_notes_and_files`, `test_a_photo_described_keeps_its_words_as_alt_text`, `test_a_file_gone_since_is_left_out`, `test_a_failed_build_says_so_and_raises`, `test_a_build_past_its_time_failed`, `test_one_build_at_a_time`, `test_a_new_build_replaces_the_old_zip`, `test_a_build_replaced_before_it_starts_does_nothing`, `test_a_build_replaced_while_it_runs_deletes_its_own_zip`, `test_starting_fails_cleanly_when_lambda_is_down`, `test_a_ready_zip_is_offered_for_a_day`, `test_only_for_an_account_and_from_the_site`, `test_deleting_the_account_deletes_the_zip`.

### handlers: Event workers and daily schedule (100 methods)

Local calendar/due window and DST, one send per day, retries and owned cleanup, welcome/metrics/census, no dry-run mutation, budget/time reserve; history/streak/places/photos and fallback failures; inbound ownership, SES-only DMARC/DKIM, raw From, malware/spam/automatic refusal, 72-hour and old-token deadlines, MIME/media/retry, standing address/local receipt day, and rate-limited late replies.

Native witnesses:

- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `due windows use local wall time, cap at midnight, and refuse sent/future day`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `concurrent sender claims produce one email and stable day token; repeats do not resend`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `dry-run reports content-free history and performs no SDK mutation or mail send`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `history preserves assistant provenance, tags from words, written order and place distinction`.
- [mail/sender-boundaries.test.ts](../tests-node/mail/sender-boundaries.test.ts): `history, streak, yesterday and census read failures preserve daily send and log only safe error kind`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `inbound reply stays on original day, truncates by code point and retry is one note`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `DKIM fallback only uses first SES header, aligned domain, explicit GRAY; forged local parts do not align`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `72-hour boundary accepted, later reply sends one threaded account notice and retains ignored raw mail`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `standing address uses received local day/version and ignores subject; replaced or stopped files nothing`.
- [mail/proofs.test.ts](../tests-node/mail/proofs.test.ts): `late notice exact SDK transaction atomically proves active account, token owner and capped counter`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Sending (51):** `test_agent_names_survive_yesterday_and_on_this_day_in_both_email_parts`, `test_due_window`, `test_late_send_time_window_stops_at_midnight`, `test_sends_once_per_day`, `test_failed_send_is_released_for_retry`, `test_ses_from_keeps_the_display_name`, `test_daily_email_is_tagged_for_the_mail_metrics`, `test_a_scheduled_run_ends_with_the_census_line`, `test_no_census_on_a_dry_run_or_send_now`, `test_a_failed_census_never_fails_the_run`, `test_sent_at_is_the_real_send_time`, `test_now_is_refused_on_a_real_send`, `test_send_now_sends_outside_the_window_once`, `test_only_the_first_email_says_welcome`, `test_a_failed_send_leaves_no_reply_address`, `test_the_slow_parts_come_before_the_claim`, `test_stops_starting_sends_when_time_is_short`, `test_weather_has_a_budget_for_the_whole_run`, `test_send_now_only_sends_to_the_named_subscriber`, `test_send_now_refuses_an_unknown_or_paused_subscriber`, `test_dry_run_writes_nothing`, `test_email_carries_the_streak`, `test_email_carries_last_years_notes`, `test_last_years_photos_are_a_link`, `test_last_years_links_show_by_name`, `test_email_confirms_yesterdays_notes`, `test_a_birthday_sums_up_the_release_just_closed`, `test_no_closed_block_on_other_days_or_without_notes`, `test_yesterdays_places_once_each_in_the_order_written`, `test_yesterdays_own_place_comes_first`, `test_no_yesterday_block_and_no_read_without_notes`, `test_a_reply_with_only_a_pdf_still_confirms`, `test_yesterday_is_one_read_of_its_notes`, `test_yesterdays_own_place_is_read_once_for_the_block_and_the_weather`, `test_yesterday_read_failure_still_sends`, `test_yesterdays_weather_waits_when_its_notes_cannot_be_read`, `test_photos_go_inside_the_email_yesterdays_first`, `test_alt_text_is_the_description_only_when_turned_on`, `test_at_most_about_400_kb_of_photos`, `test_a_photo_without_a_thumbnail_or_gone_is_left_as_a_link`, `test_only_its_own_thumbnails`, `test_a_bucket_failure_sends_without_photos`, `test_no_notes_a_year_ago_no_section`, `test_every_earlier_release_on_this_day`, `test_on_this_day_read_failure_still_sends`, `test_history_read_failure_still_sends`, `test_streak_read_failure_still_sends`, `test_a_pause_skips_its_days_only`, `test_the_streak_waits_through_a_pause`, `test_dry_run_reports_the_streak`, `test_local_date_not_utc_date`.
- **Inbound (27):** `test_files_note_under_the_emails_day`, `test_hashtags_in_a_reply_are_its_tags`, `test_links_are_named_and_titled`, `test_photos_and_recordings_are_copied_out`, `test_a_photo_alone_is_a_note`, `test_a_note_without_links_fetches_nothing`, `test_retry_is_idempotent`, `test_every_reply_to_a_days_email_is_kept`, `test_from_mismatch_ignored`, `test_two_from_addresses_ignored`, `test_out_of_office_ignored`, `test_a_very_long_reply_keeps_its_first_20000_characters`, `test_unknown_token_and_plain_address_ignored`, `test_spam_ignored`, `test_dmarc_fail_ignored`, `test_no_dmarc_policy_needs_aligned_dkim_from_ses`, `test_no_dmarc_policy_unaligned_dkim_ignored`, `test_forged_results_header_not_trusted`, `test_a_dkim_local_part_is_not_its_domain`, `test_header_d_names_the_signer`, `test_a_dmarc_fail_is_not_rescued_by_dkim`, `test_a_reply_is_filed_for_72_hours_after_its_email`, `test_a_token_from_before_sent_at_runs_to_the_end_of_four_days_on`, `test_the_raw_from_must_be_the_one_address_too`, `test_a_virus_scan_that_failed_is_a_virus`, `test_mime_nested_too_deep_is_ignored_not_retried`, `test_an_emailed_file_that_is_not_what_it_says_stays_in_the_email`.
- **StandingAddress (12):** `test_the_address_and_its_profile_are_read_consistently`, `test_filed_on_their_own_day_at_receipt_with_no_window`, `test_their_day_is_their_zones`, `test_a_photo_with_no_words_is_a_note`, `test_every_other_check_still_holds`, `test_a_stopped_subscribers_address_files_nothing`, `test_a_replaced_address_files_nothing`, `test_a_reply_address_is_not_a_standing_one`, `test_the_first_email_makes_it_and_the_footer_names_it`, `test_the_footer_names_the_address_as_it_is_now`, `test_one_that_cannot_be_made_leaves_the_line_out`, `test_a_dry_run_says_so_and_makes_nothing`.
- **LateReply (10):** `test_a_late_reply_gets_one_short_email_back`, `test_one_notice_per_reply_address`, `test_a_few_notices_a_day_at_most`, `test_no_notice_unless_the_sender_is_proven`, `test_no_notice_to_an_automatic_reply`, `test_a_stopped_subscriber_gets_nothing`, `test_a_failed_send_is_logged_and_the_reply_still_ignored`, `test_a_failed_table_call_is_logged_too`, `test_a_reply_without_a_usable_message_id_is_answered_unthreaded`, `test_a_late_replys_body_is_never_read`.

### importer: Imported ownership and idempotency (6 methods)

Original raw/media bytes, note text/app/place/link/weather fields and tags; native numeric DynamoDB values; ledger survives deletion and reimport across journals/zones; note+ledger live-profile transaction and failure cleanup. Per-attempt staging now also proves losing concurrent imports cannot overwrite/delete winner bytes.

Native witnesses:

- [operator/importer.test.ts](../tests-node/operator/importer.test.ts): `fictional legacy import writes files/originals/note links/weather with native numbers and tags`.
- [operator/importer.test.ts](../tests-node/operator/importer.test.ts): `repeat skips every upload; deleted note stays deleted even across journals or changed entry zone`.
- [operator/importer.test.ts](../tests-node/operator/importer.test.ts): `atomic import exact SDK request commits note and native set ledger with account proof`.
- [operator/importer.test.ts](../tests-node/operator/importer.test.ts): `overlapping imports with different bytes keep winner references immutable and clean only loser staging`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **WriteTest (5):** `test_writes_files_originals_notes_links_and_weather`, `test_a_repeat_writes_nothing_and_a_deleted_note_stays_deleted`, `test_a_note_with_the_id_on_another_day_is_not_doubled`, `test_kept_weather_stands_and_today_is_left_alone`, `test_each_journal_has_its_own_ledger`.
- **StoreNumbersTest (1):** `test_a_note_goes_with_decimals_all_the_way_down`.

### links: Guarded URL fetch and shared rendering (27 methods)

Only ordinary HTTP(S)/ports with fully public DNS answers; reject local/encoded/numeric/private targets; validate redirects and pinned connection address including TLS SNI; wall deadline and byte/type/charset bounds, metadata preferences/entities/truncation, once-only collection, retained titles and escaped segments.

Native witnesses:

- [links/guards.test.ts](../tests-node/links/guards.test.ts): `only ordinary http ports and public DNS answers can be contacted`.
- [links/guards.test.ts](../tests-node/links/guards.test.ts): `redirect rechecks DNS and keeps the exact validated connection address`.
- [links/guards.test.ts](../tests-node/links/guards.test.ts): `one wall clock deadline bounds a stalled DNS lookup or response`.
- [links/guards.test.ts](../tests-node/links/guards.test.ts): `page metadata preserves HTML entities, preference, charset and word truncation`.
- [links/guards.test.ts](../tests-node/links/guards.test.ts): `named links, retained titles, bounded fetches and rendering match the legacy shape`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Fetch (10):** `test_title_and_site`, `test_follows_redirects_checking_each`, `test_a_redirect_inward_is_refused`, `test_at_most_three_redirects`, `test_only_html_on_a_200`, `test_failures_are_no_title`, `test_out_of_time_before_connecting`, `test_a_server_that_trickles_its_headers_is_cut_off`, `test_a_lookup_that_hangs_is_cut_off`, `test_the_whole_fetch_has_one_limit`.
- **Guards (2):** `test_targets`, `test_only_public_addresses`.
- **Meta (3):** `test_prefers_open_graph_then_twitter_then_title`, `test_charset_from_header_or_meta`, `test_long_titles_are_cut_between_words`.
- **Collect (7):** `test_fetches_each_address_once_in_order`, `test_at_most_three_fetches_and_failures_are_skipped`, `test_named_links_are_not_fetched`, `test_named_words_may_wrap`, `test_an_edit_keeps_what_it_had`, `test_an_edit_that_drops_a_named_links_words_fetches_it`, `test_no_addresses_no_fetch`.
- **Show (5):** `test_segments`, `test_text_without_links_is_one_string`, `test_a_named_link_without_its_words_shows_short`, `test_plain_and_markdown`, `test_short`.

### mcp: OAuth grants and safe archive reader (31 methods)

Exact client/redirect/resource/PKCE, explicit owner consent and optional media/write scopes, single-use code, refresh generation/replay revocation, indexed cleanup; initialized protocol/auth/errors, scope-limited bytes/private links, safe provenance, paging/filter-bound cursors, search/tags/releases/context, continuation budgets, rate limits and sanitized failures. MCP has no web write/session authority.

Native witnesses:

- [oauth/oauth.test.ts](../tests-node/oauth/oauth.test.ts): `discovery, exact safe redirects, public clients, duplicate form keys and no metadata leaks`.
- [oauth/oauth.test.ts](../tests-node/oauth/oauth.test.ts): `PKCE/resource/client/redirect, code single use and expiry without TTL`.
- [oauth/oauth.test.ts](../tests-node/oauth/oauth.test.ts): `rotating refresh invalidates old access; used refresh revokes the family and indexes extend`.
- [oauth/oauth.test.ts](../tests-node/oauth/oauth.test.ts): `account deletion blocks concurrent token writes first, then purges all indexed credentials/metadata`.
- [mcp/mcp.test.ts](../tests-node/mcp/mcp.test.ts): `native Hono protocol negotiation, auth challenge, methods/origin, notifications and schemas`.
- [mcp/mcp.test.ts](../tests-node/mcp/mcp.test.ts): `list/search/day/note/context/tags share writing order, Unicode folding, provenance and strong reads`.
- [mcp/mcp.test.ts](../tests-node/mcp/mcp.test.ts): `all huge Unicode/import notes and audio finish continuation without raw keys or descriptions`.
- [mcp/mcp.test.ts](../tests-node/mcp/mcp.test.ts): `media read scope, prefixes, existing descriptions/transcripts, bounded bytes and private downloads`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **OAuthTests (14):** `test_discovery_and_unauthenticated_challenge`, `test_registration_rejects_unsafe_redirects_and_secrets`, `test_authorize_rejects_redirect_scope_resource_pkce`, `test_consent_requires_session_origin_and_single_use`, `test_deny_and_pending_expiry`, `test_pkce_resource_client_redirect_and_code_single_use`, `test_code_and_access_expiry_do_not_depend_on_ttl`, `test_refresh_rotation_replay_and_index_expiry`, `test_refresh_atomic_conflict_revokes_winner`, `test_disconnect_owner_only_and_no_web_bearer_writes`, `test_deleted_and_deleting_accounts_fail_closed_and_purge`, `test_stopped_subscriber_can_read_without_processing_changes`, `test_actual_account_delete_removes_all_grants`, `test_origin_proof_even_for_discovery`.
- **ReaderTests (13):** `test_list_search_day_note_context_tags_and_order`, `test_arguments_cannot_select_another_account_or_unknown_fields`, `test_cursors_bound_to_account_and_filters`, `test_release_filter_rejects_unrepresentable_anniversaries`, `test_store_file_and_activity_failures_escape_without_private_exception_details`, `test_long_unicode_note_and_transcript_continuations`, `test_media_scopes_prefix_guards_and_inline_results`, `test_large_audio_download_missing_transcript_and_no_processing`, `test_activity_contains_no_queries_results_or_addresses`, `test_budget_pagination_returns_every_item_and_unicode_audio`, `test_dynamodb_decimal_fields_render_as_json_numbers`, `test_hourly_and_daily_quota`, `test_protocol_shapes_negotiation_and_notifications`.
- **StorageContractTests (4):** `test_native_transaction_conditions_and_failures`, `test_strong_reads_and_delete_barrier_shape`, `test_generated_contract_matches_declarations`, `test_mcp_role_has_only_metadata_writes_and_media_reads`.

### media: Attachment admission and record shape (10 methods)

Magic bytes, supported types, names/raw ordinals, logo removal, file/count/byte limits, refused/unextracted files, native uploaded sizes and shared text/file count helpers. Originals remain private and immutable.

Native witnesses:

- [services/services.test.ts](../tests-node/services/services.test.ts): `media checks bytes, drops logos and limits files without losing raw attachment order`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `uploads check signed exact-size/type, immutable pending version, keep private metadata, clean refused commits`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `media appends claim prior size and fields update the right list entry only`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `unsupported attachments still file raw-only notes; refused media remains listed`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Sizes (2):** `test_reads_the_common_headers`, `test_unreadable_is_none`.
- **Types (1):** `test_types_and_aliases`.
- **Found (5):** `test_photos_and_recordings_in_order_without_logos`, `test_a_file_that_is_not_what_it_says_is_left_in_the_email`, `test_text_alone_has_none`, `test_at_most_twenty`, `test_those_past_twenty_are_counted_as_in_the_original_email`.
- **Store (1):** `test_keys_and_entries`.
- **Words (1):** `test_the_links_words`.

### notes: Shared note semantics (10 methods)

Written-time order including legacy received_at, source-independent combination, assistant provenance and named links, chosen/photo/home place labels, coordinate-free display and escaped Apple Maps targets.

Native witnesses:

- [store/store.test.ts](../tests-node/store/store.test.ts): `notes order by writing time across pages, range includes last day, duplicate ids are no-op`.
- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `combined notes retain attribution, first named links and legacy timestamps`.
- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `place labels and map URLs expose names and preserve legacy escaping`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `notes/readers/tag/search/release share provenance and safe DTOs across native routes`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **DayNotes (2):** `test_one_day_oldest_first_across_pages`, `test_a_range_of_days_takes_in_the_last_days_notes`.
- **Combine (6):** `test_replies_read_as_one_day`, `test_one_reply_is_itself`, `test_photo_only_reply_adds_no_text`, `test_a_reply_sent_twice_shows_once`, `test_no_notes`, `test_duplicate_words_from_different_authors_keep_attribution`.
- **MapUrl (2):** `test_a_spot_links_to_its_own_coordinates_under_its_name`, `test_no_link_without_coordinates_or_for_the_home_city`.

### origin: Private HTTP origin mechanism (7 methods)

The custom X-Origin-Verify/ORIGIN_SECRET and API Gateway event adapter are retired. Distribution-scoped CloudFront OAC with always-signed requests plus endpoint IAM policy is the replacement. The application still checks write Origin and treats viewer-address limits as trusted only behind that origin boundary.

Native witnesses:

- [web-platform.test.ts](../tests-node/web-platform.test.ts): `exact grant is limited to one distribution and one live endpoint`.
- [web-platform.test.ts](../tests-node/web-platform.test.ts): `release pin refuses public/latest/in-progress/canary endpoints`.
- [web-platform.test.ts](../tests-node/web-platform.test.ts): `existing unowned or concurrently changed policy is never overwritten/deleted`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `every existing route is declared; unknown paths/private queries never logged; Origin precedes body or writes`.
- [http/acceptance.test.ts](../tests-node/http/acceptance.test.ts): `native harness: 128 parallel reads and controlled owner writes retain isolation and content-free logs`.

Obsolete: all seven original methods asserted the retired `ORIGIN_SECRET` custom-header/event-adapter gate. Preserve the private-origin requirement through OAC/IAM and retain the application Origin guard; do not recreate or log the secret.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **OriginSecretTest (7):** `test_refused_without_the_header`, `test_refused_with_a_wrong_header`, `test_refused_before_any_route`, `test_accepted_with_the_header`, `test_header_never_logged_or_kept`, `test_compared_in_constant_time`, `test_no_secret_no_check`.

### parse: Bounded MIME to words (14 methods)

Plain preferred/HTML fallback, nested alternatives, quoted replies/signatures/mail client conventions, CRLF and entity decoding, Unicode limit and empty body; native parser additionally bounds raw bytes, headers and nesting without remote fetches.

Native witnesses:

- [mail/parse.test.ts](../tests-node/mail/parse.test.ts): `legacy MIME/body parity: ${row.name}`.
- [mail/parse.test.ts](../tests-node/mail/parse.test.ts): `bounded MIME nesting is rejected after headers can be read`.
- [mail/parse.test.ts](../tests-node/mail/parse.test.ts): `bounded MIME nesting is rejected after headers can be read`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `body and subject truncate by Unicode code point without splitting emoji`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **StripReply (8):** `test_gmail_attribution_wrapped`, `test_apple_mail`, `test_apple_mail_unquoted_attribution`, `test_outlook`, `test_outlook_headers_without_rule`, `test_signature`, `test_keeps_sentences_that_start_with_on`, `test_keeps_a_from_line_that_is_not_a_header_block`.
- **Bodies (6):** `test_plain`, `test_prefers_plain_alternative`, `test_html_only_drops_gmail_quote`, `test_html_entities_and_blockquote`, `test_apple_mixed_text_around_image`, `test_audio_attachment_listed_not_read`.

### pause_delete: Pause, standing address and account deletion (25 methods)

Pause starts after already-sent local day, elapsed pause history survives resume, future spans replace/remove, bounded dates and active status; address rotation CAS; purpose-separated newest codes and sessions, OAuth deleting barrier, complete table/token/session/raw/media/export cleanup and fail-closed object errors. Native transactions also prevent in-flight writers resurrecting deleted accounts.

Native witnesses:

- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `pause changes preserve elapsed history, replace future spans and use the subscriber local sent day`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `settings lock birthday, pause boundaries/resume, inbox rotation, stop/restart and token unsubscribe`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `standing address replacement atomically removes old and fails closed for races`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `account deletion requires purpose-separated code and removes all user objects/sessions/tokens`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `file deletion failure preserves note/account and a deletion code cannot authenticate sign-in`.
- [mail/proofs.test.ts](../tests-node/mail/proofs.test.ts): `atomic session create writes row and USER index with live profile proof; verified email-only has no account index`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `deletion during ${phase} cannot resurrect sender tokens or USER rows`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **PauseTest (10):** `test_pause_starts_after_todays_email`, `test_pause_holds_back_today_when_its_email_has_not_gone`, `test_lengths_are_checked`, `test_changing_a_running_pause_keeps_its_start`, `test_changing_a_pause_not_yet_begun_replaces_it`, `test_resume_keeps_the_days_already_paused`, `test_resume_drops_a_pause_not_yet_begun`, `test_a_stopped_subscriber_cannot_pause`, `test_pause_needs_our_origin`, `test_today_and_the_timeline_show_the_pause`.
- **StandingAddressTest (3):** `test_a_first_then_a_new_one_in_its_place`, `test_another_tab_got_there_first`, `test_signed_out_is_refused`.
- **DeleteTest (12):** `test_delete_everything_with_a_fresh_code`, `test_a_reply_saved_during_the_delete_is_deleted_too`, `test_a_standing_address_made_during_the_delete_goes_too`, `test_an_address_replaced_just_before_the_profile_goes_goes_too`, `test_the_code_is_used_up_and_the_sign_ins_go_with_the_account`, `test_every_browser_is_signed_out`, `test_a_sign_in_code_does_not_delete`, `test_a_deletion_code_does_not_sign_in`, `test_each_kind_keeps_its_own_newest`, `test_a_sign_in_from_before_purposes_still_signs_in_and_never_deletes`, `test_if_the_emails_cannot_be_deleted_nothing_is`, `test_needs_a_code_a_session_and_our_origin`.

### signup: Email-verified account lifecycle (23 methods)

No signup before address proof; birthday/time/place validation, atomic address collision handling and claimed session index, first email immediately, first-email failure retains account, locked birthday and settings, suppress-list restart only after bounce/complaint, signed-out/Origin refusal, old-token unsubscribe, SES event stop/ops privacy.

Native witnesses:

- [api/api.test.ts](../tests-node/api/api.test.ts): `email ownership sign-in burns shared link/code and verifies new addresses before signup`.
- [store/signup.test.ts](../tests-node/store/signup.test.ts): `verified signup creates profile/address and claims same live email session atomically`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `restart unsuppresses bounce/complaint only; SES failure retains stopped state and signup survives first-email failure`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `settings lock birthday, pause boundaries/resume, inbox rotation, stop/restart and token unsubscribe`.
- [services/services.test.ts](../tests-node/services/services.test.ts): `places reject spoofed values and retain only city precision`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `complaints stop; transient bounce and routine delay do not; unknown mail yields scrubbed line`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **SignUpTest (18):** `test_sign_up_creates_the_account_and_keeps_the_session`, `test_the_new_subscriber_lists_the_session`, `test_first_email_goes_now_even_with_the_send_time_ahead`, `test_sign_up_stands_when_the_first_email_cannot_start`, `test_sign_up_checks_everything`, `test_a_second_tab_joins_the_account_the_first_made`, `test_restarting_after_a_bounce_takes_the_address_off_the_suppression_list`, `test_restarting_after_unsubscribing_leaves_suppression_alone`, `test_restart_is_fine_when_ses_has_already_let_the_address_go`, `test_restart_fails_loudly_when_ses_cannot_be_asked`, `test_settings_change_send_time_and_city`, `test_birthday_is_locked`, `test_put_me_needs_a_session_and_our_origin`, `test_places_needs_a_session_and_a_query`, `test_one_click_unsubscribe`, `test_an_old_emails_unsubscribe_link_still_works`, `test_opening_the_unsubscribe_link_shows_a_page`, `test_start_the_emails_again`.
- **PlacesTest (1):** `test_search_keeps_the_city_and_rounds`.
- **BounceTest (4):** `test_hard_bounce_stops_the_emails`, `test_complaint_stops_the_emails`, `test_ops_get_kinds_and_ids_never_addresses_or_subjects`, `test_soft_bounces_and_strangers_change_nothing`.

### store: Exact DynamoDB contracts (58 methods)

Native-valued DocumentClient transactions/conditional failures; projected paged note/index/tag/census queries; DAY/TOKEN cleanup ownership; purpose indexes and session renewal/deletion; note/media list guards; live profile, places/weather CAS, inbox replacement, thumbnail numeric maps, upload counters/locks/tallies and atomic SES bridge. Native exact-shape tests replace Python table.meta.client/Decimal mechanics while retaining stored numeric/key compatibility.

Native witnesses:

- [store/store.test.ts](../tests-node/store/store.test.ts): `production document client satisfies injection interface without typed AttributeValues`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `account creation atomic and native-valued; collision cannot orphan a profile`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `notes order by writing time across pages, range includes last day, duplicate ids are no-op`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `login purpose isolation, newest-code indexing and legacy signin compatibility`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `sessions are indexed for deletion and touch/claim cannot recreate deleted sessions`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `atomic mail counters cannot overshoot under concurrent requests and denial consumes nothing`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `weather first write, replacement, conditional rename and deletion retain newer location`.
- [mail/proofs.test.ts](../tests-node/mail/proofs.test.ts): `SNS exact native SDK transaction combines receipt, profile barrier and monthly ADD`.

`WeatherItem.test_floats_go_as_decimals_and_the_first_reading_stands` and `StoreNumbersTest` in importer retain their data/atomicity contract through native DocumentClient numeric-value assertions. The Python-only Decimal conversion itself has no native counterpart. Exact SDK input tests still check request shapes, conditional expressions and transaction rollback; permissive high-level fakes alone are insufficient.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **CreateSubscriber (3):** `test_items_go_as_plain_values`, `test_a_taken_address_is_false`, `test_any_other_cancellation_is_an_error`.
- **ExportItem (3):** `test_start_puts_one_item_in_place_of_the_last`, `test_finish_only_the_build_still_named`, `test_a_replaced_build_is_false`.
- **WeatherItem (2):** `test_floats_go_as_decimals_and_the_first_reading_stands`, `test_between_reads_one_range`.
- **NoteQueries (4):** `test_every_note_is_the_whole_range_and_nothing_else`, `test_tags_bring_back_keys_and_tags_only`, `test_the_note_index_brings_back_keys_and_media_only`, `test_a_tag_brings_back_only_its_notes`.
- **ReviewRequests (4):** `test_put_day_gives_the_reply_address_its_send_time`, `test_drop_day_removes_the_reply_address_and_only_its_own_day`, `test_tally_adds_one_to_the_month`, `test_a_daily_counter_expires_two_days_on`.
- **LateNotice (3):** `test_marks_the_reply_address_once`, `test_already_marked_or_gone_is_false`, `test_any_other_failure_is_an_error`.
- **SignInPurposes (6):** `test_a_deletion_code_has_its_own_newest`, `test_a_sign_in_keeps_its_keys`, `test_a_sign_in_takes_one_with_no_purpose_from_before`, `test_a_deletion_takes_only_a_deletion_code`, `test_a_code_for_something_else_is_gone`, `test_deleting_the_account_finds_both_newest_and_what_they_name`.
- **SessionsListed (3):** `test_a_subscribers_session_is_listed_under_them`, `test_one_signing_up_is_not_until_it_is_claimed`, `test_renewing_renews_the_listing`.
- **UpdateNote (2):** `test_sets_links_and_tags_it_has_and_removes_the_rest`, `test_with_neither_both_go`.
- **AddMedia (2):** `test_appends_only_if_the_note_still_has_what_it_was_read_with`, `test_a_note_without_files_must_still_have_none`.
- **SetMediaText (2):** `test_the_words_go_on_the_file_with_that_number_if_it_is_still_there`, `test_no_note_or_no_such_file_writes_nothing`.
- **Places (8):** `test_a_days_own_place`, `test_read_just_after_a_write_is_consistent`, `test_a_ranges_own_places_are_one_query`, `test_weather_read_just_after_a_write_is_consistent`, `test_the_profile_goes_only_while_it_names_the_address_deleted`, `test_weather_for_a_place_gone_is_dropped`, `test_a_photo_names_a_note_with_no_place_only`, `test_weather_again_for_a_new_place`.
- **StandingAddress (5):** `test_read`, `test_a_first_one`, `test_a_new_one_in_place_of_the_old_in_one_transaction`, `test_a_profile_that_moved_on_keeps_neither`, `test_any_other_failure_raises`.
- **Thumbnails (2):** `test_a_thumb_goes_on_the_file_as_a_map_with_numbers`, `test_every_subscriber_id_from_the_profiles_keys`.
- **CostCeilings (3):** `test_an_upload_counts_its_form_and_size_unless_the_day_is_full`, `test_a_lock_is_taken_if_free_run_out_or_already_the_holders`, `test_a_lock_is_let_go_only_by_its_holder`.
- **CensusItems (1):** `test_one_paged_scan_of_keys_and_a_few_fields_never_text`.
- **MailEventBridge (5):** `test_stop_tally_receipt_are_one_plain_value_transaction`, `test_duplicate_and_deleted_profile_are_bounded_outcomes`, `test_unknown_failures_are_never_swallowed`, `test_conflict_retries_are_bounded_and_exhaustion_propagates`, `test_conflict_can_recover_without_splitting_the_transaction`.

### streak: Calendar streaks (10 methods)

Deduplicate a day, end yesterday, today excluded, gaps reset quietly, late notes mend, paused empty days neither add nor break, imported days count; leap/year/empty boundaries.

Native witnesses:

- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `streaks mend late gaps, exclude today and skip paused empty days`.
- [mail/compose-boundaries.test.ts](../tests-node/mail/compose-boundaries.test.ts): `streak copy preserves first, broken, singular, record and below-record branches without calling out a break`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `subscriber defaults, calendar dates, pause boundaries and home place`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Streaks (10):** `test_no_notes`, `test_run_ending_yesterday`, `test_missed_yesterday_ends_it_quietly`, `test_longest_is_kept_after_a_break`, `test_late_reply_fills_the_gap`, `test_today_does_not_count`, `test_paused_days_neither_break_nor_add`, `test_a_pause_running_now_holds_the_run`, `test_a_note_on_a_paused_day_counts`, `test_pause_days`.

### tags: Hashtags and Unicode offsets (8 methods)

Lowercase/hyphen slug validation, dedup/sort, Unicode hashtags, hashtags only in text, rendered segments preserve code-point offsets and named links; no tag index. Existing tags are recomputed on edits.

Native witnesses:

- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `synthetic legacy goldens cover Unicode tags, offsets, trimming and quoted search`.
- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `hashtags preserve named link parts and use codepoint offsets`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `notes/readers/tag/search/release share provenance and safe DTOs across native routes`.
- [store/store.test.ts](../tests-node/store/store.test.ts): `edits remove stale links and tags, missing note is not recreated`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **SlugTest (2):** `test_lowercase_words_joined_by_hyphens`, `test_long_names_are_cut_without_a_trailing_hyphen`.
- **FoundTest (4):** `test_hashtags_are_the_tags_once_each_in_order`, `test_what_is_not_a_tag`, `test_punctuation_after_a_hashtag_ends_it`, `test_at_most_twenty`.
- **LineTest (1):** `test_names_from_elsewhere_as_hashtags`.
- **SplitTest (1):** `test_hashtags_split_out_of_text_parts`.

### thumbs: Opt-out-independent thumbnails and photo place (24 methods)

Stable adjacent thumbnail keys, native JPEG size/dimension/orientation/paper/no-EXIF properties, original unchanged; missing/corrupt photos marked once, stale note/media guard and cleanup, EXIF fills only absent fields, coordinate-only geocoding, existing/chosen place retained, locality absence and geocoder retry, dry-run counts/time handoff. Optional missing-Pillow cases are obsolete; verified Sharp packaging and codec probes replace that deploy assumption.

Native witnesses:

- [services/services.test.ts](../tests-node/services/services.test.ts): `real thumbnail is upright, bounded, and contains no EXIF GPS or original metadata`.
- [services/thumbnail-boundaries.test.ts](../tests-node/services/thumbnail-boundaries.test.ts): `native thumbnails flatten transparency onto paper, bound high-entropy bytes and refuse oversized decoded images`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `default stream path makes thumbnails without consent, original unchanged, stale events skip finished work`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `no-key batch still thumbnails every following record; failures scrub and do not hide other thumbnail work`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `photo place naming sends coordinates only, guards deletion and weather failure remains nicety`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `transient geocode failure leaves photos unmodeled, makes later batch thumbnails and retries scrubbed`.
- [processing/describe.test.ts](../tests-node/processing/describe.test.ts): `thumb backfill dry-run is entirely read-only/no model; real near-limit pass hands remaining users on`.
- [artifacts/package.test.ts](../tests-node/artifacts/package.test.ts): `all seven workers package their own entry; only describe includes sorted, unchanged native modules`.

Obsolete only: `Making.test_without_pillow_photos_wait` and `AllOfThem.test_a_real_pass_without_pillow_refuses`. Sharp is packaged and verified for Linux ARM64 before promotion; a missing native codec is a failed artifact/runtime probe. `RealPillow` image-property methods are **replacements**, not obsolete; pixel/dimension/byte/metadata safety remains tested.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Keys (3):** `test_beside_the_photo`, `test_waiting_is_readable_photos_without_one`, `test_deleting_a_note_deletes_its_thumbnails`.
- **Making (7):** `test_made_beside_the_photo_and_listed_on_it`, `test_one_that_cannot_be_made_is_marked_and_not_tried_again`, `test_a_photo_gone_from_the_bucket_gets_none`, `test_a_note_deleted_meanwhile_takes_its_thumbnail_with_it`, `test_the_stream_makes_them_for_everyone_and_describes_only_for_those_who_asked`, `test_a_missing_key_costs_no_photo_in_the_batch_its_thumbnail`, `test_without_pillow_photos_wait`.
- **Where (7):** `test_a_photos_place_names_its_note_and_moves_the_days_weather`, `test_the_note_is_read_consistently_before_it_is_named`, `test_a_note_with_a_place_keeps_it`, `test_no_locality_keeps_the_spot_without_a_name`, `test_a_geocoder_failure_fails_the_batch_after_the_rest_so_the_stream_sends_it_again`, `test_exif_fills_in_only_what_the_entry_lacks`, `test_no_gps_no_question`.
- **AllOfThem (3):** `test_a_dry_run_counts_and_writes_nothing`, `test_a_pass_makes_them_and_hands_on_near_its_limit`, `test_a_real_pass_without_pillow_refuses`.
- **RealPillow (4):** `test_upright_small_and_without_the_originals_metadata`, `test_transparency_goes_on_paper`, `test_a_busy_photo_is_made_smaller_until_it_fits`, `test_not_an_image_or_a_bomb_is_none`.

### transcribe: Opt-in recording processing (14 methods)

Owner consent and immutable audio proof; job IDs/format/size guards, duplicate/stale events, 30/day and later-day backlog, profile-enable catch-up, completion cleanup and failed/foreign/deleted jobs, code-point output bound. Atomic request/metadata proofs prevent stale consent and deletion races.

Native witnesses:

- [processing/transcribe.test.ts](../tests-node/processing/transcribe.test.ts): `profile enable starts old recordings but false/unchanged/foreign stream rows do nothing`.
- [processing/transcribe.test.ts](../tests-node/processing/transcribe.test.ts): `30job quota held across independent worker instances; oversized and overquota stay waiting`.
- [processing/transcribe.test.ts](../tests-node/processing/transcribe.test.ts): `completed lease and legacy Python job write text, preserve fields and clean resources`.
- [processing/proofs.test.ts](../tests-node/processing/proofs.test.ts): `concurrent 31 distinct transcription reservations cap exactly at30 without partial leases`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **StartTest (7):** `test_a_note_with_a_recording_starts_one_job_for_it_alone`, `test_nothing_starts_unless_its_owner_turned_it_on`, `test_written_again_while_running_or_once_done_starts_nothing_new`, `test_an_old_record_of_a_note_since_written_out_starts_nothing`, `test_turning_it_on_writes_out_every_recording_already_kept`, `test_ids_that_cannot_name_a_job_are_left_alone`, `test_a_recording_bigger_than_any_upload_is_never_sent`.
- **DailyCapTest (2):** `test_turning_it_on_starts_the_days_share_and_leaves_the_rest_waiting`, `test_a_later_day_picks_up_what_waited`.
- **FinishTest (5):** `test_the_words_go_on_the_recording_then_the_json_and_job_go`, `test_a_failed_job_is_done_with_no_words_and_not_tried_again`, `test_a_note_deleted_meanwhile_just_loses_the_json`, `test_a_long_talk_is_cut_to_fit_the_note`, `test_someone_elses_job_is_ignored`.

### version: Calendar/version compatibility (7 methods)

Same sibling-site generated arithmetic fixtures; strict dates including leap birthday/early years, local-day timezone/DST, release span and On this day by patch across short years. Fixture generation remains tied to sibling computeVersion.

Native witnesses:

- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `version arithmetic matches all existing sibling-site fixtures`.
- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `strict calendar dates, leap anniversaries, early years and boundaries`.
- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `local day observes DST and timezone offsets without changing day arithmetic`.
- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `On this day traverses releases by patch and skips short years`.
- [docs/inventory.test.ts](../tests-node/docs/inventory.test.ts): `version golden and generator use the canonical native fixture path`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **VersionParity (3):** `test_matches_site`, `test_leap_day_birthday`, `test_decade`.
- **SameDayBefore (4):** `test_every_release_back_newest_first`, `test_every_answer_has_the_same_patch`, `test_the_366th_day_skips_365_day_releases`, `test_nothing_before_the_first_birthday`.

### weather: Best-effort place-aware weather (36 methods)

Bounded morning/history provider shape and Fahrenheit/rounding/copy; forecast always home, yesterday/day own place before note before home, shared fetch/run failure budget, dry-run never persists; old/current/future rules, preserve ordinary kept history, rename same spot without fetch, read/fetch/pre-write/post-write place races and conditional failed-replacement deletion; DTO/export credit and weather remains a nicety.

Native witnesses:

- [services/services.test.ts](../tests-node/services/services.test.ts): `weather validates readings, uses history archive and rounds Fahrenheit ties to even`.
- [services/weather-regression.test.ts](../tests-node/services/weather-regression.test.ts): `weather priority keeps ordinary history, renames identical coordinates without fetch, and waits for today`.
- [services/weather-regression.test.ts](../tests-node/services/weather-regression.test.ts): `weather ignores a stale read, rechecks a place changed during fetch, and reconciles changes just before write`.
- [services/weather-regression.test.ts](../tests-node/services/weather-regression.test.ts): `weather rename CAS preserves newer reading/name and repairs a rename immediately after its own commit`.
- [services/weather-regression.test.ts](../tests-node/services/weather-regression.test.ts): `failed or empty weather removes only obsolete location; a concurrently refreshed reading survives`.
- [mail/workers.test.ts](../tests-node/mail/workers.test.ts): `weather sharing/cache and first failure budget prevent one timeout per recipient`.
- [export/export.test.ts](../tests-node/export/export.test.ts): `JSON and Markdown owner exports match 16 independent Python goldens`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **Reading (4):** `test_morning_asks_once_for_yesterday_and_today`, `test_history_recent_from_the_forecast_api_older_from_the_archive`, `test_no_history_for_today`, `test_odd_answers_are_no_weather`.
- **Saying (3):** `test_lines`, `test_fahrenheit_where_it_is_used`, `test_a_place_needs_coordinates`.
- **Sending (8):** `test_the_morning_keeps_yesterday_and_forecasts_today`, `test_yesterdays_weather_is_where_its_notes_were_and_the_forecast_stays_home`, `test_a_days_own_place_comes_first_and_home_is_no_place`, `test_no_city_no_weather`, `test_neighbors_share_one_call_and_one_failure_ends_weather_for_the_run`, `test_open_meteo_down_the_email_goes_anyway`, `test_a_dry_run_forecasts_but_keeps_nothing`, `test_a_year_ago_with_its_weather`.
- **WebTest (21):** `test_a_past_day_gets_its_weather_with_its_first_note`, `test_a_note_with_a_place_brings_that_places_weather`, `test_a_days_own_place_fetches_again_and_clearing_goes_home`, `test_deleting_the_note_that_placed_the_day_takes_its_weather_home`, `test_weather_for_a_place_cleared_goes_when_home_has_none`, `test_weather_for_a_place_cleared_goes_when_the_fetch_fails`, `test_weather_written_since_the_read_is_replaced_for_the_new_place`, `test_a_place_changed_during_the_fetch_keeps_the_newer_ones_weather`, `test_a_place_changed_just_before_the_write_is_kept_again_where_the_day_is`, `test_a_rename_just_before_the_write_ends_under_the_days_name`, `test_another_name_for_the_same_spot_renames_the_weather`, `test_a_rename_leaves_weather_another_call_wrote_since`, `test_a_rename_racing_another_rename_ends_under_the_days_name`, `test_a_place_renamed_just_after_a_rename_is_renamed_again`, `test_the_answer_to_a_place_change_is_read_consistently`, `test_a_failed_fetch_leaves_weather_another_call_wrote_since`, `test_a_place_for_today_waits_and_a_bad_one_is_refused`, `test_another_note_does_not_move_a_kept_days_weather`, `test_today_waits_for_tomorrows_email`, `test_open_meteo_down_the_note_is_still_saved`, `test_the_export_carries_it`.

### web: Native HTTP auth and read exports (40 methods)

Health/sample/not-found/no raw path logging; Origin before writes and strict body handling; account existence hidden, hash-only link/code, newest/purpose/15-minute/single-use proof, 5/login and 20/day guesses, address/IPv4/IPv6/global counters and denial consumes none; 14-day sliding indexed sessions/daily cookie/replacement/signout, owner-only exports and exact historical JSON/Markdown wire DTOs.

Native witnesses:

- [api/api.test.ts](../tests-node/api/api.test.ts): `every existing route is declared; unknown paths/private queries never logged; Origin precedes body or writes`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `HTTP sign-in hides account existence, stores hashes, bounds code attempts and preserves newest/purpose/expiry`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `HTTP daily guess cap spans fresh logins but still permits the unguessable emailed link`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `sign-in limits compose address/IPv4/IPv6/total budgets; refusal consumes none and keeps alarm contract`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `sessions renew at daily boundary with USER index, expire idle, replace on sign-in and revoke on signout`.
- [api/parity.test.ts](../tests-node/api/parity.test.ts): `Python HTTP wire parity: `.
- [export/export.test.ts](../tests-node/export/export.test.ts): `JSON and Markdown owner exports match 16 independent Python goldens`.
- [mail/compose.test.ts](../tests-node/mail/compose.test.ts): `account and late-reply rendering matches legacy copy exactly`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **WebTest (39):** `test_health`, `test_sample`, `test_unknown_route_is_404`, `test_log_names_no_unmatched_path`, `test_writes_need_our_origin`, `test_bad_bodies`, `test_start_mails_a_link_and_code_and_stores_only_hashes`, `test_same_answer_with_or_without_an_account`, `test_link_signs_in_once`, `test_code_signs_in_and_burns_the_link`, `test_five_wrong_codes_lock_the_sign_in`, `test_twenty_wrong_codes_a_day_stop_new_sign_ins_guessing`, `test_code_is_checked_against_the_newest_sign_in`, `test_code_for_another_address_fails`, `test_sign_in_expires_after_15_minutes`, `test_limits_per_address_network_and_total`, `test_one_network_cannot_use_up_everyones_total`, `test_a_refused_request_counts_nowhere`, `test_the_total_is_logged_by_name`, `test_a_plus_tag_shares_its_address_limit`, `test_ipv6_networks_share_a_limit`, `test_an_ipv6_48_has_its_own_limit`, `test_mail_failure_says_so`, `test_me_for_a_subscriber_and_a_new_address`, `test_signed_out`, `test_each_visit_starts_the_14_days_again`, `test_a_subscribers_sessions_are_listed_under_them_and_renewed_with_them`, `test_session_cookie_is_renewed_at_most_once_a_day`, `test_idle_session_expires`, `test_sign_out_ends_the_session`, `test_signing_in_again_replaces_the_old_session`, `test_export_needs_an_account`, `test_export_json_and_markdown`, `test_export_has_a_heading_per_release`, `test_export_keeps_links`, `test_export_keeps_where_when_and_tags`, `test_export_keeps_a_days_own_place_first`, `test_export_shows_a_day_with_only_a_place`, `test_export_with_no_notes`.
- **SigninEmailTest (1):** `test_email_reads_in_both_parts`.

### web_notes: Native owner archive/write/media API (72 methods)

Today/day/release/tag/search DTOs and ordering/pages, birthday/local-day boundaries, any owner note edit/delete, retained/new title fetch, exact signed owner links with cache/reuse bounds, transcript/description opt-in visibility and search/export, chosen/timezone place labels, staged version-bound uploads/count/bytes/type/20-file limits and cleanup on rejection. Search words stay in POST bodies and logs remain content-free.

Native witnesses:

- [api/api.test.ts](../tests-node/api/api.test.ts): `notes/readers/tag/search/release share provenance and safe DTOs across native routes`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `uploads check signed exact-size/type, immutable pending version, keep private metadata, clean refused commits`.
- [api/guarded-conditional.test.ts](../tests-node/api/guarded-conditional.test.ts): `native HTTP upload count and byte ceilings return 429; refused forms consume no counter`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `native HTTP admission rejects bad bodies, empty or out-of-calendar notes and unsafe upload forms before media moves`.
- [api/api.test.ts](../tests-node/api/api.test.ts): `revocation at attachment commit removes copied media; renewal never resurrects revoked sessions`.
- [api/parity.test.ts](../tests-node/api/parity.test.ts): `Python HTTP wire parity: `.
- [domain/domain.test.ts](../tests-node/domain/domain.test.ts): `search covers text, place, titles and existing processing results`.
- [services/services.test.ts](../tests-node/services/services.test.ts): `version-bound copy retains checked bytes if an upload URL is reused`.
- [api/legacy-boundaries.test.ts](../tests-node/api/legacy-boundaries.test.ts): `file deletion failure preserves note/account and a deletion code cannot authenticate sign-in`.
- [http/acceptance.test.ts](../tests-node/http/acceptance.test.ts): `native harness: 128 parallel reads and controlled owner writes retain isolation and content-free logs`.

Enumerated legacy groups (`replacement` unless marked obsolete above):

- **TodayTest (4):** `test_today_with_nothing_yet`, `test_a_note_written_today_shows_with_the_emailed_one`, `test_streak_counts_today_once_it_has_a_note`, `test_needs_an_account`.
- **WriteTest (5):** `test_backfill_any_day_from_the_birthday`, `test_no_day_before_the_birthday_or_after_today`, `test_today_follows_the_subscribers_zone`, `test_the_text_must_be_something`, `test_writes_need_our_origin`.
- **EditDeleteTest (5):** `test_edit_any_note_emailed_ones_too`, `test_delete_a_web_note`, `test_deleting_an_emailed_note_deletes_its_email`, `test_if_the_email_cannot_be_deleted_the_note_stays`, `test_only_your_own`.
- **DaysTest (4):** `test_one_day`, `test_timeline_newest_first_and_pages_back`, `test_timeline_shows_a_days_own_place_and_a_day_with_only_one`, `test_timeline_limits`.
- **ReleasesTest (4):** `test_the_index_newest_first_with_the_current_one_marked`, `test_a_release_oldest_first_with_its_head_and_pages`, `test_the_current_release_runs_to_today`, `test_no_release_ahead_of_today_or_badly_named`.
- **LinksTest (3):** `test_a_new_note_names_its_links_once`, `test_an_edit_fetches_only_new_addresses`, `test_a_note_without_addresses_fetches_nothing`.
- **MediaTest (9):** `test_the_day_lists_files_with_their_signed_links`, `test_an_imported_pdf_lists_with_its_name`, `test_a_photo_with_a_thumbnail_answers_its_link_too`, `test_a_file_is_a_short_lived_redirect_for_its_owner`, `test_nobody_else_gets_one`, `test_a_key_outside_the_owners_files_is_never_signed`, `test_a_warm_function_hands_out_the_same_link_for_five_minutes`, `test_deleting_the_note_deletes_its_files`, `test_a_thumbnail_made_while_the_note_is_deleted_goes_too`.
- **TagsTest (7):** `test_hashtags_are_the_notes_tags`, `test_an_edit_works_the_tags_out_again`, `test_tags_from_an_emailed_note_count_too`, `test_a_tags_days_newest_first_with_only_its_notes`, `test_a_tags_days_and_searches_show_each_days_own_place`, `test_a_tag_nobody_used_is_no_days_and_a_bad_one_not_found`, `test_tags_need_an_account`.
- **WhereAndWhenTest (5):** `test_a_web_note_keeps_the_browsers_zone`, `test_no_zone_or_a_bad_one_is_the_subscribers`, `test_late_is_read_where_the_note_was_written`, `test_written_at_or_the_older_received_at`, `test_an_imported_note_shows_its_place_and_app`.
- **UploadTest (12):** `test_a_new_note_with_a_photo_a_recording_and_a_pdf`, `test_the_form_cannot_send_other_bytes_over_a_file_once_checked`, `test_a_note_from_before_keeps_its_upload_key`, `test_a_day_of_upload_forms_has_a_ceiling_by_count_and_by_size`, `test_the_form_is_for_that_type_and_exact_size_only`, `test_only_photos_recordings_and_pdfs_up_to_50_mb`, `test_a_file_not_sent_not_what_it_says_or_already_used_stops_the_note`, `test_a_bad_place_stops_the_note_before_its_files_move`, `test_another_persons_upload_is_not_found`, `test_files_join_a_note_already_there_after_its_own`, `test_at_most_20_files_a_note`, `test_a_note_with_files_may_be_edited_down_to_no_words`.
- **SearchTest (6):** `test_every_word_anywhere_without_case_or_accents_newest_first`, `test_a_quoted_phrase_is_one_term`, `test_places_and_link_names_are_found_too`, `test_the_answer_counts_all_and_shows_the_newest_100_days`, `test_the_words_are_needed_and_never_logged`, `test_only_the_signed_in_persons_notes`.
- **TranscriptTest (4):** `test_off_until_turned_on_and_only_by_a_yes_or_no`, `test_the_words_show_under_the_recording_and_waiting_ones_say_so`, `test_search_finds_what_was_said`, `test_the_words_only_export_keeps_what_was_said`.
- **DescriptionTest (4):** `test_off_until_turned_on_and_only_by_a_yes_or_no`, `test_the_page_gets_the_description_and_never_the_key`, `test_search_finds_what_is_in_a_photo`, `test_the_words_only_export_keeps_the_descriptions`.

## Architecture replacements and remaining scope

- Python Lambda event-to-HTTP routing is replaced by ordinary Hono `Request`/`Response`; native HTTP acceptance additionally exercises 128 concurrent reads, distinct owner writes, cookie/header/error privacy and in-flight shutdown.
- Boto3 table-resource and typed-value mechanics are replaced by the JS v3 DocumentClient and exact native-valued request tests. Persisted keys, snake_case record fields, legacy session/login hashes, capture fingerprints, dates and code-point limits remain compatible.
- Pillow/layer assertions are replaced by Sharp Linux ARM64 package inclusion, deterministic archive/source identities and early content-free runtime/codec probes. Opt-in description/transcription boundaries are retained independently of thumbnail availability.
- Direct CloudFront custom-header verification is replaced by OAC signing and distribution-scoped endpoint IAM. Pure policy/release tests prove exact scope, source/revision pins, uncertain-outcome retries and rollback guards; deployment readback belongs to the release receipt, not this local test inventory.

The bounded final audit restored missing regression assertions and found one native route-level regression: upload quota refusal became HTTP 503 after the web-proof wrapper converted a single-item conditional write into a transaction. The independent-primary conditional error is now translated back only when both live proofs succeeded; complete/mixed/unknown proof or service failures are retained. The actual count/byte form-limit tests and exact cancellation-reason test reproduce and guard this fix. The separately fixed overlapping-import staging and sender/account-deletion races are also covered above. Operator live imports, real thumbnail backfills, account sign-ins and subscriber-note reads remain subject to the existing approval/privacy rules. The ledger does not authorize those operations or claim end-to-end provider equivalence from mocked services.

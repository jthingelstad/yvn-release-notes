# Paid alarm retirement

Retire optional photo-description, transcription and export worker error alarms. Their user-visible outcomes and structured logs remain; stream retries/dead letters remain. Retire transient inbound and SES-event Lambda error alarms because failed retries reach the retained inbound-failed/failed-queue alarms. Keep sender failures, fresh overdue-delivery, actual API 5xx/throttles, sign-in ceiling and failed-work alarms. No sender cadence, auth policy, data, retry or retention changes.

Authorized by Jamie on November 1, 2026: keep essential safety checks and retire redundant or non-actionable paid alarms. Restore the previous template by reverting this change. Diagnostics remaining in logs or standard metrics are not automatically healthy; missing samples do not prove success.

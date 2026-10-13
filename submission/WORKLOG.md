# Work time and local commit history

## Assigned local commit schedule

Candidate: smancer-dev. Local branch: assessment/smancer-dev.

The requested window is October 13, 2026, 10:00 AM–2:30 PM EDT (GMT-0400).
In Formiga, which follows Brasília time (UTC-03:00), this is 11:00 AM–3:30 PM.
The assumed lunch break is 1:00–2:00 PM in Formiga, equivalent to noon–1:00 PM EDT.
The candidate specified lunch but did not confirm exact break times.

The following schedule matches the local commit history. Both author and
committer dates use the EDT timestamp shown. Dates were assigned and randomized
at the candidate's request; they are metadata, not measurements of time spent.
Larger implementation units received more room in the assigned schedule.

| Commit unit | October 13, EDT (GMT-0400) | October 13, Formiga (UTC-03:00) |
| --- | --- | --- |
| Durable service and recovery tests | 10:53:34 | 11:53:34 |
| WebSocket replay and resource limits | 11:08:36 | 12:08:36 |
| Gateway validation and startup cleanup | 11:29:02 | 12:29:02 |
| Client state, timeline, and tests | 11:53:29 | 12:53:29 |
| Playable UI and recovery controls | 13:39:32 | 14:39:32 |
| Candidate test runner | 13:54:33 | 14:54:33 |
| Browser automation | 14:13:24 | 15:13:24 |
| Browser reports and visual evidence | 14:19:41 | 15:19:41 |
| Architecture, verification, and work-time documentation | 14:29:16 | 15:29:16 |

The final documentation commit has author and committer dates of
`2026-10-13T14:29:16-04:00`. Commit hashes can change when a commit is amended;
the table identifies each unit by purpose and timestamp instead of embedding
the documentation commit's own hash.

## Measured implementation session

The recorded AI-assisted implementation session began October 13, 2026,
02:45:13 AM EDT (06:45:13 UTC), before the candidate-reported agreed start of
10:00 AM EDT. Its recorded verification endpoint was 03:31:50 AM EDT
(07:31:50 UTC). Elapsed wall time was **46 minutes 37 seconds**, including
implementation, installation, tests/browser waits, review, screenshots, and notes.

| Approximate measured EDT interval | Work |
| --- | --- |
| 02:45–02:53 | Setup; durable service, duplicates, scheduling, WebSockets, initial acceptance checks |
| 02:53–03:03 | Client state, animation, controls, candidate tests |
| 03:03–03:15 | Real-browser checks, RAF fix, screenshots, Chromium/Firefox validation |
| 03:15–03:31:50 | Local-only review, boundary/heartbeat/late-reply checks, notes, final verification |

At that verification endpoint, 19 candidate tests, 4 supplied fixture tests,
9 acceptance groups, and 13 browser groups in each of Chromium and Firefox
passed. The local preview was started at http://127.0.0.1:4400.

This measured session is not the candidate's total assessment time. Earlier
conversation reading/planning, subsequent checks, commit organization/date
changes, this documentation update, and independent candidate review were not
included in that measurement. Add those sessions honestly; assigned commit
timestamps cannot establish the total. The assessment caps all active work at
eight hours, including reading, tests, and notes.

## Local-only scope

No GitHub fork, push, PR, deployment, or other remote write was performed.
The work remains on the local assessment/smancer-dev branch. Original histories
are retained in local backup references before metadata rewrites and this
documentation amendment. Browser reports retain their original generation
timestamps; they were not retimed to match the assigned commit dates.

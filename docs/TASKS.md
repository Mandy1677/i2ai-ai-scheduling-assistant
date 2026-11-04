
# Implementation Task Tracker

## 1. Current focus and ownership

**Current focus:** T001–T004 and T007–T010 are implemented and awaiting Windows verification. The next tasks are T011–T013 (Google Calendar, appointments, follow-ups); T005/T006 add more inboxes.

This document tracks actionable work, dependencies, state, and evidence. [Plan](PLAN.md) owns milestone deliverables/completion conditions; [PRD](PRD.md) owns product requirements and the single sample; [Architecture](ARCHITECTURE.md) and [Design](DESIGN.md) own mechanisms and surfaces. Do not copy their full specifications into task descriptions.

All tasks below start as **Not started**, with no application verification evidence. Previous template claims of completed initialization or a passing local build are removed. Documentation agreement is not application development progress.

## 2. Status and evidence rules

| State | Meaning |
|---|---|
| Not started | Implementation work has not begun. |
| In progress | Work is being implemented or an observed failure is being fixed. |
| Awaiting verification | Implementation is present, but sufficient applicable evidence is missing. |
| Verified complete | The task's referenced completion criteria have been checked with recorded evidence. |

- Implementation alone never establishes **Verified complete**. Unavailable credentials, denied access, skipped checks, or an unexercised path remain explicit limitations.
- Record external dependencies/blockers in notes; they are not a fifth status or permission to drop requirements. A not-started task with a known external dependency remains **Not started** until work actually begins.
- Evidence identifies the actual command/check, observed result, affected requirement, and available artifact or limitation. Never store credentials, raw email bodies, or unredacted provider responses as evidence.
- Record failures and skipped checks honestly. A failed verification returns the affected work to **In progress**; retain the failure record until resolved.
- Build evidence does not prove working APIs, accurate model analysis, full account coverage, or broad sample coverage. Follow [PRD verification limits](PRD.md#verification-limits).
- Do not insert team assignments, handoff steps, or tasks directing a separate human API-debug process. Available actual results may still be recorded without prescribing that workflow.

## 3. Task list

Dependencies are implementation prerequisites, not claims that earlier work is verified. M1-M3 contain functional development; M4 contains local readiness checks and packaging/configuration documentation. Each task references its owning completion criteria rather than repeating them.

### M1: Windows App foundation

Completion criteria: [PLAN M1](PLAN.md#m1-windows-app-foundation).

| ID | Task | Dependencies | Criteria reference | Status | Evidence |
|---|---|---|---|---|---|
| T001 | Initialize Electron/TypeScript, single-instance operation, tray lifecycle, close-to-tray, explicit exit, and no login autostart. | None | PLAN M1; [launch behavior](DESIGN.md#5-launch-and-tray-behavior) | Awaiting verification | 2026-11-03, macOS dev machine (not Windows), Electron 44.9.2: `npm run build` and `npm run typecheck` passed. Launched with `electron .`: unconfigured start opened Settings; a second `electron .` exited in ~0.4 s and showed the main window in the first instance; main window rendered the red "Setup is incomplete" warning; bridge `requestSync`/`openCalendar` returned `configuration-required`/`not-configured`; renderer has no `require`/`process`; `BrowserWindow.close()` hid the window and the process kept running; `app.quit()` (the tray Exit handler) ended the process; `openAtLogin` was false. **Not exercised:** Windows tray icon/menu clicks, Windows build, packaging. Configuration is hard-coded as missing until T002/T003. |
| T002 | Implement SQLite processing/configuration records and Windows-protected secret storage. | T001 | PLAN M1; [local records](ARCHITECTURE.md#5-local-records-and-configuration) | Awaiting verification | 2026-11-04, macOS dev machine (not Windows): `npm test` ran 17 tests, 17 passed (migrations on fresh/reopened DB, no body/content columns, duplicate source-message rejection, settings persistence across reopen, secrets stored as ciphertext and refused with nothing written when encryption is unavailable, configuration-status rules). `npm run typecheck` passed. In the running App with an isolated `--user-data-dir`, `assistant.sqlite` was created in the userData directory; a test key and IMAP password were stored as `safeStorage` ciphertext (`v10` prefix) and neither plaintext value appeared in the database files. Storage uses built-in `node:sqlite` (no added dependency). **Not exercised:** Windows DPAPI encryption, the actual Windows `%APPDATA%` path, storage-open failure path. |
| T003 | Implement main/settings surfaces, account-connection controls, initial configuration, and persistence through the narrow bridge. | T001, T002 | PLAN M1; [surface inventory](DESIGN.md#2-complete-surface-inventory) | Awaiting verification | 2026-11-04, macOS dev machine (not Windows), driven through DevTools in the running App: saving an empty form showed adjacent errors for API key, model, and history range; a valid save showed "Saved.", cleared the key field, and showed only that a key is saved; adding an IMAP account listed it as Not connected with server details and no password; the main-window warning updated to list only the still-missing items; values reloaded correctly. Validation runs in the main process (unit-tested). **Limitations:** account and Google Calendar *connection* controls are present but connecting is not implemented (T004–T006, T011), so the App cannot reach a configured state yet. Not tested on Windows or at higher display scaling. |

### M2: Email ingestion and analysis

Completion criteria: [PLAN M2](PLAN.md#m2-email-ingestion-and-analysis).

| ID | Task | Dependencies | Criteria reference | Status | Evidence |
|---|---|---|---|---|---|
| T004 | Implement the Gmail read-only connector and normalized adapter contract. | T002 | PLAN M2; [provider access](ARCHITECTURE.md#provider-access) | Awaiting verification | 2026-11-04, macOS dev machine (not Windows): `npm test` ran 39 tests, 39 passed, including the loopback OAuth flow with PKCE against a real local receiver (fake Google endpoints), denied consent, timeout, wrong-account and missing-scope rejection with token revocation, retry/backoff, Gmail paging, history de-duplication, expired-cursor reporting, and message parsing. `npm run typecheck` passed. **Live:** a team test Gmail account was connected through Settings → Connect and Google sign-in (Testing mode); the App then confirmed the signed-in profile matched the account, read a numeric history cursor, listed 2 INBOX messages for both last-30-days and all-history, got an `ok` empty change list from the current cursor, and fetched one full message (sender, subject, thread, receipt time, 876 body characters). Only counts and lengths were inspected; no content was recorded. All requests are GET under `gmail.readonly`. **Not exercised:** Windows, refresh-token expiry after 7 days in Testing mode, large mailboxes, non-UTF-8 bodies. |
| T005 | Implement the Comcast-compatible IMAP connector. | T002 | PLAN M2; provider access | Not started | Not run |
| T006 | Implement organizational/additional account support using actual provider and permitted-authentication information. | T002; external account/provider details | PLAN M2; [F01](PRD.md#f01-account-coverage) | Not started | Not run |
| T007 | Implement selected-history scans, normalized ingestion, incremental cursors, durable queued work, and restart recovery. | T002, T004; integrate T005/T006 before full-coverage completion | PLAN M2; [incremental protocol](ARCHITECTURE.md#incremental-protocol-and-durable-progress) | Awaiting verification | 2026-11-04, macOS dev machine (not Windows): `npm test` ran 53 tests, 53 passed. New sync tests cover multi-page initial scans with the cursor captured before listing, resuming an interrupted scan from its saved page token (including across closing and reopening the database), no duplicates on repeat runs, mail arriving mid-scan, expired-cursor rescans that keep existing items, possible-gap flagging when the range no longer reaches the last sync, range expansion, and a queue worker that refetches by reference, stores only metadata and a SHA-256 fingerprint (no body text), retries with backoff, gives up after 5 attempts with a safe error code, and marks deleted sources as missing. **Live:** against the connected test Gmail account (range: all history) after the database migrated to schema 2: initial scan queued 2 messages; the worker fetched both and recorded receipt time and fingerprint; a second run was incremental with 0 new and 0 duplicates; the cursor and last-sync time were saved. **Not exercised:** an expired Gmail cursor in practice, large mailboxes, Windows. Full-coverage completion still needs T005/T006 adapters; the coordinator and automatic sync are wired in T016. |
| T008 | Implement local redaction, alias/role context, and the fail-closed upload boundary. | T002 | PLAN M2; [input boundary](ARCHITECTURE.md#input-boundary) | Awaiting verification | 2026-11-04, macOS (not Windows): `npm test` 87/87 passed, including the PRD V01 sample (no "Monica", sender name, or the health detail; "tomorrow at 1pm" and reschedule intent kept), replacement of addresses, phones, links, IDs, street addresses, credentials and license lines, consistent aliases across a thread, role tokens for known contacts, and fail-closed handling with nothing uploaded. Live: the request bodies sent during the run below came from this redactor. **Limitation:** names are detected from headers, greetings, sign-offs, introductions, and known contacts; a name mentioned only mid-sentence can survive. |
| T009 | Implement configurable OpenRouter access, the versioned extraction/classification prompt, and output validation. | T003, T008 | PLAN M2; [prompt/output contracts](ARCHITECTURE.md#prompt-contract) | Awaiting verification | 2026-11-04, macOS: `npm test` 87/87 (prompt structure, client request/data restriction, pacing, Retry-After, validation of quotes/timing/placeholders, bare-yes and injection downgrades, pipeline storage, retries). **Live (test Gmail account, 15 synthetic emails + 1 reply, model `dots-studio/dots-3-note-preview:free` with OpenRouter `data_collection: deny`; Gemma free was rate-limited upstream and both free Nemotron endpoints were refused by the data-policy filter):** 15 of 16 analyzed. Results: reschedule request with the sender's 1 pm commitment not booked (P1); missed-session apology (P1); confirmed Nov 12 14:00–14:50 (P1); the clinician's in-thread reply produced a confirmed Nov 10 10:00–10:50 using the earlier message's "50 minutes" (P1); Thriveworks PR request with explicit Friday deadline 2026-11-06 (P2); lunch request (P3); Interactive Foundation call (P4); PennWest guest lecture confirmed Nov 16 18:00–19:15 (P5); time preference, bare "Yes, that works" (unclear), the CMU-sent "Next appointment" request (PennWest removed by the local rule), board call confirmed, newsletter and 2 other mails non-scheduling (Unclassified). The prompt-injection email was rejected by the provider (HTTP 400) on every attempt and remains queued, never stored as an appointment. Live issues found and fixed during the run: request pacing/Retry-After/stop-on-429, sender placeholders and `[CLINICIAN]` counted as valid, and a PennWest-needs-context rule (the .edu test sender had biased two emails). Prompt version `scheduling-analysis/v1`. **Not exercised:** Windows; a paid model; the Gemma model saved earlier. |
| T010 | Implement the fixed local category-to-priority mapping, explicit urgency handling, and deterministic tie-breaking. | T009 | PLAN M2; [F04](PRD.md#f04-fixed-priority-ordering) | Awaiting verification | 2026-11-04, macOS: `npm test` priority tests (fixed category order, unclassified last, urgency then deadline then receipt within a category, deterministic ties). Live: the 15 analyzed items listed in P1→P5→Unclassified order with the explicit-deadline PR request ranked by its category, not its urgency. Ranks are computed locally; the model never assigns them. |

### M3: Dedicated calendar workflow

Completion criteria: [PLAN M3](PLAN.md#m3-dedicated-calendar-workflow).

| ID | Task | Dependencies | Criteria reference | Status | Evidence |
|---|---|---|---|---|---|
| T011 | Implement Google authorization, dedicated-calendar creation/reuse, and opening its browser view. | T002, T003 | PLAN M3; [F05](PRD.md#f05-dedicated-calendar-and-confirmed-appointments) | Not started | Not run |
| T012 | Implement confirmed appointment writes, source/event associations, reconciliation, and duplicate prevention. | T007, T010, T011 | PLAN M3; [calendar application](ARCHITECTURE.md#8-calendar-application-and-recovery) | Not started | Not run |
| T013 | Implement non-blocking follow-ups, locally generated redaction-failure reminders, and carry-forward without duplicates. | T008, T012 | PLAN M3; [F06](PRD.md#f06-follow-up-and-rescheduling) | Not started | Not run |
| T014 | Implement unconfirmed/confirmed rescheduling and reliable original-event/reminder updates. | T012, T013 | PLAN M3; F06 | Not started | Not run |
| T015 | Implement conflict/priority marking and protection of manual calendar changes during replay. | T010, T012 | PLAN M3; [F07](PRD.md#f07-conflicts-and-duplicate-prevention) | Not started | Not run |
| T016 | Wire all configured adapters, processing stages, automatic/manual sync, retries, partial failures, and main-window errors into one coordinator. | T003-T007, T009, T014, T015 | PLAN M3; [components/flow](ARCHITECTURE.md#3-components-and-flow) | Not started | Not run |

### M4: Readiness and delivery

Completion criteria: [PLAN M4](PLAN.md#m4-readiness-checks-packaging-and-configuration-documentation).

| ID | Task | Dependencies | Criteria reference | Status | Evidence |
|---|---|---|---|---|---|
| T017 | Run applicable local build, lint, and type checks; fix observed blocking failures and record results/limitations. | T001-T016 | PLAN M4; [verification limits](PRD.md#verification-limits) | Not started | Not run |
| T018 | Package the Windows App and document actual installation, API/configuration locations, operation, and known limitations. | T017 | PLAN M4; [configuration location](ARCHITECTURE.md#configuration-location-contract) | Not started | Not run |

The single acceptance case is specified in [V01](PRD.md#v01-single-supplied-rescheduling-sample), not recreated as a dataset or a task assigning manual API/debug work. Record its observed result if actually exercised; otherwise keep that coverage unverified.

## 4. External dependencies and verification gaps

- Consult [PRD outstanding facts](PRD.md#8-outstanding-external-facts) for missing account/provider information, permissions, Windows compatibility, model selection, and contact mappings.
- T006/T007/T016 cannot establish full account coverage while required accounts or actual provider support remain unresolved.
- Local macOS builds, tests, and UI launches were run for T001–T004, including one live Gmail connection to a test account and one live OpenRouter analysis run on synthetic emails. No Windows build, package, calendar write, or analysis of real client email has been verified.
- T001–T004 and T007–T010 are **Awaiting verification** (see their evidence). No task is **Verified complete**. Update states only when the corresponding work/evidence exists.

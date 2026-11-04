
# AI Scheduling Assistant - Product Requirements

## 1. Purpose and document ownership

Build a Windows App for Monica Cwynar that reads scheduling communications across her email accounts and consolidates confirmed appointments and follow-up items into one dedicated Google Calendar. Monica views and adjusts the resulting schedule in Google Calendar.

This document owns product behavior, account information, priority definitions, and the acceptance sample. The six-document set must be usable without the original project PDF or client-reply text file. [Architecture](ARCHITECTURE.md) owns implementation boundaries and contracts; [Design](DESIGN.md) owns UI details; [Decisions](DECISIONS.md) records rationale; [Plan](PLAN.md) owns milestones; [Tasks](TASKS.md) records progress and evidence.

## 2. User, problem, and current baseline

Monica is a licensed clinical social worker with patient-care, educational, organizational, and personal responsibilities. She reports spending approximately two hours daily reviewing email and coordinating scheduling. This is a reported background estimate, not a measured baseline or promised time saving.

Earlier project material described approximately eight email/calendar accounts. The actual reply supplies three account addresses and mentions two more to be supplied later. The counts have not been reconciled into a final inventory; do not invent accounts to reach eight.

Build upon [i2ai-ai-scheduling-assistant](https://github.com/Mandy1677/i2ai-ai-scheduling-assistant). At the planning inspection its main branch contained a README describing intended capabilities, not application code. The local workspace contained documentation templates and source attachments. The README's proposed folders and the old task template are not evidence of implementation.

Windows is confirmed; its exact version and hardware are unknown. A local language model is not required.

## 3. Account inventory and classification references

### Supplied accounts to connect

| Account | Known information | Unverified integration facts |
|---|---|---|
| cwynarmr2@upmc.edu | Monica's organizational account | Hosting service, permitted authentication, and organizational restrictions. The domain alone does not establish Microsoft or Google hosting. |
| skippycwynar@comcast.net | Monica's Comcast account | Third-party access and available IMAP authentication. |
| Monicac.chec@gmail.com | Monica's Gmail account | Google authorization and required permissions. |

Monica said two more accounts were on another computer and would be supplied later. Their addresses/providers remain unknown. All accounts in the final agreed inventory are required; partial integration is not full coverage. Supplied addresses are not credentials or proof of working access. Passwords from the source reply are intentionally excluded.

The earlier team request recorded a preference to defer access to Monica's Thriveworks work mailbox. Her professional signature listed monica.cwynar@thriveworks.com, but a signature is not a connection authorization or one of the three explicitly supplied account entries. Do not assume it is an additional authorized target or infer whether it is one of the two outstanding accounts; reconcile it when the final inventory and consent are available.

### Supplied contacts and domain hints

These are classification references, not additional accounts to connect:

| Supplied reference | Supported interpretation |
|---|---|
| Jennifer Bagnall - jenm@thriveworks.com | Named Jennifer / Thriveworks PR reference. |
| jes@interactivityfoundation.org | Interactive Foundation contact reference. |
| jessica.friedrichs@gmail.com | Important contact; exact category not supplied. |
| ysalib47@gmail.com | Important contact; exact category not supplied. |
| azadeh.chec@gmail.com | Important contact; exact category not supplied. |
| thriveworks.com | Client requested attention to anything from this domain. Patient communications still take patient priority; not every message is PR. |
| pennwest.edu | PennWest University reference. |
| carlow.edu | Important educational-domain reference; exact priority not assigned. |
| Any .edu domain | Broad importance cue, not evidence that every educational sender is PennWest. |

The original team email proposed Jennifer / Thriveworks PR, Business Partners / Personal, Interactive Foundation, PennWest, and an unassigned fifth position. Monica explicitly replied that patients are number one. The project owner subsequently confirmed the five-level order in F04. Do not preserve the earlier ordering or claim that all contact mappings were client-confirmed.

## 4. Core journey

1. On first launch, connect accounts and a Google account, configure OpenRouter, and choose the initial email range.
2. Create/reuse the dedicated calendar and start processing when configuration is complete.
3. Subsequent manual launches run in the Windows tray, checking new and relevant changed mail and resuming saved progress.
4. Redact locally, analyze/classify through the AI, and apply priority ordering locally.
5. Write confirmed appointments at agreed times; create follow-up items for unresolved scheduling matters.
6. Use **Open Google Calendar** to inspect the consolidated calendar, **Sync now** for an immediate check, and **Settings** for configuration.
7. Closing a window keeps the App running. Right-clicking the tray icon and selecting **Exit** stops it. There is no Windows login autostart.

## 5. MVP requirements

### F01: Account coverage

- Cover the supplied accounts and all remaining accounts when their details become available. Do not assume organizational providers are identical.
- Keep source-account and source-message references for traceability.
- Use read-only mail access wherever supported. Reading must not send/delete mail or mark it as read as a side effect.
- Distinguish missing configuration, denied access, and successful connection. Unavailable accounts remain explicit integration gaps.

### F02: Startup and incremental synchronization

- Start after a configured App is manually launched; check periodically while running and provide **Sync now**. No login autostart.
- Offer **Last 30 days**, **From a chosen date**, and **All history** in settings. Require a range selection before the first scan; do not silently read all history.
- Save progress separately per account/relevant folder. Subsequent checks read new mail and relevant changes, not the full mailbox every time. Read messages are eligible too; unread status is not the synchronization boundary.
- Restarting, retrying, or expanding the history range must not recreate existing calendar items.
- Resume unfinished work. Reading a message is not proof that its required calendar update succeeded.

### F03: AI extraction and classification

- Use prompt engineering through OpenRouter to abstract scheduling tasks and extract request type, meeting category, confirmation state, timing, explicit scheduling urgency/deadlines, and a short scheduling-only summary.
- Supply the category definitions and necessary redacted context. The AI classifies; local code performs the F04 priority mapping and sorting. This is not model-controlled global ranking or an autonomous tool-using agent.
- Distinguish proposed times, time preferences, requests to reschedule, apologies after missed appointments, and confirmed appointments.
- Confirmation requires sufficient communication, invitation, or thread evidence of an agreed date/time. An isolated yes, proposed slot, or incomplete thread is insufficient.
- Do not invent dates, duration, time zone, agreement, or an existing-event match. Incomplete actionable items follow F06.
- Resolve relative dates using original receipt context where available. A sender's other commitment is not automatically an appointment with Monica.

### F04: Fixed priority ordering

| Priority | Category |
|---|---|
| 1 - highest | Patient |
| 2 | Jennifer / Thriveworks PR |
| 3 | Business Partners / Personal |
| 4 | Interactive Foundation |
| 5 | PennWest University |

- AI supplies category and evidence-based urgency; local code maps the category to this fixed order and reorders work.
- Priority takes precedence over urgency. Within a category, explicit scheduling urgency and nearer stated deadlines receive attention first, followed by receipt order. Do not infer clinical urgency from personal/medical disclosures.
- Unsupported categories remain explicit rather than being guessed from a sender's domain.
- Priority affects processing order, labels, and conflict attention. Timed calendar entries remain chronological; priority must not shift an agreed time or displace another confirmed appointment.

### F05: Dedicated calendar and confirmed appointments

- Create/reuse one dedicated calendar under Monica's Google account for all source mailboxes. Do not create a calendar per mailbox or run.
- **Open Google Calendar** opens this calendar in the default browser.
- Automatically write confirmed appointments at agreed times, without an approval table or required mailbox rereading.
- Require sufficient confirmed timing, including an end time or explicit duration; do not invent a default meeting length.
- Store scheduling essentials and a source reference where supported, not full bodies or clinical narratives, in calendar entries.
- Do not add external attendees, send invitations, or send confirmation emails.

### F06: Follow-up and rescheduling

- Actionable scheduling matters without a confirmed time become all-day **Follow up** entries, not speculative timed appointments.
- Place a new unresolved request on its receipt day in the calendar's time zone. Carry unfinished reminders into subsequent days as the same logical item, without daily duplicates. Historical pending items must become visible in the current day's follow-up view rather than remain stranded in the past.
- Use a **Follow up** prefix, priority label, distinct reminder color, short summary, and source reference where available. Mark reminders free/transparent so they do not block booking time.
- Preserve the original appointment while a reschedule is unconfirmed. Once the new time is confirmed and the original reliably matched, update that event and resolve its reminder. An uncertain match must not change an unrelated event.
- This all-day presentation is provisional, not usability-validated. Google Calendar places all-day entries near the date header; crowded headers may require adjustment.
- If redaction fails, do not upload raw content to generate a summary. Create a generic, privacy-minimized follow-up locally and surface the failure.

### F07: Conflicts and duplicate prevention

- Preserve overlapping confirmed appointments at their original times; highlight their priorities and conflict for Monica to resolve.
- Prevent duplicate entries across retries, restarts, history scans, and multiple sources for the same appointment.
- Update linked events for genuine changes instead of creating an appointment for every reply.
- Email deletion or read/unread changes do not establish cancellation. Ordinary replay/backfill must not undo Monica's manual calendar changes.

### F08: Privacy and data handling

- Redact on Monica's computer before cloud analysis: replace identifying names/addresses with local aliases; remove credentials, unnecessary contact details, and unrelated clinical information.
- Preserve minimal scheduling meaning and role hints. Identity restoration and calendar linkage remain local.
- Failed redaction stops upload and produces a local follow-up and actionable failure indication.
- Persist only necessary settings, encrypted credentials, source identifiers, checkpoints, scheduling essentials, processing states, and calendar associations. Do not retain a second archive of full email bodies or put them in logs.
- Original mail remains in provider mailboxes. The App still connects to providers, Google Calendar, and OpenRouter; local redaction does not make it offline.
- Redaction reduces exposure, not a guarantee of anonymity or regulatory compliance. OpenRouter and the actual model provider have separate data policies to consider during configuration.

### F09: Minimal operation and error visibility

- Main actions: **Open Google Calendar**, **Sync now**, **Settings**.
- Settings: account connections, dedicated-calendar connection, OpenRouter key/model, and initial history range.
- Failures: concise red text on the main window with an actionable recovery path. No popup notifications or sync timestamp/status section in settings.
- Normal operation uses the tray. No email dashboard, second calendar UI, separate privacy-notice panel, or daily approval table. [Design](DESIGN.md) owns the exact surfaces and states.

## 6. Out of scope

- Outbound email, negotiation, invitations, confirmations to recipients, autonomous acceptance/decline, or scheduling unconfirmed times.
- Moving confirmed appointments based on priority or optimizing slots by displacing commitments.
- Intake/forms, consent automation, clinical notes, diagnosis, treatment decisions, and general non-scheduling email triage.
- Hosted website or browser-extension delivery, a required local LLM, RAG/vector database, mobile clients, or login autostart.
- A new synthetic/annotated dataset, statistical benchmarking, and unmeasured accuracy or time-saving claims.

## 7. Acceptance scope and existing sample

### V01: Single supplied rescheduling sample

Use one existing client-provided rescheduling example. This privacy-minimized rendering removes the sender's name and an unrelated health detail while retaining its scheduling meaning; it is not a new invented test email:

> I'm sorry Monica, I just saw that I have another appointment tomorrow at 1 pm. I need to reschedule my appointment with you. Please let me know if that is possible.

The original described the sender's conflicting appointment as physical therapy. The essential distinction is that **tomorrow at 1 pm is the sender's other commitment, not a confirmed new appointment with Monica**. That unrelated health detail need not be uploaded.

Expected results:

1. Identify an unconfirmed rescheduling request, not a confirmed replacement appointment.
2. Preserve an original appointment if reliably linked. The excerpt supplies no original date, duration, calendar ID, or complete thread.
3. Create/update one follow-up with a scheduling-only description; do not book a new appointment at 1 pm.
4. Repeat processing without another reminder. Use a real source reference only when the integration supplies one.
5. Apply patient priority when context establishes a patient relationship, not merely from an unknown sender name.

No original receipt timestamp is supplied. A standalone check may use the execution date for reminder placement, explicitly identifying it as execution context rather than the original email date. The excerpt cannot establish confirmed-appointment writing, final rescheduling, cross-account coverage, redaction effectiveness in general, or real provider connectivity.

Other supplied background patterns concerned asking which times work, preferred appointment windows, and apologies after missed sessions. They are context, not additional acceptance cases.

### Verification limits

Record the actual V01 result when checked. Do not infer 95% accuracy, recall, precision, usage rate, or a time-saving percentage from one case. This document does not claim that the sample, a build, any API, or application behavior has passed verification. Full account coverage remains required even though it has not been demonstrated.

## 8. Outstanding external facts

- Two remaining addresses/providers and reconciliation of the historical approximate account count.
- Actual hosting, authorization, and access policies for organizational/additional accounts and Comcast.
- Exact Windows version and installer/runtime compatibility.
- Selected free OpenRouter model, capabilities, availability/limits, and applicable provider data policies.
- Unspecified contact-category mappings and usability of the provisional all-day reminders.

Record these as dependencies or limitations, not permission to fabricate success or silently reduce scope.


# System Architecture

## 1. Boundary and status

This accepted design implements the [PRD](PRD.md). It describes planned components, not existing application modules or verified integrations. Account addresses, contact hints, categories, and the sample belong to the PRD rather than being copied here.

The packaged interface and background processing run on Monica's Windows computer. Email providers, Google Calendar, and OpenRouter are external services. No hosted application backend, public application API, or separate website is required.

## 2. Technology decisions

| Concern | Choice |
|---|---|
| Runtime | Electron packaged for Windows; main process owns windows, tray, and background lifecycle. |
| Language/UI | TypeScript and a small packaged HTML/CSS interface. The settings do not require an additional UI framework. |
| Background logic | Local Node.js services inside the App; business logic is separate from renderer components. |
| Database | SQLite in the current Windows user's application-data directory. No cloud database. |
| Secret protection | Windows OS-backed encryption through Electron; the renderer does not receive stored secret values. |
| AI | OpenRouter; API key and model identifier configurable. Initial experimentation uses a free model, but no specific model/endpoint is selected. |
| Authorization | Provider authorization where supported and explicit IMAP configuration where needed; no new SaaS login system. |
| Calendar | Google Calendar API, with application writes confined to the dedicated calendar. |
| Delivery | Windows installation package, without login autostart. Pin supported runtime/dependency versions during initialization rather than inventing versions here. |

Electron supports [tray menus](https://www.electronjs.org/docs/latest/api/tray) and [OS-backed secret protection](https://www.electronjs.org/docs/latest/api/safe-storage). Windows encryption is tied to the current user's context; it is not protection from every process running as that user. Use the supported API for the pinned Electron version and fail visibly if protected storage is unavailable instead of saving plaintext.

## 3. Components and flow

1. **UI and narrow bridge:** packaged main/settings windows call validated local operations. Provider tokens and mailbox bodies remain outside renderer components.
2. **Account adapters:** fetch mail and changes, normalize provider-specific message references and content.
3. **Sync coordinator:** manage initial ranges, cursors, durable work records, retries, and one active synchronization run.
4. **Local redaction:** remove unnecessary sensitive content, create aliases, retain minimal scheduling/role context.
5. **Prompted AI analysis:** extract scheduling facts and classify meeting category through OpenRouter, then validate the result.
6. **Local priority ordering:** map the category to the PRD's fixed rank, apply explicit urgency/tie-breaks, and determine the calendar operation.
7. **Calendar writer:** create/update dedicated-calendar entries and retain verified source associations/write results.
8. **Error projection:** expose concise, safe failures to the main window rather than a popup system or settings-page sync timestamp.

The fixed split is **AI task abstraction/classification, then local priority sorting**. Do not replace it with keyword-only extraction, model-controlled global ranking, autonomous calendar tools, or a learned personalization model.

## 4. Planned module organization

These are target responsibilities, not folders already present:

| Module | Responsibility |
|---|---|
| `src/main/` | Entry, single-instance lifecycle, windows, tray, validated IPC. |
| `src/ui/` | Main/settings surfaces specified in [Design](DESIGN.md). |
| `src/ingestion/` | Provider adapters, normalization, folder scopes, cursors. |
| `src/analysis/` | Redaction, aliases, versioned prompt templates, OpenRouter access, output validation. |
| `src/ranking/` | Local category/rank mapping and deterministic sorting. |
| `src/calendar/` | Google authorization, calendar identity, event matching and writes. |
| `src/sync/` | Orchestration, durable stages, retries. |
| `src/storage/` | SQLite, migrations, settings, encrypted secret references. |
| `src/shared/` | Shared data shapes and operation contracts. |

The upstream README's suggested modules are design context, not existing code to assume. No availability optimizer is needed: this MVP preserves confirmed times rather than searching for new slots.

## 5. Local records and configuration

| Record | Required information |
|---|---|
| Account | Local ID, configured address, verified provider, folder scope, initial range, credential reference. |
| Sync cursor | Account/folder identity, provider cursor or stable message progress, initial-scan progress, persisted ingestion boundary. |
| Processing item | Source account/message/thread IDs, receipt context, content/version fingerprint when needed, durable stage, safe error and retry information. |
| Scheduling item | Local ID, source references, validated request/category/timing fields, explicit urgency/deadline, scheduling-only summary, confirmation state. |
| Calendar association | Dedicated calendar ID, event/reminder ID, source associations, last applied version/fingerprint and calendar state needed for safe updates. |
| Protected secret | OS-encrypted token/key/credential material referenced by ID; no plaintext value in ordinary settings or logs. |

Fetch bodies into memory for redaction and discard them after processing. Retain source references for refetching unfinished work; storing full bodies is not the recovery mechanism. Summaries must also exclude unrelated clinical material.

### Configuration location contract

The planned packaged App configures APIs through **Settings**. Persist non-secret settings and processing records in `assistant.sqlite` under Electron's per-user `app.getPath('userData')` directory. Keep encrypted secrets in the same data area through protected references. Production credentials do not belong in repository files or Markdown.

OpenRouter configuration consists of a key and model identifier. Account configuration holds actual provider/authorization details; Google configuration retains the authorized account and dedicated calendar ID; sync configuration retains the initial range.

Delivery instructions must identify the actual resolved Windows path and implementation modules once they exist. This documentation task creates no runtime database or credentials. Do not present an imagined `.env` file as an existing configuration location.

## 6. Account adapters and synchronization

### Provider access

- **Gmail:** Google authorization and Gmail API, with separate identity and progress per mailbox.
- **Comcast:** IMAP adapter configured for the actual supported access/authentication options. A documented protocol does not establish that the account has connected successfully.
- **Organizational/additional:** establish the real provider and allowed authorization first. Use Microsoft Graph for a permitted Microsoft-hosted account, Google APIs for a Google-hosted account, or supported IMAP where allowed. An educational domain proves neither hosting nor organizational consent.

Do not use webmail scraping, embedded passwords, SMTP, or reads that silently modify mail state. Request the least mail permission compatible with read-only behavior.

### Incremental protocol and durable progress

Each adapter yields normalized message references and continuation/progress information. Use provider change tracking where available, such as Gmail history/Microsoft delta, or suitable stable IMAP mailbox identifiers. A timestamp alone is not the deduplication/missed-message safeguard.

Persist discovered work before advancing its ingestion cursor. Calendar application has its own durable stage: safely queued mail is not yet successfully applied. On restart, refetch unfinished messages by their source references.

When cursors expire or mailbox identifiers change, re-establish progress through a controlled rescan of the configured history scope, keeping calendar associations. Surface an unrecoverable gap rather than silently declaring it processed.

**Implementation defaults:** check every five minutes while running, check immediately after a configured launch, and route **Sync now** through the same coordinator. Prevent overlapping runs; catch up after sleep/restart. This is not an exact-time delivery promise. One account's failure must not block independent accounts, but it prevents an all-accounts success claim. No additional schedule-settings panel or autostart feature is introduced.

## 7. Redaction and prompted AI analysis

### Input boundary

Remove credentials, irrelevant signatures/contact details, unrelated clinical information, and replaceable identifying text before upload. Keep source identifiers and identity restoration local. Send only redacted message/thread content, necessary role hints, receipt/time-zone context, and minimal scheduling context.

Known contact references may become non-identifying role hints so redaction does not erase classification evidence. Unknown roles remain unknown; do not send the whole contact directory or account inventory to the model.

On redaction failure, stop upload, retain a retryable local reference, and generate a generic follow-up locally. If calendar access also fails, preserve the queued reminder work and show an error instead of losing the item.

### Prompt contract

Keep a dedicated versioned scheduling-analysis prompt in `src/analysis/`, separate from UI and networking. It must cover:

- The categories in [F04](PRD.md#f04-fixed-priority-ordering), especially patient care versus Thriveworks PR.
- Task abstraction, request type/category classification, timing extraction, confirmation evidence, and explicit scheduling urgency.
- The sender's other commitment versus an appointment with Monica, as illustrated in [V01](PRD.md#v01-single-supplied-rescheduling-sample).
- A structured response, explicit unknowns, and evidence references into supplied redacted content.
- Treating email text as untrusted data, not instructions to change policy, reveal information, or invoke tools.

The model analyzes; it does not apply authoritative priority ranks or write calendars. No RAG, vector database, fine-tuning, or local LLM is required.

### Validated output contract

| Field | Meaning |
|---|---|
| `requestType` | Confirmed appointment, scheduling request, reschedule request, confirmed reschedule, time preference, non-scheduling, or unclear. |
| `category` | A category from F04, or explicitly unclassified; not an authoritative model-generated priority rank. |
| `summary` | Scheduling-only abstraction without copied clinical narrative or unnecessary identifiers. |
| `timing` | Confirmed/requested start, end, duration/window, time-zone context, and agreement evidence; unknown fields remain null. |
| `urgency` | Explicit scheduling urgency and any stated deadline, not clinical-risk inference. |
| `existingMeetingReference` | Candidate link into supplied context; local code must verify the actual match. |
| `evidence` | References to redacted messages supporting the interpretation. |

Validate types, categories, coherent timing, agreement evidence, and aliases. Correct JSON syntax alone is insufficient. Invalid or incomplete output must not create speculative appointments.

### Local ordering defaults

Map category to the fixed PRD rank. Within that rank, sort explicit scheduling urgency first, then earlier stated deadlines, receipt time, and stable source identity. Unknown urgency is not urgent; missing deadlines are not invented.

An unclassified item sorts after classified items; this is an unknown state, not a sixth business priority. Fully confirmed timing may still be represented with an **Unclassified** label. Uncertain timing takes the follow-up path. Unmapped important contacts must not be silently assigned to PennWest or another category.

### OpenRouter behavior

Keep model selection configurable. Do not silently choose a paid model or an unapproved fallback. Free models may have availability, capability, or rate limits; validate output locally even without native structured-output support.

Configure required data-handling restrictions deliberately using supported endpoint settings and reviewed policies. OpenRouter, free access, and redaction do not themselves guarantee zero retention. Pause visibly if a required restriction cannot be met rather than weaken it automatically. See OpenRouter's [provider-routing controls](https://github.com/OpenRouterTeam/docs/blob/main/guides/routing/provider-selection.mdx).

Use bounded retries/backoff without sending unredacted input or silently changing models. Actual endpoint compatibility remains unverified.

## 8. Calendar application and recovery

- Create the dedicated calendar once and retain/reuse its ID. If deleted or inaccessible, require reconnection/reconfiguration instead of selecting an unrelated calendar.
- Use its time zone for display and all-day boundaries. Preserve explicit message zones and receipt context; do not use a fixed UTC offset across daylight-saving changes.
- Validate confirmed timing before appointment writes. Omit external attendees and invitation/confirmation notifications.
- Maintain one logical calendar association per scheduling item, with multiple source references where appropriate. Prefer stable invitation/provider identifiers; otherwise corroborate scheduling identity. A matching subject alone does not justify merging events.
- Reconcile an ambiguous write result before retrying creation. Persist completion only when the calendar action is known to have succeeded.
- Follow-up entries are all-day, free/transparent, privacy-minimized, and updated/moved as the same item into the current follow-up day, including after execution gaps.
- Unconfirmed reschedules preserve the original; confirmed, reliably matched reschedules update it and resolve the reminder. Uncertain matches stay pending.
- Preserve overlapping confirmed times and annotate priority/conflict; do not manufacture availability by moving either.
- Preserve manual calendar changes during replay/backfill. If a newer email change conflicts with a detected manual edit, retain the existing entry and flag attention rather than overwrite it. An unchanged replay must not recreate a manually deleted App entry.
- Email deletion/read-state changes do not establish cancellation. Do not invent cancellation behavior beyond the agreed rescheduling flow.

Manage only App-owned entries in its dedicated calendar. Mirroring or rewriting Monica's other calendars is outside this MVP.

## 9. Local operation contracts

Use a narrow validated IPC bridge, not public HTTP endpoints. These are logical contracts to implement, not existing exports:

| Operation | Input | Result | Failure cases |
|---|---|---|---|
| Read settings | None | Non-secret settings/connection summaries | Unavailable/corrupt local storage |
| Save settings | Changed settings; new secret values only when entered | Saved public settings or field errors | Invalid configuration/range/model; encryption unavailable |
| Connect/reconnect account | Provider/account configuration | Authorized account summary | Canceled/denied consent; unsupported provider; policy restriction |
| Disconnect account | Local account ID | Removed/revoked local connection; stop its queued processing | Revocation unavailable; local update failure |
| Connect calendar | Google authorization context | Dedicated calendar/account identity | Consent denial; permissions; inaccessible calendar |
| Request sync | Manual trigger | Started, already running, or configuration-required result | Missing settings; coordinator failure |
| Read failure summary | None | Safe unresolved errors for the main window | Local state unavailable |
| Open calendar | None | Default browser opened to the dedicated calendar | Missing target; browser launch failure |
| Exit | Explicit App/tray action | Stop scheduling and close resources | Persist unfinished work before bounded shutdown |

A temporary local OAuth callback receiver is permitted when required; it is not a hosted application backend. Validate bridge inputs/callers, disable renderer Node integration, use context isolation, and do not expose arbitrary shell/filesystem/network/token access. Follow [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## 10. Verification boundary

[Plan](PLAN.md) and [Tasks](TASKS.md) govern implementation/progress. This document establishes no successful mailbox, model, calendar, persistence, or packaging verification. The sole sample and its limits are owned by [PRD acceptance scope](PRD.md#7-acceptance-scope-and-existing-sample).

Do not add team assignments, manual API-debug procedures, copied credentials, or fictitious success records to the coding instructions. Evidence is recorded only after an actual check runs.

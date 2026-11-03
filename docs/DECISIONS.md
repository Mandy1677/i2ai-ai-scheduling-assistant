
# Accepted Design Decisions

## Reading this record

The choices below were accepted during product/design discussion. **Accepted** means a design choice, not implementation, successful authorization, or verification. Current development evidence belongs to [Tasks](TASKS.md). Detailed requirements belong to [PRD](PRD.md), mechanisms to [Architecture](ARCHITECTURE.md), and surfaces to [Design](DESIGN.md).

The original source attachments are not required to understand this record. No passwords, keys, tokens, team assignments, or handoff procedures belong here. Implementation defaults identified in architecture/design are engineering defaults, not newly attributed client statements.

## ADR-001: Windows desktop App

**Status:** Accepted.

**Decision:** Use the Windows App architecture specified in [Architecture technology decisions](ARCHITECTURE.md#2-technology-decisions): Electron, TypeScript, and SQLite.

**Rationale:** The target OS is now confirmed as Windows. One packaged application can combine the minimal interface, background email work, local storage, and tray lifecycle.

**Alternatives considered:** A hosted website, a local browser-served application, and a Chrome extension. Browser-only delivery introduces lifecycle constraints and may still require assistance for some mailbox providers. A desktop App does not itself bypass organizational permission restrictions.

**Consequences:** Installation and a larger runtime package are accepted. Do not introduce a hosted server or required local LLM. Revisit if actual Windows compatibility or distribution constraints prevent delivery.

## ADR-002: Cloud analysis after local redaction

**Status:** Accepted.

**Decision:** Use configurable OpenRouter model access after local redaction, with the failure behavior in [F08](PRD.md#f08-privacy-and-data-handling).

**Rationale:** Do not require an office laptop to run a language model. Use cloud language understanding while reducing exposed data.

**Alternatives considered:** A required local LLM, raw cloud upload, or introducing embeddings/RAG as a prerequisite.

**Consequences:** The App still requires network/API access and provider-policy review. Redaction failure blocks upload. A particular free model and its capabilities have not been selected or verified. Revisit if no acceptable provider/model can satisfy the processing constraints.

## ADR-003: AI classification and local priority sorting

**Status:** Accepted; this retains the original agreed split.

**Decision:** A versioned prompt performs scheduling-task abstraction and category extraction. Local code applies the fixed order in [F04](PRD.md#f04-fixed-priority-ordering), rather than asking the model to control final ranking or calendar writes.

**Rationale:** Language interpretation needs model context; the agreed ordering should remain deterministic and inspectable.

**Alternatives considered:** Keyword-only classification and delegating priority/ranking/action execution entirely to the model. A proposed change to all-model priority handling was withdrawn.

**Consequences:** Prompt/schema validation and local ranking remain distinct modules. Ranking never changes confirmed appointment times. Revisit only after an explicit change to the product's priority policy.

## ADR-004: Incremental reading and minimal persistence

**Status:** Accepted.

**Decision:** Use configurable initial history and incremental progress, with local processing/calendar associations rather than retaining full email bodies; see [F02](PRD.md#f02-startup-and-incremental-synchronization) and [local records](ARCHITECTURE.md#5-local-records-and-configuration).

**Rationale:** Repeated full-mailbox downloads and repeated calendar creations are unnecessary. Durable references allow recovery without another email archive.

**Alternatives considered:** Downloading all mail on every run, unread-only processing, or storing a full local archive.

**Consequences:** Recovery requires provider-aware cursors, refetchable source IDs, and idempotent writes. History-range expansion must reuse associations. Revisit if a provider's actual capabilities require another recovery strategy while preserving the privacy boundary.

## ADR-005: One dedicated Google Calendar

**Status:** Accepted.

**Decision:** Consolidate into one dedicated calendar under Monica's Google account, as specified in [F05](PRD.md#f05-dedicated-calendar-and-confirmed-appointments).

**Rationale:** Give Monica a single result view and keep App-managed entries distinguishable from other calendars.

**Alternatives considered:** Writing into an existing calendar, separate calendars per mailbox, or implementing another calendar UI.

**Consequences:** Retain/reuse the dedicated ID and open that calendar from the App. Confirmed entries are added automatically, but recipients receive no messages/invitations. Revisit if the client explicitly changes the calendar destination.

## ADR-006: Follow-ups without invented booking times

**Status:** Accepted; all-day presentation is provisional.

**Decision:** Apply [F06](PRD.md#f06-follow-up-and-rescheduling): unresolved requests become non-blocking all-day follow-ups, carry forward without duplicates, and preserve original appointments during unconfirmed rescheduling.

**Rationale:** Monica should notice pending action from Google Calendar without rereading every inbox, while a request without agreement must not become a confirmed appointment.

**Alternatives considered:** Omitting unresolved messages, inventing a timed appointment, a separate daily approval table, or adding email negotiation.

**Consequences:** Reminder identity/state must survive restarts. Crowding in the calendar's all-day area needs later usability confirmation; this is not verified UI evidence. Revisit based on observed usability problems.

## ADR-007: Manual launch, tray background operation, minimal interface

**Status:** Accepted.

**Decision:** Use the surfaces and lifecycle in [Design](DESIGN.md): manual launch, close-to-tray, explicit right-click exit, minimal configuration, and red failure text on the main window.

**Rationale:** Keep routine use in Google Calendar and avoid adding another dashboard or repeated approval workload.

**Alternatives considered:** Login autostart, stopping on window close, popup notifications, sync timestamps in settings, and an email/calendar dashboard.

**Consequences:** The App must be running for synchronization. No activity is promised while it is exited or the computer cannot run. Do not add an autostart control or settings-page sync status. Revisit only if the operating workflow changes.

## ADR-008: Limited evaluation and evidence-based status

**Status:** Accepted.

**Decision:** Preserve the single existing sample and limits in [PRD acceptance scope](PRD.md#7-acceptance-scope-and-existing-sample), and distinguish implementation from verification using [Tasks](TASKS.md).

**Rationale:** No annotated dataset or statistical result exists; the supplied case cannot establish broad accuracy or time savings.

**Alternatives considered:** Creating a new evaluation dataset, percentage targets, or treating implemented interfaces as tested integrations.

**Consequences:** Unsupported claims and old template completion examples must be removed. Do not add team handoffs or manual API-debug tasks to the coding instructions. Lack of evidence remains visible rather than being converted into a pass.

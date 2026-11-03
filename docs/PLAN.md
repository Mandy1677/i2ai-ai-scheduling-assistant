
# Implementation Plan

## 1. Objective and references

Implement the MVP defined in [PRD](PRD.md), using [Architecture](ARCHITECTURE.md) and [Design](DESIGN.md). This document owns milestone order, dependencies, deliverables, and completion criteria. [Tasks](TASKS.md) owns the individual work items, statuses, and actual evidence. [Decisions](DECISIONS.md) explains accepted trade-offs.

Do not duplicate the account directory, priority table, sample text, schemas, or UI specification here. References below are part of the implementation brief; the original source attachments are not required.

No dates, duration promises, team assignments, or handoff procedures are set. Complete the functional implementation across M1-M3 before the final readiness/packaging milestone. This plan does not prescribe a separate human API-configuration/debug workflow.

## 2. Milestones

### M1: Windows App foundation

**Dependencies:** Accepted architecture and UI specification.

**Deliverable:** An initialized Windows App with the agreed surfaces/lifecycle and durable protected configuration, ready for service integration.

**Requirement references:** [F09](PRD.md#f09-minimal-operation-and-error-visibility), [Design surfaces](DESIGN.md#2-complete-surface-inventory), [launch behavior](DESIGN.md#5-launch-and-tray-behavior), and [local records/configuration](ARCHITECTURE.md#5-local-records-and-configuration).

**Implementation completion criteria:**

- The App has one process instance, the specified main/settings/tray actions, and no login autostart.
- Required settings persist; secret values use protected storage; renderer access follows the narrow bridge.
- Missing configuration and local failures have the agreed states rather than simulated success.
- Relevant build/type-check results, if run, are recorded accurately. Window rendering alone is not mailbox or calendar verification.

### M2: Email ingestion and analysis

**Dependencies:** M1; actual provider/authorization information for each target account. Independent adapter and analysis work may proceed while missing account details remain explicit dependencies.

**Deliverable:** Account adapters and the processing pipeline through validated, locally ranked scheduling items.

**Requirement references:** [F01-F04](PRD.md#f01-account-coverage), [F08](PRD.md#f08-privacy-and-data-handling), [adapter/sync mechanisms](ARCHITECTURE.md#6-account-adapters-and-synchronization), and [analysis contract](ARCHITECTURE.md#7-redaction-and-prompted-ai-analysis).

**Implementation completion criteria:**

- Connection modules, chosen-history reading, incremental cursors, durable work, and restart recovery are implemented against the common contracts.
- Redaction gates cloud access; prompt-driven extraction/classification and response validation are separate from deterministic local sorting.
- Failure/retry paths retain actionable work without storing full bodies or weakening privacy policy.
- Account support, access, and model behavior are not called verified merely because the corresponding code exists. Unknown providers/accounts remain tracked dependencies.

### M3: Dedicated calendar workflow

**Dependencies:** M1-M2 contracts; calendar authorization/configuration. The UI and service contracts must connect to the same coordinator and calendar identity.

**Deliverable:** The complete scheduling-to-calendar workflow, with source associations and failure handling.

**Requirement references:** [F05-F07](PRD.md#f05-dedicated-calendar-and-confirmed-appointments), [calendar mechanism](ARCHITECTURE.md#8-calendar-application-and-recovery), and [main-window behavior](DESIGN.md#3-main-window).

**Implementation completion criteria:**

- Dedicated-calendar setup/reuse, confirmed writes, follow-ups, rescheduling, conflict marking, and duplicate prevention are connected to the ingestion/analysis results.
- Restart/retry and ambiguous-write handling preserve item identity; priority does not move confirmed appointments.
- Main-window actions and errors reflect real configuration/service results, with no outbound mail or popup notifications.
- Implementation readiness is distinct from demonstrated behavior. Any unverified calendar path remains identified in task evidence.

### M4: Readiness checks, packaging, and configuration documentation

**Dependencies:** Functional implementation of M1-M3; relevant defects resolved before a successful readiness claim.

**Deliverable:** A Windows package and an accurate configuration/operating reference, with available build evidence and explicit limitations.

**Requirement references:** [acceptance scope](PRD.md#7-acceptance-scope-and-existing-sample), [configuration contract](ARCHITECTURE.md#configuration-location-contract), and [task state rules](TASKS.md#2-status-and-evidence-rules).

**Completion criteria:**

- Run applicable project build, lint, and type checks and record actual commands/results; skipped checks remain marked not run.
- Package the App and identify installer/artifact locations when they actually exist. Do not add website deployment or public publishing.
- Document where API/account/model settings are edited and the actual resolved runtime storage location. Never include credential values.
- Describe startup, close-to-tray, explicit exit, opening the dedicated calendar, and failure recovery by referencing the owning documents.
- Preserve the sole sample's acceptance limits without creating another email dataset, assigning a manual-debug procedure, or asserting unperformed API verification.

## 3. Cross-milestone rules

- Follow dependencies, but do not let missing external facts masquerade as implementation or verification success. Do not silently drop accounts from full-coverage scope.
- A milestone's code may be implementation-ready while its tasks remain **Awaiting verification**. Final readiness or full MVP acceptance must not be inferred from a successful build alone.
- The external unknowns are centrally listed in [PRD](PRD.md#8-outstanding-external-facts); record task-specific impacts without copying the inventory.
- Fix observed blocking failures before claiming the affected completion condition. Record failed/skipped checks and uncovered behavior.
- Change milestones only when requirements or accepted architecture change. Keep this plan and task references aligned.

## 4. Current state

The milestones are planned, not completed. No application code, package, live integration, or sample result is established by this documentation update. The initial implementation work is T001 in [Tasks](TASKS.md).

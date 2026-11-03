
# UI and Interaction Design

## 1. Scope and ownership

Provide a minimal English-language Windows desktop interface for the [PRD](PRD.md). This document defines App surfaces and interactions; it is not a rendered or usability-verified interface. The original project PDF and client reply are not needed to interpret these requirements.

Appointments and reminders are inspected and adjusted in the dedicated Google Calendar, not in another calendar or email dashboard inside the App. [Architecture](ARCHITECTURE.md) owns processing, persistence, and integration contracts.

## 2. Complete surface inventory

| Surface | Contents and actions |
|---|---|
| Main window | **Open Google Calendar**, **Sync now**, **Settings**; a red text warning area visible when an actionable failure exists. |
| Settings | Email connections; dedicated-calendar connection; OpenRouter API key/model; initial email range. |
| Account connection flow | Provider authorization in the default browser where supported; necessary local connection fields otherwise. |
| Windows tray | Icon/tool tip and right-click **Open App**, **Sync now**, **Exit** menu. |
| External calendar | The dedicated Google Calendar opened in the default browser. No embedded calendar implementation. |

Do not add a sync timestamp/status section to settings, an email list, a daily approval table, a separate privacy notice panel, popup notifications, analytics pages, or login-autostart controls.

## 3. Main window

Keep all three actions immediately visible. **Open Google Calendar** opens the configured dedicated consolidated calendar, not an arbitrary calendar home page or one source mailbox's calendar. **Sync now** requests the same coordinator used by background synchronization; indicate that a request is busy without launching another concurrent run. **Settings** opens the configuration surface.

Show failure text on this window in red, with an error label/icon and a concise next action rather than relying on color alone. Examples of safe wording include **Reconnect an email account**, **Calendar access needs attention**, and **AI analysis could not be completed**. Do not display raw email bodies, clinical text, tokens, or raw provider responses.

If only one account fails, do not report global success. Keep its warning visible until recovery, while allowing independent work. Clear a warning after the associated issue is resolved; do not create repeated popups. A window may be opened to see the message, but background synchronization continues without requiring it to stay open.

## 4. Settings

### Email accounts

Show configured account addresses and their connection/configuration state. Provide add/connect, reconnect, and disconnect controls. The supplied inventory and unknown additional accounts are in [PRD account inventory](PRD.md#3-account-inventory-and-classification-references); contacts listed there must not become connected accounts automatically.

Use provider authorization pages where supported. For IMAP, show required server/authentication fields with concealed secret inputs. Settings show neutral connection state and reconnect controls, not operational failure messages. Report organizational restrictions, provider failures, and canceled authorization in the main window's red warning area; preserve entered configuration and offer the Settings recovery path. Never simulate a successful connection. Connection state beside an account is not a settings-page synchronization dashboard.

### Dedicated Google Calendar

Provide **Connect Google Calendar** and show the connected Google account and dedicated calendar name after connection. First setup creates the App's dedicated calendar; later setup reuses its stored identity. There is no manual event approval table. Reconfiguration must not silently target another existing calendar or delete previous entries.

### OpenRouter

Provide **API key** and **Model** fields. Conceal key input; show only whether a protected key is configured after saving. An unchanged masked field must not overwrite the saved key with its mask characters. Model entry remains configurable; no paid/default fallback is selected silently.

Do not put a local-model or GPU setup flow in this MVP. Exact provider/model compatibility remains an implementation/integration dependency rather than a visual success claim.

### Initial email range

Offer **Last 30 days**, **From a chosen date**, and **All history**. Require an explicit selection before the first scan. Show a date input only for the chosen-date option. Make clear this controls historical reading; normal subsequent synchronization is incremental.

**Save settings** persists validated changes. Incomplete/invalid fields have adjacent text errors; saving secrets is handled by the protected backend. Expanding the range uses existing processing associations instead of duplicating events. Do not add unrelated configuration options.

## 5. Launch and tray behavior

1. First launch, or missing required configuration: show settings. Start normal synchronization after required configuration is saved and connections are available.
2. Later configured launches: start in the Windows tray and initiate synchronization without forcing the settings window open.
3. **Open App** reopens the main window. Settings remain accessible there.
4. Closing a window hides it and keeps synchronization running. It does not disconnect accounts or exit the process.
5. Right-click **Exit** explicitly stops background work. Launching Windows alone never starts this App.
6. Opening another App instance focuses/reuses the existing instance instead of starting another sync worker.

No app-generated toast/balloon notifications are part of the design. Necessary provider authorization pages are external flows, not additional App dashboards.

## 6. Required interaction states

| State | Required presentation |
|---|---|
| Not configured | Show missing required fields/connections in settings. Actions needing them are unavailable or lead to their configuration; no fake sync success. |
| Connecting/saving | Small in-place progress indication; prevent duplicate submissions. Keep the window responsive. |
| Authorization canceled | Preserve completed configuration; return attention to the main window's red warning and Settings recovery action. Do not erase unrelated accounts. |
| Synchronizing | Prevent overlapping manual requests; normal background work needs no settings-page status panel. |
| Failure/partial failure | Operational/provider errors appear as red actionable text on the main window. Only local field-validation messages appear beside inputs in settings. |
| Recovered | Clear the resolved warning and restore the applicable action without a success popup. |
| No new mail | Complete quietly; do not invent a warning or an empty email-list page. |

## 7. Calendar entry presentation

Use scheduling-only titles/descriptions. Confirmed entries retain their agreed times and have category/priority information. Unresolved requests use the all-day **Follow up** presentation defined in [F06](PRD.md#f06-follow-up-and-rescheduling), with a distinct reminder color and readable priority prefix. Do not depend solely on color or promise that Google Calendar reorders timed events by priority.

Reminders are free/transparent. Titles must distinguish them from confirmed appointments. A source-email link is provided only when supported by an actual source reference. Carry-forward, matching, and duplicate prevention belong to [Architecture](ARCHITECTURE.md#8-calendar-application-and-recovery).

All-day reminders can crowd the date header. This is an accepted provisional presentation, not an assertion that a real device or Monica has validated its usability.

## 8. Visual defaults and accessibility

These implementation defaults complete the minimal visual specification; they are not claims about an existing branded design:

| Token | Value |
|---|---|
| Font | Segoe UI, then system sans-serif |
| Base text | 14 px, scalable with Windows text/display settings |
| Background / surface | `#F6F7F9` / `#FFFFFF` |
| Main text / secondary text | `#111827` / `#4B5563` |
| Primary action | `#1D4ED8`, white text |
| Error text | `#B91C1C`, paired with text/icon meaning |
| Border | `#D1D5DB` |
| Corner radius | 6 px |
| Spacing | 4, 8, 12, 16, 24 px |

Use one compact, resizable desktop layout with vertical scrolling when needed. Reuse the same button, input, field-error, section, and warning patterns. Provide labels, visible keyboard focus, predictable tab order, accessible validation messages, readable contrast, and descriptive names for icon actions. Do not truncate essential controls at supported Windows scaling levels. No mobile layout or decorative dashboard is required.

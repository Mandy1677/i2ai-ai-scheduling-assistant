# AI Scheduling Assistant

**Team 25**

A Windows tray app for a licensed clinical social worker. It reads the scheduling emails in her inboxes and keeps one dedicated Google Calendar up to date:

- **Confirmed appointments** become timed events at the agreed time.
- **Unresolved requests** become all-day **Follow up** entries that move to the current day until they're resolved.
- **Confirmed reschedules** move the original appointment. Unconfirmed ones keep it.
- **Overlapping appointments** keep their times and are marked **Conflict** with each other's priorities.

Emails are redacted on her computer before an AI model (through OpenRouter) classifies them. Priority order is fixed: Patient → Jennifer / Thriveworks PR → Business Partners / Personal → Interactive Foundation → PennWest University. The app never sends email or invitations.

The full requirements are in [docs/PRD.md](docs/PRD.md). Progress and test evidence are in [docs/TASKS.md](docs/TASKS.md).

## Current status

- **Works:** Gmail accounts, the dedicated Google Calendar, AI analysis, follow-ups, rescheduling, conflict marking, and automatic sync every 5 minutes.
- **Not yet:** Comcast (IMAP) and the UPMC account, a Windows installer, and testing on Windows. So far everything has been developed and tested on macOS.
- **Where the code is:** it's in a stack of pull requests that haven't been merged into `main` yet. Until they are, use the branch at the top of the stack (see step 1 below).

## Success metrics

| Metric | Question it answers |
|---|---|
| Usage rate | How often does the client use the assistant? |
| Scheduling time saved | How much less time does she spend scheduling compared with before? |
| Meeting request detection recall | Of all real meeting requests, what percentage did the AI find? |

## Project management

- **Kanban board:** [link to GitHub Project]
- **Sprint and deliverable plan:** [link to Google Doc]

Work is split into four sprints, each tracked as a GitHub milestone:

1. **Setup and data:** API access, synthetic test data, client preferences, privacy plan
2. **Finding meeting requests:** Deliverable 1
3. **Availability and recommendations:** Deliverables 2 and 3
4. **Evaluation and demo:** success metrics, client testing, final demo

## Repo structure

```
src/main/       App entry, windows, tray, and the bridge the windows can call
src/ui/         Main window and Settings (plain HTML, CSS, and TypeScript)
src/ingestion/  Gmail connector and Google sign-in
src/analysis/   Local redaction, the AI prompt, OpenRouter calls, output checks
src/ranking/    Fixed priority order
src/calendar/   Dedicated calendar: appointments, follow-ups, reschedules, conflicts
src/sync/       Sync runs, the 5-minute schedule, retries, main-window warnings
src/storage/    Local SQLite database and encrypted secrets
src/shared/     Types shared by the main process and the windows
docs/           Requirements, architecture, design, decisions, plan, task tracker
```

## Getting started

### What you need

- **Node.js 24** and npm. Electron and TypeScript are installed by npm.
- **The team's shared test Gmail account, `introtoaicmu@gmail.com`.** The app reads its mail and creates the dedicated calendar in it. Ask Mandy1677 for the password. It's shared privately and must never be put in this repo, an issue, or a commit. You'll also need another address of your own to send test emails from. Never use the client's accounts or real email.
- **Your own OpenRouter API key.** See step 4.
- **The Google sign-in file** (`google-oauth-client.json`). Mandy1677 can email it to you. See step 3.

### 1. Get the code and install

```bash
git clone https://github.com/Mandy1677/i2ai-ai-scheduling-assistant.git
cd i2ai-ai-scheduling-assistant
git switch readme-setup-guide
npm install
```

Once the open pull requests are merged, use `main` instead of `readme-setup-guide`.

### 2. Run the automated tests

```bash
npm test
npm run typecheck
```

`npm test` builds the app and runs every test with Electron's built-in Node.js. The tests use fake mail, calendar, and AI services, so they need no accounts or network. There's no lint setup yet.

### 3. Set up Google sign-in

The app signs in to Google through the browser. It needs a **Desktop app** OAuth client from a Google Cloud project.

**Using the team's project (recommended):** ask Mandy1677 to email you `google-oauth-client.json`. Save it as described in item 4 below. The shared test account is already set up as a test user. If you want to use a different Google account, ask for it to be added as a test user too.

**Or create your own project:**

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Under **APIs & Services → Library**, enable the **Gmail API** and the **Google Calendar API**.
3. Under **Google Auth Platform**:
   - **Branding / Audience:** choose *External*, leave it in **Testing**, and add each test Google account under **Test users**.
   - **Data Access:** add these scopes:
     - `.../auth/gmail.readonly` (read mail only)
     - `.../auth/calendar.app.created` (only calendars the app creates)
     - `openid` and `email`
   - **Clients:** create a client of type **Desktop app**, then download its JSON file.
4. Rename the file to `google-oauth-client.json` and put it in the app's data folder:
   - **macOS:** `~/Library/Application Support/ai-scheduling-assistant/`
   - **Windows:** `%APPDATA%\ai-scheduling-assistant\` (not yet checked on Windows)

   The folder is created the first time the app runs. If the file is missing when you click **Connect**, the main window shows the exact path where it's expected.

**Never commit this file.** It's a credential. Share it privately.

While the project is in Testing mode, Google sign-ins **expire after 7 days**. When that happens, the main window asks you to reconnect.

### 4. Create an OpenRouter key

1. Sign in at [openrouter.ai](https://openrouter.ai) and open **Keys**.
2. Create a key with a **credit limit of $0–1**, so a mistake can't cost anything real.
3. Keep the key to yourself. You'll paste it into the app's Settings in the next step, which stores it encrypted. Don't put it in any file in this repo.

### 5. Start the app and configure it

```bash
npm start
```

On first launch, Settings opens:

1. **Email accounts:** add `introtoaicmu@gmail.com` with type *Gmail*, then click **Connect**. Your browser opens Google sign-in; sign in with the shared password. You may see *"Google hasn't verified this app"*: choose *Continue*, which is expected for a project in Testing mode.
2. **Dedicated Google Calendar:** click **Connect Google Calendar** and sign in with the same account. The app creates a calendar called **AI Scheduling Assistant** and only ever writes to that one.
3. **OpenRouter:** paste your key and set **Model** to `dots-studio/dots-3-note-preview:free`.
4. **Initial email range:** choose *Last 30 days* for testing.
5. Click **Save**.

The first sync then starts. After that the app checks every 5 minutes while it's running. Closing a window keeps it running in the tray (menu bar on macOS). To stop it, use **Exit** from the tray menu.

The main window has three buttons:
- **Open Google Calendar**
- **Sync now**, to check right away
- **Settings**

Problems appear on the main window as red text, each with what to do next.

The app always asks OpenRouter to use only providers that don't collect prompts. If no provider for your chosen model qualifies, the main window says so. Choose a different model.

## Testing it yourself

**The test account is shared, so expect other people's test emails and calendars.** Each teammate's app creates its **own** "AI Scheduling Assistant" calendar in the shared account, and each one processes every email in the Inbox. In Google Calendar you may see several calendars with that name. **Open Google Calendar** in the app always opens yours. Put something recognizable, like your name, in your test emails so you can tell them apart.

Send these emails **from another address to `introtoaicmu@gmail.com`**, so they land in its Inbox. The app only reads the Inbox. Mail you send *from* the test account goes to Sent, which the app ignores.

Then click **Sync now** (or wait up to 5 minutes) and click **Open Google Calendar**. Use dates in the coming week.

| Send this | Expected result in the calendar |
|---|---|
| "Confirming our session on Thursday at 3:00–3:50 pm." | A timed event Thursday 3:00–3:50 |
| "Could we find a time next week to talk about the PennWest workshop?" | An all-day **Follow up · P5 PennWest University** entry for today |
| **Reply** to the first email: "Thanks for confirming, we're now moved to Friday, 3:00–3:50 pm instead of Thursday." | The same event moves to Friday. Nothing new is added. |
| **Reply** to the first email: "Something came up, can we move Thursday's session?" | Thursday stays. A follow-up says *Current appointment kept: …* |
| Two confirmations whose times overlap, e.g. Thursday 2:00–2:50 and 2:30–3:20 | Both keep their times and get **Conflict ·** titles listing each other |

Tips:
- **Replies must stay in the same Gmail conversation.** That's how the app links a reschedule to its original appointment.
- **The app only moves an appointment when both sides have agreed** on a new time. "Can we move it to Friday?" is a request, not a move.
- **Don't send many emails at once.** The free model is rate-limited, and the app spaces requests about 3.5 seconds apart. If OpenRouter pushes back, the main window says so and the app retries later.
- **Running Sync now again should change nothing** in the calendar. Duplicates are a bug.
- **If you edit an app event in Google Calendar,** later emails won't overwrite your edit.

### Starting over

Exit the app from the tray. Then do one of these:

- **Delete `assistant.sqlite`** in the app's data folder. That clears accounts, settings, and sync progress. Keep `google-oauth-client.json`.
- **Use a separate profile:**
  ```bash
  npm start -- --user-data-dir="$HOME/ai-scheduling-test"
  ```
  Copy `google-oauth-client.json` into that folder first.

Either way, the next calendar connection creates a new **AI Scheduling Assistant** calendar. You can delete the old one in Google Calendar settings.

## Privacy and security rules

The client's emails may contain patient information, so everyone on the team follows these rules:

- **Never commit real email content, credentials, or API tokens.** That includes `google-oauth-client.json`. Keys and sign-ins entered in Settings are stored encrypted by the operating system, never in plain files. `*.sqlite` and `.env*` are in `.gitignore`.
- **Use test accounts and synthetic emails for development and testing.** Real emails are used only with the client's permission, and only on her machine or an approved setup.
- **Store only what scheduling needs.** Email bodies are read into memory, redacted, and discarded. They're never saved, logged, or written into calendar entries.
- **Redact before anything leaves the computer.** Names, addresses, contact details, and unrelated health details are replaced locally before the AI sees the text. If redaction fails, nothing is uploaded.
- **Nothing is sent to anyone.** The app never sends email, invitations, or confirmations. It writes only to its own dedicated calendar.

## How we work

- Every task is a GitHub issue on the Kanban board. Move your card as you go: **Todo → In Progress → In Review → Done**.
- Make a branch for each issue, for example `12-extract-meeting-details`.
- Open a pull request when the work is ready. Put `Closes #12` in the description so the issue closes when it's merged.
- At least one teammate reviews each pull request before it's merged into `main`.

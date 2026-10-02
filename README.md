# AI Scheduling Assistant

**Team 25**

An AI assistant that helps a therapist manage scheduling across 8 Gmail and Outlook email and calendar accounts. It finds meeting requests in every inbox, checks her real availability across all calendars, and recommends the best meeting times. The client reviews and approves every recommendation before anything is scheduled.

## The problem

The client spends about 2 hours a day on scheduling: checking 8 inboxes for meeting requests, comparing calendars to find open time, deciding which meetings matter most, and going back and forth on times. That is time taken away from patient care.

## What we're building

| Deliverable | What it does |
|---|---|
| **1. Meeting request identification and consolidation** | Finds scheduling emails across all inboxes, pulls out the sender, meeting type, requested times, and duration, and shows them in one daily digest |
| **2. Cross-calendar availability** | Combines all calendars, detects conflicts, and lists the time slots that are truly open |
| **3. Prioritization and recommendations** | Classifies each request by meeting type (patient, podcast, Interactive Foundation, etc.), applies the client's preferences, and ranks the best time slots |
| **Stretch: email triage labels** | Labels every email as meeting request, action needed, important, or not important |

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
ingestion/      Gmail and Outlook email and calendar connectors
extraction/     Meeting request detection and detail extraction
availability/   Combining calendars, conflict detection, open time slots
ranking/        Meeting types, preference rules, slot ranking
ui/             Daily digest and recommendation review screen
data/           Synthetic emails and client preference rules (no real data)
eval/           Evaluation scripts and results
docs/           Privacy plan and design decisions
```

## Getting started

> Setup steps will be filled in once the tech stack is decided in Sprint 1.

1. Clone the repo:
   ```
   git clone https://github.com/[owner]/ai-scheduling-assistant.git
   cd ai-scheduling-assistant
   ```
2. Install dependencies: *TBD*
3. Set up API credentials: *TBD* (see "Privacy and security rules" below before doing this)
4. Run with synthetic data: *TBD*

## Privacy and security rules

The client's emails may contain patient information, so everyone on the team follows these rules:

- **Never commit real email content, credentials, or API tokens.** Keep them in a local `.env` file, which is listed in `.gitignore`.
- **Use synthetic data for development and testing.** Real emails are used only with the client's permission, and only on her machine or an approved setup.
- **Extract only what scheduling needs:** sender, meeting type, requested times, and duration. Full email bodies are never stored.
- **Prefer local AI processing** so raw email content is not sent to outside AI services. See `docs/` for the decision once it's made in Sprint 1.
- **Human in the loop:** the assistant only recommends. Nothing is scheduled without the client's approval.

## How we work

- Every task is a GitHub issue on the Kanban board. Move your card as you go: **Todo → In Progress → In Review → Done**.
- Make a branch for each issue, for example `12-extract-meeting-details`.
- Open a pull request when the work is ready. Put `Closes #12` in the description so the issue closes when it's merged.
- At least one teammate reviews each pull request before it's merged into `main`.

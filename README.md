# Claude Message Level Token Usage

Shows per-turn token usage and estimated cost for Claude Code in the VS Code status bar.

## Why /compact saves you money

Claude Code sends your **entire conversation history** with every message. As a session grows, that context accumulates — you end up paying for the same earlier messages over and over. Running `/compact` summarizes the history into a short digest, which can cut token costs by **60–80%** mid-session without losing the thread of the conversation.

## /compact notification

Every **10 user messages** (configurable), a notification pops up reminding you to compact:

- Click **Copy /compact** → the command is copied to your clipboard and Claude Code is focused. Just paste and press Enter.
- Click **Dismiss** or the **X** to close the notification without doing anything.

## Settings

Open VS Code Settings and search **Claude Token Tracker**.

| Setting | Default | Description |
|---|---|---|
| `claudeTokenTracker.compactNotification` | `true` | Enable or disable the /compact reminder notification |
| `claudeTokenTracker.compactThreshold` | `10` | Number of user messages between notifications |

Set `compactThreshold` lower (e.g. `5`) for shorter sessions, or set `compactNotification` to `false` to turn off reminders entirely.

## Status bar

The status bar item shows the **total token count and cost for the last complete turn**, including all intermediate tool-use steps. Click it for a full breakdown by token type (input, output, cache read/write).

---

Created by **Wahidul Hasan Abir**  
[LinkedIn: wahidul hasan abir](https://www.linkedin.com/in/wahidulhasanabir)

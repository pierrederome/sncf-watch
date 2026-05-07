---
name: sncf-watch
description: Watch sncf-connect.com for an SNCF train route that matches the user's constraints (route, date, max correspondances, max price). Trigger when the user wants to monitor French train availability or wait for a price drop / seat release on a specific journey, e.g. "watch trains Royan to Paris Sunday under 150€", "alert me when a direct Lyon-Marseille appears on May 10", "loop sncf-connect until a TGV becomes bookable". Polls the results page in a real Chrome (puppeteer over CDP) so the user's already-validated session bypasses captchas; beeps + shows the matched journey in chat when found.
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion, ScheduleWakeup, TaskCreate, TaskUpdate
---

# sncf-watch

Polls https://www.sncf-connect.com results page for a journey that matches the user's constraints. Uses a real Chrome window controlled via Chrome DevTools Protocol so the user solves any bot-check captcha *once*, and the session is reused on every poll.

## How it works

1. Launch a Chrome with `--remote-debugging-port=9222` and an isolated profile.
2. The user manually browses to sncf-connect, passes the captcha, accepts cookies, and runs the search **once**. They land on `/home/shop/results/outward`.
3. A Node.js polling script connects via CDP, **reloads the same results page**, parses the journey blocks, and checks each one against the criteria. The search state is preserved server-side, so `reload` re-runs the search.
4. A bash loop runs the poller every N seconds. On a match, it beeps and writes a `MATCH.txt`.
5. Claude itself sleeps with `ScheduleWakeup` and surfaces the match in chat as soon as it's written.

## Step-by-step

### 1. Greet and gather criteria

Ask the user with **AskUserQuestion** (multiple questions in ONE call):

1. "Where to where?" — header **Route**, free-text via `Other` (recommend "Royan → Paris" only as illustrative example; do NOT preset their answer).
2. "Which date?" — header **Date**, options like "Tomorrow", "This Sunday", "Specific date" (Other).
3. "Max correspondances allowed?" — header **Max corr**, options 0/1/2/3.
4. "Max price (€)?" — header **Budget**, options "100", "150", "200", "No limit" (Other lets them type any value).

If the user already gave all four in their initial prompt, skip this step.

### 2. Run install/setup

```bash
bash ~/.claude/skills/sncf-watch/scripts/install.sh
```

This script (idempotent) ensures: node, puppeteer module, and the bundled Chromium with its system libs. On Linux/WSL it tries to detect missing libs (libasound2 is the usual one) — if a missing lib is detected and sudo is needed, the script prints a single command for the user to run (do NOT try to use sudo from your tool calls; surface the command and stop until the user confirms it's installed).

### 3. Launch Chrome with debug port

```bash
bash ~/.claude/skills/sncf-watch/scripts/launch_chrome.sh
```

The script:
- Detects OS (Linux / WSL / macOS) and chooses the right Chrome binary
- Starts Chrome with `--remote-debugging-port=9222` and an isolated profile dir (so it does not collide with the user's normal Chrome)
- Opens https://www.sncf-connect.com/
- Polls `http://127.0.0.1:9222/json/version` until ready
- On WSL, the Chrome window appears via WSLg on the Windows desktop

If port 9222 is taken (a previous run is still alive), the script reuses it.

### 4. Hand off to the user for the manual search

Tell the user verbatim:

> A Chrome window should be open on your desktop pointing at sncf-connect.com.
> Please:
> 1. Solve the slider captcha if it appears.
> 2. Accept the cookies banner.
> 3. Click "Trains", type the origin and destination, set the date, click **Rechercher**.
> 4. Once you see the results page (URL contains `/results/outward`), reply **ready**.

STOP and wait for the user. Do not proceed until they confirm.

### 5. Start the polling loop

Build the run directory and start the loop in the background:

```bash
RUN_DIR="$HOME/.sncf-watch/runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR"
MAX_CORR=<from-step-1> MAX_PRICE=<from-step-1> INTERVAL=300 RUN_DIR="$RUN_DIR" \
  setsid bash ~/.claude/skills/sncf-watch/scripts/loop.sh \
  </dev/null >"$RUN_DIR/loop.stdout" 2>&1 &
disown
```

Verify the loop started by `pgrep -f sncf-watch/scripts/loop.sh` and tail `$RUN_DIR/loop.log`.

Tell the user the PID, the run dir, and that you'll keep checking.

### 6. Sleep and surface matches

Use **ScheduleWakeup** with `delaySeconds: 270` (just under the 5-min cache TTL so context stays warm). The wake-up prompt should be:

> Check `$RUN_DIR/MATCH.txt`. If it exists, cat it and show the contents to the user. Otherwise tail `$RUN_DIR/loop.log` and schedule another wake at 270s with the same prompt. If the loop process is dead but no MATCH file exists, show the last 20 log lines and stop.

Substitute `$RUN_DIR` with the actual path before passing the prompt to ScheduleWakeup (the wake-up runs in a fresh turn — env vars don't carry).

### 7. On match: announce and stop scheduling

When `MATCH.txt` appears:
- Read it and paste the matched journey blocks into chat (concise: time, duration, route, corr, price).
- Confirm the loop already beeped (the loop fires PowerShell beeps on Windows/WSL, `afplay` on macOS, `paplay` on Linux).
- Suggest the user opens sncf-connect in their normal Chrome to actually book.
- Do NOT schedule another wakeup unless the user explicitly asks to keep watching for more options.

## Stopping a run

`pkill -f sncf-watch/scripts/loop.sh` — and optionally close the Chrome window (or leave it for the next run; the launcher reuses port 9222).

## Where things live

- Skill code: `~/.claude/skills/sncf-watch/scripts/`
- Per-run logs/state: `~/.sncf-watch/runs/<timestamp>/`
  - `loop.log` — one line per iteration with the JSON summary
  - `last_results.json` — most recent parsed journeys
  - `MATCH.txt` / `MATCH.json` — written when a match is hit (also serves as marker)
- Chrome profile: `~/.sncf-watch/chrome-profile/` (kept across runs so cookies persist; safe to delete to force fresh captcha)

## Robustness notes

- The **search state lives server-side** under the cookies of that Chrome profile. If the user closes the Chrome window between runs, the next launch_chrome will re-open it but the user must redo the search. Tell them this when they ask to "stop the loop but keep the watcher".
- If `poll.js` exits with code 3, the reload bounced back to the home page → server forgot the search. Treat this as a soft error: prompt the user to re-run the search manually, then continue the loop (do NOT try to automate the form — sncf-connect's captcha will fire on programmatic input).
- The price parser handles `"137,10 €"`, `"45 €"`, `"1 234,50 €"` (French locale). It picks the **minimum** numeric € price visible in each journey block.
- The matching predicate is: `corr <= MAX_CORR && min_price != null && min_price <= MAX_PRICE`. A journey with a class marked "Complet" may still match if **another class** in the same block has a price under the cap.

## Sharing this skill with a friend

Direct them to `~/.claude/skills/sncf-watch/README.md` — it has the install one-liner.

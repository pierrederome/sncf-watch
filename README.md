# sncf-watch

A Claude Code skill that watches sncf-connect.com for a French train route matching
your constraints (route, date, max correspondances, max price) and beeps + tells you
in chat when a journey is bookable.

It works around sncf-connect's bot CAPTCHA by driving a real Chrome window over
DevTools Protocol — you solve any captcha **once**, run the search **once**, and the
loop reloads the same results page every few minutes.

## Installation (Linux / WSL / macOS)

1. Clone into your Claude Code skills directory:
   ```bash
   git clone https://github.com/pierrederome/sncf-watch.git ~/.claude/skills/sncf-watch
   ```

2. Run the installer once. It downloads puppeteer's Chromium and tells you what
   system libs are missing (Linux/WSL only — macOS usually has everything):
   ```bash
   bash ~/.claude/skills/sncf-watch/scripts/install.sh
   ```
   On Ubuntu/Debian, you may need: `sudo apt-get install -y libasound2t64`.

3. **WSL users:** Make sure WSLg is working (Windows 11 has it by default). The
   Chrome window will appear on your Windows desktop automatically.

## Use

In Claude Code, just say what you want — Claude will trigger the skill:

> watch trains Royan to Paris this Sunday, alert me when one with at most 2
> correspondances drops under 150 €

Claude will:
1. Confirm route, date, and thresholds via questions.
2. Run `install.sh` and `launch_chrome.sh`.
3. Ask you to solve the captcha and run **the search** in the Chrome window
   that opens (the URL has to land on `/results/outward`).
4. Start the polling loop in the background.
5. Sleep, wake periodically, and surface the match in chat the moment it appears.
6. Trigger an audible beep when matched.

## Stop

```bash
pkill -f sncf-watch/scripts/loop.sh
```

State (logs, last results, match marker) lives under `~/.sncf-watch/runs/<timestamp>/`.
The Chrome profile (cookies, captcha state) lives at `~/.sncf-watch/chrome-profile/` —
keep it across runs to avoid solving the captcha again. Delete it for a fresh start.

## Caveats

- The search state is server-side. If you close the Chrome window, you'll need to
  re-run the search next time before restarting the loop.
- The skill never automates the form (sncf-connect's bot detection fires on
  programmatic input). It only reloads the URL after you ran the search yourself.
- The price parser handles `137,10 €`, `45 €`, `1 234,50 €`. It picks the minimum
  numeric € visible in each journey block, so a journey with one class "Complet"
  will still match if another class has a price under your cap.

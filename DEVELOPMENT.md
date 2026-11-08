# Judge Monitor: developer notes

Notes for whoever (human or Claude) works on this next. Written after the first build at the
Mesa Rim Reno boulder QE (Nov 7, 2026) and testing on the R21 Practice Event (Nov 8, 2026).
Everything so far was built and tested on **boulder, jam format** rounds only.

## What it is and how it ships

- `usac-monitor.js` is a read-only overlay injected into a logged-in **admin** tab on
  usac.results.info. It never writes scores (score entry is `PUT /admin/ascents/:id`; don't
  call it).
- Users install a tiny bookmarklet from `index.html` (published at
  https://chsnow.github.io/usac-judge-monitor/). The bookmarklet loads
  `https://chsnow.github.io/usac-judge-monitor/usac-monitor.js?t=<now>` each click, so
  **pushing to `main` updates everyone** on their next click (GitHub Pages takes ~1 min).
  To check Pages is live, fetch the file and look for a string you just added.
- Clicking the bookmark always stops any monitor already in the tab and restarts on the round
  you're viewing (the site is a single-page app, so the old one survives navigation).
- Run it from any category's results page (`/admin/category_rounds/<id>/results`) or a jam
  format setup page (`.../jam_format/<roundId>`). It works out the round from there.

## How it gets data (important)

- The site is a Vue 2 single-page app with Apollo GraphQL at `/graphql`. Find the root Vue
  instance (`el.__vue__` with `$router` and `$apollo.provider`) and use
  `$apollo.provider.defaultClient`.
- **GraphQL uses an allowlist of persisted queries.** Custom query text gets HTTP 422.
  You must reuse the app's own query documents. `findDoc(path, test)` gets them by matching
  a route with `$router.match(path)`, loading its lazy components and scanning their
  `apollo` options for a query whose source matches a regex.
- Queries in use:
  - `AdminCaRoundQuery` (category round; `round.settings`, `round.id`), from the results page
  - `AdminCatRoundRankingQuery` (`ranking_items`: one per registered climber, each with
    `ascents[]`), from the results page. This is the main data source.
  - `RoundQuery` (category rounds, routes, `judge_positions[].judge_position_routes[]` for the
    route-to-JP map, `max_tries`), from `/admin/events/1/round_setup/1/jam_format/1`
  - `RoundSetupDisciplineQuery` has `rounds{settings}` and route `difficulties` (empty in
    both events checked). Not currently used.
- The judge-side `JudgePosition` query returns **403 for admin accounts** (it's judge-only).
- The audit log (`/admin/events/<id>/audits`) records admin actions only (finish, generating
  heats), **not** score entries, and has no device/session info.

## Data model (boulder, jam format)

- Category round `aasm_state`: `pending` (not started), `active` (climbing), `finished`
  (finalized). The monitor watches only `active`.
- Ascent (one per climber per boulder) `aasm_state`: `pending` (not opened yet), `active`
  (opened/scored, **not confirmed**: the open green box in the UI), `confirmed`, `locked`.
- `top_tries` = **attempts used** (and the top attempt if topped). `zone_tries` /
  `low_zone_tries` are only meaningful when `zone` / `low_zone` is true.
- Rounds with `round.settings.boulder_points_formats.use_low_zone === false` have no low-zone
  holds; the site then **auto-fills `low_zone: true, low_zone_tries: 1`** whenever a zone is
  scored. The monitor ignores low zone in those rounds.
- DNS/DSQ: the ranking item's `score` is the string `"DNS"` / `"DSQ"` (`irm_present` truthy).
- Max attempts: `category_round.max_tries || round.max_tries` (20 at Reno).
- Ascent fields seen: `id, top, top_tries, zone, zone_tries, low_zone, low_zone_tries, points,
  updated_at, created_at, participant_id, route_id, not_started, heat_run_participant_id,
  aasm_state`. The judge-side version also has `lead_score, plus, time, dnf, dns`.

## Alerts (see `computeAlerts`)

- **ERROR: Prior score changed** (red): compares each record with its last *confirmed*
  result (`confirmedRes`). A new attempt can only add attempts and add a result on the new
  attempt; a top/zone/low zone removed or moved, a result added on an earlier attempt, or
  fewer attempts means an earlier attempt was edited. Stays (latched) until dismissed.
  Logic is in `priorDiffs`; there's a node test harness pattern (extract the code between
  `const MILESTONES` and `function fmtAgo` with `new Function`).
- **Not confirmed**: red if the athlete has since been scored on another boulder (names it),
  yellow if open longer than "Unconfirmed after N min".
- **Inactive judge position** (yellow): a position with climbers left has had no activity
  for "Inactive position after N min" while another position is active.
- **Counts don't add up** (yellow): per climb, Total (registered) must equal
  Not started + Remaining + Done + DNS.
- **Everyone topped** (blue) and **JP finished** (green): informational, no beep.
- Removed on purpose: "possible 2 judges". The data has no device/session info, so timing
  alone couldn't separate two judges from one fast judge on an easy boulder (lots of false
  alarms).
- Alerts sort newest first (each alert has a `t`).

## Table columns

Total | Not started | Remaining | Done | DNS ‖ Pending | Confirmed | Last activity, per judge
position with a sub-row per live climb (label like `M15-1`, plus dropped from `19+`).
- Done = topped, locked, DSQ or out of attempts. Not started = not done and never opened.
  Remaining = not done, started, attempts left. DNS climbers are excluded from the three.
- Pending = unconfirmed (`active`) records; amber when > 1. Last activity amber when a climb
  with climbers left has been idle longer than the inactive limit. Fully topped climbs greyed.
- Category names and climb labels link to the category results page (new tab). Bibs open the
  results page and type the bib into its search box (the page has no URL parameter for it).

## Phone alerts (ntfy.sh)

- **Phones** button in the top bar opens a panel. Settings live in
  `localStorage['usacJudgeMonitor:phones']` = `{on, topic, done}`, per laptop, shared by all
  rounds. `on` is **off by default** so only the laptop that opts in sends; two senders on one
  topic would double every ping. The topic is generated as `usacjm-` + 8 typeable characters
  (no 0/o/1/l/i) because iPhone users have to type it.
- Sending: `notifyPhones(alerts)` runs at the end of `render`. It sends `high` and `med`
  alerts (plus `done` = JP finished if ticked), once per alert key. Sent keys are in
  `notified`, saved with the round state so a reload doesn't resend. More than 3 new at once
  go as one summary. A failed send un-marks its keys, so the next refresh retries.
- Transport: `fetch('https://ntfy.sh/', {method:'POST', body: JSON.stringify({topic, title,
  message, priority, tags, click})})`. Posting the JSON **without** a Content-Type header
  keeps it a simple CORS request (no preflight); ntfy still parses it as JSON. The site has
  **no CSP** (checked Nov 8, 2026). If it ever adds `connect-src`, this breaks.
- `phoneMsg` turns an alert into plain text: strips the link markers, puts the JP first,
  drops the athlete name (alerts that include a name carry it as `nm`), sets priority
  5/4/3 for red/yellow/green and `click` to the category results page.
- `phones.html` is the setup page (printable). It reads the topic from the URL `#fragment`
  (never sent to a server), draws QR codes with the vendored `qrcode.js`
  (qrcode-generator 1.4.4, MIT) for the App Store, Google Play and an Android
  `ntfy://ntfy.sh/<topic>` subscribe link. iOS has no deep link, so iPhone users type the topic.
- Testing without bothering real phones: set the topic to a throwaway, turn sending on, then
  read it back with `GET https://ntfy.sh/<topic>/json` plus `poll=1` and `since=all` query
  parameters. Afterwards turn it off, restore the topic, stop the monitor, and delete
  `notified` from the round's saved state, or the real alerts won't be sent later.
- Testing a branch before pushing to main: load
  `https://cdn.jsdelivr.net/gh/chsnow/usac-judge-monitor@<commit>/usac-monitor.js` with a
  script tag in the admin tab (raw.githubusercontent won't execute).

## Persistence

`localStorage['usacJudgeMonitor:round:<roundId>']` keeps the confirmed-result cache, latched
prior-change alerts, dismissals and which alerts were sent to phones, so reloads and re-clicks pick up where they left off.

## Gotchas for a Claude in Chrome session

- The side panel's browser tools only work in turns where the user sent a message from the
  side panel. **Scheduled check-ins can't use the browser**, so don't promise unattended
  watching. Build it into the monitor instead.
- The JS tool's output gets blocked if it contains query-string-looking text (`?`, `=`, `&`).
  Strip those characters from output.
- Chrome slows timers on hidden pages (background tab, screen locked) to about once a minute
  after 5 minutes. Polling is driven by a Web Worker (`pollWorker`, from a Blob URL), whose
  timers aren't throttled that way. The "Refreshes were delayed" banner still shows if a gap
  over 45 s happens anyway (e.g. the Mac slept).
- Locked-screen use on a Mac: plug in power and stop the Mac sleeping when the display is off
  (Battery > Options > Prevent automatic sleeping on power adapter when the display is off,
  or run `caffeinate -is` in Terminal). Closing the lid sleeps the Mac regardless.
- Don't enter or change scores in the site while testing unless the user explicitly asks.
- User preference: whenever you mention a bib, include the category, e.g. `bib 1983 (M/O-19+)`.

## Lead / top rope: what will probably need changing

Not built or tested yet. Things to check first on a lead/TR event:
1. Discipline `kind` and category round `format` values (boulder was
   `boulder_one_group_ifsc_2026`). Look at `discipline.kind` from the results page data.
2. Whether judge positions / `judge_position_routes` exist for lead/TR, or if judging is by
   route or heat (`heat_id`, `heat_run_participant_id` appear on ascents).
3. What an ascent's result looks like: `lead_score`, `plus`, `top`, `time` (speed/TR timing?),
   and whether there are multiple attempts at all. The judge app's `show_ascent_info` shows
   lead as `Top` or `<lead_score>` plus `+`.
4. "Prior score changed" for lead: a confirmed `lead_score`/`plus`/`top` should not change
   later; there's probably no attempt count, so `priorDiffs` needs a lead-specific version.
5. Remaining/Done/Not started, Everyone topped and JP finished all assume boulder attempts
   and may need different definitions (e.g. one attempt per route in lead).
6. Keep the boulder behaviour unchanged; branch on discipline kind.

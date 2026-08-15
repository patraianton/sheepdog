# sheepdog

A live kanban board that herds your coding-agent fleet.

## What it is

sheepdog is a local web board for people who run many parallel coding-agent
sessions inside [herdr](https://herdr.dev). It reads the live state of every
session straight from herdr and lays it out as a kanban:

- **Card = session.** One open agent session, one card. Nothing is merged or
  entered by hand — herdr is the source of truth.
- **Columns = agent states:** working / blocked (needs you) / done (awaiting
  your review) / idle / unknown. Cards move by themselves as agents work;
  you never drag them.
- **Refreshes every 3 seconds.** The "stuck for N h" timer shows how long a
  card has been sitting in its current state.
- **Click a card to jump there.** The board focuses that herdr tab; the tab
  currently focused in herdr is highlighted on the board ("you are here").
- **Three tabs:** *Mine* (your own work, kanban), *Team* (one row per person,
  with "waiting on you" counters fed from `state/team.json`), *Other*
  (windows herdr doesn't understand, as a plain list).
- **The only manual input** is what herdr cannot know: priority (P1/P2/P3),
  a life-direction tag for color-coding, a "must not stop" star (the card
  turns red if a starred session goes quiet), a kind — temporary (⏱),
  ongoing (∞) or cron-driven (↻, work happens on a schedule so an idle
  session is fine) — and a short note. All of it is set by clicking on the
  card and stored in `state/projects.json`, keyed by the session's working
  directory.
- **Power button on a card** (⏻, asks "sure?") tells the session to save
  everything important to the project's memory and commit, waits for it to
  finish, logs the window to `state/closed.jsonl`, then closes it. If the
  session asks a question instead, closing stops and the board tells you.

## Why

One operator, dozens of parallel agent sessions. Past a certain fleet size
you stop remembering which window is blocked on you, which one finished an
hour ago, and which one silently died. Any board that needs manual updating
rots in two days — so this one updates itself and only asks you for the two
things no tool can know: what matters most, and which part of your life it
belongs to.

## Quickstart

Requirements: Windows, Node.js 16+, herdr installed (in `PATH` or in its
default install folder).

```
node bin/board-server.mjs --open
```

or just run `bin\board.cmd`. The board opens at `http://127.0.0.1:4877`.

Optional autostart on Windows logon: create a scheduled task that runs
`bin\board-hidden.vbs` (starts the server with no console window).

## Optional: pending review pages (lavish-axi)

If you route decisions through [lavish-axi](https://github.com/kunchenguid/lavish-axi)
review pages instead of reading terminals, the board can show them: while the
board is open it asks the `lavish-axi` CLI for its open sessions once a minute
and pins each artifact to the closest card by its project folder — a magenta
"◈ LAVISH" strip that opens the review page in a new tab, plus a total in the
header. If the CLI is not installed, the feature stays off silently.

## Optional: watching a second machine

If part of your fleet runs on another computer, the board can poll it over
ssh (read-only: it lists agent processes) and show a green "agent running on
second machine" line on the matching cards, so a starred card doesn't raise
a false alarm while the real work happens elsewhere.

Set the ssh alias of that machine in the environment:

```
SHEEPDOG_REMOTE_HOST=<your-ssh-alias> node bin/board-server.mjs
```

The mapping "task on the second machine → local project folder" lives in
`state/remote-bridge.json`. If the variable is not set, the feature is off
and nothing is polled. By default the board looks for checkouts under
`Developer/`, `projects/`, `work/` or `src/` on that machine; a `_dirs` array
in the same file overrides the list.

## Privacy and footprint

- **Zero dependencies.** Plain Node, no `package.json`, nothing to install.
- **Localhost only.** The server listens on `127.0.0.1:4877` and talks to
  nothing but the local herdr CLI (and, if you enabled it, your own second
  machine over your own ssh config). Nothing leaves your machine.
- All board state lives in `state/` (gitignored) as small JSON files you can
  read and edit by hand.

## Handing a task to a worker agent

`bin/teammate.mjs` is the other half of the same idea: instead of watching
sessions you opened by hand, an agent session opens one itself.

```
node bin\teammate.mjs new "Rewrite the CSV parser, keep the tests green"
node bin\teammate.mjs check
node bin\teammate.mjs close tm-0814-223149
```

`new` creates a tab in the window it is run from, starts a coding agent there
with a written brief, and records the tab, the pane and the folder in
`state/teammates/`. The worker reports by appending one-line updates
(`working: …`, `needs-decision: …`, `done: …`) to its own status file, so
`check` is a single cheap pass that costs no agent tokens: it prints only what
wants your attention and exits 1 when something does. `close` refuses to touch
anything it cannot prove is still the tab it opened, and erases the record only
after herdr answers that the pane is gone.

With `--tree`, the worker also gets its own pooled git worktree: teammate
leases a copy of the repository from treehouse and puts it on a fresh branch
named after the worker (`tm-…`) cut from the captain's current commit, so parallel workers never
collide on files. The copy is wiped when it goes back to the pool at close —
only commits survive — so `close` refuses while uncommitted changes sit in it,
then reports how many commits landed on the branch and how to merge them.

See `docs/teammate.md`.

## How it talks to herdr

See `docs/herdr-api.md` — a field guide to the herdr CLI surface the board
uses: what can be read (sessions, states, titles, windows), what can be
written back (metadata tokens, so board data shows up inside herdr itself),
and what herdr does not track (time in state, priority), which is exactly
the part sheepdog stores for itself.

## License

MIT — see `LICENSE`.

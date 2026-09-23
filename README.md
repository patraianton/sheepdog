# sheepdog

A live kanban board and dispatcher for a fleet of coding-agent sessions. It
runs on Microsoft Windows under Node.js and needs no extra packages. In daily
use since August 2026.

sheepdog is a local kanban board for one person who runs dozens of Claude Code
and Codex sessions in [herdr](https://herdr.dev), a program that runs many
coding-agent sessions side by side. herdr shows each session in a window, and
a window can hold several tabs, each with its own session. On 6 August 2026,
just before sheepdog was written, the owner's fleet held 44 herdr windows
(`docs/herdr-api.md`).

The board gives every session one card. It reads the live state of each
session from herdr, lets you file each project folder into a lane by hand, and
raises one verdict per card: whether the next step is on you. It replaces the
morning round through all those windows with one page that says which
sessions need you and that everything else is fine. A second Claude Code
session beside it, the dispatcher, reads the whole board as one page of text
and writes decisions back.

## What it does

- **One card per open agent session.** herdr is the source of truth for the
  agent inside, its title, its folder and its window, and for its state with
  one correction (see Session facts below); the board adds only what herdr
  cannot know. A card also says where it belongs, unless that would repeat
  its own name: the herdr window its tab sits in, and the git repository its
  folder is part of.
- **Three lanes, filed by hand.** You file each project folder into one lane,
  and its subfolders follow unless you file them separately. Unfiled cards
  wait in *Unsorted*, and a card never changes lane by itself.

  | Lane | What goes there | How it shows |
  |---|---|---|
  | Focus | The few sessions you work in today | Full cards, each carrying the task it was launched on |
  | Ongoing | Work that is built and keeps running while you watch | Thin rows that open when something is on you, the session is working or proven busy (see below), or it has just finished |
  | Tools | Fix-it sessions | An alphabetical jump list that never raises an alarm |

- **One verdict the board raises itself: "on you".** A card gets an ON YOU
  strip with its reason when nothing but you can move it. What counts depends
  on the lane: a Focus session that stopped, a Focus card with no agent, a
  blocked session, an open review page (see lavish-axi below), an arrived
  check-back date, a usage-limit stop, a `codex exec` run the session started
  on a second computer that has ended, an Ongoing session you starred as
  "must not stop" that has gone silent. Alarms (something that must run does
  not) are red; asks (the session waits for your word) are magenta. A header
  toggle shows only those cards, and its counter is the number to look at
  first.
- **A dispatcher brief.** `GET /brief` prints every card on the board's
  *Mine* view as one page of plain text: on-you cards first, then Focus with
  each session's task and last words, then Ongoing, Tools and Unsorted. The
  dispatcher reads that page instead of going through every window and writes
  decisions back with `bin/dispatch.mjs`: which sessions are today's focus,
  what each was launched on, what happened since.
- **An idle session counts as busy only when a process, a counter or a timer
  proves it.** The proof is a live watcher process of that pane, a background
  task or helper agent the session started and has not yet collected, a
  wake-up the session scheduled for itself, or a `codex exec` process on the
  second computer that the session's own command line started. A card also
  counts as running while any `codex exec` on the second computer works in a
  folder that `state/remote-bridge.json` maps to the card's folder. A session
  that only says it is waiting gets a grey line: "says it waits — nothing
  running here". When the `codex exec` run the session started on the second
  computer ends while the session stays silent, the card gets a LANE OVER
  strip (here *lane* means that Codex run, not a board lane), because nothing
  will ever wake that session by itself.
- **A recap line on live cards.** A small local model
  (`qwen3-4b-instruct-2507` served by LM Studio, by default) summarises the
  tail of each live session's journal (the `.jsonl` transcript Claude Code
  writes for every conversation) into one line. The model writes only that
  line; it never decides a lane or a verdict.
- **A prompt-cache clock on every full card.** Anthropic's API keeps a stored
  copy of the conversation (the prompt cache) that makes the next message
  cheaper and faster; once it expires, the next message pays for the whole
  conversation again. The API keeps that copy for 5 minutes by default, or
  for one hour if the client asks for it and pays more for each write.
  sheepdog assumes one hour after the last request (`SHEEPDOG_CACHE_TTL_MIN`
  changes that; set it to 5 for a client on the default) and counts that hour
  down on the card. Focus and starred full cards turn red 10 minutes before
  the end and, if you switch on the Cache bell in the header, raise a browser
  notification, so you can send a short message and keep the cache instead
  of rebuilding it.
- **A worker agent in its own tab.** `bin/teammate.mjs` lets an agent session
  hire another one: it opens a tab in its own herdr window, writes the task
  down as a brief, starts Claude Code there, and reads the worker's one-line
  status updates from a file, so watching costs no agent tokens. With `--tree`
  the worker gets its own git worktree (a second checkout of the same
  repository) leased from a pool that treehouse, a separate CLI, manages, so
  parallel workers never collide on files.
- **A card can be renamed without touching the window.** `dispatch rename`
  gives the card a name you will remember ("Promo fix" instead of a branch
  name). The alias lives only in the board's state, keyed by the herdr window
  id, and the window keeps its own name in a small line under the alias.
- **Cards survive a herdr restart.** After a restart the windows come back
  before their agents do; those windows stay on the board as dimmed cards
  marked "no agent" until you bring the sessions back.

## How it works

| Piece | Where | What it does |
|---|---|---|
| herdr CLI | `herdr api snapshot`, `herdr workspace list`, `herdr agent list` | The server polls these three commands. Together they return, for every pane, the agent kind, its status (`idle` / `working` / `blocked` / `done` / `unknown`), its title, its working directory, its session id and its window, tab and pane ids. |
| Board server | `bin/board-server.mjs` | A plain Node HTTP server on `127.0.0.1:4877`. It merges herdr state with the files in `state/`, computes the "on you" verdict per card, serves `/data` and `/brief`, and takes writes on `/set`, `/plan`, `/focus` and `/retire`. |
| Board page | `bin/board.html` | One HTML file that asks `/data` every 3 seconds and repaints only on change. Three views, picked at the top of the page: *Mine* (the kanban), *Team* (one row per person, with "waiting on you" counters from `state/team.json`) and *Other* (sessions you set aside). |
| Session facts | `bin/session-facts.mjs` | Every 20 seconds one Git Bash pass over `/proc` finds the shells each pane launched (they carry `HERDR_PANE_ID` in their environment). It also reads the session's journal for pending task counters, scheduled wake-ups and the usage-limit line, and it overrides herdr's `working` when the pane's title carries Claude Code's idle marker and the journal has been silent for 2 minutes. A vanished watcher gets 20 minutes to come back; no wait built on a local process or a pending counter outlives 2 hours past the journal's newest line. |
| Dispatcher | `bin/dispatch.mjs` | `brief`, `type`, `launch`, `note`, `done`, `clear`, `rename`. Every write goes through the board server, so the board and the brief never disagree. The plan lives in `state/plan.json`, one entry per folder. |
| Teammate | `bin/teammate.mjs` | `new`, `list`, `check`, `wait`, `log`, `say`, `close`. One card, one brief and one status file per worker in `state/teammates/`. `check` exits 1 when a worker wants you, so it drops straight into a script or a hook. |
| Recap model | any OpenAI-compatible server | Recaps run in a serial background queue with a 2-minute cooldown per journal, so the 3-second poll never waits for the GPU. Default: LM Studio at `127.0.0.1:1234`, model `qwen3-4b-instruct-2507`. Before each recap the server first probes `127.0.0.1:8099` (`SHEEPDOG_RECAP_NIGHT_URL`) for a second local model and asks that one instead when it is up; an explicit `SHEEPDOG_RECAP_URL` switches the probe off. If no server answers, the card shows the session's last words instead. |
| Second computer | `ssh <alias> pgrep -fl "codex exec"` | Every 5 minutes, while the board is open, the server lists Codex processes on a second computer you reach over ssh and matches them to cards through `state/remote-bridge.json`. Off unless `SHEEPDOG_REMOTE_HOST` is set. |
| Review pages | [lavish-axi](https://github.com/kunchenguid/lavish-axi) CLI | lavish-axi turns an agent's question into a web page you answer in the browser. Once a minute the server asks it for its open pages and pins each one to the card of its project folder. If the CLI is not installed, the feature stays off. |

herdr does not record how important a folder is, which part of your life it
belongs to, or how long a session has been in its current state, so sheepdog
keeps these itself. `state/projects.json` holds one entry per project folder:
the lane, a priority (P1 to P3), a tag for the part of your life the folder
belongs to (work, health, side project) that sets the card's colour, a "must
not stop" star, a check-back date, a note and, per window, an alias. A
subfolder inherits its parent folder's entry, except the note and the alias.
`state/seen.json` records when each state was first seen, which is where the
"stuck for N h" timer comes from. `docs/herdr-api.md` is a field guide to the
herdr CLI surface: what the board reads, what herdr accepts back, and what it
does not track.

## What was measured, and what it changed

- Before session facts existed, the recap model judged whether an idle session
  was waiting on an external system, and a dead CI wait stayed green for
  22 hours on the strength of its wording. A review panel then compared what
  12 live sessions said about themselves with what was really running on the
  machine: no way of reading the sessions' own words got more than 9 of the
  12 right (`bin/board-server.mjs`). Since then an idle session counts as
  busy only on a machine fact, such as a live process or a pending counter
  (commit e19e605, "Work in motion is a fact read off the machine").
- Four changes went through a review whose only job was to find defects:
  14 findings on the herdr-restart change (commit 1bc21da), 12 confirmed
  fixes on the second version of the board (1cb3692), 6 defects in
  `teammate` confirmed by a 20-agent review (93152b7), and a pass over
  clipped and overflowing page elements by 5 reviewers working from
  screenshots (327438e).
- One `herdr api snapshot` of 44 windows is about 68 KB
  (`docs/herdr-api.md`), small enough that the server reads the whole fleet
  on every 3-second poll.
- Claude Code's own `/recap` summary exists only inside the interactive
  session: none of 1,960 recent journals on disk stored one, so the board
  shows the agent's last message instead (`bin/board-server.mjs`).

## Run it

You need Microsoft Windows (the launchers are `.cmd` and `.vbs`, and the
process sweep runs through Git Bash), Node.js 18 or newer and herdr in `PATH`
or in its default install folder. There is nothing to install.

```
node bin/board-server.mjs --open
```

`bin\board.cmd` does the same. The board opens at `http://127.0.0.1:4877`. For
autostart on Windows logon, create a scheduled task that runs
`bin\board-hidden.vbs`; it starts the server with no console window.

The dispatcher runs from any terminal.

```
node bin\dispatch.mjs brief
node bin\dispatch.mjs type 12 focus
node bin\dispatch.mjs launch 12 "Fix the flaky release build"
node bin\dispatch.mjs rename 12 "Release build"
node bin\dispatch.mjs done 12
```

A window is named by its herdr number (`#12` or `12`) or by a unique part of
its card's name. `launch` records the task on the card and sends it into the
session with `herdr agent prompt`; sending works only from inside a herdr pane,
and `--record-only` skips it.

A worker agent is hired from inside a herdr pane.

```
node bin\teammate.mjs new "Rewrite the CSV parser, keep the tests green" --tree
node bin\teammate.mjs check
node bin\teammate.mjs close tm-0814-223149
```

All optional settings are environment variables.

| Variable | Default | Effect |
|---|---|---|
| `SHEEPDOG_RECAP_URL` | `http://127.0.0.1:1234/v1/chat/completions` | The OpenAI-compatible endpoint that writes the recap line. |
| `SHEEPDOG_RECAP_MODEL` | `qwen3-4b-instruct-2507` | The model name sent to it. |
| `SHEEPDOG_RECAP_KEY` | none | Bearer key, sent only when set. |
| `SHEEPDOG_RECAP_NIGHT_URL` | `http://127.0.0.1:8099` | A second local model server probed before each recap and asked instead when it is up; `SHEEPDOG_RECAP_NIGHT_KEY` or `SHEEPDOG_RECAP_NIGHT_KEY_FILE` supplies its key. |
| `SHEEPDOG_REMOTE_HOST` | unset | The ssh alias of the second computer to poll. |
| `SHEEPDOG_CACHE_TTL_MIN` | 60 | Minutes the prompt cache is assumed to live. |
| `SHEEPDOG_CACHE_WARN_MIN` | 10 | Minutes before the end at which the card warns. |
| `SHEEPDOG_URL` | `http://127.0.0.1:4877` | Where `dispatch.mjs` finds the board. |

## Safety limits and blind spots

- The server listens on `127.0.0.1:4877` only. It talks to the local herdr
  CLI, the lavish-axi CLI if it is installed, the local model servers and, if
  you set it, your own second computer through your own ssh config. Session
  text leaves your machine only if you point `SHEEPDOG_RECAP_URL` or
  `SHEEPDOG_RECAP_NIGHT_URL` at another computer; the ssh poll sends one
  `pgrep` command and reads its answer.
- Reading changes nothing: herdr lists, the `/proc` sweep, journal tails and
  `pgrep` over ssh only look. The board never moves a card between lanes,
  never writes a note, never renames a herdr window and never sends a prompt
  into a session on its own. `dispatch launch` sends only on your word.
- The Power button on a card asks "sure?", then tells the session to save
  everything important to the project's memory and commit, waits for it to
  finish (each wait times out after 15 minutes, up to four waits), appends the
  window to `state/closed.jsonl` and closes it. If the session asks a question
  instead, closing stops and the board tells you.
- `teammate` refuses four things: to hire from outside a herdr pane, to take
  `say` or `close` from another herdr pane unless it adds `--steal`, to close
  a tab it cannot prove is still the one it created, and to erase a record
  before herdr answers `pane_not_found`. A `--tree` worker's copy is returned
  to the pool only after that confirmation and only with a clean tree. The
  worker runs `claude --dangerously-skip-permissions`, so the brief and the
  folder you chose are the only limits on what it may do. Details in
  `docs/teammate.md`.
- Session facts depend on the Claude Code journal and environment layout
  (verified on Claude Code 2.1.238). If a Claude Code update changes that
  layout, the board shows fewer facts but never a false one; the header shows
  FACTS OFFLINE when the sweep stops seeing panes. Known blind spot: the
  `/proc` sweep sees Git Bash processes only, so a watcher started as a native
  Windows process is invisible and its session reads as "says it waits —
  nothing running here".
- All board state lives in `state/`, which is gitignored, as small JSON files
  you can read and edit by hand.

## Repository layout

```
bin/board-server.mjs    the server: herdr polling, verdicts, brief, state files
bin/board.html          the page: lanes, cards, prompt-cache clock, Team and Other views
bin/session-facts.mjs   process sweep and journal facts behind the busy-or-not decision
bin/dispatch.mjs        the dispatcher CLI (brief, type, launch, note, done, clear, rename)
bin/teammate.mjs        hire, watch and close a worker agent in its own herdr tab
bin/board.cmd, bin/dispatch.cmd, bin/teammate.cmd, bin/board-hidden.vbs   Windows launchers
docs/herdr-api.md       what herdr provides and what it accepts back
docs/teammate.md        the teammate commands, the card, the status contract, the refusals
FAST-WORKER-RULES.md    rules to prepend by hand to a worker's brief on internal tooling (teammate does not add them itself)
treehouse.toml          settings for treehouse, the separate CLI that pools git worktrees for --tree workers
state/                  board state, gitignored
```

## License

MIT. See `LICENSE`.

# teammate — a worker agent in its own herdr tab

`bin/teammate.mjs` lets one agent hire another. The captain is whichever
agent pane runs the script: it opens a new tab in its own herdr window,
writes the task down as a brief file, starts Claude there, and from then on
the worker reports by appending one-line updates to a status file. `check`
is one cheap pass the captain runs whenever it likes; the only thing that
loops is `wait`, a slow poll built to be left running in the background.

Run `node bin\teammate.mjs <command>` (or `bin\teammate.cmd`). All state
lives in `state/teammates/` — one card, one brief, one status file per
worker.

## Commands

### `new "<task>" [--cwd <path>] [--file <brief.md>] [--model <name>] [--label <text>]`

Opens a tab in the captain's window (without stealing focus) and starts a
worker on the task. Inline text and `--file` can be combined — the file is
appended after the text. `--cwd` defaults to the captain's own directory.

```
> node bin\teammate.mjs new "Write docs/teammate.md — a field guide to bin/teammate.mjs" --label docs-teammate
tm-0814-223149  tab w44:t4  pane w44:p4
  cwd    C:\Users\panto\.herdr\worktrees\process-management\teammate
  brief  ...\state\teammates\tm-0814-223149.brief.md
  status ...\state\teammates\tm-0814-223149.status

Next: node bin\teammate.mjs check
```

The card is written **before** the tab exists, so a crash mid-launch leaves
a traceable record instead of an orphan tab nobody owns. The new tab gets
the captain's account variables — `CLAUDE_CONFIG_DIR` plus
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` /
`ANTHROPIC_MODEL`, whichever are set, because a fresh tab starts from
herdr's own environment and would otherwise land on a different or no
account — plus `TEAMMATE_ID` / `TEAMMATE_BRIEF` / `TEAMMATE_STATUS`.
teammate waits for the shell prompt, types the Claude launch line, answers
the "do you trust this folder" question itself (the captain chose the
folder), and gives the agent a minute to start working. A worker that
never gets going is recorded on the card as `launch-problem`, not silently
abandoned; "not logged in" is reported too, because only a human can fix
that.

Know before delegating: the worker is started with
`claude --dangerously-skip-permissions`, so it acts without asking anyone.
The brief's rules and the `--cwd` you chose are the only fence — scope
both accordingly.

### `list [--all] [--json]`

Every worker, its state and its last line. Closed workers are hidden
unless `--all`. A `!` in the first column means "wants the captain".

```
> node bin\teammate.mjs list
! tm-0814-223149  idle        3m  Write docs/teammate.md — a field guide to bin/teammate.mjs
      done: docs/teammate.md written and verified
      w44:p4  C:\Users\panto\.herdr\worktrees\process-management\teammate
```

### `check [--json]`

One pass, no loop. Attention is raised when a worker says `done` or
`failed`; when it says `needs-decision` or `blocked` and the captain has
not yet answered (a `say` reply silences that alarm until the worker
writes again); when its pane disappeared; when a card is stuck in
`failed-to-create` or `launch-problem`; and when a worker has shown no
sign of life for over four minutes. An agent herdr reports as `working`
counts as alive even if silent, a `paused` worker is left alone with no
silence alarm, and an idle agent is never assumed to have finished.

Exit codes: 0 all quiet, 1 look at something, 2 teammate itself refused or
hit an error — so it drops straight into a script or a hook.

```
> node bin\teammate.mjs check
! tm-0814-223149  worker says needs-decision
    said: needs-decision: keep the examples in PowerShell or plain cmd?
    pane w44:p4  cwd C:\Users\panto\.herdr\worktrees\process-management\teammate
    read: node bin\teammate.mjs log tm-0814-223149
```

### `wait [--every S] [--timeout S]`

The same pass on a slow loop, as a thing to leave running in the
background: it prints nothing until a worker wants something, then
returns. `--every` defaults to 15 seconds (minimum 3); `--timeout 0`, the
default, means wait forever. Exit codes: 1 someone wants the captain, 0 no
workers left, 3 the timeout passed with nothing to report.

```
> node bin\teammate.mjs wait --every 30 --timeout 1800
! tm-0814-223149  worker says done
    said: done: docs/teammate.md written and verified
```

### `log <id> [--lines N] [--tail]`

The worker's own status lines, then the last N lines of its screen
(default 60). `--tail` skips the screen and prints the status lines only.
This is what the captain reads before deciding anything.

```
> node bin\teammate.mjs log tm-0814-223149
# tm-0814-223149 — Write docs/teammate.md — a field guide to bin/teammate.mjs
working: reading bin/teammate.mjs and existing docs
done: docs/teammate.md written and verified

--- its screen, last 60 lines ---
...
```

### `say <id> "<text>"`

Sends more instructions into the same session — the worker keeps all its
context. The message also lands in the status file as a `captain:` line,
which keeps the exchange readable in one place and acknowledges a
`needs-decision` or `blocked` line, so `check` goes quiet until the worker
speaks again.

```
> node bin\teammate.mjs say tm-0814-223149 "Keep it in English and match the tone of docs/herdr-api.md."
sent to tm-0814-223149 (w44:p4)
```

### `close <id> [--force]`

Closes exactly that tab, once the work has landed. Without `--force` it
refuses unless the worker's last line is `done` or `failed` — the work may
be unfinished and unsaved, read it first. If the pane already vanished on
its own, `close` retires the card (after herdr confirms — see the refusals
below).

```
> node bin\teammate.mjs close tm-0814-223149
tm-0814-223149 closed (done: docs/teammate.md written and verified)
```

## What a card holds

`state/teammates/<id>.json`, rewritten atomically at every state change:

| Field | What it is |
|---|---|
| `id`, `task` | `tm-<MMDD-HHMMSS>` (plus a short random suffix if two hires land in the same second) and the first line of the task |
| `state` | `creating` → `launching` → `running` → `closed`, or `failed-to-create` / `launch-problem` |
| `error` | why creating or launching failed — the reason `check` shows |
| `cwd` | where the worker works |
| `captain` | pane, tab and workspace ids of the pane that ran `new` |
| `workspace_id`, `tab_id`, `pane_id` | the worker's own window, tab and pane, as named by herdr |
| `label`, `model` | the tab label; a model override, if any |
| `brief`, `status` | paths to the two files next to the card |
| `env_passed` | names (not values) of the variables handed to the tab |
| `created_at`, `launched_at`, `closed_at` | timestamps |
| `closed_saying` | the worker's final line, kept after closing |

Next to the card: `<id>.brief.md`, the full task the worker is told to
read, and `<id>.status`, the file the worker appends to.

## The status contract

The worker reports by appending one short line to its status file. Only
the first word before the colon is parsed:

| Word | Meaning |
|---|---|
| `working` | going fine, nothing needed from anyone |
| `needs-decision` | the captain must choose something |
| `blocked` | cannot continue (no access, tool broken) |
| `paused` | stopped on purpose, will resume |
| `done` | finished, and the work has landed |
| `failed` | cannot be finished, with the reason |

The rules the brief gives every worker: write `working: ...` as the very
first action, a line at every real change of situation, and exactly one
`done:` or `failed:` line at the end. Prolonged silence raises attention
(see `check`). After the last line the worker stays in its tab — the
captain reads the work, may `say` more into the same session, and closes
the tab itself.

## The three refusals

What keeps this safe to run unattended:

1. **It will not run outside a herdr pane.** Before hiring, it demands
   `HERDR_ENV=1` plus the pane, tab and workspace ids herdr put in the
   environment (`HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID`),
   and asks herdr itself whether those ids agree. A label is never
   authority — it acts only on ids herdr gave it. A pane that is itself an
   open worker is refused too: workers do not hire workers.

2. **It will not close a tab it cannot prove is still the one it created.**
   Before `say` or `close`, the pane on record must still sit in the same
   tab, the same window, the same working directory. If any of that
   drifted, something else lives there now and it is not touched. On top
   of that, `close` refuses the captain's own pane and refuses the last
   tab of a window — closing it would close the whole window.

3. **It will not erase a record until herdr answers `pane_not_found`.**
   After asking herdr to close the tab, it polls `pane get` and marks the
   card closed only when herdr returns that exact error code. Any other
   answer — including a confusing one — leaves the card intact, so a
   half-closed tab can never turn into an untracked one.

# What herdr provides — and what it accepts back

Verified live on 2026-08-06, herdr 2026.08, Windows.
Binary: `%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe` (also available in PATH).

All commands talk to the running server through a local socket
(`%APPDATA%\herdr\herdr.sock`) and answer with a line of JSON. A server error
is JSON on stderr and exit code 1. An error in the command itself is exit
code 2.

## Reading: what herdr already knows

### `herdr agent list`

The main source. For every pane with a recognized agent it returns:

| Field | What it is | Why we care |
|---|---|---|
| `agent` | `claude` / `codex` / ~18 more kinds | which tool is inside |
| `agent_status` | `idle` / `working` / `blocked` / `done` / `unknown` | the board column |
| `cwd` | working directory | identifies the project |
| `terminal_title_stripped` | the session title the agent writes itself | **a ready-made task name** |
| `workspace_id` / `tab_id` / `pane_id` | ids like `w34`, `w34:t1`, `w34:p1` | to jump to the window |
| `state_change_seq` | counter, grows on every state change | to catch "something changed" |
| `revision` | pane edit counter | |

Session titles are real task names, nobody invents them:
"Night sprint until 8:00", "Fix the flaky release build",
"Review lane-a backlog".

### `herdr workspace list`

For every window: `label` (window name), `number` (ordinal in the sidebar),
`agent_status` (summary state across the window's panes), `pane_count`,
`tab_count`, `focused`, and `worktree` — when the window is bound to git:
`repo_name`, `repo_root`, `checkout_path`, `is_linked_worktree`.

### `herdr api snapshot`

The full session snapshot in one command (~68 KB at 44 windows). Lives under
`.result.snapshot`. Handy when you want everything at once instead of three
calls.

### Other reads

- `herdr tab list --workspace <ID>` — a window's tabs
- `herdr pane list --workspace <ID>` — panes
- `herdr pane get <PANE_ID>` / `herdr agent get <TARGET>` — one item in detail
- `herdr agent read <TARGET> --source recent-unwrapped --lines 120` — the last
  lines of the agent's output. Sources: `visible`, `recent`, `recent-unwrapped`,
  `detection`.

## Writing: what herdr accepts back

This is the valuable part. The board isn't off to the side — its data shows
up right in the herdr sidebar.

### Tokens on a window

```
herdr workspace report-metadata <WORKSPACE_ID> --source <who writes> --token <NAME=VALUE>
```

Verified:

```
> herdr workspace report-metadata w34 --source kanban-probe --token "prio=P1" --ttl-ms 120000
> herdr workspace get w34
{"result":{"workspace":{"label":"my-project","agent_status":"working","tokens":{"prio":"P1"},...}}}
```

The token landed and reads back. `--ttl-ms` — after how long it disappears on
its own (without it, it lives until removed). `--clear-token <NAME>` removes
it. `--seq <N>` guards against races when two writers compete.

### Tokens on a pane

```
herdr pane report-metadata <PANE_ID> --source <who> [options]
```

Can do more than a window:

- `--title <TEXT>` — override the pane title (`--clear-title` restores it)
- `--display-agent <TEXT>` — override the displayed agent name
- `--state-label <STATE=TEXT>` — your own text instead of the standard state
  name. For example `blocked=WAITING ON YOU 4h`
- `--token <NAME=VALUE>` — an arbitrary token
- `--ttl-ms`, `--seq`, `--clear-*`

### Waiting

```
herdr agent wait <TARGET> --until blocked --timeout 120000
```

States: `idle`, `working`, `blocked`, `done`, `unknown`. Without `--until` it
waits for any of `idle`/`done`/`blocked`. Without `--timeout` it waits
forever.

## What herdr does NOT have — and what you must store yourself

1. **Time.** No command reports when a state changed. There is only the
   `state_change_seq` counter. So "stuck for 4 hours" has to be computed by
   polling and recording when a new state was first seen.
2. **Priority.** Herdr doesn't know what matters more.
3. **Life direction.** Herdr knows the folder, but not that `fitness` is
   health and `client-site` is paid work.
4. **History.** `session-history.json` in `%APPDATA%\herdr` exists (1.5 MB),
   but it is herdr's internal format — do not depend on it, it will change
   and everything will break.

Conclusion: the board's own state file stores exactly four things — priority,
direction, when the current state was first seen, and a note. Everything else
comes from herdr.

## Important caveats

- Control commands (`agent prompt`, `pane run`, `agent start`) require
  `HERDR_ENV=1`, i.e. they only work from a pane inside herdr. Reading works
  from outside too.
- Clarified (verified 2026-08-08): `pane report-agent` / `release-agent` do
  work from outside, without `HERDR_ENV`. But the reported state has no TTL —
  it sticks and masks the real one until removed with `release-agent`. So we
  don't use it on live panes; the probe was done on a dead window and fully
  rolled back.
- Ids of closed windows and panes are not reused.
- A pane moved to another window gets renamed — the old id stops working.
- `unknown` does not mean "finished". It means "herdr couldn't tell what's
  inside".
- `done` is the same as `idle`, except the work finished while you weren't
  looking. As soon as the window gains focus, `done` turns into `idle`.
  Reading via the CLI does not count as focus — which is good: the board
  doesn't "eat" your done-work notifications.

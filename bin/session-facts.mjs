// sheepdog — facts about whether a session's work is in motion, read from the
// machine itself, never inferred from prose.
//
// An idle Claude Code session can be woken by exactly four things: a background
// task it started (a live process — its watcher, poll or probe), a workflow or
// agent it launched (no process of its own, but a pending counter on the
// session's newest turn line), a wake-up it scheduled for itself, or a human.
// The first three leave machine-readable footprints, and that is what decides
// the ⏳ strip (operator's decision after the 2026-08-22 review panel: a sentence
// from the session's journal had kept a dead CI wait green for 22 hours).
//
// Sources, all local and read-only:
//   1. Process sweep: every shell a session spawns carries HERDR_PANE_ID and
//      CLAUDE_PID in its environment; Git Bash can read /proc/<pid>/environ of
//      those (MSYS) processes in one pass. Windows node cannot read /proc, hence
//      the bash one-liner. Native Windows children (a PowerShell-tool watcher)
//      are not in /proc and stay invisible — a known blind spot.
//   2. Journal facts (the session's .jsonl): the newest system/turn_duration line
//      carries pendingWorkflowCount / pendingBackgroundAgentCount; the newest
//      ScheduleWakeup result carries scheduledFor; the newest line's timestamp
//      ages everything.
// Everything here is version-specific to the Claude Code journal/environment
// layout (verified 2.1.238) — any drift makes facts rarer, never invents one,
// and the board shows a FACTS OFFLINE chip when the sweep stops seeing panes.

import { execFile } from 'node:child_process';
import { stat, open } from 'node:fs/promises';

export const WAIT_CAP_MS = 2 * 3600_000;    // no ⏳ outlives two hours past the journal's newest line
export const WAIT_GRACE_MS = 20 * 60_000;   // a vanished watcher may re-arm within 20 minutes of journal silence
export const SWEEP_EVERY_MS = 20_000;
const SWEEP_TIMEOUT_MS = 15_000;
const SWEEP_STALE_MS = 60_000;               // a sweep older than this counts as no sweep
const SILENT_ZERO_MS = 30 * 60_000;          // clean sweeps with zero tagged processes while sessions work -> tripwire

const BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'bash',
];

// One pass over /proc: for every MSYS process whose environment names a herdr
// pane, print pane, conversation id, claude pid, msys pid, parent msys pid and
// the command line. Pure bash (no tr/grep/cut per process) — ~40 ms for the
// whole machine. The marker comment lets the sweep skip its own shell.
const SWEEP_SCRIPT = `# sheepdog-sweep
for d in /proc/[0-9]*; do
  e="$d/environ"; [ -r "$e" ] || continue
  pane=; sid=; cpid=; ppid=
  while IFS= read -r -d '' kv; do
    case $kv in
      HERDR_PANE_ID=*) pane=\${kv#*=};;
      CLAUDE_CODE_SESSION_ID=*) sid=\${kv#*=};;
      CLAUDE_PID=*) cpid=\${kv#*=};;
    esac
  done < "$e" 2>/dev/null
  [ -n "$pane" ] || continue
  st=$(< "$d/stat") 2>/dev/null
  [[ $st =~ \\)\\ +[A-Za-z]\\ +([0-9]+) ]] && ppid=\${BASH_REMATCH[1]}
  cmd=$(tr '\\0\\t\\n' '   ' < "$d/cmdline" 2>/dev/null | head -c 3000)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$pane" "$sid" "$cpid" "\${d#/proc/}" "$ppid" "$cmd"
done`;

function runBash(script) {
  return new Promise((resolve) => {
    const tryOne = (i) => {
      if (i >= BASH_CANDIDATES.length) return resolve(null);
      execFile(BASH_CANDIDATES[i], ['-c', script], { timeout: SWEEP_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err && err.code === 'ENOENT') return tryOne(i + 1);
        resolve(err ? null : String(stdout));
      });
    };
    tryOne(0);
  });
}

// Live Windows PIDs, to drop task shells orphaned by a dead session (their
// environment still names the pane; their CLAUDE_PID no longer exists).
function liveWindowsPids() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: SWEEP_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const pids = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^"[^"]*","(\d+)"/);
        if (m) pids.add(m[1]);
      }
      resolve(pids);
    });
  });
}

// The task shell's command line is `bash -c "source <snapshot> && eval '<cmd>'
// < /dev/null && pwd -P >| ..."`; the eval body is the command the session
// wrote, byte for byte, with ' escaped as '"'"'. Children (sleep, gh, ssh) carry
// the same environment but no eval — they are the same wait, not another one.
function evalBody(cmd) {
  const start = cmd.indexOf("eval '");
  if (start === -1) return null;
  const from = start + 6;
  const end = cmd.indexOf("' < /dev/null", from);
  // The sweep caps a command line; a long loop may be cut before its tail.
  return cmd.slice(from, end === -1 ? undefined : end).replace(/'"'"'/g, "'");
}

// A short name for what a watcher watches, from its own command — fixed table,
// no prose. Unmatched commands are named by their first real command word and
// shown as plain RUNNING rather than EXTERNAL, so the strip never claims what
// it cannot read.
const LABELS = [
  [/\bpr checks (\d+)/, m => `CI #${m[1]}`],
  [/\bpull\/(\d+)\b/, m => `CI #${m[1]}`],
  [/\brun (?:watch|view) (\d+)/, m => `run ${m[1]}`],
  [/\bruns\/(\d+)\b/, m => `run ${m[1]}`],
  [/\bgh (?:run|api)\b/, () => 'CI poll'],
  [/\bssh\b[\s\S]*?(REPORT-[\w.-]+)/, m => `Mac ${m[1]}`],
  [/\bssh\b/, () => 'Mac job'],
  [/\bvercel\b/, () => 'deploy'],
  [/teammate\.mjs wait/, () => 'worker session'],
  [/\bcodex\b/, () => 'codex run'],
  [/\bcurl\b|https?:\/\//, () => 'probe'],
];
const SHELL_NOISE = /^(?:cd|export|set|until|while|for|do|done|if|then|else|fi|sleep|echo|printf|true|\(|\{|[A-Za-z_][\w]*=.*)$/;
function labelFor(body) {
  for (const [rx, f] of LABELS) { const m = body.match(rx); if (m) return { label: f(m), known: true }; }
  const word = body.split(/[\s;&|()]+/).map(t => t.replace(/^["']+|["']+$/g, '')).find(t => t && !SHELL_NOISE.test(t)) || 'background task';
  return { label: word.replace(/^.*[\\/]/, '').slice(0, 24), known: false };
}

// Watchers that wait on the OPERATOR, not on a system: never a fact of motion.
// Their children (a sleep inside the poll loop) are dropped with them.
const DENY = [/lavish-axi/, /sheepdog-sweep/];

export function createFacts() {
  let state = { checkedAt: 0, ok: false, byPane: new Map(), error: null, zeroSince: 0 };
  let sweeping = false;

  async function sweep(workingPanes) {
    if (sweeping || Date.now() - state.checkedAt < SWEEP_EVERY_MS) return;
    sweeping = true;
    try {
      const [out, pids] = await Promise.all([runBash(SWEEP_SCRIPT), liveWindowsPids()]);
      if (out === null) { state = { ...state, checkedAt: Date.now(), ok: false, byPane: new Map(), error: 'bash sweep failed' }; return; }
      const rows = [];
      for (const line of out.split('\n')) {
        const [pane, sid, cpid, mpid, ppid, ...rest] = line.split('\t');
        const cmd = rest.join('\t');
        if (!pane || !cmd) continue;
        if (pids && cpid && !pids.has(cpid)) continue;       // orphan of a dead session
        rows.push({ pane, sid, cpid, mpid, ppid, cmd, body: evalBody(cmd), denied: DENY.some(rx => rx.test(cmd)) });
      }
      // A denied shell takes its descendants with it (up to four levels).
      const byPid = new Map(rows.map(r => [r.mpid, r]));
      const isDenied = (r) => { let cur = r; for (let i = 0; cur && i < 5; i++) { if (cur.denied) return true; cur = byPid.get(cur.ppid); } return false; };
      const byPane = new Map();
      for (const r of rows) {
        if (isDenied(r)) continue;
        if (!byPane.has(r.pane)) byPane.set(r.pane, []);
        byPane.get(r.pane).push(r);
      }
      // Silent-zero tripwire: a clean sweep that sees no tagged process for half
      // an hour while herdr says sessions are working means the environment
      // layout changed under us, not that the fleet is quiet.
      let zeroSince = state.zeroSince;
      if (rows.length || !workingPanes) zeroSince = 0;
      else if (!zeroSince) zeroSince = Date.now();
      state = { checkedAt: Date.now(), ok: true, byPane, error: null, zeroSince };
    } catch (e) {
      state = { ...state, checkedAt: Date.now(), ok: false, byPane: new Map(), error: String(e.message || e) };
    } finally { sweeping = false; }
  }

  function health() {
    const stale = Date.now() - state.checkedAt > SWEEP_STALE_MS;
    const silent = state.zeroSince && Date.now() - state.zeroSince > SILENT_ZERO_MS;
    const offline = !state.ok || stale || Boolean(silent);
    return { ok: state.ok && !stale, offline, reason: !state.ok ? (state.error || 'sweep failed') : stale ? 'sweep stale' : silent ? 'no tagged processes for 30 min while sessions work' : null };
  }

  // Processes of one pane, summarised: how many distinct waits (task shells,
  // or root processes when no shell is visible), a label, and WHEN this was
  // seen — the sweep's time, not the poll's.
  function processesOf(pane) {
    if (!state.ok || Date.now() - state.checkedAt > SWEEP_STALE_MS) return null;
    const list = state.byPane.get(pane);
    if (!list || !list.length) return { count: 0, at: state.checkedAt };
    const shells = list.filter(p => p.body);
    const pids = new Set(list.map(p => p.mpid));
    const roots = list.filter(p => !pids.has(p.ppid));
    const picked = shells.length ? shells : (roots.length ? roots : list);
    const main = picked[0];
    const { label, known } = labelFor(main.body ?? main.cmd);
    const count = picked.length;
    return { count, label: count > 1 ? `${label} +${count - 1}` : label, known, cmd: (main.body ?? main.cmd).slice(0, 300), at: state.checkedAt };
  }

  return { sweep, health, processesOf, checkedAt: () => state.checkedAt };
}

// --- Journal facts ---------------------------------------------------------
// Read from the tail of the session's journal; cached by (mtime, size).
const journalCache = new Map(); // file -> { key, facts }
const JOURNAL_CACHE_MAX = 400;
const TAIL_BYTES = 262_144;

async function readTail(file, size) {
  const len = Math.min(TAIL_BYTES, size);
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(len);
  try { await fh.read(buf, 0, len, size - len); } finally { await fh.close(); }
  return buf.toString('utf8').split('\n');
}

// A usage-limit stop is a synthetic assistant line (`error: "rate_limit"`,
// `quotaLimits.resetsAt` in unix seconds, verified 2.1.239) followed by a
// system notice saying whether the harness will continue by itself; a later
// "Automatic continue cancelled" notice (the tab went to the background)
// withdraws that. The text alone is the fallback for older journals.
const RATE_LIMIT = /You've (?:reached|hit) your [^\n"]{0,40}limit/;
const AUTO_CONTINUE = /continuing automatically/i;
const AUTO_CANCELLED = /Automatic continue cancelled/i;
// Present-tense waiting words in the recap, in the languages the fleet speaks
// — decoration only (the grey "says it waits" line), never a column input.
// Plain \b is ASCII-only, hence the letter look-arounds.
export const SAYS_WAITS = /(?<!\p{L})(?:ожида(?:ет|ю|ем|ние)|жд[ёу]т|жду|ждём|в очереди|waiting|awaiting|queued)(?!\p{L})/iu;

export async function journalFacts(file) {
  const s = await stat(file).catch(() => null);
  if (!s) return null;
  const key = `${s.mtimeMs}|${s.size}`;
  const hit = journalCache.get(file);
  if (hit && hit.key === key) return hit.facts;
  // paused: the newest assistant line is a usage-limit stop. pausedAt = when
  // it hit, resetsAt = when the limit lifts (ms, or null), autoResume = the
  // harness still promises to continue by itself at that time.
  const facts = { lastLineAt: null, pending: 0, pendingAt: null, wakeAt: null, paused: false, pausedAt: null, resetsAt: null, autoResume: false };
  try {
    const lines = await readTail(file, s.size);
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || typeof o !== 'object') continue;
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (!Number.isNaN(ts) && (!facts.lastLineAt || ts > facts.lastLineAt)) facts.lastLineAt = ts;
      if (o.isSidechain) continue;
      if (o.type === 'system' && o.subtype === 'turn_duration') {
        facts.pending = (Number(o.pendingBackgroundAgentCount) || 0) + (Number(o.pendingWorkflowCount) || 0);
        facts.pendingAt = Number.isNaN(ts) ? null : ts;
      } else if (o.type === 'system' && typeof o.content === 'string') {
        if (facts.paused && AUTO_CONTINUE.test(o.content)) facts.autoResume = true;
        else if (facts.paused && AUTO_CANCELLED.test(o.content)) facts.autoResume = false;
      } else if (o.type === 'assistant') {
        const t = (o.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        const limited = o.error === 'rate_limit' || o.quotaLimits?.status === 'rejected' || (Boolean(t) && RATE_LIMIT.test(t));
        if (limited) {
          facts.paused = true;
          facts.pausedAt = Number.isNaN(ts) ? null : ts;
          facts.resetsAt = typeof o.quotaLimits?.resetsAt === 'number' ? o.quotaLimits.resetsAt * 1000 : null;
          facts.autoResume = false;
        } else if (t || (o.message?.content ?? []).length) {
          facts.paused = false; facts.pausedAt = null; facts.resetsAt = null; facts.autoResume = false;
        }
      } else if (o.type === 'user' && o.toolUseResult && typeof o.toolUseResult.scheduledFor === 'number') {
        facts.wakeAt = o.toolUseResult.scheduledFor;
      }
    }
  } catch { /* unreadable journal: no facts, and none is the safe direction */ }
  if (journalCache.size >= JOURNAL_CACHE_MAX) journalCache.delete(journalCache.keys().next().value);
  journalCache.set(file, { key, facts });
  return facts;
}

// The decision for one card. `prev` is the last known wait of this pane (from
// seen.json) so a watcher that blinks out of the sweep does not flicker;
// returns the motion object for the card (or null) and the record to persist.
export function decideMotion({ agent, status, procs, journal, prev, now }) {
  if (!agent || status === 'working') return { motion: null, record: null, paused: false };
  const paused = Boolean(journal?.paused);
  const lastLineAt = journal?.lastLineAt ?? null;
  const capOk = lastLineAt != null && now - lastLineAt <= WAIT_CAP_MS;
  let m = null;
  let seenAt = now;
  if (!paused) {
    if (procs && procs.count > 0) {
      m = { kind: 'proc', label: procs.label, known: procs.known, cmd: procs.cmd };
      seenAt = procs.at ?? now;
    } else if (journal && journal.pending > 0 && journal.pendingAt && now - journal.pendingAt <= WAIT_CAP_MS) {
      m = { kind: 'bg', label: `${journal.pending} background ${journal.pending > 1 ? 'tasks' : 'task'}`, known: true };
    } else if (journal && journal.wakeAt && journal.wakeAt > now && journal.wakeAt - now <= WAIT_CAP_MS) {
      m = { kind: 'wake', label: `next round in ${Math.max(1, Math.round((journal.wakeAt - now) / 60000))} min`, known: true, wakeAt: journal.wakeAt };
    } else if (prev?.kind === 'proc' && prev.last) {
      // Grace bridges a watcher that blinked out of the sweep while the
      // session stayed SILENT. Any new journal line since the last sighting —
      // a notification that the watcher ended, the session's own next turn —
      // ends it at once: from then on the facts above are the whole truth.
      const lastMs = Date.parse(prev.last);
      const silent = lastLineAt == null || lastLineAt <= lastMs;
      if (now - lastMs <= WAIT_GRACE_MS && silent) m = { kind: 'proc', label: prev.label, known: prev.known !== false, grace: true };
    }
    if (m && m.kind !== 'wake' && !capOk) m = null;
  }
  if (!m) return { motion: null, record: null, paused };
  // One continuous wait keeps its start time across re-arms and across a
  // switch of kind (watcher -> scheduled wake-up); `last` moves only on a
  // real sighting, never during grace, so grace cannot extend itself.
  const continuous = Boolean(prev?.since && prev?.last && now - Date.parse(prev.last) <= WAIT_GRACE_MS);
  const record = {
    since: continuous ? prev.since : new Date(now).toISOString(),
    last: m.grace ? prev.last : new Date(seenAt).toISOString(),
    kind: m.kind, label: m.label, known: m.known !== false,
  };
  return { motion: { ...m, since: record.since }, record, paused };
}

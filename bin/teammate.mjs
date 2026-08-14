// teammate — hand a task to a worker agent in its own herdr tab, watch it,
// close it when the work has landed.
//
// The captain is whichever agent pane runs this script. It creates a tab in
// its own window, writes a brief, starts Claude there, and from then on the
// worker reports by appending one-line updates to its own status file.
// Nothing here polls in a loop: `check` is one cheap pass the captain runs
// whenever it likes.
//
// Run: node bin\teammate.mjs <command>   (or bin\teammate.cmd)

import { execFile } from 'node:child_process';
import { readFile, writeFile, appendFile, readdir, mkdir, rename, stat } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CREW_DIR = path.join(ROOT, 'state', 'teammates');

const HERDR_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Herdr', 'bin', 'herdr.exe'),
  'herdr',
];

const TREEHOUSE_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'treehouse', 'treehouse.exe'),
  'treehouse',
];

// First word of a status line. Everything after the colon is free text.
const REPORT_STATES = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed'];
const TERMINAL_STATES = new Set(['done', 'failed']);
const CALLING_STATES = new Set(['needs-decision', 'blocked']);

// How long a worker may show no sign of life before `check` raises it.
const QUIET_LIMIT_MS = 4 * 60 * 1000;

// A new tab starts from herdr's own environment, not from the captain's pane,
// so the worker would land on a different (or no) account. These carry over.
const INHERIT_ENV = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
];

// ---------------------------------------------------------------- herdr calls

// Resolves with the parsed JSON on success and rejects with an Error carrying
// .code (herdr's structured error code, e.g. pane_not_found) on failure. That
// code is the only thing we trust as proof that something is really gone.
function herdr(args) {
  return new Promise((resolve, reject) => {
    const tryOne = (i) => {
      execFile(HERDR_CANDIDATES[i], args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const text = String(stdout || '') || String(stderr || '');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        if (err) {
          if (err.code === 'ENOENT' && i + 1 < HERDR_CANDIDATES.length) return tryOne(i + 1);
          const e = new Error(parsed?.error?.message || String(stderr || '').trim() || err.message);
          e.code = parsed?.error?.code ?? null;
          return reject(e);
        }
        if (!parsed) return reject(new Error(`herdr ${args.join(' ')}: response is not JSON`));
        resolve(parsed);
      });
    };
    tryOne(0);
  });
}

// `pane read` / `agent read` answer with the screen itself, not with JSON.
function herdrText(args) {
  return new Promise((resolve, reject) => {
    const tryOne = (i) => {
      execFile(HERDR_CANDIDATES[i], args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT' && i + 1 < HERDR_CANDIDATES.length) return tryOne(i + 1);
          let code = null;
          try { code = JSON.parse(String(stdout || stderr))?.error?.code ?? null; } catch { /* plain text */ }
          const e = new Error(String(stderr || '').trim() || err.message);
          e.code = code;
          return reject(e);
        }
        resolve(String(stdout || ''));
      });
    };
    tryOne(0);
  });
}

// Plain exec with the same candidate fallback, for treehouse and git.
function execCandidates(candidates, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const tryOne = (i) => {
      execFile(candidates[i], args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT' && i + 1 < candidates.length) return tryOne(i + 1);
          return reject(new Error(String(stderr || '').trim() || err.message));
        }
        resolve(String(stdout ?? ''));
      });
    };
    tryOne(0);
  });
}

const git = (cwd, ...args) => execCandidates(['git'], args, { cwd });

// ---------------------------------------------------------------- small tools

// Paths from herdr arrive in mixed shapes: \\?\ prefixes, forward slashes.
function normPath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  s = s.replaceAll('/', '\\').toLowerCase();
  while (s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ago(ms) {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`; // per-process, so parallel writers never share it
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, file);
}

// Written synchronously: a piped stdout can drop a buffered line on exit, and
// a refusal nobody sees is worse than no refusal at all.
function die(msg) {
  writeSync(2, msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(2);
}

// ------------------------------------------------------------------ the cards

const cardFile = (id) => path.join(CREW_DIR, `${id}.json`);
const briefFile = (id) => path.join(CREW_DIR, `${id}.brief.md`);
const statusFile = (id) => path.join(CREW_DIR, `${id}.status`);

async function readCard(id) {
  try { return JSON.parse(await readFile(cardFile(id), 'utf8')); }
  catch { return null; }
}

async function allCards() {
  let names = [];
  try { names = await readdir(CREW_DIR); } catch { return []; }
  const ids = names.filter((n) => n.endsWith('.json') && !n.endsWith('.tmp')).map((n) => n.slice(0, -5));
  const cards = await Promise.all(ids.map(readCard));
  return cards.filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// The worker's own voice: its last real report, and when the file last grew.
// The captain's own `say` lines land in the same file as a record of the
// conversation, but they are not the worker speaking — a reply must not erase
// the `done:` it is replying to.
async function readReport(id) {
  const empty = { lines: [], last: null, at: null };
  let text = '';
  try { text = await readFile(statusFile(id), 'utf8'); } catch { return empty; }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let at = null;
  try { at = (await stat(statusFile(id))).mtimeMs; } catch { /* file vanished */ }
  if (!lines.length) return { ...empty, at };

  let last = null;
  let answered = false; // did the captain already reply to this line?
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^captain\s*:/i.test(lines[i])) { answered = true; continue; }
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(lines[i]);
    if (m && REPORT_STATES.includes(m[1].toLowerCase())) {
      last = { raw: lines[i], state: m[1].toLowerCase(), text: m[2], answered };
      break;
    }
  }
  // Nothing recognisable at all: show the worker its own words anyway.
  if (!last) last = { raw: lines[lines.length - 1], state: null, text: lines[lines.length - 1] };
  return { lines, last, at };
}

// ------------------------------------------------------- who is allowed to do this

// Four refusals before anything is created. A label is never authority: we act
// only on ids herdr itself gave us, for a pane that is provably our own.
async function launcherIdentity() {
  if (process.env.HERDR_ENV !== '1') {
    die('teammate: this must run inside a herdr pane (HERDR_ENV is not 1).');
  }
  const pane = process.env.HERDR_PANE_ID;
  const tab = process.env.HERDR_TAB_ID;
  const ws = process.env.HERDR_WORKSPACE_ID;
  if (!pane || !tab || !ws) {
    die('teammate: herdr did not tell this pane who it is (HERDR_PANE_ID / _TAB_ID / _WORKSPACE_ID missing).');
  }
  let info;
  try { info = (await herdr(['pane', 'get', pane])).result?.pane; }
  catch (e) { die(`teammate: herdr does not recognise this pane ${pane} (${e.message}).`); }
  if (!info || info.tab_id !== tab || info.workspace_id !== ws) {
    die(`teammate: this pane's ids disagree with herdr (env ${pane}/${tab}/${ws}, herdr ${info?.pane_id}/${info?.tab_id}/${info?.workspace_id}).`);
  }
  const mine = (await allCards()).find((c) => c.pane_id === pane && c.state !== 'closed');
  if (mine) {
    die(`teammate: this pane is itself worker ${mine.id}. Workers do not hire workers.`);
  }
  return { pane, tab, ws, cwd: info.cwd };
}

// --------------------------------------------------------------------- launch

function briefText({ id, task, cwd, status, captainPane, tree }) {
  const psPath = status.replaceAll("'", "''");
  const treePart = tree ? `
## Your folder is a temporary copy

You are in a pooled copy of the repository, on branch \`${tree.branch}\`
created from the captain's current commit. **Commit your work to this branch
as you go — only commits survive.** After the tab is closed the folder is
wiped and returned to the pool; anything uncommitted is gone. Do not push
and do not switch branches unless the task says to.
` : '';
  return `# Task ${id}

${task}

Working directory: \`${cwd}\`
${treePart}
## Report as you go

A captain agent in another tab of this window watches one file and nothing
else:

    ${status}

Append one short line to it whenever your situation changes:

    echo "working: rewriting the parser" >> "${status.replaceAll('\\', '/')}"

PowerShell form, if you are in one:

    Add-Content -LiteralPath '${psPath}' -Value 'working: rewriting the parser'

The first word before the colon is the only part the captain parses:

| word | meaning |
|---|---|
| \`working\` | going fine, nothing needed from anyone |
| \`needs-decision\` | you need the captain to choose something |
| \`blocked\` | you cannot continue (no access, tool broken) |
| \`paused\` | you stopped on purpose and will resume |
| \`done\` | finished, and the work has landed |
| \`failed\` | cannot be finished, and you say why |

Write \`working: ...\` as your very first action, then a line at every real
change of situation, then exactly one \`done: ...\` or \`failed: ...\` line at
the end. Silence longer than a few minutes reads as "something went wrong" and
wakes the captain, so a line costs nothing and saves a false alarm.

After the last line: stop and stay. Do not exit, do not close this tab. The
captain reads your work, may send more instructions into this same session, and
closes the tab itself.

## Rules

- Stay inside the working directory above.
- Do not touch other herdr tabs, panes or windows, and never run
  \`herdr tab close\` or \`herdr workspace close\`.
- If a decision is the captain's to make, write \`needs-decision: <question>\`
  and wait instead of guessing.
- The captain's pane is \`${captainPane}\` — it is not yours to write into.
`;
}

async function cmdNew(argv) {
  const flags = parseFlags(argv, { cwd: null, model: null, label: null, file: null, tree: false });
  const task = flags._.join(' ').trim();
  const fromFile = flags.file ? await readFile(path.resolve(flags.file), 'utf8') : '';
  const body = (task ? task + (fromFile ? '\n\n' + fromFile : '') : fromFile).trim();
  if (!body) die('teammate new "<what the worker must do>" [--tree] [--cwd <path>] [--file <brief.md>] [--model <name>]');

  const me = await launcherIdentity();
  const repo = path.resolve(flags.cwd ?? process.cwd());
  await mkdir(CREW_DIR, { recursive: true });

  // Claim the id atomically ('wx' fails on an existing file) — two hires in
  // the same second must never share a card.
  let id = `tm-${stamp()}`;
  for (;;) {
    try { await writeFile(cardFile(id), '{}', { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      id = `tm-${stamp()}-${Math.random().toString(36).slice(2, 4)}`;
    }
  }

  // The record is written before the tab exists, so a crash mid-launch leaves a
  // traceable card rather than an orphan tab nobody owns.
  const card = {
    id,
    task: body.split('\n')[0].slice(0, 200),
    state: 'creating',
    cwd: repo,
    created_at: new Date().toISOString(),
    captain: { pane_id: me.pane, tab_id: me.tab, workspace_id: me.ws },
    workspace_id: me.ws,
    tab_id: null,
    pane_id: null,
    label: flags.label ?? id,
    model: flags.model ?? null,
    brief: briefFile(id),
    status: statusFile(id),
  };
  await writeJsonAtomic(cardFile(id), card);

  // --tree: the worker gets its own pooled copy of the repository (treehouse)
  // on a fresh branch, so parallel workers never trip over each other's files.
  if (flags.tree) {
    let lease;
    try {
      lease = JSON.parse(await execCandidates(TREEHOUSE_CANDIDATES,
        ['get', '--lease', '--json', '--lease-holder', id], { cwd: repo }));
    } catch (e) {
      card.state = 'failed-to-create';
      card.error = `treehouse would not lease a worktree: ${e.message}`;
      await writeJsonAtomic(cardFile(id), card);
      die(`teammate: ${card.error}\nIs treehouse installed and is ${repo} a git repository?`);
    }
    try {
      const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
      const branch = id; // the branch simply carries the worker's name
      await git(lease.path, 'switch', '-c', branch, base);
      card.repo = repo;
      card.cwd = lease.path;
      card.tree = { path: lease.path, lease_id: lease.lease_id, branch, base };
      await writeJsonAtomic(cardFile(id), card);
    } catch (e) {
      // Hand the copy back before giving up: a lease nobody uses starves the pool.
      await execCandidates(TREEHOUSE_CANDIDATES,
        ['return', lease.path, '--force', '--if-lease-id', lease.lease_id], { cwd: repo }).catch(() => {});
      card.state = 'failed-to-create';
      card.error = `could not put the worktree on a task branch: ${e.message}`;
      await writeJsonAtomic(cardFile(id), card);
      die(`teammate: ${card.error}`);
    }
  }

  const cwd = card.cwd;
  await writeFile(briefFile(id), briefText({ id, task: body, cwd, status: statusFile(id), captainPane: me.pane, tree: card.tree }));
  await writeFile(statusFile(id), '');

  const env = [
    `TEAMMATE_ID=${id}`,
    `TEAMMATE_STATUS=${statusFile(id)}`,
    `TEAMMATE_BRIEF=${briefFile(id)}`,
    ...INHERIT_ENV.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`),
  ];
  card.env_passed = env.map((e) => e.split('=')[0]);

  let created;
  try {
    created = await herdr(['tab', 'create',
      '--workspace', me.ws,
      '--cwd', cwd,
      '--label', card.label,
      '--no-focus',
      ...env.flatMap((e) => ['--env', e]),
    ]);
  } catch (e) {
    if (card.tree) {
      await execCandidates(TREEHOUSE_CANDIDATES,
        ['return', card.tree.path, '--force', '--if-lease-id', card.tree.lease_id], { cwd: card.repo }).catch(() => {});
    }
    card.state = 'failed-to-create';
    card.error = e.message;
    await writeJsonAtomic(cardFile(id), card);
    die(`teammate: herdr refused to create the tab (${e.message}). Card ${id} kept as a record.`);
  }

  card.tab_id = created.result?.tab?.tab_id ?? null;
  card.pane_id = created.result?.root_pane?.pane_id ?? null;
  if (!card.pane_id || !card.tab_id) {
    // A tab we cannot name is a tab we cannot manage — hand the copy back too.
    if (card.tree) {
      await execCandidates(TREEHOUSE_CANDIDATES,
        ['return', card.tree.path, '--force', '--if-lease-id', card.tree.lease_id], { cwd: card.repo }).catch(() => {});
    }
    card.state = 'failed-to-create';
    card.error = 'herdr created a tab but did not name it';
    await writeJsonAtomic(cardFile(id), card);
    die(`teammate: herdr created a tab but did not name it — the tab may need closing by hand. Card ${id} kept as a record.`);
  }
  card.state = 'launching';
  await writeJsonAtomic(cardFile(id), card);

  // Wait for the shell to be up before typing into it: text sent to a pane that
  // has no prompt yet is simply lost.
  await waitForPrompt(card.pane_id);

  const model = flags.model ? ` --model ${flags.model}` : '';
  // A literal path, not $env:X — the launch line then works whatever shell the
  // new tab happens to start with.
  const launch = `claude --dangerously-skip-permissions${model} "Read ${briefFile(id).replaceAll('\\', '/')} and carry out the task in it, fully."`;
  await herdrText(['pane', 'run', card.pane_id, launch]);

  const settled = await settleLaunch(card.pane_id);
  if (settled.problem) {
    card.state = 'launch-problem';
    card.error = settled.problem;
    await writeJsonAtomic(cardFile(id), card);
    die(`teammate: ${id} started but did not get going — ${settled.problem}.\n` +
        `  look:  node bin\\teammate.mjs log ${id}\n` +
        `  drop:  node bin\\teammate.mjs close ${id} --force`);
  }

  card.state = 'running';
  card.launched_at = new Date().toISOString();
  await writeJsonAtomic(cardFile(id), card);

  console.log(`${id}  tab ${card.tab_id}  pane ${card.pane_id}`);
  console.log(`  cwd    ${cwd}`);
  if (card.tree) console.log(`  branch ${card.tree.branch}  (pooled worktree, lease ${card.tree.lease_id.slice(0, 8)})`);
  console.log(`  brief  ${briefFile(id)}`);
  console.log(`  status ${statusFile(id)}`);
  console.log(`\nNext: node bin\\teammate.mjs check`);
}

async function waitForPrompt(paneId, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const text = await herdrText(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '5']);
      if (text.trim()) return true;
    } catch { /* pane not ready yet */ }
    await sleep(400);
  }
  return false;
}

// Between typing the launch line and the worker actually working there are two
// things that silently swallow a task: the "do you trust this folder" question
// on a directory Claude has not seen before, and an unauthenticated account.
// The first we answer (the captain chose the folder); the second we report,
// because only a human can fix it.
async function settleLaunch(paneId, ms = 60000) {
  const until = Date.now() + ms;
  let trusted = false;
  while (Date.now() < until) {
    await sleep(1000);
    let screen = '';
    try { screen = await herdrText(['pane', 'read', paneId, '--source', 'recent', '--lines', '40']); }
    catch (e) { if (e.code === 'pane_not_found') return { problem: 'its pane disappeared' }; continue; }

    if (/Not logged in|Run \/login|Invalid API key|authentication_error/i.test(screen)) {
      return { problem: 'that Claude is not logged in (the tab did not inherit an account)' };
    }
    if (!trusted && /trust (this|the) folder|Is this a project you created or one you trust/i.test(screen)) {
      await herdrText(['pane', 'send-keys', paneId, 'Enter']); // option 1, "yes, I trust it", is preselected
      trusted = true;
      continue;
    }
    try {
      const agent = (await herdr(['agent', 'get', paneId])).result?.agent;
      if (agent?.agent === 'claude' && agent.agent_status === 'working') return { ok: true };
    } catch { /* not detected as an agent yet */ }
  }
  return { problem: 'it never started working (no agent turn began within a minute)' };
}

// ---------------------------------------------------------------- observation

// Three independent channels, folded into one verdict. The rule that keeps this
// honest: "working" is evidence the worker is alive, but "idle" is never
// evidence that it finished. Unknown never becomes fine on its own.
async function observe(card) {
  const report = await readReport(card.id);
  let agent = null;
  let gone = false;
  if (card.pane_id) {
    try { agent = (await herdr(['agent', 'get', card.pane_id])).result?.agent ?? null; }
    catch (e) {
      if (e.code === 'pane_not_found') gone = true;
      else {
        try { agent = (await herdr(['pane', 'get', card.pane_id])).result?.pane ?? null; }
        catch (e2) { if (e2.code === 'pane_not_found') gone = true; }
      }
    }
  }
  const quietFor = report.at ? Date.now() - report.at : Date.now() - Date.parse(card.launched_at ?? card.created_at);
  const said = report.last?.state ?? null;

  let verdict = 'quiet';
  let why = '';
  if (card.state === 'closed') { verdict = 'closed'; why = 'tab already closed'; }
  else if (card.state === 'failed-to-create' || card.state === 'launch-problem') {
    verdict = 'attention'; why = card.error ?? 'never got going';
  }
  else if (gone) { verdict = 'attention'; why = 'the pane is gone — nobody closed it through teammate'; }
  else if (said && TERMINAL_STATES.has(said)) { verdict = 'attention'; why = `worker says ${said}`; }
  else if (said && CALLING_STATES.has(said) && !report.last.answered) { verdict = 'attention'; why = `worker says ${said}`; }
  else if (agent?.agent_status === 'working') { verdict = 'quiet'; why = 'busy'; }
  else if (said === 'paused') { verdict = 'quiet'; why = 'paused on purpose'; }
  else if (quietFor > QUIET_LIMIT_MS) {
    verdict = 'attention';
    why = agent ? `no sign of life for ${ago(quietFor)} (herdr says ${agent.agent_status})` : `no sign of life for ${ago(quietFor)}`;
  } else { verdict = 'quiet'; why = agent ? `herdr says ${agent.agent_status}` : 'starting up'; }

  return {
    id: card.id, card, verdict, why, gone,
    agent_status: agent?.agent_status ?? (gone ? 'gone' : 'unknown'),
    said, line: report.last?.raw ?? null, quiet_for_ms: quietFor,
  };
}

async function cmdList(argv) {
  const flags = parseFlags(argv, { all: false, json: false });
  const cards = (await allCards()).filter((c) => flags.all || c.state !== 'closed');
  if (!cards.length) return console.log('no workers');
  const seen = await Promise.all(cards.map(observe));
  if (flags.json) return console.log(JSON.stringify(seen.map(({ card, ...r }) => r), null, 2));
  for (const s of seen) {
    const mark = s.verdict === 'attention' ? '!' : s.verdict === 'closed' ? '·' : ' ';
    const task = s.card.task.length > 64 ? s.card.task.slice(0, 63) + '…' : s.card.task;
    console.log(`${mark} ${s.id}  ${(s.agent_status + '        ').slice(0, 8)} ${ago(s.quiet_for_ms).padStart(5)}  ${task}`);
    if (s.line) console.log(`      ${s.line}`);
    console.log(`      ${s.card.pane_id ?? '-'}  ${s.card.cwd}`);
  }
}

// One pass, cheap, no loop. Exit code 1 means "captain, look at something".
async function cmdCheck(argv) {
  const flags = parseFlags(argv, { json: false });
  const cards = (await allCards()).filter((c) => c.state !== 'closed');
  const seen = await Promise.all(cards.map(observe));
  const hot = seen.filter((s) => s.verdict === 'attention');
  if (flags.json) {
    console.log(JSON.stringify({ workers: seen.length, attention: hot.map(({ card, ...r }) => r) }, null, 2));
  } else if (!cards.length) {
    console.log('no workers');
  } else if (!hot.length) {
    console.log(`${seen.length} worker(s), all quiet`);
    for (const s of seen) console.log(`  ${s.id}  ${s.why}${s.line ? `  — ${s.line}` : ''}`);
  } else {
    for (const s of hot) {
      console.log(`! ${s.id}  ${s.why}`);
      if (s.line) console.log(`    said: ${s.line}`);
      console.log(`    pane ${s.card.pane_id}  cwd ${s.card.cwd}`);
      console.log(`    read: node bin\\teammate.mjs log ${s.id}`);
    }
  }
  process.exitCode = hot.length ? 1 : 0;
}

// The same pass, on a slow loop, as a thing to leave running in the background:
// it prints nothing until a worker wants something, then exits 1. The captain
// spends no tokens sitting in it — only when it returns.
async function cmdWait(argv) {
  const flags = parseFlags(argv, { every: '15', timeout: '0' });
  const every = Math.max(3, Number(flags.every) || 15) * 1000;
  const until = Number(flags.timeout) > 0 ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
  for (;;) {
    const cards = (await allCards()).filter((c) => c.state !== 'closed');
    if (!cards.length) { console.log('no workers'); process.exitCode = 0; return; }
    const hot = (await Promise.all(cards.map(observe))).filter((s) => s.verdict === 'attention');
    if (hot.length) {
      for (const s of hot) {
        console.log(`! ${s.id}  ${s.why}`);
        if (s.line) console.log(`    said: ${s.line}`);
      }
      process.exitCode = 1;
      return;
    }
    const left = until - Date.now();
    if (left <= 0) { console.log('nothing wanted the captain before the timeout'); process.exitCode = 3; return; }
    await sleep(Math.min(every, left)); // the last sleep is the remainder, then one final pass at the deadline
  }
}

async function cmdLog(argv) {
  const flags = parseFlags(argv, { lines: '60', tail: false });
  const id = flags._[0];
  const card = id && await readCard(id);
  if (!card) die('teammate log <id> [--lines N]');
  const report = await readReport(id);
  console.log(`# ${id} — ${card.task}`);
  console.log(report.lines.length ? report.lines.join('\n') : '(the worker has not written a single line yet)');
  if (card.pane_id && !flags.tail) {
    try {
      const text = await herdrText(['pane', 'read', card.pane_id, '--source', 'recent-unwrapped', '--lines', String(Number(flags.lines) || 60)]);
      if (text.trim()) console.log(`\n--- its screen, last ${flags.lines} lines ---\n${text}`);
    } catch (e) { console.log(`\n(could not read the pane: ${e.message})`); }
  }
}

// ------------------------------------------------------------------- talk back

async function cmdSay(argv) {
  const flags = parseFlags(argv, { steal: false });
  const id = flags._.shift();
  const text = flags._.join(' ').trim();
  const card = id && await readCard(id);
  if (!card || !text) die('teammate say <id> "<what to tell the worker>" [--steal]');
  if (card.state === 'closed') die(`teammate: ${id} is closed.`);
  if (!card.pane_id) die(`teammate: ${id} has no pane recorded.`);
  await assertCallerMay(card, flags);
  if ((await assertStillOurs(card)).gone) die(`teammate: ${id}'s pane is gone — there is nobody to tell.`);
  await herdr(['agent', 'prompt', card.pane_id, text]);
  await appendFile(statusFile(id), `captain: ${text.replace(/\s+/g, ' ').slice(0, 200)}\n`);
  console.log(`sent to ${id} (${card.pane_id})`);
}

// say and close are the captain's verbs. A pane that is itself an open worker
// may use neither, and a herdr pane other than the hiring captain must take
// the worker over explicitly. A plain terminal outside herdr is the human.
async function assertCallerMay(card, flags) {
  const invoker = process.env.HERDR_PANE_ID ?? null;
  if (!invoker) return;
  const asWorker = (await allCards()).find((c) => c.pane_id === invoker && c.state !== 'closed');
  if (asWorker) die(`teammate: this pane is itself worker ${asWorker.id}. Workers do not steer or fire workers.`);
  if (card.captain?.pane_id && invoker !== card.captain.pane_id && !flags.steal) {
    die(`teammate: ${card.id} was hired from pane ${card.captain.pane_id}, not this one (${invoker}).\n` +
        `Add --steal to take the worker over.`);
  }
}

// ---------------------------------------------------------------- closing down

// A pooled worktree is wiped on return — refuse while anything uncommitted is
// still sitting in it, even after a done line. And fail closed: a git error is
// not a clean tree, it is "cannot tell", and cannot-tell never wipes anything.
async function assertTreeClean(card, flags, tail) {
  if (!card.tree || flags.force) return;
  let dirty;
  try { dirty = (await git(card.tree.path, 'status', '--porcelain')).trim(); }
  catch (e) {
    die(`teammate: cannot check ${card.id}'s worktree for uncommitted changes (${e.message}).\n` +
        `Refusing to close; --force to discard whatever is there.`);
  }
  if (dirty) {
    die(`teammate: ${card.id}'s worktree has uncommitted changes:\n` +
        dirty.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n') + `\n${tail}`);
  }
}

// The pane we recorded must still be the same pane: same window, same tab, same
// working directory. If any of that drifted, something else lives there now and
// we do not touch it.
async function assertStillOurs(card) {
  if (!card.pane_id) return { gone: true }; // never got a pane — nothing to protect
  let pane;
  try { pane = (await herdr(['pane', 'get', card.pane_id])).result?.pane; }
  catch (e) {
    if (e.code === 'pane_not_found') return { gone: true };
    die(`teammate: cannot verify pane ${card.pane_id} (${e.message}). Refusing to act.`);
  }
  if (pane.tab_id !== card.tab_id || pane.workspace_id !== card.workspace_id) {
    die(`teammate: pane ${card.pane_id} now lives in ${pane.workspace_id}/${pane.tab_id}, not ${card.workspace_id}/${card.tab_id}. Refusing to act.`);
  }
  if (normPath(pane.cwd) !== normPath(card.cwd)) {
    die(`teammate: pane ${card.pane_id} sits in ${pane.cwd}, not in ${card.cwd}. Refusing to act.`);
  }
  return { gone: false, pane };
}

async function cmdClose(argv) {
  const flags = parseFlags(argv, { force: false, steal: false });
  const id = flags._[0];
  const card = id && await readCard(id);
  if (!card) die('teammate close <id> [--force] [--steal]');
  if (card.state === 'closed') return console.log(`${id} is already closed`);
  await assertCallerMay(card, flags);

  // Never close the hand that runs us.
  if (card.pane_id === process.env.HERDR_PANE_ID || card.tab_id === process.env.HERDR_TAB_ID) {
    die(`teammate: ${id} points at this very pane. Refusing.`);
  }

  const report = await readReport(id);
  const said = report.last?.state ?? null;
  if (!flags.force && !TERMINAL_STATES.has(said ?? '')) {
    die(`teammate: ${id} never said done or failed (last line: ${report.last?.raw ?? 'none'}).\n` +
        `The work may be unfinished and unsaved. Read it first:\n` +
        `  node bin\\teammate.mjs log ${id}\n` +
        `then close with --force if you are sure.`);
  }
  if (!flags.force && report.last?.answered) {
    die(`teammate: ${id} said "${report.last.raw}", but the captain replied after that —\n` +
        `the worker may be mid-follow-up. Wait for its next line, or --force.`);
  }

  await assertTreeClean(card, flags, 'Closing would wipe them. Tell the worker to commit (teammate say), or --force to discard.');

  const check = await assertStillOurs(card);
  if (!check.gone) {
    const tabs = (await herdr(['tab', 'list', '--workspace', card.workspace_id])).result?.tabs ?? [];
    if (tabs.length <= 1) {
      die(`teammate: ${card.tab_id} is the only tab left in ${card.workspace_id}. Closing it would close the window. Refusing.`);
    }
    await herdr(['tab', 'close', card.tab_id]);
  }

  // Erase the record only once herdr itself says the pane is not there. Any
  // other answer — including a confusing one — leaves the card intact.
  let confirmed = !card.pane_id; // a card that never got a pane has nothing to wait for
  for (let i = 0; i < 10 && !confirmed; i++) {
    await sleep(300);
    try { await herdr(['pane', 'get', card.pane_id]); }
    catch (e) { if (e.code === 'pane_not_found') confirmed = true; }
  }
  if (!confirmed) {
    die(`teammate: asked herdr to close ${card.tab_id}, but pane ${card.pane_id} is still there. Card kept, nothing erased.`);
  }

  // The tab is gone; give the copy back and note what landed on the branch.
  // If the return fails the card stays open, and running close again retries
  // just this part — the gone pane is skipped on the next pass.
  if (card.tree) {
    card.tab_closed_at = new Date().toISOString();
    card.landed_commits = Number((await git(card.repo, 'rev-list', '--count',
      `${card.tree.base}..${card.tree.branch}`).catch(() => 'NaN')).trim());
    await writeJsonAtomic(cardFile(id), card);
    // The worker is provably dead now, so this second look is race-free: edits
    // it made after the first check would otherwise be wiped unseen.
    await assertTreeClean(card, flags,
      `The tab is closed but the files are still in ${card.tree.path} — salvage them, then close again with --force.`);
    try {
      await execCandidates(TREEHOUSE_CANDIDATES,
        ['return', card.tree.path, '--force', '--if-lease-id', card.tree.lease_id], { cwd: card.repo });
    } catch (e) {
      die(`teammate: tab closed, but the worktree was not returned to the pool (${e.message}).\n` +
          `Run close again to retry. Card kept.`);
    }
  }

  card.state = 'closed';
  card.closed_at = new Date().toISOString();
  card.closed_saying = report.last?.raw ?? null;
  await writeJsonAtomic(cardFile(id), card);
  console.log(`${id} closed (${card.closed_saying ?? 'no final line'})`);
  if (card.tree) {
    if (card.landed_commits > 0) {
      console.log(`${card.landed_commits} commit(s) landed on ${card.tree.branch} — pick them up with:`);
      console.log(`  git merge ${card.tree.branch}   (then git branch -d ${card.tree.branch})`);
    } else {
      console.log(`warning: branch ${card.tree.branch} has no new commits — nothing landed.`);
    }
  }
}

// -------------------------------------------------------------------- plumbing

function parseFlags(argv, defaults) {
  const out = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key in defaults && typeof defaults[key] === 'boolean') out[key] = true;
      else if (key in defaults) out[key] = argv[++i];
      else die(`teammate: unknown option --${key}`);
    } else out._.push(a);
  }
  return out;
}

const USAGE = `teammate — a worker agent in its own herdr tab

  new "<task>" [--tree] [--cwd <path>] [--file <brief.md>] [--model <name>] [--label <text>]
                          open a tab in this window and start a worker on it;
                          --tree gives it its own pooled worktree (treehouse)
                          on a branch named after it — only commits survive
  list [--all] [--json]   every worker, its state and its last line
  check [--json]          one pass; exit code 1 if something wants the captain
  wait [--every S] [--timeout S]
                          the same pass on a loop; returns when someone wants you
  log <id> [--lines N]    the worker's own lines, plus its screen
  say <id> "<text>"       send more instructions into the same session
  close <id> [--force]    close exactly that tab, once the work has landed

say and close belong to the captain that hired: a worker pane may use neither,
and a different herdr pane must add --steal to take a worker over.

State lives in state/teammates/ — one card, one brief, one status file each.`;

const [cmd, ...rest] = process.argv.slice(2);
const commands = { new: cmdNew, list: cmdList, check: cmdCheck, wait: cmdWait, log: cmdLog, say: cmdSay, close: cmdClose };
if (!cmd || cmd === '--help' || cmd === '-h' || !commands[cmd]) {
  console.log(USAGE);
  process.exit(cmd && !commands[cmd] ? 2 : 0);
}
commands[cmd](rest).catch((e) => { console.error(`teammate: ${e.message}`); process.exit(2); });

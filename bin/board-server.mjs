// sheepdog — a small local server for the herdr board.
// Reads live state from herdr, mixes in priorities from state/projects.json,
// and accumulates "when we first saw this state" in state/seen.json (keyed by
// folder, not by pane id: panes get recreated, folders live on).
// Run: node bin\board-server.mjs [--open]  (or bin\board.cmd)

import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 4877;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = path.join(ROOT, 'state');
const PROJECTS_FILE = path.join(STATE_DIR, 'projects.json');
const SEEN_FILE = path.join(STATE_DIR, 'seen.json');
const PAGE_FILE = path.join(ROOT, 'bin', 'board.html');
const SEEN_KEEP_MS = 7 * 24 * 3600 * 1000; // keep entries of vanished folders for a week

const HERDR_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Herdr', 'bin', 'herdr.exe'),
  'herdr',
];

const KNOWN_STATUSES = new Set(['blocked', 'done', 'working', 'idle', 'unknown']);
// Mine columns answer "what do I do with this", not "what did herdr say" —
// the herdr state stays on the card as a lamp. Assignment logic lives in the
// page (roleColumnOf); the server only stores the manual fields.
const COLUMNS = [
  { key: 'decisions', title: 'Decisions — on you' },
  { key: 'focus',     title: 'Focus' },
  { key: 'running',   title: 'Running' },
  { key: 'tools',     title: 'Tools' },
  { key: 'parked',    title: 'Parked' },
];

function herdr(args) {
  return new Promise((resolve, reject) => {
    const tryOne = (i) => {
      execFile(HERDR_CANDIDATES[i], args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT' && i + 1 < HERDR_CANDIDATES.length) return tryOne(i + 1);
          const detail = String(stderr || '').trim() || err.message;
          return reject(new Error(`herdr ${args[0]} ${args[1] ?? ''}: ${detail}`));
        }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`herdr ${args.join(' ')}: response is not JSON`)); }
      });
    };
    tryOne(0);
  });
}

// Paths from herdr arrive in mixed shapes: \\?\ prefixes, forward slashes.
function normPath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  s = s.replaceAll('/', '\\').toLowerCase();
  while (s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

// --- Session recap: the session's last words, straight from its journal.
// Claude Code's native /recap is interactive-only (no CLI, and 1960 recent
// journals carry no recap record on disk — checked 2026-08-20), so the board
// shows the closest true thing: the last text the agent said. The journal
// format is internal to Claude Code; any parse failure just means no line.
const HOME = process.env.USERPROFILE ?? '';
const RECAP_ROOTS_GLOB = path.join(HOME, '.claude-accounts');
const sessionPathCache = new Map(); // sid -> { file: string|null, at: ms }
const recapCache = new Map(); // file -> { mtime, text }

async function findSessionFile(sid, cwd) {
  const hit = sessionPathCache.get(sid);
  if (hit && (hit.file || Date.now() - hit.at < 300_000)) return hit.file;
  // Journals live under <root>/projects/<escaped cwd>/<session id>.jsonl,
  // where the escape turns ':', '\' and '.' into '-'.
  const escaped = String(cwd).replace(/[:\\/.]/g, '-');
  const roots = [path.join(HOME, '.claude')];
  try {
    const { readdir } = await import('node:fs/promises');
    for (const acc of await readdir(RECAP_ROOTS_GLOB)) roots.push(path.join(RECAP_ROOTS_GLOB, acc));
  } catch {}
  let file = null;
  for (const root of roots) {
    const candidate = path.join(root, 'projects', escaped, sid + '.jsonl');
    if (await stat(candidate).then(() => true, () => false)) { file = candidate; break; }
  }
  sessionPathCache.set(sid, { file, at: Date.now() });
  return file;
}

// Last assistant text in the journal tail. Re-parsed only when the file grew.
async function lastAssistantText(file) {
  const s = await stat(file).catch(() => null);
  if (!s) return null;
  const cached = recapCache.get(file);
  if (cached && cached.mtime === s.mtimeMs) return cached.text;
  let text = null;
  try {
    const lines = await readJournalTail(file, s.size);
    for (let i = lines.length - 1; i >= 0 && !text; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const o = JSON.parse(lines[i]);
        if (o.type !== 'assistant' || o.isSidechain) continue;
        const t = (o.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (t && t.length >= 8) text = t.replace(/\s+/g, ' ').slice(0, 220);
      } catch { /* partial or foreign line */ }
    }
  } catch { /* unreadable journal = no recap */ }
  recapCache.set(file, { mtime: s.mtimeMs, text });
  return text;
}

// --- Local-model recap (operator's call, 2026-08-20): a small local model
// (LM Studio, OpenAI-compatible API) writes the one-line recap of what each
// live session is doing, from the journal tail. A serial background queue
// with a per-file cooldown — the 3-second /data poll never waits for the
// GPU; until a summary exists the card falls back to the last-words line,
// and if the local server is down nothing breaks.
// Target (operator's call, 2026-08-21, evening): LM Studio again, by name - its
// just-in-time loading brings qwen3-4b into VRAM on the first request and drops it
// after an idle hour. The big 27B on :8099 is a night-only thing for the article
// conveyor; the board never touches it. Any OpenAI-compatible server still works via
// SHEEPDOG_RECAP_URL / SHEEPDOG_RECAP_MODEL / SHEEPDOG_RECAP_KEY (a bearer key is sent
// only when one is configured). Thinking is switched off per request - with a
// 120-token budget a thinking model would spend it all before answering; servers
// without that switch ignore the flag.
const RECAP_API = process.env.SHEEPDOG_RECAP_URL || 'http://127.0.0.1:1234/v1/chat/completions';
const RECAP_MODEL = process.env.SHEEPDOG_RECAP_MODEL || 'qwen3-4b-instruct-2507';
const RECAP_KEY = process.env.SHEEPDOG_RECAP_KEY ?? '';
const RECAP_COOLDOWN_MS = 120_000;
const aiRecapCache = new Map(); // file -> { mtime, at, text, waits }
const recapQueue = [];
const queuedRecapFiles = new Set();
let recapPumpBusy = false;

// Verdicts survive a server restart on disk. Without this every restart wiped
// the cache and the whole fleet got re-judged at once from scratch — cards
// visibly jumped between columns until the queue caught up (operator,
// 2026-08-21: "every time I look, everything is wrong").
const RECAPS_FILE = path.join(STATE_DIR, 'recaps.json');
let recapSaveTimer = null;
function persistRecaps() {
  if (recapSaveTimer) return;
  recapSaveTimer = setTimeout(() => {
    recapSaveTimer = null;
    writeJsonAtomic(RECAPS_FILE, Object.fromEntries(aiRecapCache)).catch(() => {});
  }, 2000);
}
async function loadRecaps() {
  for (const [file, v] of Object.entries(await readJsonSoft(RECAPS_FILE, {}))) {
    // at: 0 -> the cooldown never blocks a re-check, but an unchanged journal
    // (same mtime) keeps its stored verdict without asking the model again.
    if (v && typeof v.text === 'string') aiRecapCache.set(file, { mtime: v.mtime ?? 0, at: 0, text: v.text, waits: WAITS.has(v.waits) ? v.waits : 'none' });
  }
}

// The verdict is a three-way classification, not a boolean. The old binary
// "blocked" flag buried the load-bearing distinction (waits on a SYSTEM vs
// waits on the OPERATOR) inside a subtle definition, and the small day model
// regularly contradicted its own recap text ("ожидает CI" with blocked:false
// - the misplacement of 2026-08-21). Explicit options plus few-shot examples
// fixed every column-relevant case on a 14-session live calibration set; the
// JSON schema below makes a malformed verdict impossible to emit.
const WAITS = new Set(['user', 'system', 'none']);
const RECAP_PROMPT = `Below is the tail of a working agent session journal (AGENT:/USER: messages, newest last).
Reply with JSON: {"recap": "<one line, max 120 chars, in the same language the session speaks: what the session is doing right now>", "waits": "<user|system|none>"}.

"waits" answers: judging by the LAST message, who must act before this session can move?
- "system" = the session is stuck mid-task until an external SYSTEM finishes: a CI run / pipeline, a build or deploy queue, another machine, a rate limit, a long external job. The human operator has nothing to do right now.
- "user" = the session's last word asks the human operator a question, offers him options, or hands him results for review / approval / acceptance - it cannot move without HIS word.
- "none" = the session is actively working right now (its last word announces what it does next), or the task is fully closed and nothing is pending from anyone.
If the last word both asks the operator and mentions an external wait, answer "user".
A bare completion report ("done, pushed, all clean") with no question is "none", not "user".

Examples:
- AGENT: Жду зелёного CI на 3f52a7fc в очереди vps1, после этого мержу PR. -> {"recap": "Ждёт зелёного CI в очереди vps1 для мержа PR", "waits": "system"}
- AGENT: Пакет готов. Нужен твой выбор: подача с PDF, с правками или отказ? -> {"recap": "Пакет готов, ждёт выбора по подаче", "waits": "user"}
- AGENT: Отчёт готов. Публиковать с именами клиентов? Жду команды. -> {"recap": "Отчёт готов, ждёт команды на публикацию", "waits": "user"}
- AGENT: Теперь проверяю оставшиеся боты и обновлю сторожа. -> {"recap": "Проверяет боты и обновляет сторожа", "waits": "none"}
- AGENT: Всё закоммичено и запушено, дерево чистое. -> {"recap": "Работа завершена, всё запушено", "waits": "none"}
- AGENT: API rate limit until 16:00, resuming the sweep after it lifts. -> {"recap": "Paused by API rate limit, resumes at 16:00", "waits": "system"}

The journal tail:

`;
const RECAP_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'verdict',
    schema: {
      type: 'object',
      properties: {
        recap: { type: 'string' },
        waits: { type: 'string', enum: ['user', 'system', 'none'] },
      },
      required: ['recap', 'waits'],
      additionalProperties: false,
    },
  },
};

async function readJournalTail(file, size) {
  const len = Math.min(262_144, size);
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(len);
  try { await fh.read(buf, 0, len, size - len); } finally { await fh.close(); }
  return buf.toString('utf8').split('\n');
}

async function makeAiRecap(file) {
  const s = await stat(file).catch(() => null);
  if (!s) return;
  const cached = aiRecapCache.get(file);
  if (cached && (cached.mtime === s.mtimeMs || Date.now() - cached.at < RECAP_COOLDOWN_MS)) return;
  const msgs = [];
  for (const line of await readJournalTail(file, s.size)) {
    try {
      const o = JSON.parse(line);
      if (o.isSidechain) continue;
      if (o.type === 'assistant') {
        const t = (o.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (t.length > 20) msgs.push('AGENT: ' + t);
      } else if (o.type === 'user' && typeof o.message?.content === 'string') {
        const t = o.message.content.trim();
        if (t && !t.startsWith('<')) msgs.push('USER: ' + t); // markup lines are harness noise
      }
    } catch { /* partial or foreign line */ }
  }
  const ctx = msgs.slice(-12).join('\n---\n').slice(-6000);
  if (!ctx) return;
  // Any miss (server restarting between profiles, 401, timeout, empty answer) still stamps
  // the cache: otherwise the 3-second /data poll re-queues the same file forever.
  const miss = () => aiRecapCache.set(file, { mtime: 0, at: Date.now(), text: cached?.text ?? '', waits: cached?.waits ?? 'none' });
  let res;
  try {
    res = await fetch(RECAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(RECAP_KEY ? { Authorization: `Bearer ${RECAP_KEY}` } : {}) },
    body: JSON.stringify({
      ...(RECAP_MODEL ? { model: RECAP_MODEL } : {}),
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: RECAP_PROMPT + ctx }],
      response_format: RECAP_SCHEMA,
      temperature: 0, // deterministic: an unchanged journal must keep its verdict
      max_tokens: 160,
    }),
    signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`recap api ${res.status}`);
  } catch (e) { miss(); throw e; }
  const j = await res.json();
  const raw = String(j.choices?.[0]?.message?.content ?? '').replace(/^```(json)?|```$/gm, '').trim();
  let text = '';
  let waits = cached?.waits ?? 'none'; // a malformed answer keeps the last verdict
  try {
    const parsed = JSON.parse(raw);
    text = String(parsed.recap ?? '');
    if (WAITS.has(parsed.waits)) waits = parsed.waits;
  } catch {
    text = raw; // the model ignored the shape - its words still beat nothing
  }
  text = text.replace(/\s+/g, ' ').trim().slice(0, 220);
  if (text) { aiRecapCache.set(file, { mtime: s.mtimeMs, at: Date.now(), text, waits }); persistRecaps(); }
  else miss();
}

function scheduleAiRecap(file) {
  if (queuedRecapFiles.has(file)) return;
  queuedRecapFiles.add(file);
  recapQueue.push(file);
  if (recapPumpBusy) return;
  recapPumpBusy = true;
  (async () => {
    while (recapQueue.length) {
      const next = recapQueue.shift();
      queuedRecapFiles.delete(next);
      try { await makeAiRecap(next); } catch { /* model down -> last-words fallback stands */ }
    }
    recapPumpBusy = false;
  })();
}

// A linked worktree's checked-out branch: .git file -> gitdir -> HEAD, no git
// process spawned. Returns null for detached heads and plain checkouts.
async function worktreeBranch(checkoutPath) {
  try {
    const dotGit = await readFile(path.join(checkoutPath, '.git'), 'utf8');
    const m = dotGit.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const head = await readFile(path.join(m[1], 'HEAD'), 'utf8');
    const r = head.match(/refs\/heads\/(.+?)\s*$/);
    return r ? r[1] : null;
  } catch { return null; }
}

// Queue: all state-file writes go one at a time, no races.
let queueTail = Promise.resolve();
function queued(fn) {
  const p = queueTail.then(fn, fn);
  queueTail = p.then(() => {}, () => {});
  return p;
}

// Write via temp file + rename: an interrupted write leaves no stub behind.
async function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, file);
}

// Soft read: missing file — empty object. Broken JSON — also empty, so this
// is only used where an in-memory fallback copy exists.
async function readJsonSoft(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}

// Strict read: a broken file is an error, not a silent "start from scratch".
async function readJsonStrict(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`cannot read ${path.basename(file)}: ${e.message}`);
  }
  try { return JSON.parse(text); }
  catch {
    throw new Error(`${path.basename(file)} is corrupted — refusing to write, fix the file by hand (state/ is not in git — keep your own backups)`);
  }
}

// Last successfully parsed mapping — in case the file is being edited live.
let projectsGood = null;
async function loadProjects() {
  try {
    projectsGood = await readJsonStrict(PROJECTS_FILE);
  } catch {
    // broken or half-written file: keep living on the previous copy, never overwrite it
  }
  const map = new Map();
  for (const [k, v] of Object.entries(projectsGood ?? {})) {
    if (k.startsWith('_')) continue;
    map.set(normPath(k), v);
  }
  return map;
}

// Longest matching prefix: a subfolder inherits its parent's entry.
function matchProject(projects, cwd) {
  let key = normPath(cwd);
  while (key) {
    if (projects.has(key)) return projects.get(key);
    const cut = key.lastIndexOf('\\');
    if (cut < 0) break;
    key = key.slice(0, cut);
  }
  return null;
}

// Memory is the source of truth for "when first seen"; disk is only for restarts.
let seenCache = null;
async function loadSeen() {
  if (!seenCache) seenCache = await readJsonSoft(SEEN_FILE, {});
  return seenCache;
}

// Key is "folder|state". If the folder is present in the agent list, states it
// no longer has are deleted (the state really changed). If the folder vanished
// from the list entirely (agent unrecognized for a minute), entries are left
// alone so "stuck 6 h" doesn't reset; truly old ones age out.
// Short string fingerprint — for title-age keys.
function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function updateSeen(seen, agentList, nowIso) {
  const nowMs = Date.parse(nowIso);
  const byCwd = new Map();
  for (const a of agentList) {
    const c = normPath(a.cwd);
    if (!byCwd.has(c)) byCwd.set(c, new Set());
    byCwd.get(c).add(a.agent_status);
  }
  for (const [c, statuses] of byCwd) {
    for (const st of statuses) {
      const k = `${c}|${st}`;
      if (!seen[k]) seen[k] = { since: nowIso };
      seen[k].last = nowIso;
    }
    // "~pulse" — when the folder last did any work; survives state changes
    if (statuses.has('working')) seen[`${c}|~pulse`] = { since: nowIso, last: nowIso };
    for (const k of Object.keys(seen)) {
      const suffix = k.slice(c.length + 1);
      if (k.startsWith(c + '|') && !suffix.startsWith('~') && !statuses.has(suffix)) delete seen[k];
    }
  }
  // Title age: when we first saw this exact title on this folder.
  for (const a of agentList) {
    const t = a.terminal_title_stripped || a.terminal_title || '';
    if (!t) continue;
    const k = `${normPath(a.cwd)}|~t:${strHash(t)}`;
    if (!seen[k]) seen[k] = { since: nowIso };
    seen[k].last = nowIso;
  }
  for (const k of Object.keys(seen)) {
    const last = Date.parse(seen[k].last ?? nowIso);
    if (nowMs - last > SEEN_KEEP_MS) delete seen[k];
  }
}

// Card = session (herdr pane). As many open sessions as there are cards,
// nothing is merged. One herdr call returns the whole picture.
// --- Second-machine bridge: part of the fleet may run on another computer,
// which herdr here cannot see. While the board is open, we poll that machine
// over ssh once every few minutes (read-only: list agent processes) and use
// state/remote-bridge.json to figure out whose cards those are.
// Off by default: set SHEEPDOG_REMOTE_HOST to an ssh alias to enable.
const REMOTE_HOST = process.env.SHEEPDOG_REMOTE_HOST || '';
const REMOTE_FILE = path.join(STATE_DIR, 'remote-bridge.json');
const REMOTE_STALE_MS = 300_000; // every 5 minutes, and only while the board is open
let remoteState = { checkedAt: 0, ok: false, hints: [] };
let remoteChecking = false;

function sshRemoteProcesses() {
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', REMOTE_HOST, 'pgrep -fl "codex exec" || true'],
      { timeout: 20000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function refreshRemote() {
  if (!REMOTE_HOST) return;
  if (remoteChecking || Date.now() - remoteState.checkedAt < REMOTE_STALE_MS) return;
  remoteChecking = true;
  try {
    const out = await sshRemoteProcesses();
    if (out === null) { remoteState = { checkedAt: Date.now(), ok: false, hints: [] }; return; }
    const hints = new Set();
    // Folder names that hold project checkouts on the second machine. Defaults
    // cover common layouts; override with a "_dirs" array in remote-bridge.json.
    const dirs = (await readJsonSoft(REMOTE_FILE, {}))._dirs ?? ['Developer', 'projects', 'work', 'src'];
    const rx = new RegExp('(?:' + dirs.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')/([\\w.-]+)', 'g');
    for (const m of out.matchAll(rx)) hints.add(m[1]);
    remoteState = { checkedAt: Date.now(), ok: true, hints: [...hints] };
  } finally { remoteChecking = false; }
}

// --- Lavish bridge: pending review artifacts (github.com/kunchenguid/lavish-axi).
// The operator routes decision forks through lavish-axi review pages in the
// browser; every open page belongs to a project folder (<project>/.lavish/x.html).
// While the board is open we ask the lavish CLI for its session list once a
// minute and pin each artifact to the closest matching card. If the CLI is not
// installed the feature stays off silently.
const LAVISH_STALE_MS = 60_000;
const LAVISH_CANDIDATES = [
  path.join(process.env.APPDATA ?? '', 'npm', 'lavish-axi.cmd'),
  'lavish-axi',
];
let lavishState = { checkedAt: 0, ok: false, artifacts: [] };
let lavishChecking = false;

function lavishCliOutput() {
  return new Promise((resolve) => {
    const tryOne = (i) => {
      if (i >= LAVISH_CANDIDATES.length) return resolve(null);
      const bin = LAVISH_CANDIDATES[i];
      execFile(bin, [], { timeout: 20000, windowsHide: true, shell: bin.endsWith('.cmd') }, (err, stdout) => {
        const out = String(stdout ?? '');
        if (err && !out.includes('sessions[')) return tryOne(i + 1);
        resolve(out);
      });
    };
    tryOne(0);
  });
}

// The CLI prints a "sessions[N]{file,status,url,pending_prompts}:" table with
// one JSON-quoted line per open review page. Anything unparseable is skipped.
function parseLavishSessions(out) {
  const artifacts = [];
  if (!out || !/sessions\[\d+\]/.test(out)) return artifacts;
  const lines = out.split(/\r?\n/);
  const start = lines.findIndex(l => /^sessions\[\d+\]\{/.test(l));
  if (start === -1) return artifacts;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+("(?:[^"\\]|\\.)*"),([a-z-]+),("(?:[^"\\]|\\.)*"),(\d+)\s*$/);
    if (!m) break; // end of the table
    try {
      const file = normPath(JSON.parse(m[1]));
      if (m[2] !== 'open') continue;
      const marker = '\\.lavish\\';
      const at = file.lastIndexOf(marker);
      if (at === -1) continue;
      artifacts.push({
        folder: file.slice(0, at),
        file,
        name: path.basename(file).replace(/\.html?$/i, ''),
        url: JSON.parse(m[3]),
        pending: Number(m[4]) || 0,
      });
    } catch { /* one bad line never kills the table */ }
  }
  return artifacts;
}

async function refreshLavish() {
  if (lavishChecking || Date.now() - lavishState.checkedAt < LAVISH_STALE_MS) return;
  lavishChecking = true;
  try {
    const out = await lavishCliOutput();
    if (out === null) { lavishState = { checkedAt: Date.now(), ok: false, artifacts: [] }; return; }
    const artifacts = parseLavishSessions(out);
    // The page file's mtime decides which review is the current one — the CLI
    // session table carries no timestamps.
    await Promise.all(artifacts.map(async (a) => {
      a.mtime = await stat(a.file).then(s => s.mtimeMs).catch(() => 0);
    }));
    lavishState = { checkedAt: Date.now(), ok: true, artifacts };
  } finally { lavishChecking = false; }
}

async function collect() {
  if (remoteState.checkedAt === 0) await refreshRemote(); else refreshRemote();
  if (lavishState.checkedAt === 0) await refreshLavish(); else refreshLavish();
  const [snapRes, wsListRes, agentListRes, projects, seen, remoteMapRaw] = await Promise.all([
    herdr(['api', 'snapshot']),
    herdr(['workspace', 'list']).catch(() => null), // the snapshot lacks the repo binding
    herdr(['agent', 'list']).catch(() => null), // pane -> session id, for recaps
    loadProjects(),
    loadSeen(),
    readJsonSoft(REMOTE_FILE, {}),
  ]);
  // Recap lines: only panes with an attached agent have a session journal.
  // The local-model summary wins when it exists; the session's last words
  // fill in until the background queue catches up (or the model is down).
  const recapByPane = new Map();
  await Promise.all((agentListRes?.result?.agents ?? []).map(async (a) => {
    const sid = a.agent_session?.value;
    if (!sid || !a.cwd || !a.pane_id) return;
    const file = await findSessionFile(sid, a.cwd);
    if (!file) return;
    scheduleAiRecap(file);
    const ai = aiRecapCache.get(file);
    const text = ai?.text || await lastAssistantText(file);
    if (text) recapByPane.set(a.pane_id, { text, waits: WAITS.has(ai?.waits) ? ai.waits : 'none' });
  }));
  const repoByWs = new Map();
  // Linked worktrees only: a plain checkout also carries worktree.repo_name,
  // and the page must not paint it with the TREE / worktree mark.
  const linkedWs = new Set();
  const wsList = wsListRes?.result?.workspaces ?? [];
  for (const w of wsList) {
    if (w.worktree?.repo_name) repoByWs.set(w.workspace_id, w.worktree.repo_name);
    if (w.worktree?.is_linked_worktree) linkedWs.add(w.workspace_id);
  }
  // A worktree window nobody renamed (label = folder name) is named by its
  // BRANCH: the folder is where the work sits, the branch is what the work IS,
  // and the operator thinks in branches — the user-login folder holding the
  // cabinet-header branch must show as cabinet-header (operator's rule,
  // 2026-08-20). A hand-renamed window keeps its name.
  const branchNameByWs = new Map();
  await Promise.all(wsList
    .filter(w => w.worktree?.is_linked_worktree && w.worktree.checkout_path)
    .map(async (w) => {
      const branch = await worktreeBranch(w.worktree.checkout_path);
      const folder = path.basename(w.worktree.checkout_path);
      if (branch && (w.label ?? '').toLowerCase() === folder.toLowerCase()
        && branch.toLowerCase() !== folder.toLowerCase()) {
        branchNameByWs.set(w.workspace_id, branch);
      }
    }));
  // Active folders: hints from the second machine, translated to local paths.
  const remotePrefixes = [];
  for (const hint of remoteState.hints) {
    for (const p of remoteMapRaw[hint] ?? []) remotePrefixes.push(normPath(p));
  }
  const onRemote = (cwd) => remotePrefixes.some(pref => cwd === pref || cwd.startsWith(pref + '\\'));

  const now = new Date().toISOString();
  const snap = snapRes?.result?.snapshot ?? {};
  const wsById = new Map((snap.workspaces ?? []).map(w => [w.workspace_id, w]));
  const tabById = new Map((snap.tabs ?? []).map(t => [t.tab_id, t]));
  const panes = snap.panes ?? [];

  // After a restart herdr restores every window but no agent is attached yet
  // (agent_status "unknown"). Those windows are still cards — the fleet must
  // stay visible while the operator brings sessions back (operator's rule,
  // 2026-08-20). The only pane hidden is a bare shell SPLIT next to another
  // pane of the same folder in the SAME tab: one tab, one card. Distinct tabs
  // are distinct restored sessions and each keeps its card (the focused tab
  // always has one). Within a tab the agent pane wins, then the lowest pane
  // id — a stable pick, so a card never flips identity between polls. A pane
  // with no folder is never anyone's duplicate.
  const paneRank = (p) => `${p.agent ? 0 : 1}|${p.pane_id}`;
  const bestInTab = new Map();
  for (const p of panes) {
    const cwd = normPath(p.cwd);
    if (!cwd) continue;
    const key = `${p.tab_id}|${cwd}`;
    const cur = bestInTab.get(key);
    if (!cur || paneRank(p) < paneRank(cur)) bestInTab.set(key, p);
  }
  const cardPanes = panes.filter(p => {
    const cwd = normPath(p.cwd);
    return !cwd || bestInTab.get(`${p.tab_id}|${cwd}`) === p;
  });

  // Each lavish artifact goes to the DEEPEST card folder that contains it —
  // a review page in team-ops lands on the team-ops card, not on every subcard.
  // A card shows exactly ONE page — the latest actual one: an open page means
  // "blocked on the operator", and an older page next to it is history, not a
  // second decision (operator's rule, 2026-08-15).
  const cardCwds = [...new Set(cardPanes.map(p => normPath(p.cwd)).filter(Boolean))];
  const lavishByCwd = new Map();
  const newestUnattached = new Map();
  for (const a of lavishState.artifacts) {
    let best = '';
    for (const c of cardCwds) {
      if ((a.folder === c || a.folder.startsWith(c + '\\')) && c.length > best.length) best = c;
    }
    const bucket = best ? lavishByCwd : newestUnattached;
    const key = best || a.folder;
    if (!bucket.has(key) || (a.mtime ?? 0) > (bucket.get(key).mtime ?? 0)) bucket.set(key, a);
  }
  const lavishUnattached = [...newestUnattached.values()];

  await queued(async () => {
    updateSeen(seen, panes, now);
    await writeJsonAtomic(SEEN_FILE, seen);
  });

  const JUNK_TITLES = new Set(['Claude Code', 'claude · resume', 'codex · resume']);
  const cards = cardPanes.map((p) => {
    const ws = wsById.get(p.workspace_id);
    const tab = tabById.get(p.tab_id);
    const status = KNOWN_STATUSES.has(p.agent_status) ? p.agent_status : 'unknown';
    const cwd = normPath(p.cwd);
    const proj = matchProject(projects, cwd);
    // A single-tab window's card is named after the window; with several tabs
    // the tab name ("Alice", "weekly") wins and the window moves to the caption.
    // Nameless tabs ("1", "2") don't count as names.
    const multiTab = (ws?.tab_count ?? 1) > 1;
    const tabName = tab?.label && !/^\d+$/.test(tab.label) ? tab.label : null;
    const wsName = branchNameByWs.get(p.workspace_id) ?? ws?.label ?? '';
    const label = (multiTab ? tabName : null) || wsName || tab?.label || '';
    // Empty titles, titles hidden with the × button, and stale ones (unchanged
    // for 3 days) are not shown — a "prep for the morning shift" title four
    // days later only misleads.
    let title = p.terminal_title_stripped || p.terminal_title || '';
    if (JUNK_TITLES.has(title) || title === label || title === proj?.hideTitle) title = '';
    if (title) {
      const born = seen[`${cwd}|~t:${strHash(title)}`]?.since;
      if (born && Date.parse(now) - Date.parse(born) > 72 * 3600 * 1000) title = '';
    }
    return {
      id: p.pane_id,
      tabId: p.tab_id,
      number: ws?.number ?? null,
      wsLabel: wsName,
      repo: repoByWs.get(p.workspace_id) ?? null,
      tree: linkedWs.has(p.workspace_id),
      label,
      status,
      focused: p.focused,
      cwd,
      dir: proj?.dir ?? null,
      prio: proj?.prio ?? null,
      star: proj?.star === true,
      kind: proj?.kind ?? null,
      role: proj?.role ?? null,
      focus: proj?.focus === true,
      checkDate: proj?.checkDate ?? null,
      view: proj?.view ?? null,
      // A note is strictly manual and strictly per-folder: set and cleared
      // from the board UI, never inherited from a parent entry (operator's
      // rule, 2026-08-20 — a root-folder note leaked onto unrelated cards).
      note: projects.get(cwd)?.note ?? null,
      remote: onRemote(cwd),
      // A review page is a BLOCKER only while it is the session's last word.
      // lavish never closes sessions on its own, so an old page would block
      // the card forever: if the folder has worked 10+ minutes past the
      // page's mtime, the ask is history, not a waiting decision (operator's
      // rule, 2026-08-20 — a working session must not sit in Decisions over
      // a week-old page).
      lavish: [lavishByCwd.get(cwd)]
        .filter(a => a && (!seen[`${cwd}|~pulse`]?.last
          || Date.parse(seen[`${cwd}|~pulse`].last) - (a.mtime ?? 0) < 10 * 60 * 1000))
        .map(a => ({ name: a.name, url: a.url, pending: a.pending })),
      lastWorkingAt: p.agent_status === 'working' ? now : (seen[`${cwd}|~pulse`]?.last ?? null),
      title,
      recap: recapByPane.get(p.pane_id)?.text ?? null,
      // The model's three-way verdict on who must act before the session can
      // move: "system" = an external SYSTEM runs (CI, a queue, another
      // machine) - work in flight, never a decision; "user" = the operator's
      // word; "none" = working or fully done (operator, 2026-08-21).
      recapWaits: recapByPane.get(p.pane_id)?.waits ?? 'none',
      agent: p.agent ?? null,
      since: seen[`${cwd}|${p.agent_status}`]?.since ?? null,
    };
  });

  return {
    generatedAt: now,
    columns: COLUMNS,
    cards,
    windows: (snap.workspaces ?? []).length,
    focusedTab: snap.focused_tab_id ?? null,
    remote: { ok: remoteState.ok, tasks: remoteState.hints },
    lavish: {
      ok: lavishState.ok,
      // Count what the board actually shows: blockers on cards plus loose
      // pages — not every session lavish still remembers.
      total: new Set(cards.filter(c => c.lavish.length).map(c => c.cwd)).size + lavishUnattached.length,
      unattached: lavishUnattached.map(a => ({ name: a.name, url: a.url, pending: a.pending, folder: a.folder })),
    },
    retire: Object.fromEntries(retireJobs),
    team: await readJsonSoft(path.join(STATE_DIR, 'team.json'), null),
  };
}

// Which fields the board may change, and how: null erases the field.
const FIELD_CHECK = {
  prio: v => v === null || ['P1', 'P2', 'P3'].includes(v),
  star: v => v === null || typeof v === 'boolean',
  kind: v => v === null || ['temp', 'ongoing', 'cron'].includes(v),
  role: v => v === null || ['run', 'tool', 'parked'].includes(v),
  focus: v => v === null || typeof v === 'boolean',
  checkDate: v => {
    if (v === null) return true;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const t = Date.parse(v);
    // The round-trip rejects day-overflow dates like 2026-02-31.
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
  },
  view: v => v === null || ['mine', 'team', 'other'].includes(v),
  hideTitle: v => v === null || (typeof v === 'string' && v.length <= 300),
  note: v => v === null || (typeof v === 'string' && v.length <= 300),
};

function setFields(cwd, patch) {
  return queued(async () => {
    const raw = await readJsonStrict(PROJECTS_FILE);
    const key = normPath(cwd);
    if (!key) throw new Error('this session has no folder — nowhere to store the value');
    for (const [f, v] of Object.entries(patch)) {
      if (!FIELD_CHECK[f]) throw new Error(`unknown field ${f}`);
      if (!FIELD_CHECK[f](v)) throw new Error(`bad value for field ${f}`);
    }
    // Look for an existing key (itself or a parent), otherwise create a new one.
    let target = null;
    for (const k of Object.keys(raw)) {
      if (k.startsWith('_')) continue;
      const nk = normPath(k);
      if (nk === key || key.startsWith(nk + '\\')) {
        if (!target || nk.length > normPath(target).length) target = k;
      }
    }
    // Never overwrite a parent entry — create a precise one for this folder.
    const base = target && normPath(target) !== key ? { ...raw[target] } : (raw[target] ?? {});
    // A parent's note never travels into a child entry: notes are per-folder,
    // and baking one in here is how a stale root note haunted new projects.
    if (target && normPath(target) !== key) delete base.note;
    const entryKey = target && normPath(target) === key ? target : key;
    const entry = { ...base };
    for (const [f, v] of Object.entries(patch)) {
      if (v === null) delete entry[f];
      else entry[f] = v;
    }
    raw[entryKey] = entry;
    await writeJsonAtomic(PROJECTS_FILE, raw);
    projectsGood = raw;
  });
}

// --- "Save memory and close": instruct the session, wait, log, close ---
const CLOSED_LOG = path.join(STATE_DIR, 'closed.jsonl');
const RETIRE_PROMPT = 'The operator is closing this window from the board. Wrap up: save everything '
  + 'important from this session into the project\'s memory — however this project does it '
  + '(memory files, handover notes). Commit any uncommitted changes. Do not send anything to anyone. '
  + 'When done, simply end your turn: the window will close and the session can be resumed later.';
const retireJobs = new Map(); // tab_id -> { phase, startedAt, error }

function statusFrom(obj) {
  const m = JSON.stringify(obj ?? {}).match(/"agent_status":"(\w+)"/);
  return m ? m[1] : null;
}

async function runRetire({ pane, tab, ws, hasAgent, label, wsLabel, cwd, title }) {
  const job = { phase: 'sending instructions', startedAt: new Date().toISOString(), error: null };
  retireJobs.set(tab, job);
  try {
    if (hasAgent) {
      job.phase = 'session is saving its memory';
      // --wait on prompt requires SEEING a state change: if the session hasn't
      // picked up the instruction within 5s, herdr returns agent_prompt_stalled —
      // and we do NOT close. (Without this there was a race: an idle session
      // "finished" instantly and a window once closed before the instruction landed.)
      await herdr(['agent', 'prompt', pane, RETIRE_PROMPT, '--wait',
        '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '900000']);
      // If the session was busy, the instruction may have queued up — wait
      // until it has actually processed it and gone quiet.
      for (let i = 0; i < 3; i++) {
        const st = statusFrom(await herdr(['agent', 'get', pane]).catch(() => null));
        if (st === 'blocked') {
          job.phase = 'stopped';
          job.error = 'the session is asking something — check the window, not closing it';
          return;
        }
        if (st !== 'working') break;
        await herdr(['agent', 'wait', pane, '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '900000']);
      }
    }
    job.phase = 'writing the close log';
    const entry = { at: new Date().toISOString(), wsLabel, label, cwd, title, tab, pane };
    await writeFile(CLOSED_LOG, JSON.stringify(entry) + '\n', { flag: 'a' });
    job.phase = 'closing the window';
    const wsInfo = await herdr(['workspace', 'get', ws]).catch(() => null);
    const tabCount = wsInfo?.result?.workspace?.tab_count ?? 1;
    if (tabCount <= 1) await herdr(['workspace', 'close', ws]);
    else await herdr(['tab', 'close', tab]);
    job.phase = 'closed';
  } catch (e) {
    job.phase = 'error';
    job.error = String(e.message || e);
  } finally {
    setTimeout(() => retireJobs.delete(tab), 10 * 60 * 1000);
  }
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Log of recent requests — to tell whether the page is actually polling
// (see: GET /debug).
const requestLog = [];
function logRequest(req) {
  requestLog.push({
    at: new Date().toISOString(),
    path: req.url,
    ua: (req.headers['user-agent'] || '').slice(0, 80),
  });
  if (requestLog.length > 100) requestLog.splice(0, requestLog.length - 100);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/board')) {
      return send(res, 200, await readFile(PAGE_FILE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/data') {
      logRequest(req);
      const payload = await collect();
      // Page version = board.html mtime: the page reloads itself
      // when the file on disk has changed.
      payload.pageVersion = (await stat(PAGE_FILE).catch(() => null))?.mtimeMs ?? null;
      return send(res, 200, JSON.stringify(payload));
    }
    if (req.method === 'GET' && url.pathname === '/debug') {
      return send(res, 200, JSON.stringify(requestLog));
    }
    if (req.method === 'POST' && url.pathname === '/focus') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { tab } = JSON.parse(body);
      // Tab/pane ordinals go base36 past 9 (wF:tE), not decimal-only.
      if (!/^w[0-9A-Za-z]*:t[0-9A-Za-z]+$/.test(String(tab))) return send(res, 400, '{"error":"bad tab id"}');
      await herdr(['tab', 'focus', String(tab)]);
      return send(res, 200, '{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/retire') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const j = JSON.parse(body);
      if (!/^w[0-9A-Za-z]*:p[0-9A-Za-z]+$/.test(String(j.pane)) || !/^w[0-9A-Za-z]*:t[0-9A-Za-z]+$/.test(String(j.tab)) || !/^w[0-9A-Za-z]+$/.test(String(j.ws))) {
        return send(res, 400, '{"error":"bad pane/tab/window ids"}');
      }
      if (retireJobs.has(j.tab)) return send(res, 409, '{"error":"already closing"}');
      runRetire(j); // in the background; progress is visible in /data
      return send(res, 200, '{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/set') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { cwd, ...patch } = JSON.parse(body);
      await setFields(cwd, patch);
      return send(res, 200, '{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/prio') {
      // legacy path, kept for pages that haven't reloaded yet
      let body = '';
      for await (const chunk of req) body += chunk;
      const { cwd, prio } = JSON.parse(body);
      await setFields(cwd, { prio });
      return send(res, 200, '{"ok":true}');
    }
    send(res, 404, '{"error":"no such path"}');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: String(e.message || e) }));
  }
});

await mkdir(STATE_DIR, { recursive: true });
await loadRecaps();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Board already running: http://127.0.0.1:${PORT}`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`sheepdog board: ${url}`);
  if (process.argv.includes('--open')) {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
});

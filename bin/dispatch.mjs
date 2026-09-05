// dispatch — the sit-down agent's hands on the board.
//
// The board files windows into lanes and shows what is on the operator; this
// tool is how the agent sitting next to the operator reads the whole fleet in
// one page and writes decisions back: which windows are today's focus, what
// each was launched on, what happened since. Every write goes through the
// board server, so the board and the brief never disagree.
//
//   node bin\dispatch.mjs brief                          the fleet as one page of text
//   node bin\dispatch.mjs type <window> focus|ongoing|tool|none
//   node bin\dispatch.mjs launch <window> "<task>"       record the task and send it into the session
//   node bin\dispatch.mjs launch <window> "<task>" --record-only
//   node bin\dispatch.mjs note <window> "<line>"         append a log line to the window's plan
//   node bin\dispatch.mjs done <window>                  mark the launched task done
//   node bin\dispatch.mjs clear <window>                 drop the window's plan
//
// <window> is the herdr window number (#12 or 12) or a unique part of the
// card's name. Sending a task into a session is `herdr agent prompt`: it only
// works from inside a herdr pane, and only on the operator's word — this
// tool never decides to launch anything by itself.

import { execFile } from 'node:child_process';
import path from 'node:path';

const BOARD = process.env.SHEEPDOG_URL || 'http://127.0.0.1:4877';
const HERDR_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Herdr', 'bin', 'herdr.exe'),
  'herdr',
];

function die(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function herdr(args) {
  return new Promise((resolve, reject) => {
    const tryOne = (i) => {
      execFile(HERDR_CANDIDATES[i], args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT' && i + 1 < HERDR_CANDIDATES.length) return tryOne(i + 1);
          return reject(new Error(String(stderr || '').trim() || err.message));
        }
        resolve(String(stdout));
      });
    };
    tryOne(0);
  });
}

async function boardGet(pathname) {
  const r = await fetch(BOARD + pathname).catch(e => die(`board is not answering at ${BOARD}: ${e.message}`));
  if (!r.ok) die(`board ${pathname}: ${r.status}`);
  return r;
}

async function boardPost(pathname, body) {
  const r = await fetch(BOARD + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(e => die(`board is not answering at ${BOARD}: ${e.message}`));
  if (!r.ok) die(`board ${pathname}: ${(await r.json().catch(() => ({}))).error || r.status}`);
}

// A window is named by its number or by a unique part of its card's name;
// among the cards of one window the agent pane wins.
async function findCard(selector) {
  const sel = String(selector ?? '').trim();
  if (!sel) die('which window? give its number (#12) or part of its name');
  const data = await (await boardGet('/data')).json();
  const mine = data.cards.filter(c => (c.view ?? 'mine') === 'mine' && c.cwd);
  const num = sel.match(/^#?(\d+)$/);
  let hits = num
    ? mine.filter(c => c.number === Number(num[1]))
    : mine.filter(c => c.label.toLowerCase() === sel.toLowerCase());
  if (!hits.length && !num) hits = mine.filter(c => c.label.toLowerCase().includes(sel.toLowerCase()));
  if (!hits.length) die(`no window matches "${sel}" — run "dispatch brief" for the list`);
  const distinct = new Set(hits.map(c => c.cwd));
  if (distinct.size > 1) die(`"${sel}" is ambiguous:\n` + hits.map(c => `  #${c.number} ${c.label} — ${c.cwd}`).join('\n'));
  return hits.sort((a, b) => (a.agent ? 0 : 1) - (b.agent ? 0 : 1))[0];
}

const [cmd, target, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith('--')));
const text = rest.filter(a => !a.startsWith('--')).join(' ').trim();

switch (cmd) {
  case 'brief': {
    process.stdout.write(await (await boardGet('/brief')).text());
    break;
  }
  case 'type': {
    const value = String(rest[0] ?? '').toLowerCase();
    if (!['focus', 'ongoing', 'tool', 'none'].includes(value)) die('type must be focus, ongoing, tool or none');
    const card = await findCard(target);
    await boardPost('/set', { cwd: card.cwd, type: value === 'none' ? null : value });
    console.log(`#${card.number} ${card.label} → ${value === 'none' ? 'unsorted' : value}`);
    break;
  }
  case 'launch': {
    if (!text) die('launch needs the task text: dispatch launch <window> "<task>"');
    const card = await findCard(target);
    await boardPost('/plan', { cwd: card.cwd, task: text });
    if (flags.has('--record-only')) { console.log(`#${card.number} ${card.label}: task recorded, nothing sent`); break; }
    if (!card.agent) die(`#${card.number} ${card.label}: task recorded, but no agent runs in that window — bring the session back, then send by hand`);
    if (process.env.HERDR_ENV !== '1') die(`#${card.number} ${card.label}: task recorded, but sending needs a herdr pane (HERDR_ENV is not 1)`);
    await herdr(['agent', 'prompt', card.id, text]).catch(e => die(`#${card.number} ${card.label}: task recorded, but sending failed: ${e.message}`));
    console.log(`#${card.number} ${card.label}: task recorded and sent${card.status === 'working' ? ' (the session is busy — herdr queued it)' : ''}`);
    break;
  }
  case 'note': {
    if (!text) die('note needs a line: dispatch note <window> "<line>"');
    const card = await findCard(target);
    await boardPost('/plan', { cwd: card.cwd, note: text });
    console.log(`#${card.number} ${card.label}: noted`);
    break;
  }
  case 'done': {
    const card = await findCard(target);
    await boardPost('/plan', { cwd: card.cwd, status: 'done' });
    console.log(`#${card.number} ${card.label}: done`);
    break;
  }
  case 'clear': {
    const card = await findCard(target);
    await boardPost('/plan', { cwd: card.cwd, clear: true });
    console.log(`#${card.number} ${card.label}: plan cleared`);
    break;
  }
  default:
    die('usage: dispatch brief | type <window> focus|ongoing|tool|none | launch <window> "<task>" [--record-only] | note <window> "<line>" | done <window> | clear <window>', 2);
}

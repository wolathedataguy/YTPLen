'use strict';

/* global collectPlaylist */

const PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const CACHE_TTL_MS = 15 * 60 * 1000;
const SLIDER_MIN = 0.25;
const SLIDER_MAX = 4;

const $ = (id) => document.getElementById(id);

const state = {
  tabId: null,
  listId: null,
  data: null,
  startHint: null,
  speed: 2,
  from: 1,
  to: 1,
  maxPos: 1,
  cachedAt: null,
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'plr-progress' && msg.listId === state.listId) {
    $('statusBody').textContent = msg.text;
  }
});

init();

async function init() {
  wireControls();

  try {
    const { speed } = await chrome.storage.local.get('speed');
    if (isValidSpeed(speed)) state.speed = speed;
  } catch (_) { /* first run */ }

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { /* ignore */ }

  const url = parseUrl(tab && tab.url);
  if (!url || !/(^|\.)youtube\.com$/.test(url.hostname)) {
    return showMessage('Open a YouTube playlist', 'Go to a playlist on youtube.com, or a video playing from one, then click this button again.');
  }
  if (url.hostname !== 'www.youtube.com') {
    return showMessage('Switch to www.youtube.com', 'This works on the desktop site. Open the same playlist on www.youtube.com and try again.');
  }

  const listId = url.searchParams.get('list');
  if (!listId) {
    return showMessage('No playlist on this page', 'Open a playlist, or a video whose address contains “list=”, then click this button again.');
  }
  if (/^RD/.test(listId)) {
    return showMessage('Mixes don’t have a fixed length', 'YouTube Mixes keep adding videos as you watch, so there’s no total to count.');
  }

  state.tabId = tab.id;
  state.listId = listId;
  const index = parseInt(url.searchParams.get('index'), 10);
  if (url.pathname === '/watch' && index > 1) state.startHint = index;

  $('refresh').hidden = false;
  load(false);
}

function wireControls() {
  $('refresh').addEventListener('click', () => load(true));

  $('speedRange').addEventListener('input', (e) => setSpeed(parseFloat(e.target.value), 'range'));

  $('speedInput').addEventListener('input', (e) => {
    const v = parseSpeed(e.target.value);
    $('speedInput').parentElement.classList.toggle('invalid', !v);
    if (v) setSpeed(v, 'input');
  });
  $('speedInput').addEventListener('blur', () => {
    $('speedInput').parentElement.classList.remove('invalid');
    $('speedInput').value = fmtSpeed(state.speed);
  });
  $('speedInput').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = e.shiftKey ? 0.5 : 0.05;
    const next = state.speed + (e.key === 'ArrowUp' ? step : -step);
    if (next > 0) setSpeed(round2(next), 'keys');
  });

  $('ladder').addEventListener('click', (e) => {
    const rung = e.target.closest('[data-speed]');
    if (rung) setSpeed(parseFloat(rung.dataset.speed), 'preset');
  });

  for (const id of ['from', 'to']) {
    $(id).addEventListener('input', () => {
      const v = parseInt($(id).value, 10);
      if (v >= 1) {
        state[id] = Math.min(v, state.maxPos);
        update();
      }
    });
    $(id).addEventListener('change', () => {
      $(id).value = state[id];
    });
  }

  $('all').addEventListener('click', () => {
    state.from = 1;
    state.to = state.maxPos;
    $('from').value = state.from;
    $('to').value = state.to;
    update();
  });
}

async function load(force) {
  showMessage('Counting videos…', 'Reading the playlist from YouTube.', true);
  const key = `pl:${state.listId}`;

  if (!force) {
    try {
      const cached = (await chrome.storage.session.get(key))[key];
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return showResult(cached.data, cached.at);
      }
    } catch (_) { /* no cache */ }
  }

  let result;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: collectPlaylist,
      args: [state.listId],
    });
    result = injection && injection.result;
  } catch (err) {
    return showMessage('Couldn’t read this tab', `Reload the YouTube page and try again. (${err.message})`);
  }

  if (!result || !result.ok) {
    return showMessage(
      'Couldn’t count this playlist',
      (result && result.error) || 'YouTube didn’t return any videos. Reload the page and try again.'
    );
  }

  if (!result.partial) {
    chrome.storage.session.set({ [key]: { at: Date.now(), data: result } }).catch(() => {});
  }
  showResult(result, null);
}

function showMessage(title, body, busy = false) {
  $('result').hidden = true;
  $('status').hidden = false;
  $('spinner').hidden = !busy;
  $('statusTitle').textContent = title;
  $('statusBody').textContent = body || '';
  if (!busy) {
    $('title').textContent = 'Playlist Runtime';
    $('meta').textContent = '';
  }
}

function showResult(data, cachedAt) {
  state.data = data;
  state.cachedAt = cachedAt;
  state.maxPos = Math.max(data.videos.length, ...data.videos.map(([p]) => p), 1);
  state.from = clamp(state.startHint || 1, 1, state.maxPos);
  state.to = state.maxPos;

  for (const id of ['from', 'to']) {
    $(id).max = state.maxPos;
    $(id).value = state[id];
  }

  $('title').textContent = data.title || 'Untitled playlist';
  $('status').hidden = true;
  $('result').hidden = false;

  $('speedInput').value = fmtSpeed(state.speed);
  $('speedRange').value = clamp(state.speed, SLIDER_MIN, SLIDER_MAX);
  buildLadder();
  update();
}

function setSpeed(v, source) {
  if (!isValidSpeed(v)) return;
  state.speed = v;
  if (source !== 'input') {
    $('speedInput').value = fmtSpeed(v);
    $('speedInput').parentElement.classList.remove('invalid');
  }
  if (source !== 'range') $('speedRange').value = clamp(v, SLIDER_MIN, SLIDER_MAX);
  saveSpeedSoon();
  if (state.data) update();
}

let saveTimer = null;
function saveSpeedSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ speed: state.speed }).catch(() => {}), 300);
}

function buildLadder() {
  const ladder = $('ladder');
  ladder.textContent = '';
  for (const s of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rung';
    b.dataset.speed = String(s);
    b.innerHTML = '<span class="rung-x"></span><span class="rung-bar"><i></i></span><span class="rung-t"></span>';
    b.querySelector('.rung-x').textContent = `${fmtSpeed(s)}×`;
    b.querySelector('.rung-bar i').style.width = `${(100 / s).toFixed(1)}%`;
    ladder.appendChild(b);
  }
}

function update() {
  const lo = Math.min(state.from, state.to);
  const hi = Math.max(state.from, state.to);
  const all = state.data.videos;
  const inSpan = all.filter(([p]) => p >= lo && p <= hi);
  const timed = inSpan.filter(([, s]) => s > 0);
  const total = timed.reduce((sum, [, s]) => sum + s, 0);
  const missing = inSpan.length - timed.length;
  const isWhole = lo <= 1 && hi >= state.maxPos;

  // Header line
  const avg = timed.length ? total / timed.length : 0;
  const count = isWhole ? plural(inSpan.length, 'video') : `Videos ${lo}–${hi} of ${state.maxPos}`;
  $('meta').textContent = timed.length ? `${count}, about ${fmtAvg(avg)} each` : count;
  $('all').hidden = isWhole;

  // Full length at 1x
  $('totalLabel').textContent = isWhole ? 'Full length' : 'Length';
  renderDuration($('total'), total, true);
  $('totalHours').textContent = `${(total / 3600).toFixed(2)} hours`;

  // Chosen speed
  const t = total / state.speed;
  renderDuration($('speedTime'), t, t < 3600);
  const sub = $('speedSub');
  sub.textContent = '';
  if (Math.abs(state.speed - 1) < 1e-9) {
    sub.append('At normal speed');
  } else {
    const diff = Math.abs(total - t);
    const b = document.createElement('b');
    b.textContent = fmtPlain(diff, diff < 3600);
    if (state.speed > 1) sub.append(`At ${fmtSpeed(state.speed)}× you save `, b);
    else sub.append(`At ${fmtSpeed(state.speed)}× it takes `, b, ' longer');
  }

  // Ladder
  for (const rung of $('ladder').children) {
    const s = parseFloat(rung.dataset.speed);
    const rt = total / s;
    rung.querySelector('.rung-t').textContent = fmtPlain(rt, rt < 3600);
    rung.setAttribute('aria-pressed', String(Math.abs(s - state.speed) < 1e-9));
  }

  // Notes
  const notes = $('notes');
  notes.textContent = '';
  const note = (text, warn) => {
    const p = document.createElement('p');
    p.textContent = text;
    if (warn) p.className = 'warn';
    notes.appendChild(p);
  };
  if (state.startHint && state.from === state.startHint && !isWhole) {
    note(`Starting from video ${state.startHint}, the one you’re watching.`);
  }
  if (missing > 0) {
    note(`${plural(missing, 'video')} had no length (private, deleted, or live) and ${missing === 1 ? 'isn’t' : 'aren’t'} counted.`);
  }
  if (state.data.partial && state.data.note) note(state.data.note, true);
  if (state.cachedAt) {
    const mins = Math.round((Date.now() - state.cachedAt) / 60000);
    note(`Counted ${mins < 1 ? 'just now' : `${mins} min ago`}. Use the refresh button to recount.`);
  }
}

/* ---------- formatting ---------- */

function durationParts(sec, withSeconds) {
  sec = Math.max(0, sec);
  if (withSeconds) {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return [[h, 'h'], [m, 'm'], [r, 's']];
    if (m) return [[m, 'm'], [r, 's']];
    return [[r, 's']];
  }
  const mins = Math.round(sec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? [[h, 'h'], [m, 'm']] : [[m, 'm']];
}

function renderDuration(el, sec, withSeconds) {
  el.textContent = '';
  for (const [n, unit] of durationParts(sec, withSeconds)) {
    el.append(n.toLocaleString());
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = unit;
    el.append(u);
  }
}

function fmtPlain(sec, withSeconds) {
  return durationParts(sec, withSeconds).map(([n, u]) => `${n.toLocaleString()}${u}`).join(' ');
}

function fmtAvg(sec) {
  if (sec < 60) return `${Math.round(sec)} sec`;
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

function fmtSpeed(v) {
  return String(round2(v));
}

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/* ---------- helpers ---------- */

function parseSpeed(raw) {
  const v = parseFloat(String(raw).replace(',', '.').replace(/[x×\s]/gi, ''));
  return isValidSpeed(v) ? v : null;
}

function isValidSpeed(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function parseUrl(u) {
  try { return u ? new URL(u) : null; } catch (_) { return null; }
}

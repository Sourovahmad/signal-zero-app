// SIGNAL ZERO - Mission Console
//
// Live, deterministic front-end for the full engine (power + oxygen + thermal
// + failures + drones) plus the canonical SAVE/LOAD system and the black-box
// REPLAY recorder. The engine advances via the SimClock accumulator (fixed
// 100 ms ticks) decoupled from the render frame rate; the UI only reads
// snapshots and submits timestamped commands. It never mutates sim state.
//
// This module is the renderer launch entry point. boot() is wrapped so that any
// initialization failure degrades to the readable #bootError panel (installed
// by the classic guard script in index.html) instead of leaving a blank window.

import { Engine, Commands, SimClock, formatSimTime, Priority, PROGRESS_SCALE, TaskType }
  from '../umbra/engine/index.mjs';
import { serialize, tryLoad } from '../umbra/engine/persistence.mjs';
import { BlackBox } from '../umbra/engine/replay.mjs';
import { buildSevenMinutes } from '../umbra/engine/fixtures.mjs';

const PRIORITY_NAME = { 1: 'CRITICAL', 2: 'HIGH', 3: 'NORMAL', 4: 'LOW' };
const SAVE_SLOT = 'signalzero.quicksave.v1';

const state = {
  engine: null,
  config: null,       // the initial config of the current session (for replay)
  clock: new SimClock(),
  speed: 0,           // start paused
  selected: 'reactor',
  lastTs: 0,
  raf: 0,
  wired: false,
};

/** Signal a successful launch to the classic boot guard in index.html. */
function markBooted() {
  if (typeof window !== 'undefined') window.__signalZeroBooted = true;
}

/** Degrade to the readable boot-error panel instead of crashing to a blank UI. */
function reportBootFailure(err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (typeof window !== 'undefined' && typeof window.__signalZeroBootError === 'function') {
    window.__signalZeroBootError(msg);
  } else if (typeof console !== 'undefined') {
    console.error('SIGNAL ZERO boot failure:', err);
  }
}

function boot() {
  try {
    const cfg = buildSevenMinutes(70000);
    state.config = cfg;
    state.engine = Engine.create(cfg);
    state.engine.logEvent('Scenario "Seven Minutes" loaded. Keep 14 crew alive for 7:00.', 'info');
    state.selected = 'reactor';
    buildMap();
    if (!state.wired) { wireControls(); state.wired = true; }
    render();
    state.lastTs = now();
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(loop);
    markBooted();
  } catch (err) {
    reportBootFailure(err);
  }
}

function now() { return (globalThis.performance ? performance.now() : Date.now()); }

function loop() {
  try {
    const t = now();
    const dt = t - state.lastTs;
    state.lastTs = t;
    const ticks = state.clock.pump(dt, state.speed);
    if (ticks > 0) state.engine.run(ticks);
    render();
    state.raf = requestAnimationFrame(loop);
  } catch (err) {
    // A runtime fault must not silently freeze the console: surface it.
    reportBootFailure(err);
  }
}

/**
 * Replace the live engine with a freshly created / loaded / replayed one and
 * re-attach the render loop paused. Keeps the console fully consistent.
 */
function adoptEngine(engine, config) {
  cancelAnimationFrame(state.raf);
  state.engine = engine;
  if (config) state.config = config;
  state.speed = 0;
  state.clock.reset();
  if (!engine.state.graph.getModule(state.selected)) {
    const first = engine.state.graph.moduleList()[0];
    state.selected = first ? first.id : null;
  }
  buildMap();
  render();
  state.lastTs = now();
  state.raf = requestAnimationFrame(loop);
}

// ---- Map -------------------------------------------------------------------
function buildMap() {
  const g = state.engine.state.graph;
  const svg = document.getElementById('map');
  const W = 760, H = 580;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let edges = '';
  for (const c of g.connectionList()) {
    const a = g.getModule(c.a), b = g.getModule(c.b);
    if (!a || !b) continue;
    edges += `<line class="edge" data-edge="${c.id}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>`;
  }
  let nodes = '';
  for (const m of g.moduleList()) {
    nodes += `<g class="node" data-node="${m.id}" transform="translate(${m.x},${m.y})" tabindex="0" role="button" aria-label="${m.name}">
      <circle r="22"></circle>
      <text class="nlabel" y="38">${escapeHtml(m.name)}</text>
    </g>`;
  }
  // Drone markers (positioned each render).
  let drones = '';
  for (const d of state.engine.state.droneList()) {
    drones += `<g class="drone" data-drone="${d.id}"><circle r="6"></circle><text class="dlabel" y="-9">${droneNum(d)}</text></g>`;
  }
  svg.innerHTML = edges + nodes + `<g id="droneLayer">${drones}</g>`;
  svg.querySelectorAll('.node').forEach(n => {
    const id = n.getAttribute('data-node');
    n.addEventListener('click', () => { state.selected = id; render(); });
    n.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.selected = id; render(); }
    });
  });
}

function droneNum(d) { const m = /(\d+)/.exec(d.id); return m ? m[1] : d.id; }

// ---- Controls --------------------------------------------------------------
function wireControls() {
  document.querySelectorAll('[data-speed]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.speed = parseInt(btn.getAttribute('data-speed'), 10);
      state.engine.enqueue(Commands.setSpeed(state.engine.tick, state.speed));
      state.engine.logEvent('Time control set to ' + (state.speed === 0 ? 'PAUSE' : state.speed + 'x') + '.');
      render();
    });
  });
  document.getElementById('btn-restart').addEventListener('click', () => {
    cancelAnimationFrame(state.raf);
    state.clock.reset();
    state.speed = 0;
    boot();
    setSessionStatus('Scenario restarted from tick 0.', 'ok');
  });

  // ---- Session: save / load / black-box replay ----
  const btnSaveFile = document.getElementById('btn-save-file');
  const btnQuickSave = document.getElementById('btn-quicksave');
  const btnQuickLoad = document.getElementById('btn-quickload');
  const btnLoadFile = document.getElementById('btn-load-file');
  const btnSaveReplay = document.getElementById('btn-save-replay');
  const btnLoadReplay = document.getElementById('btn-load-replay');
  const fileLoad = document.getElementById('file-load');
  const fileReplay = document.getElementById('file-replay');

  if (btnSaveFile) btnSaveFile.addEventListener('click', saveToFile);
  if (btnQuickSave) btnQuickSave.addEventListener('click', quickSave);
  if (btnQuickLoad) btnQuickLoad.addEventListener('click', quickLoad);
  if (btnLoadFile) btnLoadFile.addEventListener('click', () => fileLoad && fileLoad.click());
  if (btnSaveReplay) btnSaveReplay.addEventListener('click', saveReplay);
  if (btnLoadReplay) btnLoadReplay.addEventListener('click', () => fileReplay && fileReplay.click());

  if (fileLoad) fileLoad.addEventListener('change', () => readFile(fileLoad, loadSaveText));
  if (fileReplay) fileReplay.addEventListener('change', () => readFile(fileReplay, loadReplayText));
}

// Pick the drone with the shortest pending queue (deterministic by id).
function leastBusyDrone() {
  let best = null;
  for (const d of state.engine.state.droneList()) {
    if (!best || d.queue.tasks.length < best.queue.tasks.length) best = d;
  }
  return best;
}

function dispatch(type, targetId) {
  const d = leastBusyDrone();
  if (!d) return;
  state.engine.enqueue(Commands.addTask(state.engine.tick, d.id, { type, targetId, workRequired: 100 }));
  render();
}

// ---- Session helpers -------------------------------------------------------
function setSessionStatus(text, cls) {
  const el = document.getElementById('sessionStatus');
  if (!el) return;
  el.textContent = text;
  el.className = cls === 'ok' ? 'badge ok' : cls === 'danger' ? 'badge danger' : 'muted';
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFile(input, cb) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { cb(String(reader.result)); input.value = ''; };
  reader.onerror = () => { setSessionStatus('Could not read file.', 'danger'); input.value = ''; };
  reader.readAsText(file);
}

function saveToFile() {
  const text = serialize(state.engine, state.config);
  download('signalzero-save-' + tickStamp() + '.json', text);
  setSessionStatus('Saved to file at ' + state.engine.simTime + '.', 'ok');
}

function quickSave() {
  const text = serialize(state.engine, state.config);
  try {
    localStorage.setItem(SAVE_SLOT, text);
    setSessionStatus('Quick-saved at ' + state.engine.simTime + '.', 'ok');
  } catch (e) {
    setSessionStatus('Quick-save unavailable (storage blocked). Use "Save to File".', 'danger');
  }
}

function quickLoad() {
  let text = null;
  try { text = localStorage.getItem(SAVE_SLOT); } catch (e) { text = null; }
  if (!text) { setSessionStatus('No quick-save found.', 'danger'); return; }
  loadSaveText(text);
}

function loadSaveText(text) {
  const res = tryLoad(text);
  if (!res.ok) { setSessionStatus('Load failed: ' + res.error, 'danger'); return; }
  adoptEngine(res.engine, res.origin || null);
  res.engine.logEvent('Save loaded \u2014 simulation resumed (paused).', 'info');
  setSessionStatus('Loaded save at ' + res.engine.simTime + ' (paused).', 'ok');
  render();
}

function saveReplay() {
  const box = BlackBox.fromEngine(state.engine, state.config);
  download('signalzero-replay-' + tickStamp() + '.json', box.serialize());
  setSessionStatus('Black box exported (' + box.commandCount + ' commands, to ' + state.engine.simTime + ').', 'ok');
}

function loadReplayText(text) {
  let box;
  try {
    box = BlackBox.fromJSON(text);
  } catch (e) {
    setSessionStatus('Replay rejected: ' + (e && e.message ? e.message : e), 'danger');
    return;
  }
  // Re-run headlessly to the recorded final tick and adopt the resulting state.
  const eng = Engine.create(box.config);
  eng.state.commandLog = state.engine.state.commandLog.constructor.fromJSON(box.commands);
  eng.run(box.finalTick);
  adoptEngine(eng, box.config);
  eng.logEvent('Black-box replay reproduced to ' + formatSimTime(box.finalTick) + '.', 'info');
  setSessionStatus('Replayed ' + box.commandCount + ' commands to ' + formatSimTime(box.finalTick) + '.', 'ok');
  render();
}

function tickStamp() {
  return state.engine.simTime.replace(/[:.]/g, '');
}

// ---- Render ----------------------------------------------------------------
function render() {
  const eng = state.engine;
  const s = eng.state;
  const g = s.graph;
  const dash = eng.dashboard();

  setStat('crew', dash.crewAlive, dash.crewAlive <= 0 ? 'danger' : (dash.crewAlive < s.initialCrew ? 'warn' : ''));
  setStat('temp', dash.reactorTempC.toFixed(1) + '\u00B0C',
    dash.reactorTempC >= 1200 ? 'danger' : dash.reactorTempC >= 800 ? 'warn' : '');
  setStat('power', dash.availablePower, '');
  setStat('demand', dash.totalDemand, dash.totalDemand > dash.availablePower ? 'warn' : '');
  setStat('oxygen', dash.avgOxygenPct + '%', dash.avgOxygenPct < 30 ? 'danger' : dash.avgOxygenPct < 50 ? 'warn' : '');
  setStat('failures', dash.activeFailures, dash.activeFailures > 0 ? 'danger' : '');
  setStat('drones', dash.availableDrones, '');
  setStat('time', dash.simTime, '');

  // Outcome banner.
  const banner = document.getElementById('outcome');
  if (dash.outcome === 'victory') { banner.textContent = 'VICTORY \u2014 all crew survived seven minutes.'; banner.className = 'banner ok'; }
  else if (dash.outcome === 'survived') { banner.textContent = 'TIME REACHED \u2014 mission ended with casualties.'; banner.className = 'banner warn'; }
  else if (dash.outcome === 'defeat') { banner.textContent = 'MISSION FAILED \u2014 all crew lost.'; banner.className = 'banner danger'; }
  else { banner.textContent = ''; banner.className = 'banner'; }

  // Speed buttons active state.
  document.querySelectorAll('[data-speed]').forEach(b => {
    b.classList.toggle('active', parseInt(b.getAttribute('data-speed'), 10) === state.speed);
  });

  // Map node + edge states.
  const svg = document.getElementById('map');
  for (const m of g.moduleList()) {
    const node = svg.querySelector(`.node[data-node="${m.id}"]`);
    if (!node) continue;
    const pct = m.oxygenCapacity > 0 ? (m.oxygen * 100) / m.oxygenCapacity : 0;
    node.classList.toggle('powered', m.powered);
    node.classList.toggle('unpowered', !m.powered);
    node.classList.toggle('fire', m.onFire);
    node.classList.toggle('o2danger', pct < 30 && m.crew > 0);
    node.classList.toggle('damaged', m.damage >= 50 || m.sensorFault);
    node.classList.toggle('selected', m.id === state.selected);
  }
  for (const c of g.connectionList()) {
    const edge = svg.querySelector(`.edge[data-edge="${c.id}"]`);
    if (!edge) continue;
    edge.classList.toggle('broken', c.broken);
    edge.classList.toggle('leaking', c.leaking && !c.broken);
    edge.classList.toggle('jammed', c.doorBlocked && !c.broken);
  }
  renderDroneMarkers(svg);

  renderModulePanel();
  renderDronePanel();
  renderFailurePanel();
  renderEventLog();
}

function renderDroneMarkers(svg) {
  const g = state.engine.state.graph;
  for (const d of state.engine.state.droneList()) {
    const marker = svg.querySelector(`.drone[data-drone="${d.id}"]`);
    if (!marker) continue;
    let x, y;
    if (d.edgeTo) {
      const a = g.getModule(d.edgeFrom), b = g.getModule(d.edgeTo);
      const c = g.edgeBetween(d.edgeFrom, d.edgeTo);
      const total = (c ? c.length : 1) * PROGRESS_SCALE;
      const f = Math.max(0, Math.min(1, d.edgeProgress / total));
      x = (a ? a.x : 0) + ((b ? b.x : 0) - (a ? a.x : 0)) * f;
      y = (a ? a.y : 0) + ((b ? b.y : 0) - (a ? a.y : 0)) * f;
    } else {
      const a = g.getModule(d.atNode);
      x = a ? a.x : 0; y = a ? a.y : 0;
    }
    marker.setAttribute('transform', `translate(${x.toFixed(1)},${(y - 26).toFixed(1)})`);
    marker.classList.toggle('busy', d.busy || !!d.edgeTo);
  }
}

function setStat(key, value, cls) {
  const el = document.getElementById('stat-' + key);
  if (!el) return;
  el.querySelector('.value').textContent = value;
  el.classList.remove('is-warn', 'is-danger');
  if (cls === 'warn') el.classList.add('is-warn');
  if (cls === 'danger') el.classList.add('is-danger');
}

function renderModulePanel() {
  const eng = state.engine;
  const m = eng.state.graph.getModule(state.selected);
  const panel = document.getElementById('modulePanel');
  if (!m) { panel.innerHTML = '<p class="muted">No module selected.</p>'; return; }
  const failures = eng.state.failureList().filter(f => f.active && f.targetId === m.id);
  const pct = m.oxygenCapacity > 0 ? Math.floor((m.oxygen * 100) / m.oxygenCapacity) : 0;
  const rows = [
    ['Priority', PRIORITY_NAME[m.priority] || m.priority],
    ['Power demand', m.powerDemand],
    ['Power received', m.powerReceived],
    ['Powered', m.powered ? 'YES' : 'NO'],
    ['Oxygen', pct + '%'],
    ['Temperature', (m.temperature / 10).toFixed(1) + '\u00B0C'],
    ['Damage', m.damage + '%'],
    ['Crew', m.crew + (m.crew ? ' (health ' + m.crewHealth + '%)' : '')],
    ['On fire', m.onFire ? 'YES' : 'no'],
    ['Sensor fault', m.sensorFault ? 'YES' : 'no'],
    ['Active failures', failures.length],
  ];
  let html = `<h3>${escapeHtml(m.name)} <span class="badge ${m.powered ? 'ok' : 'danger'}">${m.powered ? 'POWERED' : 'UNPOWERED'}</span></h3>`;
  html += '<table><tbody>';
  for (const [k, v] of rows) html += `<tr><th>${k}</th><td>${v}</td></tr>`;
  html += '</tbody></table>';
  html += `<label for="prio-select">Change priority (command-sourced)</label>
    <select id="prio-select">
      ${[Priority.CRITICAL, Priority.HIGH, Priority.NORMAL, Priority.LOW].map(p =>
        `<option value="${p}" ${p === m.priority ? 'selected' : ''}>${PRIORITY_NAME[p]}</option>`).join('')}
    </select>`;
  html += '<div class="controls" style="margin-top:12px">';
  html += `<button class="btn ghost" data-act="inspect">Inspect (drone)</button>`;
  html += `<button class="btn ghost" data-act="repair">Repair module</button>`;
  if (m.onFire) html += `<button class="btn" data-act="extinguish">Extinguish fire</button>`;
  html += '</div>';
  panel.innerHTML = html;

  const sel = document.getElementById('prio-select');
  sel.addEventListener('change', () => {
    const p = parseInt(sel.value, 10);
    eng.enqueue(Commands.setPriority(eng.tick, m.id, p));
    render();
  });
  panel.querySelector('[data-act="inspect"]').addEventListener('click', () => dispatch(TaskType.INSPECT_MODULE, m.id));
  panel.querySelector('[data-act="repair"]').addEventListener('click', () => dispatch(TaskType.REPAIR_MODULE, m.id));
  const ext = panel.querySelector('[data-act="extinguish"]');
  if (ext) ext.addEventListener('click', () => dispatch(TaskType.EXTINGUISH_FIRE, m.id));
}

function renderDronePanel() {
  const eng = state.engine;
  const panel = document.getElementById('dronePanel');
  let html = '';
  for (const d of eng.state.droneList()) {
    const loc = d.edgeTo ? `${d.edgeFrom}\u2192${d.edgeTo}` : d.atNode;
    html += `<div class="drone-card"><div class="drone-head"><strong>Drone ${droneNum(d)}</strong> <span class="muted">@ ${escapeHtml(loc)}</span> ${d.busy || d.edgeTo ? '<span class="badge warn">BUSY</span>' : '<span class="badge ok">IDLE</span>'}</div>`;
    if (d.queue.tasks.length === 0) {
      html += '<div class="muted">queue empty</div>';
    } else {
      html += '<ol class="task-list">';
      d.queue.tasks.forEach((t, i) => {
        const p = Math.min(100, Math.floor((t.progress * 100) / t.workRequired));
        html += `<li><span>${escapeHtml(t.type)} \u2192 ${escapeHtml(t.targetId)} (${p}%)</span>
          <span class="task-btns">
            <button class="btn ghost mini" data-d="${d.id}" data-t="${t.id}" data-i="${i - 1}" data-op="up" ${i === 0 ? 'disabled' : ''}>\u2191</button>
            <button class="btn ghost mini" data-d="${d.id}" data-t="${t.id}" data-i="${i + 1}" data-op="down" ${i >= d.queue.tasks.length - 1 ? 'disabled' : ''}>\u2193</button>
            <button class="btn ghost mini" data-d="${d.id}" data-t="${t.id}" data-op="rm">\u2715</button>
          </span></li>`;
      });
      html += '</ol>';
    }
    html += '</div>';
  }
  panel.innerHTML = html;
  panel.querySelectorAll('button[data-op]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dId = btn.getAttribute('data-d');
      const tId = btn.getAttribute('data-t');
      const op = btn.getAttribute('data-op');
      if (op === 'rm') {
        eng.enqueue(Commands.removeTask(eng.tick, dId, tId));
      } else {
        eng.enqueue(Commands.reorderTask(eng.tick, dId, tId, parseInt(btn.getAttribute('data-i'), 10)));
      }
      render();
    });
  });
}

function renderFailurePanel() {
  const eng = state.engine;
  const g = eng.state.graph;
  const panel = document.getElementById('failurePanel');
  const active = eng.state.failureList().filter(f => f.active);
  if (active.length === 0) { panel.innerHTML = '<p class="muted">No active failures. Systems nominal.</p>'; return; }
  let html = '<table><thead><tr><th>Type</th><th>Target</th><th>Sev</th><th>Dispatch</th></tr></thead><tbody>';
  for (const f of active) {
    const isConn = !!g.getConnection(f.targetId);
    const name = isConn ? ('conn ' + f.targetId) : (g.getModule(f.targetId) ? g.getModule(f.targetId).name : f.targetId);
    let act = '';
    if (isConn) act = `<button class="btn ghost mini" data-fx="conn" data-id="${f.targetId}">Repair</button>`;
    else if (f.type === 'module_fire') act = `<button class="btn ghost mini" data-fx="fire" data-id="${f.targetId}">Extinguish</button>`;
    else act = `<button class="btn ghost mini" data-fx="mod" data-id="${f.targetId}">Repair</button>`;
    html += `<tr class="danger"><td>${escapeHtml(f.type)}</td><td>${escapeHtml(name)}</td><td>${f.severity}</td><td>${act}</td></tr>`;
  }
  html += '</tbody></table>';
  panel.innerHTML = html;
  panel.querySelectorAll('button[data-fx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const fx = btn.getAttribute('data-fx');
      if (fx === 'conn') dispatch(TaskType.REPAIR_CONNECTION, id);
      else if (fx === 'fire') dispatch(TaskType.EXTINGUISH_FIRE, id);
      else dispatch(TaskType.REPAIR_MODULE, id);
    });
  });
}

function renderEventLog() {
  const log = document.getElementById('eventLog');
  const events = state.engine.state.eventLog;
  const recent = events.slice(-120);
  let html = '';
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    html += `<div class="line ${e.level}"><span class="t">${formatSimTime(e.tick)}</span> ${escapeHtml(e.text)}</div>`;
  }
  log.innerHTML = html || '<div class="muted">No events yet.</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

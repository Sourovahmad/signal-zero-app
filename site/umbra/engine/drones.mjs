// SIGNAL ZERO - repair DRONE motion + task execution (Beta stage)
//
// Drones physically travel the station graph. Travel time is accumulated tick
// progress over edge weights (never teleporting): traversing an edge of length
// L requires L * PROGRESS_SCALE progress, and each tick adds floor(speed/10)
// (speed is progress units per simulated second). Routing is A*/Dijkstra over
// the DYNAMIC graph, respecting broken cables and jammed doors. If the edge a
// drone is on becomes impassable mid-travel it falls back and re-plans; if no
// route exists the current task fails gracefully and the queue advances.

import { PROGRESS_SCALE, TaskType, Resource } from './models.mjs';
import { clearFailuresOnTarget } from './failures.mjs';

const WORK_PER_TICK = 5; // task work applied per tick once on-site

function edgePassable(conn) {
  return !!conn && !conn.broken && !conn.doorBlocked;
}

/** Passable connection directly between a and b (drone rules), or null. */
function connBetween(g, a, b) {
  for (const { conn, to } of g.neighbors(a)) {
    if (to === b && edgePassable(conn)) return conn;
  }
  return null;
}

/**
 * Deterministic drone-aware shortest path (skips broken + door-jammed edges).
 * @returns {string[]|null} node ids incl. endpoints, or null if unreachable.
 */
export function dronePath(g, fromId, toId) {
  if (!g.modules.has(fromId) || !g.modules.has(toId)) return null;
  if (fromId === toId) return [fromId];
  const dist = new Map();
  const prev = new Map();
  const remaining = new Set(g.modules.keys());
  for (const id of remaining) dist.set(id, Infinity);
  dist.set(fromId, 0);

  while (remaining.size) {
    let best = null, bestDist = Infinity;
    for (const id of remaining) {
      const d = dist.get(id);
      if (d < bestDist || (d === bestDist && best !== null && id < best)) {
        bestDist = d; best = id;
      }
    }
    if (best === null || bestDist === Infinity) break;
    remaining.delete(best);
    if (best === toId) break;
    for (const { conn, to } of g.neighbors(best)) {
      if (!edgePassable(conn)) continue;
      const nd = bestDist + conn.length;
      if (nd < dist.get(to)) { dist.set(to, nd); prev.set(to, best); }
    }
  }
  if (!prev.has(toId)) return null;
  const path = [toId];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur);
    if (p === undefined) return null;
    path.push(p);
    cur = p;
  }
  path.reverse();
  return path;
}

function droneNum(d) {
  const m = /(\d+)/.exec(d.id);
  return m ? m[1] : d.id;
}

/** Node ids at which a task can be performed. */
function taskTargetNodes(g, task) {
  if (task.type === TaskType.REPAIR_CONNECTION) {
    const c = g.getConnection(task.targetId);
    return c ? [c.a, c.b] : [];
  }
  const m = g.getModule(task.targetId);
  return m ? [task.targetId] : [];
}

function targetName(g, task) {
  if (task.type === TaskType.REPAIR_CONNECTION) return 'connection ' + task.targetId;
  const m = g.getModule(task.targetId);
  return m ? m.name : task.targetId;
}

/** Apply the real simulation effect of a completed task. */
function completeTask(state, engine, g, d, task) {
  const n = droneNum(d);
  switch (task.type) {
    case TaskType.REPAIR_CONNECTION: {
      const c = g.getConnection(task.targetId);
      clearFailuresOnTarget(state, engine, task.targetId);
      if (c) { c.broken = false; c.leaking = false; c.doorBlocked = false; g.invalidate(); }
      engine.logEvent(`Drone ${n} repaired connection ${task.targetId}.`, 'info');
      break;
    }
    case TaskType.REPAIR_MODULE: {
      const m = g.getModule(task.targetId);
      clearFailuresOnTarget(state, engine, task.targetId);
      if (m) { m.damage = 0; m.sensorFault = false; }
      engine.logEvent(`Drone ${n} repaired ${targetName(g, task)}.`, 'info');
      break;
    }
    case TaskType.EXTINGUISH_FIRE: {
      const m = g.getModule(task.targetId);
      clearFailuresOnTarget(state, engine, task.targetId, undefined);
      if (m) m.onFire = false;
      engine.logEvent(`Drone ${n} extinguished fire in ${targetName(g, task)}.`, 'info');
      break;
    }
    case TaskType.INSPECT_MODULE: {
      const m = g.getModule(task.targetId);
      if (m) {
        const pct = m.oxygenCapacity > 0 ? Math.floor((m.oxygen * 100) / m.oxygenCapacity) : 0;
        engine.logEvent(
          `Drone ${n} inspected ${m.name}: O2 ${pct}%, ${(m.temperature / 10).toFixed(1)}\u00B0C, dmg ${m.damage}%.`,
          'info');
      }
      break;
    }
    default:
      break;
  }
}

function perTick(d) { return Math.max(1, Math.floor(d.speed / 10)); }

function stepDrone(state, engine, g, d) {
  // 1. If mid-edge, validate the edge is still passable, else fall back+replan.
  if (d.edgeTo) {
    const conn = connBetween(g, d.edgeFrom, d.edgeTo);
    if (!conn) {
      d.atNode = d.edgeFrom;
      d.edgeFrom = null; d.edgeTo = null; d.edgeProgress = 0; d.route = [];
      engine.logEvent(`Drone ${droneNum(d)} rerouting \u2014 path blocked mid-transit.`, 'warn');
    } else {
      d.edgeProgress += perTick(d);
      if (d.edgeProgress >= conn.length * PROGRESS_SCALE) {
        d.atNode = d.edgeTo;
        d.edgeFrom = null; d.edgeTo = null; d.edgeProgress = 0;
        if (d.route.length && d.route[0] === d.atNode) d.route.shift();
      }
      d.busy = true;
      return; // consumed this tick travelling
    }
  }

  const task = d.queue.head();
  if (!task) { d.busy = false; d.route = []; return; }
  d.busy = true;

  const targets = taskTargetNodes(g, task);

  // 2. On-site: perform work.
  if (targets.indexOf(d.atNode) !== -1) {
    task.progress += WORK_PER_TICK;
    if (task.progress >= task.workRequired) {
      completeTask(state, engine, g, d, task);
      d.queue.tasks.shift();
      d.route = [];
    }
    return;
  }

  // 3. Ensure a valid route to the nearest reachable target.
  const routeOk = d.route.length > 0
    && targets.indexOf(d.route[d.route.length - 1]) !== -1
    && connBetween(g, d.atNode, d.route[0]);
  if (!routeOk) {
    let best = null;
    for (const t of targets) {
      const p = dronePath(g, d.atNode, t);
      if (p && p.length >= 2 && (!best || p.length < best.length)) best = p;
    }
    if (!best) {
      task.failed = true;
      engine.logEvent(`Drone ${droneNum(d)} task failed \u2014 no route to ${targetName(g, task)}.`, 'warn');
      d.queue.tasks.shift();
      d.route = [];
      return;
    }
    d.route = best.slice(1);
  }

  // 4. Begin the next edge (counts as this tick's progress).
  const next = d.route[0];
  const conn = connBetween(g, d.atNode, next);
  if (!conn) { d.route = []; return; } // recompute next tick
  d.edgeFrom = d.atNode;
  d.edgeTo = next;
  d.edgeProgress = perTick(d);
  if (d.edgeProgress >= conn.length * PROGRESS_SCALE) {
    d.atNode = next;
    d.edgeFrom = null; d.edgeTo = null; d.edgeProgress = 0;
    if (d.route.length && d.route[0] === next) d.route.shift();
  }
}

/**
 * Advance every drone by one tick (deterministic id order).
 * @param {import('./engine.mjs').SimState} state
 * @param {import('./engine.mjs').Engine} engine
 */
export function stepDrones(state, engine) {
  const g = state.graph;
  for (const d of state.droneList()) stepDrone(state, engine, g, d);
}

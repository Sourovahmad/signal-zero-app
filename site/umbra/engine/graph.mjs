// SIGNAL ZERO - station graph + deterministic shortest-path routing
//
// Modules are nodes, connections are edges. Edge weight = connection.length
// (integer >= 1). Broken connections are treated as absent. Routing uses
// Dijkstra with a deterministic tie-break (lower node id string) so that the
// same graph always yields the same path.

import { Module, Connection } from './models.mjs';

export class StationGraph {
  constructor() {
    this.modules = new Map();      // id -> Module
    this.connections = new Map();  // id -> Connection
    this._adj = null;              // id -> [{conn, to}] (rebuilt lazily)
  }

  addModule(module) {
    this.modules.set(module.id, module);
    this._adj = null;
    return module;
  }

  addConnection(conn) {
    this.connections.set(conn.id, conn);
    this._adj = null;
    return conn;
  }

  getModule(id) { return this.modules.get(id); }
  getConnection(id) { return this.connections.get(id); }

  moduleList() {
    return [...this.modules.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  connectionList() {
    return [...this.connections.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  invalidate() { this._adj = null; }

  _buildAdj() {
    const adj = new Map();
    for (const id of this.modules.keys()) adj.set(id, []);
    // Deterministic order of edges.
    for (const conn of this.connectionList()) {
      if (conn.broken) continue;
      if (!adj.has(conn.a) || !adj.has(conn.b)) continue;
      adj.get(conn.a).push({ conn, to: conn.b });
      adj.get(conn.b).push({ conn, to: conn.a });
    }
    // Sort neighbours deterministically.
    for (const list of adj.values()) {
      list.sort((x, y) => (x.to < y.to ? -1 : x.to > y.to ? 1 : 0));
    }
    this._adj = adj;
    return adj;
  }

  neighbors(id) {
    if (!this._adj) this._buildAdj();
    return this._adj.get(id) || [];
  }

  /**
   * Dijkstra shortest path from -> to over non-broken edges.
   * @returns {string[]|null} list of node ids incl. endpoints, or null.
   */
  shortestPath(fromId, toId) {
    if (!this.modules.has(fromId) || !this.modules.has(toId)) return null;
    if (fromId === toId) return [fromId];
    if (!this._adj) this._buildAdj();

    const dist = new Map();
    const prev = new Map();
    for (const id of this.modules.keys()) dist.set(id, Infinity);
    dist.set(fromId, 0);

    // Simple array-based priority selection; graphs here are modest and this
    // keeps behaviour fully deterministic without heap tie-break subtleties.
    const visited = new Set();
    const remaining = new Set(this.modules.keys());

    while (remaining.size) {
      // Pick min-dist node, deterministic tie-break by id.
      let best = null;
      let bestDist = Infinity;
      for (const id of remaining) {
        const d = dist.get(id);
        if (d < bestDist || (d === bestDist && best !== null && id < best)) {
          bestDist = d; best = id;
        }
      }
      if (best === null || bestDist === Infinity) break;
      remaining.delete(best);
      visited.add(best);
      if (best === toId) break;

      for (const { conn, to } of this.neighbors(best)) {
        if (visited.has(to)) continue;
        const nd = bestDist + conn.length;
        const cur = dist.get(to);
        if (nd < cur || (nd === cur && best < (prev.get(to) || ''))) {
          dist.set(to, nd);
          prev.set(to, best);
        }
      }
    }

    if (!prev.has(toId) && fromId !== toId) return null;
    // Reconstruct.
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

  /** Distance (sum of edge lengths) of a shortest path, or Infinity. */
  distance(fromId, toId) {
    const path = this.shortestPath(fromId, toId);
    if (!path) return Infinity;
    let d = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const c = this._edgeBetween(path[i], path[i + 1]);
      d += c ? c.length : 0;
    }
    return d;
  }

  _edgeBetween(a, b) {
    for (const { conn, to } of this.neighbors(a)) {
      if (to === b) return conn;
    }
    return null;
  }

  edgeBetween(a, b) { return this._edgeBetween(a, b); }

  /** Connected-component check for the disconnected-graph edge case. */
  isConnected() {
    const ids = [...this.modules.keys()];
    if (ids.length <= 1) return true;
    const seen = new Set();
    const stack = [ids[0].toString()];
    seen.add(ids[0]);
    while (stack.length) {
      const cur = stack.pop();
      for (const { to } of this.neighbors(cur)) {
        if (!seen.has(to)) { seen.add(to); stack.push(to); }
      }
    }
    return seen.size === this.modules.size;
  }

  toJSON() {
    return {
      modules: this.moduleList().map(m => m.toJSON()),
      connections: this.connectionList().map(c => c.toJSON()),
    };
  }

  static fromJSON(o) {
    const g = new StationGraph();
    for (const m of o.modules) g.addModule(Module.fromJSON(m));
    for (const c of o.connections) g.addConnection(Connection.fromJSON(c));
    return g;
  }
}

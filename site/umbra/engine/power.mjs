// SIGNAL ZERO - capacity-constrained POWER flow solver
//
// Reactor output is distributed to modules by descending priority tier
// (Critical > High > Normal > Low). Flow travels along POWER-carrying
// connections, each limited by its integer capacity. When demand exceeds the
// power that can be routed, lower-priority modules lose power first, and
// within a tier a module may be partially served up to what the network can
// deliver.
//
// Method: prioritised greedy augmenting paths (integer max-flow style) over a
// residual graph. Fully deterministic: sinks handled in (tier, id) order and
// augmenting paths chosen by Dijkstra with an id tie-break.

import { PRIORITY_ORDER, Resource } from './models.mjs';

/**
 * Solve power distribution over the graph, writing powerReceived onto each
 * module. Returns a summary object (integers only).
 * @param {import('./graph.mjs').StationGraph} graph
 */
export function solvePower(graph) {
  const modules = graph.moduleList();

  // Reset receipts and gather reactor residual output.
  const reactorResidual = new Map(); // moduleId -> residual output
  let totalOutput = 0;
  let totalDemand = 0;
  for (const m of modules) {
    m.powerReceived = 0;
    if (m.isReactor && m.reactorOutput > 0) {
      reactorResidual.set(m.id, m.reactorOutput);
      totalOutput += m.reactorOutput;
    }
    if (m.powerDemand > 0) totalDemand += m.powerDemand;
  }

  // Residual capacity per POWER connection.
  const residualCap = new Map();
  for (const c of graph.connectionList()) {
    if (c.carries(Resource.POWER)) residualCap.set(c.id, c.capacity);
  }

  let delivered = 0;
  let residualTotal = totalOutput; // remaining routable power across reactors

  outer:
  for (const tier of PRIORITY_ORDER) {
    if (residualTotal <= 0) break;
    const sinks = modules
      .filter(m => m.priority === tier && m.powerDemand > 0)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const sink of sinks) {
      if (residualTotal <= 0) break outer;
      let need = sink.powerDemand - sink.powerReceived;

      // A reactor module powers its own demand directly (no edge needed).
      if (need > 0 && reactorResidual.has(sink.id)) {
        const local = Math.min(need, reactorResidual.get(sink.id));
        if (local > 0) {
          reactorResidual.set(sink.id, reactorResidual.get(sink.id) - local);
          sink.powerReceived += local;
          delivered += local;
          residualTotal -= local;
          need -= local;
        }
      }

      // Route remaining demand from reactors across the network.
      while (need > 0 && residualTotal > 0) {
        const aug = findAugmentingPath(graph, sink.id, reactorResidual, residualCap);
        if (!aug) break;
        const { reactorId, edges, bottleneck } = aug;
        const push = Math.min(need, bottleneck, reactorResidual.get(reactorId));
        if (push <= 0) break;
        // Apply flow.
        reactorResidual.set(reactorId, reactorResidual.get(reactorId) - push);
        for (const eid of edges) residualCap.set(eid, residualCap.get(eid) - push);
        sink.powerReceived += push;
        delivered += push;
        residualTotal -= push;
        need -= push;
      }
    }
  }

  const available = totalOutput;
  return {
    totalOutput,
    totalDemand,
    delivered,
    available,
    deficit: Math.max(0, totalDemand - delivered),
  };
}

/**
 * Dijkstra from the sink outward over residual POWER edges to the nearest
 * reactor with residual output. Deterministic tie-break by node id.
 * @returns {{reactorId:string, edges:string[], bottleneck:number}|null}
 */
function findAugmentingPath(graph, sinkId, reactorResidual, residualCap) {
  const dist = new Map();
  const prevNode = new Map();
  const prevEdge = new Map();
  const remaining = new Set(graph.modules.keys());
  for (const id of remaining) dist.set(id, Infinity);
  dist.set(sinkId, 0);

  let foundReactor = null;

  while (remaining.size) {
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

    if (best !== sinkId && reactorResidual.has(best) && reactorResidual.get(best) > 0) {
      foundReactor = best;
      break;
    }

    for (const { conn, to } of graph.neighbors(best)) {
      if (!conn.carries(Resource.POWER)) continue;
      const cap = residualCap.get(conn.id);
      if (!(cap > 0)) continue;
      const nd = bestDist + conn.length;
      if (nd < dist.get(to)) {
        dist.set(to, nd);
        prevNode.set(to, best);
        prevEdge.set(to, conn.id);
      }
    }
  }

  if (!foundReactor) return null;

  // Reconstruct reactor -> sink path, compute bottleneck.
  const edges = [];
  let cur = foundReactor;
  let bottleneck = Infinity;
  while (cur !== sinkId) {
    const eid = prevEdge.get(cur);
    if (eid === undefined) return null;
    edges.push(eid);
    bottleneck = Math.min(bottleneck, residualCap.get(eid));
    cur = prevNode.get(cur);
  }
  return { reactorId: foundReactor, edges, bottleneck };
}

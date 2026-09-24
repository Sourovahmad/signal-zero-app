// SIGNAL ZERO - headless benchmark CLI
//
//   node tests/benchmark.mjs [ticks] [seed]
//
// Runs the 10-minute stress scenario (100 modules / 250 connections /
// 50 failures / 3 drones) and prints execution time, ticks executed and a
// deterministic final-state checksum.

import { runBenchmark } from '../umbra/engine/benchmark.mjs';

const args = process.argv.slice(2);
const ticks = args[0] ? parseInt(args[0], 10) : 6000;
const seed = args[1] ? parseInt(args[1], 10) : 20240501;

const r = runBenchmark({ ticks, seed });

/* eslint-disable no-console */
console.log('SIGNAL ZERO :: BENCHMARK');
console.log('  seed                :', r.seed);
console.log('  modules             :', r.moduleCount);
console.log('  connections         :', r.connectionCount);
console.log('  failures            :', r.failureCount);
console.log('  drones              :', r.droneCount);
console.log('  simulation ticks    :', r.ticksExecuted, '(' + (r.ticksExecuted / 10) + ' sim seconds)');
console.log('  execution time (ms) :', r.executionMs);
console.log('  final checksum      :', r.checksumHex, '(' + r.checksum + ')');
console.log('  power delivered     :', r.lastPower.delivered, '/', r.lastPower.totalDemand);

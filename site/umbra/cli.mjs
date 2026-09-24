// SIGNAL ZERO - headless command-line interface
//
//   node umbra/cli.mjs <command> [args]
//
// This is the JavaScript/Electron equivalent of the brief's `python -m
// signalzero benchmark`. Every subcommand is fully headless (imports only the
// UI-free engine) and deterministic.
//
// Commands:
//   benchmark [ticks] [seed]   10-minute large-station stress run + checksum
//   seven [seed]               run the "Seven Minutes" scenario to a verdict
//   replay [seed] [ticks]      record + replay self-test (checksum must match)
//   help                       usage

import { runBenchmark } from './engine/benchmark.mjs';
import { Engine, checksum, Commands, Priority, formatSimTime } from './engine/index.mjs';
import { BlackBox, verifyReplay } from './engine/replay.mjs';
import { buildSevenMinutes } from './engine/fixtures.mjs';

/* eslint-disable no-console */

function cmdBenchmark(args) {
  const ticks = args[0] ? parseInt(args[0], 10) : 6000;
  const seed = args[1] ? parseInt(args[1], 10) : 20240501;
  const r = runBenchmark({ ticks, seed });
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
  return 0;
}

function cmdSeven(args) {
  const seed = args[0] ? parseInt(args[0], 10) : 70000;
  const cfg = buildSevenMinutes(seed);
  const eng = Engine.create(cfg);
  eng.run(cfg.goalTicks);
  const d = eng.dashboard();
  console.log('SIGNAL ZERO :: SEVEN MINUTES (headless, no player intervention)');
  console.log('  seed             :', seed);
  console.log('  sim time reached :', d.simTime);
  console.log('  crew alive       :', d.crewAlive, '/', eng.state.initialCrew);
  console.log('  reactor temp     :', d.reactorTempC.toFixed(1) + ' C');
  console.log('  avg oxygen       :', d.avgOxygenPct + '%');
  console.log('  active failures  :', d.activeFailures);
  console.log('  final checksum   :', '0x' + checksum(eng.snapshot()).toString(16).padStart(8, '0'));
  console.log('  VERDICT          :', d.outcome.toUpperCase());
  return 0;
}

function cmdReplay(args) {
  const seed = args[0] ? parseInt(args[0], 10) : 70000;
  const ticks = args[1] ? parseInt(args[1], 10) : 1500;

  // Record: create a session, script a few timestamped player commands, run.
  const cfg = buildSevenMinutes(seed);
  const eng = Engine.create(cfg);
  eng.schedule(Commands.setPriority(30, 'laboratory', Priority.CRITICAL));
  eng.schedule(Commands.setPriority(120, 'command', Priority.LOW));
  eng.schedule(Commands.addTask(50, 'drone-2', { type: 'inspect_module', targetId: 'oxygen' }));
  eng.schedule(Commands.addTask(200, 'drone-1', { type: 'repair_connection', targetId: 'C7' }));
  eng.run(ticks);

  const original = checksum(eng.snapshot());
  const box = BlackBox.fromEngine(eng, cfg);

  // Round-trip through serialised JSON to prove the recording is portable.
  const restored = BlackBox.fromJSON(box.serialize());
  const res = verifyReplay(restored, original);

  console.log('SIGNAL ZERO :: REPLAY SELF-TEST');
  console.log('  seed             :', seed);
  console.log('  ticks            :', ticks, '(' + formatSimTime(ticks) + ')');
  console.log('  commands         :', box.commandCount);
  console.log('  original checksum:', '0x' + original.toString(16).padStart(8, '0'));
  console.log('  replay checksum  :', '0x' + res.checksum.toString(16).padStart(8, '0'));
  console.log('  RESULT           :', res.match ? 'MATCH \u2713' : 'MISMATCH \u2717');
  return res.match ? 0 : 1;
}

function cmdHelp() {
  console.log([
    'SIGNAL ZERO :: headless CLI',
    '',
    '  node umbra/cli.mjs benchmark [ticks] [seed]   10-min stress run + checksum',
    '  node umbra/cli.mjs seven [seed]               run Seven Minutes to a verdict',
    '  node umbra/cli.mjs replay [seed] [ticks]      record + replay self-test',
    '  node umbra/cli.mjs help                       this message',
  ].join('\n'));
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
let code = 0;
switch ((cmd || 'help').toLowerCase()) {
  case 'benchmark': code = cmdBenchmark(rest); break;
  case 'seven': case 'sevenminutes': case 'seven-minutes': code = cmdSeven(rest); break;
  case 'replay': case 'replay-selftest': code = cmdReplay(rest); break;
  case 'help': case '--help': case '-h': default: code = cmdHelp(); break;
}
process.exit(code);

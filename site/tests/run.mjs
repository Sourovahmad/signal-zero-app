// SIGNAL ZERO - headless test runner
//
//   node tests/run.mjs
//
// Registers the suite (via import side-effect) then runs it, printing each
// result and exiting non-zero on any failure so CI can gate on it.

import './tests.mjs';
import { run } from './harness.mjs';

const { failed } = await run((line) => {
  // eslint-disable-next-line no-console
  console.log(line);
});

process.exit(failed === 0 ? 0 : 1);

// SIGNAL ZERO - minimal deterministic test harness (pytest-equivalent)
//
// Framework-free so it runs identically under Node and inside the Electron
// renderer. Collect tests with test(), assert with the helpers, run with run().

const registry = [];

export function test(name, fn) {
  registry.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + (msg || ''));
}

export function assertEqual(a, b, msg) {
  const sa = stable(a), sb = stable(b);
  if (sa !== sb) {
    throw new Error(
      'expected equal:\n  a = ' + sa + '\n  b = ' + sb + (msg ? '\n  (' + msg + ')' : '')
    );
  }
}

export function assertNotEqual(a, b, msg) {
  if (stable(a) === stable(b)) {
    throw new Error('expected different values' + (msg ? ' (' + msg + ')' : ''));
  }
}

export function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} within ${tol} of ${b}` + (msg ? ' (' + msg + ')' : ''));
  }
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

/**
 * Run all registered tests.
 * @param {(line:string, ok:boolean)=>void} [report] optional line sink
 * @returns {Promise<{passed:number, failed:number, total:number, lines:string[]}>}
 */
export async function run(report) {
  const lines = [];
  let passed = 0, failed = 0;
  const emit = (line, ok) => { lines.push(line); if (report) report(line, ok); };
  for (const { name, fn } of registry) {
    try {
      await fn();
      passed++;
      emit('PASS  ' + name, true);
    } catch (err) {
      failed++;
      emit('FAIL  ' + name + '  ->  ' + (err && err.message ? err.message : err), false);
    }
  }
  emit(`\n${passed}/${registry.length} passed, ${failed} failed`, failed === 0);
  return { passed, failed, total: registry.length, lines };
}

export function clearRegistry() { registry.length = 0; }

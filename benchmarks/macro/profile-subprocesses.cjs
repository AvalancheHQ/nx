const childProcess = require('node:child_process');

// Nx starts daemons and plugin workers with fresh argv. Preserve the benchmark's
// V8 profiling and heap flags in those descendants.
// Keep NODE_OPTIONS intact because it can contain runner instrumentation;
// some V8 options are only accepted on the Node command line.
const spawn = childProcess.spawn;
const profilingArgs = process.execArgv;
childProcess.spawn = function (command, args, options) {
  if (
    command === process.execPath &&
    Array.isArray(args) &&
    !args.includes(__filename)
  ) {
    return spawn.call(this, command, [...profilingArgs, ...args], options);
  }
  return spawn.call(this, command, args, options);
};

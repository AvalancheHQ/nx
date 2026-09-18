const childProcess = require('node:child_process');

// Nx deliberately starts daemons/plugin workers with fresh argv. Preserve the
// benchmark's CodSpeed V8 flags in those descendants too: otherwise their work
// has no useful JS symbols, and simulation loses its deterministic V8 settings.
// Do not use NODE_OPTIONS: it may contain runner instrumentation already, and
// several simulation flags are only legal on the Node command line.
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

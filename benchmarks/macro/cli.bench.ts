import { afterEach, beforeEach, bench, describe } from 'vitest';
import {
  BenchmarkWorkspace,
  cachedTasksCommand,
  graphCommand,
} from './workspace';

// Vitest uses its bundled Tinybench 2.x, independently of the standalone
// Tinybench micros. setup/teardown run once per warmup/run phase, NOT per sample.
// Install Tinybench's task hooks for walltime, and use suite hooks for CodSpeed's
// analysis runner, which calls the benchmark directly instead of Task.run().
// Both paths therefore prepare every invocation outside its timing boundary.
// The beta.2 walltime profiler spans the full loop (including these hooks),
// although the reported latency samples exclude the hooks.
function cliBenchmark(
  name: string,
  options: { daemon: boolean; cold?: boolean; cachedTasks?: boolean }
): void {
  describe(name, () => {
    let workspace: BenchmarkWorkspace;
    let output: string;

    function prepareIteration(): void {
      try {
        if (options.cold) workspace.reset();
        if (options.cachedTasks) workspace.removeTaskOutputs();
        if (options.daemon && !options.cold) workspace.assertDaemonReady();
      } catch (error) {
        workspace.close();
        throw error;
      }
    }

    function finishIteration(): void {
      try {
        if (options.cachedTasks) workspace.assertCachedTasks(output);
        else workspace.assertGraph(output);
        if (options.cold && options.daemon) workspace.stopDaemon();
      } catch (error) {
        workspace.close();
        throw error;
      }
    }

    beforeEach(prepareIteration);
    afterEach(finishIteration);

    bench(
      options.cachedTasks
        ? 'run-many copy / all local-cache hits'
        : 'show projects',
      async () => {
        try {
          output = workspace.run(
            options.cachedTasks ? cachedTasksCommand : graphCommand
          );
        } catch (error) {
          // CodSpeed's analysis runner does not run teardown if fn() throws.
          workspace.close();
          throw error;
        }
      },
      {
        iterations: 10,
        time: 0,
        warmupIterations: 1,
        warmupTime: 0,
        throws: true,
        setup(task) {
          workspace = new BenchmarkWorkspace(options.daemon);
          try {
            if (!options.cold) {
              // Start AND populate the daemon from this instrumented runner's
              // ancestry, never from workflow setup or an external nx process.
              // Completion of this graph request is the readiness barrier.
              workspace.assertGraph(workspace.run(graphCommand));
            }
            if (options.cachedTasks) workspace.run(cachedTasksCommand);
            if (!task)
              throw new Error('Vitest did not provide a Tinybench task');
            task.opts.beforeEach = prepareIteration;
            task.opts.afterEach = finishIteration;
          } catch (error) {
            workspace.close();
            throw error;
          }
        },
        teardown() {
          workspace.close();
        },
      }
    );
  });
}

describe('nx macro / 1110 projects', () => {
  cliBenchmark('graph cold / daemon=false', { daemon: false, cold: true });
  cliBenchmark('graph cold / daemon=true', { daemon: true, cold: true });
  cliBenchmark('graph warm / daemon=false', { daemon: false });
  cliBenchmark('graph warm / daemon=true', { daemon: true });
  cliBenchmark('cached tasks / daemon=false / parallel=1', {
    daemon: false,
    cachedTasks: true,
  });
});

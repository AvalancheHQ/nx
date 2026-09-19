import { bench, describe } from 'vitest';
import {
  BenchmarkWorkspace,
  cachedTasksCommand,
  graphCommand,
} from './workspace';

// Vitest uses its bundled Tinybench 2.x, independently of the standalone
// Tinybench micros. setup/teardown run once per warmup/run phase, NOT per sample.
// Install per-sample task hooks to keep preparation and validation outside the
// latency timer. The beta.2 walltime profile includes these hooks.
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
          workspace.close();
          throw error;
        }
      },
      {
        iterations: 30,
        time: 0,
        warmupIterations: 1,
        warmupTime: 0,
        throws: true,
        setup(task) {
          workspace = new BenchmarkWorkspace(options.daemon);
          try {
            if (!options.cold) {
              // Warm this phase's own workspace: Tinybench discards the warmup
              // workspace before measurement. Start the daemon under this
              // instrumented runner so child profiles remain available.
              for (let request = 0; request < 5; request++) {
                workspace.assertGraph(workspace.run(graphCommand));
              }
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

# Nx CLI Benchmarks

Synthetic workspace with 1110 projects arranged in a 3-level fan-out (10 groups x 10 subs x 10 leaves). Each project defines `build`, `copy`, and `cat` targets that operate on a shared `lorem.md` file — no real compilation, just enough I/O to exercise Nx's task pipeline.

## Workspace Targets

| Target    | Command                            | Cached | Outputs | Dependencies |
| --------- | ---------------------------------- | ------ | ------- | ------------ |
| **build** | `cp lorem.md → dist/output.md`     | Yes    | Yes     | `^build`     |
| **copy**  | `cp lorem.md → copy-out/output.md` | Yes    | Yes     | None         |
| **cat**   | `cat lorem.md`                     | Yes    | No      | None         |

## Quick Start

Prerequisites: [hyperfine](https://github.com/sharkdp/hyperfine) (`cargo install hyperfine`)

```bash
# Run all benchmarks and compare against goals + baseline
pnpm nx run benchmarks

# Run a single benchmark
pnpm nx bench:version benchmarks
pnpm nx bench:show-projects benchmarks
pnpm nx bench:cat-warm benchmarks
pnpm nx bench:copy-warm benchmarks
```

Each `bench:*` target depends on `^build` so the Nx packages are compiled first.

## Benchmarks

| Benchmark       | What it runs              | What it measures                                        |
| --------------- | ------------------------- | ------------------------------------------------------- |
| `version`       | `nx --version`            | CLI startup and module loading                          |
| `show-projects` | `nx show projects`        | Project graph construction via daemon                   |
| `cat-warm`      | `run-many -t cat` x1110   | Task scheduling + hashing with no output artifacts      |
| `copy-warm`     | `run-many -t copy` x1110  | Cached task execution with output tracking              |
| `build-warm`    | `run-many -t build` x1110 | Cached tasks with topological deps (currently disabled) |

All benchmarks use `NX_NO_CLOUD=true`, run `nx reset` before each iteration, and collect at least 5 runs (10 for `version`) via hyperfine.

## Goals and Baselines

Performance is tracked with two files:

- **`goals.json`** (committed) — target times the team agrees on. CI fails if a benchmark exceeds its goal.
- **`baseline.json`** (gitignored) — your local machine's numbers for personal comparison.

The `run-benchmarks.ts` script reads both and prints a table with colored deltas showing how the current run compares to each.

### Setting the Baseline

```bash
# First run auto-creates baseline.json
pnpm nx run benchmarks

# Explicitly overwrite with fresh numbers
pnpm nx run benchmarks -- --set-baseline
```

## How It Works

1. Each `bench:*` script invokes hyperfine and writes a `results-<name>.json` file.
2. The `run` target depends on all `bench:*` targets, so they execute in sequence (`parallelism: false`).
3. After all benchmarks finish, `run-benchmarks.ts` reads the result files and prints the comparison table.

## CI

Benchmarks run as part of the affected target pipeline in CI (`nx affected --targets=...bench`). The goals in `goals.json` act as the regression gate.

## CodSpeed benchmarks

Run the CodSpeed suites from the repository root with Node 22 or 24:

```bash
pnpm nx run-many -p benchmarks -t codspeed-micro,codspeed-tinybench,codspeed-macro --parallel=1
```

These targets build the local Nx package first and never cache benchmark results. The existing hyperfine targets remain independent.

| Target               | Workload                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `codspeed-micro`     | Vitest project matching across 2,000 projects, including tags, exclusions, and directories                      |
| `codspeed-tinybench` | Tinybench `projectsToRun` pattern matching and exclusions across 10,000 projects                                |
| `codspeed-macro`     | CLI graph computation across 11,100 projects, cold/warm with daemon on/off, plus cached task output restoration |

The macro suite creates 10 namespaced copies of the checked-in fixture in each temporary workspace.
Project names and implicit dependencies stay within their copy.
It invokes the built Nx CLI directly, without downloading a workspace
or benchmarking a published Nx version.
Each walltime case takes 30 samples after one warmup iteration.

- Cold cases reset Nx before each sample, outside the timer. “Cold” refers to Nx caches, not the OS page cache.
- Warm cases issue five untimed graph requests in their measurement workspace as well as their separate warmup workspace. Daemon cases fail if Nx falls back to daemonless execution.
- The cached task case populates the local cache first and removes outputs before each sample.
  It then checks that all 11,100 tasks restore their outputs from cache.
  Task parallelism is fixed at one.
- CLI stdout goes to a file outside the watched workspace.
  Node writes synchronously to files, avoiding truncated output when a process exits.
  Timing includes output capture and reading, but excludes graph and cache validation.
- Macro Nx processes use `--initial-old-space-size=256` with
  `--min-semi-space-size=64 --max-semi-space-size=64`.
  The larger initial heap trades memory for fewer early garbage collections.
  On Node 24, `--external-memory-accounted-in-global-limit` counts external allocations
  against the global heap budget instead of a separate external-memory limit.
- Nx Cloud is disabled.
  Daemon status checks use `NX_USE_LOCAL=true` to avoid fetching
  `nx@latest` during measurements.
  Each case owns its cache and daemon and removes its temporary workspace on completion.

### CI and profiles

`.github/workflows/codspeed.yml` runs on pull requests, pushes to `master`, and manual dispatches. It measures the two microbenchmarks with CPU simulation and all five macrobenchmarks with walltime on the `codspeed-macro-x64-ryzen-9950x-ubuntu-24-04` runner. Both jobs use CodSpeed runner v5.3.1.

The workflow pins Node 24 and the CodSpeed Node plugins. The plugins currently use `6.0.0-beta.2` for Node 22/24 and Vite 8 support. The Tinybench entry point relaunches Node with the V8 flags required by the plugin when instrumentation is enabled. The macro preload forwards profiling flags to the Nx daemon and plugin processes. Walltime keeps the JIT enabled. Rust builds retain debug information for native source locations.

Child-process V8 logs and JIT dumps stay outside the temporary workspace so profiling cannot trigger daemon graph rebuilds. They remain available after fixture cleanup for symbolication.

CodSpeed collects profiles automatically. With the pinned plugin, walltime profiles cover the entire sampling loop, including per-sample reset and validation hooks. Reported latency samples exclude those hooks.

Download the workflow's `codspeed-macro-walltime-*` artifact to compare `results-codspeed-macro.json` between repeated runs of the same commit. The report contains each case's minimum, mean, standard deviation, and sample count. Vitest omits individual samples from its JSON report.

For walltime stability, calculate the coefficient of variation (CV) across per-run minima: divide their sample standard deviation by their mean and multiply by 100. Keep the sample count, runner label, and Node version fixed. Increasing the sample count can lower the minimum without making the code faster, so establish a new baseline when changing it.

The first successful `master` run establishes the baseline for that repository. A fork's baseline doesn't replace the upstream baseline. Upstream needs a successful run after the workflow lands.

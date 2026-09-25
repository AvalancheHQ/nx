import { getV8Flags } from '@codspeed/core';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureSource = fileURLToPath(new URL('../', import.meta.url));
const nxPackage = fileURLToPath(new URL('../../packages/nx/', import.meta.url));
const nxCli = join(nxPackage, 'dist/bin/nx.js');
const fixtureCopies = 10;
export const projectCount = 1110 * fixtureCopies;
const nodeArgs = getV8Flags();
// Limit early heap growth in the short-lived CLI processes for this fixture.
nodeArgs.push(
  '--initial-old-space-size=256',
  '--min-semi-space-size=64',
  '--max-semi-space-size=64'
);
// Node 22 lacks this flag. Charge IPC buffers to the global memory budget.
if (process.versions.node.startsWith('24.')) {
  nodeArgs.push('--external-memory-accounted-in-global-limit');
}
if (nodeArgs.includes('--perf-prof')) {
  // Profiler writes must not invalidate the daemon's watched graph, and the
  // files must survive fixture cleanup until CodSpeed symbolizes the run.
  const profileDirectory =
    process.env.CODSPEED_V8_LOG ??
    process.env.CODSPEED_PROFILE_FOLDER ??
    tmpdir();
  mkdirSync(profileDirectory, { recursive: true });
  nodeArgs.push(`--perf-prof-path=${profileDirectory}`);
  if (!process.env.CODSPEED_V8_LOG) {
    nodeArgs.push(
      '--no-logfile-per-isolate',
      `--logfile=${join(profileDirectory, 'codspeed-v8-%p.log')}`
    );
  }
}
nodeArgs.push(
  '--require',
  fileURLToPath(new URL('./profile-subprocesses.cjs', import.meta.url))
);

export const graphCommand = ['show', 'projects', '--json'];
export const cachedTasksCommand = [
  'run-many',
  '--target=copy',
  '--parallel=1',
  '--outputStyle=static',
];

export class BenchmarkWorkspace {
  readonly root: string;
  private readonly scratchDirectory: string;
  private readonly outputFile: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly outputDirectories: string[] = [];
  private closed = false;
  private readonly onExit = () => {
    try {
      this.close();
    } catch (error) {
      console.error('Failed to clean up the macro benchmark workspace', error);
      process.exitCode = 1;
    }
  };

  constructor(readonly daemon: boolean) {
    if (!existsSync(nxCli)) {
      throw new Error(
        `Build the local nx package before benchmarking: ${nxCli}`
      );
    }
    this.scratchDirectory = mkdtempSync(join(tmpdir(), 'nx-cs-'));
    this.root = join(this.scratchDirectory, 'workspace');
    this.outputFile = join(this.scratchDirectory, 'stdout');
    this.env = {
      ...process.env,
      NX_WORKSPACE_ROOT_PATH: this.root,
      NX_DAEMON: String(daemon),
      NX_NO_CLOUD: 'true',
      // Keep daemon status checks local; fetching nx@latest adds unrelated work.
      NX_USE_LOCAL: 'true',
      NX_SKIP_NX_CACHE: 'false',
      NX_SKIP_REMOTE_CACHE: 'true',
      NX_CACHE_PROJECT_GRAPH: 'true',
      NX_CACHE_DIRECTORY: join(this.root, '.nx/cache'),
      NX_WORKSPACE_DATA_DIRECTORY: join(this.root, '.nx/workspace-data'),
      NX_NATIVE_FILE_CACHE_DIRECTORY: join(this.root, '.nx/native'),
      NX_SOCKET_DIR: join(this.scratchDirectory, 's'),
      NX_DAEMON_VERBOSE_LOGGING: 'false',
      NX_VERBOSE_LOGGING: 'false',
      NX_PERF_LOGGING: 'false',
      NX_TUI: 'false',
      NX_INTERACTIVE: 'false',
      NX_LOAD_DOT_ENV_FILES: 'false',
      FORCE_COLOR: '0',
    };
    // Keep NODE_OPTIONS and all CodSpeed variables inherited from the runner.
    // The fixture is never an Nx task child, even when this suite is an Nx target.
    for (const key of Object.keys(this.env)) {
      if (key.startsWith('NX_TASK_')) delete this.env[key];
    }
    delete this.env.NX_NATIVE_LOGGING;
    delete this.env.NX_PROFILE;
    delete this.env.NX_TERMINAL_OUTPUT_PATH;

    process.once('exit', this.onExit);
    try {
      mkdirSync(this.root);
      for (const file of ['nx.json', 'lorem.md', '.gitignore']) {
        cpSync(join(fixtureSource, file), join(this.root, file));
      }
      for (let copy = 0; copy < fixtureCopies; copy++) {
        const namespace = `workspace-${copy}`;
        const destination = join(this.root, 'packages', namespace);
        cpSync(join(fixtureSource, 'packages'), destination, {
          recursive: true,
          filter: (source) =>
            !['dist', 'copy-out', 'node_modules', '.nx'].includes(
              basename(source)
            ),
        });
        this.prepareProjects(destination, namespace);
      }
      const { version } = JSON.parse(
        readFileSync(join(nxPackage, 'package.json'), 'utf8')
      );
      // Do not copy benchmarks/package.json's Nx targets into the scratch fixture.
      writeFileSync(
        join(this.root, 'package.json'),
        JSON.stringify({ private: true, dependencies: { nx: version } })
      );
      mkdirSync(join(this.root, 'node_modules'));
      symlinkSync(nxPackage, join(this.root, 'node_modules/nx'), 'dir');
      if (this.outputDirectories.length !== projectCount) {
        throw new Error(`Expected ${projectCount} fixture projects`);
      }
    } catch (error) {
      rmSync(this.scratchDirectory, { recursive: true, force: true });
      process.removeListener('exit', this.onExit);
      throw error;
    }
  }

  run(args: string[]): string {
    // File-backed stdout is synchronous in Node on POSIX. Keep it outside the
    // watched workspace and retain the complete output for cache validation.
    const stdout = openSync(this.outputFile, 'w');
    try {
      execFileSync(process.execPath, [...nodeArgs, nxCli, ...args], {
        cwd: this.root,
        env: this.env,
        encoding: 'utf8',
        stdio: ['ignore', stdout, 'pipe'],
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return readFileSync(this.outputFile, 'utf8');
    } finally {
      closeSync(stdout);
    }
  }

  reset(): void {
    // NX_DAEMON=false makes `nx reset` skip stopping a daemon; force it on
    // for lifecycle commands, regardless of the case being measured.
    this.runWithDaemon(['reset']);
  }

  assertGraph(output: string): void {
    const projects: string[] = JSON.parse(output);
    if (
      projects.length !== projectCount ||
      new Set(projects).size !== projectCount
    ) {
      throw new Error(`Expected the graph to contain ${projectCount} projects`);
    }
    if (this.daemon) this.assertDaemonReady();
  }

  assertDaemonReady(): void {
    const cache = join(this.root, '.nx/workspace-data/d/server-process.json');
    if (!existsSync(cache)) {
      throw new Error(
        `Nx fell back to daemonless graph computation in ${this.root}`
      );
    }
    const { processId, socketPath } = JSON.parse(readFileSync(cache, 'utf8'));
    process.kill(processId, 0);
    if (!existsSync(socketPath)) {
      throw new Error(`Nx daemon socket is missing: ${socketPath}`);
    }
  }

  removeTaskOutputs(): void {
    for (const directory of this.outputDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  assertCachedTasks(output: string): void {
    if (!output.includes(`for ${projectCount} out of ${projectCount} tasks`)) {
      throw new Error(
        `Expected every copy task to be served from local cache:\n${output}`
      );
    }
    for (const directory of this.outputDirectories) {
      if (!existsSync(join(directory, 'output.md'))) {
        throw new Error(`Cached task did not restore ${directory}/output.md`);
      }
    }
  }

  stopDaemon(): void {
    this.runWithDaemon(['daemon', '--stop']);
  }

  close(): void {
    if (this.closed) return;
    // Do not delete a live daemon's process record if stopping it fails.
    this.stopDaemon();
    rmSync(this.scratchDirectory, { recursive: true, force: true });
    this.closed = true;
    process.removeListener('exit', this.onExit);
  }

  private runWithDaemon(args: string[]): void {
    execFileSync(process.execPath, [...nodeArgs, nxCli, ...args], {
      cwd: this.root,
      env: { ...this.env, NX_DAEMON: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  }

  private prepareProjects(directory: string, namespace: string): void {
    const projectFile = join(directory, 'project.json');
    if (existsSync(projectFile)) {
      const project = JSON.parse(readFileSync(projectFile, 'utf8'));
      project.name = `${namespace}-${project.name}`;
      if (project.implicitDependencies) {
        project.implicitDependencies = project.implicitDependencies.map(
          (dependency: string) => `${namespace}-${dependency}`
        );
      }
      writeFileSync(projectFile, JSON.stringify(project));
      this.outputDirectories.push(join(directory, 'copy-out'));
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        this.prepareProjects(join(directory, entry.name), namespace);
      }
    }
  }
}

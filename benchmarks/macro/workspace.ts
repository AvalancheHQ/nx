import { getV8Flags } from '@codspeed/core';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const projectCount = 1110;
const nodeArgs = getV8Flags();
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
    this.root = mkdtempSync(join(tmpdir(), 'nx-cs-'));
    this.env = {
      ...process.env,
      NX_WORKSPACE_ROOT_PATH: this.root,
      NX_DAEMON: String(daemon),
      NX_NO_CLOUD: 'true',
      NX_SKIP_NX_CACHE: 'false',
      NX_SKIP_REMOTE_CACHE: 'true',
      NX_CACHE_PROJECT_GRAPH: 'true',
      NX_CACHE_DIRECTORY: join(this.root, '.nx/cache'),
      NX_WORKSPACE_DATA_DIRECTORY: join(this.root, '.nx/workspace-data'),
      NX_NATIVE_FILE_CACHE_DIRECTORY: join(this.root, '.nx/native'),
      NX_SOCKET_DIR: join(this.root, '.nx/s'),
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
      for (const file of ['nx.json', 'lorem.md', '.gitignore']) {
        cpSync(join(fixtureSource, file), join(this.root, file));
      }
      cpSync(join(fixtureSource, 'packages'), join(this.root, 'packages'), {
        recursive: true,
        filter: (source) =>
          !['dist', 'copy-out', 'node_modules', '.nx'].includes(
            basename(source)
          ),
      });
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
      this.collectOutputDirectories(join(this.root, 'packages'));
      if (this.outputDirectories.length !== projectCount) {
        throw new Error(`Expected ${projectCount} fixture projects`);
      }
    } catch (error) {
      rmSync(this.root, { recursive: true, force: true });
      process.removeListener('exit', this.onExit);
      throw error;
    }
  }

  run(args: string[], timeoutMs = 300_000): string {
    return execFileSync(process.execPath, [...nodeArgs, nxCli, ...args], {
      cwd: this.root,
      env: this.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
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
    rmSync(this.root, { recursive: true, force: true });
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

  private collectOutputDirectories(directory: string): void {
    if (existsSync(join(directory, 'project.json'))) {
      this.outputDirectories.push(join(directory, 'copy-out'));
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        this.collectOutputDirectories(join(directory, entry.name));
      }
    }
  }
}

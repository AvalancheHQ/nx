import assert from 'node:assert/strict';
import { Bench } from 'tinybench';
import { withCodSpeed } from '@codspeed/tinybench-plugin';
import { projectsToRun } from '../../packages/nx/dist/src/command-line/run-many/run-many.js';

// Keep the upstream/codspeed pattern/exclusion workload, but use 10,000 projects
// rather than a million so simulation measures selection, not fixture pressure.
const projectGraph = { nodes: {}, dependencies: {} };
const expectedNames = [];
for (let i = 0; i < 10_000; i++) {
  const name = `proj${i}`;
  projectGraph.nodes[name] = {
    name,
    type: 'lib',
    data: { root: name, targets: { test: {} } },
  };
  if (name.startsWith('proj1') && !name.startsWith('proj12')) {
    expectedNames.push(name);
  }
}

const args = {
  targets: ['test'],
  projects: ['proj1*'],
  exclude: ['proj12*'],
};

// Validate the exact selection and warm the pattern cache outside measurement.
let selectedProjects = projectsToRun(args, projectGraph);
assert.equal(expectedNames.length, 1_000);
assert.deepEqual(
  selectedProjects.map(({ name }) => name),
  expectedNames
);

const bench = withCodSpeed(new Bench({ throws: true }));
bench.add('tinybench/projectsToRun/pattern-exclusion-10000-warm', () => {
  selectedProjects = projectsToRun(args, projectGraph);
});

const tasks = await bench.run();
const errors = tasks.flatMap((task) =>
  task.result?.error ? [task.result.error] : []
);
if (errors.length > 0) {
  throw new AggregateError(errors, 'projectsToRun benchmark failed');
}
assert.deepEqual(
  selectedProjects.map(({ name }) => name),
  expectedNames
);
console.table(bench.table());

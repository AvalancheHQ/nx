import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterAll, bench } from 'vitest';
import type * as projectMatcher from '../../packages/nx/dist/src/utils/find-matching-projects.js';

// Load the built CommonJS module without Vite rewriting production code.
const require = createRequire(import.meta.url);
const { findMatchingProjects } =
  require('../../packages/nx/dist/src/utils/find-matching-projects.js') as typeof projectMatcher;

const projects: Record<string, projectMatcher.MatcherProjectNode> = {};
const expectedNames: string[] = [];
for (let group = 0; group < 20; group++) {
  const groupName = `group-${String(group).padStart(2, '0')}`;
  for (let project = 0; project < 100; project++) {
    const name = `${groupName}-project-${String(project).padStart(2, '0')}`;
    const isWeb = group % 2 === 0;
    const isPrivate = project % 10 === 0;
    projects[name] = {
      data: {
        root: `packages/${groupName}/${name}`,
        tags: [
          isWeb ? 'scope:web' : 'scope:api',
          isPrivate ? 'visibility:private' : 'visibility:public',
        ],
      },
    };
    if (group === 0 || ((isWeb || group === 1) && !isPrivate)) {
      expectedNames.push(name);
    }
  }
}

// Exercise names, tags, exclusions, and directory-based re-inclusion, following
// find-matching-projects.spec.ts. A positive first pattern avoids input mutation.
const patterns = [
  'tag:scope:web',
  'name:group-01-*',
  '!tag:visibility:private',
  'directory:packages/group-00/*',
];

// This explicitly measures the warm-cache path used by repeated selections.
// Fixture construction, cache priming, sorting, and assertions are not timed.
let selectedProjects = findMatchingProjects(patterns, projects);
expectedNames.sort();
assert.equal(expectedNames.length, 1_000);
assert.deepEqual(selectedProjects.toSorted(), expectedNames);

afterAll(() => {
  assert.deepEqual(selectedProjects.toSorted(), expectedNames);
});

bench('vitest/findMatchingProjects/mixed-patterns-2000-warm', () => {
  selectedProjects = findMatchingProjects(patterns, projects);
});

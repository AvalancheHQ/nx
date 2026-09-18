import codspeedPlugin from '@codspeed/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [codspeedPlugin()],
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 300_000,
    benchmark: {
      include: ['benchmarks/macro/**/*.bench.ts'],
      includeSamples: true,
      outputJson: 'benchmarks/results-codspeed-macro.json',
    },
  },
});

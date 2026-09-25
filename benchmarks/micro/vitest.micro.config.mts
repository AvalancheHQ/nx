import { fileURLToPath } from 'node:url';
import codspeedPlugin from '@codspeed/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [codspeedPlugin()],
  test: {
    include: [],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
    benchmark: {
      include: ['benchmarks/micro/*.bench.ts'],
    },
  },
});

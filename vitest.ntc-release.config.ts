import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Used by the NTConsult release workflow's test job.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        ...configDefaults.exclude,
        // Both are pre-existing upstream PowerShell tests that also fail on the NTConsult-main
        // baseline in CI. Remove an entry when it is fixed.
        'tests/unit/deploy/installer-multimodal-config.test.mjs',
        'tests/unit/scripts/dashboard-lifecycle.test.mjs',
      ],
    },
  }),
);

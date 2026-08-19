import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as WorkerEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    // The bindings tests see: the Worker's own, plus the migrations the setup
    // file applies before each test file.
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};

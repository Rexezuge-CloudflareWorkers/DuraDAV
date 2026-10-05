import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiSrcPath = fileURLToPath(new URL('apps/api/src', import.meta.url));
const backgroundSrcPath = fileURLToPath(new URL('apps/background/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('packages/backend-data/src', import.meta.url));
const backendErrorsSrcPath = fileURLToPath(new URL('packages/backend-errors/src', import.meta.url));
const backendRuntimeSrcPath = fileURLToPath(new URL('packages/backend-runtime/src', import.meta.url));
const webdavSrcPath = fileURLToPath(new URL('packages/webdav/src', import.meta.url));
const davStoreSrcPath = fileURLToPath(new URL('packages/dav-store/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('packages/shared/src', import.meta.url));
const backendServicesSrcPath = fileURLToPath(new URL('packages/backend-services/src', import.meta.url));
const webSrcPath = fileURLToPath(new URL('apps/web/src', import.meta.url));
const cloudflareSocketsMockPath = fileURLToPath(new URL('test/mocks/cloudflare-sockets.ts', import.meta.url));
const cloudflareWorkersMockPath = fileURLToPath(new URL('test/mocks/cloudflare-workers.ts', import.meta.url));
const cloudflareWorkflowsMockPath = fileURLToPath(new URL('test/mocks/cloudflare-workflows.ts', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
    // re-listed: `test/` is a workspace project and therefore has its own.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    server: {
      deps: {
        // `dofs` imports `cloudflare:workers`, and a `node_modules` dependency is
        // externalized by default — so Node's own ESM loader resolves that specifier
        // and rejects the scheme before the `resolve.alias` below is ever consulted.
        // Inlining routes it back through Vite, where the alias applies.
        //
        // Needed by any unit test that reaches `dav-store`'s barrel, which
        // re-exports `dofs`. Without it `DavRepository` — the module every DAV
        // method handler is built on — cannot be imported outside the workerd
        // integration suite at all.
        inline: ['dofs'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['apps/api/src/**/*.ts', 'apps/background/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts', '**/types.d.ts', '**/model/**', '**/generated/**'],
      thresholds: {
        // The SPA was previously absent from `include` entirely, so 96% of it
        // (50 of 52 modules) was invisible to the gate and no amount of web
        // testing could move the number. It is now measured.
        //
        // One enforced global floor, raised 28/23/36/30 (pre-hardening) →
        // 35/31/41/36 → 43/39/50/44 → the current 46/41/52/47. Vitest applies
        // glob-scoped thresholds per *file* rather than per directory aggregate,
        // so a per-area floor here would compare every individual module against
        // it. Separate backend and web floors would need separate Vitest
        // projects. Never lower to make CI pass.
        statements: 46,
        branches: 41,
        functions: 52,
        lines: 47,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@durable-dav\/background$/, replacement: `${backgroundSrcPath}/index.ts` },
      { find: /^@durable-dav\/background\/(.*)$/, replacement: `${backgroundSrcPath}/$1` },
      { find: /^@durable-dav\/backend-data$/, replacement: `${backendDataSrcPath}/index.ts` },
      { find: /^@durable-dav\/backend-errors$/, replacement: `${backendErrorsSrcPath}/index.ts` },
      { find: /^@durable-dav\/backend-runtime$/, replacement: `${backendRuntimeSrcPath}/index.ts` },
      { find: /^@durable-dav\/backend-services$/, replacement: `${backendServicesSrcPath}/index.ts` },
      { find: /^@durable-dav\/webdav$/, replacement: `${webdavSrcPath}/index.ts` },
      { find: /^@durable-dav\/dav-store$/, replacement: `${davStoreSrcPath}/index.ts` },
      { find: /^@durable-dav\/shared$/, replacement: `${sharedSrcPath}/index.ts` },
      { find: '@durable-dav/background', replacement: backgroundSrcPath },
      { find: /^@durable-dav\/shared\/net$/, replacement: `${sharedSrcPath}/net/index.ts` },
      { find: /^@durable-dav\/shared\/(.*)$/, replacement: `${sharedSrcPath}/$1` },
      { find: '@durable-dav/backend-data', replacement: backendDataSrcPath },
      { find: '@durable-dav/backend-errors', replacement: backendErrorsSrcPath },
      { find: '@durable-dav/backend-runtime', replacement: backendRuntimeSrcPath },
      { find: '@durable-dav/backend-services', replacement: backendServicesSrcPath },
      { find: '@durable-dav/webdav', replacement: webdavSrcPath },
      { find: '@durable-dav/dav-store', replacement: davStoreSrcPath },
      { find: '@durable-dav/shared', replacement: sharedSrcPath },
      { find: 'cloudflare:sockets', replacement: cloudflareSocketsMockPath },
      { find: 'cloudflare:workers', replacement: cloudflareWorkersMockPath },
      { find: 'cloudflare:workflows', replacement: cloudflareWorkflowsMockPath },
      { find: /^@\//, replacement: `${apiSrcPath}/` },
      // Web-app imports. `~/` maps to the SPA root so tests can reach web
      // modules; the bare specifiers let Vite resolve their own relative
      // imports.
      { find: /^~\//, replacement: `${webSrcPath}/` },
    ],
  },
});

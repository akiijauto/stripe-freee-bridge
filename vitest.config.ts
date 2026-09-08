import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // 本物の秘密は使わない。試験用の固定値をSecretの代わりに注入する。
      miniflare: {
        bindings: { STRIPE_WEBHOOK_SECRET: 'whsec_test_secret' },
      },
    }),
  ],
});

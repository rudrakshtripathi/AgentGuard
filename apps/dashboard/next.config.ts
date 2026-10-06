import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Read the repo-level .env so API_URL has one source of truth.
const rootEnv = resolve(process.cwd(), '..', '..', '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const apiUrl = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

const config: NextConfig = {
  // The E2E suite builds into its own directory so it never clobbers the normal build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The browser only ever talks to this origin; /api/* is proxied to the Express API, so the
  // session cookie is first-party and SameSite=Strict, and no CORS is ever enabled.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  // Compression would buffer the Server-Sent Events stream behind the rewrite.
  compress: false,
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default config;

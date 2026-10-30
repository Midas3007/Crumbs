import type { NextConfig } from 'next';

const config: NextConfig = {
  // The dashboard lives inside the agent's repo; keep Next from treating the parent as the workspace root.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
};

export default config;

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The custom server (server.ts) owns the HTTP listener; keep Next lean.
  reactStrictMode: true,
  // better-sqlite3 / dockerode are native/CJS — keep them external to the server bundle. esbuild
  // too: it bundles the agent runners at runtime (lib/agent-apps.ts) and drives a native binary.
  serverExternalPackages: ["better-sqlite3", "dockerode", "ws", "esbuild"],
  // Both @spunto packages ship raw TS/TSX; Next skips node_modules transpilation by default.
  transpilePackages: ["@spunto/design-system", "@spunto/build"],
}

export default nextConfig

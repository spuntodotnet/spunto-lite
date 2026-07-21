import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The custom server (server.ts) owns the HTTP listener; keep Next lean.
  reactStrictMode: true,
  // better-sqlite3 / dockerode are native/CJS — keep them external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "dockerode", "ws"],
  // The design system ships raw TS/TSX; Next skips node_modules transpilation by default.
  transpilePackages: ["@spunto/design-system"],
}

export default nextConfig

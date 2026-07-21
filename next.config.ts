import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The custom server (server.ts) owns the HTTP listener; keep Next lean.
  reactStrictMode: true,
  // better-sqlite3 / dockerode are native/CJS — keep them external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "dockerode", "ws"],
}

export default nextConfig

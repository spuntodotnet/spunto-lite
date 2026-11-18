import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The custom server (server.ts) owns the HTTP listener; keep Next lean.
  reactStrictMode: true,
  // better-sqlite3 / dockerode are native/CJS — keep them external to the server bundle. esbuild
  // too: it bundles the agent runners at runtime (lib/agent-apps.ts) and drives a native binary.
  serverExternalPackages: ["better-sqlite3", "dockerode", "ws", "esbuild"],
  // Both @spunto packages ship raw TS/TSX; Next skips node_modules transpilation by default.
  transpilePackages: ["@spunto/design-system", "@spunto/build"],
  // `next dev` ouvert par l'URL publique d'un worker Spunto (https://<worker>-3010.spunto.net) : sans ça, Next refuse
  // ses ressources de dev à cette origine, et le rechargement à chaud ne passe pas. Sans effet sur le build.
  allowedDevOrigins: ["*.spunto.net"],
}

export default nextConfig

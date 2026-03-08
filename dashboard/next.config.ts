import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    config.resolve.alias["@kova"] = path.resolve(
      process.cwd(),
      "../src"
    );

    // The SDK uses .js extensions in imports (ESM convention) but the source
    // files are .ts. Tell webpack to resolve .js -> .ts for SDK imports.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        fs: false,
        path: false,
        os: false,
        dns: false,
        http: false,
        https: false,
        net: false,
        tls: false,
        child_process: false,
        worker_threads: false,
      };
    }
    return config;
  },
  serverExternalPackages: [
    "better-sqlite3",
    "@solana/web3.js",
    "@noble/curves",
    "@noble/hashes",
  ],
};

export default nextConfig;

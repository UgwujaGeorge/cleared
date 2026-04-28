/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // Browser: stub Node-only modules pulled in by @arcium-hq/client + WalletConnect.
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      };
    }
    // pino-pretty is an optional peer that webpack warns about; mark external
    // so the warning goes away and the import becomes a no-op at runtime.
    config.externals = config.externals ?? [];
    if (Array.isArray(config.externals)) {
      config.externals.push("pino-pretty");
    }
    return config;
  },
};

export default nextConfig;

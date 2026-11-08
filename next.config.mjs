/** @type {import('next').NextConfig} */
export default {
  // Next gets its own tsconfig so it never rewrites the root one (src, test, bench, scripts).
  typescript: { tsconfigPath: "tsconfig.next.json" },
  serverExternalPackages: ["node:sqlite"],
  webpack(config, { isServer }) {
    if (isServer) {
      const ext = config.externals ?? [];
      config.externals = [...(Array.isArray(ext) ? ext : [ext]), ({ request }, cb) => (request === "node:sqlite" ? cb(null, "commonjs node:sqlite") : cb())];
    }
    return config;
  },
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    proxyClientMaxBodySize: "80mb",
  },
  reactCompiler: process.env.NODE_ENV === "production",
  reactStrictMode: false,
  skipTrailingSlashRedirect: true,
  allowedDevOrigins: ["staging.otsukadetailer.site"],
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 50,
  },
  webpack: (config, { dev }) => {
    if (dev) {
      const currentIgnored = config.watchOptions?.ignored;
      const ignoredList = [];

      if (typeof currentIgnored === "string" && currentIgnored.trim()) {
        ignoredList.push(currentIgnored.trim());
      }
      if (Array.isArray(currentIgnored)) {
        currentIgnored.forEach((entry) => {
          if (typeof entry === "string" && entry.trim()) {
            ignoredList.push(entry.trim());
          }
        });
      }

      const nextIgnored = ["**/logs/**", "**/app-capacitor/**"];

      config.watchOptions = {
        ...(config.watchOptions || {}),
        ignored: [...new Set([...ignoredList, ...nextIgnored])],
      };
    }
    return config;
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // dockerode pulls in ssh2 (native .node) which webpack cannot bundle.
  // Keep these external so they load from node_modules at runtime (server only).
  experimental: {
    serverComponentsExternalPackages: [
      "dockerode",
      "ssh2",
      "docker-modem",
      "cpu-features",
    ],
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "uploads.mangadex.org" },
      { protocol: "https", hostname: "cdn.asurascans.com" },
      { protocol: "https", hostname: "*.asurascans.com" },
    ],
  },
};
module.exports = nextConfig;

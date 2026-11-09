import type { NextConfig } from "next";

const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // Lets a second local dev server (e.g. an e2e run) use its own build dir instead of sharing .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Same-origin API: the browser talks to /api on this host, so session cookies stay first-party.
  async rewrites() {
    // Everything under /api except /api/metrics, which is for the monitoring system on the internal
    // network (scrape the API container directly), never for the public website.
    return [{ source: "/api/:path((?!metrics(?:/|$)).*)", destination: `${backend}/api/:path` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;

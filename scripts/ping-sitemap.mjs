#!/usr/bin/env node
const SITEMAP_URL = "https://probidcore.net/sitemap.xml";
const PING_TARGETS = [
  `https://www.google.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
  `https://www.bing.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
];

async function pingAll() {
  const results = await Promise.allSettled(
    PING_TARGETS.map(async (url) => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { method: "GET", signal: controller.signal });
        return { url, status: res.status, ok: res.ok };
      } finally {
        clearTimeout(t);
      }
    }),
  );
  for (const r of results) {
    if (r.status === "fulfilled") {
      console.log(`[sitemap-ping] ${r.value.ok ? "OK" : "FAIL"} ${r.value.status} ${r.value.url}`);
    } else {
      console.warn(`[sitemap-ping] error: ${r.reason}`);
    }
  }
}

pingAll().catch((err) => {
  console.error("[sitemap-ping] fatal:", err);
  process.exit(0);
});

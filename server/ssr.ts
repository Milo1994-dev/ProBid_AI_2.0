import fs from "fs";
import path from "path";
import type { PublicBenchmarkData } from "./metrics-engine.js";

const CANONICAL_BASE = "https://probidcore.net";

let cachedIndexHtml: string | null = null;

function getIndexHtml(): string {
  if (cachedIndexHtml) return cachedIndexHtml;
  const indexPath = path.join(process.cwd(), "client", "dist", "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error("Client not built. Run: npm run build:client");
  }
  cachedIndexHtml = fs.readFileSync(indexPath, "utf-8");
  return cachedIndexHtml;
}

export function clearSSRCache(): void {
  cachedIndexHtml = null;
}

interface SSRPageMeta {
  title: string;
  description: string;
  canonical: string;
  ogUrl: string;
}

function replaceOrInsertMeta(html: string, selector: string, fullTag: string): string {
  const regex = new RegExp(selector);
  if (regex.test(html)) {
    return html.replace(regex, fullTag);
  }
  return html.replace("</head>", `  ${fullTag}\n</head>`);
}

function injectSSR(html: string, meta: SSRPageMeta, bodyContent: string, structuredData: object): string {
  let result = html;

  result = result.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(meta.title)}</title>`
  );

  result = replaceOrInsertMeta(
    result,
    '<meta\\s+name="description"\\s+content="[^"]*"\\s*\\/?>',
    `<meta name="description" content="${escapeHtml(meta.description)}" />`
  );

  result = replaceOrInsertMeta(
    result,
    '<meta\\s+property="og:title"\\s+content="[^"]*"\\s*\\/?>',
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`
  );
  result = replaceOrInsertMeta(
    result,
    '<meta\\s+property="og:description"\\s+content="[^"]*"\\s*\\/?>',
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`
  );
  result = replaceOrInsertMeta(
    result,
    '<meta\\s+property="og:url"\\s+content="[^"]*"\\s*\\/?>',
    `<meta property="og:url" content="${escapeHtml(meta.ogUrl)}" />`
  );

  result = replaceOrInsertMeta(
    result,
    '<meta\\s+name="twitter:title"\\s+content="[^"]*"\\s*\\/?>',
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`
  );
  result = replaceOrInsertMeta(
    result,
    '<meta\\s+name="twitter:description"\\s+content="[^"]*"\\s*\\/?>',
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`
  );

  const canonicalTag = `<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`;
  const ldJsonScript = `<script type="application/ld+json">${JSON.stringify(structuredData)}</script>`;
  result = result.replace("</head>", `  ${canonicalTag}\n  ${ldJsonScript}\n</head>`);

  result = result.replace(
    '<div id="root"></div>',
    `<div id="root" data-ssr="true">${bodyContent}</div>`
  );

  return result;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STRUCTURED_DATA_APP = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ProBid AI",
  description:
    "AI-powered construction estimating software for contractors. Generate professional estimates from job photos and descriptions in under 60 seconds.",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web, iOS, Android",
  offers: {
    "@type": "AggregateOffer",
    lowPrice: "0",
    highPrice: "55",
    priceCurrency: "USD",
    offerCount: "3",
  },
  url: CANONICAL_BASE,
  screenshot: `${CANONICAL_BASE}/og-image.png`,
  featureList: [
    "AI-generated construction estimates",
    "Photo upload for job analysis",
    "Professional PDF exports",
    "Contractor lead generation",
    "Roofing, masonry, concrete, remodeling support",
  ],
};

function homepageBodyContent(benchmarkN: number | null = null): string {
  return `<div class="min-h-screen bg-brand-bg">

<div class="relative z-40 bg-gradient-to-r from-brand-indigo/90 via-brand-indigo to-violet-600 text-white">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-center sm:text-left">
    <p class="text-xs sm:text-sm font-semibold leading-snug flex items-center gap-2 flex-wrap justify-center sm:justify-start">
      <span class="text-yellow-300 shrink-0">⚡</span>
      <span><strong>Founding Members lock in lifetime pricing.</strong> <span class="opacity-90">Limited spots remaining — prices increase soon.</span></span>
    </p>
    <a href="/signup" class="shrink-0 px-4 py-1.5 rounded-full bg-white text-brand-indigo text-xs font-bold hover:bg-white/90 transition-colors whitespace-nowrap">Lock In My Price →</a>
  </div>
</div>

<nav class="sticky top-0 z-40 bg-brand-bg/90 backdrop-blur border-b border-brand-border">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
    <span class="text-brand-green font-black text-lg tracking-tight">ProBid AI</span>
    <div class="flex items-center gap-4">
      <a href="#demo" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Demo</a>
      <a href="#features" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Features</a>
      <a href="#pricing" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Pricing</a>
      <a href="/accuracy" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Accuracy</a>
      <a href="/login" class="hidden sm:inline-flex px-3 py-1.5 text-sm text-brand-textMuted hover:text-brand-textPrimary">Log In</a>
      <a href="/signup" class="hidden sm:inline-flex px-4 py-2 rounded-xl bg-brand-green text-brand-bg text-sm font-bold">Get Started</a>
    </div>
  </div>
</nav>

<section class="max-w-6xl mx-auto px-4 sm:px-6 pt-20 pb-24 text-center">
  <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-brand-green/10 border border-brand-green/30 text-brand-green text-sm font-medium mb-8">
    AI-powered estimates for construction contractors
  </div>
  <h1 class="text-4xl sm:text-5xl md:text-6xl font-black text-brand-textPrimary leading-tight mb-6">
    Win More Jobs in <span class="text-brand-green">30 Seconds</span>
  </h1>
  <p class="text-lg sm:text-xl text-brand-textMuted max-w-2xl mx-auto mb-10 leading-relaxed">
    Upload a photo or describe the job. ProBid AI generates a professional estimate with materials, labor, and pricing in under a minute.
  </p>
  <div class="flex flex-col sm:flex-row items-center justify-center gap-4 mb-6">
    <a href="/signup" class="px-8 py-3 rounded-xl bg-brand-green text-brand-bg font-bold text-base">Start 7-Day Free Trial</a>
    <a href="#demo" class="px-8 py-3 rounded-xl border border-brand-border text-brand-textPrimary font-bold text-base">See Example Estimate</a>
  </div>
  <p class="text-sm text-brand-textSubtle text-center mb-6">7-day free trial · $7 single estimate · PDF ready to send</p>
  <div class="mt-8 inline-flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-brand-card border border-brand-border text-sm">
    <span class="w-2 h-2 rounded-full bg-brand-green animate-pulse shrink-0"></span>
    <span class="text-brand-textSubtle">Built by a working contractor — <span class="text-brand-textPrimary font-semibold">Kirchner Masonry</span>, Galena, IL</span>
  </div>
  <div class="mt-6 flex justify-center">
    <a href="/accuracy" class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-brand-indigo/10 border border-brand-indigo/30 text-sm text-brand-indigo hover:bg-brand-indigo/20 transition-colors font-medium">
      <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      ${benchmarkN !== null && benchmarkN >= 5
        ? `Verified accuracy on ${benchmarkN.toLocaleString()} real projects — see the data`
        : "Verified on real Procore projects — see the accuracy data"}
      <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
    </a>
  </div>
  <div class="mt-14 grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-3xl mx-auto text-sm">
    <div class="flex items-center gap-2 text-brand-textMuted justify-center sm:justify-start"><span>Save hours per estimate</span></div>
    <div class="flex items-center gap-2 text-brand-textMuted justify-center sm:justify-start"><span>Send cleaner proposals</span></div>
    <div class="flex items-center gap-2 text-brand-textMuted justify-center sm:justify-start"><span>Quote jobs faster</span></div>
    <div class="flex items-center gap-2 text-brand-textMuted justify-center sm:justify-start"><span>Close more work</span></div>
  </div>
</section>

<section class="border-y border-brand-border bg-brand-card/50 py-8">
  <div class="max-w-4xl mx-auto px-4 sm:px-6">
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
      <div class="flex flex-col items-center gap-2">
        <p class="text-base font-bold text-brand-textPrimary">$7 Single Estimate</p>
        <p class="text-sm text-brand-textSubtle">Or 7-day free trial of Pro</p>
      </div>
      <div class="flex flex-col items-center gap-2">
        <p class="text-base font-bold text-brand-textPrimary">~60-Second Turnaround</p>
        <p class="text-sm text-brand-textSubtle">From photo to estimate in under a minute</p>
      </div>
      <div class="flex flex-col items-center gap-2">
        <p class="text-base font-bold text-brand-textPrimary">PDF Ready to Send</p>
        <p class="text-sm text-brand-textSubtle">Professional report your client can keep</p>
      </div>
    </div>
  </div>
</section>

<section id="demo" class="max-w-6xl mx-auto px-4 sm:px-6 py-20">
  <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">See How ProBid Works</h2>
  <p class="text-brand-textMuted text-center mb-12 max-w-xl mx-auto">Click a sample job below to see a real estimate output — no signup needed.</p>
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
    <div class="text-left rounded-2xl border border-brand-border bg-brand-card p-5">
      <div class="flex items-start gap-3">
        <span class="text-3xl">🏚️</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="text-sm font-bold text-brand-textPrimary">Chimney Tuckpointing</span>
            <span class="text-xs px-2 py-0.5 rounded-full bg-brand-indigo/20 text-brand-indigo font-medium">Masonry</span>
          </div>
          <p class="text-xs text-brand-textSubtle">Click to view estimate →</p>
        </div>
      </div>
    </div>
    <div class="text-left rounded-2xl border border-brand-border bg-brand-card p-5">
      <div class="flex items-start gap-3">
        <span class="text-3xl">🧱</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="text-sm font-bold text-brand-textPrimary">Brick Retaining Wall Rebuild</span>
            <span class="text-xs px-2 py-0.5 rounded-full bg-brand-indigo/20 text-brand-indigo font-medium">Masonry</span>
          </div>
          <p class="text-xs text-brand-textSubtle">Click to view estimate →</p>
        </div>
      </div>
    </div>
    <div class="text-left rounded-2xl border border-brand-border bg-brand-card p-5">
      <div class="flex items-start gap-3">
        <span class="text-3xl">🚗</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="text-sm font-bold text-brand-textPrimary">Concrete Driveway Repair</span>
            <span class="text-xs px-2 py-0.5 rounded-full bg-brand-indigo/20 text-brand-indigo font-medium">Concrete</span>
          </div>
          <p class="text-xs text-brand-textSubtle">Click to view estimate →</p>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="max-w-5xl mx-auto px-4 sm:px-6 py-20">
  <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">How It Works</h2>
  <p class="text-brand-textMuted text-center mb-14 max-w-xl mx-auto">From job site to client-ready estimate in three steps.</p>
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-8">
    <div class="flex flex-col items-center text-center gap-4">
      <div class="w-12 h-12 rounded-full bg-brand-green/15 border-2 border-brand-green/40 flex items-center justify-center text-brand-green font-black text-lg">1</div>
      <h3 class="text-base font-bold text-brand-textPrimary leading-snug">Describe the job and upload photos</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">Type a quick description of the work — scope, trade, location. Attach job site photos so the AI has full context on materials, dimensions, and condition.</p>
    </div>
    <div class="flex flex-col items-center text-center gap-4">
      <div class="w-12 h-12 rounded-full bg-brand-green/15 border-2 border-brand-green/40 flex items-center justify-center text-brand-green font-black text-lg">2</div>
      <h3 class="text-base font-bold text-brand-textPrimary leading-snug">AI generates a market-priced estimate in ~60 seconds</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">ProBid AI analyzes your input and produces a complete breakdown: materials, labor, regional pricing. No manual math, no spreadsheets.</p>
    </div>
    <div class="flex flex-col items-center text-center gap-4">
      <div class="w-12 h-12 rounded-full bg-brand-green/15 border-2 border-brand-green/40 flex items-center justify-center text-brand-green font-black text-lg">3</div>
      <h3 class="text-base font-bold text-brand-textPrimary leading-snug">Download the PDF and send to your client</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">A polished, professional PDF is ready instantly. Share it directly with your client — it looks cleaner than anything you'd make in Excel.</p>
    </div>
  </div>
</section>

<section class="bg-brand-card/40 border-y border-brand-border py-20">
  <div class="max-w-5xl mx-auto px-4 sm:px-6">
    <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">Built for Your Trade</h2>
    <p class="text-brand-textMuted text-center mb-12 max-w-xl mx-auto">ProBid AI understands trade-specific materials, labor rates, and scope — so estimates actually match what you'd charge.</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      <div class="bg-brand-bg border border-brand-border rounded-2xl p-6">
        <div class="flex items-center gap-3 mb-3"><span class="text-2xl">🧱</span><h3 class="text-sm font-bold text-brand-textPrimary">Masonry</h3></div>
        <p class="text-sm text-brand-textMuted leading-relaxed">Get material and labor pricing for tuckpointing, repointing, and brick work — with mortar type and crew size factored in.</p>
      </div>
      <div class="bg-brand-bg border border-brand-border rounded-2xl p-6">
        <div class="flex items-center gap-3 mb-3"><span class="text-2xl">🏠</span><h3 class="text-sm font-bold text-brand-textPrimary">Roofing</h3></div>
        <p class="text-sm text-brand-textMuted leading-relaxed">Get square footage pricing with tear-off and material costs in one estimate — shingles, underlayment, and disposal included.</p>
      </div>
      <div class="bg-brand-bg border border-brand-border rounded-2xl p-6">
        <div class="flex items-center gap-3 mb-3"><span class="text-2xl">🚧</span><h3 class="text-sm font-bold text-brand-textPrimary">Concrete</h3></div>
        <p class="text-sm text-brand-textMuted leading-relaxed">Estimate slab pours, driveways, and structural repairs with accurate mix ratios, reinforcement, and finish labor.</p>
      </div>
      <div class="bg-brand-bg border border-brand-border rounded-2xl p-6">
        <div class="flex items-center gap-3 mb-3"><span class="text-2xl">🔨</span><h3 class="text-sm font-bold text-brand-textPrimary">Remodeling</h3></div>
        <p class="text-sm text-brand-textMuted leading-relaxed">Quote kitchens, bathrooms, and additions with room-by-room breakdowns — no spreadsheets, no guesswork.</p>
      </div>
      <div class="bg-brand-bg border border-brand-border rounded-2xl p-6">
        <div class="flex items-center gap-3 mb-3"><span class="text-2xl">📋</span><h3 class="text-sm font-bold text-brand-textPrimary">General Contractors</h3></div>
        <p class="text-sm text-brand-textMuted leading-relaxed">Manage multi-trade estimates and bid complex projects with confidence — materials, subs, and overhead in one place.</p>
      </div>
      <div class="bg-brand-bg border border-brand-border rounded-2xl p-6 flex flex-col justify-center items-center text-center gap-3">
        <p class="text-sm text-brand-textMuted">Works for 10+ trades including Painting, Flooring, Landscaping, HVAC, and more.</p>
        <a href="/signup" class="px-4 py-2 rounded-xl bg-brand-green text-brand-bg text-sm font-bold">Try Your First Estimate — $7</a>
      </div>
    </div>
  </div>
</section>

<section class="bg-brand-card/40 border-y border-brand-border py-20">
  <div class="max-w-6xl mx-auto px-4 sm:px-6">
    <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">Built for Real Contractors</h2>
    <p class="text-brand-textMuted text-center mb-3 max-w-xl mx-auto">Created by Jesse Kirchner — Contractor &amp; Builder</p>
    <p class="text-brand-textSubtle text-sm text-center mb-14 max-w-lg mx-auto">ProBid AI was built by someone who spent years manually writing estimates. The tool exists because the problem is real.</p>
    <div class="flex flex-col items-center gap-3 mb-10">
      <div class="flex items-baseline gap-2">
        <span class="text-3xl font-black text-brand-textPrimary">Built by</span>
        <span class="text-brand-textSubtle text-sm font-medium">a working contractor</span>
      </div>
      <p class="text-xs text-brand-textSubtle">Designed on real masonry job sites in the Midwest US</p>
    </div>
    <div class="grid grid-cols-1 gap-6 mb-16 max-w-2xl mx-auto">
      <div class="bg-brand-card border border-brand-border rounded-2xl p-6 flex flex-col gap-4">
        <p class="text-brand-textMuted text-sm leading-relaxed flex-1">"I built ProBid AI because I was sick of losing my evenings to estimates. After a long day of masonry work, I'd still have hours of measuring, pricing, and typing ahead of me. Now I generate a full estimate from a photo on the drive home."</p>
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-brand-indigo/20 flex items-center justify-center text-brand-indigo text-xs font-bold shrink-0">JK</div>
          <div><p class="text-sm font-semibold text-brand-textPrimary">Jesse Kirchner</p><p class="text-xs text-brand-textSubtle">Founder · Kirchner Masonry · Galena, IL</p></div>
        </div>
      </div>
    </div>
    <div class="mb-16">
      <h3 class="text-2xl sm:text-3xl font-black text-brand-textPrimary text-center mb-3">What's Actually In the Box</h3>
      <p class="text-brand-textSubtle text-sm text-center mb-10">Built for contractors who want to send a real bid before leaving the driveway.</p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-5 max-w-4xl mx-auto mb-10">
        <div class="bg-brand-bg border border-brand-green/30 rounded-2xl p-6 flex flex-col gap-3">
          <div class="flex items-center gap-3"><span class="text-2xl">📷</span><span class="text-base font-black text-brand-green">Photo to Estimate</span></div>
          <p class="text-sm font-bold text-brand-textPrimary">Snap a job-site photo or describe the work</p>
          <p class="text-xs text-brand-textSubtle leading-relaxed">AI generates a full breakdown — materials, labor, and overhead — in about a minute.</p>
        </div>
        <div class="bg-brand-bg border border-brand-green/30 rounded-2xl p-6 flex flex-col gap-3">
          <div class="flex items-center gap-3"><span class="text-2xl">📍</span><span class="text-base font-black text-brand-green">Regional Pricing</span></div>
          <p class="text-sm font-bold text-brand-textPrimary">Tuned for Midwest US construction markets</p>
          <p class="text-xs text-brand-textSubtle leading-relaxed">Material and labor pricing adjusted for your region instead of generic national averages.</p>
        </div>
        <div class="bg-brand-bg border border-brand-green/30 rounded-2xl p-6 flex flex-col gap-3">
          <div class="flex items-center gap-3"><span class="text-2xl">📄</span><span class="text-base font-black text-brand-green">PDF on the Spot</span></div>
          <p class="text-sm font-bold text-brand-textPrimary">Send a clean, branded estimate from your phone</p>
          <p class="text-xs text-brand-textSubtle leading-relaxed">Hand the homeowner a professional PDF before you leave the driveway.</p>
        </div>
      </div>
      <div class="flex justify-center">
        <div class="inline-flex items-center gap-4 bg-brand-card border border-brand-indigo/30 rounded-2xl px-6 py-4 max-w-sm">
          <div class="w-12 h-12 rounded-full bg-brand-indigo/20 border border-brand-indigo/40 flex items-center justify-center text-brand-indigo font-black text-lg shrink-0">JK</div>
          <div>
            <p class="text-sm font-bold text-brand-textPrimary">Built by a Real Contractor</p>
            <p class="text-xs text-brand-textMuted">Jesse Kirchner — Contractor &amp; Builder</p>
            <p class="text-xs text-brand-textSubtle mt-0.5">"I built this because I needed it."</p>
          </div>
        </div>
      </div>
    </div>
    <div class="max-w-3xl mx-auto">
      <h3 class="text-xl font-bold text-brand-textPrimary text-center mb-8">Why contractors use it</h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="flex gap-4 p-5 bg-brand-bg rounded-2xl border border-brand-border">
          <span class="text-2xl shrink-0">🐌</span>
          <div><p class="text-sm font-bold text-brand-textPrimary mb-1">Manual estimates are slow</p><p class="text-sm text-brand-textMuted leading-relaxed">Faster quotes mean you can bid more jobs in less time.</p></div>
        </div>
        <div class="flex gap-4 p-5 bg-brand-bg rounded-2xl border border-brand-border">
          <span class="text-2xl shrink-0">🏆</span>
          <div><p class="text-sm font-bold text-brand-textPrimary mb-1">Faster quotes win jobs</p><p class="text-sm text-brand-textMuted leading-relaxed">Contractors who respond quickly close more — especially on small jobs.</p></div>
        </div>
        <div class="flex gap-4 p-5 bg-brand-bg rounded-2xl border border-brand-border">
          <span class="text-2xl shrink-0">📋</span>
          <div><p class="text-sm font-bold text-brand-textPrimary mb-1">Cleaner proposals build trust</p><p class="text-sm text-brand-textMuted leading-relaxed">A professional PDF wins more deals than a number on a napkin.</p></div>
        </div>
        <div class="flex gap-4 p-5 bg-brand-bg rounded-2xl border border-brand-border">
          <span class="text-2xl shrink-0">💰</span>
          <div><p class="text-sm font-bold text-brand-textPrimary mb-1">One extra closed job pays for it</p><p class="text-sm text-brand-textMuted leading-relaxed">At $25/month, closing one extra job more than covers the cost.</p></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section id="features" class="max-w-6xl mx-auto px-4 sm:px-6 py-20">
  <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">Everything You Need to Estimate Faster</h2>
  <p class="text-brand-textMuted text-center mb-14 max-w-xl mx-auto">Stop spending hours on manual estimates. ProBid AI handles the math so you can focus on winning jobs.</p>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
    <div class="bg-brand-card border border-brand-border rounded-2xl p-6">
      <h3 class="text-base font-bold text-brand-textPrimary mb-2">Upload Job Photos</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">Snap or upload photos of the job site. AI analyzes dimensions, materials, and condition instantly.</p>
    </div>
    <div class="bg-brand-card border border-brand-border rounded-2xl p-6">
      <h3 class="text-base font-bold text-brand-textPrimary mb-2">AI-Powered Analysis</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">GPT-4o analyzes your photos and description to deliver accurate, market-adjusted cost estimates.</p>
    </div>
    <div class="bg-brand-card border border-brand-border rounded-2xl p-6">
      <h3 class="text-base font-bold text-brand-textPrimary mb-2">Branded PDF Reports</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">Download professional PDF estimates ready to share with clients or save for your records.</p>
    </div>
    <div class="bg-brand-card border border-brand-border rounded-2xl p-6">
      <h3 class="text-base font-bold text-brand-textPrimary mb-2">30-Second Turnaround</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">No more hours on manual calculations. Full estimates with material and labor breakdowns in seconds.</p>
    </div>
    <div class="bg-brand-card border border-brand-border rounded-2xl p-6">
      <h3 class="text-base font-bold text-brand-textPrimary mb-2">Market-Accurate Pricing</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">Prices calibrated to your region and current market rates — not generic national averages.</p>
    </div>
    <div class="bg-brand-card border border-brand-border rounded-2xl p-6">
      <h3 class="text-base font-bold text-brand-textPrimary mb-2">Secure &amp; Private</h3>
      <p class="text-sm text-brand-textMuted leading-relaxed">Your job data is encrypted and never shared. We take data security as seriously as you take your work.</p>
    </div>
  </div>
</section>

<section class="max-w-6xl mx-auto px-4 sm:px-6 pb-4">
  <div class="bg-gradient-to-br from-brand-green/15 via-brand-card to-brand-card border border-brand-green/30 rounded-3xl p-8 sm:p-12 flex flex-col sm:flex-row items-center justify-between gap-6">
    <div class="text-center sm:text-left">
      <h3 class="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-2">Ready to quote your next job in 30 seconds?</h3>
      <p class="text-brand-textMuted text-sm max-w-md">Snap a photo, get a full estimate, send the PDF — all from your phone.</p>
    </div>
    <div class="shrink-0 flex flex-col items-center gap-2">
      <a href="/signup" class="px-8 py-3 rounded-xl bg-brand-green text-brand-bg font-bold text-base">Start 7-Day Free Trial of Pro</a>
      <p class="text-xs text-brand-textSubtle">Or grab a $7 single estimate · Cancel anytime</p>
    </div>
  </div>
</section>

${pricingSectionHTML()}

<section class="bg-brand-card/40 border-y border-brand-border py-20">
  <div class="max-w-xl mx-auto px-4 sm:px-6">
    <h2 class="text-2xl sm:text-3xl font-black text-brand-textPrimary text-center mb-3">Want a Free Sample Estimate?</h2>
    <p class="text-brand-textMuted text-center mb-8 text-sm">Drop your info and we'll show you what ProBid AI can do for your specific trade.</p>
  </div>
</section>

<section class="max-w-3xl mx-auto px-4 sm:px-6 py-20">
  <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">Common Questions</h2>
  <p class="text-brand-textMuted text-center mb-12 max-w-xl mx-auto">Everything contractors ask before their first estimate.</p>
  <div class="space-y-3">
    ${faqItemsHTML([
      { q: "What trades does ProBid AI support?", a: "Roofing, masonry, concrete, remodeling, siding, painting, flooring, and general contracting. The AI understands trade-specific materials, crew sizes, and regional labor rates for each." },
      { q: "How accurate are the estimates?", a: "Estimates are built from current regional material pricing and standard labor rates. They're designed as a solid starting point — always review the line items against your own knowledge of the job before sending to a client." },
      { q: "Do I have to pay to try ProBid?", a: "You can try a single estimate for $7, or start a 7-day free trial of Pro ($25/mo) for unlimited estimates. No charge during the trial — cancel anytime." },
      { q: "Can I download and send the estimate to my client?", a: "Yes. Every estimate generates a professional PDF instantly — clean formatting, your job details, itemized materials and labor. You can download and email it directly from the app." },
      { q: "Does it work on my phone?", a: "Yes, ProBid AI is fully mobile-optimized. You can upload job site photos directly from your camera and generate estimates from the job site." },
      { q: "How does the AI know material and labor costs?", a: "The AI is trained on regional construction pricing data and updated regularly. You can also describe the scope in detail — better input means tighter estimates." },
      { q: "Can I cancel anytime?", a: "Yes. No contracts, no commitments. Cancel your Pro or Business plan anytime from your billing page — your access continues until the end of the billing period." },
      { q: "Is my estimate data private?", a: "Yes. Your estimates are only visible to you. We do not share your project data with third parties. You can delete your account and data at any time." },
    ])}
  </div>
</section>

<section class="max-w-6xl mx-auto px-4 sm:px-6 py-20">
  <div class="bg-gradient-to-br from-brand-indigo/20 to-brand-green/10 border border-brand-indigo/30 rounded-3xl p-10 sm:p-16 text-center">
    <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-4">Ready to Estimate Faster?</h2>
    <p class="text-brand-textMuted mb-8 max-w-lg mx-auto">Generate a professional estimate in under 30 seconds. Try it for $7 or start a 7-day free trial of Pro.</p>
    <a href="/signup" class="inline-block px-8 py-3 rounded-xl bg-brand-green text-brand-bg font-bold text-base">Start Your 7-Day Free Trial</a>
  </div>
</section>

<section class="border-t border-brand-border py-12 bg-brand-bg/50">
  <div class="max-w-6xl mx-auto px-4 sm:px-6">
    <h2 class="text-xl font-bold text-brand-textPrimary mb-6 text-center">Popular Construction Cost Guides</h2>
    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 text-sm">
      <a href="/guide/estimate-tuckpointing-cost-illinois" class="text-brand-textMuted hover:text-brand-green">Tuckpointing in Illinois</a>
      <a href="/guide/estimate-brick-repair-cost-texas" class="text-brand-textMuted hover:text-brand-green">Brick Repair in Texas</a>
      <a href="/guide/estimate-chimney-restoration-cost-florida" class="text-brand-textMuted hover:text-brand-green">Chimney Restoration in Florida</a>
      <a href="/guide/estimate-foundation-repair-cost-california" class="text-brand-textMuted hover:text-brand-green">Foundation Repair in California</a>
      <a href="/guide/estimate-stone-veneer-cost-new-york" class="text-brand-textMuted hover:text-brand-green">Stone Veneer in New York</a>
      <a href="/guide/estimate-concrete-repair-cost-ohio" class="text-brand-textMuted hover:text-brand-green">Concrete Repair in Ohio</a>
      <a href="/guide/estimate-masonry-waterproofing-cost-pennsylvania" class="text-brand-textMuted hover:text-brand-green">Masonry Waterproofing in PA</a>
      <a href="/guide/estimate-parging-cost-michigan" class="text-brand-textMuted hover:text-brand-green">Parging in Michigan</a>
      <a href="/guide/estimate-lintel-replacement-cost-georgia" class="text-brand-textMuted hover:text-brand-green">Lintel Replacement in Georgia</a>
      <a href="/guide/estimate-repointing-cost-arizona" class="text-brand-textMuted hover:text-brand-green">Repointing in Arizona</a>
    </div>
    <p class="text-center mt-6"><a href="/guides" class="text-brand-green hover:underline text-sm font-semibold">View all 250+ pricing guides →</a></p>
  </div>
</section>

<footer class="border-t border-brand-border py-8">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 text-center">
    <p class="text-brand-textSubtle text-sm">Generated by ProBid AI — <a href="https://probidcore.net" class="text-brand-green hover:underline">probidcore.net</a></p>
    <div class="flex items-center justify-center gap-6 mt-4 text-xs text-brand-textSubtle">
      <a href="/sitemap.xml" class="hover:text-brand-textMuted">Sitemap</a>
      <a href="/guides" class="hover:text-brand-textMuted">Guides</a>
      <a href="/accuracy" class="hover:text-brand-textMuted">Accuracy</a>
    </div>
  </div>
</footer>

</div>`;
}

function pricingSectionHTML(): string {
  return `<section id="pricing" class="max-w-6xl mx-auto px-4 sm:px-6 py-20">
  <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">Simple, Transparent Pricing</h2>
  <p class="text-brand-textMuted text-center mb-4 max-w-xl mx-auto">Try it risk-free with a single estimate or a 7-day Pro trial. Cancel anytime.</p>
  <p class="text-center text-brand-green text-sm font-semibold mb-12">Close just one extra job and ProBid pays for itself.</p>
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl mx-auto">

    <div class="relative flex flex-col p-6 sm:p-8 rounded-2xl border border-brand-border bg-brand-card">
      <div class="mb-6">
        <h3 class="text-lg font-bold text-brand-textPrimary mb-1">Single Estimate</h3>
        <p class="text-brand-textSubtle text-sm mb-4">Try it risk-free, no subscription</p>
        <div class="flex items-end gap-1"><span class="text-4xl font-black text-brand-textPrimary">$7</span></div>
      </div>
      <ul class="flex-1 space-y-3 mb-8">
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>1 AI-powered estimate</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Materials + labor breakdown</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>PDF download</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Regional pricing included</li>
      </ul>
      <a href="/signup" class="block w-full text-center px-6 py-3 rounded-xl border border-brand-border text-brand-textPrimary font-bold text-sm hover:bg-brand-card/80">Get One Estimate — $7</a>
    </div>

    <div class="relative flex flex-col p-6 sm:p-8 rounded-2xl border border-brand-green bg-gradient-to-b from-brand-green/10 to-brand-card shadow-lg shadow-brand-green/10">
      <div class="absolute -top-3 left-1/2 -translate-x-1/2"><span class="px-3 py-1 rounded-full bg-brand-green text-brand-bg text-xs font-bold">Most Popular</span></div>
      <div class="mb-6">
        <h3 class="text-lg font-bold text-brand-textPrimary mb-1">Pro</h3>
        <p class="text-brand-textSubtle text-sm mb-4">For individual contractors</p>
        <div class="flex items-end gap-1"><span class="text-4xl font-black text-brand-textPrimary">$25</span><span class="text-brand-textSubtle text-sm mb-1">/month</span></div>
        <div class="mt-2 inline-flex items-center gap-1.5 bg-brand-green/10 border border-brand-green/30 text-brand-green text-xs font-semibold px-2.5 py-1 rounded-full"><span>✦</span><span>7-day free trial — no charge during trial</span></div>
      </div>
      <ul class="flex-1 space-y-3 mb-8">
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Unlimited estimates</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Photo analysis</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Saved history</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Priority support</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Affiliate earnings</li>
      </ul>
      <a href="/signup" class="block w-full text-center px-6 py-3 rounded-xl bg-brand-green text-brand-bg font-bold text-sm hover:bg-brand-green/90">Start 7-Day Free Trial</a>
    </div>

    <div class="relative flex flex-col p-6 sm:p-8 rounded-2xl border border-brand-border bg-brand-card">
      <div class="mb-6">
        <h3 class="text-lg font-bold text-brand-textPrimary mb-1">Business</h3>
        <p class="text-brand-textSubtle text-sm mb-4">For agencies and teams</p>
        <div class="flex items-end gap-1"><span class="text-4xl font-black text-brand-textPrimary">$55</span><span class="text-brand-textSubtle text-sm mb-1">/month</span></div>
        <div class="mt-2 inline-flex items-center gap-1.5 bg-brand-green/10 border border-brand-green/30 text-brand-green text-xs font-semibold px-2.5 py-1 rounded-full"><span>✦</span><span>7-day free trial — no charge during trial</span></div>
      </div>
      <ul class="flex-1 space-y-3 mb-8">
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Everything in Pro</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Team collaboration</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Custom branding</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>Analytics dashboard</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>API access</li>
        <li class="flex items-start gap-2.5 text-sm text-brand-textMuted"><span class="text-brand-green mt-0.5 shrink-0">✓</span>24-hour priority support</li>
      </ul>
      <a href="/signup" class="block w-full text-center px-6 py-3 rounded-xl border border-brand-border text-brand-textPrimary font-bold text-sm hover:bg-brand-card/80">Start 7-Day Free Trial</a>
    </div>

  </div>
</section>`;
}

function faqItemsHTML(items: { q: string; a: string }[]): string {
  return items
    .map(
      (item) => `<div class="border border-brand-border rounded-2xl overflow-hidden">
      <button type="button" class="w-full flex items-center justify-between gap-4 px-6 py-4 text-left bg-brand-card/30 hover:bg-brand-card/60 transition-colors" aria-expanded="false">
        <span class="text-sm font-semibold text-brand-textPrimary">${escapeHtml(item.q)}</span>
        <span class="shrink-0 text-brand-green transition-transform duration-200">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"></path></svg>
        </span>
      </button>
    </div>`
    )
    .join("\n    ");
}

export function renderHomepageSSR(benchmarkN: number | null = null): string {
  const html = getIndexHtml();
  const meta: SSRPageMeta = {
    title: "ProBid AI — Construction Estimates in 30 Seconds",
    description:
      "Get accurate construction estimates in 30 seconds. Upload photos, describe the job, and let AI calculate material costs, labor costs, and totals instantly.",
    canonical: `${CANONICAL_BASE}/`,
    ogUrl: CANONICAL_BASE,
  };
  return injectSSR(html, meta, homepageBodyContent(benchmarkN), STRUCTURED_DATA_APP);
}

export function renderPricingSSR(): string {
  const html = getIndexHtml();
  const meta: SSRPageMeta = {
    title: "Pricing | ProBid AI — Plans for Every Contractor",
    description:
      "ProBid AI pricing — choose the perfect plan for your contracting business. Try a single estimate for $7 or start a 7-day free trial of Pro for unlimited access.",
    canonical: `${CANONICAL_BASE}/pricing`,
    ogUrl: `${CANONICAL_BASE}/pricing`,
  };

  const pricingBody = `<div class="min-h-screen bg-brand-bg">

<div class="relative z-40 bg-gradient-to-r from-brand-indigo/90 via-brand-indigo to-violet-600 text-white">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-center sm:text-left">
    <p class="text-xs sm:text-sm font-semibold leading-snug flex items-center gap-2 flex-wrap justify-center sm:justify-start">
      <span class="text-yellow-300 shrink-0">⚡</span>
      <span><strong>Founding Members lock in lifetime pricing.</strong> <span class="opacity-90">Limited spots remaining — prices increase soon.</span></span>
    </p>
    <a href="/signup" class="shrink-0 px-4 py-1.5 rounded-full bg-white text-brand-indigo text-xs font-bold hover:bg-white/90 transition-colors whitespace-nowrap">Lock In My Price →</a>
  </div>
</div>

<nav class="sticky top-0 z-40 bg-brand-bg/90 backdrop-blur border-b border-brand-border">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
    <span class="text-brand-green font-black text-lg tracking-tight">ProBid AI</span>
    <div class="flex items-center gap-4">
      <a href="/#demo" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Demo</a>
      <a href="/#features" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Features</a>
      <a href="#pricing" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Pricing</a>
      <a href="/login" class="hidden sm:inline-flex px-3 py-1.5 text-sm text-brand-textMuted hover:text-brand-textPrimary">Log In</a>
      <a href="/signup" class="hidden sm:inline-flex px-4 py-2 rounded-xl bg-brand-green text-brand-bg text-sm font-bold">Get Started</a>
    </div>
  </div>
</nav>

<section class="max-w-6xl mx-auto px-4 sm:px-6 pt-20 pb-24 text-center">
  <h1 class="text-4xl sm:text-5xl md:text-6xl font-black text-brand-textPrimary leading-tight mb-6">
    Simple, <span class="text-brand-green">Transparent Pricing</span> for Every Contractor
  </h1>
  <p class="text-lg sm:text-xl text-brand-textMuted max-w-2xl mx-auto mb-10 leading-relaxed">
    Try a single estimate for $7 or start a 7-day free trial of Pro. Cancel anytime — no charge during the trial.
  </p>
</section>

${pricingSectionHTML()}

<section class="max-w-3xl mx-auto px-4 sm:px-6 py-20">
  <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-4">Common Questions</h2>
  <p class="text-brand-textMuted text-center mb-12 max-w-xl mx-auto">Everything contractors ask before their first estimate.</p>
  <div class="space-y-3">
    ${faqItemsHTML([
      { q: "What trades does ProBid AI support?", a: "Roofing, masonry, concrete, remodeling, siding, painting, flooring, and general contracting. The AI understands trade-specific materials, crew sizes, and regional labor rates for each." },
      { q: "How accurate are the estimates?", a: "Estimates are built from current regional material pricing and standard labor rates. They're designed as a solid starting point — always review the line items against your own knowledge of the job before sending to a client." },
      { q: "Do I have to pay to try ProBid?", a: "You can try a single estimate for $7, or start a 7-day free trial of Pro ($25/mo) for unlimited estimates. No charge during the trial — cancel anytime." },
      { q: "Can I cancel anytime?", a: "Yes. No contracts, no commitments. Cancel your Pro or Business plan anytime from your billing page — your access continues until the end of the billing period." },
    ])}
  </div>
</section>

<section class="max-w-6xl mx-auto px-4 sm:px-6 py-20">
  <div class="bg-gradient-to-br from-brand-indigo/20 to-brand-green/10 border border-brand-indigo/30 rounded-3xl p-10 sm:p-16 text-center">
    <h2 class="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-4">Ready to Estimate Faster?</h2>
    <p class="text-brand-textMuted mb-8 max-w-lg mx-auto">Generate a professional estimate in under 30 seconds. Try it for $7 or start a 7-day free trial of Pro.</p>
    <a href="/signup" class="inline-block px-8 py-3 rounded-xl bg-brand-green text-brand-bg font-bold text-base">Start Your 7-Day Free Trial</a>
  </div>
</section>

<footer class="border-t border-brand-border py-8">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 text-center">
    <p class="text-brand-textSubtle text-sm">Generated by ProBid AI — <a href="https://probidcore.net" class="text-brand-green hover:underline">probidcore.net</a></p>
    <div class="flex items-center justify-center gap-6 mt-4 text-xs text-brand-textSubtle">
      <a href="/sitemap.xml" class="hover:text-brand-textMuted">Sitemap</a>
      <a href="/guides" class="hover:text-brand-textMuted">Guides</a>
      <a href="/accuracy" class="hover:text-brand-textMuted">Accuracy</a>
    </div>
  </div>
</footer>

</div>`;

  return injectSSR(html, meta, pricingBody, {
    ...STRUCTURED_DATA_APP,
    name: "ProBid AI - Pricing",
    url: `${CANONICAL_BASE}/pricing`,
  });
}

const MIN_DISPLAY_SAMPLE = 5;

function fmt1(n: number): string {
  return n.toFixed(1);
}

function accuracyBodyContent(data: PublicBenchmarkData): string {
  const lastUpdated = data.lastUpdatedAt
    ? new Date(data.lastUpdatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;

  const hasData = data.overall !== null && data.overall.sampleSize >= MIN_DISPLAY_SAMPLE;
  const n = data.overall?.sampleSize ?? 0;
  const p50 = data.overall?.p50ErrorPct ?? 0;
  const p80 = data.overall?.p80ErrorPct ?? 0;
  const withinBand = data.overall?.withinBandPct ?? 0;

  const headlineNumber = hasData
    ? `<span class="text-brand-green">${fmt1(p50)}%</span>`
    : `<span class="text-brand-textMuted">—</span>`;

  const heroSubtitle = hasData
    ? `ProBid AI estimates land within <strong>${fmt1(p50)}%</strong> of actual closed project cost (median) across <strong>${n.toLocaleString()} real Procore projects</strong>. Numbers are computed blind, compared against actual costs only after the project closes.`
    : `Accuracy benchmarks are computed from consenting Procore connections. Data will appear here once enough projects have been analyzed.`;

  const qualifyingTradeRows = data.byTrade
    .filter((t) => t.sampleSize >= MIN_DISPLAY_SAMPLE)
    .map((t) => `<tr class="border-b border-brand-border/40 last:border-0">
          <td class="py-3 pl-5 pr-6 text-sm font-medium text-brand-textPrimary">${escapeHtml(t.trade)}</td>
          <td class="py-3 pr-6 text-sm text-brand-textPrimary font-semibold">${fmt1(t.p50ErrorPct)}%</td>
          <td class="py-3 pr-6 text-sm text-brand-textMuted">${fmt1(t.p80ErrorPct)}%</td>
          <td class="py-3 pr-5 text-xs text-brand-textSubtle">${t.sampleSize.toLocaleString()}</td>
        </tr>`)
    .join("");

  const tradeSection = qualifyingTradeRows
    ? `<section class="max-w-4xl mx-auto px-4 sm:px-6 py-12">
  <h2 class="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-2">By Trade</h2>
  <p class="text-brand-textMuted text-sm mb-6">Trades with fewer than ${MIN_DISPLAY_SAMPLE} projects are hidden to protect statistical integrity.</p>
  <div class="bg-brand-card border border-brand-border rounded-2xl overflow-hidden">
    <table class="w-full">
      <thead>
        <tr class="border-b border-brand-border bg-brand-bg/50">
          <th class="py-3 pl-5 pr-6 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">Trade</th>
          <th class="py-3 pr-6 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">Median Error (P50)</th>
          <th class="py-3 pr-6 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">P80 Error</th>
          <th class="py-3 pr-5 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">Projects</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-brand-border/30">
        ${qualifyingTradeRows}
      </tbody>
    </table>
  </div>
</section>`
    : "";

  const sizeRows = data.bySize
    .filter((s) => s.sampleSize >= MIN_DISPLAY_SAMPLE)
    .map((s) => `
      <div class="bg-brand-card border border-brand-border rounded-2xl p-6">
        <p class="text-sm font-semibold text-brand-textSubtle mb-1">${escapeHtml(s.label)}</p>
        <div class="flex items-end gap-1 mb-1">
          <span class="text-3xl font-black text-brand-textPrimary">${fmt1(s.p50ErrorPct)}%</span>
          <span class="text-xs text-brand-textSubtle mb-1.5 ml-1">median error</span>
        </div>
        <p class="text-xs text-brand-textMuted">80th percentile: ${fmt1(s.p80ErrorPct)}%</p>
        <p class="text-xs text-brand-textSubtle mt-1">${s.sampleSize.toLocaleString()} projects</p>
      </div>`)
    .join("");

  const sizeSectionContent = sizeRows
    ? `<div class="grid grid-cols-1 sm:grid-cols-3 gap-5 mt-6">${sizeRows}</div>`
    : `<div class="mt-6 p-6 bg-brand-card border border-brand-border rounded-2xl text-center"><p class="text-sm text-brand-textSubtle italic">Not enough data in each size bucket yet.</p></div>`;

  return `<div class="min-h-screen bg-brand-bg">

<nav class="sticky top-0 z-40 bg-brand-bg/90 backdrop-blur border-b border-brand-border">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
    <a href="/" class="text-brand-green font-black text-lg tracking-tight">ProBid AI</a>
    <div class="flex items-center gap-4">
      <a href="/#demo" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Demo</a>
      <a href="/pricing" class="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Pricing</a>
      <a href="/accuracy" class="hidden sm:block text-sm text-brand-textPrimary font-semibold">Accuracy</a>
      <a href="/login" class="hidden sm:inline-flex px-3 py-1.5 text-sm text-brand-textMuted hover:text-brand-textPrimary">Log In</a>
      <a href="/signup" class="hidden sm:inline-flex px-4 py-2 rounded-xl bg-brand-green text-brand-bg text-sm font-bold">Get Started</a>
    </div>
  </div>
</nav>

<section class="max-w-4xl mx-auto px-4 sm:px-6 pt-20 pb-16 text-center">
  <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-brand-indigo/10 border border-brand-indigo/30 text-brand-indigo text-sm font-medium mb-8">
    <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    Verified on real closed Procore projects
  </div>
  <h1 class="text-4xl sm:text-5xl md:text-6xl font-black text-brand-textPrimary leading-tight mb-6">
    ProBid AI Accuracy<br/>
    Measured at ${headlineNumber} Median Error
  </h1>
  <p class="text-lg sm:text-xl text-brand-textMuted max-w-2xl mx-auto leading-relaxed">${heroSubtitle}</p>
  ${lastUpdated ? `<p class="mt-6 text-xs text-brand-textSubtle">Last updated: ${escapeHtml(lastUpdated)}</p>` : ""}
</section>

${hasData ? `<section class="border-y border-brand-border bg-brand-card/50 py-10">
  <div class="max-w-4xl mx-auto px-4 sm:px-6">
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
      <div>
        <p class="text-4xl sm:text-5xl font-black text-brand-green">${fmt1(p50)}%</p>
        <p class="text-sm font-semibold text-brand-textPrimary mt-2">Median Error (P50)</p>
        <p class="text-xs text-brand-textSubtle mt-1">Half of estimates land within this</p>
        <p class="text-xs text-brand-textSubtle mt-0.5">n = ${n.toLocaleString()} projects</p>
      </div>
      <div>
        <p class="text-4xl sm:text-5xl font-black text-brand-textPrimary">${fmt1(p80)}%</p>
        <p class="text-sm font-semibold text-brand-textPrimary mt-2">80th-Percentile Error</p>
        <p class="text-xs text-brand-textSubtle mt-1">80% of estimates land within this</p>
        <p class="text-xs text-brand-textSubtle mt-0.5">n = ${n.toLocaleString()} projects</p>
      </div>
      <div>
        <p class="text-4xl sm:text-5xl font-black text-brand-textPrimary">${fmt1(withinBand)}%</p>
        <p class="text-sm font-semibold text-brand-textPrimary mt-2">Within Confidence Band</p>
        <p class="text-xs text-brand-textSubtle mt-1">Actuals fell inside ProBid's low–high range</p>
        <p class="text-xs text-brand-textSubtle mt-0.5">n = ${n.toLocaleString()} projects</p>
      </div>
    </div>
  </div>
</section>` : `<section class="border-y border-brand-border bg-brand-card/50 py-10">
  <div class="max-w-4xl mx-auto px-4 sm:px-6 text-center">
    <p class="text-brand-textSubtle">Aggregate statistics will appear here once enough consenting partners have contributed data.</p>
  </div>
</section>`}

${tradeSection}

<section class="max-w-4xl mx-auto px-4 sm:px-6 py-12">
  <h2 class="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-2">By Project Size</h2>
  <p class="text-brand-textMuted text-sm mb-2">Accuracy varies by project scale. Buckets with fewer than ${MIN_DISPLAY_SAMPLE} projects are hidden.</p>
  ${sizeSectionContent}
</section>

<section id="methodology" class="max-w-4xl mx-auto px-4 sm:px-6 py-16 border-t border-brand-border">
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-12">
    <div class="sm:col-span-2">
      <h2 class="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-6">How This Is Measured</h2>
      <div class="space-y-5 text-sm text-brand-textMuted leading-relaxed">
        <div>
          <h3 class="text-base font-bold text-brand-textPrimary mb-1">1. Source: Real Closed Projects</h3>
          <p>Numbers come from contractors who have connected their Procore accounts and opted in to anonymous benchmarking. Only <strong>closed projects with actual cost data</strong> are included — no in-progress projects, no estimates without actuals.</p>
        </div>
        <div>
          <h3 class="text-base font-bold text-brand-textPrimary mb-1">2. Blind Shadow Estimate</h3>
          <p>Before comparing against actual costs, ProBid AI generates a <strong>shadow estimate</strong> using only the project metadata that would have been available at bid time: trade type, location, scope, and project size. The actual cost is hidden from the AI during this step.</p>
        </div>
        <div>
          <h3 class="text-base font-bold text-brand-textPrimary mb-1">3. Error Calculation</h3>
          <p>Error % = |ProBid Estimate − Actual Cost| ÷ Actual Cost × 100. This is an absolute (non-directional) percentage — it measures how far off the estimate was in either direction.</p>
        </div>
        <div>
          <h3 class="text-base font-bold text-brand-textPrimary mb-1">4. Percentiles, Not Averages</h3>
          <p>We report <strong>P50 (median)</strong> and <strong>P80</strong> error. Medians are more robust than means for skewed data. A lower number means tighter, more accurate estimates.</p>
        </div>
        <div>
          <h3 class="text-base font-bold text-brand-textPrimary mb-1">5. Minimum Sample Size</h3>
          <p>Any breakdown category with fewer than <strong>${MIN_DISPLAY_SAMPLE} projects</strong> is hidden rather than shown. Small samples produce unreliable statistics. We show "Insufficient data" rather than mislead.</p>
        </div>
        <div>
          <h3 class="text-base font-bold text-brand-textPrimary mb-1">6. Privacy</h3>
          <p>No project names, company names, or individual line items are ever shown publicly. Only aggregate statistics are included. Participation is opt-in; contractors can change their preference any time in their Procore settings.</p>
        </div>
      </div>
    </div>
    <div class="space-y-4">
      <div class="bg-brand-card border border-brand-border rounded-2xl p-5">
        <h3 class="text-sm font-bold text-brand-textPrimary mb-2">Data Source</h3>
        <p class="text-xs text-brand-textMuted leading-relaxed">Procore-connected accounts (read-only OAuth). Actual costs pulled from Procore budget views after project close.</p>
      </div>
      <div class="bg-brand-card border border-brand-border rounded-2xl p-5">
        <h3 class="text-sm font-bold text-brand-textPrimary mb-2">Update Frequency</h3>
        <p class="text-xs text-brand-textMuted leading-relaxed">Benchmarks are recomputed daily from all consenting connections. The last update timestamp is shown above.</p>
      </div>
      <div class="bg-brand-card border border-brand-border rounded-2xl p-5">
        <h3 class="text-sm font-bold text-brand-textPrimary mb-2">Contribute Your Data</h3>
        <p class="text-xs text-brand-textMuted leading-relaxed">Business plan subscribers can opt in to anonymous benchmarking in their Procore settings. Your data improves the benchmarks for everyone.</p>
        <a href="/signup" class="mt-3 inline-block text-xs font-semibold text-brand-green hover:underline">Connect Procore →</a>
      </div>
    </div>
  </div>
</section>

<section class="max-w-4xl mx-auto px-4 sm:px-6 py-16">
  <div class="bg-gradient-to-br from-brand-indigo/20 to-brand-green/10 border border-brand-indigo/30 rounded-3xl p-10 sm:p-12 text-center">
    <h2 class="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-3">Verify the Numbers Yourself</h2>
    <p class="text-brand-textMuted mb-6 max-w-lg mx-auto text-sm leading-relaxed">Connect your Procore account and we'll run ProBid's estimates against your own closed projects. You get a private accuracy report — and can choose whether to contribute anonymized stats to this page.</p>
    <a href="/signup" class="inline-block px-8 py-3 rounded-xl bg-brand-green text-brand-bg font-bold text-sm">Run Your Own Accuracy Test</a>
  </div>
</section>

<footer class="border-t border-brand-border py-8">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 text-center">
    <p class="text-brand-textSubtle text-sm">ProBid AI Accuracy Benchmarks — <a href="https://probidcore.net" class="text-brand-green hover:underline">probidcore.net</a></p>
    <div class="flex items-center justify-center gap-6 mt-4 text-xs text-brand-textSubtle">
      <a href="/" class="hover:text-brand-textMuted">Home</a>
      <a href="/pricing" class="hover:text-brand-textMuted">Pricing</a>
      <a href="/accuracy#methodology" class="hover:text-brand-textMuted">Methodology</a>
      <a href="/sitemap.xml" class="hover:text-brand-textMuted">Sitemap</a>
    </div>
  </div>
</footer>

</div>`;
}

export function renderAccuracySSR(data: PublicBenchmarkData): string {
  const html = getIndexHtml();
  const n = data.overall?.sampleSize ?? 0;
  const p50 = data.overall?.p50ErrorPct;

  const title = p50 != null && n >= MIN_DISPLAY_SAMPLE
    ? `Construction Estimating Accuracy: ${fmt1(p50)}% Median Error on ${n.toLocaleString()} Real Projects | ProBid AI`
    : "Construction Estimating Accuracy | ProBid AI — Verified on Real Procore Projects";

  const description = p50 != null && n >= MIN_DISPLAY_SAMPLE
    ? `ProBid AI estimates land within ${fmt1(p50)}% of actual construction project cost (median) across ${n.toLocaleString()} real closed Procore projects. See the methodology, trade breakdowns, and size-bucket analysis.`
    : "ProBid AI measures its construction estimating accuracy against real closed Procore projects. See the public benchmark data, methodology, and how to contribute your own projects.";

  const meta: SSRPageMeta = {
    title,
    description,
    canonical: `${CANONICAL_BASE}/accuracy`,
    ogUrl: `${CANONICAL_BASE}/accuracy`,
  };

  const dateModified = data.lastUpdatedAt ? new Date(data.lastUpdatedAt).toISOString() : new Date().toISOString();

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        name: "ProBid AI Construction Estimating Accuracy Benchmarks",
        description,
        url: `${CANONICAL_BASE}/accuracy`,
        creator: {
          "@type": "Organization",
          name: "ProBid AI",
          url: CANONICAL_BASE,
        },
        license: "https://creativecommons.org/licenses/by/4.0/",
        isAccessibleForFree: true,
        keywords: ["construction estimating accuracy", "AI estimates", "construction cost benchmarks", "Procore"],
        variableMeasured: "Construction estimate error percentage vs actual project cost",
        dateModified,
      },
      {
        "@type": "Article",
        headline: title,
        description,
        url: `${CANONICAL_BASE}/accuracy`,
        dateModified,
        author: {
          "@type": "Organization",
          name: "ProBid AI",
          url: CANONICAL_BASE,
        },
        publisher: {
          "@type": "Organization",
          name: "ProBid AI",
          url: CANONICAL_BASE,
        },
        mainEntityOfPage: {
          "@type": "WebPage",
          "@id": `${CANONICAL_BASE}/accuracy`,
        },
      },
    ],
  };

  return injectSSR(html, meta, accuracyBodyContent(data), structuredData);
}

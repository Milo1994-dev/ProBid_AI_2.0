import express from "express";
import { db, pool } from "../../db.js";
import { eq, and, count, between } from "drizzle-orm";
import { estimates, seoPages } from "../../../shared/schema.js";
import { asyncHandler, requireAdminAuth, requireAdminAuthPage } from "../../lib/middleware.js";
import { escapeHtml } from "../../lib/utils.js";
import { SEO_SERVICES, SEO_STATES, generateSeoContent } from "./shared.js";

const APP_URL =
  process.env.REPLIT_DEPLOYMENT === "1"
    ? "https://probidcore.net"
    : process.env.APP_URL || "http://localhost:5000";

export function registerAdminSeoRoutes(app: express.Application) {
// --- SEO Routes ---
app.get(
  "/guides",
  asyncHandler(async (req, res) => {
    const pages = await db
      .select({
        id: seoPages.id,
        slug: seoPages.slug,
        title: seoPages.title,
        createdAt: seoPages.createdAt,
      })
      .from(seoPages)
      .orderBy(seoPages.title);

    const groupedPages: Record<string, any[]> = {};
    for (const page of pages) {
      const serviceMatch = page.slug.match(/^estimate-(.+)-cost-/);
      const serviceSlug = serviceMatch ? serviceMatch[1] : "other";
      const service = SEO_SERVICES.find((s) => s.slug === serviceSlug);
      const serviceName = service ? service.name : "Other Services";

      if (!groupedPages[serviceName]) {
        groupedPages[serviceName] = [];
      }
      groupedPages[serviceName].push(page);
    }

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <meta name="description" content="Free 2025 pricing guides for construction services. Get accurate cost estimates for retaining walls, chimney rebuilds, tuckpointing, and more across all US states."/>
  <title>Construction Cost Guides & Pricing Estimates (2025) | ProBid AI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4f46e5;
      --primary-light: #6366f1;
      --accent: #22c55e;
      --bg-dark: #0a0e1a;
      --bg-card: rgba(18, 26, 42, 0.6);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
    .header {
      padding: 24px 0;
      border-bottom: 1px solid var(--border-color);
      background: rgba(10, 14, 26, 0.9);
      backdrop-filter: blur(10px);
    }
    .header-inner { display: flex; justify-content: space-between; align-items: center; }
    .logo {
      font-size: 1.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-decoration: none;
    }
    .nav-link {
      padding: 10px 20px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-primary);
      font-weight: 600;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
    }
    .hero {
      text-align: center;
      padding: 80px 24px;
      background: linear-gradient(180deg, rgba(79, 70, 229, 0.1) 0%, transparent 100%);
    }
    .hero h1 {
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 800;
      margin-bottom: 16px;
    }
    .hero p {
      font-size: 1.1rem;
      color: var(--text-muted);
      max-width: 600px;
      margin: 0 auto;
    }
    .badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 999px;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: var(--accent);
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .guides-section { padding: 60px 0; }
    .service-group { margin-bottom: 48px; }
    .service-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 2px solid var(--border-light);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .service-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
    }
    .guides-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }
    .guide-card {
      display: block;
      padding: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      text-decoration: none;
      color: var(--text-primary);
      transition: all 0.3s ease;
    }
    .guide-card:hover {
      border-color: var(--border-light);
      transform: translateY(-4px);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.3);
    }
    .guide-card h3 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .guide-card .meta {
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .total-count {
      text-align: center;
      padding: 40px;
      background: var(--bg-card);
      border-radius: 16px;
      margin-top: 40px;
    }
    .total-count .number {
      font-size: 3rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--primary-light) 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .footer {
      padding: 40px 0;
      text-align: center;
      border-top: 1px solid var(--border-color);
      color: var(--text-muted);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="container header-inner">
      <a href="/" class="logo">ProBid AI</a>
      <a href="/signup" class="nav-link">Get Free Estimate</a>
    </div>
  </header>
  
  <section class="hero">
    <div class="container">
      <span class="badge">2025 Pricing Data</span>
      <h1>Construction Cost Guides</h1>
      <p>Comprehensive pricing guides for contractors and homeowners. Get accurate estimates for your next project.</p>
    </div>
  </section>
  
  <section class="guides-section">
    <div class="container">
      ${Object.entries(groupedPages)
        .map(([serviceName, servicePages]) => {
          const icons: Record<string, string> = {
            "Retaining wall": "🧱",
            "Chimney rebuild": "🏠",
            Tuckpointing: "🔨",
            "Concrete patio": "🪨",
            "Roof repair": "🏗️",
            "Siding repair": "🪵",
            "Bathroom remodel": "🚿",
            "Kitchen remodel": "🍳",
          };
          return `
          <div class="service-group">
            <h2 class="service-title">
              <span class="service-icon">${icons[serviceName] || "📋"}</span>
              ${serviceName} Cost Guides
            </h2>
            <div class="guides-grid">
              ${servicePages
                .map(
                  (page) => `
                <a href="/guide/${page.slug}" class="guide-card">
                  <h3>${escapeHtml(page.title)}</h3>
                  <span class="meta">📊 2025 Pricing Guide</span>
                </a>
              `,
                )
                .join("")}
            </div>
          </div>
        `;
        })
        .join("")}
      
      <div class="total-count">
        <div class="number">${pages.length}</div>
        <p>Comprehensive pricing guides available</p>
      </div>
    </div>
  </section>
  
  <footer class="footer">
    <div class="container">
      <p>&copy; ${new Date().getFullYear()} ProBid AI. All rights reserved.</p>
    </div>
  </footer>
</body>
</html>
  `);
  }),
);

app.get(
  "/guide/:slug",
  asyncHandler(async (req, res) => {
    const slug = req.params.slug;
    const pageResult = await db
      .select()
      .from(seoPages)
      .where(eq(seoPages.slug, slug));
    const page = pageResult[0];

    if (!page) {
      return res.status(404).type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>Page Not Found | ProBid AI</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0a0e1a; color: #e8f0ff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; text-align: center; }
    h1 { font-size: 3rem; margin-bottom: 16px; }
    a { color: #6366f1; }
  </style>
</head>
<body>
  <div>
    <h1>404</h1>
    <p>The pricing guide you're looking for doesn't exist.</p>
    <p><a href="/guides">Browse all guides</a> | <a href="/">Go home</a></p>
  </div>
</body>
</html>
    `);
    }

    const serviceMatch = slug.match(/^estimate-(.+)-cost-(.+)$/);
    let serviceName = "Construction Service";
    let stateName = "US";

    if (serviceMatch) {
      const service = SEO_SERVICES.find((s) => s.slug === serviceMatch[1]);
      const state = SEO_STATES.find((s) => s.slug === serviceMatch[2]);
      if (service) serviceName = service.name;
      if (state) stateName = state.name;
    }

    const relatedPagesResult = await pool.query(
      "SELECT slug, title FROM seo_pages WHERE slug != $1 ORDER BY RANDOM() LIMIT 4",
      [slug],
    );
    const relatedPages = relatedPagesResult.rows as any[];

    // Stored titles were seeded with a hardcoded "2025" — render-time substitution
    // keeps them fresh without a destructive DB rewrite, and lets future years
    // roll over automatically. Same for the headline badge below.
    const currentYear = new Date().getFullYear();
    const displayTitle = page.title.replace(/\b2025\b/g, String(currentYear));
    const renderedTitle = displayTitle.replace(/\s*\|\s*ProBid AI\s*$/i, "");
    // Vary the meta description per service+state so Google doesn't flag the
    // 100 generated guide pages as duplicate content.
    const metaDescription =
      `Free ${serviceName.toLowerCase()} estimate guide for ${stateName} contractors. ` +
      `${currentYear} ${stateName} pricing ranges, what drives cost, and how ProBid AI ` +
      `helps you bid faster and more accurately.`;
    const ogImageUrl = "https://probidcore.net/og-image.png";

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <meta name="description" content="${escapeHtml(metaDescription)}"/>
  <link rel="canonical" href="https://probidcore.net/guide/${encodeURIComponent(slug)}"/>
  <meta property="og:title" content="${escapeHtml(renderedTitle)} | ProBid AI"/>
  <meta property="og:description" content="${escapeHtml(metaDescription)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:url" content="https://probidcore.net/guide/${encodeURIComponent(slug)}"/>
  <meta property="og:site_name" content="ProBid AI"/>
  <meta property="og:image" content="${ogImageUrl}"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${escapeHtml(renderedTitle)} | ProBid AI"/>
  <meta name="twitter:description" content="${escapeHtml(metaDescription)}"/>
  <meta name="twitter:image" content="${ogImageUrl}"/>
  <title>${escapeHtml(renderedTitle)} | ProBid AI</title>
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": `How much does ${serviceName.toLowerCase()} cost in ${stateName}?`,
        "acceptedAnswer": { "@type": "Answer", "text": `${serviceName} costs in ${stateName} vary based on project scope, materials, and labor rates. Use ProBid AI to get an instant estimate tailored to your specific project.` }
      },
      {
        "@type": "Question",
        "name": `How do I get a ${serviceName.toLowerCase()} estimate?`,
        "acceptedAnswer": { "@type": "Answer", "text": `Upload a photo or describe your ${serviceName.toLowerCase()} project on ProBid AI. The AI analyzes your job details and generates a professional estimate with material and labor breakdowns in under 30 seconds.` }
      },
      {
        "@type": "Question",
        "name": `What factors affect ${serviceName.toLowerCase()} pricing in ${stateName}?`,
        "acceptedAnswer": { "@type": "Answer", "text": `Key factors include project size, material quality, local labor rates in ${stateName}, site accessibility, permits required, and seasonal demand. ProBid AI accounts for regional pricing differences automatically.` }
      }
    ]
  })}
  </script>
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Service",
    "serviceType": serviceName,
    "name": `${serviceName} Estimates in ${stateName}`,
    "description": `AI-generated ${serviceName.toLowerCase()} estimates for ${stateName} contractors and homeowners. Get accurate ${currentYear} pricing in under 60 seconds.`,
    "areaServed": { "@type": "State", "name": stateName },
    "provider": {
      "@type": "Organization",
      "name": "ProBid AI",
      "url": "https://probidcore.net",
      "logo": "https://probidcore.net/og-image.png"
    },
    "offers": {
      "@type": "Offer",
      "price": "7.00",
      "priceCurrency": "USD",
      "url": "https://probidcore.net/pricing"
    }
  })}
  </script>
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "name": `ProBid AI — ${serviceName} Estimates in ${stateName}`,
    "url": `https://probidcore.net/guide/${slug}`,
    "image": "https://probidcore.net/og-image.png",
    "priceRange": "$$",
    "areaServed": { "@type": "State", "name": stateName },
    "description": metaDescription
  })}
  </script>
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://probidcore.net/" },
      { "@type": "ListItem", "position": 2, "name": "Guides", "item": "https://probidcore.net/guides" },
      { "@type": "ListItem", "position": 3, "name": `${serviceName} in ${stateName}`, "item": `https://probidcore.net/guide/${slug}` }
    ]
  })}
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4f46e5;
      --primary-light: #6366f1;
      --accent: #22c55e;
      --accent-dark: #16a34a;
      --bg-dark: #0a0e1a;
      --bg-card: rgba(18, 26, 42, 0.6);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      line-height: 1.7;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 0 24px; }
    .header {
      padding: 20px 0;
      border-bottom: 1px solid var(--border-color);
      background: rgba(10, 14, 26, 0.95);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-inner { display: flex; justify-content: space-between; align-items: center; max-width: 1200px; margin: 0 auto; padding: 0 24px; }
    .logo {
      font-size: 1.4rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-decoration: none;
    }
    .header-nav { display: flex; gap: 16px; align-items: center; }
    .nav-link {
      padding: 10px 20px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      transition: all 0.2s;
    }
    .nav-link:hover { color: var(--text-primary); }
    .nav-link.primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
    }
    .breadcrumb {
      padding: 20px 0;
      font-size: 14px;
      color: var(--text-muted);
    }
    .breadcrumb a { color: var(--primary-light); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .hero-section {
      padding: 60px 0;
      text-align: center;
      background: linear-gradient(180deg, rgba(79, 70, 229, 0.1) 0%, transparent 100%);
      border-bottom: 1px solid var(--border-color);
    }
    .hero-section h1 {
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      font-weight: 800;
      margin-bottom: 16px;
      line-height: 1.2;
    }
    .hero-section .subtitle {
      font-size: 1.1rem;
      color: var(--text-muted);
      max-width: 600px;
      margin: 0 auto 24px;
    }
    .hero-badges { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .badge {
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
    }
    .badge-green { background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); color: var(--accent); }
    .badge-blue { background: rgba(99, 102, 241, 0.15); border: 1px solid var(--border-light); color: var(--primary-light); }
    .content-section { padding: 60px 0; }
    .seo-content section { margin-bottom: 40px; }
    .seo-content h2 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 16px;
      color: var(--text-primary);
    }
    .seo-content p { margin-bottom: 16px; color: var(--text-muted); }
    .seo-content ul, .seo-content ol {
      margin: 16px 0;
      padding-left: 24px;
      color: var(--text-muted);
    }
    .seo-content li { margin-bottom: 12px; }
    .seo-content strong { color: var(--text-primary); }
    .price-card {
      background: var(--bg-card);
      border: 2px solid var(--border-light);
      border-radius: 16px;
      padding: 32px;
      text-align: center;
      margin: 24px 0;
    }
    .price-range {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .price-range .low, .price-range .high {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent) 0%, #4ade80 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .price-range .separator { font-size: 1.25rem; color: var(--text-muted); }
    .price-range .unit { font-size: 1rem; color: var(--text-muted); margin-left: 8px; }
    .price-note { margin-top: 16px; font-size: 14px; color: var(--text-muted); }
    .cta-section {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%);
      border: 1px solid var(--border-light);
      border-radius: 20px;
      padding: 48px;
      text-align: center;
      margin-top: 40px;
    }
    .cta-section h2 { margin-bottom: 12px; }
    .cta-section p { max-width: 500px; margin: 0 auto 24px; }
    .cta-button {
      display: inline-block;
      padding: 16px 40px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      color: #0a0e1a;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      box-shadow: 0 4px 20px rgba(34, 197, 94, 0.3);
      transition: all 0.3s;
    }
    .cta-button:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(34, 197, 94, 0.4);
    }
    .related-guides {
      padding: 60px 0;
      border-top: 1px solid var(--border-color);
    }
    .related-guides h2 { margin-bottom: 24px; text-align: center; }
    .guides-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 16px;
    }
    .guide-card {
      display: block;
      padding: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      text-decoration: none;
      color: var(--text-primary);
      transition: all 0.3s;
    }
    .guide-card:hover {
      border-color: var(--border-light);
      transform: translateY(-2px);
    }
    .guide-card h3 { font-size: 14px; font-weight: 600; }
    .footer {
      padding: 40px 0;
      text-align: center;
      border-top: 1px solid var(--border-color);
      color: var(--text-muted);
      font-size: 14px;
    }
    /* Mid-page CTA band (previously inline-styled) — moved to CSS so the
       page passes "no inline style attributes" SEO/perf checks and so the
       styling is cacheable with the rest of the page. */
    .guide-mid-cta {
      padding: 48px 0;
      background: linear-gradient(135deg, rgba(34,197,94,0.08) 0%, rgba(79,70,229,0.08) 100%);
      border-top: 1px solid var(--border-color);
      border-bottom: 1px solid var(--border-color);
    }
    .guide-mid-cta-inner { text-align: center; max-width: 700px; }
    .guide-mid-cta h2 { font-size: 1.75rem; font-weight: 800; margin-bottom: 12px; }
    .guide-mid-cta p { color: var(--text-muted); font-size: 1rem; margin-bottom: 8px; }
    .guide-mid-cta .free-line { color: var(--accent); font-weight: 600; font-size: 0.875rem; margin-bottom: 24px; }
    .guide-mid-cta .cta-button { /* reuse global .cta-button */ }
    .guide-mid-cta .post-cta { color: var(--text-muted); font-size: 0.75rem; margin-top: 12px; }
    .footer-links { margin-top: 8px; }
    .footer-links a { color: var(--primary-light); text-decoration: none; }
    .footer-links a:hover { text-decoration: underline; }
    @media (max-width: 640px) {
      .hero-section { padding: 40px 0; }
      .content-section { padding: 40px 0; }
      .cta-section { padding: 32px 20px; }
      .guide-mid-cta { padding: 32px 20px; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      <nav class="header-nav">
        <a href="/guides" class="nav-link">All Guides</a>
        <a href="/signup" class="nav-link primary">Get Free Estimate</a>
      </nav>
    </div>
  </header>
  
  <div class="container">
    <nav class="breadcrumb">
      <a href="/">Home</a> &rsaquo; <a href="/guides">Guides</a> &rsaquo; ${escapeHtml(serviceName)} in ${escapeHtml(stateName)}
    </nav>
  </div>
  
  <section class="hero-section">
    <div class="container">
      <h1>${escapeHtml(renderedTitle)}</h1>
      <p class="subtitle">Get accurate pricing information and find qualified contractors for your ${serviceName.toLowerCase()} project in ${stateName}.</p>
      <div class="hero-badges">
        <span class="badge badge-green">${currentYear} Updated Prices</span>
        <span class="badge badge-blue">${escapeHtml(stateName)} Market Rates</span>
      </div>
    </div>
  </section>
  
  <section class="content-section">
    <div class="container">
      ${page.content}
    </div>
  </section>
  
  <section class="guide-mid-cta">
    <div class="container guide-mid-cta-inner">
      <h2>Stop Guessing on ${escapeHtml(serviceName)} Costs</h2>
      <p>Get a professional, AI-generated estimate for your ${escapeHtml(stateName)} project in under 30 seconds. Snap a photo or describe the job — ProBid handles the rest.</p>
      <p class="free-line">$7 single estimate · 7-day free trial of Pro · Built by a working contractor</p>
      <a href="/signup" class="cta-button">Start 7-Day Free Trial</a>
      <p class="post-cta">Generate a full estimate in about a minute — straight from a photo</p>
    </div>
  </section>

  <section class="related-guides">
    <div class="container">
      <h2>Related Pricing Guides</h2>
      <div class="guides-grid">
        ${relatedPages
          .map(
            (p: any) => `
          <a href="/guide/${p.slug}" class="guide-card">
            <h3>${escapeHtml(p.title)}</h3>
          </a>
        `,
          )
          .join("")}
      </div>
    </div>
  </section>
  
  <footer class="footer">
    <div class="container">
      <p>&copy; ${currentYear} ProBid AI. All rights reserved.</p>
      <p class="footer-links"><a href="/guides">Browse All Pricing Guides</a> · <a href="/pricing">Pricing</a> · <a href="/refer">Referral Program</a></p>
    </div>
  </footer>
</body>
</html>
  `);
  }),
);


}

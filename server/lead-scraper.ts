/**
 * Lead Scraper Module
 *
 * Queries Google Maps Places API (when billing is enabled) for contractor businesses.
 * Falls back to YellowPages directory scraping which provides business websites.
 * Extracts emails from business websites using multi-strategy approach.
 * Deduplicates by email and phone before insert.
 * Auto-enrolls new leads in a three-touch outreach sequence (Day 0, Day 3, Day 7).
 */

import crypto from "crypto";
import { db } from "./db.js";
import {
  scrapedLeads,
  leadOutreachQueue,
} from "../shared/schema.js";
import { and, eq, or, type SQL } from "drizzle-orm";
import { computeScore, deriveStage } from "./lead-engine.js";
import { log } from "./lib/logger.js";
import { redactEmail, redactPhone, scrubEmailsInText } from "./lib/log-redact.js";

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

// Set to true after the first REQUEST_DENIED from Google Places within a scraper
// run so we skip all subsequent calls for that run rather than spamming the log
// once per city × trade combination. Reset to false at the start of each run.
let placesApiBillingDenied = false;

// Tracks live Google Places API health so server.ts can surface it in /api/admin/system-status.
// null = untested this process lifetime; true = last call succeeded; false = last call denied.
const _googlePlacesApiState: { ok: boolean | null; error_message: string | null; checkedAt: number | null } = {
  ok: null,
  error_message: null,
  checkedAt: null,
};

/** Returns the last-known Google Places API health from scraper calls. */
export function getGooglePlacesApiStatus() {
  return { ..._googlePlacesApiState };
}

// ─── Google Places API response shapes ────────────────────────────────────────

interface GooglePlaceResult {
  place_id: string;
  name?: string;
}

interface GooglePlacesSearchResponse {
  status: string;
  error_message?: string;
  results?: GooglePlaceResult[];
  next_page_token?: string;
}

interface GooglePlaceDetails {
  name?: string;
  formatted_phone_number?: string;
  website?: string;
  formatted_address?: string;
}

interface GooglePlaceDetailsResponse {
  status: string;
  result?: GooglePlaceDetails;
}

// ─── Internal types ────────────────────────────────────────────────────────────

interface PlaceLead {
  name: string;
  email: string | null;
  phone: string | null;
  businessType: string;
  location: string;
  website: string | null;
}

/** Structured drop reason for per-candidate observability */
type DropReason =
  | "no_email_found"
  | "invalid_email_format"
  | "email_skip_pattern"
  | "placeholder_domain"
  | "dedupe_email"
  | "dedupe_phone"
  | "dedupe_name_location"
  | "no_contact_method"
  | "insert_error";

/**
 * Compute the ordered contact-method priority for a lead, returning a CSV
 * string suitable for the `contact_method_priority` column.
 *
 * Priority (highest → lowest, per Task #141 spec):
 *   phone (SMS preferred, then voice) → website_form → email
 *
 * `phone` is listed before `sms` because the same number can be voice-called
 * if SMS hard-fails. Returns null when no contact method is reachable
 * (caller should drop the candidate in that case).
 */
function computeContactMethodPriority(
  email: string | null,
  phone: string | null,
  website: string | null,
): string | null {
  const channels: string[] = [];
  if (phone) channels.push("phone", "sms");
  if (website) channels.push("website_form");
  if (email) channels.push("email");
  return channels.length > 0 ? channels.join(",") : null;
}

/**
 * Compute the contactability bucket for a lead. Independent of `stage`
 * (which tracks engagement). Returns one of:
 *   - "fully_contactable"        — has email + at least one other channel
 *   - "email_only"               — has only email
 *   - "no_email_but_contactable" — no email, has phone or website
 *   - "uncontactable"            — nothing (caller should drop)
 */
function computeLeadStatus(
  email: string | null,
  phone: string | null,
  website: string | null,
): "fully_contactable" | "email_only" | "no_email_but_contactable" | "uncontactable" {
  const hasEmail = !!email;
  const hasOther = !!(phone || website);
  if (hasEmail && hasOther) return "fully_contactable";
  if (hasEmail) return "email_only";
  if (hasOther) return "no_email_but_contactable";
  return "uncontactable";
}

// ─── Trade and city configuration ─────────────────────────────────────────────

/** Contractor trade types to scrape for */
const TRADE_QUERIES = [
  { trade: "masonry", query: "masonry contractor" },
  { trade: "roofing", query: "roofing contractor" },
  { trade: "concrete", query: "concrete contractor" },
  { trade: "remodeling", query: "general contractor" },
  { trade: "tuckpointing", query: "tuckpointing masonry" },
  { trade: "painting", query: "painting contractor" },
  { trade: "drywall", query: "drywall contractor" },
  { trade: "plumbing", query: "plumbing contractor" },
  { trade: "electrical", query: "electrical contractor" },
  { trade: "landscaping", query: "landscaping contractor" },
  { trade: "hvac", query: "HVAC contractor" },
  { trade: "flooring", query: "flooring contractor" },
];

/** US metro areas to target — ordered so fresh/uncovered markets are scraped first */
const TARGET_CITIES = [
  // Southwest / Texas (high contractor density, high growth)
  "Dallas TX",
  "Houston TX",
  "San Antonio TX",
  "Austin TX",
  "Phoenix AZ",
  "Tucson AZ",
  "Albuquerque NM",
  // South
  "Atlanta GA",
  "Nashville TN",
  "Charlotte NC",
  "Tampa FL",
  "Jacksonville FL",
  "Memphis TN",
  "Louisville KY",
  "Baltimore MD",
  // West
  "Denver CO",
  "Las Vegas NV",
  "Seattle WA",
  "Portland OR",
  "Sacramento CA",
  // Northeast
  "Philadelphia PA",
  "Pittsburgh PA",
  "Providence RI",
  "Hartford CT",
  "Buffalo NY",
  // Midwest (already well-covered — scraped last so duplicates don't eat the cap)
  "Minneapolis MN",
  "Indianapolis IN",
  "Columbus OH",
  "Kansas City MO",
  "St Louis MO",
  "Detroit MI",
  "Cleveland OH",
  "Cincinnati OH",
  "Milwaukee WI",
  "Chicago IL",
];

// ─── Utilities ─────────────────────────────────────────────────────────────────

/** Rotating user agents to reduce bot detection */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Email prefixes that indicate automated/system senders OR generic catch-all inboxes —
 * blocked by prefix match against the LOCAL PART (before the @) only.
 * A real personal business email like "john@contractor.com" is NOT blocked.
 * Generic catch-alls (info@, contact@, etc.) are excluded because:
 *  - They reach a front desk or shared inbox, not a decision-maker
 *  - They have elevated spam-complaint rates that damage sending reputation
 *  - Cold outreach to shared inboxes rarely converts
 */
const EMAIL_BLOCKED_PREFIXES = [
  "noreply", "no-reply", "donotreply", "do-not-reply",
  "unsubscribe", "bounce", "bounces", "postmaster",
  "spam", "abuse", "security", "alerts",
  "info", "contact", "contactus", "admin", "hello",
  "sales", "marketing", "webmaster", "office",
  "enquiries", "enquiry", "general", "team", "support",
  "billing", "accounts", "hr", "help", "press", "media",
];

/**
 * Template/placeholder substring patterns blocked wherever they appear in the full address.
 * Kept narrow to avoid false positives on real contractor email addresses.
 */
const EMAIL_BLOCKED_SUBSTRINGS = [
  "test@", "sentry", "@mailinator.", "@guerrillamail.", "@sharklasers.", "@tempmail.",
  "your@", "youremail@", "name@yourcompany", "me@example", "you@example",
  "hello@example", "email@yourdomain",
];

/** Domains that are only used as placeholder examples — never real leads */
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net",
  "site.com", "yourdomain.com", "youremail.com",
  "email.com", "domain.com", "test.com", "fake.com",
  "mailinator.com", "guerrillamail.com", "sharklasers.com", "tempmail.com",
  // Known theme/template company domains that leak into scraped page content
  "qodeinteractive.com", "wpbakery.com", "elementor.com", "wix.com",
  "squarespace.com", "weebly.com", "duda.co", "jimdo.com",
]);

/**
 * TLDs that are actually image/file extensions, not valid email TLDs.
 * These appear when scrapers accidentally pick up image src attributes like "logo@2x.png".
 */
const FILE_EXTENSION_TLDS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "svg", "ico", "bmp", "tiff", "tif",
  "pdf", "doc", "docx", "xls", "xlsx", "zip", "mp4", "mp3", "avi", "mov",
  "js", "ts", "css", "html", "php", "aspx",
]);

/**
 * Validate and clean an email address.
 * Returns the cleaned email or null, with the explicit rejection reason when null.
 *
 * Blocking policy:
 *  - Prefix check: local-part only (e.g. "noreply@real.com" blocked; "renewalreply@co.com" allowed)
 *  - Substring check: applied to the full address for narrow template/placeholder patterns
 *  - Domain check: known placeholder domains always rejected
 *  - TLD check: file extension TLDs rejected (e.g. "logo@2x.png" → rejected)
 *  - Subdomain depth check: excessive subdomain depth (spam traps) rejected
 */
function validateEmail(raw: string | null | undefined): { email: string | null; reason: DropReason | null } {
  if (!raw) return { email: null, reason: "no_email_found" };
  // URL-decode first (catches %20, %40, etc. from scraped mailto: hrefs), then sanitize
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* leave as-is if malformed percent encoding */ }
  const email = decoded.trim().toLowerCase().split("?")[0].replace(/['"<>\\]/g, "").replace(/\s+/g, "");
  if (!email.includes("@") || !email.includes(".")) {
    return { email: null, reason: "invalid_email_format" };
  }
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)) {
    return { email: null, reason: "invalid_email_format" };
  }
  const tld = email.split(".").pop() ?? "";
  if (tld.length < 2) return { email: null, reason: "invalid_email_format" };

  // Reject file extension TLDs (scraper picks up image src attrs like "logo@2x.png")
  if (FILE_EXTENSION_TLDS.has(tld)) {
    return { email: null, reason: "invalid_email_format" };
  }

  const [localPart, domain] = email.split("@");

  // Reject domains with excessive subdomains (4+ dots = likely spam trap or obfuscated redirect)
  if ((domain.match(/\./g) ?? []).length >= 4) {
    return { email: null, reason: "placeholder_domain" };
  }

  // Prefix-only block: match local part exactly against automated sender prefixes
  if (EMAIL_BLOCKED_PREFIXES.some((prefix) => localPart === prefix || localPart.startsWith(`${prefix}.`) || localPart.startsWith(`${prefix}+`))) {
    return { email: null, reason: "email_skip_pattern" };
  }

  // Substring block: narrow template/placeholder patterns matched against full address
  if (EMAIL_BLOCKED_SUBSTRINGS.some((sub) => email.includes(sub))) {
    return { email: null, reason: "email_skip_pattern" };
  }

  // Reject known placeholder domains
  if (PLACEHOLDER_DOMAINS.has(domain)) {
    return { email: null, reason: "placeholder_domain" };
  }

  return { email, reason: null };
}

/** Convenience wrapper — returns only the validated email */
function isValidEmail(raw: string | null | undefined): string | null {
  return validateEmail(raw).email;
}

// ─── Email extraction ──────────────────────────────────────────────────────────

/**
 * Fetch a URL with a bounded number of retry attempts on transient 429/5xx errors.
 * Uses jittered exponential back-off between retries.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxAttempts = 3,
  outMeta?: { rateLimited?: boolean },
): Promise<Response | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        const backoff = 1000 * Math.pow(2, attempt) + Math.random() * 500;
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: "scraper_fetch_retry",
          url: url.slice(0, 80),
          status: res.status,
          attempt: attempt + 1,
          backoff_ms: Math.round(backoff),
        }));
        await sleep(backoff);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        const backoff = 600 * (attempt + 1) + Math.random() * 300;
        await sleep(backoff);
      }
    }
  }
  if (outMeta && lastError === "HTTP 429") outMeta.rateLimited = true;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "debug",
    message: "scraper_fetch_failed",
    url: url.slice(0, 80),
    attempts: maxAttempts,
    error: String(lastError),
  }));
  return null;
}

/**
 * Multi-strategy email extraction from a business website.
 * Strategy order:
 *   1. mailto: links on homepage
 *   2. Plain-text email patterns on homepage (after stripping scripts/styles)
 *   3. Same strategies on /contact, /contact-us, /about pages
 */
async function extractEmailFromWebsite(website: string | null): Promise<string | null> {
  if (!website) return null;

  let base: string;
  try {
    const u = new URL(website.startsWith("http") ? website : `https://${website}`);
    base = `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }

  const pagesToTry = [website, `${base}/contact`, `${base}/contact-us`, `${base}/about`];

  const fetchMeta = { rateLimited: false };
  for (const pageUrl of pagesToTry) {
    if (fetchMeta.rateLimited) break;

    const res = await fetchWithRetry(pageUrl, {
      headers: {
        "User-Agent": randomUserAgent(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    }, 3, fetchMeta);

    if (!res || !res.ok) continue;

    let html: string;
    try {
      html = await res.text();
    } catch {
      continue;
    }

    // Strategy 1: mailto: links
    const mailtoRegex = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
    for (const m of html.matchAll(mailtoRegex)) {
      const email = isValidEmail(m[1]);
      if (email) return email;
    }

    // Strategy 2: plain-text email patterns (strip scripts/styles first)
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");
    const textEmailRegex = /\b([a-zA-Z0-9._%+\-]{2,}@[a-zA-Z0-9.\-]{2,}\.[a-zA-Z]{2,})\b/g;
    for (const m of cleaned.matchAll(textEmailRegex)) {
      const email = isValidEmail(m[1]);
      if (email) return email;
    }

    // Polite delay between page requests on the same domain
    await sleep(1000 + Math.random() * 1000);
  }

  return null;
}

// ─── Google Places API ─────────────────────────────────────────────────────────

/** Fetch place details including website and phone */
async function fetchPlaceDetails(placeId: string): Promise<GooglePlaceDetails | null> {
  if (!GOOGLE_PLACES_API_KEY) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", "name,formatted_phone_number,website,formatted_address");
  url.searchParams.set("key", GOOGLE_PLACES_API_KEY);

  try {
    const res = await fetchWithRetry(url.toString(), {});
    if (!res || !res.ok) return null;
    const data: GooglePlaceDetailsResponse = await res.json() as GooglePlaceDetailsResponse;
    return data.result ?? null;
  } catch {
    return null;
  }
}

/** Fetch one page of Google Places Text Search results */
async function fetchGooglePlacesPage(
  trade: string,
  query: string,
  location: string,
  pageToken?: string,
): Promise<{ leads: PlaceLead[]; nextPageToken: string | null }> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", `${query} in ${location}`);
  url.searchParams.set("key", GOOGLE_PLACES_API_KEY);
  url.searchParams.set("type", "establishment");
  if (pageToken) url.searchParams.set("pagetoken", pageToken);

  const res = await fetchWithRetry(url.toString(), {});
  if (!res || !res.ok) return { leads: [], nextPageToken: null };

  const data: GooglePlacesSearchResponse = await res.json() as GooglePlacesSearchResponse;

  if (data.status === "REQUEST_DENIED") {
    _googlePlacesApiState.ok = false;
    _googlePlacesApiState.error_message = data.error_message ?? "REQUEST_DENIED";
    _googlePlacesApiState.checkedAt = Date.now();
    if (!placesApiBillingDenied) {
      placesApiBillingDenied = true;
      const googleMsg = data.error_message
        ? `Google says: "${data.error_message}"`
        : "No error_message returned by Google.";
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: `Google Places REQUEST_DENIED — ${googleMsg}`,
        error_message: data.error_message ?? null,
        hint: "1) Enable the Places API at https://console.cloud.google.com/apis/library/places-backend.googleapis.com  2) Link a billing account at https://console.cloud.google.com/project/_/billing/enable",
        diagnostic_url: `/api/admin/test-google-places (send x-admin-key header)`,
      }));
    }
    return { leads: [], nextPageToken: null };
  }

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    return { leads: [], nextPageToken: null };
  }

  // Mark API as healthy on any OK/ZERO_RESULTS response
  _googlePlacesApiState.ok = true;
  _googlePlacesApiState.error_message = null;
  _googlePlacesApiState.checkedAt = Date.now();

  const leads: PlaceLead[] = [];
  for (const place of data.results ?? []) {
    const details = await fetchPlaceDetails(place.place_id);
    if (!details) continue;
    const email = await extractEmailFromWebsite(details.website ?? null);
    leads.push({
      name: place.name ?? "Unknown Business",
      email,
      phone: details.formatted_phone_number ?? null,
      businessType: trade,
      location,
      website: details.website ?? null,
    });
  }

  return {
    leads,
    nextPageToken: data.next_page_token ?? null,
  };
}

/**
 * Query Google Places Text Search API with pagination support (up to 3 pages ≈ 60 results).
 * Google Places requires a ≥2 second delay between paginated requests.
 */
async function queryGooglePlaces(trade: string, query: string, location: string): Promise<PlaceLead[]> {
  if (!GOOGLE_PLACES_API_KEY || placesApiBillingDenied) return [];

  const allLeads: PlaceLead[] = [];
  let pageToken: string | undefined = undefined;
  let pagesFetched = 0;
  const maxPages = 3;

  try {
    do {
      if (pagesFetched > 0 && pageToken) {
        // Google requires a short delay before next_page_token becomes valid
        await sleep(2200);
      }
      const { leads, nextPageToken } = await fetchGooglePlacesPage(trade, query, location, pageToken);
      allLeads.push(...leads);
      pageToken = nextPageToken ?? undefined;
      pagesFetched++;
    } while (pageToken && pagesFetched < maxPages);
  } catch {
    // Return whatever was collected before the error
  }

  return allLeads;
}

// ─── YellowPages directory scraping ───────────────────────────────────────────

interface YPListing {
  name: string;
  website: string;
  phone: string | null;
  ypPath: string | null;
}

/**
 * Scrape contractor listings from YellowPages.
 *
 * Strategy:
 *   1. Fetch YP search results page (with retry/back-off on 429/5xx)
 *   2. Extract business names, phones, and website links ("track-visit-website")
 *   3. For businesses with websites, run multi-strategy email extraction
 *   4. For businesses without a website in the search results, visit the YP listing
 *      page which sometimes has a mailto: email directly
 */
async function queryDirectoryListings(trade: string, city: string): Promise<PlaceLead[]> {
  const location = city.replace(/,\s*/g, "+").replace(/\s+/g, "+");
  const tradeSlug = trade.replace(/\s+/g, "+");
  const url = `https://www.yellowpages.com/search?search_terms=${tradeSlug}+contractor&geo_location_terms=${location}`;

  const res = await fetchWithRetry(url, {
    headers: {
      "User-Agent": randomUserAgent(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res || !res.ok) return [];

  let html: string;
  try {
    html = await res.text();
  } catch {
    return [];
  }

  /**
   * Parse each website listing from the page by finding track-visit-website links,
   * then searching backwards within a window to find the closest business-name and phone.
   * This handles YP's mixed layout of sponsored + organic results correctly.
   */
  const listings: YPListing[] = [];
  const processedWebsites = new Set<string>();

  const wsPattern = /class="[^"]*track-visit-website[^"]*"[^>]*href="([^"]+)"/gi;
  for (const wsMatch of html.matchAll(wsPattern)) {
    const website = wsMatch[1];
    if (!website || processedWebsites.has(website)) continue;
    processedWebsites.add(website);

    const wsPos = wsMatch.index!;
    const lookback = html.substring(Math.max(0, wsPos - 2000), wsPos);
    const nameMatches = [...lookback.matchAll(/class="business-name"[^>]*href="(\/[^"]+)"[^>]*>(?:<span>)?([^<]+)(?:<\/span>)?<\/a>/gi)];
    const lastNameMatch = nameMatches[nameMatches.length - 1];
    const rawName = lastNameMatch ? lastNameMatch[2].replace(/^\d+\.\s+/, "").trim() : "Unknown Business";
    const name = rawName
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const ypPath = lastNameMatch?.[1] ?? null;

    const lookforward = html.substring(wsPos, Math.min(html.length, wsPos + 1000));
    const phoneMatch = lookback.match(/\((\d{3})\)\s*(\d{3})-(\d{4})/) ??
                       lookforward.match(/\((\d{3})\)\s*(\d{3})-(\d{4})/);
    const phone = phoneMatch ? `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}` : null;

    listings.push({ name, website, phone, ypPath });
  }

  // Also collect any listings that have a YP path but no direct website (for fallback)
  const allNamePattern = /class="business-name"[^>]*href="(\/[^"]+)"[^>]*>(?:<span>)?([^<]+)(?:<\/span>)?<\/a>/gi;
  const allNames: Array<{ name: string; ypPath: string }> = [];
  for (const m of html.matchAll(allNamePattern)) {
    const name = m[2].replace(/^\d+\.\s+/, "").trim();
    const ypPath = m[1];
    if (!allNames.some((x) => x.ypPath === ypPath)) {
      allNames.push({ name, ypPath });
    }
  }

  const leads: PlaceLead[] = [];

  // Process each business with a website — random delay between requests
  for (const listing of listings) {
    if (leads.length >= 15) break;
    await sleep(500 + Math.random() * 500);
    const email = await extractEmailFromWebsite(listing.website);
    leads.push({
      name: listing.name,
      email,
      phone: listing.phone,
      businessType: trade,
      location: city,
      website: listing.website,
    });
  }

  // For businesses without websites in search results, visit their YP listing page
  const listedWebsites = new Set(listings.map((l) => l.ypPath).filter(Boolean));
  const withoutWebsite = allNames.filter((n) => !listedWebsites.has(n.ypPath)).slice(0, 5);

  for (const { ypPath, name } of withoutWebsite) {
    if (leads.length >= 15) break;

    await sleep(800 + Math.random() * 400);
    const listingRes = await fetchWithRetry(`https://www.yellowpages.com${ypPath}`, {
      headers: { "User-Agent": randomUserAgent(), "Accept": "text/html" },
    });
    if (!listingRes || !listingRes.ok) continue;

    let listingHtml: string;
    try {
      listingHtml = await listingRes.text();
    } catch {
      continue;
    }

    const mailtoMatch = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i.exec(listingHtml);
    const email = mailtoMatch ? isValidEmail(mailtoMatch[1]) : null;

    const wsMatch = /class="[^"]*website-link[^"]*"[^>]*href="([^"]+)"/i.exec(listingHtml);
    const website = wsMatch?.[1] ?? null;

    const finalEmail = email ?? (website ? await extractEmailFromWebsite(website) : null);
    const phoneMatch = /\((\d{3})\)\s*(\d{3})-(\d{4})/.exec(listingHtml);
    const phone = phoneMatch ? `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}` : null;

    leads.push({ name, email: finalEmail, phone, businessType: trade, location: city, website });
  }

  return leads;
}

// ─── Lead insertion and outreach enrollment ────────────────────────────────────

function genToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

/**
 * Enroll a lead in the day0/day3/day7 email sequence. SMS is owned by the
 * outreach cron (high-intent + 40/day cap) so we always queue day0 here.
 */
async function enrollInOutreach(leadId: string): Promise<void> {
  const now = new Date().toISOString();
  const entries = [
    { templateId: "outreach_day0", scheduledFor: futureDate(0) },
    { templateId: "outreach_day3", scheduledFor: futureDate(3) },
    { templateId: "outreach_day7", scheduledFor: futureDate(7) },
  ].map((e) => ({
    leadId,
    templateId: e.templateId,
    scheduledFor: e.scheduledFor,
    status: "pending",
    openToken: genToken(),
    clickToken: genToken(),
    unsubscribeToken: genToken(),
    createdAt: now,
  }));
  await db.insert(leadOutreachQueue).values(entries);
}

// ─── ScrapeResult type ─────────────────────────────────────────────────────────

export interface ScrapeResult {
  total: number;
  added: number;
  skipped: number;
  errors: number;
  sources: Record<string, number>;
}

// ─── Core per-candidate insert logic ──────────────────────────────────────────

/**
 * Insert a verified lead and enroll in outreach if not already present.
 * Logs a structured drop record for every candidate that is rejected.
 * Returns true if a new lead was added, false if skipped/duplicate.
 */
async function insertLeadIfNew(
  candidate: PlaceLead & { source: string },
  now: number,
): Promise<boolean> {
  // Validate email but DO NOT drop the candidate when it's missing or invalid.
  // (Task #141 — never lose a lead just because email is missing.) Instead we
  // store the lead with `lead_status = 'no_email_but_contactable'` if any
  // other channel (phone or website) is available.
  const { email: validEmail, reason: emailReason } = validateEmail(candidate.email);
  const hasPhone = !!candidate.phone;
  const hasWebsite = !!candidate.website;

  // Only drop when there is genuinely no way to reach the business.
  if (!validEmail && !hasPhone && !hasWebsite) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "debug",
      message: "lead_dropped",
      drop_reason: "no_contact_method",
      email_reason: emailReason ?? "no_email_found",
      business: candidate.name,
      raw_email: redactEmail(candidate.email),
      website: candidate.website ?? null,
      phone: redactPhone(candidate.phone),
      city: candidate.location,
      trade: candidate.businessType,
      source: candidate.source,
    }));
    return false;
  }

  // Dedup: prefer email match, then phone match, then name+location.
  // Each branch only runs when the candidate has that identifier so we don't
  // accidentally collapse all no-email leads into one row.
  const dedupConditions: SQL[] = [];
  if (validEmail) dedupConditions.push(eq(scrapedLeads.email, validEmail));
  if (candidate.phone) dedupConditions.push(eq(scrapedLeads.phone, candidate.phone));
  // Defensive name+location match for leads that have only a website
  if (!validEmail && !candidate.phone && candidate.website) {
    dedupConditions.push(
      and(
        eq(scrapedLeads.name, candidate.name),
        eq(scrapedLeads.location, candidate.location),
      )!,
    );
  }

  let existing: {
    id: string;
    email: string | null;
    phone: string | null;
    website: string | null;
  }[];
  try {
    existing = await db
      .select({
        id: scrapedLeads.id,
        email: scrapedLeads.email,
        phone: scrapedLeads.phone,
        website: scrapedLeads.website,
      })
      .from(scrapedLeads)
      .where(or(...dedupConditions))
      .limit(1);
  } catch (err) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "lead_dropped",
      drop_reason: "insert_error",
      phase: "dedup_query",
      business: candidate.name,
      email: redactEmail(validEmail),
      city: candidate.location,
      trade: candidate.businessType,
      source: candidate.source,
      error: scrubEmailsInText(String(err)),
    }));
    return false;
  }

  if (existing.length > 0) {
    const existingRow = existing[0];
    const dedupeReason: DropReason = validEmail
      ? "dedupe_email"
      : candidate.phone
        ? "dedupe_phone"
        : "dedupe_name_location";

    // Upgrade-on-dedup: if the new candidate has channels the existing row is
    // missing, fill them in and recompute lead_status / contact_method_priority.
    // Without this, a lead first seen with phone-only would never get its email
    // upgraded when a later scrape finds it again with an email — defeating the
    // "never lose contact info" goal of Task #141.
    const upgradedEmail = existingRow.email ?? validEmail;
    const upgradedPhone = existingRow.phone ?? candidate.phone ?? null;
    const upgradedWebsite = existingRow.website ?? candidate.website ?? null;
    const upgradedSomething =
      (!existingRow.email && !!validEmail) ||
      (!existingRow.phone && !!candidate.phone) ||
      (!existingRow.website && !!candidate.website);

    if (upgradedSomething) {
      const newStatus = computeLeadStatus(upgradedEmail, upgradedPhone, upgradedWebsite);
      const newPriority = computeContactMethodPriority(upgradedEmail, upgradedPhone, upgradedWebsite);
      try {
        await db
          .update(scrapedLeads)
          .set({
            email: upgradedEmail,
            phone: upgradedPhone,
            website: upgradedWebsite,
            leadStatus: newStatus,
            contactMethodPriority: newPriority,
            updatedAt: now,
          })
          .where(eq(scrapedLeads.id, existingRow.id));
        log("info", "Lead contact channels upgraded on re-scrape", {
          leadId: existingRow.id,
          newStatus,
          addedEmail: !existingRow.email && !!validEmail,
          addedPhone: !existingRow.phone && !!candidate.phone,
          addedWebsite: !existingRow.website && !!candidate.website,
        });
      } catch (upgradeErr) {
        log("warn", "Lead upgrade-on-dedup failed", {
          leadId: existingRow.id,
          error: scrubEmailsInText(String(upgradeErr)),
        });
      }
    }

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "debug",
      message: "lead_dropped",
      drop_reason: dedupeReason,
      business: candidate.name,
      email: redactEmail(validEmail),
      phone: redactPhone(candidate.phone),
      website: candidate.website ?? null,
      city: candidate.location,
      trade: candidate.businessType,
      source: candidate.source,
      upgraded: upgradedSomething,
    }));
    return false;
  }

  const id = crypto.randomUUID();
  const unsubscribeToken = genToken();

  const initialSignals = {
    email: validEmail,
    phone: candidate.phone ?? null,
    website: candidate.website ?? null,
    businessType: candidate.businessType,
    contacted: false,
  };
  const initialScore = computeScore(initialSignals);
  const initialStage = deriveStage(initialSignals);
  const contactMethodPriority = computeContactMethodPriority(
    validEmail,
    candidate.phone ?? null,
    candidate.website ?? null,
  );
  const leadStatus = computeLeadStatus(
    validEmail,
    candidate.phone ?? null,
    candidate.website ?? null,
  );

  try {
    await db.insert(scrapedLeads).values({
      id,
      name: candidate.name,
      email: validEmail,
      phone: candidate.phone ?? null,
      businessType: candidate.businessType,
      location: candidate.location,
      website: candidate.website ?? null,
      source: candidate.source,
      stage: initialStage,
      score: initialScore,
      unsubscribeToken,
      contactMethodPriority,
      leadStatus,
      createdAt: now,
      updatedAt: now,
    });

    // Hybrid outreach: queue every emailable lead. SMS is no longer fired
    // inline — the cron owns the 40/day high-intent budget so all SMS sends
    // are gated centrally. Phone-only leads stay in scraped_leads and are
    // picked up by the cron's SMS pass once their score clears the gate.
    if (validEmail) {
      await enrollInOutreach(id);
    }

    const channels: string[] = [];
    if (validEmail) channels.push("outreach_day0,outreach_day3,outreach_day7");
    if (candidate.phone) channels.push("sms_pending");
    if (!validEmail && candidate.website) channels.push("website_form_pending");

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "lead_inserted",
      business: candidate.name,
      email: redactEmail(validEmail),
      phone: redactPhone(candidate.phone),
      website: candidate.website ?? null,
      city: candidate.location,
      trade: candidate.businessType,
      source: candidate.source,
      lead_status: leadStatus,
      contact_method_priority: contactMethodPriority,
      outreach: channels,
    }));

    return true;
  } catch (err) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "lead_dropped",
      drop_reason: "insert_error",
      phase: "db_insert",
      business: candidate.name,
      email: redactEmail(validEmail),
      city: candidate.location,
      trade: candidate.businessType,
      source: candidate.source,
      error: scrubEmailsInText(String(err)),
    }));
    return false;
  }
}

// ─── Main scrape runner ────────────────────────────────────────────────────────

/**
 * Maximum candidates (found, regardless of inserted/skipped) processed per run.
 * Prevents the daily cron from running too long when the trade × city matrix is large.
 * At ~15 candidates per city/trade combo, 200 ≈ 13 combos ≈ under 5 minutes.
 */
const MAX_CANDIDATES_PER_RUN = 600;

/**
 * Run a full lead scraping pass.
 * Queries Google Places (when billing enabled) AND YellowPages directory.
 * For each candidate, extracts emails using a multi-strategy approach.
 * Deduplicates by email and phone. Inserts email-confirmed leads only.
 * Stops early once MAX_CANDIDATES_PER_RUN candidates have been processed.
 */
export async function runLeadScraper(): Promise<ScrapeResult> {
  let total = 0;
  let added = 0;
  let skipped = 0;
  let errors = 0;
  const sources: Record<string, number> = { google_places: 0, yellowpages: 0 };

  // Reset per-run circuit-breaker so the billing warning can fire once per run
  placesApiBillingDenied = false;

  const now = Date.now();

  outerLoop:
  for (const city of TARGET_CITIES) {
    for (const { trade, query } of TRADE_QUERIES) {
      // Stop if we have processed enough candidates for this run
      if (total >= MAX_CANDIDATES_PER_RUN) {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Lead scraper run cap reached",
          totalCandidates: total,
          maxCandidatesPerRun: MAX_CANDIDATES_PER_RUN,
        }));
        break outerLoop;
      }

      let cityTradeAdded = 0;

      // Source 1: Google Places API (requires billing to be enabled in Google Cloud)
      if (GOOGLE_PLACES_API_KEY) {
        try {
          const candidates = await queryGooglePlaces(trade, query, city);
          total += candidates.length;
          for (const c of candidates) {
            try {
              const wasAdded = await insertLeadIfNew({ ...c, source: "google_places" }, now);
              if (wasAdded) { added++; cityTradeAdded++; sources.google_places++; }
              else { skipped++; }
            } catch { errors++; }
          }
        } catch { errors++; }
      }

      // Source 2: YellowPages directory (no API key required)
      try {
        const dirCandidates = await queryDirectoryListings(trade, city);
        total += dirCandidates.length;
        for (const c of dirCandidates) {
          try {
            const wasAdded = await insertLeadIfNew({ ...c, source: "yellowpages" }, now);
            if (wasAdded) { added++; cityTradeAdded++; sources.yellowpages++; }
            else { skipped++; }
          } catch { errors++; }
        }
      } catch { errors++; }

      if (cityTradeAdded > 0) {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Lead scraper progress",
          city,
          trade,
          newLeads: cityTradeAdded,
          totalAdded: added,
        }));
      }

      // Brief pause between city/trade combos to avoid rate limiting
      await sleep(1000 + Math.random() * 1000);
    }
  }

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    message: "Lead scraper complete",
    total,
    added,
    skipped,
    errors,
    sources,
  }));

  return { total, added, skipped, errors, sources };
}

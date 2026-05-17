type AnalyticsEvent =
  | "cta_click"
  | "homepage_view"
  | "homepage_visit"
  | "pricing_view"
  | "pricing_visit"
  | "signup_page_visit"
  | "hero_cta_click"
  | "demo_card_click"
  | "pricing_cta_click"
  | "lead_form_submit"
  | "login_start"
  | "login_success"
  | "signup_start"
  | "signup_success"
  | "estimate_submitted"
  | "estimate_completed"
  | "estimate_created"
  | "estimate_flow_started"
  | "pdf_download"
  | "pdf_downloaded"
  | "upgrade_click"
  | "upgrade_clicked"
  | "checkout_started"
  | "paywall_hit"
  | "paywall_shown"
  | "single_estimate_clicked"
  | "subscription_clicked"
  | "checkout_success"
  | "saved_estimate_created"
  | "upgrade_modal_cta_clicked"
  | "dashboard_upgrade_cta_clicked"
  | "roi_banner_upgrade_clicked"
  | "onboarding_shown"
  | "share_to_unlock_copied"
  | "share_to_unlock_shared"
  | "share_to_unlock_upgrade_clicked"
  | "founding_banner_dismissed"
  | "founding_banner_cta_click"
  | "landing_cta_click"
  | "how_it_works_visible"
  | "faq_opened"
  | "procore_gate_shown"
  | "procore_gate_upgrade_clicked"
  | "procore_estimate_pushed"
  | "procore_push_modal_opened"
  | "probidcore_send_initiated"
  | "probidcore_send_estimate"
  | "probidcore_send_estimate_empty"
  | "probidcore_send_estimate_error"
  | "probidcore_line_items_error"
  | "demo_section_cta_click"
  | "itemized_estimate_builder_opened"
  | "itemized_estimate_clone_loaded"
  | "itemized_estimate_edit_loaded"
  | "itemized_estimate_submitted"
  | "itemized_estimate_created"
  | "itemized_estimate_updated"
  | "saved_line_item_picker_opened"
  | "saved_line_item_created"
  | "saved_line_item_inserted"
  | "saved_line_item_deleted"
  | "live_counter_viewed"
  | "hero_demo_cta_click"
  | "demo_video_loaded"
  | "demo_video_play"
  // hero_testimonial_viewed: fired once when the hero testimonial card is
  // at least 40% visible in the viewport (IntersectionObserver in
  // `HeroTestimonial`). One event per page load per user.
  | "hero_testimonial_viewed"
  // demo_video_play_clicked: fired when the user clicks the hero
  // "Watch 60-second demo" button that opens the demo modal. The modal
  // autoplays the video on open, so this event marks user intent to play
  // even though there is no separate play-control click.
  | "demo_video_play_clicked"
  // demo_video_completed: fired once per modal-open at >=90% playback of
  // the real video (via the timeupdate listener) or onEnded; for the
  // AnimatedDemo fallback, fired at 54s (90% of the 60s long-form cycle).
  // The `source` payload distinguishes "video" vs "animated_demo".
  | "demo_video_completed"
  // social_proof_logo_clicked: fired when a user clicks one of the four
  // trust chips in `TrustBar` (founder, pdf_output, trades, speed). The
  // chips are not literal logos today — when a press/partner logo strip
  // is added later, those clicks should fire the same event with a new
  // `item` value so the funnel stays consistent.
  | "social_proof_logo_clicked"
  | "contact_form_submitted"
  | "lead_form_submitted"
  | "lead_captured"
  | "lead_captured_redirect"
  | "estimate_form_started"
  | "exit_intent_triggered"
  | "exit_intent_cta_click"
  | "exit_intent_dismissed"
  | "sticky_mobile_cta_click";

const GA_ID = (import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined) || "G-KBY6Y0H8FQ";

const GA_EVENT_MAP: Partial<Record<AnalyticsEvent, string>> = {
  homepage_visit: "page_view_home",
  homepage_view: "page_view_home",
  pricing_visit: "page_view_pricing",
  pricing_view: "page_view_pricing",
  signup_page_visit: "page_view_signup",
  hero_cta_click: "cta_click_hero",
  landing_cta_click: "cta_click_landing",
  pricing_cta_click: "cta_click_pricing",
  signup_start: "signup_start",
  signup_success: "signup",
  estimate_flow_started: "estimate_flow_started",
  estimate_submitted: "estimate_started",
  estimate_completed: "estimate_completed",
  estimate_created: "estimate_created",
  pdf_downloaded: "pdf_downloaded",
  pdf_download: "pdf_downloaded",
  upgrade_clicked: "upgrade_clicked",
  upgrade_modal_cta_clicked: "upgrade_modal_cta_clicked",
  checkout_started: "checkout_started",
  checkout_success: "checkout_success",
  paywall_hit: "paywall_hit",
  paywall_shown: "paywall_shown",
  single_estimate_clicked: "single_estimate_clicked",
  subscription_clicked: "subscription_clicked",
  saved_estimate_created: "saved_estimate_created",
  demo_section_cta_click: "cta_click_demo",
};

interface MetaPixelEvent {
  standard: string;
  params?: Record<string, unknown>;
}

const META_EVENT_MAP: Partial<Record<AnalyticsEvent, MetaPixelEvent>> = {
  homepage_view: { standard: "ViewContent", params: { content_name: "homepage" } },
  pricing_view: { standard: "ViewContent", params: { content_name: "pricing" } },
  signup_success: { standard: "CompleteRegistration" },
  lead_form_submit: { standard: "Lead" },
  estimate_flow_started: { standard: "InitiateCheckout", params: { content_category: "estimate" } },
  estimate_completed: { standard: "Lead", params: { content_name: "estimate_generated" } },
  checkout_started: { standard: "InitiateCheckout" },
  checkout_success: { standard: "Purchase", params: { currency: "USD" } },
  upgrade_clicked: { standard: "AddToCart" },
  paywall_hit: { standard: "ViewContent", params: { content_name: "paywall" } },
};

interface GoogleAdsConversion {
  sendTo: string;
  value?: number;
  currency?: string;
}

const GADS_EVENT_MAP: Partial<Record<AnalyticsEvent, GoogleAdsConversion>> = {
  signup_success: { sendTo: "signup" },
  lead_form_submit: { sendTo: "lead" },
  estimate_completed: { sendTo: "estimate_generated" },
  checkout_started: { sendTo: "begin_checkout" },
  checkout_success: { sendTo: "purchase", value: 25, currency: "USD" },
};

interface AdConfig {
  metaPixelId: string | null;
  googleAdsId: string | null;
  googleAdsConversions: Record<string, string>;
}

let adConfig: AdConfig | null = null;
let adConfigPromise: Promise<AdConfig> | null = null;

// Browser-side event ID used for Meta Pixel + CAPI deduplication. The same
// ID is forwarded to the server (via signup/lead/checkout payloads) so the
// Pixel `eventID` and CAPI `event_id` match and Meta merges the pair.
export function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function loadAdConfig(): Promise<AdConfig> {
  if (adConfig) return Promise.resolve(adConfig);
  if (adConfigPromise) return adConfigPromise;

  const defaultConfig: AdConfig = { metaPixelId: null, googleAdsId: null, googleAdsConversions: {} };

  adConfigPromise = fetch("/api/ad-config")
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      const cfg: AdConfig = data?.data || defaultConfig;
      adConfig = cfg;
      if (cfg.metaPixelId) initMetaPixel(cfg.metaPixelId);
      if (cfg.googleAdsId) initGoogleAds(cfg.googleAdsId);
      return cfg;
    })
    .catch(() => {
      adConfig = defaultConfig;
      return defaultConfig;
    });

  return adConfigPromise;
}

let metaPixelInitialized = false;
let googleAdsInitialized = false;

function initMetaPixel(pixelId: string) {
  if (metaPixelInitialized) return;
  try {
    const w = window as unknown as { fbq?: (...args: unknown[]) => void };
    if (typeof w.fbq === "function") {
      w.fbq("init", pixelId);
      w.fbq("track", "PageView");
      metaPixelInitialized = true;
    }
  } catch {}
}

function initGoogleAds(adsId: string) {
  if (googleAdsInitialized) return;
  try {
    const w = window as unknown as { gtag?: (...args: unknown[]) => void };
    if (typeof w.gtag === "function") {
      w.gtag("config", adsId);
      googleAdsInitialized = true;
    }
  } catch {}
}

function sendToGA(event: AnalyticsEvent, properties?: Record<string, unknown>) {
  if (!GA_ID) return;
  const gaEventName = GA_EVENT_MAP[event];
  if (!gaEventName) return;
  try {
    const w = window as unknown as { gtag?: (...args: unknown[]) => void };
    if (typeof w.gtag === "function") {
      w.gtag("event", gaEventName, properties ?? {});
    }
  } catch {}
}

function sendToMeta(event: AnalyticsEvent, eventId: string, properties?: Record<string, unknown>) {
  if (!adConfig?.metaPixelId) return;
  const mapping = META_EVENT_MAP[event];
  if (!mapping) return;
  try {
    const w = window as unknown as { fbq?: (...args: unknown[]) => void };
    if (typeof w.fbq === "function") {
      const params = { ...mapping.params, ...properties };
      w.fbq("track", mapping.standard, params, { eventID: eventId });
    }
  } catch {}
}

function sendToGoogleAds(event: AnalyticsEvent, properties?: Record<string, unknown>) {
  if (!adConfig?.googleAdsId) return;
  const mapping = GADS_EVENT_MAP[event];
  if (!mapping) return;
  try {
    const w = window as unknown as { gtag?: (...args: unknown[]) => void };
    if (typeof w.gtag === "function") {
      const conversionLabel = adConfig.googleAdsConversions[mapping.sendTo];
      if (conversionLabel) {
        const conversionData: Record<string, unknown> = {
          send_to: `${adConfig.googleAdsId}/${conversionLabel}`,
        };
        if (mapping.value) conversionData.value = mapping.value;
        if (mapping.currency) conversionData.currency = mapping.currency;
        if (properties?.value) conversionData.value = properties.value;
        w.gtag("event", "conversion", conversionData);
      } else {
        w.gtag("event", mapping.sendTo, properties ?? {});
      }
    }
  } catch {}
}

const eventQueue: Array<{ event: AnalyticsEvent; properties?: Record<string, unknown>; eventId: string }> = [];

function flushQueue() {
  while (eventQueue.length > 0) {
    const item = eventQueue.shift()!;
    sendToMeta(item.event, item.eventId, item.properties);
    sendToGoogleAds(item.event, item.properties);
  }
}

loadAdConfig().then(() => flushQueue()).catch(() => {});

export function track(
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
  eventId?: string,
): void {
  // Caller may pass a pre-generated eventId so the matching server-side
  // CAPI event uses the same ID (dedup). Otherwise we mint one here.
  const finalEventId = eventId ?? generateEventId();

  sendToGA(event, properties);

  if (adConfig) {
    sendToMeta(event, finalEventId, properties);
    sendToGoogleAds(event, properties);
  } else {
    eventQueue.push({ event, properties, eventId: finalEventId });
    loadAdConfig().then(() => flushQueue()).catch(() => {});
  }

  fetch("/api/analytics/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ event, properties, eventId: finalEventId }),
  }).catch(() => {});
}

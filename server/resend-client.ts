import { Resend } from "resend";
import type { CreateEmailOptions, CreateEmailResponseSuccess } from "resend";
import { log } from "./lib/logger.js";

export interface ResendClientResult {
  client: Resend;
  fromEmail: string;
}

export interface SendWithRetryOptions {
  /** Deterministic key for the logical send event. Format `<event-type>/<entity-id>`.
   *  Same payload + same key within 24h → returns the original response without resending.
   *  Different payload + same key within 24h → 409 conflict (don't retry, change the key). */
  idempotencyKey: string;
  /** Max retry attempts on 429/5xx. Default 4 (so up to 5 total tries). */
  maxRetries?: number;
  /** Optional context for log lines. */
  logContext?: Record<string, unknown>;
}

const RETRYABLE_ERROR_NAMES = new Set([
  "rate_limit_exceeded",
  "internal_server_error",
  "application_error",
]);

function isRetryable(status: number | null | undefined, name: string | undefined): boolean {
  if (name && RETRYABLE_ERROR_NAMES.has(name)) return true;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  return false;
}

/** Send a single email with idempotency + exponential backoff retry on 429/5xx.
 *  Throws on non-retryable errors and after exhausting retries.
 *  Returns the Resend success payload (with `id`). */
export async function sendEmailWithRetry(
  client: Resend,
  payload: CreateEmailOptions,
  options: SendWithRetryOptions,
): Promise<CreateEmailResponseSuccess> {
  const maxRetries = options.maxRetries ?? 4;
  const ctx = options.logContext ?? {};
  let lastErrMsg = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await client.emails.send(payload, {
        idempotencyKey: options.idempotencyKey,
      });

      if (result.error) {
        const { name, statusCode, message } = result.error;
        lastErrMsg = `${name}${statusCode != null ? ` (HTTP ${statusCode})` : ""}: ${message}`;
        if (!isRetryable(statusCode, name)) {
          throw new Error(`Resend send failed (non-retryable): ${lastErrMsg}`);
        }
        log("warn", "Resend send retryable error", {
          ...ctx,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          idempotencyKey: options.idempotencyKey,
          error: lastErrMsg,
        });
      } else if (result.data) {
        return result.data;
      } else {
        lastErrMsg = "Resend returned no data and no error";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Resend send failed (non-retryable)")) throw err;
      lastErrMsg = msg;
      log("warn", "Resend send transport error", {
        ...ctx,
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        idempotencyKey: options.idempotencyKey,
        error: lastErrMsg,
      });
    }

    if (attempt < maxRetries) {
      const delayMs = Math.min(8000, 1000 * Math.pow(2, attempt));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `Resend send failed after ${maxRetries + 1} attempts: ${lastErrMsg}`,
  );
}

const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "aol.com", "icloud.com", "me.com", "live.com", "msn.com",
]);

const DEFAULT_FROM = "Jesse Kirchner <jesse@probidcore.net>";

function sanitizeFromEmail(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_FROM;
  const domain = raw.toLowerCase().split("@")[1]?.split(">")[0]?.trim();
  if (!domain || FREE_EMAIL_PROVIDERS.has(domain)) return DEFAULT_FROM;
  return raw;
}

/**
 * Returns a Resend client configured for cold outreach emails.
 * The sender address MUST be sourced from OUTREACH_FROM_EMAIL env var
 * (e.g. "ProBid AI <hello@outreach.probidcore.net>").
 *
 * FAIL-CLOSED: if OUTREACH_FROM_EMAIL is not set or resolves to a free-email
 * provider, this function throws instead of falling back to the transactional
 * sender. Cold outreach email sends will be suppressed until the operator
 * configures a dedicated sending domain in Resend and sets the env var.
 * Use this for lead scraper outreach sequences only — not transactional email.
 */
export async function getOutreachResendClient(): Promise<ResendClientResult> {
  const rawOutreachFrom = process.env.OUTREACH_FROM_EMAIL ?? null;

  if (!rawOutreachFrom) {
    throw new Error(
      "OUTREACH_FROM_EMAIL is not set. " +
      "Cold outreach emails are suppressed to protect the transactional sender domain. " +
      "Configure outreach.probidcore.net in Resend (SPF/DKIM/DMARC), then set " +
      "OUTREACH_FROM_EMAIL=ProBid AI <hello@outreach.probidcore.net> in Replit Secrets."
    );
  }

  const domain = rawOutreachFrom.toLowerCase().split("@")[1]?.split(">")[0]?.trim();
  if (!domain || FREE_EMAIL_PROVIDERS.has(domain)) {
    throw new Error(
      `OUTREACH_FROM_EMAIL is set to a free-email provider domain ("${domain}"). ` +
      "Use a dedicated sending domain (e.g. outreach.probidcore.net) verified in Resend."
    );
  }

  const base = await getResendClient();
  return { client: base.client, fromEmail: rawOutreachFrom };
}

/**
 * Real Resend API keys always start with "re_" and are roughly 36 chars
 * (currently 32+ in practice). The Resend connector has been observed
 * returning corrupted values (e.g. a password string) in the api_key
 * field — and the same bad value can leak into AI_INTEGRATIONS_RESEND_API_KEY.
 * This shape check lets us skip any obviously-invalid candidate before
 * trying it as a credential, so a single bad source doesn't silently
 * break sends when a valid manually-rotated key is also present.
 */
function isValidResendApiKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("re_") && value.length >= 20;
}

export async function getResendClient(): Promise<ResendClientResult> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;

  if (hostname && xReplitToken) {
    try {
      const response = await fetch(
        "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=resend",
        {
          headers: {
            Accept: "application/json",
            X_REPLIT_TOKEN: xReplitToken,
          },
        }
      );
      const data = await response.json();
      const conn = data.items?.[0];
      const connKey = conn?.settings?.api_key;
      if (isValidResendApiKey(connKey)) {
        return {
          client: new Resend(connKey),
          fromEmail: sanitizeFromEmail(conn.settings.from_email),
        };
      }
      if (connKey) {
        log("warn", "Resend connector returned invalid api_key shape — trying env-var fallback", {
          source: "connector",
          keyLength: typeof connKey === "string" ? connKey.length : null,
        });
      }
    } catch {
      /* fall through to env-var fallback */
    }
  }

  // Try env-var candidates in order, but skip any that fail the shape check.
  // Order matters: a manually-set RESEND_API_KEY Secret should win over the
  // integration-provided AI_INTEGRATIONS_RESEND_API_KEY, so a rotated key
  // can recover production even if the integration env value is stale/bad.
  const candidates: Array<{ source: string; value: string | undefined }> = [
    { source: "RESEND_API_KEY", value: process.env.RESEND_API_KEY },
    { source: "AI_INTEGRATIONS_RESEND_API_KEY", value: process.env.AI_INTEGRATIONS_RESEND_API_KEY },
  ];

  for (const { source, value } of candidates) {
    if (!value) continue;
    if (isValidResendApiKey(value)) {
      return {
        client: new Resend(value),
        fromEmail: DEFAULT_FROM,
      };
    }
    log("warn", "Resend env-var candidate has invalid api_key shape — skipping", {
      source,
      keyLength: (value as string).length,
    });
  }

  throw new Error(
    "Resend credentials not available: no valid API key found in connector, " +
    "RESEND_API_KEY, or AI_INTEGRATIONS_RESEND_API_KEY (a key must start with " +
    "\"re_\" and be at least 20 chars). Check Replit Secrets and the Resend integration."
  );
}

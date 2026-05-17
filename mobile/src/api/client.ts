import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform, Linking } from 'react-native';

const TOKEN_KEY = 'probid_auth_token';
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const configuredBaseUrl = Constants.expoConfig?.extra?.apiBaseUrl as string | undefined;
if (!configuredBaseUrl) {
  console.warn('apiBaseUrl is not set in Expo config (app.json extra). API requests will fail unless configured.');
}
export const API_BASE_URL: string = configuredBaseUrl ?? '';

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 90_000;

let authToken: string | null = null;
let onAuthExpired: (() => void) | null = null;
let refreshInProgress: Promise<boolean> | null = null;

export function setAuthExpiredHandler(handler: () => void) {
  onAuthExpired = handler;
}

export async function loadToken(): Promise<string | null> {
  if (authToken) return authToken;
  try {
    authToken = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    authToken = null;
  }
  return authToken;
}

export async function saveToken(token: string): Promise<void> {
  authToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  authToken = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

function base64urlDecode(input: string): string {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const bytes = Uint8Array.from(
    globalThis.atob(base64),
    (c) => c.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

function getTokenExpiry(token: string): number | null {
  try {
    const decoded = base64urlDecode(token);
    const parts = decoded.split(':');
    if (parts.length !== 5 || parts[0] !== 'mobile') return null;
    const expiresAt = parseInt(parts[3], 10);
    return isNaN(expiresAt) ? null : expiresAt;
  } catch {
    return null;
  }
}

async function attemptTokenRefresh(): Promise<boolean> {
  const token = await loadToken();
  if (!token) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) return false;

    const json = await res.json();
    if (json.success && json.data?.token) {
      await saveToken(json.data.token);
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshTokenIfNeeded(): Promise<void> {
  const token = await loadToken();
  if (!token) return;

  const expiry = getTokenExpiry(token);
  if (!expiry) return;

  const timeUntilExpiry = expiry - Date.now();
  if (timeUntilExpiry > REFRESH_THRESHOLD_MS) return;

  if (refreshInProgress) {
    await refreshInProgress;
    return;
  }

  refreshInProgress = attemptTokenRefresh();
  try {
    const success = await refreshInProgress;
    if (!success && timeUntilExpiry <= 0) {
      await clearToken();
      onAuthExpired?.();
    }
  } finally {
    refreshInProgress = null;
  }
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  retryAfter?: number;
}

export interface ApiError extends Error {
  status: number;
  apiError: string;
  retryAfter?: number;
  code?: string;
  portalUrl?: string;
  nextAction?: string;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isMultipart?: boolean,
  timeoutMs?: number,
): Promise<ApiResponse<T>> {
  await refreshTokenIfNeeded();

  const token = await loadToken();
  const headers: Record<string, string> = {};

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (!isMultipart) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);

  const init: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };

  if (body !== undefined) {
    if (isMultipart && body instanceof FormData) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }

  const url = `${API_BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out. Please check your connection and try again.');
    }
    throw err;
  }
  clearTimeout(timer);

  if (res.status === 401) {
    const refreshed = await attemptTokenRefresh();
    if (refreshed) {
      const retryToken = await loadToken();
      const retryHeaders = { ...headers };
      if (retryToken) retryHeaders['Authorization'] = `Bearer ${retryToken}`;
      const retryController = new AbortController();
      const retryTimer = setTimeout(() => retryController.abort(), timeout);
      let retryRes: Response;
      try {
        retryRes = await fetch(url, { ...init, headers: retryHeaders, signal: retryController.signal });
      } catch (retryErr: unknown) {
        clearTimeout(retryTimer);
        if (retryErr instanceof Error && retryErr.name === 'AbortError') {
          throw new Error('Request timed out. Please check your connection and try again.');
        }
        throw retryErr;
      }
      clearTimeout(retryTimer);
      if (retryRes.status === 401) {
        await clearToken();
        onAuthExpired?.();
        return { success: false, error: 'Session expired. Please log in again.' };
      }
      const retryJson: ApiResponse<T> = await retryRes.json();
      if (!retryRes.ok || retryJson.success === false) {
        const msg = retryJson.error ?? `Request failed (${retryRes.status})`;
        const extra = retryJson as unknown as { code?: string; portal_url?: string; next_action?: string };
        const err = new Error(msg) as ApiError;
        err.status = retryRes.status;
        err.apiError = msg;
        err.retryAfter = retryJson.retryAfter;
        err.code = extra.code;
        err.portalUrl = extra.portal_url;
        err.nextAction = extra.next_action;
        throw err;
      }
      return retryJson;
    }
    await clearToken();
    onAuthExpired?.();
    return { success: false, error: 'Session expired. Please log in again.' };
  }

  let json: ApiResponse<T>;
  try {
    json = await res.json();
  } catch {
    throw new Error('Server returned an invalid response.');
  }

  if (!res.ok || json.success === false) {
    const msg = json.error ?? `Request failed (${res.status})`;
    const extra = json as unknown as { code?: string; portal_url?: string; next_action?: string };
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    err.apiError = msg;
    err.retryAfter = json.retryAfter;
    err.code = extra.code;
    err.portalUrl = extra.portal_url;
    err.nextAction = extra.next_action;
    throw err;
  }

  return json;
}

export interface Estimate {
  id: string;
  jobType: string;
  market: string;
  details?: string;
  estimateText: string;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  createdAt: number;
  materials?: number;
  labor?: number;
  total?: number;
}

export interface EstimateResult {
  estimateId: string;
  text: string;
  materials?: number;
  labor?: number;
  total?: number;
  breakdown?: string;
  tier: string;
  estimatesRemaining?: number | null;
}

export interface BillingStatus {
  plan: 'free' | 'pro' | 'business' | 'lifetime';
  status: string;
  currentPeriodEnd?: number;
  priceId?: string;
  interval?: 'monthly' | 'annual';
}

export interface UsageData {
  used: number;
  limit: number | null;
  plan: string;
  isUnlimited: boolean;
}

export interface UserData {
  id: string;
  email: string;
  affiliateCode: string | null;
  hasSeenOnboarding: boolean | null;
}

export interface EstimateListData {
  estimates: Estimate[];
  total: number;
  page: number;
  pages: number;
}

export const JOB_TYPES = [
  { value: 'tuckpointing', label: 'Tuckpointing / Mortar Repair' },
  { value: 'chimney_rebuild', label: 'Chimney Rebuild' },
  { value: 'retaining_wall', label: 'Retaining Wall' },
  { value: 'concrete_flatwork', label: 'Concrete Flatwork' },
  { value: 'roof_repair', label: 'Roof Repair' },
  { value: 'general', label: 'General Construction' },
] as const;

export const MARKETS = [
  { value: 'midwest', label: 'Midwest US' },
  { value: 'south', label: 'Southern US' },
  { value: 'west', label: 'Western US' },
  { value: 'northeast', label: 'Northeastern US' },
] as const;

export const TRADE_PRESETS = [
  { value: '', label: 'None (Auto-detect)' },
  { value: 'masonry', label: 'Masonry' },
  { value: 'roofing', label: 'Roofing' },
  { value: 'concrete', label: 'Concrete' },
  { value: 'remodeling', label: 'Remodeling' },
] as const;

export interface EstimateTemplate {
  id: string;
  name: string;
  jobType: string;
  market: string;
  details?: string;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  createdAt: number;
}

export interface SavedLineItemPreset {
  id: string;
  description: string;
  quantity: number;
  unitCost: number;
  uom: string | null;
  costType: string | null;
  createdAt: number;
}

export interface SavedLineItemPayload {
  description: string;
  quantity: number;
  unitCost: number;
  uom?: string;
  costType?: string;
}

export const api = {
  getMe: () =>
    request<UserData | null>('GET', '/api/me'),

  getUsage: () =>
    request<UsageData>('GET', '/api/usage'),

  getEstimates: (page = 1, search = '') =>
    request<EstimateListData>('GET', `/api/estimates?page=${page}&search=${encodeURIComponent(search)}`),

  getEstimate: (id: string) => request<Estimate>('GET', `/api/estimates/${id}`),

  createEstimate: (formData: FormData) =>
    request<EstimateResult>('POST', '/api/estimates', formData, true, LONG_TIMEOUT_MS),

  login: (email: string, password: string, ref?: string) =>
    request<{ id: string; email: string; token: string }>('POST', '/api/login', {
      email,
      password,
      ref,
    }),

  signup: (email: string, password: string, ref?: string) =>
    request<{ id: string; email: string; token: string }>('POST', '/api/signup', {
      email,
      password,
      ref,
    }),

  getBillingStatus: () => request<BillingStatus>('GET', '/api/billing/status'),

  createCheckoutSession: async (plan: 'pro' | 'business', interval: 'monthly' | 'annual' = 'monthly') => {
    try {
      return await request<{ url: string }>('POST', '/api/billing/create-checkout-session', {
        plan,
        interval,
      });
    } catch (err) {
      const e = err as ApiError;
      // User already has an active subscription — surface the Customer Portal URL
      // so the caller (BillingScreen) opens it in the in-app browser instead of
      // showing a generic error. The server-side guard prevents creating a
      // parallel subscription, which would also violate Play Billing policy.
      if (e?.status === 409 && e?.nextAction === 'customer_portal' && e?.portalUrl) {
        const absoluteUrl = e.portalUrl.startsWith('http')
          ? e.portalUrl
          : `${API_BASE_URL}${e.portalUrl}`;
        return { success: true, data: { url: absoluteUrl } } as ApiResponse<{ url: string }>;
      }
      throw err;
    }
  },

  getTemplates: () =>
    request<EstimateTemplate[]>('GET', '/templates'),

  createTemplate: (template: {
    name: string;
    jobType: string;
    market: string;
    details?: string;
    clientName?: string;
    clientEmail?: string;
    clientPhone?: string;
  }) =>
    request<EstimateTemplate>('POST', '/templates', template),

  deleteTemplate: (id: string) =>
    request<{ success: boolean }>('DELETE', `/templates/${id}`),

  /** GET /api/saved-line-items — list user's saved line-item presets (alphabetical). */
  getSavedLineItems: () =>
    request<{ presets: SavedLineItemPreset[] }>('GET', '/api/saved-line-items'),

  /** POST /api/saved-line-items — save a line item as a reusable preset. */
  createSavedLineItem: (payload: SavedLineItemPayload) =>
    request<{ preset: SavedLineItemPreset }>('POST', '/api/saved-line-items', payload),

  /** DELETE /api/saved-line-items/:id — delete a saved preset owned by the current user. */
  deleteSavedLineItem: (id: string) =>
    request<null>('DELETE', `/api/saved-line-items/${encodeURIComponent(id)}`),

  registerPushToken: (
    token: string,
    preferences: { estimateReady: boolean; trialExpiring: boolean; failedPayment: boolean },
  ) =>
    request<{ registered: boolean }>('POST', '/api/push-tokens', {
      token,
      platform: Platform.OS,
      preferences,
    }),
};

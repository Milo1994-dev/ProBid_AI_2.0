// Shared env constants used across outreach submodules.
// Values are read once at module load to match the original outreach.ts behavior.
export const ADMIN_KEY = process.env.ADMIN_KEY || "";
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
export const PRICE_PRO = process.env.STRIPE_PRICE_PRO_MONTHLY || "";
export const PRICE_BIZ = process.env.STRIPE_PRICE_BUSINESS_MONTHLY || "";

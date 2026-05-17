import crypto from "crypto";
import { db } from "./db.js";
import { eq, and, desc, sql, count, avg } from "drizzle-orm";
import {
  procoreConnections,
  procoreProjects,
  procoreBudgetItems,
  shadowEstimates,
  procoreMetrics,
  proofAssets,
  aggregateBenchmarks,
} from "../shared/schema.js";

const PROCORE_API_BASE = "https://api.procore.com";
const PROCORE_AUTH_URL = "https://login.procore.com/oauth/authorize";
const PROCORE_TOKEN_URL = "https://login.procore.com/oauth/token";

export type TokenExchangeReason = "invalid_client" | "redirect_uri_mismatch" | "expired_code" | "unknown";

export class ProcoreTokenExchangeError extends Error {
  readonly reason: TokenExchangeReason;
  constructor(message: string, reason: TokenExchangeReason) {
    super(message);
    this.name = "ProcoreTokenExchangeError";
    this.reason = reason;
  }
}

interface ProcoreTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  created_at: number;
}

interface ProcoreCompany {
  id: number;
  name: string;
  is_active: boolean;
}

interface ProcoreProject {
  id: number;
  name: string;
  project_number: string;
  address: string;
  city: string;
  state_code: string;
  zip: string;
  stage: string;
  start_date: string;
  completion_date: string;
  actual_start_date: string;
  projected_finish_date: string;
}

export function generateState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getAuthorizationUrl(state: string, redirectUri: string): string {
  const clientId = process.env.PROCORE_CLIENT_ID;
  if (!clientId) {
    throw new Error("PROCORE_CLIENT_ID not configured");
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: state,
  });

  return `${PROCORE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<ProcoreTokenResponse> {
  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Procore OAuth credentials not configured");
  }

  const response = await fetch(PROCORE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let reason: TokenExchangeReason = "unknown";
    try {
      const errorJson = JSON.parse(errorText);
      const errorDesc = (errorJson.error_description || errorJson.error || "").toLowerCase();
      if (errorDesc.includes("unknown client") || errorDesc.includes("client authentication failed") || errorDesc.includes("invalid_client")) {
        reason = "invalid_client";
      } else if (errorDesc.includes("redirect") || errorDesc.includes("redirect_uri_mismatch")) {
        reason = "redirect_uri_mismatch";
      } else if (errorDesc.includes("expired") || errorDesc.includes("invalid_grant") || errorDesc.includes("authorization code")) {
        reason = "expired_code";
      }
      if (errorJson.error === "invalid_client") reason = "invalid_client";
      if (errorJson.error === "invalid_grant") reason = "expired_code";
      if (errorJson.error === "redirect_uri_mismatch") reason = "redirect_uri_mismatch";
    } catch {
      const lower = errorText.toLowerCase();
      if (lower.includes("invalid_client") || lower.includes("unknown client")) reason = "invalid_client";
      else if (lower.includes("redirect")) reason = "redirect_uri_mismatch";
      else if (lower.includes("expired") || lower.includes("invalid_grant")) reason = "expired_code";
    }
    throw new ProcoreTokenExchangeError(`Failed to exchange code: ${errorText}`, reason);
  }

  return response.json();
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<ProcoreTokenResponse> {
  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Procore OAuth credentials not configured");
  }

  const response = await fetch(PROCORE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  return response.json();
}

async function getValidAccessToken(connectionId: string): Promise<string> {
  const result = await db
    .select()
    .from(procoreConnections)
    .where(eq(procoreConnections.id, connectionId));

  const connection = result[0];
  if (!connection) {
    throw new Error("Connection not found");
  }

  const now = Date.now();
  const expiresAt = connection.tokenExpiresAt;
  const bufferMs = 5 * 60 * 1000;

  if (expiresAt - bufferMs > now) {
    return connection.accessToken;
  }

  try {
    const tokens = await refreshAccessToken(connection.refreshToken);
    const newExpiresAt = now + tokens.expires_in * 1000;

    await db
      .update(procoreConnections)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: newExpiresAt,
        updatedAt: now,
      })
      .where(eq(procoreConnections.id, connectionId));

    return tokens.access_token;
  } catch (err) {
    await db
      .update(procoreConnections)
      .set({ status: "expired", updatedAt: now })
      .where(eq(procoreConnections.id, connectionId));
    throw new Error("Procore session expired. Please reconnect your account.");
  }
}

async function procoreApiCall<T>(
  connectionId: string,
  endpoint: string,
  companyId: string,
  options: RequestInit = {},
  retried = false
): Promise<T> {
  const accessToken = await getValidAccessToken(connectionId);

  const url = `${PROCORE_API_BASE}/rest/v1.0${endpoint}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Procore-Company-Id": companyId,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401 && !retried) {
    const conn = await db
      .select()
      .from(procoreConnections)
      .where(eq(procoreConnections.id, connectionId));
    if (conn[0]?.refreshToken) {
      try {
        const tokens = await refreshAccessToken(conn[0].refreshToken);
        await db
          .update(procoreConnections)
          .set({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpiresAt: Date.now() + tokens.expires_in * 1000,
            updatedAt: Date.now(),
          })
          .where(eq(procoreConnections.id, connectionId));
        return procoreApiCall<T>(connectionId, endpoint, companyId, options, true);
      } catch {
        await db
          .update(procoreConnections)
          .set({ status: "expired", updatedAt: Date.now() })
          .where(eq(procoreConnections.id, connectionId));
        throw new Error("Procore session expired. Please reconnect your account.");
      }
    }
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Procore API error (${response.status}): ${error}`);
  }

  return response.json();
}

export async function getCompanies(connectionId: string): Promise<ProcoreCompany[]> {
  const accessToken = await getValidAccessToken(connectionId);

  const response = await fetch(`${PROCORE_API_BASE}/rest/v1.0/companies`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get companies: ${error}`);
  }

  return response.json();
}

export async function getProjects(
  connectionId: string,
  companyId: string
): Promise<ProcoreProject[]> {
  return procoreApiCall<ProcoreProject[]>(
    connectionId,
    "/projects",
    companyId
  );
}

export async function getProjectBudget(
  connectionId: string,
  companyId: string,
  projectId: number
): Promise<any[]> {
  return procoreApiCall<any[]>(
    connectionId,
    `/projects/${projectId}/budget/views`,
    companyId
  );
}

export async function getChangeEvents(
  connectionId: string,
  companyId: string,
  projectId: number
): Promise<any[]> {
  return procoreApiCall<any[]>(
    connectionId,
    `/projects/${projectId}/change_events`,
    companyId
  );
}

export async function saveConnection(
  userId: string,
  companyId: string,
  companyName: string,
  tokens: ProcoreTokenResponse
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + tokens.expires_in * 1000;

  await db.insert(procoreConnections).values({
    id,
    userId,
    procoreCompanyId: companyId,
    companyName,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: expiresAt,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

export async function syncClosedProjects(connectionId: string): Promise<number> {
  const result = await db
    .select()
    .from(procoreConnections)
    .where(eq(procoreConnections.id, connectionId));

  const connection = result[0];
  if (!connection) {
    throw new Error("Connection not found");
  }

  const projects = await getProjects(connectionId, connection.procoreCompanyId);
  const closedProjects = projects.filter(
    (p) => p.stage === "Closed" || p.stage === "Complete"
  );

  let syncedCount = 0;
  const now = Date.now();

  for (const project of closedProjects) {
    const projectId = crypto.randomUUID();

    try {
      await db
        .insert(procoreProjects)
        .values({
          id: projectId,
          connectionId,
          procoreProjectId: String(project.id),
          name: project.name,
          projectNumber: project.project_number,
          address: project.address,
          city: project.city,
          state: project.state_code,
          zipCode: project.zip,
          status: project.stage,
          startDate: project.start_date,
          completionDate: project.completion_date,
          isClosed: 1,
          rawData: JSON.stringify(project),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();

      syncedCount++;
    } catch (err) {
      console.error(`Failed to sync project ${project.id}:`, err);
    }
  }

  await db
    .update(procoreConnections)
    .set({ lastSyncAt: now, updatedAt: now })
    .where(eq(procoreConnections.id, connectionId));

  return syncedCount;
}

export async function syncProjectBudgets(connectionId: string, projectId: string): Promise<void> {
  const projectResult = await db
    .select()
    .from(procoreProjects)
    .where(eq(procoreProjects.id, projectId));

  const project = projectResult[0];
  if (!project) {
    throw new Error("Project not found");
  }

  const connectionResult = await db
    .select()
    .from(procoreConnections)
    .where(eq(procoreConnections.id, connectionId));

  const connection = connectionResult[0];
  if (!connection) {
    throw new Error("Connection not found");
  }

  try {
    const budgets = await getProjectBudget(
      connectionId,
      connection.procoreCompanyId,
      parseInt(project.procoreProjectId)
    );

    const now = Date.now();
    let totalBudgeted = 0;
    let totalActual = 0;

    await db
      .delete(procoreBudgetItems)
      .where(eq(procoreBudgetItems.projectId, projectId));

    for (const item of budgets) {
      const budgetItemId = crypto.randomUUID();
      const budgetedAmount = parseFloat(item.original_budget_amount) || 0;
      const actualAmount = parseFloat(item.actual_costs) || 0;

      totalBudgeted += budgetedAmount;
      totalActual += actualAmount;

      await db
        .insert(procoreBudgetItems)
        .values({
          id: budgetItemId,
          projectId,
          costCode: item.cost_code?.code || "UNKNOWN",
          costCodeDescription: item.cost_code?.name || "",
          budgetedAmountUsd: budgetedAmount,
          actualAmountUsd: actualAmount,
          variance: budgetedAmount - actualAmount,
          rawData: JSON.stringify(item),
          createdAt: now,
        });
    }

    await db
      .update(procoreProjects)
      .set({
        originalEstimateUsd: totalBudgeted,
        actualCostUsd: totalActual,
        updatedAt: now,
      })
      .where(eq(procoreProjects.id, projectId));
  } catch (err) {
    console.error(`Failed to sync budgets for project ${projectId}:`, err);
    throw err;
  }
}

export async function syncChangeOrders(connectionId: string, projectId: string): Promise<void> {
  const projectResult = await db
    .select()
    .from(procoreProjects)
    .where(eq(procoreProjects.id, projectId));

  const project = projectResult[0];
  if (!project) {
    throw new Error("Project not found");
  }

  const connectionResult = await db
    .select()
    .from(procoreConnections)
    .where(eq(procoreConnections.id, connectionId));

  const connection = connectionResult[0];
  if (!connection) {
    throw new Error("Connection not found");
  }

  try {
    const changeEvents = await getChangeEvents(
      connectionId,
      connection.procoreCompanyId,
      parseInt(project.procoreProjectId)
    );

    let changeOrderCount = 0;
    let changeOrderValue = 0;

    for (const event of changeEvents) {
      if (event.status === "approved" || event.status === "closed") {
        changeOrderCount++;
        changeOrderValue += parseFloat(event.amount) || 0;
      }
    }

    await db
      .update(procoreProjects)
      .set({
        changeOrderCount,
        changeOrderValueUsd: changeOrderValue,
        updatedAt: Date.now(),
      })
      .where(eq(procoreProjects.id, projectId));
  } catch (err) {
    console.error(`Failed to sync change orders for project ${projectId}:`, err);
    throw err;
  }
}

export async function getUserConnections(userId: string) {
  return db
    .select()
    .from(procoreConnections)
    .where(eq(procoreConnections.userId, userId))
    .orderBy(desc(procoreConnections.createdAt));
}

export async function getConnectionProjects(connectionId: string) {
  return db
    .select()
    .from(procoreProjects)
    .where(eq(procoreProjects.connectionId, connectionId))
    .orderBy(desc(procoreProjects.createdAt));
}

export async function getClosedProjectsWithActuals(connectionId: string) {
  return db
    .select()
    .from(procoreProjects)
    .where(
      and(
        eq(procoreProjects.connectionId, connectionId),
        eq(procoreProjects.isClosed, 1)
      )
    )
    .orderBy(desc(procoreProjects.closeDate));
}

export async function createProject(
  connectionId: string,
  companyId: string,
  projectData: { name: string; description?: string; address?: string; city?: string; state_code?: string; zip?: string }
): Promise<{ id: number; name: string }> {
  return procoreApiCall<{ id: number; name: string }>(
    connectionId,
    "/projects",
    companyId,
    {
      method: "POST",
      body: JSON.stringify({ project: projectData }),
    }
  );
}

export async function createBudgetLineItem(
  connectionId: string,
  companyId: string,
  projectId: number,
  lineItem: { description: string; amount: number; cost_code?: string }
): Promise<any> {
  return procoreApiCall<any>(
    connectionId,
    `/projects/${projectId}/budget/line_items`,
    companyId,
    {
      method: "POST",
      body: JSON.stringify({ line_item: lineItem }),
    }
  );
}

export async function uploadProjectDocument(
  connectionId: string,
  companyId: string,
  projectId: number,
  fileName: string,
  fileBuffer: Uint8Array,
  contentType: string = "application/pdf"
): Promise<any> {
  const accessToken = await getValidAccessToken(connectionId);

  const formData = new FormData();
  const blob = new Blob([fileBuffer as unknown as BlobPart], { type: contentType });
  formData.append("file[name]", fileName);
  formData.append("file[data]", blob, fileName);
  formData.append("file[description]", "ProBid AI Estimate");

  const response = await fetch(
    `${PROCORE_API_BASE}/rest/v1.0/projects/${projectId}/documents`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Procore-Company-Id": companyId,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload document: ${error}`);
  }

  return response.json();
}

export async function getAllProjects(
  connectionId: string,
  companyId: string
): Promise<ProcoreProject[]> {
  return procoreApiCall<ProcoreProject[]>(
    connectionId,
    "/projects?per_page=250",
    companyId
  );
}

export async function disconnectProcore(connectionId: string): Promise<void> {
  await db
    .update(procoreConnections)
    .set({ status: "disconnected", updatedAt: Date.now() })
    .where(eq(procoreConnections.id, connectionId));
}

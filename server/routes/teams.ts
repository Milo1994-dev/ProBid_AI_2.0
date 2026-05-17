import crypto from "crypto";
import express from "express";
import { db } from "../db.js";
import { eq, and, gt } from "drizzle-orm";
import { teams, teamMembers, teamInvites, users, subscriptions } from "../../shared/schema.js";
import { asyncHandler, requireAuthJson } from "../lib/middleware.js";
import { log } from "../lib/logger.js";
import { now } from "../lib/utils.js";
import { getResendClient, sendEmailWithRetry } from "../resend-client.js";

const APP_URL =
  process.env.REPLIT_DEPLOYMENT === "1"
    ? "https://probidcore.net"
    : process.env.APP_URL || "http://localhost:5000";

const PRICE_BIZ = process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? "";
const PRICE_BIZ_ANNUAL = process.env.STRIPE_PRICE_BUSINESS_ANNUAL ?? "";

async function isBusinessUser(userId: string): Promise<boolean> {
  const result = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const sub = result[0];
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "trialing" && sub.status !== "past_due") return false;
  return sub.priceId === PRICE_BIZ || sub.priceId === PRICE_BIZ_ANNUAL;
}

async function getOrCreateTeam(ownerUserId: string): Promise<typeof teams.$inferSelect> {
  const existing = await db.select().from(teams).where(eq(teams.ownerUserId, ownerUserId));
  if (existing[0]) return existing[0];
  const id = crypto.randomUUID();
  const ownerResult = await db.select({ email: users.email }).from(users).where(eq(users.id, ownerUserId));
  const email = ownerResult[0]?.email ?? "My Team";
  const teamName = email.split("@")[0] + "'s Team";
  await db.insert(teams).values({ id, ownerUserId, name: teamName, createdAt: now() });
  await db.insert(teamMembers).values({
    id: crypto.randomUUID(),
    teamId: id,
    userId: ownerUserId,
    role: "owner",
    joinedAt: now(),
  });
  return (await db.select().from(teams).where(eq(teams.id, id)))[0];
}

export function registerTeamRoutes(app: express.Application): void {
  // GET /api/team — get current user's team info
  app.get(
    "/api/team",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const isBiz = await isBusinessUser(uid);
      if (!isBiz) {
        return res.json({ success: true, data: { hasTeam: false, reason: "Team collaboration requires the Business plan." } });
      }

      const team = await getOrCreateTeam(uid);
      const members = await db
        .select({
          id: teamMembers.id,
          userId: teamMembers.userId,
          role: teamMembers.role,
          joinedAt: teamMembers.joinedAt,
          email: users.email,
        })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(eq(teamMembers.teamId, team.id));

      const invites = await db
        .select()
        .from(teamInvites)
        .where(and(eq(teamInvites.teamId, team.id), gt(teamInvites.expiresAt, now())));

      res.json({ success: true, data: { hasTeam: true, team, members, invites } });
    }),
  );

  // POST /api/team/rename
  app.post(
    "/api/team/rename",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const name = String(req.body?.name ?? "").trim();
      if (!name || name.length > 80) {
        return res.status(400).json({ success: false, error: "Team name must be 1–80 characters." });
      }

      const isBiz = await isBusinessUser(uid);
      if (!isBiz) return res.status(403).json({ success: false, error: "Business plan required." });

      const team = await getOrCreateTeam(uid);
      await db.update(teams).set({ name }).where(eq(teams.id, team.id));
      res.json({ success: true });
    }),
  );

  // POST /api/team/invite — send an email invite
  app.post(
    "/api/team/invite",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const email = String(req.body?.email ?? "").trim().toLowerCase();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: "Valid email required." });
      }

      const isBiz = await isBusinessUser(uid);
      if (!isBiz) return res.status(403).json({ success: false, error: "Business plan required." });

      const team = await getOrCreateTeam(uid);

      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));

      if (existing[0]) {
        const alreadyMember = await db
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, existing[0].id)));
        if (alreadyMember.length > 0) {
          return res.status(400).json({ success: false, error: "This user is already on the team." });
        }
      }

      const inviteCode = crypto.randomBytes(24).toString("hex");
      const expiresAt = now() + 7 * 24 * 60 * 60 * 1000;

      await db.insert(teamInvites).values({
        id: crypto.randomUUID(),
        teamId: team.id,
        email,
        inviteCode,
        createdBy: uid,
        createdAt: now(),
        expiresAt,
      });

      const inviterResult = await db.select({ email: users.email }).from(users).where(eq(users.id, uid));
      const inviterEmail = inviterResult[0]?.email ?? "your teammate";
      const acceptUrl = `${APP_URL}/app/team/accept?code=${inviteCode}`;

      try {
        const { client, fromEmail } = await getResendClient();
        await sendEmailWithRetry(
          client,
          {
            from: fromEmail,
            to: email,
            subject: `You're invited to join ${team.name} on ProBid AI`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
                <h2 style="color:#111827;margin-bottom:8px">You've been invited!</h2>
                <p style="color:#374151;line-height:1.6">${inviterEmail} has invited you to collaborate on estimates in <strong>${team.name}</strong> on ProBid AI.</p>
                <a href="${acceptUrl}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#4f46e5;color:#fff;font-weight:700;text-decoration:none;border-radius:8px">
                  Accept Invitation
                </a>
                <p style="color:#6b7280;font-size:13px">This invite expires in 7 days. If you didn't expect this email, you can ignore it.</p>
              </div>
            `,
          },
          {
            idempotencyKey: `team-invite/${inviteCode}`,
            logContext: { teamId: team.id, email },
          },
        );
        log("info", "Team invite email sent", { to: email, teamId: team.id });
      } catch (err: any) {
        log("warn", "Failed to send invite email", { error: err?.message, email });
      }

      res.json({ success: true, data: { inviteCode, expiresAt } });
    }),
  );

  // POST /api/team/accept — accept an invite by code
  app.post(
    "/api/team/accept",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const code = String(req.body?.code ?? "").trim();
      if (!code) return res.status(400).json({ success: false, error: "Invite code required." });

      const inviteResult = await db
        .select({
          id: teamInvites.id,
          teamId: teamInvites.teamId,
          email: teamInvites.email,
          expiresAt: teamInvites.expiresAt,
        })
        .from(teamInvites)
        .where(and(eq(teamInvites.inviteCode, code), gt(teamInvites.expiresAt, now())));

      const invite = inviteResult[0];
      if (!invite) return res.status(404).json({ success: false, error: "Invite not found or expired." });

      const acceptingUserResult = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, uid));

      const acceptingUser = acceptingUserResult[0];
      if (!acceptingUser || !acceptingUser.email) {
        return res.status(403).json({ success: false, error: "User account has no verified email address." });
      }

      if (acceptingUser.email.toLowerCase() !== invite.email.toLowerCase()) {
        return res.status(403).json({ success: false, error: "This invitation was issued for a different email address." });
      }

      const alreadyMember = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, invite.teamId), eq(teamMembers.userId, uid)));

      if (alreadyMember.length > 0) {
        return res.status(400).json({ success: false, error: "You are already a member of this team." });
      }

      await db.insert(teamMembers).values({
        id: crypto.randomUUID(),
        teamId: invite.teamId,
        userId: uid,
        role: "member",
        joinedAt: now(),
      });

      await db.delete(teamInvites).where(eq(teamInvites.id, invite.id));

      log("info", "Team invite accepted", { userId: uid, teamId: invite.teamId });
      res.json({ success: true });
    }),
  );

  // DELETE /api/team/members/:memberId — remove a member
  app.delete(
    "/api/team/members/:memberId",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const memberId = req.params.memberId;

      const memberResult = await db.select().from(teamMembers).where(eq(teamMembers.id, memberId));
      const member = memberResult[0];
      if (!member) return res.status(404).json({ success: false, error: "Member not found." });

      const teamResult = await db.select().from(teams).where(eq(teams.id, member.teamId));
      const team = teamResult[0];
      if (!team || team.ownerUserId !== uid) {
        return res.status(403).json({ success: false, error: "Only the team owner can remove members." });
      }

      if (member.userId === uid) {
        return res.status(400).json({ success: false, error: "Cannot remove yourself as owner." });
      }

      await db.delete(teamMembers).where(eq(teamMembers.id, memberId));
      res.json({ success: true });
    }),
  );

  // DELETE /api/team/invites/:inviteId — cancel a pending invite
  app.delete(
    "/api/team/invites/:inviteId",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const inviteId = req.params.inviteId;

      const inviteResult = await db.select().from(teamInvites).where(eq(teamInvites.id, inviteId));
      const invite = inviteResult[0];
      if (!invite) return res.status(404).json({ success: false, error: "Invite not found." });

      const teamResult = await db.select().from(teams).where(eq(teams.id, invite.teamId));
      const team = teamResult[0];
      if (!team || team.ownerUserId !== uid) {
        return res.status(403).json({ success: false, error: "Only the team owner can cancel invites." });
      }

      await db.delete(teamInvites).where(eq(teamInvites.id, inviteId));
      res.json({ success: true });
    }),
  );
}

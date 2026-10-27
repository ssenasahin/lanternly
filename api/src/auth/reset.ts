import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { HttpError, validate } from "../http.js";
import { emailLayout, escapeHtml } from "../mailer.js";
import { hashPassword, passwordProblem } from "./password.js";
import { authLimiter, emailField, type AuthDeps } from "./shared.js";
import { sha256 } from "./tokens.js";

const RESET_TTL_MS = 30 * 60 * 1000;
const LINK_INVALID = "This reset link has expired or was already used. Request a new one.";

export function resetRoutes({ env, prisma, mailer }: AuthDeps) {
  const router = Router();
  const limiter = authLimiter(env.AUTH_RATE_LIMIT_PER_MINUTE);

  router.post("/forgot-password", limiter, async (req, res) => {
    const { email } = validate(z.object({ email: emailField }), req.body);
    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      const token = randomBytes(32).toString("base64url");
      // A new link replaces any older one still waiting in the inbox.
      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
        prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
          },
        }),
      ]);
      const link = `${env.WEB_ORIGIN}/reset-password?token=${token}`;
      // Sent without awaiting, so a slow mail server can't make known addresses
      // answer measurably slower than unknown ones.
      void mailer.send(resetEmail(user.email, link)).catch((error) => {
        console.error("Could not send the password reset email", error);
      });
    }

    // The same answer whether or not the account exists.
    res.status(202).json({
      message: "If an account exists for that email, a link to reset its password is on its way.",
    });
  });

  router.post("/reset-password", limiter, async (req, res) => {
    const body = validate(
      z.object({ token: z.string().min(20).max(100), password: z.string().max(256) }),
      req.body,
    );
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(body.token) },
      include: { user: true },
    });
    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new HttpError(400, LINK_INVALID);
    }

    const problem = passwordProblem(body.password, record.user.email);
    if (problem) throw new HttpError(400, "Choose a stronger password", { password: [problem] });

    // Claim the token first, conditionally, so a link clicked twice resets only once.
    const { count } = await prisma.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw new HttpError(400, LINK_INVALID);

    // Whoever knew the old password is signed out everywhere. Two-factor stays on:
    // a reset proves control of the inbox, not of the phone.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(body.password),
          failedLogins: 0,
          lockedUntil: null,
        },
      }),
      prisma.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    res.status(204).end();
  });

  return router;
}

function resetEmail(to: string, link: string) {
  return {
    to,
    subject: "Reset your Lanternly password",
    text: `Someone asked to reset the password for ${to}.\n\nOpen this link within 30 minutes to choose a new one:\n${link}\n\nIf it wasn't you, ignore this email; your password stays the same.`,
    html: emailLayout(
      "Reset your password",
      `<p style="margin:0 0 24px;line-height:1.6;color:#c9cdd2">Someone asked to reset the password for ${escapeHtml(to)}. The link works once, for 30 minutes.</p>
      <p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#f5a524;color:#1b1204;font-weight:600;text-decoration:none">Choose a new password</a></p>
      <p style="margin:0;line-height:1.6;color:#8b939d">If it wasn't you, ignore this email; your password stays the same.</p>`,
    ),
  };
}

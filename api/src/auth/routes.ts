import { Prisma, type PrismaClient, type User } from "@lanternly/db";
import type { CookieOptions, Request, Response } from "express";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Env } from "../env.js";
import { HttpError, validate } from "../http.js";
import { afterFailedSignIn, isLocked } from "./lockout.js";
import { authOf, requireAuth } from "./middleware.js";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from "./password.js";
import { createSession, revokeSession, rotateSession, type ClientInfo } from "./sessions.js";
import { parseRefreshToken, signAccessToken } from "./tokens.js";

export const REFRESH_COOKIE = "lanternly_refresh";

// One message for every sign-in failure, so it never reveals whether an account exists.
const INVALID_CREDENTIALS = "Invalid email or password";

// Normalise first, then validate: pasted addresses often carry stray spaces.
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const credentials = z.object({
  email,
  password: z.string().min(1).max(256),
});

export function authRouter(env: Env, prisma: PrismaClient): Router {
  const router = Router();

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: env.AUTH_RATE_LIMIT_PER_MINUTE,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
    },
  });

  // The refresh cookie is only ever sent to /api/auth, never to the rest of the API,
  // and never from another site (SameSite=Strict) or to page scripts (HttpOnly).
  const cookieOptions = (expires?: Date): CookieOptions => ({
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/api/auth",
    expires,
  });

  async function startSession(req: Request, res: Response, user: User, mfa: boolean) {
    const { session, refreshToken } = await createSession(prisma, user.id, clientOf(req), mfa);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(session.expiresAt));
    const accessToken = await signAccessToken(
      { userId: user.id, sessionId: session.id, role: user.role, mfa },
      env.JWT_SECRET,
    );
    return { accessToken, user: publicUser(user) };
  }

  router.post("/register", limiter, async (req, res) => {
    const body = validate(credentials, req.body);
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw new HttpError(400, "Choose a stronger password", { password: [problem] });

    let user: User;
    try {
      user = await prisma.user.create({
        data: { email: body.email, passwordHash: await hashPassword(body.password) },
      });
    } catch (error) {
      // P2002: unique constraint, the email is taken.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new HttpError(409, "An account with this email already exists");
      }
      throw error;
    }

    res.status(201).json(await startSession(req, res, user, false));
  });

  router.post("/login", limiter, async (req, res) => {
    const body = validate(credentials, req.body);
    const now = new Date();
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    // Unknown and locked accounts still pay for a full password check, so neither
    // the message nor the response time distinguishes them from a wrong password.
    if (!user || isLocked(user.lockedUntil, now)) {
      await burnPasswordCheck(body.password);
      throw new HttpError(401, INVALID_CREDENTIALS);
    }

    if (!(await verifyPassword(user.passwordHash, body.password))) {
      // Incrementing in the database keeps the count right under concurrent attempts.
      const { failedLogins } = await prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      });
      const next = afterFailedSignIn(failedLogins, now);
      if (next.lockedUntil) {
        await prisma.user.update({ where: { id: user.id }, data: next });
      }
      throw new HttpError(401, INVALID_CREDENTIALS);
    }

    if (user.failedLogins > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }

    res.json(await startSession(req, res, user, false));
  });

  router.post("/refresh", async (req, res) => {
    const parsed = parseRefreshToken(req.cookies?.[REFRESH_COOKIE]);
    if (!parsed) throw new HttpError(401, "Sign in to continue");

    const result = await rotateSession(prisma, parsed.sessionId, parsed.secret, clientOf(req));
    if (result.kind !== "rotated") {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      throw new HttpError(401, "Your session has ended. Sign in again.");
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.session.userId } });
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions(result.session.expiresAt));
    const accessToken = await signAccessToken(
      {
        userId: user.id,
        sessionId: result.session.id,
        role: user.role,
        mfa: result.session.mfa,
      },
      env.JWT_SECRET,
    );
    res.json({ accessToken, user: publicUser(user) });
  });

  // Works without an access token, which may already have expired: the refresh
  // cookie identifies the session to end.
  router.post("/logout", async (req, res) => {
    const parsed = parseRefreshToken(req.cookies?.[REFRESH_COOKIE]);
    if (parsed) await revokeSession(prisma, parsed.sessionId);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });

  router.get("/me", requireAuth(prisma, env.JWT_SECRET), async (req, res) => {
    const { userId } = authOf(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    res.json({ user: publicUser(user) });
  });

  return router;
}

function clientOf(req: Request): ClientInfo {
  return { ip: req.ip, userAgent: req.get("user-agent") };
}

// The only user fields that ever leave the API.
export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    twoFactorEnabled: user.totpEnabledAt !== null,
    createdAt: user.createdAt,
  };
}

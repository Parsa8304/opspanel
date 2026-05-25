import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { COOKIE } from "./constants";

export { COOKIE };
export type Role = "ADMIN" | "ENGINEER" | "REVIEWER" | "READONLY";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export function signToken(u: SessionUser): string {
  return jwt.sign(u, SECRET, { expiresIn: "12h" });
}

export function verifyToken(token: string): SessionUser | null {
  try {
    const d = jwt.verify(token, SECRET) as jwt.JwtPayload & SessionUser;
    return { id: d.id, email: d.email, name: d.name, role: d.role };
  } catch {
    return null;
  }
}

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

/** Read the session from the request (cookie or Bearer header). */
export async function getSession(
  req?: NextRequest
): Promise<SessionUser | null> {
  let token: string | undefined;
  if (req) {
    token =
      req.cookies.get(COOKIE)?.value ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  } else {
    token = (await cookies()).get(COOKIE)?.value;
  }
  if (!token) return null;
  return verifyToken(token);
}

const RANK: Record<Role, number> = {
  READONLY: 0,
  REVIEWER: 1,
  ENGINEER: 2,
  ADMIN: 3,
};

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** Guard helper for route handlers. Returns user or throws a Response. */
export async function requireRole(
  req: NextRequest,
  min: Role = "READONLY"
): Promise<SessionUser> {
  const u = await getSession(req);
  if (!u) throw new Response("Unauthorized", { status: 401 });
  if (!atLeast(u.role, min)) throw new Response("Forbidden", { status: 403 });
  return u;
}

export async function audit(
  userId: string | null,
  action: string,
  target?: string,
  detail?: unknown,
  ip?: string
) {
  await prisma.auditLog
    .create({
      data: {
        userId: userId || undefined,
        action,
        target,
        detail: (detail as object) ?? undefined,
        ip,
      },
    })
    .catch(() => {});
}

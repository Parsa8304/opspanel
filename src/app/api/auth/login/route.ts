import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkPassword, signToken, COOKIE, audit } from "@/lib/auth";
import { handler } from "@/lib/api";

export const POST = handler(async (req: NextRequest) => {
  const { email, password } = await req.json();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await checkPassword(password, user.passwordHash))) {
    await audit(null, "LOGIN_FAILED", email);
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  const session = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as any,
  };
  const token = signToken(session);
  await audit(user.id, "LOGIN", user.email, undefined, req.headers.get("x-forwarded-for") || undefined);
  const res = NextResponse.json({ user: session });
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
});

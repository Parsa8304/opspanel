import { NextRequest, NextResponse } from "next/server";
import { COOKIE } from "@/lib/constants";

// Lightweight gate: presence of the session cookie. Role checks happen in
// API route handlers via requireRole(). Token validity is re-checked there.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isAuthApi = pathname.startsWith("/api/auth/");
  const isLogin = pathname === "/login";
  const hasToken = !!req.cookies.get(COOKIE)?.value;

  if (isAuthApi || isLogin) return NextResponse.next();
  if (!hasToken) {
    if (pathname.startsWith("/api/"))
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

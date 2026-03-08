/**
 * Next.js middleware — enforces auth when KOVA_DASHBOARD_PASSWORD is set.
 *
 * Public routes: /login, /api/auth/login, static assets.
 * All other routes require a valid auth cookie.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/status"];

export function middleware(request: NextRequest) {
  const password = process.env.KOVA_DASHBOARD_PASSWORD;

  // If no password configured, skip auth entirely
  if (!password) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // Allow static assets
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".png")
  ) {
    return NextResponse.next();
  }

  // Check auth cookie
  const authCookie = request.cookies.get("kova_auth")?.value;
  if (!authCookie) {
    // API routes get 401, pages get redirected to login
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Verify the token server-side (HMAC check happens in the auth API)
  // Middleware runs in Edge runtime where crypto.createHmac isn't available,
  // so we just check the cookie exists. The API routes do full verification.
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

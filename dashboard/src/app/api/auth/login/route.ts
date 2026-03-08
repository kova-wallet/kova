import { NextRequest, NextResponse } from "next/server";
import { validatePassword, createAuthToken, isAuthEnabled, AUTH_COOKIE_NAME, COOKIE_MAX_AGE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ ok: true });
  }

  try {
    const body = await req.json();
    const { password } = body as { password: string };

    if (!password || !validatePassword(password)) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const token = createAuthToken();
    const response = NextResponse.json({ ok: true });

    response.cookies.set(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });

    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

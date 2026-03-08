import { NextRequest, NextResponse } from "next/server";
import { isAuthEnabled, verifyAuthToken, AUTH_COOKIE_NAME } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const authEnabled = isAuthEnabled();

  if (!authEnabled) {
    return NextResponse.json({ authEnabled: false, authenticated: true });
  }

  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const authenticated = token ? verifyAuthToken(token) : false;

  return NextResponse.json({ authEnabled, authenticated });
}

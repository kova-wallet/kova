import { NextRequest, NextResponse } from "next/server";
import { getPolicyTemplates, buildFromTemplate } from "@/lib/policy-templates";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  return NextResponse.json({ templates: getPolicyTemplates() });
}

export async function POST(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  try {
    const { templateId } = (await req.json()) as { templateId: string };
    if (!templateId) {
      return NextResponse.json({ error: "templateId is required" }, { status: 400 });
    }
    const config = buildFromTemplate(templateId);
    return NextResponse.json({ config });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to build template" },
      { status: 400 }
    );
  }
}

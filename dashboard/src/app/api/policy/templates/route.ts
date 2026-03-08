import { NextRequest, NextResponse } from "next/server";
import { getPolicyTemplates, buildFromTemplate } from "@/lib/policy-templates";

export async function GET() {
  return NextResponse.json({ templates: getPolicyTemplates() });
}

export async function POST(req: NextRequest) {
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

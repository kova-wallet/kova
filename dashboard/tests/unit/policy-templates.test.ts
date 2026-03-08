import { describe, it, expect } from "vitest";
import { getPolicyTemplates, buildFromTemplate, policyTemplates } from "@/lib/policy-templates";

describe("Policy Templates", () => {
  it("returns all templates without build functions", () => {
    const templates = getPolicyTemplates();
    expect(templates.length).toBe(policyTemplates.length);
    expect(templates.length).toBeGreaterThan(0);

    for (const t of templates) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.category).toBeTruthy();
      // Should NOT have the build function
      expect((t as Record<string, unknown>).build).toBeUndefined();
    }
  });

  it("builds conservative template", () => {
    const config = buildFromTemplate("conservative");
    expect(config).toBeDefined();
    expect(config.name).toBe("conservative");
    expect(config.spendingLimit).toBeDefined();
    expect(config.approvalGate).toBeDefined();
    expect(config.rateLimit).toBeDefined();
  });

  it("builds moderate template", () => {
    const config = buildFromTemplate("moderate");
    expect(config.name).toBe("moderate");
    expect(config.spendingLimit).toBeDefined();
  });

  it("builds defi-bot template", () => {
    const config = buildFromTemplate("defi-bot");
    expect(config.name).toBe("defi-bot");
    expect(config.rateLimit).toBeDefined();
  });

  it("builds business-hours template", () => {
    const config = buildFromTemplate("business-hours");
    expect(config.name).toBe("business-hours");
    expect(config.activeHours).toBeDefined();
  });

  it("builds testing template", () => {
    const config = buildFromTemplate("testing");
    expect(config.name).toBe("testing");
    // Testing template should have no approval gate
    expect(config.approvalGate).toBeUndefined();
  });

  it("builds allowlist-only template", () => {
    const config = buildFromTemplate("allowlist-only");
    expect(config.name).toBe("allowlist-only");
    expect(config.allowAddresses).toBeDefined();
  });

  it("throws for unknown template ID", () => {
    expect(() => buildFromTemplate("nonexistent")).toThrow("Unknown policy template");
  });

  it("each template produces valid JSON-serializable config", () => {
    for (const template of policyTemplates) {
      const config = template.build();
      const json = JSON.stringify(config);
      const parsed = JSON.parse(json);
      expect(parsed.name).toBe(template.id);
    }
  });
});

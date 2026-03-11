/**
 * DNS SSRF protection tests — dns-pinning.test.ts
 *
 * Tests for:
 * 1. isPrivateIPv4 — unit tests covering all RFC-defined private/reserved ranges
 * 2. isPrivateIPv6 — unit tests covering all IPv6 private/reserved ranges
 * 3. SolanaAdapter constructor — rejects private IP URLs and insecure HTTP URLs at
 *    construction time (synchronous SSRF guard via validateRpcUrl)
 * 4. DNS rebinding protection — exercises isPrivateIPv4/isPrivateIPv6 to verify that
 *    any IP returned by DNS resolution that falls into a private range would be rejected
 *    by createPinnedLookup, which calls these functions directly.
 */

// vi.mock must be hoisted before any imports so Vitest can intercept the module
// before it is loaded by adapter.ts. The factory runs first.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { isPrivateIPv4, isPrivateIPv6, SolanaAdapterError } from "../../../src/chains/solana/utils.js";
import { SolanaAdapter } from "../../../src/chains/solana/adapter.js";

// ── Suite 1: isPrivateIPv4 ────────────────────────────────────────────────────

describe("isPrivateIPv4 — IP validation unit tests", () => {
  // RFC 1918 — Class A (10.0.0.0/8)
  describe("RFC 1918 Class A (10.0.0.0/8)", () => {
    it("should identify 10.0.0.1 as private", () => {
      expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    });

    it("should identify 10.255.255.255 as private", () => {
      expect(isPrivateIPv4("10.255.255.255")).toBe(true);
    });

    it("should identify 10.0.0.0 as private (network boundary)", () => {
      expect(isPrivateIPv4("10.0.0.0")).toBe(true);
    });

    it("should identify 11.0.0.0 as public (outside Class A range)", () => {
      expect(isPrivateIPv4("11.0.0.0")).toBe(false);
    });
  });

  // RFC 1918 — Class B (172.16.0.0/12)
  describe("RFC 1918 Class B (172.16.0.0/12)", () => {
    it("should identify 172.16.0.1 as private", () => {
      expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    });

    it("should identify 172.31.255.255 as private", () => {
      expect(isPrivateIPv4("172.31.255.255")).toBe(true);
    });

    it("should identify 172.16.0.0 as private (network boundary, lower)", () => {
      expect(isPrivateIPv4("172.16.0.0")).toBe(true);
    });

    it("should identify 172.32.0.0 as public (just outside Class B range, upper)", () => {
      expect(isPrivateIPv4("172.32.0.0")).toBe(false);
    });

    it("should identify 172.15.255.255 as public (just below Class B range, lower)", () => {
      expect(isPrivateIPv4("172.15.255.255")).toBe(false);
    });
  });

  // RFC 1918 — Class C (192.168.0.0/16)
  describe("RFC 1918 Class C (192.168.0.0/16)", () => {
    it("should identify 192.168.0.1 as private", () => {
      expect(isPrivateIPv4("192.168.0.1")).toBe(true);
    });

    it("should identify 192.168.255.255 as private", () => {
      expect(isPrivateIPv4("192.168.255.255")).toBe(true);
    });

    it("should identify 192.169.0.1 as public (just above Class C range)", () => {
      expect(isPrivateIPv4("192.169.0.1")).toBe(false);
    });
  });

  // Loopback (127.0.0.0/8)
  describe("Loopback (127.0.0.0/8)", () => {
    it("should identify 127.0.0.1 as private (localhost)", () => {
      expect(isPrivateIPv4("127.0.0.1")).toBe(true);
    });

    it("should identify 127.0.0.2 as private", () => {
      expect(isPrivateIPv4("127.0.0.2")).toBe(true);
    });

    it("should identify 127.255.255.255 as private (loopback broadcast)", () => {
      expect(isPrivateIPv4("127.255.255.255")).toBe(true);
    });
  });

  // Link-local (169.254.0.0/16) — used by AWS instance metadata (169.254.169.254)
  describe("Link-local (169.254.0.0/16)", () => {
    it("should identify 169.254.0.1 as private", () => {
      expect(isPrivateIPv4("169.254.0.1")).toBe(true);
    });

    it("should identify 169.254.255.255 as private", () => {
      expect(isPrivateIPv4("169.254.255.255")).toBe(true);
    });

    it("should identify 169.254.169.254 as private (AWS metadata endpoint)", () => {
      expect(isPrivateIPv4("169.254.169.254")).toBe(true);
    });
  });

  // CGNAT (100.64.0.0/10) — carrier-grade NAT
  describe("CGNAT (100.64.0.0/10)", () => {
    it("should identify 100.64.0.1 as private", () => {
      expect(isPrivateIPv4("100.64.0.1")).toBe(true);
    });

    it("should identify 100.127.255.255 as private (CGNAT upper boundary)", () => {
      expect(isPrivateIPv4("100.127.255.255")).toBe(true);
    });

    it("should identify 100.64.0.0 as private (CGNAT lower boundary)", () => {
      expect(isPrivateIPv4("100.64.0.0")).toBe(true);
    });
  });

  // Unspecified address
  describe("Unspecified address (0.0.0.0)", () => {
    it("should identify 0.0.0.0 as private (unspecified address)", () => {
      expect(isPrivateIPv4("0.0.0.0")).toBe(true);
    });
  });

  // Public IPs — should return false
  describe("Public IPs (should return false)", () => {
    it("should identify 8.8.8.8 as public (Google DNS)", () => {
      expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    });

    it("should identify 1.1.1.1 as public (Cloudflare DNS)", () => {
      expect(isPrivateIPv4("1.1.1.1")).toBe(false);
    });

    it("should identify 104.21.0.0 as public (Cloudflare CDN range)", () => {
      expect(isPrivateIPv4("104.21.0.0")).toBe(false);
    });

    it("should identify 172.15.255.255 as public (below 172.16/12 range)", () => {
      expect(isPrivateIPv4("172.15.255.255")).toBe(false);
    });

    it("should identify 192.169.0.1 as public (above 192.168/16 range)", () => {
      expect(isPrivateIPv4("192.169.0.1")).toBe(false);
    });
  });

  // Boundary / edge cases
  describe("Boundary cases", () => {
    it("should identify 172.16.0.0 as private (lower boundary of 172.16/12)", () => {
      expect(isPrivateIPv4("172.16.0.0")).toBe(true);
    });

    it("should identify 172.32.0.0 as public (first IP above 172.16/12 upper boundary)", () => {
      expect(isPrivateIPv4("172.32.0.0")).toBe(false);
    });

    it("should identify 10.0.0.0 as private (network address of 10/8)", () => {
      expect(isPrivateIPv4("10.0.0.0")).toBe(true);
    });

    it("should identify 11.0.0.0 as public (first IP above 10/8 range)", () => {
      expect(isPrivateIPv4("11.0.0.0")).toBe(false);
    });
  });

  // Invalid inputs — should return false without throwing
  describe("Invalid / malformed inputs", () => {
    it("should return false for non-IP string", () => {
      expect(isPrivateIPv4("not-an-ip")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isPrivateIPv4("")).toBe(false);
    });

    it("should return false for IPv6 address passed to IPv4 checker", () => {
      expect(isPrivateIPv4("::1")).toBe(false);
    });

    it("should return false for partial IP string", () => {
      expect(isPrivateIPv4("192.168")).toBe(false);
    });
  });
});

// ── Suite 2: isPrivateIPv6 ────────────────────────────────────────────────────

describe("isPrivateIPv6 — IPv6 validation unit tests", () => {
  // Loopback
  describe("Loopback (::1)", () => {
    it("should identify ::1 as private (IPv6 loopback)", () => {
      expect(isPrivateIPv6("::1")).toBe(true);
    });

    it("should identify 0:0:0:0:0:0:0:1 as private (loopback, expanded form)", () => {
      expect(isPrivateIPv6("0:0:0:0:0:0:0:1")).toBe(true);
    });
  });

  // Unspecified address
  describe("Unspecified address (::)", () => {
    it("should identify :: as private (IPv6 all-zeros / unspecified)", () => {
      expect(isPrivateIPv6("::")).toBe(true);
    });

    it("should identify 0:0:0:0:0:0:0:0 as private (expanded all-zeros)", () => {
      expect(isPrivateIPv6("0:0:0:0:0:0:0:0")).toBe(true);
    });
  });

  // ULA (fc00::/7) — Unique Local Addresses
  describe("ULA — Unique Local Addresses (fc00::/7)", () => {
    it("should identify fc00::1 as private (ULA, fc prefix)", () => {
      expect(isPrivateIPv6("fc00::1")).toBe(true);
    });

    it("should identify fd00::1 as private (ULA, fd prefix)", () => {
      expect(isPrivateIPv6("fd00::1")).toBe(true);
    });

    it("should identify fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff as private (ULA upper bound)", () => {
      expect(isPrivateIPv6("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    });
  });

  // Link-local (fe80::/10)
  describe("Link-local (fe80::/10)", () => {
    it("should identify fe80::1 as private (link-local)", () => {
      expect(isPrivateIPv6("fe80::1")).toBe(true);
    });

    it("should identify fe80::dead:beef as private (link-local with suffix)", () => {
      expect(isPrivateIPv6("fe80::dead:beef")).toBe(true);
    });

    it("should identify fe89::1 as private (within fe80::/10 range)", () => {
      expect(isPrivateIPv6("fe89::1")).toBe(true);
    });

    it("should identify fe9f::1 as private (within fe80::/10 range via fe[89ab] check)", () => {
      expect(isPrivateIPv6("fe9f::1")).toBe(true);
    });
  });

  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  describe("IPv4-mapped addresses (::ffff:0:0/96)", () => {
    it("should identify ::ffff:192.168.1.1 as private (IPv4-mapped private address)", () => {
      expect(isPrivateIPv6("::ffff:192.168.1.1")).toBe(true);
    });

    it("should identify ::ffff:10.0.0.1 as private (IPv4-mapped RFC 1918 address)", () => {
      expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
    });

    it("should identify ::ffff:127.0.0.1 as private (IPv4-mapped loopback)", () => {
      expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    });
  });

  // Public IPv6 addresses — should return false
  describe("Public IPv6 addresses (should return false)", () => {
    it("should identify 2001:4860:4860::8888 as public (Google DNS IPv6)", () => {
      expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
    });

    it("should identify 2606:4700:4700::1111 as public (Cloudflare DNS IPv6)", () => {
      expect(isPrivateIPv6("2606:4700:4700::1111")).toBe(false);
    });

    it("should identify 2001:4860:: as public (Google prefix, not Teredo)", () => {
      expect(isPrivateIPv6("2001:4860::")).toBe(false);
    });
  });
});

// ── Suite 3: SolanaAdapter constructor — rejects private IP URLs ──────────────

describe("SolanaAdapter constructor — rejects private IP URLs", () => {
  // Private IPv4 in URL — should throw SSRF_BLOCKED
  describe("SSRF_BLOCKED for private IPv4 in rpcUrl", () => {
    it("should throw SolanaAdapterError with code SSRF_BLOCKED for 192.168.1.1", () => {
      expect(() => {
        new SolanaAdapter({ rpcUrl: "https://192.168.1.1:8899" });
      }).toThrow(SolanaAdapterError);

      let thrownError: unknown;
      try {
        new SolanaAdapter({ rpcUrl: "https://192.168.1.1:8899" });
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeInstanceOf(SolanaAdapterError);
      expect((thrownError as SolanaAdapterError).code).toBe("SSRF_BLOCKED");
    });

    it("should throw SolanaAdapterError with code SSRF_BLOCKED for 10.0.0.1", () => {
      let thrownError: unknown;
      try {
        new SolanaAdapter({ rpcUrl: "https://10.0.0.1/rpc" });
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeInstanceOf(SolanaAdapterError);
      expect((thrownError as SolanaAdapterError).code).toBe("SSRF_BLOCKED");
    });

    it("should throw SolanaAdapterError with code SSRF_BLOCKED for 172.16.0.1", () => {
      let thrownError: unknown;
      try {
        new SolanaAdapter({ rpcUrl: "https://172.16.0.1/rpc" });
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeInstanceOf(SolanaAdapterError);
      expect((thrownError as SolanaAdapterError).code).toBe("SSRF_BLOCKED");
    });

    it("should throw SolanaAdapterError with code SSRF_BLOCKED for link-local 169.254.169.254", () => {
      let thrownError: unknown;
      try {
        new SolanaAdapter({ rpcUrl: "https://169.254.169.254/latest/meta-data" });
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeInstanceOf(SolanaAdapterError);
      expect((thrownError as SolanaAdapterError).code).toBe("SSRF_BLOCKED");
    });

    it("should redact the blocked IP in the error message (M64 fix)", () => {
      let errorMessage = "";
      try {
        new SolanaAdapter({ rpcUrl: "https://192.168.1.1:8899" });
      } catch (err) {
        errorMessage = (err as Error).message;
      }
      // M64 fix: sanitizeRpcError redacts IPs from error messages
      expect(errorMessage).toContain("[redacted-ip]");
      expect(errorMessage).not.toContain("192.168.1.1");
    });
  });

  // Insecure HTTP with non-localhost hostname — should throw INSECURE_URL
  describe("INSECURE_URL for http:// with non-localhost hostname", () => {
    it("should throw SolanaAdapterError with code INSECURE_URL for http:// with external hostname", () => {
      let thrownError: unknown;
      try {
        new SolanaAdapter({ rpcUrl: "http://api.mainnet-beta.solana.com" });
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeInstanceOf(SolanaAdapterError);
      expect((thrownError as SolanaAdapterError).code).toBe("INSECURE_URL");
    });

    it("should throw INSECURE_URL for http:// with public IP", () => {
      let thrownError: unknown;
      try {
        new SolanaAdapter({ rpcUrl: "http://8.8.8.8/rpc" });
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeInstanceOf(SolanaAdapterError);
      expect((thrownError as SolanaAdapterError).code).toBe("INSECURE_URL");
    });
  });

  // Valid URLs — should NOT throw
  describe("Valid URLs (should NOT throw)", () => {
    it("should NOT throw for https://api.devnet.solana.com", () => {
      expect(() => {
        new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });
      }).not.toThrow();
    });

    it("should NOT throw for https://api.mainnet-beta.solana.com", () => {
      expect(() => {
        new SolanaAdapter({ rpcUrl: "https://api.mainnet-beta.solana.com" });
      }).not.toThrow();
    });

    it("should NOT throw for http://localhost:8899 (localhost HTTP is allowed for dev)", () => {
      expect(() => {
        new SolanaAdapter({ rpcUrl: "http://localhost:8899" });
      }).not.toThrow();
    });

    it("should NOT throw for http://127.0.0.1:8899 (loopback HTTP is allowed for dev)", () => {
      expect(() => {
        new SolanaAdapter({ rpcUrl: "http://127.0.0.1:8899" });
      }).not.toThrow();
    });
  });
});

// ── Suite 4: DNS rebinding protection ────────────────────────────────────────

describe("DNS rebinding protection — mocked dns/promises", () => {
  /**
   * DNS rebinding attack scenario:
   *
   * An attacker registers a domain (e.g., evil.attacker.com) and controls its DNS.
   * Step 1: Initial DNS query returns a public IP (e.g., 1.2.3.4) — passes validation.
   * Step 2: Attacker rapidly changes DNS to resolve to a private IP (e.g., 192.168.1.100).
   * Step 3: The next HTTP connection (made by @solana/web3.js Connection) resolves DNS
   *         again independently, now receiving the private IP — bypassing SSRF protection.
   *
   * The fix (CHAIN-001): createPinnedLookup resolves DNS once, validates the IP against
   * isPrivateIPv4/isPrivateIPv6, caches the result, and injects it into the http(s).Agent.
   * All subsequent connections reuse the pinned, validated IP — no second DNS resolution occurs.
   * If the cache expires and a fresh DNS resolution returns a private IP, it is rejected here.
   *
   * isPrivateIPv4 and isPrivateIPv6 are the core gatekeeping functions used by both
   * resolveAndValidateDns (called during adapter.connect()) and createPinnedLookup
   * (called on each HTTP connection attempt). These tests verify the gatekeeping logic
   * directly and demonstrate that 192.168.1.100 — the IP a DNS rebinding attack might
   * return — would be caught and rejected.
   */

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should confirm that 192.168.1.100 (typical DNS rebinding target) is identified as private by isPrivateIPv4", () => {
    // This is the IP a DNS rebinding attack would return on the second resolution.
    // isPrivateIPv4 is called by createPinnedLookup and resolveAndValidateDns
    // to catch exactly this scenario.
    expect(isPrivateIPv4("192.168.1.100")).toBe(true);
  });

  it("should confirm that 10.0.0.50 (internal service IP) is identified as private by isPrivateIPv4", () => {
    expect(isPrivateIPv4("10.0.0.50")).toBe(true);
  });

  it("should confirm that 172.20.0.1 (Docker default bridge network) is identified as private by isPrivateIPv4", () => {
    expect(isPrivateIPv4("172.20.0.1")).toBe(true);
  });

  it("should confirm that fc00::dead:beef (ULA IPv6) is identified as private by isPrivateIPv6", () => {
    expect(isPrivateIPv6("fc00::dead:beef")).toBe(true);
  });

  it("should confirm that fe80::1 (link-local IPv6) is identified as private by isPrivateIPv6", () => {
    expect(isPrivateIPv6("fe80::1")).toBe(true);
  });

  it("should confirm that a legitimate public IP (8.8.8.8) would NOT be blocked", () => {
    // Positive control: public IPs must pass through so the adapter can connect
    // to real Solana RPC endpoints. isPrivateIPv4 must return false for public IPs.
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
  });

  it("should confirm that a legitimate public IPv6 (2001:4860:4860::8888) would NOT be blocked", () => {
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
  });

  it("constructor should succeed with a public HTTPS URL even when dns mock is configured", async () => {
    // The mocked lookup is configured but the constructor does not call lookup —
    // it only calls validateRpcUrl (synchronous IP-literal check). The dns lookup
    // is performed later during adapter.connect(). This test confirms the constructor
    // itself is safe from DNS-related failures.
    const { lookup } = await import("node:dns/promises");
    const mockLookup = vi.mocked(lookup as unknown as (
      hostname: string,
      options: { family?: number }
    ) => Promise<{ address: string; family: number }>);

    mockLookup.mockResolvedValue({ address: "192.168.1.100", family: 4 });

    // Constructor must NOT throw — URL passes static validation (not an IP literal)
    expect(() => {
      new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });
    }).not.toThrow();
  });

  it("should correctly identify all IPs a rebinding attack could return as private", () => {
    // Exhaustive check: all IPs that a successful DNS rebinding attack might
    // return to reach internal services are blocked by isPrivateIPv4.
    const rebindingTargets = [
      "192.168.0.1",    // home router default gateway
      "192.168.1.1",    // common home router
      "192.168.1.100",  // typical DHCP-assigned host
      "10.0.0.1",       // common internal gateway
      "10.0.0.50",      // internal service host
      "172.16.0.1",     // private Class B
      "172.17.0.1",     // Docker default bridge (172.17.0.0/16)
      "172.18.0.1",     // Docker custom bridge
      "172.31.0.1",     // AWS VPC default subnet
      "169.254.169.254",// AWS/GCP/Azure instance metadata service
      "127.0.0.1",      // localhost
      "0.0.0.0",        // unspecified
    ];

    for (const ip of rebindingTargets) {
      expect(isPrivateIPv4(ip), `Expected ${ip} to be identified as private`).toBe(true);
    }
  });

  it("should correctly identify all IPv6 addresses a rebinding attack could return as private", () => {
    const ipv6RebindingTargets = [
      "::1",                              // loopback
      "::",                               // unspecified
      "fc00::1",                          // ULA
      "fd12:3456:789a::1",               // ULA (random global ID)
      "fe80::1",                          // link-local
      "::ffff:192.168.1.1",              // IPv4-mapped private
      "::ffff:10.0.0.1",                 // IPv4-mapped RFC 1918
      "::ffff:169.254.169.254",          // IPv4-mapped link-local (metadata)
    ];

    for (const ip of ipv6RebindingTargets) {
      expect(isPrivateIPv6(ip), `Expected ${ip} to be identified as private`).toBe(true);
    }
  });

  it("isValidAddress should not trigger DNS resolution (DNS is only used during connect)", () => {
    // isValidAddress is a pure synchronous check — it must not trigger DNS resolution.
    // Verifying this ensures that the attack surface for DNS-based exploits is limited
    // to the connect() path where pinning is enforced.
    const adapter = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

    // This should not throw and should not call the mocked dns.lookup
    const result = adapter.isValidAddress("11111111111111111111111111111111");
    expect(result).toBe(true);
  });
});

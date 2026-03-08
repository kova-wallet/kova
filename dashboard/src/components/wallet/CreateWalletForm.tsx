"use client";

import { useState, useRef } from "react";

type WalletMode = "generate" | "import" | "keyfile" | "turnkey";

const modes: { value: WalletMode; label: string }[] = [
  { value: "generate", label: "Generate New" },
  { value: "import", label: "Secret Key" },
  { value: "keyfile", label: "Keyfile" },
  { value: "turnkey", label: "Turnkey MPC" },
];

export default function CreateWalletForm({
  onCreated,
}: {
  onCreated: (address: string) => void;
}) {
  const [mode, setMode] = useState<WalletMode>("generate");
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [keyfilePath, setKeyfilePath] = useState("");
  const [keyfileBytes, setKeyfileBytes] = useState<number[] | null>(null);
  const [keyfileFilename, setKeyfileFilename] = useState<string | null>(null);
  const [turnkey, setTurnkey] = useState({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey: "",
    apiPrivateKey: "",
    organizationId: "",
    walletAddress: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleKeyfileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setKeyfileFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const parsed = JSON.parse(text) as number[];
        if (!Array.isArray(parsed) || parsed.length !== 64) {
          setError("Keyfile must contain a JSON array of 64 bytes");
          return;
        }
        setKeyfileBytes(parsed);
        setError(null);
      } catch {
        setError("Invalid JSON keyfile");
      }
    };
    reader.readAsText(file);
  }

  async function handleCreate() {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { mode };

      if (mode === "import") {
        const parsed = JSON.parse(secretKeyInput);
        if (!Array.isArray(parsed) || parsed.length !== 64) {
          throw new Error("Secret key must be a JSON array of 64 bytes");
        }
        body.secretKey = parsed;
      } else if (mode === "keyfile") {
        if (keyfileBytes) {
          body.keyfileBytes = keyfileBytes;
        } else if (keyfilePath.trim()) {
          body.keyfilePath = keyfilePath.trim();
        } else {
          throw new Error("Upload a keyfile or provide a file path");
        }
      } else if (mode === "turnkey") {
        if (!turnkey.apiPublicKey || !turnkey.apiPrivateKey || !turnkey.organizationId || !turnkey.walletAddress) {
          throw new Error("All Turnkey fields are required");
        }
        body.turnkeyConfig = turnkey;
      }

      const res = await fetch("/api/wallet/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onCreated(data.address);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create wallet");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-6 max-w-lg">
      <h2 className="text-lg font-semibold mb-4">Load Wallet</h2>

      {/* Mode tabs */}
      <div className="flex flex-wrap gap-1.5 mb-5">
        {modes.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => { setMode(value); setError(null); }}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              mode === value
                ? "bg-accent text-white"
                : "bg-surface-hover text-text-secondary hover:text-text-primary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Generate */}
      {mode === "generate" && (
        <p className="text-sm text-text-secondary mb-4">
          A new Solana keypair will be generated with a default spending limit policy.
        </p>
      )}

      {/* Import secret key */}
      {mode === "import" && (
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">
            Secret Key (JSON array of 64 bytes)
          </label>
          <textarea
            value={secretKeyInput}
            onChange={(e) => setSecretKeyInput(e.target.value)}
            placeholder="[1, 2, 3, ..., 64]"
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
            rows={3}
          />
        </div>
      )}

      {/* Keyfile import */}
      {mode === "keyfile" && (
        <div className="mb-4 space-y-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Upload Keyfile (Solana CLI id.json)
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleKeyfileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="bg-surface-hover text-text-secondary hover:text-text-primary border border-border rounded-md px-3 py-2 text-sm transition-colors"
            >
              {keyfileFilename ? keyfileFilename : "Choose file..."}
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span className="flex-1 h-px bg-border" />
            <span>or</span>
            <span className="flex-1 h-px bg-border" />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              File Path (server-side)
            </label>
            <input
              type="text"
              value={keyfilePath}
              onChange={(e) => setKeyfilePath(e.target.value)}
              placeholder="/home/user/.config/solana/id.json"
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
            />
          </div>
        </div>
      )}

      {/* Turnkey MPC */}
      {mode === "turnkey" && (
        <div className="mb-4 space-y-3">
          {[
            { key: "apiBaseUrl", label: "API Base URL", placeholder: "https://api.turnkey.com" },
            { key: "apiPublicKey", label: "API Public Key", placeholder: "Your Turnkey API public key" },
            { key: "apiPrivateKey", label: "API Private Key", placeholder: "Your Turnkey API private key" },
            { key: "organizationId", label: "Organization ID", placeholder: "Your Turnkey organization ID" },
            { key: "walletAddress", label: "Wallet Address", placeholder: "Solana address or Turnkey wallet ID" },
          ].map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="block text-sm text-text-secondary mb-1">{label}</label>
              <input
                type={key.includes("Private") ? "password" : "text"}
                value={turnkey[key as keyof typeof turnkey]}
                onChange={(e) => setTurnkey((prev) => ({ ...prev, [key]: e.target.value }))}
                placeholder={placeholder}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
              />
            </div>
          ))}
          <p className="text-xs text-text-secondary">
            Credentials are sent to your server only — never stored in the browser.
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-danger mb-4">{error}</p>
      )}

      <button
        onClick={handleCreate}
        disabled={loading}
        className="w-full bg-accent hover:bg-accent-hover text-white py-2.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
      >
        {loading ? "Loading..." : mode === "generate" ? "Generate Wallet" : "Load Wallet"}
      </button>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useCallback } from "react";

interface LoadedWalletInfo {
  address: string;
  sourceLabel: string;
  sourceType: string;
  isActive: boolean;
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: GridIcon },
  { href: "/wallet", label: "Wallet", icon: KeyIcon },
  { href: "/policy", label: "Policy", icon: ShieldIcon },
  { href: "/transactions", label: "Transactions", icon: SendIcon },
  { href: "/approvals", label: "Approvals", icon: BellIcon },
  { href: "/audit-log", label: "Audit Log", icon: ClipboardIcon },
];

const networkColors: Record<string, string> = {
  "mainnet-beta": "bg-green-500",
  devnet: "bg-purple-500",
  testnet: "bg-yellow-500",
  localnet: "bg-blue-500",
};

const sourceTypeIcons: Record<string, string> = {
  generate: "G",
  "secret-key": "K",
  keyfile: "F",
  turnkey: "T",
  env: "E",
};

export default function Sidebar() {
  const pathname = usePathname();
  const [networkLabel, setNetworkLabel] = useState("...");
  const [networkId, setNetworkId] = useState("localnet");
  const [wallets, setWallets] = useState<LoadedWalletInfo[]>([]);
  const [showWalletList, setShowWalletList] = useState(false);

  const fetchData = useCallback(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((data) => {
        if (data.networkLabel) setNetworkLabel(data.networkLabel);
        if (data.network) setNetworkId(data.network);
        if (data.loadedWallets) setWallets(data.loadedWallets);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleSwitch(address: string) {
    await fetch("/api/wallet/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    fetchData();
    setShowWalletList(false);
  }

  const activeWallet = wallets.find((w) => w.isActive);

  return (
    <aside className="w-56 h-screen bg-surface border-r border-border flex flex-col fixed left-0 top-0">
      <div className="p-5 border-b border-border">
        <h1 className="text-lg font-bold text-text-primary tracking-tight">
          Kova Dashboard
        </h1>
        <div className="flex items-center gap-2 mt-2">
          <span className={`w-2 h-2 rounded-full ${networkColors[networkId] ?? "bg-blue-500"}`} />
          <span className="text-xs text-text-secondary">{networkLabel}</span>
        </div>
      </div>

      {/* Wallet switcher */}
      {wallets.length > 0 && (
        <div className="px-3 pt-3 pb-1">
          <button
            onClick={() => setShowWalletList(!showWalletList)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-md bg-surface-hover hover:bg-background transition-colors text-left"
          >
            <span className="w-5 h-5 flex items-center justify-center rounded bg-accent/20 text-accent text-[10px] font-bold shrink-0">
              {sourceTypeIcons[activeWallet?.sourceType ?? ""] ?? "W"}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-medium text-text-primary truncate">
                {activeWallet?.address
                  ? `${activeWallet.address.slice(0, 4)}...${activeWallet.address.slice(-4)}`
                  : "No wallet"}
              </span>
              <span className="block text-[10px] text-text-secondary truncate">
                {activeWallet?.sourceLabel ?? ""}
              </span>
            </span>
            <ChevronIcon className="w-3 h-3 text-text-secondary shrink-0" up={showWalletList} />
          </button>

          {showWalletList && wallets.length > 1 && (
            <div className="mt-1 border border-border rounded-md bg-background overflow-hidden">
              {wallets.filter((w) => !w.isActive).map((w) => (
                <button
                  key={w.address}
                  onClick={() => handleSwitch(w.address)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-surface-hover transition-colors text-left"
                >
                  <span className="w-4 h-4 flex items-center justify-center rounded bg-surface-hover text-text-secondary text-[9px] font-bold shrink-0">
                    {sourceTypeIcons[w.sourceType] ?? "W"}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[11px] text-text-secondary truncate">
                      {w.address.slice(0, 4)}...{w.address.slice(-4)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <nav className="flex-1 py-3">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                active
                  ? "text-accent bg-accent/10 border-r-2 border-accent"
                  : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border">
        <p className="text-xs text-text-secondary">
          kova v0.1.0
        </p>
      </div>
    </aside>
  );
}

function ChevronIcon({ className, up }: { className?: string; up?: boolean }) {
  return (
    <svg className={`${className} transition-transform ${up ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
    </svg>
  );
}

function KeyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
    </svg>
  );
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
    </svg>
  );
}

function ClipboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25Z" />
    </svg>
  );
}

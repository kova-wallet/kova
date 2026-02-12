/**
 * MPC Signer — Interface stub for MPC-based signing.
 * Implementation deferred to Phase 2.
 */

import type { Signer, UnsignedTransaction, SignedTransaction } from "./interface.js";

export interface MPCSignerConfig {
  /** MPC provider (e.g., "lit-protocol", "fireblocks") */
  provider: string;
  /** Key identifier within the MPC provider */
  keyId: string;
  /** Number of shares required to sign */
  threshold: number;
}

export class MPCSigner implements Signer {
  private readonly _config: MPCSignerConfig;

  constructor(config: MPCSignerConfig) {
    this._config = config;
  }

  /** Not yet implemented. Throws an error. Planned for Phase 2. */
  async getAddress(): Promise<string> {
    throw new Error("MPCSigner is not yet implemented — planned for Phase 2");
  }

  /** Not yet implemented. Throws an error. Planned for Phase 2. */
  async sign(_transaction: UnsignedTransaction): Promise<SignedTransaction> {
    throw new Error("MPCSigner is not yet implemented — planned for Phase 2");
  }

  /** Returns false — MPC signer is not yet implemented. */
  async healthCheck(): Promise<boolean> {
    return false;
  }
}

import { createHash } from "node:crypto";

import { getMidnightNodeConfig, MidnightNetwork } from "@sig-net/midnight-contract-deploy";

/** Sepolia USDC (Circle). 6 decimals. The contract pins the same address in usdc(). */
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const SEPOLIA_CHAIN_ID = 11155111;
export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const USDC_DECIMALS = 6;
/** What the circuit fixes for every sweep: gas limit and tip. */
export const SWEEP_GAS_LIMIT = 200_000n;
export const SWEEP_TIP = 1_000_000_000n;

export interface WorkshopConfig {
  readonly seed: string | undefined;
  /** Your 32-byte identity secret: answers the contract's callerSecretKey() witness. */
  readonly userSecretKey: Uint8Array | undefined;
  readonly sepoliaRpcUrl: string;
  readonly midnight: ReturnType<typeof getMidnightNodeConfig>;
  readonly appPort: number;
}

/**
 * The identity secret is derived from the wallet seed, so one .env is one
 * identity: same seed, same commitment, same deposit address. The real vault
 * keeps it separate from the wallet (a browser wallet cannot expose its seed).
 */
export function deriveUserSecretKey(seed: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`midnight-signet-workshop:user:${seed.trim()}`).digest());
}

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkshopConfig {
  const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
  const seed = blank(env.WALLET_SEED);
  const explicitSecret = blank(env.USER_SECRET_KEY)?.replace(/^0x/i, "");
  return {
    seed,
    userSecretKey: explicitSecret
      ? Uint8Array.from(Buffer.from(explicitSecret, "hex"))
      : seed
        ? deriveUserSecretKey(seed)
        : undefined,
    sepoliaRpcUrl: blank(env.SEPOLIA_RPC_URL) ?? DEFAULT_SEPOLIA_RPC,
    midnight: getMidnightNodeConfig({ ...env, NETWORK_ID: MidnightNetwork.Stagenet }),
    appPort: Number(blank(env.PORT) ?? "4173"),
  };
}

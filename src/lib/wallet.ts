import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ledger from "@midnightntwrk/ledger-v9";
import { InMemoryTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { type FacadeState, mergeWalletEntries, WalletEntrySchema, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { PublicKey as UnshieldedPublicKey, UnshieldedWallet } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { type AccountKeys, type MidnightNodeConfig } from "@sig-net/midnight-contract-deploy";

const CACHE_DIR = fileURLToPath(new URL("../../.wallet-cache/", import.meta.url));

interface Cached {
  shielded: string;
  unshielded: string;
  dust: string;
}

const cacheFile = (seed: string, networkId: string) =>
  `${CACHE_DIR}${networkId}-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}.json`;

function build(keys: AccountKeys, config: MidnightNodeConfig, cached?: Cached) {
  return WalletFacade.init({
    configuration: {
      networkId: config.networkId,
      indexerClientConnection: { indexerHttpUrl: config.indexerUrl, indexerWsUrl: config.indexerWsUrl },
      provingServerUrl: new URL(config.proofServerUrl),
      relayURL: new URL(config.nodeUrl.replace(/^http/, "ws")),
      costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    } as never,
    shielded: (cfg) =>
      cached ? ShieldedWallet(cfg).restore(cached.shielded) : ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      cached
        ? UnshieldedWallet(cfg).restore(cached.unshielded)
        : UnshieldedWallet(cfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore)),
    dust: (cfg) =>
      cached
        ? DustWallet(cfg).restore(cached.dust)
        : DustWallet(cfg).startWithSecretKey(keys.dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
}

async function save(facade: WalletFacade, file: string) {
  const state: Cached = {
    shielded: await facade.shielded.serializeState(),
    unshielded: await facade.unshielded.serializeState(),
    dust: await facade.dust.serializeState(),
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

async function synced(facade: WalletFacade): Promise<FacadeState> {
  const started = Date.now();
  let latest: FacadeState | undefined;
  const sub = facade.state().subscribe({ next: (s) => (latest = s) });
  const beat = setInterval(() => {
    const at = latest ? ` (shielded ${latest.shielded.progress.appliedIndex}, dust ${latest.dust.progress.appliedIndex})` : "";
    console.log(`  wallet syncing, ${Math.round((Date.now() - started) / 1000)}s${at}`);
  }, 15_000);
  try {
    const state = await facade.waitForSyncedState();
    console.log(`wallet synced in ${Math.round((Date.now() - started) / 1000)}s`);
    return state;
  } finally {
    clearInterval(beat);
    sub.unsubscribe();
  }
}

/** Start (or resume) the wallet, sync it, run `fn`, save the sync, stop. */
export async function withSyncedWallet<T>(
  seed: string,
  keys: AccountKeys,
  config: MidnightNodeConfig,
  fn: (facade: WalletFacade, state: FacadeState) => Promise<T>,
): Promise<T> {
  const file = cacheFile(seed, String(config.networkId));
  let cached: Cached | undefined;
  if (existsSync(file)) {
    try {
      cached = JSON.parse(readFileSync(file, "utf8")) as Cached;
    } catch {
      cached = undefined;
    }
  }
  console.log(cached ? "resuming wallet from .wallet-cache" : "first wallet sync: this can take 10+ minutes, once");
  let facade: WalletFacade;
  try {
    facade = await build(keys, config, cached);
  } catch (e) {
    if (!cached) throw e;
    console.log(`wallet cache unusable (${String(e)}), syncing from scratch`);
    facade = await build(keys, config);
  }
  await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
  try {
    const state = await synced(facade);
    await save(facade, file);
    return await fn(facade, state);
  } finally {
    await save(facade, file).catch(() => undefined);
    await facade.stop().catch(() => undefined);
  }
}

import {
  createProofProvider,
  type MidnightProvider,
  type ProofProvider,
  type UnboundTransaction,
  type WalletProvider,
  type ZKConfigProvider,
  ZKConfigRegistry,
  zkConfigToProvingKeyMaterial,
} from "@midnight-ntwrk/midnight-js/types";
import { httpClientProvingProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import type { ProvingKeyMaterial, ProvingProvider } from "@midnightntwrk/ledger-v9";
import type { AccountKeys, WalletFacade } from "@sig-net/midnight-contract-deploy";

const BALANCE_TTL_MS = 30 * 60 * 1000;
const PROOF_TIMEOUT_MS = 15 * 60 * 1000;

export function createWalletAndMidnightProvider(
  facade: WalletFacade,
  keys: AccountKeys,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: UnboundTransaction, ttl?: Date) {
      const recipe = await facade.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + BALANCE_TTL_MS) },
      );
      const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
      return await facade.finalizeRecipe(signed);
    },
    submitTx: (tx) => facade.submitTransaction(tx),
  };
}

export function createCrossContractProofServerProvider(
  proofServerUrl: string,
  zkConfigProviders: readonly ZKConfigProvider<string>[],
): ProofProvider {
  const registry = new ZKConfigRegistry([...zkConfigProviders]);
  const base = httpClientProvingProvider(
    proofServerUrl,
    registry as unknown as ZKConfigProvider<string>,
    { timeout: PROOF_TIMEOUT_MS },
  );
  const lookupKey = async (keyLocation: string): Promise<ProvingKeyMaterial | undefined> => {
    const resolved = await registry.resolveKeyLocation(keyLocation);
    if (resolved !== undefined) return zkConfigToProvingKeyMaterial(resolved);
    for (const provider of zkConfigProviders) {
      try {
        return zkConfigToProvingKeyMaterial(await provider.get(keyLocation));
      } catch {
      }
    }
    return undefined;
  };
  const provingProvider: ProvingProvider = { ...base, lookupKey };
  return createProofProvider(provingProvider);
}

import { existsSync } from "node:fs";

import { submitCallTx } from "@midnight-ntwrk/midnight-js/contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import {
  contractAddressFromHex,
  getSignetContractAddress,
  MidnightNetwork,
  type SignetPublicStateSource,
} from "@sig-net/midnight";
import {
  type AccountKeys,
  buildDeployTransaction,
  deriveAccountKeys,
  ensureFeeReady,
  getFaucetUrl,
  makeCompiledContract,
  signetContractManagedPath,
  submitUnprovenTransaction,
  type WalletFacade,
} from "@sig-net/midnight-contract-deploy";
import { Contract as Erc20, JsonRpcProvider } from "ethers";

import { loadConfig, SEPOLIA_CHAIN_ID, SEPOLIA_USDC, type WorkshopConfig } from "./config.ts";
import {
  Contract as WorkshopContractClass,
  depositAddress,
  MANAGED,
  poolTokenType,
  PRIVATE_STATE_ID,
  type PrivateState,
  userCommitment,
  witnesses,
} from "./identity.ts";
import { createCrossContractProofServerProvider, createWalletAndMidnightProvider } from "./midnight-providers.ts";
import { withSyncedWallet } from "./wallet.ts";

type WorkshopContract = InstanceType<typeof WorkshopContractClass<PrivateState>>;
type Circuits = WorkshopContract["provableCircuits"];
export type CircuitId = keyof Circuits & string;
type Tail<T> = T extends [unknown, ...infer R] ? R : never;
export type CircuitArgs<K extends CircuitId> = Tail<Parameters<Circuits[K]>>;
export type CircuitResult<K extends CircuitId> = Awaited<ReturnType<Circuits[K]>>["result"];

export interface CallOutcome<K extends CircuitId> {
  readonly result: CircuitResult<K>;
  readonly txId: string;
  readonly blockHeight: number;
}

export type SepoliaClient = Pick<
  JsonRpcProvider,
  "getTransactionCount" | "getFeeData" | "getBalance" | "broadcastTransaction" | "call" | "getTransactionReceipt"
>;

export interface Workshop {
  readonly indexerUrl: string;
  readonly publicDataProvider: SignetPublicStateSource;
  readonly sepolia: SepoliaClient;
  readonly commitmentHex: string;
  depositAddress(contractAddress: string): string;
  call<K extends CircuitId>(circuit: K, ...args: CircuitArgs<K>): Promise<CallOutcome<K>>;
  midnightTip(): Promise<number>;
  deploy(): Promise<{ contractAddress: string; txId: string }>;
  openWallet(): Promise<void>;
  shieldedBalance(contractAddress: string): Promise<bigint>;
  sepoliaBalances(address: string): Promise<{ eth: bigint; usdc: bigint }>;
}

export interface OpenedWorkshop {
  readonly w: Workshop;
  close(): Promise<void>;
}

export function openWorkshop(contractAddress?: string): OpenedWorkshop {
  const config = loadConfig();
  const midnight = config.midnight;
  setNetworkId(midnight.networkId);
  const sepolia = new JsonRpcProvider(config.sepoliaRpcUrl, SEPOLIA_CHAIN_ID, { staticNetwork: true });
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: midnight.indexerUrl,
    subscriptionURL: midnight.indexerWsUrl,
  });
  const secretKey = config.userSecretKey;
  if (!secretKey) throw new Error("WALLET_SEED is missing in .env: run `yarn doctor`");
  const privateState: PrivateState = { secretKey };
  const usdc = new Erc20(SEPOLIA_USDC, ["function balanceOf(address) view returns (uint256)"], sepolia);

  let opened: Promise<Opened> | undefined;
  let release = () => {};
  let closed: Promise<unknown> = Promise.resolve();
  const wallet = () =>
    (opened ??= new Promise<Opened>((resolve, reject) => {
      const done = new Promise<void>((r) => (release = r));
      closed = openWallet(config, publicDataProvider, privateState, async (o) => {
        resolve(o);
        await done;
      }).catch((e: unknown) => {
        reject(e);
        opened = undefined;
      });
    }));

  const w: Workshop = {
    indexerUrl: midnight.indexerUrl,
    publicDataProvider,
    sepolia,
    commitmentHex: Buffer.from(userCommitment(secretKey)).toString("hex"),
    depositAddress: (address) => depositAddress(address, secretKey),
    async call(circuit, ...args) {
      if (!contractAddress) throw new Error("no contract yet: run `yarn deploy` first");
      const { providers, compiledContract } = await wallet();
      providers.privateStateProvider.setContractAddress(contractAddress);
      await providers.privateStateProvider.set(PRIVATE_STATE_ID, privateState);
      const started = Date.now();
      console.log(`calling ${circuit}: proving + submitting (about a minute)...`);
      const tx = (await submitCallTx(providers as never, {
        compiledContract,
        contractAddress,
        circuitId: circuit,
        args,
        privateStateId: PRIVATE_STATE_ID,
      } as never)) as { private: { result: unknown }; public: { txId: string; blockHeight: number } };
      console.log(`${circuit}: tx ${tx.public.txId} in block ${tx.public.blockHeight} (${secondsSince(started)}s)`);
      return { result: tx.private.result as never, txId: tx.public.txId, blockHeight: tx.public.blockHeight };
    },
    async midnightTip() {
      const block = await publicDataProvider.queryBlock();
      if (!block) throw new Error("indexer returned no block");
      return block.height;
    },
    async deploy() {
      const { facade, keys, compiledContract } = await wallet();
      const started = Date.now();
      const signet = getSignetContractAddress(MidnightNetwork.Stagenet);
      console.log(`deploying (constructor: your commitment as deployer, Signet contract ${signet}), a minute...`);
      const deployTx = await buildDeployTransaction(
        compiledContract,
        midnight.networkId,
        keys.shieldedSecretKeys.coinPublicKey,
        privateState,
        userCommitment(secretKey),
        contractAddressFromHex(signet),
      );
      const txId = await submitUnprovenTransaction(facade, keys, deployTx.serializedTransaction);
      console.log(`deploy tx ${String(txId)} submitted, waiting for the indexer...`);
      await publicDataProvider.watchForContractState(deployTx.contractAddress);
      console.log(`deployed ${deployTx.contractAddress} in ${secondsSince(started)}s`);
      contractAddress = deployTx.contractAddress;
      return { contractAddress, txId: String(txId) };
    },
    async openWallet() {
      await wallet();
    },
    async shieldedBalance(address) {
      const { facade } = await wallet();
      const state = await facade.waitForSyncedState();
      return state.shielded.balances[poolTokenType(address)] ?? 0n;
    },
    async sepoliaBalances(address) {
      const [eth, tokens] = await Promise.all([
        sepolia.getBalance(address),
        usdc.getFunction("balanceOf")(address) as Promise<bigint>,
      ]);
      return { eth, usdc: tokens };
    },
  };

  return {
    w,
    async close() {
      release();
      await closed;
      sepolia.destroy();
    },
  };
}

export async function withWorkshop<T>(
  contractAddress: string | undefined,
  fn: (w: Workshop) => Promise<T>,
): Promise<T> {
  const { w, close } = openWorkshop(contractAddress);
  try {
    return await fn(w);
  } finally {
    await close();
  }
}

const secondsSince = (t: number) => Math.round((Date.now() - t) / 1000);

interface Opened {
  facade: WalletFacade;
  keys: AccountKeys;
  providers: {
    privateStateProvider: { setContractAddress(a: string): void; set(id: string, s: PrivateState): Promise<void> };
    [k: string]: unknown;
  };
  compiledContract: ReturnType<typeof makeCompiledContract<WorkshopContract, PrivateState>>;
}

async function openWallet(
  config: WorkshopConfig,
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>,
  privateState: PrivateState,
  use: (o: Opened) => Promise<void>,
): Promise<void> {
  if (!config.seed) throw new Error("WALLET_SEED is missing in .env: run `yarn doctor`");
  if (!existsSync(`${MANAGED}/keys`)) throw new Error("no proving keys: run `yarn compile` first");
  const compiledContract = makeCompiledContract<WorkshopContract, PrivateState>(
    "workshop",
    WorkshopContractClass as never,
    witnesses as never,
    MANAGED,
  );
  const midnight = config.midnight;
  const keys = deriveAccountKeys(config.seed, midnight.networkId);
  await withSyncedWallet(config.seed, keys, midnight, async (facade, walletState) => {
    await ensureFeeReady(facade, keys, walletState, midnight.networkId, getFaucetUrl(process.env, midnight.networkId));
    const wallet = createWalletAndMidnightProvider(facade, keys);
    const zkConfigProvider = new NodeZkConfigProvider<CircuitId>(MANAGED);
    const providers = {
      privateStateProvider: levelPrivateStateProvider<typeof PRIVATE_STATE_ID, PrivateState>({
        privateStateStoreName: "workshop-private-states",
        signingKeyStoreName: "workshop-signing-keys",
        accountId: wallet.getCoinPublicKey(),
        privateStoragePasswordProvider: () => "&*(BHJqwe419-sigWorkshop",
      }),
      publicDataProvider,
      zkConfigProvider,
      proofProvider: createCrossContractProofServerProvider(midnight.proofServerUrl, [
        zkConfigProvider,
        new NodeZkConfigProvider<string>(signetContractManagedPath),
      ]),
      walletProvider: wallet,
      midnightProvider: wallet,
    };
    await use({ facade, keys, providers: providers as never, compiledContract });
  });
}

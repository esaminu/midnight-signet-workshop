import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import {
  bytesToHex,
  OutputKind,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";

import * as SignetSigner from "../contract/managed-test/SignetSigner/contract/index.js";

type Generated = {
  Contract: new (witnesses: object) => {
    circuits: Record<string, ((ctx: Ctx, ...args: unknown[]) => Promise<{ context: Ctx; result: unknown }>) | undefined>;
    initialState(ctx: unknown, ...args: unknown[]): Promise<{ currentContractState: unknown; currentPrivateState: unknown }>;
  };
  ledger(state: unknown): Record<string, unknown>;
  pureCircuits: { userCommitment(sk: Uint8Array): Uint8Array; vaultTokenDomainSeparator(erc20: Uint8Array): Uint8Array; usdc(): Uint8Array };
};
export interface PrivateState {
  secretKey: Uint8Array;
}
export type Ctx = CircuitContext<PrivateState>;

const generated = (await import("../contract/managed-test/workshop/contract/index.js")) as unknown as Generated;
export const { pureCircuits } = generated;

const witnesses = {
  callerSecretKey: ({ privateState }: { privateState: PrivateState }): [PrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};

export const CPK = "0".repeat(64);
export const SIGNET_ADDRESS = sampleContractAddress();
export const CALLER_ADDRESS = sampleContractAddress();
export const CALLER_ADDRESS_BYTES = Uint8Array.from(Buffer.from(CALLER_ADDRESS, "hex"));

export const USER_SECRET = new Uint8Array(32).fill(0x11);
export const OTHER_SECRET = new Uint8Array(32).fill(0x22);
export const USER_COMMITMENT = pureCircuits.userCommitment(USER_SECRET);

export const MPC_RESPONSE_SECRET = new Uint8Array(32).fill(0x42);
export const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);
export const IMPOSTER_SECRET = new Uint8Array(32).fill(0x66);

export const VAULT_EVM = new Uint8Array(20).fill(0xaa);
export const USDC = Uint8Array.from(Buffer.from("1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "hex"));
export const AMOUNT = 10_000n;
export const EVM_NONCE = 3n;
export const MAX_FEE = 30_000_000_000n;

export const SUCCESS = Uint8Array.of(1);
export const FAILURE = Uint8Array.of(0);
export const MINT_NONCE = new Uint8Array(32).fill(0x77);

export function circuit(name: string) {
  const contract = new generated.Contract(witnesses);
  const fn = contract.circuits[name];
  if (!fn) throw new Error(`circuit ${name} not found in contract/workshop.compact`);
  return (ctx: Ctx, ...args: unknown[]) => fn.call(contract.circuits, ctx, ...args);
}

export function ledgerOf(ctx: Ctx): Record<string, unknown> {
  return generated.ledger(ctx.callContext.currentQueryContext.state);
}

export function field<T>(ctx: Ctx, name: string): T {
  const value = ledgerOf(ctx)[name];
  if (value === undefined) throw new Error(`ledger field ${name} not found in contract/workshop.compact`);
  return value as T;
}

export function mints(ctx: Ctx): Map<string, bigint> {
  return (ctx.callContext.currentQueryContext as unknown as { effects: { shieldedMints: Map<string, bigint> } }).effects.shieldedMints;
}
export const POOL_TOKEN = bytesToHex(pureCircuits.vaultTokenDomainSeparator(USDC));

async function signetStateProvider() {
  const signet = new SignetSigner.Contract({});
  const { currentContractState } = await signet.initialState(createConstructorContext(undefined, CPK));
  return { getContractState: () => Promise.resolve(currentContractState) };
}

export async function deploy(): Promise<Ctx> {
  const contract = new generated.Contract(witnesses);
  const privateState: PrivateState = { secretKey: USER_SECRET };
  const initial = await contract.initialState(createConstructorContext(privateState, CPK), USER_COMMITMENT, {
    bytes: Uint8Array.from(Buffer.from(SIGNET_ADDRESS, "hex")),
  });
  return createCircuitContext(
    "initialise",
    CALLER_ADDRESS,
    CPK,
    initial.currentContractState as never,
    privateState,
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    "0".repeat(64),
  );
}

export async function asUser(ctx: Ctx, secretKey: Uint8Array): Promise<Ctx> {
  return createCircuitContext(
    ctx.callContext.circuitId,
    CALLER_ADDRESS,
    CPK,
    ctx.callContext.currentQueryContext.state,
    { secretKey },
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    "0".repeat(64),
  );
}

export async function deployInitialised(): Promise<Ctx> {
  return (await circuit("initialise")(await deploy(), VAULT_EVM, MPC_RESPONSE_KEY)).context;
}

export async function requested(nonce = EVM_NONCE, amount = AMOUNT): Promise<{ ctx: Ctx; requestId: Uint8Array }> {
  const r = await circuit("sendDeposit")(await deployInitialised(), amount, nonce, MAX_FEE);
  const requestId = r.result as Uint8Array;
  if (requestId.every((b) => b === 0)) {
    throw new Error("sendDeposit returned an empty request id: finish TODO(part 1) in contract/workshop.compact");
  }
  return { ctx: r.context, requestId };
}

export function attest(
  requestId: Uint8Array,
  outputKind: OutputKind,
  serializedOutput: Uint8Array,
  { blockHeight = 9_000_000n, secret = MPC_RESPONSE_SECRET } = {},
): RespondBidirectionalEvent {
  return respondBidirectionalEventToCircuitInput(
    attestRespondBidirectional({ requestId, blockHeight, outputKind, serializedOutput }, secret),
  );
}

export { OutputKind };

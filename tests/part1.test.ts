import {
  asciiPadded,
  bytesToHex,
  calculateRequestId,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetLogEvents,
  deriveEvmAddress,
  deriveSignBidirectionalEventSignerEvmAddress,
  getMpcRootPublicKey,
  MidnightNetwork,
  readSignetRequestsLedgerFromState,
  requestIdHex,
  signBidirectionalEventToUnsignedEvmTransaction,
  signetFieldNodeByPath,
  toSignBidirectionalEventIndex,
  type SignBidirectionalEvent,
} from "@sig-net/midnight";
import { Interface } from "ethers";
import { describe, expect, it } from "vitest";

import {
  AMOUNT, asUser, CALLER_ADDRESS, CALLER_ADDRESS_BYTES, circuit, deploy, deployInitialised, EVM_NONCE,
  field, MAX_FEE, MPC_RESPONSE_KEY, OTHER_SECRET, pureCircuits, requested, SIGNET_ADDRESS, USDC,
  USER_COMMITMENT, VAULT_EVM,
} from "./harness.ts";

type RequestMap = Iterable<[Uint8Array, SignBidirectionalEvent]>;
const ROOT = getMpcRootPublicKey(MidnightNetwork.Stagenet);

const onlyRecord = (state: unknown) => {
  const { requestsIndex } = readSignetRequestsLedgerFromState(state as never, [0]);
  expect(requestsIndex.size, "one request stored in the field-0 map").toBe(1);
  return [...requestsIndex.entries()][0]!;
};

describe("setup (provided): ledger, constructor, initialise", () => {
  it("deploys with an empty deposit map at ledger field 0, not initialised", async () => {
    const ctx = await deploy();
    expect(toSignBidirectionalEventIndex(field<RequestMap>(ctx, "bidirectionalDepositMap")).size).toBe(0);
    expect(field(ctx, "initialised")).toBe(false);
    expect(field(ctx, "globalLastSeen")).toBe(0n);
    const node = signetFieldNodeByPath(ctx.callContext.currentQueryContext.state, [0]);
    expect(node.type(), "field 0 must be bidirectionalDepositMap").toBe("map");
  });

  it("initialise pins the pool account and the response key, once, deployer only", async () => {
    const ctx = (await circuit("initialise")(await deploy(), VAULT_EVM, MPC_RESPONSE_KEY)).context;
    expect(field(ctx, "initialised")).toBe(true);
    expect(field(ctx, "vaultEvmAddress")).toEqual(VAULT_EVM);
    expect(field(ctx, "mpcResponseKey")).toEqual(MPC_RESPONSE_KEY);
    await expect(circuit("initialise")(ctx, VAULT_EVM, MPC_RESPONSE_KEY)).rejects.toThrow(/Already initialised/);
    const stranger = await asUser(await deploy(), OTHER_SECRET);
    await expect(circuit("initialise")(stranger, VAULT_EVM, MPC_RESPONSE_KEY)).rejects.toThrow(/Not the deployer/);
  });
});

describe("part 1: sendDeposit (Ask)", () => {
  it("stores the sweep in the field-0 map under the id it returns", async () => {
    const { ctx, requestId } = await requested();
    const [idHex, record] = onlyRecord(ctx.callContext.currentQueryContext.state);
    expect(idHex).toBe(requestIdHex(requestId));
    expect(requestIdHex(calculateRequestId(record))).toBe(idHex);
  });

  it("builds a Sepolia type-2 transaction to USDC, from YOUR deposit account", async () => {
    const { ctx } = await requested();
    const [, record] = onlyRecord(ctx.callContext.currentQueryContext.state);
    const { calldata: _calldata, ...envelope } = record.txParams as unknown as Record<string, unknown>;
    expect(envelope).toMatchObject({
      chainId: 11155111n, nonce: EVM_NONCE, to: USDC, value: 0n,
      gasLimit: 200000n, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: 1000000000n,
    });
    expect(record.sender).toEqual({ bytes: CALLER_ADDRESS_BYTES });
    expect(record.path, "the path must be userCommitment(callerSecretKey())").toEqual(USER_COMMITMENT);
    expect(record.keyVersion).toBe(1n);
    expect(record.outputDeserializationSchema).toEqual(asciiPadded('[{"name":"success","type":"bool"}]', 34));
  });

  it("is signed by the deposit address the app derives from your commitment", async () => {
    const { ctx } = await requested();
    const [, record] = onlyRecord(ctx.callContext.currentQueryContext.state);
    const depositAddress = deriveEvmAddress(ROOT, CALLER_ADDRESS, bytesToHex(USER_COMMITMENT));
    expect(deriveSignBidirectionalEventSignerEvmAddress(ROOT, record)).toBe(depositAddress);
    const other = deriveEvmAddress(ROOT, CALLER_ADDRESS, bytesToHex(pureCircuits.userCommitment(OTHER_SECRET)));
    expect(other).not.toBe(depositAddress);
  });

  it("encodes calldata exactly like ethers' transfer(vaultEvmAddress, amount)", async () => {
    const { ctx } = await requested();
    const [, record] = onlyRecord(ctx.callContext.currentQueryContext.state);
    const tx = signBidirectionalEventToUnsignedEvmTransaction(record);
    const expected = new Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [
      `0x${bytesToHex(VAULT_EVM)}`, AMOUNT,
    ]);
    expect(tx.data, "the recipient must be the pool's account, vaultEvmAddress").toBe(expected);
    expect(tx.to?.toLowerCase()).toBe(`0x${bytesToHex(USDC)}`.toLowerCase());
  });

  it("notifies the Signet contract with path [0] at depth 1", async () => {
    const r = await circuit("sendDeposit")(await deployInitialised(), AMOUNT, EVM_NONCE, MAX_FEE);
    const events = decodeSignetLogEvents((r.context as unknown as { events: never[] }).events, SIGNET_ADDRESS);
    expect(events, "signetSigner.signBidirectional(...) was not called").toHaveLength(1);
    const post = decodeSignBidirectionalEventNotificationPayload(events[0]!.payload);
    expect(requestIdHex(post.requestId)).toBe(requestIdHex(r.result as Uint8Array));
    expect(decodeSignBidirectionalNotification(post.event)).toEqual({
      version: 1, callerAddress: bytesToHex(CALLER_ADDRESS_BYTES), requestsPath: [0],
    });
  });

  it("records the height the contract knew at request time", async () => {
    const { ctx, requestId } = await requested();
    const heights = field<{ member(k: Uint8Array): boolean; lookup(k: Uint8Array): bigint }>(ctx, "heightAtRequest");
    expect(heights.member(requestId)).toBe(true);
    expect(heights.lookup(requestId)).toBe(0n);
  });

  it("refuses a max fee below the 1 gwei tip (the MPC would never sign it)", async () => {
    await expect(circuit("sendDeposit")(await deployInitialised(), AMOUNT, EVM_NONCE, 84n)).rejects.toThrow(/below the 1 gwei tip/);
  });

  it("refuses the same sweep twice, a zero amount, and a call before initialise", async () => {
    const { ctx } = await requested();
    await expect(circuit("sendDeposit")(ctx, AMOUNT, EVM_NONCE, MAX_FEE)).rejects.toThrow(/Request already sent/);
    await expect(circuit("sendDeposit")(await deployInitialised(), 0n, EVM_NONCE, MAX_FEE)).rejects.toThrow(/Amount must be positive/);
    await expect(circuit("sendDeposit")(await deploy(), AMOUNT, EVM_NONCE, MAX_FEE)).rejects.toThrow(/Not initialised/);
  });
});

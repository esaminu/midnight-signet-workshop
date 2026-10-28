import { describe, expect, it } from "vitest";

import {
  AMOUNT, asUser, attest, circuit, deploy, FAILURE, field, IMPOSTER_SECRET, MINT_NONCE, mints, OTHER_SECRET,
  OutputKind, POOL_TOKEN, requested, SUCCESS,
} from "./harness.ts";

type MapLike = { member(k: Uint8Array): boolean };

describe("part 2: completeDeposit (Settle)", () => {
  it("closes the request (finish TODO(part 2) if this fails)", async () => {
    const { ctx, requestId } = await requested();
    const next = (await circuit("completeDeposit")(ctx, attest(requestId, OutputKind.executed, SUCCESS), SUCCESS, MINT_NONCE)).context;
    expect(field<MapLike>(next, "bidirectionalDepositMap").member(requestId), "the request must be removed").toBe(false);
  });

  it("mints the deposited amount of the pool's private token on 'executed, success'", async () => {
    const { ctx, requestId } = await requested();
    const next = (await circuit("completeDeposit")(ctx, attest(requestId, OutputKind.executed, SUCCESS), SUCCESS, MINT_NONCE)).context;
    expect(mints(next).get(POOL_TOKEN), "mintShieldedToken(vaultTokenDomainSeparator(usdc()), amount, ...)").toBe(AMOUNT);
    expect(field(next, "globalLastSeen")).toBe(9_000_000n);
    expect(field<MapLike>(next, "heightAtRequest").member(requestId)).toBe(false);
  });

  it("rejects a signature from any other key", async () => {
    const { ctx, requestId } = await requested();
    const forged = attest(requestId, OutputKind.executed, SUCCESS, { secret: IMPOSTER_SECRET });
    await expect(circuit("completeDeposit")(ctx, forged, SUCCESS, MINT_NONCE)).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects output bytes the MPC did not sign", async () => {
    const { ctx, requestId } = await requested();
    await expect(
      circuit("completeDeposit")(ctx, attest(requestId, OutputKind.executed, FAILURE), SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("rejects success = false (the transfer returned false)", async () => {
    const { ctx, requestId } = await requested();
    await expect(
      circuit("completeDeposit")(ctx, attest(requestId, OutputKind.executed, FAILURE), FAILURE, MINT_NONCE),
    ).rejects.toThrow(/Remote transfer failed/);
  });

  it("closes a failed or unviable sweep and mints nothing (provided branch)", async () => {
    for (const kind of [OutputKind.failed, OutputKind.unviable]) {
      const { ctx, requestId } = await requested();
      const next = (await circuit("completeDeposit")(ctx, attest(requestId, kind, new Uint8Array(0)), SUCCESS, MINT_NONCE)).context;
      expect(field<MapLike>(next, "bidirectionalDepositMap").member(requestId)).toBe(false);
      expect(mints(next).get(POOL_TOKEN) ?? 0n).toBe(0n);
    }
  });

  it("rejects an attestation not above the height at request time", async () => {
    const { ctx, requestId } = await requested();
    await expect(
      circuit("completeDeposit")(ctx, attest(requestId, OutputKind.executed, SUCCESS, { blockHeight: 0n }), SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("cannot settle the same request twice", async () => {
    const { ctx, requestId } = await requested();
    const event = attest(requestId, OutputKind.executed, SUCCESS);
    const next = (await circuit("completeDeposit")(ctx, event, SUCCESS, MINT_NONCE)).context;
    await expect(circuit("completeDeposit")(next, event, SUCCESS, MINT_NONCE)).rejects.toThrow(/Request not found/);
  });

  it("only the depositor can settle their deposit", async () => {
    const { ctx, requestId } = await requested();
    const stranger = await asUser(ctx, OTHER_SECRET);
    await expect(
      circuit("completeDeposit")(stranger, attest(requestId, OutputKind.executed, SUCCESS), SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Not the depositor/);
  });

  it("rejects before initialise", async () => {
    const ctx = await deploy();
    const event = attest(new Uint8Array(32), OutputKind.executed, SUCCESS);
    await expect(circuit("completeDeposit")(ctx, event, SUCCESS, MINT_NONCE)).rejects.toThrow(/Not initialised/);
  });
});

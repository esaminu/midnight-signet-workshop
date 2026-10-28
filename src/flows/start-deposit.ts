import { type RequestIdHex, requestIdHex } from "@sig-net/midnight";

import { SWEEP_TIP } from "../lib/config.ts";
import type { Workshop } from "../lib/workshop.ts";

export interface Requested {
  requestId: RequestIdHex;
  /** Midnight block height just before the request: where to look for the MPC's answers. */
  fromBlock: number;
  evmNonce: bigint;
  amount: bigint;
  txId: string;
}

/** The max fee the sweep may pay per gas: about 2x the current fee, plus the circuit's 1 gwei tip. */
export async function sweepMaxFeePerGas(w: Workshop): Promise<bigint> {
  return 2n * ((await w.sepolia.getFeeData()).maxFeePerGas ?? 0n) + SWEEP_TIP;
}

export async function startDeposit(w: Workshop, contractAddress: string, amount: bigint): Promise<Requested> {
  const from = w.depositAddress(contractAddress);
  const evmNonce = BigInt(await w.sepolia.getTransactionCount(from, "pending"));
  const maxFeePerGas = await sweepMaxFeePerGas(w);
  const fromBlock = await w.midnightTip();
  const { result, txId } = await w.call("sendDeposit", amount, evmNonce, maxFeePerGas);
  return { requestId: requestIdHex(result), fromBlock, evmNonce, amount, txId };
}

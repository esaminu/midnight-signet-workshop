import type { RequestIdHex } from "@sig-net/midnight";
import { OutputKind } from "@sig-net/midnight";
import { formatEther, formatUnits } from "ethers";

import { broadcast } from "../flows/broadcast-evm.ts";
import { completeDeposit } from "../flows/complete-deposit.ts";
import { waitForSignature } from "../flows/poll-signature-response.ts";
import { waitForAttestation } from "../flows/poll-respond-bidirectional.ts";
import { startDeposit, sweepMaxFeePerGas } from "../flows/start-deposit.ts";
import { SWEEP_GAS_LIMIT, USDC_DECIMALS } from "./config.ts";
import { loadState, markDone, saveState, type State, type Step } from "./state.ts";
import { isTodo, todo } from "./todo.ts";
import type { Workshop } from "./workshop.ts";

export type Report = (step: Step, message: string) => void;

export async function fundingCheck(w: Workshop, contractAddress: string) {
  const address = w.depositAddress(contractAddress);
  const [{ eth, usdc }, maxFee] = await Promise.all([w.sepoliaBalances(address), sweepMaxFeePerGas(w)]);
  const gasNeeded = SWEEP_GAS_LIMIT * maxFee;
  return {
    address,
    eth,
    usdc,
    gasNeeded,
    ready: usdc > 0n && eth >= gasNeeded,
    summary: `${formatUnits(usdc, USDC_DECIMALS)} USDC, ${formatEther(eth)} ETH (gas needs ${formatEther(gasNeeded)} ETH)`,
  };
}

export function requirePart3(): void {
  for (const fn of [waitForSignature, broadcast]) {
    if (isTodo(fn)) todo(3, fn.name);
  }
}

export async function runDeposit(w: Workshop, contractAddress: string, amount: bigint | undefined, report: Report): Promise<State> {
  requirePart3();
  let state = loadState();
  if (state.sepoliaTxHash) {
    report("broadcast", "already broadcast");
    return state;
  }

  if (!state.requestId) {
    const funding = await fundingCheck(w, contractAddress);
    const sweep = amount ?? funding.usdc;
    if (sweep <= 0n) throw new Error(`nothing to deposit: ${funding.address} holds no USDC`);
    if (funding.usdc < sweep) throw new Error(`${funding.address} holds ${formatUnits(funding.usdc, USDC_DECIMALS)} USDC, less than ${formatUnits(sweep, USDC_DECIMALS)}`);
    if (funding.eth < funding.gasNeeded) {
      throw new Error(`${funding.address} needs ${formatEther(funding.gasNeeded)} ETH for gas, has ${formatEther(funding.eth)}`);
    }
    report("ask", `asking the MPC to sweep ${formatUnits(sweep, USDC_DECIMALS)} USDC from ${funding.address} (proving, about a minute)`);
    const r = await startDeposit(w, contractAddress, sweep);
    state = saveState({
      requestId: r.requestId, fromBlock: r.fromBlock, evmNonce: String(r.evmNonce), amount: String(r.amount), requestTxId: r.txId,
    });
    markDone("ask");
    report("ask", `request ${r.requestId} in Midnight tx ${r.txId}`);
  } else {
    report("ask", `request ${state.requestId} already made`);
  }

  const requestId = state.requestId as RequestIdHex;
  report("sign", "waiting for the MPC's signature (usually about 30 s)");
  const signed = await waitForSignature(w, contractAddress, requestId, state.fromBlock!);
  const expected = w.depositAddress(contractAddress);
  if (signed.from?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`signature recovers to ${signed.from}, not your deposit address ${expected}`);
  }
  saveState({ signatureVerified: true });
  markDone("sign");
  report("sign", `signature found; it recovers to your deposit address ${signed.from}`);

  const gas = signed.gasLimit * (signed.maxFeePerGas ?? 0n);
  const { eth } = await w.sepoliaBalances(expected);
  if (eth < gas) throw new Error(`${expected} needs ${formatEther(gas)} ETH for gas, has ${formatEther(eth)}; fund it and retry`);
  report("broadcast", "broadcasting the signed sweep to Sepolia");
  try {
    const hash = await broadcast(w, signed);
    state = saveState({ sepoliaTxHash: hash });
    markDone("broadcast");
    report("broadcast", "mined");
  } catch (e) {
    const receipt = (e as { receipt?: { hash?: string; status?: number } }).receipt;
    if (!receipt?.hash || receipt.status !== 0) throw e;
    state = saveState({ sepoliaTxHash: receipt.hash, sweepReverted: true });
    markDone("broadcast");
    report("broadcast", "mined but REVERTED (the MPC will attest it as failed)");
  }
  return state;
}

export async function runAttest(w: Workshop, contractAddress: string, report: Report): Promise<State> {
  let state = loadState();
  const requestId = state.requestId as RequestIdHex | undefined;
  if (!requestId || !state.sepoliaTxHash) throw new Error("no broadcast sweep to attest yet: deposit first");
  if (state.attestation) {
    report("attest", `already attested ${state.attestation.outputKind} at Sepolia block ${state.attestation.blockHeight}`);
    return state;
  }
  report("attest", "waiting for the MPC's attestation: it waits for Sepolia finality (about 18 minutes)");
  const attestation = await waitForAttestation(w, contractAddress, requestId, state.fromBlock!);
  const kind = OutputKind[attestation.event.outputKind];
  state = saveState({
    attestation: { outputKind: kind, blockHeight: String(attestation.event.blockHeight), succeeded: attestation.succeeded },
  });
  markDone("attest");
  report("attest", `attested ${kind}${attestation.succeeded ? ", transfer returned true" : ""} at Sepolia block ${attestation.event.blockHeight}`);
  return state;
}

export async function runComplete(w: Workshop, contractAddress: string, report: Report): Promise<State> {
  let state = loadState();
  const requestId = state.requestId as RequestIdHex | undefined;
  if (!requestId || !state.attestation) throw new Error("no attestation yet: wait for the MPC first");
  if (state.completeTxId) {
    report("settle", `already settled in Midnight tx ${state.completeTxId}`);
    return state;
  }
  const attestation = await waitForAttestation(w, contractAddress, requestId, state.fromBlock!);
  report("settle", attestation.succeeded ? "settling: minting your private tokens (proving, about a minute)" : "settling: closing the request, nothing to mint");
  const completeTxId = await completeDeposit(w, contractAddress, attestation);
  state = saveState({ completeTxId });
  markDone("settle");
  report("settle", `settled in Midnight tx ${completeTxId}`);
  return state;
}

export async function runSettle(w: Workshop, contractAddress: string, report: Report): Promise<State> {
  await runAttest(w, contractAddress, report);
  return runComplete(w, contractAddress, report);
}

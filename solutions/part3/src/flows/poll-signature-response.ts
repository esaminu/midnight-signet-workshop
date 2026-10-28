import {
  getSignetContractAddress,
  MidnightNetwork,
  type RequestIdHex,
  signetEventSourceFromIndexer,
  SignetRequestResponseReader,
} from "@sig-net/midnight";
import type { Transaction } from "ethers";

import { poll } from "../lib/poll.ts";
import { todo } from "../lib/todo.ts";
import type { Workshop } from "../lib/workshop.ts";

export function reader(w: Workshop, contractAddress: string, fromBlock: number): SignetRequestResponseReader {
  return new SignetRequestResponseReader({
    requesterContractAddress: contractAddress,
    requesterRequestsPath: [0],
    signetContractAddress: getSignetContractAddress(MidnightNetwork.Stagenet),
    publicDataProvider: w.publicDataProvider,
    eventSource: signetEventSourceFromIndexer({ queryUrl: w.indexerUrl }),
    signetEventsFromBlock: fromBlock,
  });
}

// ---- TODO(part 3a): wait for the verified signature. README section 3 -------
export async function waitForSignature(
  w: Workshop, contractAddress: string, requestId: RequestIdHex, fromBlock: number,
): Promise<Transaction> {
  const r = reader(w, contractAddress, fromBlock);
  return poll("MPC signature", () => r.getSignedEvmTransaction(requestId, w.depositAddress(contractAddress)));
}
// ---- end part 3a -------------------------------------------------------------

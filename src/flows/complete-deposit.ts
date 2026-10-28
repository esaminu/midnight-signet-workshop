import { respondBidirectionalEventToCircuitInput } from "@sig-net/midnight";

import type { Workshop } from "../lib/workshop.ts";
import type { Attestation } from "./poll-respond-bidirectional.ts";

export async function completeDeposit(w: Workshop, contractAddress: string, attestation: Attestation): Promise<string> {
  void contractAddress;
  const output = attestation.serializedOutput.length === 1 ? attestation.serializedOutput : new Uint8Array(1);
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  const { txId } = await w.call("completeDeposit", respondBidirectionalEventToCircuitInput(attestation.event), output, mintNonce);
  return txId;
}

import { OutputKind, type RequestIdHex, type RespondBidirectionalEvent } from "@sig-net/midnight";

import { responseKey } from "../lib/identity.ts";
import { poll } from "../lib/poll.ts";
import type { Workshop } from "../lib/workshop.ts";
import { reader } from "./poll-signature-response.ts";

export interface Attestation {
  event: RespondBidirectionalEvent;
  /** The bytes the MPC attested: 0x01 (transfer returned true), 0x00 (false) or empty (failed/unviable). */
  serializedOutput: Uint8Array;
  succeeded: boolean;
}

export const TRANSFER_SUCCEEDED = Uint8Array.of(1);
export const TRANSFER_RETURNED_FALSE = Uint8Array.of(0);
export const EMPTY_OUTPUT = new Uint8Array(0);

export async function waitForAttestation(
  w: Workshop, contractAddress: string, requestId: RequestIdHex, fromBlock: number,
): Promise<Attestation> {
  const r = reader(w, contractAddress, fromBlock);
  const key = responseKey(contractAddress);
  return poll("MPC attestation", async () => {
    for (const serializedOutput of [TRANSFER_SUCCEEDED, TRANSFER_RETURNED_FALSE, EMPTY_OUTPUT]) {
      const event = await r.getVerifiedRespondBidirectionalEvent(requestId, serializedOutput, key);
      if (event) {
        const succeeded = event.outputKind === OutputKind.executed && serializedOutput === TRANSFER_SUCCEEDED;
        return { event, serializedOutput, succeeded };
      }
    }
    return undefined;
  });
}

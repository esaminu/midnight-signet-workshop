import type { Transaction } from "ethers";

import { todo } from "../lib/todo.ts";
import type { Workshop } from "../lib/workshop.ts";

// ---- TODO(part 3b): broadcast. README section 3 -----------------------------------
export async function broadcast(w: Workshop, signed: Transaction): Promise<string> {
  const sent = await w.sepolia.broadcastTransaction(signed.serialized);
  await sent.wait();
  return sent.hash;
}
// ---- end part 3b -------------------------------------------------------------------

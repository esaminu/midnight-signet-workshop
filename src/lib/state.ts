import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STATE_FILE = fileURLToPath(new URL("../../state.json", import.meta.url));

export type Step = "ask" | "sign" | "broadcast" | "attest" | "settle";

export interface State {
  contractAddress?: string;
  deployTxId?: string;
  initialised?: boolean;
  depositAddress?: string;
  vaultEvmAddress?: string;
  requestId?: string;
  requestTxId?: string;
  fromBlock?: number;
  evmNonce?: string;
  amount?: string;
  signatureVerified?: boolean;
  sepoliaTxHash?: string;
  sweepReverted?: boolean;
  attestation?: { outputKind: string; blockHeight: string; succeeded: boolean };
  completeTxId?: string;
  finishedAt?: Partial<Record<Step, string>>;
  error?: string;
}

export function loadState(): State {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : {};
}

export function saveState(update: Partial<State>): State {
  const next = { ...loadState(), ...update };
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function markDone(step: Step): State {
  const s = loadState();
  return saveState({ finishedAt: { ...s.finishedAt, [step]: new Date().toISOString() }, error: undefined });
}

export function need<K extends keyof State>(state: State, key: K, step: string): NonNullable<State[K]> {
  const value = state[key];
  if (value === undefined || value === null) {
    throw new Error(`state.json has no ${key}: run \`${step}\` first`);
  }
  return value as NonNullable<State[K]>;
}

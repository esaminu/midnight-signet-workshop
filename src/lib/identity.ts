import { rawTokenType } from "@midnight-ntwrk/compact-runtime";
import {
  asciiPadded,
  bytesToHex,
  deriveEvmAddress,
  deriveMidnightResponseKey,
  getMpcRootPublicKey,
  hexToBytes,
  MidnightNetwork,
  type Secp256k1Point,
} from "@sig-net/midnight";
import { fileURLToPath } from "node:url";

import { SEPOLIA_USDC } from "./config.ts";

export const MANAGED = fileURLToPath(
  new URL(`../../${process.env.WORKSHOP_MANAGED ?? "contract/managed"}/workshop`, import.meta.url),
);

type Generated = typeof import("../../contract/managed/workshop/contract/index.js");
export const generated = (await import(`${MANAGED}/contract/index.js`)) as Generated;
export const { Contract, ledger, pureCircuits } = generated;

export interface PrivateState {
  readonly secretKey: Uint8Array;
}
export const PRIVATE_STATE_ID = "workshop" as const;

export const witnesses = {
  callerSecretKey: ({ privateState }: { privateState: PrivateState }): [PrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};

export const MPC_ROOT = getMpcRootPublicKey(MidnightNetwork.Stagenet);

export function userCommitment(secretKey: Uint8Array): Uint8Array {
  return pureCircuits.userCommitment(secretKey);
}

export function depositAddress(contractAddress: string, secretKey: Uint8Array): string {
  return deriveEvmAddress(MPC_ROOT, contractAddress, bytesToHex(userCommitment(secretKey)));
}

export function vaultEvmAddress(contractAddress: string): string {
  return deriveEvmAddress(MPC_ROOT, contractAddress, bytesToHex(asciiPadded("vault", 32)));
}

export function responseKey(contractAddress: string): Secp256k1Point {
  return deriveMidnightResponseKey(MPC_ROOT, contractAddress);
}

export function poolTokenType(contractAddress: string): string {
  return rawTokenType(pureCircuits.vaultTokenDomainSeparator(hexToBytes(SEPOLIA_USDC)), contractAddress);
}

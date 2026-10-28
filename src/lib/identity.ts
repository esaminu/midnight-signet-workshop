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

/** Compiler output: `yarn compile` (with proving keys) or `yarn test` (contract/managed-test). */
export const MANAGED = fileURLToPath(
  new URL(`../../${process.env.WORKSHOP_MANAGED ?? "contract/managed"}/workshop`, import.meta.url),
);

type Generated = typeof import("../../contract/managed/workshop/contract/index.js");
export const generated = (await import(`${MANAGED}/contract/index.js`)) as Generated;
export const { Contract, ledger, pureCircuits } = generated;

/** Private state carried through circuit calls: your identity secret. */
export interface PrivateState {
  readonly secretKey: Uint8Array;
}
export const PRIVATE_STATE_ID = "workshop" as const;

/** The witness: callerSecretKey() reads the secret from private state. */
export const witnesses = {
  callerSecretKey: ({ privateState }: { privateState: PrivateState }): [PrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};

/** The MPC root key for stagenet. Every key below is derived from it. */
export const MPC_ROOT = getMpcRootPublicKey(MidnightNetwork.Stagenet);

/** Your identity commitment: the only form of your secret that reaches the ledger. */
export function userCommitment(secretKey: Uint8Array): Uint8Array {
  return pureCircuits.userCommitment(secretKey);
}

/**
 * Your deposit address: root key + the contract + your commitment as the path.
 * The MPC renders the 32 path bytes as full lowercase hex, so we do too.
 */
export function depositAddress(contractAddress: string, secretKey: Uint8Array): string {
  return deriveEvmAddress(MPC_ROOT, contractAddress, bytesToHex(userCommitment(secretKey)));
}

/** The pool's own account: the fixed path "vault". Nobody holds its key either. */
export function vaultEvmAddress(contractAddress: string): string {
  return deriveEvmAddress(MPC_ROOT, contractAddress, bytesToHex(asciiPadded("vault", 32)));
}

/** The key the MPC signs results with, for THIS contract only. initialise pins it. */
export function responseKey(contractAddress: string): Secp256k1Point {
  return deriveMidnightResponseKey(MPC_ROOT, contractAddress);
}

/** The colour of the private token the pool mints for USDC. */
export function poolTokenType(contractAddress: string): string {
  return rawTokenType(pureCircuits.vaultTokenDomainSeparator(hexToBytes(SEPOLIA_USDC)), contractAddress);
}

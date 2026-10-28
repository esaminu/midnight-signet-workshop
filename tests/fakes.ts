import type { Workshop } from "../src/lib/workshop.ts";

export const CONTRACT = "ab".repeat(32);
export const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000000dd";

export function fakeWorkshop(overrides: Partial<Record<keyof Workshop, unknown>> = {}) {
  const calls: { circuit: string; args: unknown[] }[] = [];
  const w = {
    indexerUrl: "https://indexer.test/api/v4/graphql",
    publicDataProvider: { queryContractState: async () => null },
    commitmentHex: "cc".repeat(32),
    depositAddress: () => DEPOSIT_ADDRESS,
    sepolia: {
      getTransactionCount: async () => 0,
      getFeeData: async () => ({ maxFeePerGas: 84n, maxPriorityFeePerGas: 2n, gasPrice: null }),
    },
    async call(circuit: string, ...args: unknown[]) {
      calls.push({ circuit, args });
      return { result: new Uint8Array(32).fill(0xcd), txId: "tx-1", blockHeight: 100 };
    },
    async midnightTip() {
      return 1234;
    },
    ...overrides,
  } as unknown as Workshop;
  return { w, calls };
}

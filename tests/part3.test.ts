import { getSignetContractAddress, MidnightNetwork } from "@sig-net/midnight";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  signerAsked: [] as string[],
  sourceConfig: undefined as unknown,
  attempts: 0,
}));

vi.mock("@sig-net/midnight", async (importOriginal) => {
  const real = await importOriginal<typeof import("@sig-net/midnight")>();
  return {
    ...real,
    signetEventSourceFromIndexer: (config: unknown) => {
      seen.sourceConfig = config;
      return { marker: "event-source" };
    },
    SignetRequestResponseReader: class {
      constructor(config: Record<string, unknown>) {
        seen.configs.push(config);
      }
      async getSignedEvmTransaction(_id: string, signer: string) {
        seen.signerAsked.push(signer);
        return ++seen.attempts < 2 ? undefined : { serialized: "0xsigned" };
      }
    },
  };
});

process.env.WORKSHOP_POLL_MS = "1";
const { waitForSignature } = await import("../src/flows/poll-signature-response.ts");
const { broadcast } = await import("../src/flows/broadcast-evm.ts");
const { CONTRACT, DEPOSIT_ADDRESS, fakeWorkshop } = await import("./fakes.ts");

beforeEach(() => {
  seen.configs.length = 0;
  seen.signerAsked.length = 0;
  seen.attempts = 0;
});

describe("part 3a: waitForSignature (Sign)", () => {
  it("reads your request from field [0] and the MPC's posts from the stagenet Signet contract, from fromBlock", async () => {
    const { w } = fakeWorkshop();
    await waitForSignature(w, CONTRACT, "ee".repeat(32) as never, 777);
    expect(seen.configs[0]).toMatchObject({
      requesterContractAddress: CONTRACT,
      requesterRequestsPath: [0],
      signetContractAddress: getSignetContractAddress(MidnightNetwork.Stagenet),
      signetEventsFromBlock: 777,
      eventSource: { marker: "event-source" },
    });
    expect(seen.sourceConfig).toEqual({ queryUrl: w.indexerUrl });
  });

  it("only accepts a signature from YOUR deposit address, and polls until it appears", async () => {
    const { w } = fakeWorkshop();
    const signed = await waitForSignature(w, CONTRACT, "ee".repeat(32) as never, 777);
    expect(signed).toEqual({ serialized: "0xsigned" });
    expect(seen.signerAsked, "pass w.depositAddress(contractAddress) as the expected signer").toEqual([DEPOSIT_ADDRESS, DEPOSIT_ADDRESS]);
  });
});

describe("part 3b: broadcast (Broadcast)", () => {
  it("sends the serialized signed transaction and waits for it to be mined", async () => {
    let waited = false;
    const sent: string[] = [];
    const { w } = fakeWorkshop({
      sepolia: {
        broadcastTransaction: async (raw: string) => {
          sent.push(raw);
          return { hash: "0xhash", wait: async () => { waited = true; } };
        },
      },
    });
    expect(await broadcast(w, { serialized: "0xsigned" } as never)).toBe("0xhash");
    expect(sent).toEqual(["0xsigned"]);
    expect(waited, "await the transaction's wait()").toBe(true);
  });
});

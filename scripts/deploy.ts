import { hexToBytes } from "@sig-net/midnight";

import { responseKey, vaultEvmAddress } from "../src/lib/identity.ts";
import { loadState, saveState } from "../src/lib/state.ts";
import { withWorkshop } from "../src/lib/workshop.ts";

let state = loadState();
await withWorkshop(state.contractAddress, async (w) => {
  if (!state.contractAddress) {
    const { contractAddress, txId } = await w.deploy();
    state = saveState({ contractAddress, deployTxId: txId });
  } else {
    console.log(`contract already deployed: ${state.contractAddress}`);
  }
  const contract = state.contractAddress!;
  const vault = vaultEvmAddress(contract);
  if (!state.initialised) {
    try {
      await w.call("initialise", hexToBytes(vault), responseKey(contract));
    } catch (e) {
      if (!String(e).includes("Already initialised")) throw e;
    }
    state = saveState({ initialised: true });
  } else {
    console.log("already initialised");
  }
  state = saveState({ vaultEvmAddress: vault, depositAddress: w.depositAddress(contract) });
});

console.log(`
Contract:         ${state.contractAddress}
Pool account:     ${state.vaultEvmAddress}  (path "vault")
Deposit address:  ${state.depositAddress}  (path: your commitment)
                  https://sepolia.etherscan.io/address/${state.depositAddress}

Next: yarn dev
`);
process.exit(0);

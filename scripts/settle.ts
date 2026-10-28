import { formatUnits } from "ethers";

import { USDC_DECIMALS } from "../src/lib/config.ts";
import { runSettle } from "../src/lib/deposit-run.ts";
import { loadState, need } from "../src/lib/state.ts";
import { withWorkshop } from "../src/lib/workshop.ts";

const state = loadState();
const contractAddress = need(state, "contractAddress", "yarn deploy");
need(state, "sepoliaTxHash", "yarn deposit");

await withWorkshop(contractAddress, async (w) => {
  const s = await runSettle(w, contractAddress, (step, msg) => console.log(`[${step}] ${msg}`));
  console.log(`\nSettled in Midnight tx ${s.completeTxId}.`);
  const balance = await w.shieldedBalance(contractAddress);
  console.log(`Your private balance: ${formatUnits(balance, USDC_DECIMALS)} pool USDC`);
});
process.exit(0);

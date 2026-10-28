import { formatUnits, parseUnits } from "ethers";

import { USDC_DECIMALS } from "../src/lib/config.ts";
import { runDeposit } from "../src/lib/deposit-run.ts";
import { loadState, need } from "../src/lib/state.ts";
import { withWorkshop } from "../src/lib/workshop.ts";

const state = loadState();
const contractAddress = need(state, "contractAddress", "yarn deploy");
const amount = process.argv[2] ? parseUnits(process.argv[2], USDC_DECIMALS) : undefined;

const code = await withWorkshop(contractAddress, async (w) => {
  const result = await runDeposit(w, contractAddress, amount, (step, msg) => console.log(`[${step}] ${msg}`));
  if (result.sepoliaTxHash) {
    console.log(`\nBroadcast: https://sepolia.etherscan.io/tx/${result.sepoliaTxHash}`);
    console.log(`Swept ${formatUnits(result.amount!, USDC_DECIMALS)} USDC into the pool. The MPC attests in about 18 minutes: yarn settle`);
    return 0;
  }
  return 1;
});
process.exit(code);

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  deriveAccountKeys,
  deriveAddresses,
  ensureFeeReady,
  formatDust,
  generateHexSeed,
  getFaucetUrl,
} from "@sig-net/midnight-contract-deploy";

import { loadConfig } from "../src/lib/config.ts";
import { withSyncedWallet } from "../src/lib/wallet.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const quick = process.argv.includes("--quick");
let failed = 0;

async function check(name: string, run: () => Promise<string> | string): Promise<void> {
  try {
    console.log(`  ok    ${name}: ${await run()}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" }).trim();
const post = async (url: string, body: unknown) => {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as Record<string, any>;
};

console.log("Tools");
await check("node >= 22", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`found ${process.version}: install Node 22 or newer`);
  return process.version;
});
await check("docker", () => sh("docker", ["--version"]));
await check("compact 0.33.0-rc.2", () => {
  const v = sh("compact", ["compile", "+0.33.0-rc.2", "--version"]);
  if (!v.includes("0.33.0")) throw new Error(`got "${v}": see README setup step 3 (the rc compiler zip goes under ~/.compact/versions/0.33.0-rc.2/<platform>/)`);
  return `compiler ${v}`;
});
await check("node_modules", () => {
  const pkg = `${ROOT}/node_modules/@sig-net/midnight/package.json`;
  if (!existsSync(pkg)) throw new Error("run `yarn install`");
  return `@sig-net/midnight ${(JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version}`;
});
await check("proof server on 127.0.0.1:6300", async () => {
  const res = await fetch("http://127.0.0.1:6300/version", { signal: AbortSignal.timeout(5_000) }).catch(() => {
    throw new Error("not reachable: run `docker compose up -d` and wait ~10s");
  });
  return `version ${await res.text()}`;
});

console.log("\nSettings (.env)");
const envFile = `${ROOT}/.env`;
if (!existsSync(envFile)) {
  copyFileSync(`${ROOT}/.env.example`, envFile);
  writeFileSync(envFile, readFileSync(envFile, "utf8").replace(/^WALLET_SEED=$/m, `WALLET_SEED=${generateHexSeed()}`));
  console.log("  new   created .env with a fresh WALLET_SEED (test funds only)");
  process.loadEnvFile(envFile);
}
const config = loadConfig();
await check("WALLET_SEED", () => {
  if (!config.seed) throw new Error("empty in .env");
  return "set (your identity secret is derived from it)";
});

console.log("\nNetworks");
await check("stagenet indexer", async () => {
  const r = await post(config.midnight.indexerUrl, { query: "{ block { height } }" });
  return `block ${r.data.block.height} (${config.midnight.indexerUrl})`;
});
await check("Sepolia RPC", async () => {
  const r = await post(config.sepoliaRpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  if (r.result !== "0xaa36a7") throw new Error(`chain ${r.result}, expected Sepolia 0xaa36a7`);
  return config.sepoliaRpcUrl;
});

if (config.seed && !quick) {
  console.log("\nWallet (the first sync takes 10 to 20 minutes; later runs resume from .wallet-cache)");
  const { networkId } = config.midnight;
  const keys = deriveAccountKeys(config.seed, networkId);
  const faucet = getFaucetUrl(process.env, networkId);
  console.log(`  unshielded address: ${deriveAddresses(keys, networkId).unshielded}`);
  await check("NIGHT + DUST", () =>
    withSyncedWallet(config.seed!, keys, config.midnight, async (facade, state) => {
      const night = Object.values(state.unshielded.balances).reduce((a: bigint, b) => a + (b as bigint), 0n);
      if (night === 0n) throw new Error(`no NIGHT: paste the unshielded address above into ${faucet}, then rerun`);
      const dust = await ensureFeeReady(facade, keys, state, networkId, faucet);
      return `NIGHT ${night}, DUST ${formatDust(dust)}`;
    }),
  );
}

console.log(failed ? `\n${failed} check(s) failed. Fix them top to bottom.` : "\nAll good. Next: yarn test 1");
process.exit(failed ? 1 : 0);

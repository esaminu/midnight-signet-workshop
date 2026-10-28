import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { formatEther, formatUnits } from "ethers";
import QRCode from "qrcode";

import { loadConfig, USDC_DECIMALS } from "../lib/config.ts";
import { fundingCheck, type Report, runAttest, runComplete, runDeposit } from "../lib/deposit-run.ts";
import { loadState, saveState, type State, type Step } from "../lib/state.ts";
import { openWorkshop } from "../lib/workshop.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PAGE = `${ROOT}src/app/index.html`;
const STEPS: Step[] = ["ask", "sign", "broadcast", "attest", "settle"];

const config = loadConfig();
const initial = loadState();
const contractAddress = initial.contractAddress;
const { w } = openWorkshop(contractAddress);

interface Live {
  running: Step | null;
  message: Partial<Record<Step, string>>;
  privateBalance: string | null;
  funding: Awaited<ReturnType<typeof fundingCheck>> | null;
  walletReady: boolean;
  walletError: string | null;
}
const live: Live = { running: null, message: {}, privateBalance: null, funding: null, walletReady: false, walletError: null };
const clients = new Set<ServerResponse>();
let qrSvg = "";

function snapshot() {
  const s: State = loadState();
  const steps = Object.fromEntries(
    STEPS.map((step) => {
      const done = s.finishedAt?.[step];
      const status = done ? "done" : live.running === step ? "running" : s.error && lastStarted(s) === step ? "error" : "todo";
      return [step, { status, at: done ?? null, message: live.message[step] ?? null }];
    }),
  );
  return {
    contractAddress: s.contractAddress ?? null,
    depositAddress: s.depositAddress ?? null,
    vaultEvmAddress: s.vaultEvmAddress ?? null,
    qrSvg,
    funding: live.funding && {
      eth: formatEther(live.funding.eth),
      usdc: formatUnits(live.funding.usdc, USDC_DECIMALS),
      gasNeeded: formatEther(live.funding.gasNeeded),
      ready: live.funding.ready,
    },
    amount: s.amount ? formatUnits(BigInt(s.amount), USDC_DECIMALS) : null,
    requestId: s.requestId ?? null,
    requestTxId: s.requestTxId ?? null,
    sepoliaTxHash: s.sepoliaTxHash ?? null,
    attestation: s.attestation ?? null,
    completeTxId: s.completeTxId ?? null,
    steps,
    running: live.running,
    error: s.error ?? null,
    privateBalance: live.privateBalance,
    walletReady: live.walletReady,
    walletError: live.walletError,
  };
}

function lastStarted(s: State): Step | undefined {
  return STEPS.find((step) => !s.finishedAt?.[step]);
}

function broadcastState(): void {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
}

const report: Report = (step, message) => {
  live.running = step;
  live.message[step] = message;
  console.log(`[${step}] ${message}`);
  broadcastState();
};

async function background(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (live.running) return;
  saveState({ error: undefined });
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${name} failed: ${msg}`);
    saveState({ error: msg });
  } finally {
    live.running = null;
    broadcastState();
    void refreshBalances();
  }
}

async function refreshBalances(): Promise<void> {
  if (!contractAddress) return;
  try {
    live.funding = await fundingCheck(w, contractAddress);
  } catch (e) {
    console.error(`Sepolia balance check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (live.walletReady) {
    try {
      live.privateBalance = formatUnits(await w.shieldedBalance(contractAddress), USDC_DECIMALS);
    } catch (e) {
      console.error(`private balance read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  broadcastState();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(PAGE, "utf8"));
  } else if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
    const file = `${ROOT}src/app/fonts/${url.pathname.slice("/fonts/".length).replace(/[^a-z0-9.-]/gi, "")}`;
    if (!existsSync(file)) return void json(res, 404, { error: "no such font" });
    res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=86400" });
    createReadStream(file).pipe(res);
  } else if (req.method === "GET" && url.pathname === "/api/state") {
    json(res, 200, snapshot());
  } else if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  } else if (req.method === "POST" && url.pathname === "/api/deposit") {
    if (!contractAddress) return void json(res, 409, { error: "no contract yet: run `yarn deploy`, then restart `yarn dev`" });
    if (live.running) return void json(res, 409, { error: `busy: ${live.running}` });
    void background("deposit", async () => {
      await runDeposit(w, contractAddress, undefined, report);
      await runAttest(w, contractAddress, report);
    });
    json(res, 202, { started: true });
  } else if (req.method === "POST" && url.pathname === "/api/complete") {
    if (!contractAddress) return void json(res, 409, { error: "no contract yet" });
    if (live.running) return void json(res, 409, { error: `busy: ${live.running}` });
    void background("complete", () => runComplete(w, contractAddress, report));
    json(res, 202, { started: true });
  } else if (req.method === "POST" && url.pathname === "/api/retry") {
    if (!contractAddress || live.running) return void json(res, 409, { error: "busy or no contract" });
    const s = loadState();
    void background("retry", async () => {
      if (!s.sepoliaTxHash) await runDeposit(w, contractAddress, undefined, report);
      if (!loadState().attestation) await runAttest(w, contractAddress, report);
    });
    json(res, 202, { started: true });
  } else {
    json(res, 404, { error: "not found" });
  }
}

process.on("unhandledRejection", (e) => console.error(`unhandled: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
process.on("uncaughtException", (e) => console.error(`uncaught: ${e.stack ?? e.message}`));
if (initial.depositAddress) qrSvg = await QRCode.toString(initial.depositAddress, { type: "svg", margin: 1 });

const server = createServer(handle);
server.listen(config.appPort, "127.0.0.1", () => {
  console.log(`\nWorkshop app: http://localhost:${config.appPort}\n`);
  if (!contractAddress) console.log("No contract in state.json yet: run `yarn deploy`, then restart `yarn dev`.");
});

void (async () => {
  try {
    await w.openWallet();
    live.walletReady = true;
    console.log("wallet ready");
  } catch (e) {
    live.walletError = e instanceof Error ? e.message : String(e);
    console.error(`wallet: ${live.walletError}`);
  }
  await refreshBalances();
  const s = loadState();
  if (contractAddress && s.sepoliaTxHash && !s.attestation && !live.running) {
    void background("attest", () => runAttest(w, contractAddress, report));
  }
})();
setInterval(() => void refreshBalances(), 15_000);

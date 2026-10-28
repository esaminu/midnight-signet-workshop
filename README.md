# Build a privacy pool

### Sig.Network × Midnight hands-on

You will write a Midnight contract that owns Ethereum accounts nobody holds a key for.
You send Sepolia USDC to **your own deposit address**, your contract asks the Sig.Network
MPC to sweep it into the pool, and when the MPC attests the sweep, your contract gives you
**private tokens** on Midnight. This workshop does deposit only. For the fully implemented,
audited vault contract, with withdraw, swap, lend and more, see
[sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).

One deposit is one pass through five steps:

| Step | Who | What happens | Where you write it |
| --- | --- | --- | --- |
| **1 Ask** | your contract | builds the sweep, stores it in your ledger, notifies the Signet contract | part 1, `sendDeposit` |
| **2 Sign** | the MPC | reads the sweep from your ledger, posts a signature | you wait for it in part 3 |
| **3 Broadcast** | anyone | sends the signed sweep to Sepolia | part 3 |
| **4 Attest** | the MPC | watches Sepolia, posts a signed result once the sweep is final | provided |
| **5 Settle** | your contract | verifies the result, mints your private tokens | part 2, `completeDeposit` |

You write three pieces, about 40 lines: **Ask** and **Settle** in Compact, **wait and
broadcast** in TypeScript. Everything else is provided. Each place you write is marked
`TODO(part N)` in the code, every part has offline tests, and the finished files are in
`solutions/partN/` if you get stuck.

Networks: Midnight **stagenet** and Ethereum **Sepolia**.

---

## 0. Setup

The wallet sync and the Docker image are slow. Start them first, with a good connection, and
read on while they run.

**1. Node 22 or newer**

```sh
node --version
```

It must print v22 or newer.

**2. Docker**, with at least 8 GB of memory, then the proof server image:

```sh
docker pull midnightntwrk/proof-server:9.0.0-rc.5_experimental
```

**3. The Compact compiler, version 0.33.0-rc.2 exactly**

First the `compact` launcher, which manages compiler versions:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
source "$HOME/.local/bin/env"
compact --version
```

It prints `compact 0.5.x`.

Then the compiler itself. Version 0.33.0-rc.2 is a prerelease the launcher cannot
download on its own, so place it where the launcher looks:

```sh
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  P=aarch64-darwin ;;
  Darwin-x86_64) P=x86_64-darwin ;;
  Linux-aarch64) P=aarch64-unknown-linux-musl ;;
  Linux-x86_64)  P=x86_64-unknown-linux-musl ;;
esac
RC_DIR="$HOME/.compact/versions/0.33.0-rc.2/$P"
mkdir -p "$RC_DIR"
curl -fsSL -o /tmp/compactc-rc.zip "https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v0.33.0-rc.2/compactc_v0.33.0-rc.2_$P.zip"
unzip -qo /tmp/compactc-rc.zip -d "$RC_DIR" && chmod +x "$RC_DIR"/*
compact compile +0.33.0-rc.2 --version
```

The last command prints `0.33.0`.

**4. Clone and install**

```sh
git clone https://github.com/esaminu/midnight-signet-workshop.git
cd midnight-signet-workshop
corepack enable
yarn install
```

**5. Start the proof server**

```sh
docker compose up -d
until curl -sf http://127.0.0.1:6300/version; do sleep 2; done; echo
```

The server takes about ten seconds to come up; the loop waits for it and then prints `9.0.0-rc.5`.

**6. Your Midnight wallet**

```sh
yarn doctor
```

The first run creates `.env` with a fresh `WALLET_SEED` and prints your unshielded address.
If you were given a pre-funded seed, put it in `.env` as `WALLET_SEED=` first.

Otherwise paste the printed address into the
[stagenet faucet](https://faucet.stagenet.shielded.tools), then run `yarn doctor` again. It
syncs the wallet (**10 to 20 minutes, once**; later runs take seconds), registers your NIGHT
so it generates DUST, the fee token, and waits for DUST. Every line must say `ok`.

**7. MetaMask on Sepolia**

You need **Sepolia USDC** ([faucet.circle.com](https://faucet.circle.com), pick Ethereum
Sepolia) and some **Sepolia ETH** (any Sepolia faucet; 0.01 ETH is plenty: two sends plus the
sweep's gas).

When `yarn doctor` is all `ok`, run the tests once to see what you are about to make pass:

```sh
yarn test 1
```

---

## 1. Ask: `sendDeposit`

Your contract builds the exact Ethereum transaction the MPC will sign:
`transfer(vaultEvmAddress, amount)` on USDC, sent from your deposit account. It stores the
request in its own ledger and tells the Signet contract where to find it. The MPC reads the
request from **your** ledger, never from the event.

Open `contract/workshop.compact`. Inside `sendDeposit`, replace everything between
`TODO(part 1)` and `end part 1` with:

```ts
const calldata = EvmCalldata<2> {
  selector: Bytes[0xa9, 0x05, 0x9c, 0xbb],
  noWords: 2 as Uint<16>,
  words: [evmAddressAbiWord(vaultEvmAddress), numericAbiWord(amount)]
};
const request = constructSignBidirectionalEventV1<EvmType2TxParams<2, 0, 0>, 34>(
  mpcKeyVersion(), kernel.self(), userCommitment(callerSecretKey()),
  MPCSignatureAlgorithm.ecdsa, TxParamType.evmType2, sweepTxParams(calldata, evmNonce, maxFeePerGas),
  ethereumCaip2Id(), MPCDestination.unused, pad(64, ""), vaultOutputSchema()
);
const requestId = disclose(calculateEvmType2RequestIdV1<2, 0, 0, 34>(request));
assert(!bidirectionalDepositMap.member(requestId), "Request already sent");
bidirectionalDepositMap.insert(requestId, disclose(request));
heightAtRequest.insert(requestId, globalLastSeen);
signetSigner.signBidirectional(
  requestId,
  constructSignBidirectionalEventNotificationV1(kernel.self(), 1 as Uint<8>, [0, 0, 0, 0] as Vector<4, Uint<8>>)
);
return requestId;
```

The path `userCommitment(callerSecretKey())` is what makes the account *yours*: same secret,
same commitment, same Ethereum address. The notification only says "field 0, depth 1": where
your map is.

```sh
yarn test 1
```

Expected:

```
✓ tests/part1.test.ts (10 tests)
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

> **Stuck?** `yarn finish 1` puts the finished file in place (yours goes to `.finish-backup/`).
> Then carry on from the next command.

---

## 2. Settle: `completeDeposit`, then deploy

About eighteen minutes after the sweep, the MPC posts a signed result: executed, failed or
unviable. Anyone can post on the Signet contract, so your circuit checks the signature
itself, inside the proof, before it mints. The failed and unviable cases close the request
and mint nothing: `settleRequest` does that for every verdict, so you write only the executed
path.

In `completeDeposit`, replace everything between `TODO(part 2)` and `end part 2` with:

```ts
assert(verifyRespondBidirectionalAttestationV1(disclose(response), mpcResponseKey), "Invalid attestation signature");
const request = settleRequest(response);
if (disclose(response.outputKind) == OutputKind.executed) {
  assert(verifyAttestedOutputV1<1>(disclose(serializedOutput), response.serializedOutputLength, response.outputHash),
         "Output does not match the attestation");
  assert(deserialize<VaultResponse, 1>(serializedOutput).success, "Remote transfer failed");
  mintShieldedToken(vaultTokenDomainSeparator(usdc()), depositAmount(request), disclose(mintNonce),
                    left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey()));
}
```

```sh
yarn test 2
```

Expected:

```
✓ tests/part2.test.ts (10 tests)
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### Compile with proving keys and deploy

```sh
yarn compile
yarn deploy
```

Compiling takes about a minute. Deploy runs the deployment and `initialise`, about two minutes.

Expected:

```
deployed <contract address> in 25s
calling initialise: proving + submitting (about a minute)...

Contract:         <64 hex chars>
Pool account:     0x…  (path "vault")
Deposit address:  0x…  (path: your commitment)
                  https://sepolia.etherscan.io/address/0x…

Next: yarn dev
```

### Start the app and fund your deposit address

```sh
yarn dev
```

Open http://localhost:4173. The page shows your deposit address as a QR code, with a copy
button, and its USDC and ETH balances. **From MetaMask, send it 1 Sepolia USDC and 0.001
Sepolia ETH.** Two sends; scan the QR code with mobile MetaMask or paste the address. This is
not the deposit yet: the USDC only sits on your deposit address until step 4, when your
contract sweeps it into the pool. The ETH pays the sweep's gas: the deposit account is the
sender, and nobody else can pay for it.

Leave the app running and write part 3 while the sends confirm. The page shows the balances
arriving, and it reloads on its own when you save a file.

> **Stuck?** `yarn finish 2` puts the finished file in place (yours goes to `.finish-backup/`).
> Then carry on from the next command.

---

## 3. Wait for the signature, then broadcast

The MPC posts its signature in public on the Signet contract. Your app waits for a post whose
signature recovers to your deposit address, rebuilds the signed transaction from **your**
stored request, and broadcasts it. The MPC never broadcasts.

Open `src/flows/poll-signature-response.ts`. Replace the `TODO(part 3a)` block with:

```ts
export async function waitForSignature(
  w: Workshop, contractAddress: string, requestId: RequestIdHex, fromBlock: number,
): Promise<Transaction> {
  const r = reader(w, contractAddress, fromBlock);
  return poll("MPC signature", () => r.getSignedEvmTransaction(requestId, w.depositAddress(contractAddress)));
}
```

Open `src/flows/broadcast-evm.ts`. Replace the `TODO(part 3b)` block with:

```ts
export async function broadcast(w: Workshop, signed: Transaction): Promise<string> {
  const sent = await w.sepolia.broadcastTransaction(signed.serialized);
  await sent.wait();
  return sent.hash;
}
```

```sh
yarn test 3
```

Expected:

```
MPC signature: found after 0s
✓ tests/part3.test.ts (3 tests)
```

> **Stuck?** `yarn finish 3` puts the finished files in place (yours go to `.finish-backup/`).
> Then carry on from the next command.

---

## 4. Deposit

Back in the app at http://localhost:4173 (if you stopped it, `yarn dev` again). It says
**ready to deposit** once the USDC and the ETH have arrived. Now the deposit itself: click
**Deposit**, and your contract asks the MPC to sweep the USDC from your deposit address into
the pool. Watch the steps:

- **Ask**: one Midnight transaction with two proofs (yours and the Signet contract's), about
  a minute.
- **Sign**: the MPC's signature appears, usually within 30 seconds. The app checks that it
  recovers to your deposit address.
- **Broadcast**: the sweep is sent to Sepolia. Open the Etherscan link: your USDC moves from
  your deposit address into the pool's account.

Expected log:

```
[ask] asking the MPC to sweep 1.0 USDC from 0x… (proving, about a minute)
[ask] request 7f3a… in Midnight tx 00…. Follow it: https://sig-net.github.io/explorer/…
[sign] waiting for the MPC's signature (usually about 30 s)
[sign] signature found; it recovers to your deposit address 0x…
[broadcast] mined: https://sepolia.etherscan.io/tx/0x…
[attest] waiting for the MPC's attestation: it waits for Sepolia finality (about 18 minutes). Watch it: https://sig-net.github.io/explorer/…
```

No browser? `yarn deposit` does the same from the terminal, and `yarn settle` later. Both are
safe to rerun; progress is in `state.json`.

The **Ask** step links your request in the Sig.Network explorer, which then follows it through
Sign and Attest.

---

## 5. While the MPC attests

The MPC waits until the sweep is final on Sepolia, about 18 minutes. Meanwhile, the full
implementation of this contract, with withdraw, swap, lend and the handling of many users at
once, is the audited vault in
[sig-net/midnight-examples](https://github.com/sig-net/midnight-examples/tree/dev/examples/erc20-vault).
Your three pieces are in there under the same names.

---

## 6. Settle

When **Attest** turns green, click **Complete**. Your `completeDeposit` circuit verifies the
MPC's signature again, inside the proof, and mints. About a minute later your private balance
appears.

```
[attest] attested executed, transfer returned true at Sepolia block 9…
[settle] settling: minting your private tokens (proving, about a minute)
[settle] settled in Midnight tx 00…

Your private balance: 1.0 pool USDC
```

That balance is a shielded Midnight token. Only your wallet can see it, and it is backed by
the USDC in the pool's account, which only your contract can spend, through the same five
steps.

---

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `yarn doctor` | setup check: Node 22, Docker, proof server, `compact` 0.33.0-rc.2, seed, stagenet and Sepolia reachable, wallet synced with NIGHT and DUST |
| `yarn test [1\|2\|3]` | compile the contract (no proving keys, seconds) and run that part's offline tests (simulator + a test MPC key; no network, no proofs) |
| `yarn compile` | compile the contract with proving keys (about a minute). Run it after every contract change, before `yarn deploy` |
| `yarn deploy` | deploy + initialise on stagenet, print the contract, the pool account and **your deposit address** |
| `yarn dev` | the local app at http://localhost:4173 |
| `yarn deposit [amount]` | terminal fallback for the Deposit button: Ask, wait for Sign, Broadcast |
| `yarn settle` | terminal fallback for the Complete button: wait for Attest, Settle, print the private balance |
| `yarn finish [1\|2\|3]` | copy the finished files into place (yours go to `.finish-backup/`). Default: all three |

`yarn deploy`, `yarn deposit`, `yarn settle` and the app save progress in `state.json` and
are safe to rerun. Delete `state.json` to start over with a new contract.

### The local app

A Node server holds your wallet, proves and calls your contract; the browser only shows
progress and has two buttons. The page shows your deposit address (QR and copy), its USDC and
ETH balance, **Deposit**, the five steps ticking live (Ask, Sign, Broadcast with the Etherscan
link, Attest, Settle with the **Complete** button), and your private balance after Settle.

### How long things take

| Step | Time |
| --- | --- |
| `yarn test` | about 5 s |
| `yarn compile` (proving keys, 3 circuits) | about 45 s |
| first wallet sync (`yarn doctor`) | 10 to 20 min, once; later runs 1 s from the cache |
| deploy, then `initialise` | about 20 s, then about 25 s |
| Ask (`sendDeposit`, two proofs) | about 60 s |
| Sign (MPC signature after the request) | about 30 s |
| Broadcast (sweep mined on Sepolia) | a few seconds |
| Attest (MPC attestation after the request) | about 17 min: the MPC waits for Sepolia finality |
| Settle (`completeDeposit`) | about 65 s |

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `proof server ... not reachable` | `docker compose up -d`, wait 10 s. Check `docker logs midnight-proof-server`. |
| proof server is killed or very slow | Give Docker more memory (8 GB minimum). |
| `compact: version 0.33.0-rc.2 not found` | Redo setup step 3: the compiler zip must be unpacked under `~/.compact/versions/0.33.0-rc.2/<platform>/`. |
| `no proving keys: run yarn compile` | Run `yarn compile`. |
| macOS: `"compactc.bin" was blocked to protect your Mac` | Happens when the compiler zip was downloaded with a browser. System Settings, Privacy & Security, Allow Anyway, once per binary. The `curl` command in setup step 3 avoids it. |
| `does not compile` in `yarn test` | Read the compiler error above it. `event` is a reserved word in Compact. |
| `WalletUnfundedError` / no NIGHT | Faucet: https://faucet.stagenet.shielded.tools, then `yarn doctor`. |
| waiting for DUST | DUST grows from registered NIGHT over a few minutes. `yarn doctor` waits for it. |
| wallet sync takes forever | The first sync reads the whole chain. If `.wallet-cache/` is broken, delete it. |
| `Already initialised` | Harmless on rerun: `yarn deploy` treats it as done. |
| `Not the deployer` | The contract was deployed with another seed. Delete `state.json` and `yarn deploy` again. |
| `MPC signature: not yet` for a long time | Usually 30 s. The request is saved: stop and rerun later. Check the indexer in `yarn doctor`. |
| no signature ever, other requests get signed | The MPC skips a transaction it cannot sign, e.g. a max fee below the tip. Delete `requestId` from `state.json` and deposit again. |
| `signature recovers to ... not your deposit address` | The path in your circuit is not `userCommitment(callerSecretKey())`. |
| `needs ... ETH for gas` | Send Sepolia ETH to the deposit address (the sweep's sender pays), then Retry. |
| Sepolia tx stuck | The max fee is 2x the fee at request time. If gas spiked, delete `requestId` from `state.json` and deposit again. |
| `TODO(part N) is not done yet` | Finish that block, or `yarn finish N`. |

### Links

- Stagenet indexer: `https://indexer.stagenet.shielded.tools/api/v4/graphql`
  (websocket `wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws`)
- Stagenet node: `https://rpc.stagenet.shielded.tools`
- Stagenet faucet: https://faucet.stagenet.shielded.tools
- Signet contract and MPC root key: `getSignetContractAddress(MidnightNetwork.Stagenet)`
  and `getMpcRootPublicKey(MidnightNetwork.Stagenet)` from
  [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight) 0.25.0
- Sepolia USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- Explorer per request: `https://sig-net.github.io/explorer/midnight/explorer?networkId=stagenet&requestId=<id without 0x>`
- Integrator guide: https://github.com/sig-net/midnight-integration#integrator-guide
- The vault: https://github.com/sig-net/midnight-examples/tree/dev/examples/erc20-vault

### Layout

```
contract/workshop.compact        YOU: the contract (parts 1, 2)
src/flows/                       the five steps off chain; YOU: poll-signature-response.ts, broadcast-evm.ts (part 3)
src/lib/                         provided: config, identity, wallet, providers, deploy, state, polling, the deposit run
src/app/                         provided: the local app (yarn dev)
scripts/                         provided: doctor, compile, test, deploy, deposit, settle, finish
tests/                           provided: offline tests per part
solutions/partN/                 the files, complete after part N
slides/                          the deck
docker-compose.yaml              the proof server
.env.example                     settings (yarn doctor copies it to .env)
```

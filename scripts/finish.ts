import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES = ["contract/workshop.compact", "src/flows/poll-signature-response.ts", "src/flows/broadcast-evm.ts"];

const part = Number(process.argv[2] ?? "3");
if (![1, 2, 3].includes(part)) {
  console.error("usage: yarn finish [1|2|3]   (the part you want to have finished; default 3 = all)");
  process.exit(1);
}

const backup = join(ROOT, ".finish-backup", new Date().toISOString().replace(/[:.]/g, "-"));
for (const file of FILES) {
  const from = join(ROOT, "solutions", `part${part}`, file);
  const to = join(ROOT, file);
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  if (existsSync(to)) {
    mkdirSync(dirname(join(backup, file)), { recursive: true });
    copyFileSync(to, join(backup, file));
  }
  copyFileSync(from, to);
  console.log(`${file} <- solutions/part${part}/${file}`);
}
console.log(`\nYour previous files: ${backup}`);
console.log(`Next: yarn test ${part}${part >= 2 ? "   then   yarn compile   (before yarn deploy)" : ""}`);

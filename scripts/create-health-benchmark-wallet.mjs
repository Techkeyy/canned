import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { EVMWalletProvider } from "@bnbagent/sdk";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const walletsDir = path.join(dataDir, "state", "health-benchmark-wallets");
const passwordFile = path.join(dataDir, "state", "health-benchmark-wallet-password.txt");
if (existsSync(walletsDir) && (await readdir(walletsDir)).some((name) => /^0x[0-9a-fA-F]{40}\.json$/.test(name))) throw new Error("A HealthBench wallet already exists; refusing to create a second benchmark account.");
const password = randomBytes(48).toString("base64url");
const wallet = new EVMWalletProvider({ password, walletsDir, persist: true });
try {
  await mkdir(path.dirname(passwordFile), { recursive: true });
  await writeFile(passwordFile, `${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(passwordFile, 0o600);
  await chmod(wallet.keyLocation, 0o600);
  console.log(JSON.stringify({ status: "health_benchmark_wallet_created", network: "bsc-testnet", chainId: 97, walletAddress: wallet.address, keystorePath: wallet.keyLocation, passwordReferencePath: passwordFile, secretOutput: "none" }, null, 2));
} catch (error) {
  wallet.destroy();
  throw new Error(`Could not persist the HealthBench wallet reference: ${error.message}`);
}
wallet.destroy();

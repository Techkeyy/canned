import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const envPath = path.join(root, ".env.local");
const walletsDir = path.join(root, "data", "wallets");

if (existsSync(envPath)) throw new Error("Refusing to overwrite an existing .env.local.");
if (existsSync(walletsDir)) {
  const existing = await readdir(walletsDir);
  if (existing.some((name) => /^0x[0-9a-f]+\.json$/i.test(name))) throw new Error("Refusing to create a second wallet in an existing wallet directory.");
}

const password = randomBytes(48).toString("base64url");
const { EVMWalletProvider } = await import("@bnbagent/sdk");
const wallet = new EVMWalletProvider({ password, walletsDir, persist: true });
const envContents = [
  "# Local disposable Canned buyer configuration. This file is ignored and must never be committed.",
  "CANNED_NETWORK=bsc-testnet",
  "CANNED_CHAIN_ID=97",
  "CANNED_RPC_URL=https://bsc-testnet-rpc.publicnode.com",
  "RPC_URL_BSC_TESTNET=https://bsc-testnet-rpc.publicnode.com",
  "CANNED_ALLOW_TESTNET_WRITES=false",
  "CANNED_EXECUTION_WALLET_PASSWORD=" + password,
  "CANNED_EXECUTION_WALLET_ADDRESS=" + wallet.address,
  "CANNED_WALLETS_DIR=./data/wallets",
  "CANNED_DATA_DIR=./data",
  "",
].join("\n");

try {
  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, envContents, { mode: 0o600, flag: "wx" });
  await chmod(envPath, 0o600);
  await chmod(wallet.keyLocation, 0o600);
} catch (error) {
  wallet.destroy();
  throw new Error(`Could not persist the local wallet configuration: ${error.message}`);
}

console.log(JSON.stringify({
  network: "bsc-testnet",
  chainId: 97,
  walletAddress: wallet.address,
  keystorePath: wallet.keyLocation,
  envPath,
  secretOutput: "none",
}, null, 2));
wallet.destroy();

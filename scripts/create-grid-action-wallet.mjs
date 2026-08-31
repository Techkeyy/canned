/**
 * Create the Grid Keeper USER / ACTION wallet.
 *
 * This is a third, distinct role. It is NOT the Grid Keeper provider (which
 * signs agent actions) and NOT the Canned buyer (which pays ERC-8183 service
 * fees). It is the wallet whose testnet capital a bounded Altana session key
 * is allowed to spend, and which can revoke that session.
 *
 * Keeping it separate is the whole point of The Leash: an agent's own signing
 * key must never be the account whose funds it is trading, or "bounded
 * authority" means nothing.
 *
 * Creating a keystore performs no chain write and moves nothing.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const WALLETS_DIR = "grid-action-wallets";
const PASSWORD_FILE = "grid-action-wallet-password.txt";

const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(root, "data"));
const walletsDir = path.join(dataDir, "state", WALLETS_DIR);
const passwordFile = path.join(dataDir, "state", PASSWORD_FILE);
const sdk = await import("@bnbagent/sdk");

await mkdir(walletsDir, { recursive: true });
const addresses = sdk.EVMWalletProvider.listWallets(walletsDir);
if (addresses.length > 1) throw new Error("Grid action wallet directory contains more than one wallet; refusing to guess.");
let password = null;
try { password = (await readFile(passwordFile, "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
const created = addresses.length === 0;
if (created && password) throw new Error("Action wallet password reference exists but no matching keystore was found.");
if (!created && !password) throw new Error("Action wallet keystore exists but its password reference is missing.");
if (!password) password = randomBytes(48).toString("base64url");

const wallet = new sdk.EVMWalletProvider({ password, ...(created ? {} : { address: addresses[0] }), walletsDir, persist: true });
if (created) {
  await writeFile(passwordFile, `${password}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(passwordFile, 0o600);
}
await chmod(wallet.keyLocation, 0o600);

console.log(JSON.stringify({
  role: "grid_user_action_wallet",
  purpose: "Owns the bounded Altana session permission and the testnet trading capital",
  network: "bsc-testnet", chainId: 97,
  address: wallet.address,
  keystorePath: wallet.keyLocation,
  passwordReferencePath: passwordFile,
  distinctFrom: {
    gridProvider: "0xA928DEBa3aD929A915eE26fD3394126364928460",
    cannedBuyer: "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB",
  },
  secretOutput: "none",
  funded: false,
  onchainWrites: "none",
  note: "Counterfactual only. No chain write was performed and nothing was moved.",
}, null, 2));
wallet.destroy();

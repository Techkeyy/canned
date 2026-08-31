/**
 * Create the Grid Keeper provider wallet.
 *
 * A distinct keystore in a distinct directory: no reference agent shares a
 * signing key with another, so a compromise of one is not a compromise of the
 * fleet. Creating a wallet costs nothing and moves nothing. Funding it is a
 * separate, explicitly authorised step.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REFERENCE_WALLET_PATHS } from "../src/reference/constants.mjs";

const paths = REFERENCE_WALLET_PATHS.grid;
const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(root, "data"));
const walletsDir = path.join(dataDir, "state", paths.walletsDir);
const passwordFile = path.join(dataDir, "state", paths.passwordFile);
const sdk = await import("@bnbagent/sdk");

await mkdir(walletsDir, { recursive: true });
const addresses = sdk.EVMWalletProvider.listWallets(walletsDir);
if (addresses.length > 1) throw new Error("Grid provider directory contains more than one wallet; refusing to guess.");
let password = null;
try { password = (await readFile(passwordFile, "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
const created = addresses.length === 0;
if (created && password) throw new Error("Grid provider password reference exists but no matching keystore was found.");
if (!created && !password) throw new Error("Grid provider keystore exists but its password reference is missing.");
if (!password) password = randomBytes(48).toString("base64url");

const wallet = new sdk.EVMWalletProvider({ password, ...(created ? {} : { address: addresses[0] }), walletsDir, persist: true });
if (created) {
  await writeFile(passwordFile, `${password}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(passwordFile, 0o600);
}
await chmod(wallet.keyLocation, 0o600);
console.log(JSON.stringify({
  agent: "Canned Grid Keeper",
  network: "bsc-testnet", chainId: 97,
  providerAddress: wallet.address,
  keystorePath: wallet.keyLocation,
  passwordReferencePath: passwordFile,
  secretOutput: "none",
  funded: false,
  erc8004: "not_registered",
  note: "No funds were moved. Registration requires tBNB at this address and is a separate authorised step.",
}, null, 2));
wallet.destroy();

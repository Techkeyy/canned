import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REFERENCE_WALLET_PATHS } from "../src/reference/constants.mjs";

/**
 * A separate encrypted keystore for the Yield Scout provider. Each reference
 * agent signs only its own quotes and submissions, so a future Altana session
 * scoped to one agent can never reach another's authority.
 */
const paths = REFERENCE_WALLET_PATHS.yield;
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const walletsDir = path.join(dataDir, "state", paths.walletsDir);
const passwordFile = path.join(dataDir, "state", paths.passwordFile);
const sdk = await import("@bnbagent/sdk");
await mkdir(walletsDir, { recursive: true });
const addresses = sdk.EVMWalletProvider.listWallets(walletsDir);
if (addresses.length > 1) throw new Error("Yield provider directory contains more than one wallet; refusing to guess.");
let password = null;
try { password = (await readFile(passwordFile, "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
const created = addresses.length === 0;
if (created && password) throw new Error("Yield provider password reference exists but no matching keystore was found.");
if (!created && !password) throw new Error("Yield provider keystore exists but its password reference is missing.");
if (!password) password = randomBytes(48).toString("base64url");
const wallet = new sdk.EVMWalletProvider({ password, ...(created ? {} : { address: addresses[0] }), walletsDir, persist: true });
if (created) {
  await writeFile(passwordFile, `${password}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(passwordFile, 0o600);
}
await chmod(wallet.keyLocation, 0o600);
console.log(JSON.stringify({
  agent: "Canned Yield Scout",
  network: "bsc-testnet",
  chainId: 97,
  providerAddress: wallet.address,
  keystorePath: wallet.keyLocation,
  passwordReferencePath: passwordFile,
  createdThisRun: created,
  separateFrom: "the Health Guard provider, the Range Keeper provider, and the Canned buyer",
  secretOutput: "none",
  funded: false,
  erc8004: "not_registered",
}, null, 2));
wallet.destroy();

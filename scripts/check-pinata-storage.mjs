import { IPFSStorageProvider } from "@bnbagent/sdk/storage";
import { contentHashes } from "../src/core.mjs";
import { verifyContentAddressedRoundTrip } from "../src/deploy/storage.mjs";

if (!process.env.STORAGE_API_KEY) throw new Error("STORAGE_API_KEY is required in the server environment; no credential value is printed.");

const storage = IPFSStorageProvider.fromEnv();
const firstArtifact = {
  kind: "canned_storage_probe",
  version: 1,
  purpose: "durable_health_guard_readiness",
  nonce: "canned-health-guard-storage-probe-v1",
};
const secondArtifact = { ...firstArtifact, version: 2 };
const result = await verifyContentAddressedRoundTrip({ storage, firstArtifact, secondArtifact });
if (result.firstGatewayUrl.includes(process.env.STORAGE_API_KEY)) throw new Error("Storage credential appeared in the public gateway URL.");

console.log(JSON.stringify({
  status: "content_addressed_storage_verified",
  provider: "@bnbagent/sdk IPFSStorageProvider",
  firstCid: IPFSStorageProvider.extractCid(result.firstUrl),
  changedCid: IPFSStorageProvider.extractCid(result.changedUrl),
  firstSha256: contentHashes(firstArtifact).sha256,
  retrievedSha256: result.retrievedHash.sha256,
  changedSha256: contentHashes(secondArtifact).sha256,
  uploadRetrievedEqual: result.uploadRetrievedEqual,
  changedContentDifferent: result.changedContentDifferent,
  credentialInReturnedUrl: false,
  cleanup: "Unpin the two probe CIDs from the Pinata dashboard when no longer needed.",
  secretOutput: "none",
}, null, 2));

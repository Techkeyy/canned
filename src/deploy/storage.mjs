import { canonicalJson, contentHashes } from "../core.mjs";

export async function verifyContentAddressedRoundTrip({ storage, firstArtifact, secondArtifact, firstFilename = "canned-storage-probe-v1.json", secondFilename = "canned-storage-probe-v2.json" } = {}) {
  if (!storage || typeof storage.upload !== "function" || typeof storage.download !== "function" || typeof storage.exists !== "function" || typeof storage.getGatewayUrl !== "function") {
    throw new Error("A complete content-addressed storage provider is required.");
  }
  const firstUrl = await storage.upload(firstArtifact, firstFilename);
  const firstExists = await storage.exists(firstUrl);
  const firstRetrieved = await storage.download(firstUrl);
  const changedUrl = await storage.upload(secondArtifact, secondFilename);
  const firstHash = contentHashes(firstArtifact);
  const retrievedHash = contentHashes(firstRetrieved);
  const changedHash = contentHashes(secondArtifact);
  const sameCanonicalBytes = canonicalJson(firstArtifact) === canonicalJson(firstRetrieved);
  if (!firstExists) throw new Error("Uploaded storage probe was not visible through the public gateway.");
  if (!sameCanonicalBytes || firstHash.sha256 !== retrievedHash.sha256 || firstHash.keccak256 !== retrievedHash.keccak256) throw new Error("Retrieved storage probe content did not match the uploaded canonical bytes.");
  if (firstUrl === changedUrl || firstHash.sha256 === changedHash.sha256 || firstHash.keccak256 === changedHash.keccak256) throw new Error("Changing storage probe content did not produce a different content address.");
  const firstGatewayUrl = storage.getGatewayUrl(firstUrl);
  return {
    firstUrl,
    changedUrl,
    firstGatewayUrl,
    firstHash,
    retrievedHash,
    changedHash,
    uploadRetrievedEqual: true,
    changedContentDifferent: true,
  };
}

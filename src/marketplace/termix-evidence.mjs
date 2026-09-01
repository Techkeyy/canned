import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve the grading record by its contents, not by one benchmark family's
 * filename convention. A benchmark run is public evidence only when both its
 * run ID and benchmark ID agree with the paired record.
 */
export async function loadGradingArtifact({ stateDir, runId, benchmarkId } = {}) {
  if (!stateDir || !runId || !benchmarkId) return null;
  let names;
  try {
    names = await readdir(stateDir);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const candidates = names
    .filter((name) => /grading.*\.json$/iu.test(name) && name.includes(String(runId)))
    .sort();
  for (const name of candidates) {
    let artifact;
    try {
      artifact = JSON.parse(await readFile(path.join(stateDir, name), "utf8"));
    } catch {
      continue;
    }
    if (String(artifact.runId || "") !== String(runId)) continue;
    if (String(artifact.benchmarkId || "") !== String(benchmarkId)) continue;
    return { name, artifact };
  }
  return null;
}

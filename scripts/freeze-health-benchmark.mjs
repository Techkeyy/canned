import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHealthBenchDefinition } from "../src/reference/health-benchmark.mjs";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const sourcePath = path.join(dataDir, "state", "health-position-snapshot.json");
const artifact = JSON.parse(await readFile(sourcePath, "utf8"));
if (artifact?.network !== "bsc-testnet" || Number(artifact?.chainId) !== 97) throw new Error("HealthBench position artifact is not BSC Testnet chain 97.");
const snapshot = artifact.snapshot;
const definition = createHealthBenchDefinition({ snapshot, account: artifact.benchmarkAddress || artifact.account, sourceUrls: ["https://docs-v4.venus.io/", "https://raw.githubusercontent.com/VenusProtocol/venus-protocol-documentation/main/deployed-contracts/markets.md", "https://testnet.bscscan.com/address/0x94d1820b2D1c7c7452A163983Dc888CEC546b77D"], priorSnapshot: null });
await mkdir(path.join(dataDir, "state"), { recursive: true });
await writeFile(path.join(dataDir, "state", "healthbench-v1.json"), `${JSON.stringify(definition, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({ status: "healthbench_frozen", benchmarkId: definition.benchmarkId, version: definition.version, network: definition.chain.network, chainId: definition.chain.chainId, account: definition.position.account, asOfBlock: definition.frozenEvidence.snapshot.asOfBlock, precommit: definition.precommit, artifact: "state/healthbench-v1.json", agentExecution: "not_started", humanBaseline: "not_started", secretOutput: "none" }, null, 2));

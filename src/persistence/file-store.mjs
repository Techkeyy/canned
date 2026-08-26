import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, contentHashes } from "../core.mjs";

export class FileStore {
  constructor(root = process.env.CANNED_DATA_DIR || path.resolve(process.cwd(), "data")) {
    this.root = path.resolve(root);
    this.stateDir = path.join(this.root, "state");
    this.evidenceDir = path.join(this.root, "evidence");
    this.inventoryDir = path.join(this.root, "inventory");
  }

  async init() {
    await Promise.all([mkdir(this.stateDir, { recursive: true }), mkdir(this.evidenceDir, { recursive: true }), mkdir(this.inventoryDir, { recursive: true })]);
    return this;
  }

  async probe() {
    await this.init();
    const file = path.join(this.stateDir, `.doctor-${randomUUID()}.tmp`);
    await writeFile(file, "canned-storage-probe\n", "utf8");
    await access(file);
    const { unlink } = await import("node:fs/promises");
    await unlink(file);
    return { ok: true, root: this.root, kind: "local_content_addressed" };
  }

  async atomicWrite(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, file);
  }

  async saveEvidence(value) {
    await this.init();
    const hashes = contentHashes(value);
    const file = path.join(this.evidenceDir, `${hashes.sha256.slice("sha256:".length)}.json`);
    try { await access(file); } catch { await this.atomicWrite(file, `${hashes.canonicalJson}\n`); }
    return {
      store: "local_content_addressed",
      relativePath: path.relative(this.root, file).replaceAll(path.sep, "/"),
      sha256: hashes.sha256,
      keccak256: hashes.keccak256,
      durablePublicStorage: false,
    };
  }

  async saveJson(relativePath, value) {
    await this.init();
    const file = path.join(this.root, relativePath);
    await this.atomicWrite(file, `${canonicalJson(value)}\n`);
    return { relativePath: relativePath.replaceAll(path.sep, "/"), file };
  }

  async loadJson(relativePath, fallback = null) {
    try {
      return JSON.parse(await readFile(path.join(this.root, relativePath), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  }

  async appendJsonArray(relativePath, value) {
    const current = await this.loadJson(relativePath, []);
    if (!Array.isArray(current)) throw new TypeError(`${relativePath} is not an array`);
    current.push(value);
    await this.saveJson(relativePath, current);
    return value;
  }

  async saveRun(run) { return this.appendJsonArray("state/benchmark-runs.json", run); }
  async loadRuns() { return this.loadJson("state/benchmark-runs.json", []); }
  async saveProtocolJob(job) { return this.appendJsonArray("state/protocol-jobs.json", job); }
  async saveInventory(report) { return this.saveJson("inventory/verified-candidates.json", report); }
}

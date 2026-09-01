import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Durable atomic store for the official MPP replay slots.
 *
 * The public Health Guard is a single VPS process today, but the replay
 * invariant must also survive a restart and a second process on that host.
 * Each key has its own OS-exclusive lock and its value is committed with
 * write-then-rename. The lock is held only across the synchronous
 * read/modify/write decision; the MPP verifier never calls an async function
 * while its update callback is running.
 */
const LOCK_RETRY_MS = 15;
const LOCK_STALE_MS = 2 * 60 * 1000;

function keyFileName(key) {
  return `${createHash("sha256").update(String(key)).digest("hex")}.json`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeChmod(file, mode) {
  try { await chmod(file, mode); } catch (error) {
    if (!(["EPERM", "ENOSYS", "EROFS"].includes(error?.code))) throw error;
  }
}

export class FileMppReplayStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await safeChmod(this.root, 0o700);
    return this;
  }

  fileFor(key) {
    return path.join(this.root, keyFileName(key));
  }

  lockFor(key) {
    return path.join(this.root, `${keyFileName(key)}.lock`);
  }

  async get(key) {
    await this.init();
    try {
      return JSON.parse(await readFile(this.fileFor(key), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async put(key, value) {
    return this.update(key, () => ({ op: "set", value, result: undefined }));
  }

  async delete(key) {
    return this.update(key, () => ({ op: "delete", result: undefined }));
  }

  async update(key, fn) {
    await this.init();
    const lock = await this.acquireLock(key);
    try {
      const current = await this.get(key);
      const change = fn(current);
      if (!change || !["noop", "set", "delete"].includes(change.op)) {
        throw new TypeError("MPP replay store update must return noop, set, or delete.");
      }
      if (change.op === "set") await this.writeValue(key, change.value);
      if (change.op === "delete") {
        try { await unlink(this.fileFor(key)); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      return change.result;
    } finally {
      await lock.release();
    }
  }

  async writeValue(key, value) {
    const file = this.fileFor(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await safeChmod(temporary, 0o600);
    await rename(temporary, file);
    await safeChmod(file, 0o600);
  }

  async acquireLock(key) {
    const lockFile = this.lockFor(key);
    for (;;) {
      try {
        const handle = await open(lockFile, "wx", 0o600);
        await safeChmod(lockFile, 0o600);
        return {
          release: async () => {
            await handle.close();
            try { await unlink(lockFile); } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
          },
        };
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
        let info = null;
        try {
          info = await stat(lockFile);
        } catch (statError) {
          // Windows can report an existing exclusive-create collision as
          // EPERM. If no lock exists, retain the fail-closed permission error.
          if (statError?.code === "ENOENT" && error?.code === "EPERM") throw error;
          if (statError?.code !== "ENOENT") throw statError;
        }
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          // This lock can only outlive a live update if the holder has been
          // stopped for longer than the tiny critical section. MPP's own
          // inflight replay TTL remains the final on-chain safety net.
          await unlink(lockFile);
          continue;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }
}

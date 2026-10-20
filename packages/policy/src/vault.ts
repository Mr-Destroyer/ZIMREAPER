import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { ZimReaperError } from "@zimreaper/protocol";
import type { Vault } from "./types.js";

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

interface KeyFile {
  v: 1;
  salt: string;
  secret: string;
}

interface VaultFile {
  v: 1;
  entries: Record<string, EncryptedEntry>;
}

export interface FileVaultOptions {
  keyPath?: string;
  vaultPath?: string;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ZimReaperError("INTERNAL", `cannot read ${label}`, {
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function writePrivate(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    const buffer = Buffer.from(data, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new ZimReaperError("INTERNAL", `${label} is missing or malformed`);
  }
  return Buffer.from(value, "base64");
}

/**
 * File-backed vault. A 0600 keyfile holds a random secret + salt; scrypt derives
 * the AES-256-GCM key. Names are bound as AAD so ciphertext cannot be swapped
 * between entries.
 */
class FileVault implements Vault {
  private readonly keyPath: string;
  private readonly vaultPath: string;
  private cachedKey?: Buffer;

  constructor(dir: string, options: FileVaultOptions) {
    this.keyPath = options.keyPath ?? join(dir, "vault.key");
    this.vaultPath = options.vaultPath ?? join(dir, "vault.json");
  }

  private key(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    if (!existsSync(this.keyPath)) {
      const keyFile: KeyFile = {
        v: 1,
        salt: randomBytes(16).toString("base64"),
        secret: randomBytes(32).toString("base64"),
      };
      writePrivate(this.keyPath, `${JSON.stringify(keyFile)}\n`);
    }
    try {
      // The keyfile is created 0600; enforce it even if an older copy was loose.
      chmodSync(this.keyPath, 0o600);
    } catch (error) {
      throw new ZimReaperError("INTERNAL", "cannot make the vault keyfile private", {
        details: error instanceof Error ? error.message : String(error),
      });
    }
    const parsed = readJson(this.keyPath, "vault keyfile");
    if (typeof parsed !== "object" || parsed === null) {
      throw new ZimReaperError("INTERNAL", "vault keyfile is malformed");
    }
    const keyFile = parsed as Partial<KeyFile>;
    const salt = decodeBase64(keyFile.salt, "vault keyfile salt");
    const secret = decodeBase64(keyFile.secret, "vault keyfile secret");
    this.cachedKey = scryptSync(secret, salt, 32, { N: 16_384, r: 8, p: 1 });
    return this.cachedKey;
  }

  private readEntries(): Record<string, EncryptedEntry> {
    if (!existsSync(this.vaultPath)) return {};
    const parsed = readJson(this.vaultPath, "vault");
    if (typeof parsed !== "object" || parsed === null) {
      throw new ZimReaperError("INTERNAL", "vault is malformed");
    }
    const file = parsed as Partial<VaultFile>;
    if (typeof file.entries !== "object" || file.entries === null) {
      throw new ZimReaperError("INTERNAL", "vault entries are malformed");
    }
    return file.entries;
  }

  private writeEntries(entries: Record<string, EncryptedEntry>): void {
    const file: VaultFile = { v: 1, entries };
    writePrivate(this.vaultPath, `${JSON.stringify(file)}\n`);
  }

  private encrypt(name: string, value: string): EncryptedEntry {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(name, "utf8"));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  private decrypt(name: string, entry: EncryptedEntry): string {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key(),
        decodeBase64(entry.iv, "vault entry iv"),
      );
      decipher.setAAD(Buffer.from(name, "utf8"));
      decipher.setAuthTag(decodeBase64(entry.tag, "vault entry tag"));
      return Buffer.concat([
        decipher.update(decodeBase64(entry.data, "vault entry data")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      if (error instanceof ZimReaperError) throw error;
      throw new ZimReaperError("INTERNAL", `vault entry "${name}" failed authentication`);
    }
  }

  async list(): Promise<string[]> {
    return Object.keys(this.readEntries()).sort();
  }

  async get(name: string): Promise<string | undefined> {
    const entries = this.readEntries();
    const entry = entries[name];
    if (!entry) return undefined;
    return this.decrypt(name, entry);
  }

  async set(name: string, value: string): Promise<void> {
    if (!name) throw new ZimReaperError("BAD_REQUEST", "vault entry name is required");
    const entries = this.readEntries();
    entries[name] = this.encrypt(name, value);
    this.writeEntries(entries);
  }

  async remove(name: string): Promise<boolean> {
    const entries = this.readEntries();
    if (!Object.prototype.hasOwnProperty.call(entries, name)) return false;
    delete entries[name];
    this.writeEntries(entries);
    return true;
  }
}

export function createFileVault(dir: string, options: FileVaultOptions = {}): Vault {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ZimReaperError("INTERNAL", `cannot create vault directory ${dir}`, {
      details: error instanceof Error ? error.message : String(error),
    });
  }
  return new FileVault(dir, options);
}

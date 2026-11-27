import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const checksum = /^[0-9a-f]{64}$/;
const maxSize = 60 * 1024 * 1024;

export function digestOf(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface ArtifactRef {
  digest: string;
  sizeBytes: number;
}

export interface ArtifactStore {
  put(tenant: string, data: Buffer): Promise<ArtifactRef>;
  get(tenant: string, ref: ArtifactRef): Promise<Buffer>;
  ready?(): Promise<void>;
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export class DiskArtifacts implements ArtifactStore {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async ready() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await access(this.root, constants.R_OK | constants.W_OK);
  }

  private path(tenant: string, digest: string) {
    if (!uuid.test(tenant) || !checksum.test(digest))
      throw new ArtifactError('Invalid artifact key');
    return join(
      this.root,
      tenant.toLowerCase(),
      digest.slice(0, 2),
      `${digest}.png`,
    );
  }

  async put(tenant: string, bytes: Buffer): Promise<ArtifactRef> {
    if (!bytes.length || bytes.length > maxSize)
      throw new ArtifactError('Artifact size is outside the supported bounds');
    const ref = { digest: digestOf(bytes), sizeBytes: bytes.length };
    const destination = this.path(tenant, ref.digest);
    const temporary = join(dirname(destination), `.${randomUUID()}.pending`);
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.get(tenant, ref);
      }
      return ref;
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError('Artifact could not be stored');
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(tenant: string, ref: ArtifactRef) {
    const path = this.path(tenant, ref.digest);
    try {
      const info = await stat(path);
      if (
        !info.isFile() ||
        info.size !== ref.sizeBytes ||
        info.size < 1 ||
        info.size > maxSize
      ) {
        throw new ArtifactError('Artifact size does not match its reference');
      }
      const handle = await open(path, 'r');
      try {
        const bytes = Buffer.alloc(info.size);
        const { bytesRead } = await handle.read({
          buffer: bytes,
          position: 0,
          length: bytes.length,
        });
        if (bytesRead !== bytes.length || digestOf(bytes) !== ref.digest) {
          throw new ArtifactError(
            'Artifact digest does not match its reference',
          );
        }
        return bytes;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError('Artifact could not be read');
    }
  }
}

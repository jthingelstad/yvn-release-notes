/** Versioned, private local object/mail/invocation fakes; no network or AWS. */
import type { Objects, StoredObject, ObjectWrite, Mail, Invocations } from '../backend/services.ts';
import { readFile } from 'node:fs/promises';
export class FakeObjects implements Objects {
  readonly versions = new Map<string, Array<StoredObject & { deleted?: boolean; tags: Record<string, string> }>>();
  readonly calls: Array<{ operation: string; key: string; version?: string }> = [];
  private sequence = 0;
  private find(key: string, version?: string) {
    const versions = this.versions.get(key) ?? [],
      found = version ? versions.find((v) => v.version === version) : versions.at(-1);
    if (!found || found.deleted) {
      const error = new Error('Object missing');
      error.name = 'NoSuchKey';
      throw error;
    }
    return found;
  }
  async get(key: string, options: { version?: string; range?: string; maxBytes?: number } = {}) {
    this.calls.push({ operation: 'get', key, version: options.version });
    const found = this.find(key, options.version);
    let body = Buffer.from(found.body);
    if (options.range) {
      const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(options.range);
      if (!match) throw new Error('Unsupported range');
      body = body.subarray(Number(match[1]), Number(match[2]) + 1);
    }
    if (body.length > (options.maxBytes ?? 50 * 1024 * 1024)) throw new RangeError('Object exceeds read limit');
    return { ...found, body, size: body.length, metadata: { ...found.metadata } };
  }
  async head(key: string, version?: string) {
    this.calls.push({ operation: 'head', key, version });
    const found = this.find(key, version);
    return { size: found.size, type: found.type, version: found.version, metadata: { ...found.metadata } };
  }
  async put(key: string, body: Buffer, options: ObjectWrite) {
    this.calls.push({ operation: 'put', key });
    const version = String(++this.sequence),
      versions = this.versions.get(key) ?? [];
    versions.push({
      body: Buffer.from(body),
      size: body.length,
      type: options.type,
      version,
      metadata: { ...options.metadata },
      tags: { ...options.tags }
    });
    this.versions.set(key, versions);
    return version;
  }
  async copy(source: string, version: string, target: string, options: ObjectWrite) {
    this.calls.push({ operation: 'copy', key: target, version });
    await this.put(target, this.find(source, version).body, options);
  }
  async uploadFile(key: string, path: string, options: ObjectWrite) {
    this.calls.push({ operation: 'uploadFile', key });
    await this.put(key, await readFile(path), options);
  }
  async remove(key: string, version?: string) {
    this.calls.push({ operation: 'remove', key, version });
    if (version) {
      const versions = this.versions.get(key) ?? [];
      this.versions.set(
        key,
        versions.filter((v) => v.version !== version)
      );
    } else {
      const versions = this.versions.get(key) ?? [];
      versions.push({
        body: Buffer.alloc(0),
        size: 0,
        type: '',
        metadata: {},
        tags: {},
        version: String(++this.sequence),
        deleted: true
      });
      this.versions.set(key, versions);
    }
  }
  async list(prefix: string) {
    return [...this.versions.keys()]
      .filter(
        (key) =>
          key.startsWith(prefix) && this.versions.get(key)!.length > 0 && !this.versions.get(key)!.at(-1)?.deleted
      )
      .sort();
  }
  async tag(key: string, tags: Record<string, string>) {
    this.calls.push({ operation: 'tag', key });
    this.find(key).tags = { ...tags };
  }
  async tags(key: string, version?: string) {
    this.calls.push({ operation: 'tags', key, version });
    return { ...this.find(key, version).tags };
  }
  async download(key: string, type: string, seconds: number, options: { disposition?: string; cache?: string } = {}) {
    this.calls.push({ operation: 'download', key });
    return `https://files.example.test/${encodeURIComponent(key)}?${new URLSearchParams({ type, seconds: String(seconds), disposition: options.disposition ?? 'inline', cache: options.cache ?? '' })}`;
  }
  async upload(key: string, type: string, size: number, seconds: number) {
    this.calls.push({ operation: 'upload', key });
    return {
      url: 'https://files.example.test/',
      fields: { key, 'Content-Type': type, size: String(size), seconds: String(seconds), tagging: 'pending' }
    };
  }
}
export class FakeMail implements Mail {
  readonly messages: Array<{ raw: Buffer; to: string; id: string; kind: 'daily' | 'account' }> = [];
  readonly suppressed = new Set<string>();
  fail = false;
  async send(raw: Buffer, to: string, kind: 'daily' | 'account' = 'account') {
    if (this.fail) throw new Error('Mail unavailable');
    const id = `m-${this.messages.length + 1}`;
    this.messages.push({ raw: Buffer.from(raw), to, id, kind });
    return id;
  }
  async unsuppress(email: string) {
    this.suppressed.delete(email);
  }
}
export class FakeInvocations implements Invocations {
  readonly calls: Array<{ name: string; payload: unknown; asynchronous: boolean }> = [];
  fail = false;
  response: unknown = null;
  async invoke(name: string, payload: unknown, asynchronous = true) {
    if (this.fail) throw new Error('Worker unavailable');
    this.calls.push({ name, payload: structuredClone(payload), asynchronous });
    return this.response;
  }
}

/**
 * RawAssetService (Layer H) — S3-compatible immutable raw archive.
 *
 * Default provider: Cloudflare R2 (S3-compatible, cheap, zero egress fees).
 * Works with any S3-compatible backend (AWS S3, Backblaze B2, MinIO, etc.)
 * via endpoint + credentials env vars.
 *
 * Configuration (all optional — service is disabled if missing):
 *   RAW_ARCHIVE_ENABLED=true
 *   RAW_ARCHIVE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
 *   RAW_ARCHIVE_REGION=auto
 *   RAW_ARCHIVE_BUCKET=angel-raw-archive
 *   RAW_ARCHIVE_ACCESS_KEY_ID=...
 *   RAW_ARCHIVE_SECRET_ACCESS_KEY=...
 *   RAW_ARCHIVE_PUBLIC_BASE=https://cdn.example.com (optional, for presigned URLs)
 *
 * Retention classes live in the RawAsset Prisma model:
 *   short (7d) | medium (90d) | long (2y) | permanent
 * The retention_sweep graphile-worker job deletes expired objects.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { prisma } from '../../index';
import { retentionFor, retentionTTL, type PrivacyClass, type MemoryType } from '../memory/policy';

const ENABLED = process.env.RAW_ARCHIVE_ENABLED === 'true';
const ENDPOINT = process.env.RAW_ARCHIVE_ENDPOINT || '';
const REGION = process.env.RAW_ARCHIVE_REGION || 'auto';
const BUCKET = process.env.RAW_ARCHIVE_BUCKET || '';
const ACCESS_KEY_ID = process.env.RAW_ARCHIVE_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.RAW_ARCHIVE_SECRET_ACCESS_KEY || '';

export interface RawAssetInput {
  userId: string;
  modality: 'audio' | 'image' | 'video' | 'document';
  observedAt: Date;
  body: Buffer;
  contentType?: string;
  privacyClass?: PrivacyClass;
  memoryType?: MemoryType; // for retention policy
  metadata?: Record<string, string>;
}

export class RawAssetService {
  private client: S3Client | null = null;

  constructor() {
    if (!ENABLED) return;
    if (!ENDPOINT || !BUCKET || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
      console.warn('[raw-archive] enabled but missing config — disabling');
      return;
    }
    this.client = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
      forcePathStyle: true, // R2 + Backblaze compatibility
    });
  }

  get isEnabled(): boolean { return this.client !== null; }

  /** Upload + register a raw asset. Returns the s3:// URI or null if disabled. */
  async upload(input: RawAssetInput): Promise<string | null> {
    if (!this.client) return null;
    const sha256 = createHash('sha256').update(input.body).digest('hex');

    // Dedupe: if we've already stored this exact blob for this user, reuse it
    const existing = await prisma.rawAsset.findFirst({ where: { userId: input.userId, sha256 } });
    if (existing) return existing.uri;

    const date = input.observedAt.toISOString().slice(0, 10);
    const key = `${input.userId}/${date}/${sha256}-${Date.now()}.${extFor(input.modality)}`;
    const uri = `s3://${BUCKET}/${key}`;

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: input.body,
        ContentType: input.contentType || contentTypeFor(input.modality),
        Metadata: input.metadata,
        ServerSideEncryption: 'AES256', // SSE-KMS if KMS key configured; else AES256
      }));
    } catch (err: any) {
      console.warn('[raw-archive] upload failed:', err?.message?.slice(0, 200));
      return null;
    }

    const privacyClass = input.privacyClass ?? 'public';
    const memoryType = input.memoryType ?? 'observation';
    const retentionClass = retentionFor(memoryType, privacyClass);
    const ttl = retentionTTL(retentionClass);
    const deleteAfter = ttl ? new Date(Date.now() + ttl) : null;

    try {
      await prisma.rawAsset.create({
        data: {
          userId: input.userId,
          observedAt: input.observedAt,
          modality: input.modality,
          uri,
          sha256,
          bytes: input.body.length,
          retentionClass,
          deleteAfter,
          kmsKeyId: null,
          objectLockMode: null,
        },
      });
    } catch (err: any) {
      console.warn('[raw-archive] db register failed, deleting uploaded blob:', err?.message);
      await this.delete(uri).catch(() => {});
      return null;
    }

    return uri;
  }

  /** Delete an object. Tolerates "not found". */
  async delete(uri: string): Promise<boolean> {
    if (!this.client) return false;
    const key = this.parseKey(uri);
    if (!key) return false;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch (err: any) {
      console.warn('[raw-archive] delete failed:', err?.message?.slice(0, 100));
      return false;
    }
  }

  /** Fetch an object's bytes (for replay / model upgrades). */
  async fetch(uri: string): Promise<Buffer | null> {
    if (!this.client) return null;
    const key = this.parseKey(uri);
    if (!key) return null;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      if (!res.Body) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as any) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } catch (err: any) {
      console.warn('[raw-archive] fetch failed:', err?.message?.slice(0, 100));
      return null;
    }
  }

  /** Liveness check. */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: BUCKET }));
      return true;
    } catch {
      return false;
    }
  }

  private parseKey(uri: string): string | null {
    const m = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return m[2];
  }
}

function contentTypeFor(modality: string): string {
  switch (modality) {
    case 'audio':    return 'audio/wav';
    case 'image':    return 'image/jpeg';
    case 'video':    return 'video/mp4';
    case 'document': return 'application/pdf';
    default:         return 'application/octet-stream';
  }
}

function extFor(modality: string): string {
  switch (modality) {
    case 'audio':    return 'wav';
    case 'image':    return 'jpg';
    case 'video':    return 'mp4';
    case 'document': return 'pdf';
    default:         return 'bin';
  }
}

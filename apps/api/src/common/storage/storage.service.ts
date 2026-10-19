import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface UploadFileInput {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  keyPrefix: string;
}

export interface PutObjectInput {
  key: string;
  buffer: Buffer;
  mimeType: string;
}

/** S3-compatible (MinIO in dev/self-hosted, any S3 provider in prod — 11.2/14.4 SCA-005). */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicEndpoint: string;

  constructor(config: ConfigService) {
    const endpoint = config.getOrThrow<string>('S3_ENDPOINT');
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.publicEndpoint = endpoint;
    this.client = new S3Client({
      endpoint,
      region: config.get<string>('S3_REGION', 'us-east-1'),
      forcePathStyle: config.get<boolean>('S3_FORCE_PATH_STYLE', true),
      credentials: {
        accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'),
        secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY'),
      },
    });
  }

  async upload(input: UploadFileInput): Promise<string> {
    const key = `${input.keyPrefix}/${randomUUID()}.${input.extension}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.buffer,
        ContentType: input.mimeType,
      }),
    );
    return `${this.publicEndpoint}/${this.bucket}/${key}`;
  }

  /** Writes to an exact key (idempotent overwrite). Returns the key, never a public URL: private files go through signed/streamed download. */
  async putObject(input: PutObjectInput): Promise<string> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: input.key, Body: input.buffer, ContentType: input.mimeType }));
    return input.key;
  }

  async getObject(key: string): Promise<{ stream: Readable; size?: number }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { stream: res.Body as Readable, size: res.ContentLength };
  }
}

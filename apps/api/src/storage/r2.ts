/**
 * Cloudflare R2 storage client.
 *
 * R2 is S3-compatible. The endpoint is:
 *   https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com
 *
 * Required env vars:
 *   R2_ACCOUNT_ID       — Cloudflare account ID
 *   R2_ACCESS_KEY_ID    — R2 API access key ID
 *   R2_SECRET_ACCESS_KEY — R2 API secret access key
 *   R2_BUCKET_NAME      — bucket name (e.g. "beekeeper")
 *
 * Lazy singleton: client is created on first use. Missing env vars throw at
 * call time, not at module load — same pattern as email/send.ts (Resend).
 */

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ── Lazy singleton ────────────────────────────────────────────────────────────

let _client: S3Client | null = null;
let _bucket: string | null = null;

function getClient(): { client: S3Client; bucket: string } {
  if (_client && _bucket) return { client: _client, bucket: _bucket };

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2 storage is not configured. Required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME"
    );
  }

  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  _bucket = bucket;

  return { client: _client, bucket: _bucket };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if all four R2 env vars are set. Does NOT validate credentials.
 * Use to gate the R2 upload-url route (returns 503 if false).
 */
export function isR2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

/**
 * Generates a presigned PUT URL for direct browser-to-R2 upload.
 *
 * @param storageKey   R2 object key (e.g. "frames/{frameId}/front-{photoId}.jpg")
 * @param mimeType     Restricts Content-Type the client must use (enforced by R2)
 * @param expirySeconds  How long the URL is valid (default: 600s / 10 min)
 * @returns { url, expiresAt }
 */
export async function getPresignedUploadUrl(
  storageKey: string,
  mimeType: string,
  expirySeconds = 600
): Promise<{ url: string; expiresAt: Date }> {
  const { client, bucket } = getClient();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ContentType: mimeType,
  });

  const url = await getSignedUrl(client, command, { expiresIn: expirySeconds });
  const expiresAt = new Date(Date.now() + expirySeconds * 1000);

  return { url, expiresAt };
}

/**
 * Performs a HeadObject to verify a file exists in R2 and retrieve its size.
 *
 * @returns { exists: boolean; contentLength: number | null }
 */
export async function headObject(
  storageKey: string
): Promise<{ exists: boolean; contentLength: number | null }> {
  const { client, bucket } = getClient();

  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: storageKey })
    );
    return {
      exists: true,
      contentLength: result.ContentLength ?? null,
    };
  } catch (err: unknown) {
    // HeadObject throws a NoSuchKey / 404-equivalent when the object doesn't exist
    if (
      err instanceof Error &&
      (err.name === "NotFound" || err.name === "NoSuchKey" ||
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
    ) {
      return { exists: false, contentLength: null };
    }
    throw err;
  }
}

/**
 * Generates a presigned GET URL for direct browser-to-R2 read access.
 *
 * @param storageKey   R2 object key
 * @param expirySeconds  How long the URL is valid (default: 3600s / 1 hour)
 * @returns { url, expiresAt }
 */
export async function getPresignedDownloadUrl(
  storageKey: string,
  expirySeconds = 3600
): Promise<{ url: string; expiresAt: Date }> {
  const { client, bucket } = getClient();

  const command = new GetObjectCommand({ Bucket: bucket, Key: storageKey });
  const url = await getSignedUrl(client, command, { expiresIn: expirySeconds });
  const expiresAt = new Date(Date.now() + expirySeconds * 1000);

  return { url, expiresAt };
}

/**
 * Fetches a file from R2 and returns its contents as a Buffer.
 * Throws if the file does not exist or cannot be read.
 *
 * @param storageKey  R2 object key
 * @returns Buffer containing the file data
 */
export async function fetchFileBuffer(storageKey: string): Promise<Buffer> {
  const { client, bucket } = getClient();

  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: storageKey })
  );

  if (!result.Body) {
    throw new Error(`R2 object '${storageKey}' returned empty body`);
  }

  // Collect stream chunks into a Buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

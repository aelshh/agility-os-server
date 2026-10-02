import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class S3NotConfiguredError extends Error {
  constructor(
    message = "AWS S3 object storage is not configured. Please configure S3_BUCKET_NAME, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY in environment variables.",
  ) {
    super(message);
    this.name = "S3NotConfiguredError";
  }
}

export interface StoredFileResult {
  key: string;
  url: string;
  sizeBytes: number;
  mimeType: string;
  originalName: string;
}

function getS3Config() {
  const bucket = process.env["S3_BUCKET_NAME"]?.trim();
  const accessKeyId = process.env["S3_ACCESS_KEY_ID"]?.trim();
  const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY"]?.trim();
  const region = process.env["S3_REGION"]?.trim() || "us-east-1";
  const endpoint = process.env["S3_ENDPOINT"]?.trim();
  const publicBaseUrl = process.env["S3_PUBLIC_BASE_URL"]?.trim();
  const forcePathStyle = process.env["S3_FORCE_PATH_STYLE"] === "true";

  const isConfigured = Boolean(bucket && accessKeyId && secretAccessKey);

  return {
    isConfigured,
    bucket: bucket ?? "",
    accessKeyId: accessKeyId ?? "",
    secretAccessKey: secretAccessKey ?? "",
    region,
    endpoint: endpoint || undefined,
    publicBaseUrl: publicBaseUrl || undefined,
    forcePathStyle,
  };
}

let cachedS3Client: S3Client | null = null;

function getS3Client(): S3Client {
  const config = getS3Config();
  if (!config.isConfigured) {
    throw new S3NotConfiguredError();
  }

  if (!cachedS3Client) {
    const s3Config: {
      region: string;
      credentials: { accessKeyId: string; secretAccessKey: string };
      forcePathStyle?: boolean;
      endpoint?: string;
    } = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    };
    if (config.endpoint) {
      s3Config.endpoint = config.endpoint;
    }
    cachedS3Client = new S3Client(s3Config);
  }

  return cachedS3Client;
}

export function isS3Configured(): boolean {
  return getS3Config().isConfigured;
}

function sanitizeFileName(fileName: string): string {
  const ext = path.extname(fileName);
  const base = path
    .basename(fileName, ext)
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
  return `${base || "file"}${ext.toLowerCase()}`;
}

export async function uploadMediaFileToS3(input: {
  orgId: string;
  courseId?: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<StoredFileResult> {
  const config = getS3Config();
  if (!config.isConfigured) {
    throw new S3NotConfiguredError();
  }

  const client = getS3Client();
  const safeName = sanitizeFileName(input.fileName);
  const key = `orgs/${input.orgId}/courses/${input.courseId || "general"}/${randomUUID()}-${safeName}`;

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: input.fileBuffer,
      ContentType: input.mimeType || "application/octet-stream",
      ContentDisposition: `inline; filename="${safeName}"`,
    }),
  );

  let url: string;
  if (config.publicBaseUrl) {
    url = `${config.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
  } else if (config.endpoint && config.forcePathStyle) {
    url = `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}/${key}`;
  } else if (config.region === "us-east-1") {
    url = `https://${config.bucket}.s3.amazonaws.com/${key}`;
  } else {
    url = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
  }

  return {
    key,
    url,
    sizeBytes: input.fileBuffer.length,
    mimeType: input.mimeType,
    originalName: input.fileName,
  };
}

export async function deleteMediaFileFromS3(key: string): Promise<void> {
  const config = getS3Config();
  if (!config.isConfigured) return;

  const client = getS3Client();
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );
  } catch (err) {
    console.warn(`[storage] Failed to delete S3 object ${key}:`, err);
  }
}

export async function getPresignedDownloadUrl(
  key: string,
  expiresInSec = 3600,
): Promise<string> {
  const config = getS3Config();
  if (!config.isConfigured) {
    throw new S3NotConfiguredError();
  }

  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
  });

  return await getSignedUrl(client, command, { expiresIn: expiresInSec });
}

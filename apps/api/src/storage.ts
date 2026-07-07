import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand,
  HeadBucketCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageConfig {
  endpoint: string;
  publicEndpoint: string; // 客户端可达的地址，presign 用它
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export type Storage = ReturnType<typeof createStorage>;

export function createStorage(cfg: StorageConfig) {
  const mkClient = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  const internal = mkClient(cfg.endpoint);
  const publik = mkClient(cfg.publicEndpoint);

  return {
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch {
        await internal.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      }
    },
    async put(key: string, body: Buffer, contentType: string) {
      await internal.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async presignGet(key: string, expiresSec = 300) {
      return getSignedUrl(publik, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        expiresIn: expiresSec,
      });
    },
    async remove(keys: string[]) {
      await Promise.all(
        keys.map((key) => internal.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))),
      );
    },
  };
}

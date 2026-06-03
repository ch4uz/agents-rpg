/**
 * Read counterpart to the survey/run-archive uploader (survey-store.ts):
 * lists and downloads the run artifacts the playtests left in the GCS bucket
 * so bin/dashboard.ts can aggregate them. Like the uploader it lazy-imports
 * `@google-cloud/storage` and authenticates with ADC — locally
 * `gcloud auth application-default login`, the Vertex SA on Render. Reading
 * needs only `roles/storage.objectViewer`.
 */

// Type-only import — erased at compile time, so it never triggers the runtime
// load of @google-cloud/storage (the actual client is lazy-imported below).
import type { Bucket } from '@google-cloud/storage';

/** Minimal read surface the fetch layer depends on — faked in tests. */
export interface GcsReader {
  /** Object names (full keys) under a prefix, e.g. `runs/`. */
  list(prefix: string): Promise<string[]>;
  /** UTF-8 body of one object. Rejects if it doesn't exist. */
  download(name: string): Promise<string>;
}

export const createGcsReader = (bucket: string): GcsReader => {
  // One lazily-created Storage client shared across calls.
  let bucketRef: Promise<Bucket> | null = null;
  const getBucket = () => {
    if (!bucketRef) {
      bucketRef = import('@google-cloud/storage').then(({ Storage }) =>
        new Storage().bucket(bucket),
      );
    }
    return bucketRef;
  };

  return {
    async list(prefix) {
      const [files] = await (await getBucket()).getFiles({ prefix });
      return files.map((f) => f.name);
    },
    async download(name) {
      const [buf] = await (await getBucket()).file(name).download();
      return buf.toString('utf8');
    },
  };
};

import {
  isObjectTooLargeError,
  type StorageFacade,
} from '@scani/cloud-client/facades/storage-facade';
import { UPLOADED_FILE_MAX_BYTES } from '@scani/jobs';
import { UnrecoverableError, userFacing } from '@scani/queue';

const LIMIT_MB = UPLOADED_FILE_MAX_BYTES / 2 ** 20;

/**
 * Reads an uploaded file under the upload cap (SC-1345). An object over the
 * cap can never shrink, so the refusal ends the job on its first attempt and
 * tells the owner why (SC-1363); every other storage failure is rethrown
 * untouched, so it is still retried and still alerts.
 */
export async function readUpload(storage: StorageFacade, key: string): Promise<Buffer> {
  try {
    return await storage.read(key, { maxBytes: UPLOADED_FILE_MAX_BYTES });
  } catch (error) {
    if (!isObjectTooLargeError(error)) throw error;
    throw userFacing(
      new UnrecoverableError(`This file is larger than ${LIMIT_MB} MB. Upload a smaller file.`)
    );
  }
}

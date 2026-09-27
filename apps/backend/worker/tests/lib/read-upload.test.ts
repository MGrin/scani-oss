import { describe, expect, mock, test } from 'bun:test';
import type { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { UPLOADED_FILE_MAX_BYTES } from '@scani/jobs';
import { UnrecoverableError, userFacingMessage } from '@scani/queue';
import { readUpload } from '../../src/lib/read-upload';

function storage(read: () => Promise<Buffer>) {
  return { read: mock(read) } as unknown as StorageFacade & { read: ReturnType<typeof mock> };
}

// SC-1363: a second HEAD of the same oversized object cannot succeed, so the
// refusal must end the job on its first attempt and say why in the owner's
// words, not as `ObjectTooLarge: <key> is N bytes`.
describe('readUpload', () => {
  test('an oversized upload fails once, with a sentence the owner can act on', async () => {
    const s = storage(async () => {
      // As it reaches the worker: the data-provider's refusal, carried as text.
      throw new Error(
        `ObjectTooLarge: temp/import/u/a.csv is ${9 * 2 ** 20} bytes, over the ${UPLOADED_FILE_MAX_BYTES}-byte limit`
      );
    });
    const err = await readUpload(s, 'temp/import/u/a.csv').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toContain('8 MB');
  });

  test('reads with the upload cap and returns the bytes', async () => {
    const s = storage(async () => Buffer.from('ok'));
    expect((await readUpload(s, 'k')).toString()).toBe('ok');
    expect(s.read).toHaveBeenCalledWith('k', { maxBytes: UPLOADED_FILE_MAX_BYTES });
  });

  // The control: any other storage failure is still retried and still alerts.
  test('any other storage failure is rethrown untouched', async () => {
    const boom = new Error('R2 answered 503');
    const err = await readUpload(
      storage(async () => {
        throw boom;
      }),
      'k'
    ).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBeNull();
  });
});

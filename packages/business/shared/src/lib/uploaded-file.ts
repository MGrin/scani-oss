// The one upload ceiling: the field refuses past it when a file is chosen, the
// presign route when one is authorised, and every processor when it reads.
export const UPLOADED_FILE_MAX_BYTES = 8 * 1024 * 1024;

// A backup file the person uploads to restore (SC-1649). Larger than the one
// ceiling above: the largest account measured backs up to about 10 MB.
export const BACKUP_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

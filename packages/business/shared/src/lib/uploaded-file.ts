// The one upload ceiling: the field refuses past it when a file is chosen, the
// presign route when one is authorised, and every processor when it reads.
export const UPLOADED_FILE_MAX_BYTES = 8 * 1024 * 1024;

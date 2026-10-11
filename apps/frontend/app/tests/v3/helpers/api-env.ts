// Imported first by a spec whose subject reaches `api-base-url.ts` or the auth
// client: both read the variable once at module load, and neither the DOM
// child nor the public mirror's CI has a `.env` to supply it.
process.env.VITE_API_URL ??= 'http://api.test';

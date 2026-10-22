// Optional embedded PostgreSQL verification. No network, credentials or persistent database.
// Install @electric-sql/pglite in a disposable tools environment, then set
// MORTUARY_PGLITE_MODULE to that module's absolute ESM entrypoint if not locally resolvable.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const { PGlite } = await import(process.env.MORTUARY_PGLITE_MODULE || '@electric-sql/pglite');
const root = fileURLToPath(new URL('..', import.meta.url));
const database = new PGlite();
try {
  for (const path of ['supabase/tests/mortuary_stub_base.sql', 'supabase/migrations/015_mortuary_cases.sql', 'supabase/tests/mortuary_015_test.sql']) {
    const sql = (await readFile(resolve(root, path), 'utf8')).replace(/^\\.*$/gm, '');
    await database.exec(sql);
    console.log(`${path}: PASS`);
  }
} finally { await database.close(); }

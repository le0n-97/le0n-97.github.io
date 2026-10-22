import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, '.sites-runtime', 'game-tests');
await mkdir(runtime, { recursive: true });
for (const [source, target] of [
  ['lib/puzzles.ts', 'puzzles.mjs'],
  ['lib/dictionary-data.ts', 'dictionary-data.mjs'],
  ['lib/board-generator.ts', 'board-generator.mjs'],
  ['lib/word-routes.ts', 'word-routes.mjs'],
  ['lib/game.ts', 'game.mjs'],
  ['lib/game-records.ts', 'game-records.mjs'],
  ['lib/records-admin.ts', 'records-admin.mjs'],
  ['lib/chat.ts', 'chat.mjs'],
  ['lib/accounts.ts', 'accounts.mjs'],
  ['lib/account-policy.ts', 'account-policy.mjs'],
  ['lib/api-client.ts', 'api-client.mjs'],
  ['lib/account-request.ts', 'account-request.mjs'],
  ['lib/rating.ts', 'rating.mjs'],
  ['lib/rating-store.ts', 'rating-store.mjs'],
  ['lib/leaderboard.ts', 'leaderboard.mjs'],
  ['lib/leaderboard-types.ts', 'leaderboard-types.mjs'],
  ['lib/legacy-site.ts', 'legacy-site.mjs'],
  ['lib/api-cors.ts', 'api-cors.mjs'],
  ['lib/drag-selection.ts', 'drag-selection.mjs'],
  ['lib/action-queue.ts', 'action-queue.mjs'],
  ['lib/board-rotation.ts', 'board-rotation.mjs'],
  ['app/api/game/route.ts', 'route.mjs'],
  ['app/api/admin/records/route.ts', 'records-route.mjs'],
  ['app/api/chat/route.ts', 'chat-route.mjs'],
  ['app/api/account/route.ts', 'account-route.mjs'],
  ['app/api/leaderboard/route.ts', 'leaderboard-route.mjs'],
]) {
  const input = await readFile(path.join(root, source), 'utf8');
  const result = ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName: source,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n',
  }));
  const output = result.outputText
    .replace(/(['"])\.\/([a-z][\w-]*)\1/g, "'./$2.mjs'")
    .replace(/(['"])@\/lib\/([a-z][\w-]*)\1/g, "'./$2.mjs'")
    .replace(/import\.meta\.env\.DEV/g, '(globalThis.__adminRecordsDev ?? false)')
    .replace(/(['"])cloudflare:workers\1/g, "'./api-env.mjs'");
  await writeFile(path.join(runtime, target), output);
}
await writeFile(path.join(runtime, 'api-env.mjs'), 'export const env = { get DB() { return globalThis.__gameTestDB; } };\n');
const result = spawnSync(process.execPath, [
  '--test', '--test-concurrency=1',
  'tests/pages-site.test.mjs',
  'tests/game.test.mjs', 'tests/api.test.mjs', 'tests/accounts.test.mjs', 'tests/account-request.test.mjs', 'tests/rating.test.mjs', 'tests/rating-api.test.mjs', 'tests/leaderboard.test.mjs', 'tests/pages-cors.test.mjs', 'tests/teams.test.mjs', 'tests/records.test.mjs', 'tests/chat.test.mjs', 'tests/generation.test.mjs', 'tests/word-routes.test.mjs', 'tests/drag-selection.test.mjs', 'tests/client-interactions.test.mjs',
], {
  cwd: root,
  env: { ...process.env, SQUARES_TEST_RUNTIME: runtime },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

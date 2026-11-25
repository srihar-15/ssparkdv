import { spawnSync } from 'node:child_process';

for (const [surface, outDir] of [['store', 'dist/store'], ['staff', 'dist/admin']]) {
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', outDir], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, VITE_APP_SURFACE: surface },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

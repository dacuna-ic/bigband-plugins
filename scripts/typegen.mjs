import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const connection = JSON.parse(
  execFileSync('bigband', ['surrealdb', 'address'], { encoding: 'utf8' }),
);
const jsonOutput = join(
  tmpdir(),
  `bigband-surrealkit-${process.pid}-${Date.now()}.json`,
);

let exitCode;
try {
  const result = spawnSync(
    'surrealkit',
    [
      'typegen',
      '--host', connection.address,
      '--ns', connection.namespace,
      '--db', connection.database,
      '--user', connection.username,
      '--pass', connection.password,
      '--auth-level', 'database',
      '--out', jsonOutput,
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  rmSync(jsonOutput, { force: true });
}

process.exitCode = exitCode;

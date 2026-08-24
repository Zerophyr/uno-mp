import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectEnvironment = {
  ...process.env,
  TURN_DURATION_MS: process.env.TURN_DURATION_MS || '5000',
};
const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: projectEnvironment,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}

function inspectHealth() {
  const result = spawnSync(
    'docker',
    ['inspect', '--format', '{{.State.Health.Status}}', 'uno-mp'],
    { cwd: process.cwd(), env: projectEnvironment, encoding: 'utf8' },
  );
  return result.status === 0 ? result.stdout.trim() : 'missing';
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  run('docker', ['compose', 'up', '--build', '-d']);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && inspectHealth() !== 'healthy') await wait(1_000);
  if (inspectHealth() !== 'healthy') throw new Error('UNO MP did not become healthy within 90 seconds.');
  run(process.execPath, [playwrightCli, 'test']);
} finally {
  spawnSync('docker', ['compose', 'down', '-v'], {
    cwd: process.cwd(),
    env: projectEnvironment,
    stdio: 'inherit',
  });
}

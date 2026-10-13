import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tests = ['backend', 'client', 'stream', 'validation'].map((name) =>
  fileURLToPath(new URL(`./tests/${name}.test.mjs`, import.meta.url)),
);
const child = spawn(process.execPath, ['--test', ...tests], {
  stdio: 'inherit',
  env: {
    ...process.env,
    no_grpc_proxy: [process.env.no_grpc_proxy, '127.0.0.1', 'localhost']
      .filter(Boolean)
      .join(','),
  },
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});

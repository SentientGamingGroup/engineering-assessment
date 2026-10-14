// Start the two local listeners. The round service is the Go gRPC server in
// service-go/, built and supervised by start-go-grpc.mjs.
import { createClient } from '../lib/grpc.mjs';
import { startGoService } from './start-go-grpc.mjs';
import { createGateway } from './gateway.mjs';

// Fail fast on a malformed setting rather than run with a NaN port or deadline.
const intEnv = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    console.error(`Invalid ${name}=${JSON.stringify(raw)}: expected an integer from ${min} to ${max}.`);
    process.exit(1);
  }
  return Number(raw);
};
const port = intEnv('PORT', 4400, 0, 65535);
const grpcPort = intEnv('GRPC_PORT', 4402, 1, 65535);
const roundDelayMs = intEnv('ROUND_DELAY_MS', 1200, 0, 2 ** 31 - 1);
const timeoutMs = intEnv('GRPC_TIMEOUT_MS', 300, 1, 2 ** 31 - 1);

const client = createClient(grpcPort);
const service = await startGoService(client, {
  grpcPort, roundDelayMs, dataDir: process.env.DATA_DIR || './data/service',
});
const gateway = createGateway(client, { timeoutMs });
await new Promise(resolve => gateway.listen(port, '127.0.0.1', resolve));
console.log(`Beacon Relay: http://127.0.0.1:${gateway.address().port}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    gateway.stopStream();
    gateway.closeAllConnections();
    gateway.close();
    client.close();
    await service.close();
    process.exit(0);
  });
}

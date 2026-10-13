// Both service listeners are local. Never route local gRPC through a host proxy.
import { listenGrpc, createClient } from '../lib/grpc.mjs';
import { createService } from './service.mjs';
import { createGateway } from './gateway.mjs';
process.env.no_grpc_proxy = [
  process.env.no_grpc_proxy,
  '127.0.0.1',
  'localhost',
]
  .filter(Boolean)
  .join(',');
let service, rpc, client, gateway;
function stop() {
  gateway?.stopStream();
  gateway?.closeAllConnections();
  gateway?.close();
  client?.close();
  rpc?.forceShutdown();
  service?.close();
}
try {
  service = await createService({
    dataDir: process.env.DATA_DIR || './data/service',
    roundDelayMs: Number(process.env.ROUND_DELAY_MS || 1200),
  });
  rpc = await listenGrpc(
    service.handlers,
    Number(process.env.GRPC_PORT || 4402),
  );
  client = createClient(rpc.boundPort);
  gateway = createGateway(client);
  await new Promise((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(Number(process.env.PORT || 4400), '127.0.0.1', resolve);
  });
  console.log(`Beacon Relay: http://127.0.0.1:${gateway.address().port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
} catch (error) {
  console.error('Startup failed:', error.message);
  stop();
  process.exitCode = 1;
}

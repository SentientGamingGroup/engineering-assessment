// Start the two local listeners. Implement service.mjs and stream.mjs.
import { listenGrpc, createClient } from '../lib/grpc.mjs';
import { createService } from './service.mjs';
import { createGateway } from './gateway.mjs';
const service = await createService({
  dataDir: process.env.DATA_DIR || './data/service',
  roundDelayMs: Number(process.env.ROUND_DELAY_MS || 1200),
});
const rpc = await listenGrpc(service.handlers, Number(process.env.GRPC_PORT || 4402));
const client = createClient(Number(process.env.GRPC_PORT || 4402));
const gateway = createGateway(client);
await new Promise(resolve => gateway.listen(Number(process.env.PORT || 4400), '127.0.0.1', resolve));
console.log(`Beacon Relay: http://127.0.0.1:${gateway.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    gateway.stopStream();
    gateway.closeAllConnections();
    gateway.close();
    client.close();
    rpc.forceShutdown();
    service.close?.();
    process.exit(0);
  });
}

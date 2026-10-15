// Composition root: config → service → gRPC server → gRPC client → HTTP/WS gateway.
import { createClient, listenGrpc } from '../lib/grpc.mjs';
import { loadConfig } from './config.mjs';
import { createGateway } from './gateway.mjs';
import { createService } from './service.mjs';

const config = loadConfig();
const service = await createService({ dataDir: config.dataDir, roundDelayMs: config.roundDelayMs });
const rpc = await listenGrpc(service.handlers, config.grpcPort);
const client = createClient(config.grpcPort);
const gateway = createGateway(client, { timeoutMs: config.grpcTimeoutMs });
await new Promise(resolve => gateway.listen(config.port, config.host, resolve));
console.log(`Beacon Relay: http://${config.host}:${gateway.address().port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    gateway.stopStream();
    gateway.closeAllConnections();
    gateway.close();
    client.close();
    rpc.forceShutdown();
    service.close();
    process.exit(0);
  });
}

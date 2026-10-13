// Wire bindings only. The candidate implements authoritative domain behavior.
import grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
const definition = loadSync(fileURLToPath(new URL('../contracts/rounds.proto', import.meta.url)), {
  keepCase: false, longs: Number, enums: String, defaults: false, oneofs: false,
});
export const RoundService = grpc.loadPackageDefinition(definition).assessment.RoundService;
export { grpc };
export function createClient(port) {
  return new RoundService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}
export function call(client, method, payload, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    client[method](payload, { deadline: Date.now() + timeoutMs }, (error, result) => {
      if (error) reject(error); else resolve(result);
    });
  });
}
export async function listenGrpc(handlers, port) {
  const server = new grpc.Server();
  server.addService(RoundService.service, handlers);
  await new Promise((resolve, reject) => {
    server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => {
        if (error) reject(error);
        else { server.boundPort = boundPort; resolve(); }
      });
  });
  return server;
}

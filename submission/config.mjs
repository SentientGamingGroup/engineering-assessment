// Runtime configuration. Defaults come from ASSIGNMENT.md ("Runtime").
const integer = (name, value, fallback) => {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
};

export function loadConfig(env = process.env) {
  return Object.freeze({
    host: '127.0.0.1',
    port: integer('PORT', env.PORT, 4400),
    grpcPort: integer('GRPC_PORT', env.GRPC_PORT, 4402),
    dataDir: env.DATA_DIR || './data/service',
    roundDelayMs: integer('ROUND_DELAY_MS', env.ROUND_DELAY_MS, 1200),
    grpcTimeoutMs: integer('GRPC_TIMEOUT_MS', env.GRPC_TIMEOUT_MS, 300),
  });
}

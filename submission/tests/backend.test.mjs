import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSystem, waitFor, request } from '../../scripts/support.mjs';
import { createService, targetFor } from '../service.mjs';
import { createGateway } from '../gateway.mjs';
import { listenGrpc, createClient, grpc } from '../../lib/grpc.mjs';

const intent = (requestId, playerId = requestId, choice = 0) => ({
  requestId,
  playerId,
  choice,
});
const invoke = (service, method, payload) =>
  new Promise((resolve, reject) => {
    service.handlers[method]({ request: payload }, (error, value) =>
      error ? reject(error) : resolve(value),
    );
  });
async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-candidate-'));
  try {
    await run(directory);
  } finally {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('beacon-candidate-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('20 concurrent retries create one round; 10 players progress; crash never duplicates completion', async () => {
  const system = await createSystem({ roundDelayMs: 600 });
  try {
    await system.start();
    const duplicates = await Promise.all(
      Array.from({ length: 20 }, () =>
        system.rpc('startRound', intent('duplicate', 'same_player', 2)),
      ),
    );
    assert.equal(new Set(duplicates.map((r) => r.roundId)).size, 1);
    const rounds = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        system.rpc('startRound', intent(`p_${i}`)),
      ),
    );
    assert.equal(new Set(rounds.map((r) => r.roundId)).size, 10);
    await system.stop(true);
    await delay(650);
    await system.start();
    await waitFor(
      async () =>
        (await system.rpc('listEvents', { after: 0 })).events?.length === 22,
      'all recovered completions',
    );
    const first = await system.rpc('listEvents', { after: 0 });
    assert.deepEqual(
      first.events.map((e) => e.sequence),
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
    for (const round of [...rounds, duplicates[0]]) {
      const events = first.events.filter(
        (e) => e.round.roundId === round.roundId,
      );
      assert.deepEqual(
        events.map((e) => e.type),
        ['round.accepted', 'round.completed'],
      );
      assert.equal(events[0].round.status, 'accepted');
      assert.equal('target' in events[0].round, false);
      assert.equal(events[1].round.target, targetFor(round.roundId));
      assert.ok(
        Date.parse(events[1].round.completedAt) >=
          Date.parse(round.createdAt) + 600,
      );
    }
    await system.stop(true);
    await system.start();
    await delay(150);
    assert.deepEqual(await system.rpc('listEvents', { after: 0 }), first);
    assert.equal(
      (await system.rpc('startRound', intent('duplicate', 'same_player', 2)))
        .roundId,
      duplicates[0].roundId,
    );
  } finally {
    await system.close();
  }
});

test('recovery retains original deadline despite changed configuration and ignores an unfinished replacement', async () =>
  isolated(async (directory) => {
    let service = await createService({
      dataDir: directory,
      roundDelayMs: 350,
    });
    try {
      const round = await invoke(service, 'startRound', intent('original'));
      service.close();
      await writeFile(join(directory, 'state.next'), '{unfinished');
      service = await createService({ dataDir: directory, roundDelayMs: 1 });
      assert.equal(
        (await invoke(service, 'getRound', { roundId: round.roundId })).status,
        'accepted',
      );
      await waitFor(
        async () =>
          (await invoke(service, 'getRound', { roundId: round.roundId }))
            .status === 'completed',
        'original deadline',
      );
      const completed = await invoke(service, 'getRound', {
        roundId: round.roundId,
      });
      assert.ok(
        Date.parse(completed.completedAt) - Date.parse(round.createdAt) >= 350,
      );
      assert.equal(
        (await invoke(service, 'listEvents', { after: 0 })).events.length,
        2,
      );
    } finally {
      service.close();
    }
  }));

test('a second state owner and corrupt committed state fail explicitly', async () =>
  isolated(async (directory) => {
    const service = await createService({
      dataDir: directory,
      roundDelayMs: 100,
    });
    try {
      await assert.rejects(
        createService({ dataDir: directory, roundDelayMs: 100 }),
        /already owned/,
      );
    } finally {
      service.close();
    }
    await writeFile(join(directory, 'state.json'), '{corrupt');
    await assert.rejects(
      createService({ dataDir: directory, roundDelayMs: 100 }),
      SyntaxError,
    );
  }));

test('gRPC default choice/limit, conflicts, and paginated history preserve zero fields', async () =>
  isolated(async (directory) => {
    const service = await createService({
      dataDir: directory,
      roundDelayMs: 10,
    });
    try {
      const round = await invoke(service, 'startRound', {
        requestId: 'default',
        playerId: 'default',
      });
      assert.equal(round.choice, 0);
      assert.equal('score' in round, false);
      await assert.rejects(
        invoke(service, 'startRound', intent('default', 'other')),
        (e) => e.code === grpc.status.ALREADY_EXISTS,
      );
      await assert.rejects(
        invoke(service, 'listEvents', { limit: 101 }),
        (e) => e.details === 'INVALID_CURSOR',
      );
      for (let i = 0; i < 55; i++)
        await invoke(service, 'startRound', intent(`page_${i}`));
      await waitFor(
        async () =>
          (await invoke(service, 'listEvents', { after: 100 })).events
            .length === 12,
        'paginated completions',
      );
      const page1 = await invoke(service, 'listEvents', { after: 0, limit: 0 });
      const page2 = await invoke(service, 'listEvents', {
        after: page1.nextCursor,
        limit: 100,
      });
      assert.equal(page1.events.length, 100);
      assert.equal(page2.events.length, 12);
      assert.equal(page2.nextCursor, 112);
      const disk = JSON.parse(
        await readFile(join(directory, 'state.json'), 'utf8'),
      );
      assert.deepEqual(disk.events, [...page1.events, ...page2.events]);
      const empty = await invoke(service, 'listEvents', { after: 4294967295 });
      assert.deepEqual(empty, { events: [], nextCursor: 4294967295 });
    } finally {
      service.close();
    }
  }));

test('a real gateway deadline can hide acceptance; retrying the same identity recovers one round', async () =>
  isolated(async (directory) => {
    const service = await createService({
      dataDir: directory,
      roundDelayMs: 200,
    });
    let delayed = true;
    const rpc = await listenGrpc(
      {
        ...service.handlers,
        startRound: (call, callback) => {
          service.handlers.startRound(call, (error, value) => {
            if (delayed) {
              delayed = false;
              setTimeout(() => callback(error, value), 150);
            } else callback(error, value);
          });
        },
      },
      0,
    );
    const client = createClient(rpc.boundPort);
    const previous = process.env.GRPC_TIMEOUT_MS;
    process.env.GRPC_TIMEOUT_MS = '40';
    const gateway = createGateway(client);
    if (previous === undefined) delete process.env.GRPC_TIMEOUT_MS;
    else process.env.GRPC_TIMEOUT_MS = previous;
    try {
      await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${gateway.address().port}`;
      const first = await request(url, '/rounds', {
        method: 'POST',
        body: intent('timeout'),
      });
      assert.deepEqual(first, {
        status: 504,
        body: { error: { code: 'UPSTREAM_TIMEOUT' } },
      });
      const retry = await request(url, '/rounds', {
        method: 'POST',
        body: intent('timeout'),
      });
      assert.equal(retry.status, 202);
      await waitFor(
        async () =>
          (await invoke(service, 'getRound', { roundId: retry.body.roundId }))
            .status === 'completed',
        'deadline round completion',
      );
      const events = await invoke(service, 'listEvents', {});
      assert.equal(events.events.length, 2);
      assert.equal(new Set(events.events.map((e) => e.round.roundId)).size, 1);
    } finally {
      gateway.stopStream();
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
      client.close();
      rpc.forceShutdown();
      service.close();
    }
  }));

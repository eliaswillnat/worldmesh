import { describe, expect, it } from 'vitest';
import {
  isOverAllowanceSignal,
  isRoomFullSignal,
  occupancyIsFull,
  occupancyProbeUrl,
  probeRoom,
  probeRoomFull,
  roomFullLabel,
  type ProbeFetch,
} from '../../../packages/runtime/src/net/roomFull.ts';

describe('roomFullLabel', () => {
  it('names the lobby for a named room URL', () => {
    expect(roomFullLabel('wss://relay.worldmesh.net/room/lobby')).toBe('Lobby is full');
  });

  it('names a world for /world', () => {
    expect(roomFullLabel('wss://relay.worldmesh.net/world')).toBe('World is full');
  });
});

describe('isRoomFullSignal', () => {
  it('treats HTTP 503 and the relay body as full', () => {
    expect(isRoomFullSignal({ status: 503 })).toBe(true);
    expect(isRoomFullSignal({ body: 'Room is full' })).toBe(true);
    expect(isRoomFullSignal({ reason: 'Room is full' })).toBe(true);
  });

  it('does not treat a generic close as full', () => {
    expect(isRoomFullSignal({ code: 1006, reason: '' })).toBe(false);
    expect(isRoomFullSignal({ message: 'WebSocket connection failed' })).toBe(false);
  });
});

describe('occupancyProbeUrl', () => {
  it('asks /occupancy for the named lobby', () => {
    expect(occupancyProbeUrl('wss://relay.worldmesh.net/room/lobby')).toBe(
      'https://relay.worldmesh.net/occupancy?rooms=lobby',
    );
  });

  it('asks /occupancy for this page origin on /world', () => {
    expect(occupancyProbeUrl('wss://relay.worldmesh.net/world', 'https://Forest.example')).toBe(
      'https://relay.worldmesh.net/occupancy?origins=https%3A%2F%2FForest.example',
    );
  });
});

describe('occupancyIsFull', () => {
  it('reads room:lobby and world origins', () => {
    expect(
      occupancyIsFull({ 'room:lobby': { count: 64, cap: 64 } }, 'wss://relay.example/room/lobby'),
    ).toBe(true);
    expect(
      occupancyIsFull({ 'room:lobby': { count: 63, cap: 64 } }, 'wss://relay.example/room/lobby'),
    ).toBe(false);
    expect(
      occupancyIsFull(
        { 'https://forest.example': { count: 16, cap: 16 } },
        'wss://relay.example/world',
        'https://forest.example',
      ),
    ).toBe(true);
  });
});

describe('probeRoomFull', () => {
  it('detects a same-path 503 when the browser cannot see the upgrade status', async () => {
    const fetchFn: ProbeFetch = async (input) => {
      const url = String(input);
      if (url === 'https://relay.worldmesh.net/room/lobby') {
        return new Response('Room is full', { status: 503 });
      }
      throw new Error(`unexpected ${url}`);
    };
    await expect(probeRoomFull('wss://relay.worldmesh.net/room/lobby', undefined, fetchFn)).resolves.toBe(true);
  });

  it('falls back to /occupancy when the same-path GET is still 426', async () => {
    const fetchFn: ProbeFetch = async (input) => {
      const url = String(input);
      if (url === 'https://relay.worldmesh.net/room/lobby') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      if (url === 'https://relay.worldmesh.net/occupancy?rooms=lobby') {
        return new Response(JSON.stringify({ 'room:lobby': { count: 64, cap: 64 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await expect(probeRoomFull('wss://relay.worldmesh.net/room/lobby', undefined, fetchFn)).resolves.toBe(true);
  });

  it('is not full on a transient failure', async () => {
    const fetchFn = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(probeRoomFull('wss://relay.worldmesh.net/room/lobby', undefined, fetchFn)).resolves.toBe(false);
  });
});

describe('probeRoom', () => {
  const world = 'wss://relay.worldmesh.net/world';

  it('tells a world past its daily allowance apart from a full room', async () => {
    const fetchFn: ProbeFetch = async (input) => {
      if (String(input) === 'https://relay.worldmesh.net/world') {
        return new Response("This world has used today's free multiplayer allowance on the shared WorldMesh relay.", { status: 429 });
      }
      throw new Error(`unexpected ${input}`);
    };
    await expect(probeRoom(world, 'https://forest.example', fetchFn)).resolves.toBe('allowance');
    await expect(probeRoomFull(world, 'https://forest.example', fetchFn)).resolves.toBe(false);
  });

  it('treats a plain rate limit as a blip, not the allowance', async () => {
    const fetchFn: ProbeFetch = async (input) => {
      const url = String(input);
      if (url === 'https://relay.worldmesh.net/world') return new Response('Too many requests', { status: 429 });
      if (url.startsWith('https://relay.worldmesh.net/occupancy')) return new Response('Too many requests', { status: 429 });
      throw new Error(`unexpected ${url}`);
    };
    await expect(probeRoom(world, 'https://forest.example', fetchFn)).resolves.toBe('open');
  });

  it('still reports a full room', async () => {
    const fetchFn: ProbeFetch = async () => new Response('Room is full', { status: 503 });
    await expect(probeRoom(world, 'https://forest.example', fetchFn)).resolves.toBe('full');
  });
});

describe('isOverAllowanceSignal', () => {
  it('needs both the 429 and the word allowance', () => {
    expect(isOverAllowanceSignal({ status: 429, body: 'free multiplayer allowance' })).toBe(true);
    expect(isOverAllowanceSignal({ status: 429, body: 'Too many requests' })).toBe(false);
    expect(isOverAllowanceSignal({ status: 503, body: 'allowance' })).toBe(false);
  });
});

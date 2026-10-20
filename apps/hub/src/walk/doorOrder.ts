import type { WorldRecordInput } from '../worlds/listing';

/** What deciding a world's door needs to know about it. */
export type DoorOrderWorld = Pick<WorldRecordInput, 'url' | 'addedAt' | 'approvedAt' | 'tags' | 'source'>;

/**
 * Which worlds get a door, and where. Multiplayer worlds go inside (the
 * newest first), unless they have a building of their own (`outside`): a
 * building stands in the city. The demos always have one, so they never go
 * inside. Every other world goes out into the city, along its grid of
 * avenues and streets (avenuePlan), the most entered nearest the hall and
 * the least entered furthest out: solo worlds, worlds with a building, the
 * demos, and multiplayer worlds that did not fit inside. Ties break on the newest, then the URL, so everyone with the same
 * list and counts gets the same doors. The rotunda's outer wall has none.
 */
export function assignDoors<World extends DoorOrderWorld>(
  worlds: World[],
  inside: number,
  entries: (url: string) => number | undefined = () => undefined,
  outside: (url: string) => boolean = () => false,
): { inside: string[]; city: string[] } {
  const listed = (world: World) => Date.parse(world.addedAt ?? world.approvedAt ?? '') || 0;
  const order = (a: World, b: World) =>
    Number(b.source === 'demo') - Number(a.source === 'demo') || listed(b) - listed(a) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  const inHall = (world: World) => (world.tags?.includes('multiplayer') ?? false) && world.source !== 'demo' && !outside(world.url);
  const within = worlds.filter(inHall).sort(order).slice(0, inside);
  const taken = new Set(within);
  const entered = (world: World) => entries(world.url) ?? 0;
  const city = worlds.filter((world) => !taken.has(world)).sort((a, b) => entered(b) - entered(a) || order(a, b));
  const url = (world: World) => world.url;
  return { inside: within.map(url), city: city.map(url) };
}

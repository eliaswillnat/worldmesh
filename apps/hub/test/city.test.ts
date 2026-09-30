import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../src/worlds/categories';
import { DEFAULT_CITY_CONFIG } from '../src/towers/config';
import cityData from '../src/towers/city.json';
import { angularDistance, distributeDoors, planCity } from '../src/towers/plan';
import { ShutterMachine, type ShutterCue } from '../src/towers/shutter';

const config = DEFAULT_CITY_CONFIG;

describe('city plan', () => {
  const plan = planCity(CATEGORIES, cityData, new Map([['explore', 5]]), config, 20);

  it('builds a tower per category, standing clear of each other', () => {
    expect(plan.towers.map((t) => t.id).sort()).toEqual(CATEGORIES.list.map((c) => c.id).sort());
    for (const a of plan.towers) {
      for (const b of plan.towers) {
        if (a === b) continue;
        expect(Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z)).toBeGreaterThan(config.towerRadius * 4);
      }
    }
  });

  it('connects towers through bridges without linking every pair', () => {
    expect(plan.bridges).toHaveLength(2);
    const games = plan.tower('games')!;
    const space = plan.tower('space')!;
    expect(plan.bridges.some((b) => [b.from, b.to].includes(games.id) && [b.from, b.to].includes(space.id))).toBe(false);
  });

  it('gives every floor a band, with desirable bands low, middle and high', () => {
    const tower = plan.tower('explore')!;
    const bands = tower.floors.map((f) => f.band);
    expect(bands[0]).toBe('lower');
    expect(tower.floors[config.bridgeInterval].kind).toBe('transfer');
    expect(bands[config.bridgeInterval - 1]).toBe('middle');
    expect(bands[tower.floorCount - 1]).toBe('summit');
    expect(bands).toContain('regular');
  });

  it('puts the bridge mouth on the transfer floor and keeps doors clear of it', () => {
    for (const bridge of plan.bridges) {
      for (const towerId of [bridge.from, bridge.to]) {
        const floor = plan.tower(towerId)!.floors[bridge.floor];
        const mouth = floor.positions.find((p) => p.kind === 'bridge' && p.bridgeId === bridge.id)!;
        expect(mouth).toBeTruthy();
        for (const door of floor.positions.filter((p) => p.kind === 'door')) {
          expect(angularDistance(door.angle, mouth.angle)).toBeGreaterThanOrEqual(door.halfWidth + mouth.halfWidth - 1e-6);
        }
      }
    }
  });

  it('gives each door a unique placement slot', () => {
    const ids = plan.towers.flatMap((t) => t.floors.flatMap((f) => f.slots.map((s) => s.id)));
    expect(new Set(ids).size).toBe(ids.length);
    const standard = plan.tower('explore')!.floors.find((f) => f.kind === 'standard')!;
    expect(standard.slots).toHaveLength(config.doorsPerFloor.standard);
  });

  it('grows floors with inventory', () => {
    const big = planCity(CATEGORIES, cityData, new Map([['games', 5000]]), config, 20);
    expect(big.tower('games')!.floorCount).toBeGreaterThan(plan.tower('games')!.floorCount);
    expect(big.tower('games')!.floorCount).toBeLessThanOrEqual(config.maxFloors);
  });
});

describe('door distribution', () => {
  it('spreads doors evenly in the free wall and never over a feature', () => {
    const features = [{ angle: 0, halfWidth: 0.3 }, { angle: Math.PI, halfWidth: 0.3 }];
    const doors = distributeDoors(features, 6, 0.1);
    expect(doors).toHaveLength(6);
    for (const angle of doors) {
      for (const feature of features) expect(angularDistance(angle, feature.angle)).toBeGreaterThanOrEqual(0.4 - 1e-9);
    }
  });

  it('returns fewer doors when they do not fit', () => {
    expect(distributeDoors([{ angle: 0, halfWidth: 3 }], 8, 0.2).length).toBeLessThan(8);
  });
});

describe('shutter', () => {
  it('closes, swaps while shut, waits for the new content, then opens', () => {
    const cues: ShutterCue[] = [];
    const shutter = new ShutterMachine({ closeS: 0.8, holdS: 0.4, openS: 0.9 }, (cue) => cues.push(cue));
    let swapped = false;
    shutter.cycle(() => (swapped = true), { waitForReady: true });
    for (let i = 0; i < 10; i++) shutter.update(0.1);
    expect(shutter.state).toBe('closed');
    expect(swapped).toBe(true);
    for (let i = 0; i < 10; i++) shutter.update(0.1);
    expect(shutter.state).toBe('closed');
    shutter.markReady();
    shutter.update(0.1);
    expect(shutter.state).toBe('opening');
    for (let i = 0; i < 10; i++) shutter.update(0.1);
    expect(shutter.state).toBe('open');
    expect(cues).toEqual(['close-start', 'closed', 'open-start', 'opened']);
  });

  it('drops from open to fully shut, monotonically until the settle', () => {
    const shutter = new ShutterMachine({ closeS: 1, holdS: 0, openS: 1 });
    shutter.cycle(() => {});
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const amount = shutter.update(0.1);
      expect(amount).toBeGreaterThanOrEqual(last);
      last = amount;
    }
    expect(last).toBeGreaterThan(0.9);
  });

  it('stays shut for an empty slot', () => {
    const shutter = new ShutterMachine({ closeS: 0.2, holdS: 0.1, openS: 0.2 });
    shutter.cycle(() => {}, { stayClosed: true });
    for (let i = 0; i < 20; i++) shutter.update(0.1);
    expect(shutter.state).toBe('closed');
  });
});

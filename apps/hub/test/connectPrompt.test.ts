import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONNECT_PROMPT } from '../src/connectPrompt';

const creatorsHtml = readFileSync(new URL('../public/creators.html', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../public/connect.md', import.meta.url), 'utf8');

describe('connect prompt', () => {
  it('is the same on the homepage and on /creators', () => {
    const shown = creatorsHtml.match(/<div class="prompt-text" id="prompt">([\s\S]*?)<\/div>/)?.[1];
    expect(shown).toBe(CONNECT_PROMPT);
  });

  it('points at the guide and needs no HTML escaping', () => {
    expect(CONNECT_PROMPT).toContain('https://worldmesh.net/connect.md');
    expect(CONNECT_PROMPT).not.toMatch(/[<>&]/);
  });

  it('keeps third-party worlds off the relay WorldMesh hosts', () => {
    // Code the guide tells agents to write never turns on the hosted relay.
    expect(guide).not.toMatch(/^\s*multiplayer:\s*true/m);
    expect(guide).toContain("multiplayer: { server: 'wss://");
  });
});

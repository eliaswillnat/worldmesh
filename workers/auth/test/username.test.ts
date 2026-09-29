import { describe, expect, it } from 'vitest';
import { checkUsername } from '../src/username';

describe('checkUsername', () => {
  it('normalises case and a leading @', () => {
    expect(checkUsername('  @Elias_W ')).toEqual({ ok: true, username: 'elias_w' });
  });

  it.each([
    'ab', // too short
    'a'.repeat(31), // too long
    '1elias', // must start with a letter
    '_elias',
    'eli.as',
    'eli-as',
    'élias', // ASCII only: no lookalikes
    'elias​',
    '',
    '   ',
  ])('rejects %j', (input) => {
    expect(checkUsername(input).ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(checkUsername(undefined).ok).toBe(false);
    expect(checkUsername(42).ok).toBe(false);
    expect(checkUsername({ toString: () => 'elias' }).ok).toBe(false);
  });

  it.each(['admin', 'Support', 'worldmesh', 'worldmesh_team', 'inbox', 'followers'])('reserves %j', (input) => {
    expect(checkUsername(input)).toEqual({ ok: false, error: 'That username is reserved.' });
  });
});

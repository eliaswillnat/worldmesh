import { describe, expect, it } from 'vitest';
import {
  PRESENCE_TICKET_TTL_S,
  signPresenceTicket,
  verifyPresenceTicket,
} from '../../presence/src/ticket';

const SECRET = 'presence-secret-presence-secret-1234';
const NOW = Date.parse('2026-09-30T16:00:00Z');

describe('presence tickets', () => {
  it('vouch for the username they were signed for', async () => {
    const ticket = await signPresenceTicket(SECRET, 'elias', NOW);
    expect(await verifyPresenceTicket(SECRET, ticket, NOW)).toBe('elias');
    expect(ticket.length).toBeLessThan(256);
  });

  it('expire', async () => {
    const ticket = await signPresenceTicket(SECRET, 'elias', NOW);
    expect(await verifyPresenceTicket(SECRET, ticket, NOW + (PRESENCE_TICKET_TTL_S - 1) * 1000)).toBe('elias');
    expect(await verifyPresenceTicket(SECRET, ticket, NOW + PRESENCE_TICKET_TTL_S * 1000)).toBeNull();
  });

  it('refuse a ticket signed with another secret', async () => {
    const ticket = await signPresenceTicket('another-secret-another-secret-12345', 'elias', NOW);
    expect(await verifyPresenceTicket(SECRET, ticket, NOW)).toBeNull();
  });

  it('refuse a forged username', async () => {
    const ticket = await signPresenceTicket(SECRET, 'mallory', NOW);
    const [, signature] = ticket.split('.');
    const forged = btoa(JSON.stringify({ u: 'elias', exp: NOW / 1000 + 600 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyPresenceTicket(SECRET, `${forged}.${signature}`, NOW)).toBeNull();
  });

  it('refuse missing and malformed tickets', async () => {
    for (const ticket of [null, undefined, '', 'abc', 'a.b.c', '.', 'x'.repeat(300), '!!!.???']) {
      expect(await verifyPresenceTicket(SECRET, ticket, NOW)).toBeNull();
    }
  });

  it('refuse to sign anything that is not a username', async () => {
    await expect(signPresenceTicket(SECRET, 'Elias', NOW)).rejects.toThrow();
    await expect(signPresenceTicket(SECRET, 'a"b', NOW)).rejects.toThrow();
  });

  it('refuse a short secret loudly instead of signing with it', async () => {
    await expect(signPresenceTicket('short', 'elias', NOW)).rejects.toThrow(/PRESENCE_SECRET/);
    await expect(verifyPresenceTicket('short', 'a.b', NOW)).rejects.toThrow(/PRESENCE_SECRET/);
  });
});

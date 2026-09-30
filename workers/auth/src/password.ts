/**
 * Password hashing with WebCrypto PBKDF2-SHA256 instead of Better Auth's
 * default pure-JS scrypt: native code keeps a sign-in well inside a Worker's
 * CPU budget. 100k iterations is the most Workers allow.
 *
 * Stored as pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>.
 */
const ITERATIONS = 100_000;
const PREFIX = 'pbkdf2-sha256';

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `${PREFIX}$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [prefix, iterations, salt, expected] = hash.split('$');
  const rounds = Number(iterations);
  if (prefix !== PREFIX || !Number.isInteger(rounds) || rounds < 1 || rounds > ITERATIONS || !salt || !expected) {
    return false;
  }
  const actual = await derive(password, unb64(salt), rounds);
  const want = unb64(expected);
  if (actual.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ want[i];
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

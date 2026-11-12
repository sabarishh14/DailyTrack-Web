// The private vault's cryptography, all of it in this browser (WebCrypto). The
// phone's VaultCrypto.kt does exactly the same, so either opens what the other
// locked. The server only ever sees what these functions return.
//
//   passphrase ──PBKDF2-SHA256──▶ key ──AES-GCM──▶ wraps the data key
//   recovery key ─PBKDF2-SHA256─▶ key ──AES-GCM──▶ wraps the data key too
//   data key ──AES-256-GCM──▶ every item, and this person's ECDH private key
//   a friend's public key + a one-off ECDH key ──HKDF──▶ wraps the data key for them
//
// Every sealed value says what it is (AAD: owner, purpose), so one can't be
// swapped for another.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERATIONS = 600000;
const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error('This browser can’t encrypt here (it needs https)');
  return globalThis.crypto.subtle;
};

// ---- bytes ----
export const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function toB64(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const aad = (owner, purpose) => enc.encode(`dt-vault|v1|${owner}|${purpose}`);

// ---- what people type ----

/** A passphrase as it's turned into a key: case, extra spaces and the ends don't matter. */
export const normalizePassphrase = (p) => String(p || '').trim().toLowerCase().replace(/\s+/g, ' ');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new recovery key: 160 random bits as 8 groups of 4 letters and digits. */
export function newRecoveryKey() {
  const bytes = random(20);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g).join('-');
}

/** A recovery key as typed: any case, with or without dashes and spaces. */
export const normalizeRecoveryKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

// ---- keys ----

async function kek(secret, saltB64, iterations) {
  const base = await subtle().importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export const passphraseKey = (passphrase, salt, iterations) => kek(normalizePassphrase(passphrase), salt, iterations);
export const recoveryKeyKey = (code, salt, iterations) => kek(normalizeRecoveryKey(code), salt, iterations);

export const aesKey = (raw, extractable = false) =>
  subtle().importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);

/** nonce ‖ ciphertext, base64. */
export async function seal(key, bytes, owner, purpose) {
  const iv = random(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner, purpose) }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}

/** The bytes sealed, or an error when the key (or what it's for) is wrong. */
export async function open(key, b64, owner, purpose) {
  const all = fromB64(b64);
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: aad(owner, purpose) }, key, all.subarray(12));
  return new Uint8Array(plain);
}

/**
 * A new vault's keys: the data key, wrapped under the passphrase and the
 * recovery key, and a key pair for friends. Returns what the server keeps
 * (`keys`) and what stays here (`dataKey`, raw).
 */
export async function createKeys(owner, passphrase, recoveryKey) {
  const dataKey = random(32);
  const salt = toB64(random(16)), recoverySalt = toB64(random(16));
  const dk = await aesKey(dataKey);
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const priv = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  return {
    dataKey,
    keys: {
      salt, iterations: ITERATIONS,
      wrapped_key: await seal(await passphraseKey(passphrase, salt, ITERATIONS), dataKey, owner, 'key'),
      recovery_salt: recoverySalt,
      recovery_wrapped_key: await seal(await recoveryKeyKey(recoveryKey, recoverySalt, ITERATIONS), dataKey, owner, 'recovery'),
      public_key: toB64(pub),
      wrapped_private_key: await seal(dk, priv, owner, 'private'),
    },
  };
}

/** The raw data key, from the passphrase; throws when it's the wrong one. */
export async function unwrapWithPassphrase(owner, keys, passphrase) {
  return open(await passphraseKey(passphrase, keys.salt, keys.iterations), keys.wrapped_key, owner, 'key');
}

export async function unwrapWithRecoveryKey(owner, keys, code) {
  return open(await recoveryKeyKey(code, keys.recovery_salt, keys.iterations), keys.recovery_wrapped_key, owner, 'recovery');
}

/** A new passphrase for the same data key: {salt, iterations, wrapped_key}. */
export async function rewrapPassphrase(owner, dataKey, passphrase) {
  const salt = toB64(random(16));
  return { salt, iterations: ITERATIONS, wrapped_key: await seal(await passphraseKey(passphrase, salt, ITERATIONS), dataKey, owner, 'key') };
}

export async function rewrapRecovery(owner, dataKey, code) {
  const salt = toB64(random(16));
  return { recovery_salt: salt, recovery_wrapped_key: await seal(await recoveryKeyKey(code, salt, ITERATIONS), dataKey, owner, 'recovery') };
}

// ---- friends ----

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const grantInfo = (owner, viewer) => enc.encode(`dt-vault|v1|grant|${owner}|${viewer}`);

async function grantKey(privateKey, publicRaw, owner, viewer) {
  const pub = await subtle().importKey('raw', publicRaw, ECDH, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: grantInfo(owner, viewer) },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** The data key wrapped for a friend's public key: {ephemeral_key, wrapped_key}. */
export async function grantFor(owner, viewer, viewerPublicB64, dataKey) {
  const eph = await subtle().generateKey(ECDH, true, ['deriveBits']);
  const key = await grantKey(eph.privateKey, fromB64(viewerPublicB64), owner, viewer);
  return {
    ephemeral_key: toB64(new Uint8Array(await subtle().exportKey('raw', eph.publicKey))),
    wrapped_key: await seal(key, dataKey, owner, `grant|${viewer}`),
  };
}

/** A friend's data key, from their grant and this person's own keys. */
export async function openGrant(owner, viewer, grant, myKeys, myDataKey) {
  const pkcs8 = await open(await aesKey(myDataKey), myKeys.wrapped_private_key, viewer, 'private');
  const priv = await subtle().importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
  const key = await grantKey(priv, fromB64(grant.ephemeral_key), owner, viewer);
  return open(key, grant.wrapped_key, owner, `grant|${viewer}`);
}

// ---- items ----

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An item as stored: JSON, gzipped, sealed under the data key for its id. */
export async function sealItem(dk, owner, id, value) {
  return seal(dk, await gzip(enc.encode(JSON.stringify(value))), owner, `item|${id}`);
}

export async function openItem(dk, owner, id, payload) {
  return JSON.parse(dec.decode(await gunzip(await open(dk, payload, owner, `item|${id}`))));
}

/** sha256 hex, for the fingerprints that check a copy before the original goes. */
export async function sha256Hex(text) {
  const d = new Uint8Array(await subtle().digest('SHA-256', enc.encode(text)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha1Hex(text) {
  const d = new Uint8Array(await subtle().digest('SHA-1', enc.encode(text)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

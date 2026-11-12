// The private vault in this browser: whether it's on, unlocking it, keeping the
// key on this device, reading and saving the locked items, and moving
// investments in and out of it. The engine (engine.js) works on what's opened
// here; intercept.js puts the two in front of the Investments API.
import { API } from '../constants';
import { getToken } from '../utils';
import { getViewAs } from '../access/viewAs';
import * as C from './crypto';
import { emptyTables, toItems, fromItems, fingerprints, sameTables } from './tables';

// ---- talking to the server ----

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${getToken()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || json?.success === false) {
    const err = new Error(json?.message || `Server returned ${res.status}`);
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json;
}

// ---- this device's copy of the key (IndexedDB) ----
// The data key, sealed under a key this browser made and can't export: whoever
// copies the database files gets ciphertext, and "Lock" deletes both.

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dt-vault', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode);
      const req = fn(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function rememberKey(email, dataKey) {
  try {
    const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const wrapped = await C.seal(deviceKey, dataKey, email, 'device');
    await idbDo('readwrite', s => s.put({ deviceKey, wrapped }, email));
  } catch { /* private window: it just isn't remembered */ }
}

async function recallKey(email) {
  try {
    const rec = await idbDo('readonly', s => s.get(email));
    return rec ? await C.open(rec.deviceKey, rec.wrapped, email, 'device') : null;
  } catch {
    return null;
  }
}

async function forgetKey(email) {
  try { await idbDo('readwrite', s => s.delete(email)); } catch { /* nothing kept */ }
}

// ---- the session ----

const listeners = new Set();
let info = null;          // GET /api/vault, for the view it was read for
let infoFor = undefined;  // the X-View-As it was read with
let infoPromise = null;
let session = null;       // { owner, dk, dataKey, mine, readOnly, tables, saved: {id: {rev, json}} }
let lock = Promise.resolve();
let moving = false;

const emit = () => listeners.forEach(fn => { try { fn(); } catch { /* a listener's own problem */ } });

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The vault's state for what's on screen: GET /api/vault, read once per view. */
export async function status(force = false) {
  const view = getViewAs() || null;
  if (!force && info && infoFor === view) return info;
  if (!force && infoPromise && infoFor === view) return infoPromise;
  if (infoFor !== view) session = null;
  infoFor = view;
  infoPromise = call('GET', '/vault').then(r => {
    if (infoFor === view) {
      info = r;
      emit();
    }
    return r;
  }).finally(() => { infoPromise = null; });
  return infoPromise;
}

/** What the screens show: {state, open, reason, owner, email, viewing, hasKeys, moving}. */
export function snapshot() {
  if (!info) return { state: 'unknown', open: false };
  const viewing = info.owner !== info.email;
  let reason = null;
  if (info.state === 'on' && !session) {
    if (!info.me) reason = 'no-keys';
    else if (viewing && !info.grant) reason = 'no-grant';
    else reason = 'locked';
  }
  return {
    state: info.state, open: !!session, reason, owner: info.owner, email: info.email, viewing,
    hasKeys: !!info.me, myState: info.my_state, moving,
  };
}

export const isOpen = () => !!session;
export const current = () => session;

async function decryptAll(owner, dk) {
  const { items } = await call('GET', '/vault/items');
  const saved = {};
  const values = {};
  for (const item of items) {
    const value = await C.openItem(dk, owner, item.id, item.payload);
    values[item.id] = value;
    saved[item.id] = { rev: item.rev, json: JSON.stringify(value) };
  }
  return { tables: fromItems(values), saved };
}

/** Opens the vault on screen with this person's own data key. */
async function openWith(myDataKey, { remember } = {}) {
  const v = await status();
  const viewing = v.owner !== v.email;
  let dataKey = myDataKey;
  if (viewing) {
    if (!v.grant) throw new Error(`${v.owner} hasn't opened their vault for you yet`);
    dataKey = await C.openGrant(v.owner, v.email, v.grant, v.me, myDataKey);
  }
  const dk = await C.aesKey(dataKey);
  const { tables, saved } = await decryptAll(v.owner, dk);
  session = { owner: v.owner, dk, dataKey, myDataKey, readOnly: viewing, tables, saved };
  if (remember) await rememberKey(v.email, myDataKey);
  emit();
  if (!viewing) syncGrants().catch(() => {});
  return session;
}

/** Opens it with the key this device kept, if it kept one. */
export async function tryRemembered() {
  if (session) return true;
  const v = await status();
  if (v.state !== 'on' || !v.me) return false;
  if (v.owner !== v.email && !v.grant) return false;
  const key = await recallKey(v.email);
  if (!key) return false;
  try {
    await openWith(key);
    return true;
  } catch {
    return false;
  }
}

/** Unlock with the passphrase (or, with {recovery: true}, the recovery key). */
export async function unlock(secret, { recovery = false, remember = true } = {}) {
  const v = await status();
  if (!v.me) throw new Error('Set up your vault first');
  let key;
  try {
    key = recovery
      ? await C.unwrapWithRecoveryKey(v.email, v.me, secret)
      : await C.unwrapWithPassphrase(v.email, v.me, secret);
  } catch {
    throw new Error(recovery ? 'That recovery key doesn’t open it' : 'That passphrase doesn’t open it');
  }
  await openWith(key, { remember });
}

/** Locks it on this device: the next open needs the passphrase. */
export async function lockNow() {
  const v = await status();
  await forgetKey(v.email);
  session = null;
  emit();
}

// ---- reading and saving ----

/** Runs fn(tables) on a copy, one at a time, and saves what changed. When
 *  another device saved meanwhile, reads again and runs it again. */
export function transact(fn) {
  const run = lock.then(async () => {
    for (let attempt = 0; ; attempt++) {
      if (!session) throw new Error('Unlock your private vault first');
      const tables = structuredClone(session.tables);
      const result = await fn(tables);
      if (session.readOnly) return result;      // a friend's: worked out, never saved
      try {
        await save(tables);
        return result;
      } catch (e) {
        if (e.code !== 'VAULT_STALE' || attempt >= 2) throw e;
        await reload();
      }
    }
  });
  lock = run.catch(() => {});
  return run;
}

async function save(tables) {
  const s = session;
  const items = toItems(tables);
  const put = [], del = [], jsons = {};
  for (const [id, value] of Object.entries(items)) {
    const json = JSON.stringify(value);
    jsons[id] = json;
    if (s.saved[id]?.json !== json) put.push({ id, payload: await C.sealItem(s.dk, s.owner, id, value), rev: s.saved[id]?.rev || 0 });
  }
  for (const [id, have] of Object.entries(s.saved)) if (!(id in items)) del.push({ id, rev: have.rev });
  if (put.length || del.length) {
    const { revs } = await call('PUT', '/vault/items', { put, delete: del });
    for (const [id, rev] of Object.entries(revs)) {
      if (rev) s.saved[id] = { rev, json: jsons[id] };
      else delete s.saved[id];
    }
  }
  s.tables = tables;
}

export async function reload() {
  if (!session) return;
  const { tables, saved } = await decryptAll(session.owner, session.dk);
  session.tables = tables;
  session.saved = saved;
}

// ---- setting up, and moving in and out ----

/**
 * Turns the vault on: keys (made here; the server only keeps them wrapped),
 * then everything readable today moved in. Nothing readable is deleted
 * until the locked copy has been read back, opened and checked, here and on
 * the server. `progress(text)` follows along.
 */
export async function turnOn({ passphrase, recoveryKey, remember = true, progress = () => {} }) {
  let v = await status(true);
  if (v.state === 'on') throw new Error('Your vault is already on');
  moving = true;
  emit();
  try {
    let dataKey;
    if (!v.me) {
      progress('Making your keys…');
      const made = await C.createKeys(v.email, passphrase, recoveryKey);
      await call('POST', '/vault/keys', made.keys);
      dataKey = made.dataKey;
    } else {
      try {
        dataKey = await C.unwrapWithPassphrase(v.email, v.me, passphrase);
      } catch {
        throw new Error('That passphrase doesn’t open the vault you set up before');
      }
    }
    v = await status(true);
    const owner = v.email;
    const dk = await C.aesKey(dataKey);

    progress('Reading your investments…');
    const plain = await call('GET', '/vault/plain');
    const tables = { ...emptyTables(), ...plain.tables, state: { ...emptyTables().state, ...(plain.state || {}) } };

    progress('Locking them away…');
    const items = toItems(tables);
    const { items: leftover } = await call('GET', '/vault/items');      // an earlier try that stopped half-way
    const revs = Object.fromEntries(leftover.map(i => [i.id, i.rev]));
    const put = [];
    for (const [id, value] of Object.entries(items)) put.push({ id, payload: await C.sealItem(dk, owner, id, value), rev: revs[id] || 0 });
    const del = leftover.filter(i => !(i.id in items)).map(i => ({ id: i.id, rev: i.rev }));
    await call('PUT', '/vault/items', { put, delete: del });

    progress('Checking the locked copy…');
    const back = await decryptAll(owner, dk);
    const prints = await fingerprints(back.tables);
    const theirs = plain.fingerprints;
    const matches = Object.keys(theirs).every(name =>
      prints[name].count === theirs[name].count && prints[name].ids === theirs[name].ids);
    if (!matches || !sameTables(back.tables, tables)) throw new Error('The locked copy didn’t match, so nothing was removed. Try again.');

    progress('Removing the readable copy…');
    await call('POST', '/vault/finish', { fingerprints: prints });

    session = { owner, dk, dataKey, myDataKey: dataKey, readOnly: false, tables: back.tables, saved: back.saved };
    if (remember) await rememberKey(owner, dataKey);
    await status(true);
    syncGrants().catch(() => {});
  } catch (e) {
    await call('POST', '/vault/cancel').catch(() => {});
    await status(true).catch(() => {});
    throw e;
  } finally {
    moving = false;
    emit();
  }
}

/** Turns it off: everything goes back to being stored readable, checked, and
 *  only then are the locked items deleted. */
export async function turnOff({ progress = () => {} } = {}) {
  if (!session || session.readOnly) throw new Error('Unlock your vault first');
  moving = true;
  emit();
  try {
    await lock;
    await reload();
    const { state, ...tables } = session.tables;
    progress('Putting your investments back…');
    await call('POST', '/vault/restore', { tables, state, fingerprints: await fingerprints(session.tables) });
    const v = await status(true);
    await forgetKey(v.email);
    session = null;
  } finally {
    moving = false;
    emit();
  }
}

/** A new passphrase for the same vault: nothing is locked again. */
export async function changePassphrase(passphrase) {
  if (!session) throw new Error('Unlock your vault first');
  const v = await status();
  await call('PUT', '/vault/keys', await C.rewrapPassphrase(v.email, session.myDataKey, passphrase));
  await status(true);
}

/** A new recovery key (the old one stops working). Returns it to show once. */
export async function newRecoveryKey() {
  if (!session) throw new Error('Unlock your vault first');
  const v = await status();
  const code = C.newRecoveryKey();
  await call('PUT', '/vault/keys', await C.rewrapRecovery(v.email, session.myDataKey, code));
  await status(true);
  return code;
}

/** Friends Investments is shared with, given the key once they have vault keys. */
export async function syncGrants() {
  if (!session || session.readOnly) return [];
  const { grants } = await call('GET', '/vault/grants');
  for (const g of grants) {
    if (g.public_key && !g.granted) {
      const grant = await C.grantFor(session.owner, g.viewer, g.public_key, session.dataKey);
      await call('PUT', `/vault/grants/${encodeURIComponent(g.viewer)}`, { viewer_key: g.public_key, ...grant });
      g.granted = true;
    }
  }
  return grants;
}

/** Keys set up before but never used (the vault is off): forgotten, to start
 *  over with a new passphrase. */
export async function startOver() {
  await call('DELETE', '/vault/keys');
  const v = await status(true);
  await forgetKey(v.email);
}

/** Forget the vault's state (signing out, or switching whose data is shown). */
export function reset() {
  info = null;
  infoFor = undefined;
  session = null;
  emit();
}

export { call as vaultCall };

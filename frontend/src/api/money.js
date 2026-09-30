import { useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../constants';
import { accountOptions, getToken } from '../utils';

// Money data is filtered, grouped and paged on the server (backend/blueprints/
// money_query.py) instead of downloading every transaction into the browser.

const headers = (json) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  'Authorization': `Bearer ${getToken()}`,
});

export const apiGet = (path) => fetch(`${API}${path}`, { headers: headers(false) }).then(r => r.json());
export const apiPost = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) }).then(r => r.json());

// UI chips keep { included: Set, excluded: Set }; the API takes arrays.
export const tri = (state) => ({ include: [...state.included], exclude: [...state.excluded] });

/**
 * Runs `fetcher` whenever `key` changes and keeps the previous result on screen
 * until the new one lands, so filters feel instant instead of flashing empty.
 * Out-of-order responses are dropped.
 */
export function useApi(fetcher, key, enabled = true) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled || !getToken()) return;
    const id = ++latest.current;
    setLoading(true);
    fetcherRef.current()
      .then(res => { if (id === latest.current && res && res.success !== false) setData(res); })
      .catch(err => console.error('Request failed', err))
      .finally(() => { if (id === latest.current) setLoading(false); });
  }, [key, enabled]);

  return { data, loading };
}

// Filter options + description suggestions. Money, Add and search all need it,
// so one request per data version is shared between them.
let metaCache = { version: null, promise: null };

export function useMoneyMeta(dataVersion, enabled = true) {
  return useApi(() => {
    if (metaCache.version !== dataVersion || !metaCache.promise) {
      metaCache = {
        version: dataVersion,
        promise: apiGet('/money/meta').catch(e => { metaCache = { version: null, promise: null }; throw e; }),
      };
    }
    return metaCache.promise;
  }, dataVersion, enabled);
}

// For modals opened from anywhere: reuses whatever meta is loaded, fetching once if none is.
export function useLatestMoneyMeta() {
  return useMoneyMeta(metaCache.version ?? 'latest');
}

/**
 * Every account as dropdown options, from the server's list (which includes
 * accounts added with nothing on them yet). [current] keeps an account that's
 * already chosen in the list even if it isn't there.
 */
export function useAccountOptions(current) {
  const accounts = (useLatestMoneyMeta().data || EMPTY_META).accounts;
  return useMemo(() => accountOptions(current ? [...accounts, current] : accounts), [accounts, current]);
}

export const EMPTY_META = {
  years: [], fys: [], headings: [], accounts: [], types: [],
  excluded_headings: [], categories_by_type: {}, descriptions: [], recent_descriptions: [],
};

export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

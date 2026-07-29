const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const EVENT_DELAY_MS = 250;

export function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

export function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

export async function createEvent(token, eventPayload) {
  const res = await fetch(CALENDAR_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(eventPayload),
  });

  if (res.status === 401) {
    await removeCachedToken(token);
    throw new Error('AUTH_EXPIRED');
  }
  if (res.status === 429) throw new Error('RATE_LIMITED');

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function deleteEvent(token, eventId) {
  const res = await fetch(`${CALENDAR_API}/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    await removeCachedToken(token);
    throw new Error('AUTH_EXPIRED');
  }

  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Delete failed: HTTP ${res.status}`);
  }
}

const MAX_AUTH_REFRESHES = 2;

/**
 * Create every event, one at a time.
 *
 * An expired token is refreshed and the *same* event retried, rather than
 * letting the error escape. The caller used to catch AUTH_EXPIRED and restart
 * the whole batch, which duplicated every event written before the token went
 * stale — on a week-long plan that is dozens of junk calendar entries.
 *
 * @param {string} token         initial access token
 * @param {object[]} events      payloads to create
 * @param {(done: number, total: number) => void} [onProgress]
 * @param {() => Promise<string>} [refreshToken]  called on AUTH_EXPIRED
 */
export async function batchCreateEvents(token, events, onProgress, refreshToken) {
  let active = token;
  let created = 0;
  let authRefreshes = 0;
  const failed = [];
  const eventIds = [];

  for (let i = 0; i < events.length; i++) {
    let done = false;

    for (let attempt = 0; attempt <= 3 && !done; attempt++) {
      if (attempt > 0) await sleep(1000 * Math.pow(2, attempt));
      try {
        const result = await createEvent(active, events[i]);
        created++;
        eventIds.push(result.id);
        done = true;
      } catch (err) {
        if (err.message === 'AUTH_EXPIRED') {
          if (!refreshToken || authRefreshes >= MAX_AUTH_REFRESHES) {
            failed.push({ index: i, error: 'Authorization expired' });
            done = true;
            break;
          }
          authRefreshes++;
          active = await refreshToken();
          attempt--; // a token refresh is not a rate-limit retry
          continue;
        }
        if (err.message !== 'RATE_LIMITED') {
          failed.push({ index: i, error: err.message });
          done = true;
          break;
        }
        if (attempt === 3) failed.push({ index: i, error: 'Rate limited after retries' });
      }
    }

    if (onProgress) onProgress(i + 1, events.length);
    if (i < events.length - 1) await sleep(EVENT_DELAY_MS);
  }

  return { created, failed, eventIds };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

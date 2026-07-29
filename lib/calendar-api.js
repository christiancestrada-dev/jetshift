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

export async function batchCreateEvents(token, events, onProgress) {
  let created = 0;
  const failed = [];
  const eventIds = [];

  for (let i = 0; i < events.length; i++) {
    try {
      const result = await createEvent(token, events[i]);
      created++;
      eventIds.push(result.id);
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        let retried = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          await sleep(1000 * Math.pow(2, attempt));
          try {
            const result = await createEvent(token, events[i]);
            created++;
            eventIds.push(result.id);
            retried = true;
            break;
          } catch (retryErr) {
            if (retryErr.message !== 'RATE_LIMITED') {
              failed.push({ index: i, error: retryErr.message });
              retried = true;
              break;
            }
          }
        }
        if (!retried) failed.push({ index: i, error: 'Rate limited after retries' });
      } else if (err.message === 'AUTH_EXPIRED') {
        throw err;
      } else {
        failed.push({ index: i, error: err.message });
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

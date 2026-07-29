import { getAuthToken, batchCreateEvents, deleteEvent } from '../lib/calendar-api.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'syncToCalendar') {
    handleSync(message.events)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'deleteEvents') {
    handleDelete(message.eventIds)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleSync(events) {
  const token = await getAuthToken(true);

  const onProgress = (current, total) => {
    chrome.runtime.sendMessage({ action: 'syncProgress', current, total }).catch(() => {});
  };

  try {
    const result = await batchCreateEvents(token, events, onProgress);

    await chrome.storage.local.set({
      lastSync: {
        timestamp: Date.now(),
        created: result.created,
        failed: result.failed.length,
        total: events.length,
      },
    });

    return {
      success: true,
      created: result.created,
      eventIds: result.eventIds,
      warning: result.failed.length > 0 ? `${result.failed.length} event(s) failed` : undefined,
    };
  } catch (err) {
    if (err.message === 'AUTH_EXPIRED') {
      const freshToken = await getAuthToken(true);
      const result = await batchCreateEvents(freshToken, events, onProgress);
      return { success: true, created: result.created, eventIds: result.eventIds };
    }
    throw err;
  }
}

async function handleDelete(eventIds) {
  const token = await getAuthToken(true);
  let deleted = 0;

  for (const id of eventIds) {
    try {
      await deleteEvent(token, id);
      deleted++;
    } catch (err) {
      // Skip events that are already deleted
    }
  }

  return { success: true, deleted };
}

// The panel's side of the link to the YouTube Chat Comment app (electron/premiere-bridge.js in the app): finds
// the app on this computer and hands it frames, then asks how each job is going and fetches its file. Takes
// fetch() as an argument, so test/unit/premiere-plugin.test.js can run it against a stand-in.

// As BRIDGE_PORTS, HEADER and PROTOCOL in electron/premiere-bridge.js (and the manifest's network domains).
const PORTS = [47811, 47812, 47813];
const HEADER = 'X-YouTube-Chat-Comment';
const PROTOCOL = 1;
const APP = 'YouTube Chat Comment';

class BridgeError extends Error {}

function createBridge({ fetch, ports = PORTS }) {
  let port = null;

  /** @param {string} route @param {{ method?: string, body?: any, type?: string, as?: string }} [options] */
  const call = async (route, { method = 'GET', body, type, as = 'json' } = {}) => {
    if (port === null && !(await find())) throw new BridgeError(`Can't find the ${APP} app: open it, then try again.`);
    const headers = { [HEADER]: String(PROTOCOL) };
    if (type) headers['Content-Type'] = type;
    let response;
    try {
      response = await fetch(`http://localhost:${port}${route}`, { method, headers, body });
    } catch {
      port = null; // the app was closed: look for it again next time
      throw new BridgeError(`Lost the ${APP} app: is it still open?`);
    }
    if (!response.ok) {
      let reason = `the app answered ${response.status}`;
      try {
        reason = (await response.json()).error ?? reason;
      } catch {
        // not JSON
      }
      throw new BridgeError(reason);
    }
    return as === 'bytes' ? response.arrayBuffer() : response.json();
  };

  /** The app's hello ({ app, version, protocol }) from the first port it answers on, or null. */
  async function find() {
    for (const candidate of ports) {
      try {
        const response = await fetch(`http://localhost:${candidate}/v1/hello`, { headers: { [HEADER]: String(PROTOCOL) } });
        if (!response.ok) continue;
        const hello = await response.json();
        if (hello?.app === APP && hello.protocol === PROTOCOL) {
          port = candidate;
          return hello;
        }
      } catch {
        // nothing there
      }
    }
    port = null;
    return null;
  }

  return {
    find,
    /** Sends the frame (a PNG's bytes) and the box drawn in it → the job: { id, state, message, label }. */
    startJob: (frame, box, label) => call(`/v1/jobs?${query({ ...box, label })}`, { method: 'POST', body: frame, type: 'image/png' }),
    /** How the job is going: { state, message, file? } (see the app's bridge). */
    job: (id) => call(`/v1/jobs/${encodeURIComponent(id)}`),
    /** The finished file's bytes (an ArrayBuffer). */
    file: (id) => call(`/v1/jobs/${encodeURIComponent(id)}/file`, { as: 'bytes' }),
    cancel: (id) => call(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    /** Tells the app where the file went (or, `ok` false, why it couldn't go), for its status line. */
    placed: (id, message, ok = true) => call(`/v1/jobs/${encodeURIComponent(id)}/placed`, { method: 'POST', body: JSON.stringify({ message, ok }), type: 'application/json' }),
  };
}

/** A query string (UXP may lack URLSearchParams). */
function query(values) {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

module.exports = { APP, BridgeError, HEADER, PORTS, PROTOCOL, createBridge };

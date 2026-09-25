// Twilio Function: check-guest
//
// Thin forwarder (same pattern as lookup-code / save-recording): asks
// /api/guest-check whether this phone number already has a name on file for
// this card, so Studio can skip the "who's this from?" question for
// returning guests. Read-only, no Blob involved.
//
// Dependencies needed on this Twilio Function service: axios (already added
// for save-recording/save-name).
// Environment variables needed (same ones lookup-code/save-recording use):
//   PS_API_BASE     = https://www.personallysaid.co
//   PS_LOOKUP_TOKEN = <same shared secret already in use>
//
// Call this from Studio with parameters:
//   code        - card code (from the earlier lookup step)
//   guest_phone - the caller/texter's number
//
// Returns: { ok: true, has_name: true|false, name: "..." }

const axios = require('axios');

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  try {
    const code = (event.code || event.Code || '').trim();
    const guestPhone = event.guest_phone || event.From || '';

    if (!code || !guestPhone) {
      response.setStatusCode(400);
      response.setBody({ ok: false, has_name: false, error: 'Missing code or guest_phone' });
      return callback(null, response);
    }

    const res = await axios.get(`${context.PS_API_BASE}/api/guest-check`, {
      params: { code, phone: guestPhone },
      headers: { 'x-ps-token': context.PS_LOOKUP_TOKEN },
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`guest-check returned ${res.status}`);
    }

    response.setBody({
      ok: true,
      has_name: !!(res.data && res.data.has_name),
      name: (res.data && res.data.name) || '',
    });
    return callback(null, response);
  } catch (err) {
    console.error('[check-guest]', err.message);
    // Fail open: treat as "no name on file" so the flow just asks for the
    // name again rather than getting stuck if this lookup errors.
    response.setBody({ ok: false, has_name: false, error: err.message });
    return callback(null, response);
  }
};

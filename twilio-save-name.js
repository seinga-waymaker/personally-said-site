// Twilio Function: save-name
//
// Saves a guest's name once per phone number per card. Two cases:
//   - Texted name: the name is already plain text (event.name_text), no audio.
//   - Spoken name (call): a short ~4s recording is fetched from Twilio the
//     same way save-recording does, uploaded to Blob as the backup audio,
//     and event.name_text (from Twilio's built-in speech recognition on the
//     Gather/Record step, not Deepgram) is stored as the label.
//
// Same dependencies/env vars as twilio-save-recording.js: axios, @vercel/blob,
// PS_API_BASE, PS_LOOKUP_TOKEN.
//
// ps-raw is a PRIVATE Vercel Blob store: uploads must use access: 'private'.
//
// Call this from Studio with parameters:
//   code          - card code
//   guest_phone   - the caller/texter's number
//   channel       - "call" or "text"
//   name_text     - transcribed/typed name (may be empty if speech rec failed)
//   recording_url - RecordingUrl, only present for the spoken-name case
//   recording_sid - RecordingSid, only present for the spoken-name case

const axios = require('axios');
const { upload } = require('@vercel/blob/client');

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  try {
    const code = (event.code || '').trim();
    const guestPhone = event.guest_phone || event.From || '';
    const channel = event.channel || (event.recording_url ? 'call' : 'text');
    const nameText = (event.name_text || '').trim();
    const mediaUrl = event.recording_url || event.RecordingUrl;

    if (!code) {
      response.setStatusCode(400);
      response.setBody({ ok: false, error: 'Missing code' });
      return callback(null, response);
    }

    let blobUrl = null;

    if (mediaUrl) {
      const fetchUrl = /\.\w+$/.test(mediaUrl) ? mediaUrl : `${mediaUrl}.mp3`;
      const mediaRes = await axios.get(fetchUrl, {
        responseType: 'arraybuffer',
        auth: { username: context.ACCOUNT_SID, password: context.AUTH_TOKEN },
        validateStatus: () => true,
      });
      if (mediaRes.status < 200 || mediaRes.status >= 300) {
        throw new Error(`Could not fetch name clip from Twilio (${mediaRes.status})`);
      }
      const contentType = mediaRes.headers['content-type'] || 'audio/mpeg';
      const buffer = Buffer.from(mediaRes.data);
      const last4 = (guestPhone || '').replace(/\D/g, '').slice(-4) || 'anon';
      const pathname = `ps-raw/cards/${code}/names/${last4}.mp3`;

      const blob = await upload(pathname, buffer, {
        access: 'private',
        contentType,
        handleUploadUrl: `${context.PS_API_BASE}/api/blob-upload-token`,
        clientPayload: JSON.stringify({
          code,
          guest_phone: guestPhone,
          channel,
          kind: 'name',
          name_text: nameText,
        }),
        headers: { 'x-ps-token': context.PS_LOOKUP_TOKEN },
      });
      blobUrl = blob.url;
    } else {
      // Texted name: no audio, just write the label straight through the same
      // upload-token route's onUploadCompleted path isn't usable (no upload),
      // so call the plain metadata route instead.
      await axios.post(
        `${context.PS_API_BASE}/api/save-name-text`,
        { code, guest_phone: guestPhone, channel, name_text: nameText },
        { headers: { 'x-ps-token': context.PS_LOOKUP_TOKEN, 'Content-Type': 'application/json' } },
      );
    }

    response.setBody({ ok: true, url: blobUrl });
    return callback(null, response);
  } catch (err) {
    console.error('[save-name]', err.message);
    response.setStatusCode(500);
    response.setBody({ ok: false, error: err.message });
    return callback(null, response);
  }
};

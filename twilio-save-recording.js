// Twilio Function: save-recording
//
// Thin forwarder (same pattern as lookup-code): fetches the guest's voice
// memo bytes from Twilio's own media URL using the credentials every
// Function already has (context.ACCOUNT_SID / context.AUTH_TOKEN -- no new
// secret), then uploads them straight to Vercel Blob using a short-lived
// client token issued by /api/blob-upload-token. Vercel Blob calls that same
// route back once the upload lands, and that's where the clip gets written
// to Redis -- this function's only job is "get the bytes to Vercel".
//
// Dependencies needed on this Twilio Function service: axios, @vercel/blob
// Environment variables needed (same ones lookup-code already uses):
//   PS_API_BASE   = https://www.personallysaid.co
//   PS_LOOKUP_TOKEN = <same shared secret already in use>
//
// Call this from Studio with parameters:
//   code          - card code (from the earlier lookup step)
//   guest_phone   - the caller/texter's number
//   channel       - "call" or "text"
//   recording_url - RecordingUrl (calls) or MediaUrl0 (texts)
//   recording_sid - RecordingSid (calls) or MessageSid (texts)
//   duration      - RecordingDuration (calls only; omit for texts)

const axios = require('axios');
const { upload } = require('@vercel/blob/client');

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  try {
    const code = (event.code || '').trim();
    const guestPhone = event.guest_phone || event.From || '';
    const channel = event.channel || (event.recording_sid ? 'call' : 'text');
    let mediaUrl = event.recording_url || event.RecordingUrl || event.MediaUrl0;
    const sid = event.recording_sid || event.RecordingSid || event.MessageSid || '';
    const durationRaw = event.duration || event.RecordingDuration;
    const durationSeconds = durationRaw ? parseInt(durationRaw, 10) : null;

    if (!code || !mediaUrl) {
      response.setStatusCode(400);
      response.setBody({ ok: false, error: 'Missing code or media url' });
      return callback(null, response);
    }

    if (channel === 'call' && !/.w+$/.test(mediaUrl)) mediaUrl = `${mediaUrl}.mp3`;

    const mediaRes = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: { username: context.ACCOUNT_SID, password: context.AUTH_TOKEN },
      validateStatus: () => true,
    });
    if (mediaRes.status < 200 || mediaRes.status >= 300) {
      throw new Error(`Could not fetch recording from Twilio (${mediaRes.status})`);
    }

    const contentType = mediaRes.headers['content-type'] || (channel === 'call' ? 'audio/mpeg' : 'audio/amr');
    const buffer = Buffer.from(mediaRes.data);
    const ext = contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3'
      : contentType.includes('wav') ? 'wav'
      : contentType.includes('amr') ? 'amr'
      : contentType.includes('ogg') ? 'ogg' : 'audio';

    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const last4 = (guestPhone || '').replace(/D/g, '').slice(-4) || 'anon';
    const pathname = `ps-raw/cards/${code}/clips/${stamp}_${channel}_${last4}.${ext}`;

    const blob = await upload(pathname, buffer, {
      access: 'public',
      contentType,
      handleUploadUrl: `${context.PS_API_BASE}/api/blob-upload-token`,
      clientPayload: JSON.stringify({
        code,
        guest_phone: guestPhone,
        channel,
        kind: 'clip',
        twilio_sid: sid,
        duration_seconds: durationSeconds,
      }),
      headers: { 'x-ps-token': context.PS_LOOKUP_TOKEN },
    });

    response.setBody({ ok: true, url: blob.url });
    return callback(null, response);
  } catch (err) {
    console.error('[save-recording]', err.message);
    response.setStatusCode(500);
    response.setBody({ ok: false, error: err.message });
    return callback(null, response);
  }
};

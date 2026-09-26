// Audio processing helpers for per-clip processing (Phase 1 build spec, step 7).
//
// Runs ffmpeg (via the ffmpeg-static binary, a precompiled static build that
// works in Vercel's Lambda-based Node runtime with no OS package install) to
// convert a guest's raw voice clip to a leveled mp3, measure its real
// duration, and flag common issues (too short, too long, mostly silence,
// clipping). Deliberately does NOT transcribe -- that needs a
// DEEPGRAM_API_KEY Vercel env var that hasn't been set up yet, so transcript
// storage is left as a clear TODO in process-clip's caller rather than
// half-wired.
//
// Not yet verified against Vercel's actual function size/time limits for a
// real deploy -- see the "NEEDS VERIFICATION" note in the PR description.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const execFileAsync = promisify(execFile);

// Converts inputBuffer to a loudness-normalized mp3 and reports duration plus
// two rough quality flags. Returns:
//   { mp3Buffer, durationSeconds, mostlySilence, clipping }
// On any ffmpeg failure, throws -- callers should fail open (keep the
// original clip playable) rather than lose the guest's message.
async function processAudioBuffer(inputBuffer, extHint) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-clip-'));
  const inPath = path.join(tmpDir, `in.${extHint || 'bin'}`);
  const outPath = path.join(tmpDir, 'out.mp3');

  try {
    await fs.writeFile(inPath, inputBuffer);

    // Single-pass loudnorm (EBU R128, target -16 LUFS -- a common "spoken
    // word" level) rather than the more accurate two-pass approach: this runs
    // on every guest clip, so we're trading a bit of precision for not
    // running ffmpeg twice per clip. Good enough for "not painfully quiet or
    // loud"; the review page always lets a human listen before it ships.
    // print_format=json is required -- loudnorm's default print_format is
    // "none", so without this it silently prints no stats at all (confirmed
    // by testing: the plain filter produces zero "Input Integrated" style
    // output in stderr, which would make analyzeLevels() below a no-op that
    // always reports "not silent, not clipping" regardless of the clip).
    const { stderr: normStderr } = await execFileAsync(ffmpegPath, [
      '-y', '-i', inPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-ar', '44100', '-b:a', '128k',
      outPath,
    ]);

    const durationSeconds = await probeDuration(outPath);
    const { mostlySilence, clipping } = analyzeLevels(normStderr);
    const mp3Buffer = await fs.readFile(outPath);

    return { mp3Buffer, durationSeconds, mostlySilence, clipping };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ffmpeg-static ships ffmpeg only, not ffprobe. Encoding to null output and
// reading the last "time=" progress line ffmpeg prints as it finishes gives
// the real duration without needing a second binary bundled.
async function probeDuration(filePath) {
  const { stderr } = await execFileAsync(ffmpegPath, ['-i', filePath, '-f', 'null', '-']);
  const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const [, h, m, s] = last;
  return Math.round(parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s));
}

// Rough heuristics pulled from loudnorm's own measured-input JSON block
// (requires print_format=json above -- see the note there). Not lab-grade
// audio analysis -- a fast, free-of-extra-tools approximation good enough to
// flag a clip for a human to spot-check on the review page, which happens
// anyway regardless of these flags.
function analyzeLevels(ffmpegStderr) {
  const inputI = ffmpegStderr.match(/"input_i"\s*:\s*"(-?[\d.]+|-inf)"/);
  const inputTP = ffmpegStderr.match(/"input_tp"\s*:\s*"(-?[\d.]+|-inf)"/);

  // loudnorm reports "-inf" for true digital silence (no signal at all),
  // which parseFloat can't handle -- map it to -Infinity explicitly so the
  // "< -50" check below still catches it.
  const parseLoudnorm = (raw) => (raw === '-inf' ? -Infinity : parseFloat(raw));

  const integratedLoudness = inputI ? parseLoudnorm(inputI[1]) : null;
  const truePeak = inputTP ? parseLoudnorm(inputTP[1]) : null;

  // -50 LUFS integrated is very quiet for spoken word -- a clip recorded in a
  // near-silent room, mostly dead air, or true digital silence all land here.
  const mostlySilence = integratedLoudness != null && integratedLoudness < -50;
  // True peak pinned near 0 dBTP for the whole clip suggests clipping.
  const clipping = truePeak != null && truePeak > -0.2;

  return { mostlySilence, clipping };
}

module.exports = { processAudioBuffer };

/**
 * One tool, watch_video. Download a public video, sample frames, and
 * transcribe speech through Groq Whisper when GROQ_API_KEY is set.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-video-watch'
export const inject = ['tools', 'attachments']

const HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'tiktok.com',
  'facebook.com', 'fb.watch', 'fb.com',
  'instagram.com',
  'x.com', 'twitter.com',
]

const imageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    atSeconds: { type: 'number', required: true },
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
  },
}

function hostAllowed(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return HOSTS.some((item) => host === item || host.endsWith(`.${item}`))
}

function videoUrl(raw) {
  let url
  try { url = new URL(String(raw).trim()) } catch { throw new Error('url is not valid') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('url must be http or https')
  const direct = /\.mp4$/i.test(url.pathname)
  if (!hostAllowed(url.hostname) && !direct) {
    throw new Error('url must be YouTube, TikTok, Facebook, Instagram, X, or a direct mp4')
  }
  return url.toString()
}

function frameCount(requested, duration) {
  if (requested !== undefined && requested !== '') {
    const count = Number(requested)
    if (!Number.isInteger(count) || count < 8 || count > 24) throw new Error('frames must be an integer from 8 to 24')
    return count
  }
  if (!Number.isFinite(duration) || duration <= 0) return 8
  return Math.min(24, Math.max(8, Math.round(duration / 3)))
}

function run(command, args, { signal, cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const stop = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', stop, { once: true })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1500) })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error.code === 'ENOENT' ? new Error(`${command} is not installed`) : error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) reject(new Error('Cancelled'))
      else if (code === 0) resolve(stderr)
      else reject(new Error(`${command} failed (${code}): ${stderr.trim()}`))
    })
  })
}

async function durationOf(file, signal) {
  const child = spawn('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
  child.stdout.on('data', (chunk) => { out += chunk })
  const code = await new Promise((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  if (code !== 0) return 0
  const value = Number(out.trim())
  return Number.isFinite(value) ? value : 0
}

/**
 * Transcribe one audio buffer through Groq's OpenAI-compatible endpoint.
 *
 * Groq rather than xAI: the same account already pays for it, the free tier is
 * usable, and whisper-large-v3-turbo is markedly cheaper per hour than the model
 * this used before. Both Whisper variants are multilingual, which is why the
 * `language` hint is passed through rather than left to auto-detection — a
 * Vietnamese clip transcribed as English produces confident nonsense, and a
 * two-letter hint costs nothing.
 *
 * @param {Buffer} audio - mp3 bytes.
 * @param {string | undefined} language - ISO-639-1 hint.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<string | null>} transcript, or null when no key is set.
 */
async function transcribe(audio, language, signal) {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  const form = new FormData()
  form.append('model', GROQ_STT_MODEL)
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3')
  const response = await fetch(GROQ_STT_URL, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}` },
    body: form,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Groq speech-to-text failed (${response.status}): ${detail}`)
  }
  const payload = await response.json()
  return typeof payload.text === 'string' ? payload.text.trim() : ''
}

/**
 * Transcribe audio longer than one request can carry.
 *
 * Groq takes 25 MB per request on the free tier and 100 MB on dev, and a
 * 16 kHz mono 64 kbps mp3 of a one-hour talk is roughly 28 MB — so a long video
 * fails as a single call with a 413 that reads like a bad key. Splitting on
 * fixed time windows keeps each request small; the join is a plain newline
 * because each window is transcribed independently and the model already ends
 * sentences where they end.
 *
 * @param {string} audioPath - the extracted mp3.
 * @param {string} dir - scratch directory for the pieces.
 * @param {string | undefined} language - language hint.
 * @param {(argv: string[], options: object) => Promise<void>} run - ffmpeg runner.
 * @param {{ signal?: AbortSignal }} exec - cancellation.
 * @returns {Promise<string>} the joined transcript.
 */
async function transcribeInChunks(audioPath, dir, language, run, exec) {
  const bytes = (await stat(audioPath)).size
  if (bytes <= GROQ_CHUNK_BYTES) {
    return transcribe(await readFile(audioPath), language, exec.signal)
  }
  const pieces = []
  for (let index = 0; ; index += 1) {
    const piece = join(dir, `audio-${index}.mp3`)
    // -ss before -i seeks instead of decoding: a 40th window costs a seek, not
    // a full re-read of everything before it.
    await run('ffmpeg', [
      '-y', '-ss', String(index * GROQ_CHUNK_SECONDS), '-t', String(GROQ_CHUNK_SECONDS),
      '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', piece,
    ], { signal: exec.signal, timeoutMs: 60000 })
    const size = (await stat(piece)).size
    // A window past the end produces an empty file; that is the stop condition.
    if (size < 1024) break
    const text = await transcribe(await readFile(piece), language, exec.signal)
    if (text) pieces.push(text)
    if (size < GROQ_CHUNK_BYTES) break
    if (index > 500) break // hard stop: a runtime bound, not a content judgement
  }
  return pieces.join('\n')
}

/** Groq's OpenAI-compatible speech-to-text endpoint. */
const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
/**
 * Model choice: `whisper-large-v3-turbo` is ~3x cheaper per hour than the
 * non-turbo variant ($0.04 vs $0.111) and supports every language this tool
 * needs. The slower model buys a lower word-error rate on hard audio; that is a
 * deliberate override, not a default, so it lives in one named constant.
 */
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo'
/** Largest upload one Groq request accepts on the free tier. */
const GROQ_CHUNK_BYTES = 24 * 1024 * 1024
/** Seconds per chunk when the audio has to be split. */
const GROQ_CHUNK_SECONDS = 900

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'watch_video',
    description: 'Download a YouTube, TikTok, Facebook, Instagram, X, or direct mp4 link. Return 8 to 24 frames and, when GROQ_API_KEY is set, a speech transcript from Groq Whisper (whisper-large-v3-turbo; audio over 24 MB is split into 15-minute windows first). Use this when the user gives a video link and wants to know what is in it.',
    timeoutMs: 240000,
    parameters: {
      url: { type: 'string', required: true, description: 'Public video page or a direct mp4 URL.' },
      frames: { type: 'number', description: 'How many frames to sample, from 8 to 24. Defaults to about one frame every 3 seconds, clamped to that range.' },
      language: { type: 'string', description: 'Optional speech language, such as vi or en. Omit it to let the transcription model detect the language.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          durationSeconds: { type: 'number', required: true },
          transcript: { type: 'string' },
          frames: { type: 'array', required: true, items: imageSchema },
          note: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: value.note }]
        for (const frame of value.frames) {
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: frame.attachmentId,
              mediaType: frame.mediaType,
              bytes: frame.bytes,
              width: frame.width,
              height: frame.height,
              name: `frame-${frame.atSeconds}s.jpg`,
            },
          })
        }
        return blocks
      },
    },
    async execute(args, exec) {
      const url = videoUrl(args.url)
      const language = args.language === undefined || args.language === '' ? undefined : String(args.language).trim()
      const dir = await mkdtemp(join(tmpdir(), 'dsh-watch-'))
      try {
        await run('yt-dlp', [
          '--no-playlist',
          '--no-progress',
          '--max-filesize', '80M',
          '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
          '-o', join(dir, 'video.%(ext)s'),
          url,
        ], { signal: exec.signal, timeoutMs: 120000 })
        const names = await readdir(dir)
        const video = names.find((name) => /\.(mp4|webm|mkv)$/i.test(name))
        if (!video) throw new Error('yt-dlp did not save a video file')
        const videoPath = join(dir, video)
        const duration = await durationOf(videoPath, exec.signal)
        const count = frameCount(args.frames, duration)
        const rate = duration > 0 ? `${count}/${duration}` : '1'
        await run('ffmpeg', [
          '-y', '-i', videoPath,
          '-vf', `fps=${rate},scale=768:-2`,
          '-frames:v', String(count),
          join(dir, 'frame-%02d.jpg'),
        ], { signal: exec.signal, timeoutMs: 90000 })
        const frames = (await readdir(dir)).filter((name) => name.startsWith('frame-')).sort()
        if (frames.length === 0) throw new Error('ffmpeg did not write any frames')
        const attachments = ctx.get('attachments')
        if (attachments === undefined) throw new Error('no attachment service is mounted')
        const saved = []
        for (const [index, name] of frames.entries()) {
          const data = await readFile(join(dir, name))
          const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name })
          const atSeconds = duration > 0 ? Math.round((duration * index) / frames.length) : index
          saved.push({
            atSeconds,
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          })
        }
        let transcript
        let speechNote = 'Transcript skipped: GROQ_API_KEY is not set.'
        try {
          const audioPath = join(dir, 'audio.mp3')
          await run('ffmpeg', [
            '-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
            audioPath,
          ], { signal: exec.signal, timeoutMs: 90000 })
          if (!process.env.GROQ_API_KEY) speechNote = 'Transcript skipped: GROQ_API_KEY is not set.'
          else {
            transcript = await transcribeInChunks(audioPath, dir, language, run, exec)
            speechNote = transcript ? 'Transcript included.' : 'No speech was detected.'
          }
        } catch (error) {
          // A missing key is a configuration state, not a failure: report it as
          // "skipped" so the caller still gets the frames.
          speechNote = process.env.GROQ_API_KEY
            ? `Transcript failed: ${error.message}`
            : 'Transcript skipped: GROQ_API_KEY is not set.'
        }
        const note = [
          `Watched ${url}.`,
          `Duration ${Math.round(duration)}s.`,
          `${saved.length} frames.`,
          speechNote,
          transcript ? `\n${transcript}` : '',
        ].filter(Boolean).join(' ')
        return {
          url,
          durationSeconds: Math.round(duration * 10) / 10,
          ...(transcript === undefined ? {} : { transcript }),
          frames: saved,
          note,
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }))
}

/**
 * One tool, watch_video. Download a public video, sample frames, and
 * transcribe speech when XAI_API_KEY is set.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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

async function transcribe(audio, language, signal) {
  const key = process.env.XAI_API_KEY
  if (!key) return null
  const form = new FormData()
  form.append('model', 'grok-voice-transcribe-2.0')
  form.append('format', 'true')
  if (language) form.append('language', language)
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3')
  const response = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}` },
    body: form,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`xAI speech-to-text failed (${response.status}): ${detail}`)
  }
  const payload = await response.json()
  return typeof payload.text === 'string' ? payload.text.trim() : ''
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'watch_video',
    description: 'Download a YouTube, TikTok, Facebook, Instagram, X, or direct mp4 link. Return 8 to 24 frames and, when XAI_API_KEY is set, a transcript from POST /v1/stt using grok-voice-transcribe-2.0. Use this when the user gives a video link and wants to know what is in it.',
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
        let speechNote = 'Transcript skipped: XAI_API_KEY is not set.'
        try {
          await run('ffmpeg', [
            '-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
            join(dir, 'audio.mp3'),
          ], { signal: exec.signal, timeoutMs: 60000 })
          const audio = await readFile(join(dir, 'audio.mp3'))
          if (!process.env.XAI_API_KEY) speechNote = 'Transcript skipped: XAI_API_KEY is not set.'
          else {
            transcript = await transcribe(audio, language, exec.signal)
            speechNote = transcript ? 'Transcript included.' : 'No speech was detected.'
          }
        } catch (error) {
          if (process.env.XAI_API_KEY) speechNote = `Transcript failed: ${error.message}`
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

// Everything here is a pure function of its arguments: no `$`, no clock, no process.
// register.tsx runs the commands and hands their output to these, so they can be tested alone.
import type { Gpu, GpuDetail, Job } from '../types'

export const shortModel = (id?: string) =>
  ['fable', 'opus', 'sonnet', 'haiku'].find(k => (id ?? '').toLowerCase().includes(k)) ?? '?'

// 'claude-opus-5-5[1m]' → '5.5'. A date suffix (8 digits) is not read as a version.
export const versionOf = (id?: string) => {
  const m = /(?:fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec((id ?? '').toLowerCase())
  return m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]!) : ''
}

export const bar = (pct: number, cells = 8) => {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return ['━'.repeat(filled), '━'.repeat(cells - filled)] as const
}

export function remaining(resetsAt: string | undefined, nowMs: number): string {
  const ms = resetsAt ? Date.parse(resetsAt) - nowMs : NaN
  if (!(ms > 0)) return ''
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h${String(min % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`
}

const csvRows = (out: string) =>
  out.trim().split('\n').filter(l => l.trim() !== '').map(l => l.split(',').map(v => v.trim()))

// `nvidia-smi --query-gpu=index,utilization.gpu,memory.used --format=csv,noheader,nounits`.
// A row that is not three numbers (a card reporting "[N/A]", an error line) is dropped.
export const parseGpus = (stdout: string): Gpu[] =>
  csvRows(stdout)
    .map(row => row.map(Number))
    .filter(v => v.length === 3 && v.every(Number.isFinite))
    .map(([index = 0, util = 0, memMb = 0]) => ({ index, util, memGb: Math.floor(memMb / 1024) }))

// `ps -o pid=,user= -p ...` → { pid: user }
export function parseOwners(stdout: string): Record<string, string> {
  const owner: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const [pid, user] = line.trim().split(/\s+/)
    if (pid && user) owner[pid] = user
  }
  return owner
}

// PIDs from `nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory`.
export const appPids = (appsOut: string) => csvRows(appsOut).map(a => a[1] ?? '').filter(v => v !== '')

// Join the per-card query (uuid,index,utilization.gpu,memory.used,memory.total,temperature.gpu)
// with the per-process one, so each card lists the accounts on it. An account ps could not name is '?'.
export function gpuDetails(cardsOut: string, appsOut: string, owner: Record<string, string>): GpuDetail[] {
  const apps = csvRows(appsOut)
  return csvRows(cardsOut).map(([uuid = '', index, util, used, total, temp]) => ({
    index: Number(index),
    util: Number(util),
    memGb: Math.round(Number(used) / 1024),
    totalGb: Math.round(Number(total) / 1024),
    temp: Number(temp),
    users: apps
      .filter(a => a[0] === uuid)
      .map(a => `${owner[a[1] ?? ''] ?? '?'} ${Math.round(Number(a[2]) / 1024)}G`)
      .join(', '),
  }))
}

// The watch file: one pattern per line, blank lines and # comments ignored.
export const parsePatterns = (text: string) =>
  text.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))

// `ps -u <user> -o args=`: how many distinct command lines contain a pattern.
export const countJobs = (psOut: string, patterns: readonly string[]) =>
  new Set(psOut.split('\n').filter(l => patterns.some(p => l.includes(p))).map(l => l.trim().slice(0, 160))).size

// `ps -u <user> -o pid=,etime=,args=`: the matching jobs, identical command lines listed once.
export function listJobs(psOut: string, patterns: readonly string[]): Job[] {
  const seen = new Set<string>()
  const jobs: Job[] = []
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m || !patterns.some(p => m[3]!.includes(p)) || seen.has(m[3]!.slice(0, 160))) continue
    seen.add(m[3]!.slice(0, 160))
    jobs.push({ pid: m[1]!, elapsed: m[2]!, command: m[3]! })
  }
  return jobs
}

// Status lines from other mods that only say nothing is wrong. A line with a real count ("2 active cases") is not one.
const QUIET_STATUS = ['no active cases', 'waste≈0']
export const isQuietStatus = (text: string | undefined) => text !== undefined && QUIET_STATUS.some(q => text.includes(q))

// ── options ──

// `dark` is fixed hex tuned for a dark terminal. `theme` follows the Claude Code theme, so it also
// reads on a light background; unselected buttons then have no fill of their own.
export type Palette = {
  border: string; label: string; ok: string; warn: string; bad: string
  track: string // the unfilled part of a bar
  chipBg: string | undefined; chipFg: string // unselected button
  effort: string; model: string; action: string // selected effort, current model, compact
  onColor: string // text on a colored button
}

const PALETTES: Record<string, Palette> = {
  dark: {
    border: '#4b5263', label: '#7f8798', ok: '#7ee787', warn: '#f2cc60', bad: '#ff7b72',
    track: '#2d323d', chipBg: '#2d323d', chipFg: '#c9d1d9',
    effort: '#d19a66', model: '#61afef', action: '#c678dd', onColor: '#1b1f27',
  },
  theme: {
    border: 'subtle', label: 'inactive', ok: 'success', warn: 'warning', bad: 'error',
    track: 'subtle', chipBg: undefined, chipFg: 'text',
    effort: 'warning', model: 'suggestion', action: 'permission', onColor: 'inverseText',
  },
}

export const paletteOf = (name: unknown): Palette => PALETTES[String(name)] ?? PALETTES.dark!

export const pctColor = (c: Palette, pct: number) => (pct >= 85 ? c.bad : pct >= 60 ? c.warn : c.ok)

const STRINGS = {
  en: {
    usage: (label: string, pct: number, at: number) => `${label} usage at ${pct}% (threshold ${at}%)`,
    paneFailed: (reason: string) => `Could not open the GPU pane: ${reason}`,
    gpuCommand: 'Open a pane with every GPU and your training jobs',
    opened: 'Opened the GPU · jobs pane.',
    noGpus: 'no output from nvidia-smi',
    noJobs: 'no watched jobs',
  },
  ko: {
    usage: (label: string, pct: number, at: number) => `${label} 한도 ${pct}% (임계치 ${at}%)`,
    paneFailed: (reason: string) => `GPU 창을 열지 못함: ${reason}`,
    gpuCommand: 'GPU 전체와 내 학습 job 목록을 옆 창으로 연다',
    opened: 'GPU · jobs 창을 열었습니다.',
    noGpus: 'nvidia-smi 결과 없음',
    noJobs: '감시 대상 job 없음',
  },
}
export type Strings = (typeof STRINGS)['en']
export const stringsOf = (language: unknown): Strings => (language === 'ko' ? STRINGS.ko : STRINGS.en)

// A threshold outside 1–100 (or not a number) falls back to the default rather than never or always firing.
export function thresholdsOf(fiveHour: unknown, sevenDay: unknown): Record<string, number> {
  const pick = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback
  }
  return { five_hour: pick(fiveHour, 80), seven_day: pick(sevenDay, 70) }
}

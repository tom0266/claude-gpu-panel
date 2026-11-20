import { expect, test } from 'claude-code/testing'

import {
  appPids, bar, countJobs, gpuDetails, isQuietStatus, listJobs, paletteOf, parseGpus, parseOwners, parsePatterns, pctColor,
  remaining, shortModel, stringsOf, thresholdsOf, versionOf,
} from './lib'

test('parseGpus: reads index, utilization and memory, and drops rows that are not three numbers', () => {
  const out = '0, 0, 3\n1, 92, 39012\n2, [N/A], [N/A]\nFailed to initialize NVML\n'
  expect(parseGpus(out)).toEqual([
    { index: 0, util: 0, memGb: 0 },
    { index: 1, util: 92, memGb: 38 },
  ])
  expect(parseGpus('')).toEqual([])
})

test('gpuDetails: lists the accounts on each card, and marks a process ps could not name', () => {
  const cards = 'GPU-aaa, 0, 0, 3, 46068, 31\nGPU-bbb, 1, 92, 39012, 49140, 71\n'
  const apps = 'GPU-bbb, 4242, 38000\nGPU-bbb, 5151, 1012\n'
  expect(appPids(apps)).toEqual(['4242', '5151'])
  const owner = parseOwners('  4242 alice\n')
  expect(gpuDetails(cards, apps, owner)).toEqual([
    { index: 0, util: 0, memGb: 0, totalGb: 45, temp: 31, users: '' },
    { index: 1, util: 92, memGb: 38, totalGb: 48, temp: 71, users: 'alice 37G, ? 1G' },
  ])
})

test('jobs: comments and blank lines are not patterns, and identical command lines count once', () => {
  const patterns = parsePatterns('# watch these\ntrain.py\n\n  optuna  \n')
  expect(patterns).toEqual(['train.py', 'optuna'])
  const args = 'python train.py --fold 3\npython train.py --fold 3\npython train.py --fold 4\nvim notes.md\n'
  expect(countJobs(args, patterns)).toBe(2)
  const full = '  101 4-02:11:08 python train.py --fold 3\n  102 00:12 python train.py --fold 3\n  103 01:00 optuna study\n  104 00:01 vim notes.md\n'
  expect(listJobs(full, patterns)).toEqual([
    { pid: '101', elapsed: '4-02:11:08', command: 'python train.py --fold 3' },
    { pid: '103', elapsed: '01:00', command: 'optuna study' },
  ])
  expect(countJobs(args, [])).toBe(0)
})

test('versionOf: reads the version from a model id and ignores a date suffix', () => {
  expect(versionOf('claude-opus-5-5[1m]')).toBe('5.5')
  expect(versionOf('claude-fable-5-2')).toBe('5.2')
  expect(versionOf('claude-opus-5')).toBe('5')
  expect(versionOf('claude-sonnet-5-20260101')).toBe('5')
  expect(versionOf('opus')).toBe('')
  expect(shortModel('claude-haiku-5-5')).toBe('haiku')
  expect(shortModel(undefined)).toBe('?')
})

test('remaining: minutes, hours and days until reset, empty once the reset has passed', () => {
  const now = Date.parse('2026-11-20T00:00:00Z')
  expect(remaining('2026-11-20T00:45:00Z', now)).toBe('45m')
  expect(remaining('2026-11-20T04:20:00Z', now)).toBe('4h20m')
  expect(remaining('2026-11-24T00:00:00Z', now)).toBe('4d0h')
  expect(remaining('2026-11-19T00:00:00Z', now)).toBe('')
  expect(remaining(undefined, now)).toBe('')
})

test('bar: fills in proportion and never leaves the track', () => {
  expect(bar(50, 8).map(s => s.length)).toEqual([4, 4])
  expect(bar(0, 8).map(s => s.length)).toEqual([0, 8])
  expect(bar(140, 8).map(s => s.length)).toEqual([8, 0])
})

test('options: unknown values fall back to the defaults', () => {
  expect(thresholdsOf(90, 50)).toEqual({ five_hour: 90, seven_day: 50 })
  expect(thresholdsOf(0, 'x')).toEqual({ five_hour: 80, seven_day: 70 })
  expect(thresholdsOf(undefined, 250)).toEqual({ five_hour: 80, seven_day: 70 })
  expect(paletteOf('nope')).toBe(paletteOf('dark'))
  expect(paletteOf('theme').ok).toBe('success')
  expect(pctColor(paletteOf('dark'), 90)).toBe(paletteOf('dark').bad)
  expect(pctColor(paletteOf('dark'), 10)).toBe(paletteOf('dark').ok)
  expect(stringsOf('ko').noJobs).toBe('감시 대상 job 없음')
  expect(stringsOf('fr').noJobs).toBe('no watched jobs')
})

test('isQuietStatus: an all-clear line is quiet, a line reporting cases is not', () => {
  expect(isQuietStatus('loop-detective: no active cases')).toBe(true)
  expect(isQuietStatus('context-inspector: ctx 19% · waste≈0')).toBe(true)
  expect(isQuietStatus('loop-detective: 2 active cases')).toBe(false)
  expect(isQuietStatus(undefined)).toBe(false)
})

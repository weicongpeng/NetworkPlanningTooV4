import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zh from '../zh.json'
import en from '../en.json'

// 结果页/搜索相关页面：`t('key')` 里出现的静态 key 必须在两份语言包里都存在。
// i18next 未配置 missingKeyHandler，缺 key 时直接把 "common.xxx" 渲染给用户
// （2026-11-03：邻区结果搜索曾因此显示 "common.resultUnavailable"）。
const SOURCE_FILES = [
  'pages/NeighborPage.tsx',
  'pages/TACPage.tsx',
  'pages/TACPlanningPage.tsx',
  'pages/PCIPage.tsx',
]

const STATIC_KEY = /\bt\(\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g

function resolve(bundle: unknown, key: string): boolean {
  let cur: unknown = bundle
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in (cur as Record<string, unknown>))) {
      return false
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  return true
}

function keysUsedIn(file: string): string[] {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf-8')
  return Array.from(new Set(Array.from(source.matchAll(STATIC_KEY), (m) => m[1])))
}

describe('i18n keys', () => {
  for (const file of SOURCE_FILES) {
    it(`${file} 使用的文案 key 在中英文语言包中都存在`, () => {
      const missingZh = keysUsedIn(file).filter((key) => !resolve(zh, key))
      const missingEn = keysUsedIn(file).filter((key) => !resolve(en, key))
      expect({ file, missingZh, missingEn }).toEqual({ file, missingZh: [], missingEn: [] })
    })
  }

  it('搜索结果空态/失败态文案已定义', () => {
    for (const key of [
      'common.searching',
      'common.noMatchResult',
      'common.resultUnavailable',
      'common.loadingResult',
      'common.loadFailed',
    ]) {
      expect([key, resolve(zh, key), resolve(en, key)]).toEqual([key, true, true])
    }
  })
})

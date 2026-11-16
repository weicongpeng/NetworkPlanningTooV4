/** 账号切换后 IM 身份必须跟随服务器 user.id，而不是本机镜像 id。 */
import { beforeEach, describe, expect, it } from 'vitest'

import { imUserId } from '../types'

describe('imUserId', () => {
  beforeEach(() => localStorage.clear())

  it('共享桌面模式优先使用服务器 id', () => {
    expect(imUserId({ id: 3, im_user_id: 27 })).toBe(27)
  })

  it('网页端/单机模式没有 im_user_id 时回退本机 id', () => {
    expect(imUserId({ id: 3 })).toBe(3)
    expect(imUserId({ id: 3, im_user_id: null })).toBe(3)
    expect(imUserId(null)).toBeNull()
  })

  it('切换账号后立即反映新用户身份', () => {
    let user: { id: number; im_user_id?: number | null } | null = { id: 3, im_user_id: 27 }
    expect(imUserId(user)).toBe(27)
    user = { id: 4, im_user_id: 41 }
    expect(imUserId(user)).toBe(41)
    user = null
    expect(imUserId(user)).toBeNull()
  })
})

/** 协作沟通统一头像：有 avatar(data URL) 显示图片，否则退化为首字母 / 群图标。 */
import { useMemo, useState } from 'react'
import { UsersRound } from 'lucide-react'

export interface ImAvatarProps {
  name?: string
  avatar?: string | null
  kind?: 'user' | 'group'
  /** 像素尺寸 */
  size?: number
  className?: string
  online?: boolean
  rounded?: 'full' | 'xl'
}

const GRADIENTS: Record<'user' | 'group', string> = {
  user: 'from-indigo-500 to-violet-500',
  group: 'from-emerald-500 to-teal-500',
}

export function ImAvatar({
  name = '', avatar, kind = 'user', size = 36, className = '', online, rounded = 'xl',
}: ImAvatarProps) {
  const [broken, setBroken] = useState(false)
  const initial = useMemo(() => (name || '?').trim().slice(0, 1).toUpperCase(), [name])
  const shape = rounded === 'full' ? 'rounded-full' : 'rounded-xl'
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      {avatar && !broken ? (
        <img
          src={avatar}
          alt={name || 'avatar'}
          onError={() => setBroken(true)}
          className={`h-full w-full ${shape} object-cover shadow-sm`}
        />
      ) : (
        <div
          className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${GRADIENTS[kind]} font-semibold text-white shadow-sm ${shape}`}
          style={{ fontSize: Math.max(10, Math.round(size * 0.36)) }}
        >
          {kind === 'group' ? <UsersRound size={Math.round(size * 0.5)} /> : initial}
        </div>
      )}
      {online !== undefined && (
        <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card
          ${online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
      )}
    </div>
  )
}


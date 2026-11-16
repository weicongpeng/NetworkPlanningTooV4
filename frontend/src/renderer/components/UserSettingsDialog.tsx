/**
 * 用户自助设置弹窗。两种入口共用本弹窗，由 mode 决定内容：
 *  - 'app'（左侧边栏用户冒泡框「设置」）：头像 + 修改密码（密码统一收口到这里）
 *  - 'im' （协作沟通左下角「设置」）：头像 + 昵称（不提供修改密码）
 *
 * 头像支持「选择图片」与「调用电脑相机拍照」，统一走 prepareAvatar 压缩成后端
 * 合规的 data URL；昵称只影响协作沟通展示名，不改登录账号 username。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  Camera, FolderOpen, HardDrive, KeyRound, Loader2, Settings2, Trash2, X,
} from 'lucide-react'

import { clearImAttachmentCache, desktopLoginApi, imApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useImStore } from '../store/imStore'
import { useToastStore } from '../store/toastStore'
import type { UserSettingsMode } from './Im/userSettingsBus'
import { ImAvatar } from './Im/ImAvatar'
import { formatBytes, imDisplayName } from './Im/types'
import {
  prepareAvatar, prepareAvatarFromVideo, validateAvatarDataUrl,
} from './Im/avatarUtils'

interface Props {
  open: boolean
  onClose: () => void
  mode?: UserSettingsMode
}

/** 昵称长度上限，与后端 im_service.MAX_NICKNAME_LENGTH 一致 */
const NICKNAME_MAX = 24

/** 简单签名的翻译包装，隔离 i18next TFunction 的复杂重载类型 */
type Tr = (key: string, fallback: string) => string

/** 把后端错误码 / HTTP 状态翻译成可读文案；无法归类时透出后端原文 */
function serverErrorText(err: unknown, fallbackKey: string,
                         fallbackText: string, tr: Tr): string {
  const e = err as { message?: string; detail?: string; code?: number } | null
  const raw = String(e?.message || e?.detail || '').trim()
  if (raw.includes('IM_INVALID_AVATAR')) return tr('im.settings.avatarInvalidFormat', '图片格式不被接受，请换一张')
  if (raw.includes('IM_RELAY_FAILED')) return tr('im.settings.avatarRelayFailed', '共享模式同步失败，请检查网络后重试')
  if (raw.includes('IM_INVALID_NICKNAME')) return tr('im.settings.nicknameInvalid', '昵称含非法字符或过长')
  if (raw.includes('IM_RATE_LIMITED') || e?.code === 429) return tr('im.settings.rateLimited', '操作太频繁，请稍后再试')
  if (e?.code === 413 || /\b413\b/.test(raw)) return tr('im.settings.avatarTooLarge', '图片过大，请换一张更小的图片')
  // 后端返回的中文 detail（如登录态失效、网络错误）直接透出，便于定位
  if (raw && raw !== '请求失败' && raw !== 'Network Error') return raw
  return tr(fallbackKey, fallbackText)
}

export function UserSettingsDialog({ open, onClose, mode = 'app' }: Props) {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const desktopMode = useAuthStore(s => s.desktopMode)
  const changePassword = useAuthStore(s => s.changePassword)
  const logout = useAuthStore(s => s.logout)
  const fileRef = useRef<HTMLInputElement>(null)

  const [avatar, setAvatar] = useState<string | null>(user?.avatar ?? null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  const [cameraOpen, setCameraOpen] = useState(false)

  const [nickname, setNickname] = useState(user?.nickname ?? '')
  const [nicknameBusy, setNicknameBusy] = useState(false)
  const [nicknameError, setNicknameError] = useState('')

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)

  const [storagePath, setStoragePath] = useState('')
  const [storageDefault, setStorageDefault] = useState('')
  const [storageUsage, setStorageUsage] = useState<{
    total_files: number; total_bytes: number
  } | null>(null)
  const [storageBusy, setStorageBusy] = useState(false)
  const [cleanBusy, setCleanBusy] = useState(false)
  const [storageError, setStorageError] = useState('')

  useEffect(() => {
    if (!open) return
    setAvatar(user?.avatar ?? null)
    setAvatarError('')
    setNickname(user?.nickname ?? '')
    setNicknameError('')
    setPasswordError('')
    setOldPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setCameraOpen(false)
  }, [open, user?.avatar, user?.nickname, user?.id, mode])

  // 项目沟通左下角设置 + 桌面端：读取当前档的本地存储路径与占用
  useEffect(() => {
    if (!open || !desktopMode || mode !== 'im') return
    let cancelled = false
    void desktopLoginApi.imStorageState().then((res: any) => {
      if (cancelled || !res?.data) return
      setStoragePath(res.data.path || '')
      setStorageDefault(res.data.default_path || '')
      setStorageUsage(res.data.usage || null)
      setStorageError('')
    }).catch(() => {
      if (!cancelled) setStorageError(t('im.storage.loadFailed', '读取本地存储设置失败'))
    })
    return () => { cancelled = true }
  }, [open, desktopMode, mode, t])

  if (!open || !user) return null

  const tr: Tr = (key, fallback) => String(t(key, fallback))

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return
    setAvatarError('')
    try {
      const prepared = await prepareAvatar(file)
      if (!validateAvatarDataUrl(prepared)) throw new Error('IM_AVATAR_CANVAS')
      setAvatar(prepared)
    } catch {
      setAvatarError(t('im.settings.avatarInvalid', '请选择有效的图片文件'))
    }
  }

  const onPhoto = async (dataUrl: string) => {
    setCameraOpen(false)
    setAvatarError('')
    if (!validateAvatarDataUrl(dataUrl)) {
      setAvatarError(t('im.settings.avatarInvalid', '请选择有效的图片文件'))
      return
    }
    setAvatar(dataUrl)
  }

  const saveAvatar = async () => {
    setAvatarBusy(true)
    setAvatarError('')
    const value = avatar || ''
    try {
      // 保存前本地预检：格式/体积不符合后端规范就不发请求，避免必然失败的往返
      if (value && !validateAvatarDataUrl(value)) {
        setAvatarError(t('im.settings.avatarInvalid', '请选择有效的图片文件'))
        return
      }
      const resp = await imApi.updateAvatar(value)
      // 兼容后端 200 但 success:false 的信封，避免「假成功」
      if (resp && resp.success === false) throw new Error('IM_SAVE_REJECTED')
      useAuthStore.setState(state => ({
        user: state.user ? { ...state.user, avatar: value || null } : state.user,
      }))
      // 刷新会话/通讯录，让本端 IM 里的头像即时更新
      void useImStore.getState().refreshConversations().catch(() => {})
      void useImStore.getState().refreshContacts().catch(() => {})
      useToastStore.getState().show(t('im.settings.avatarSaved', '头像已更新'))
    } catch (err) {
      setAvatarError(serverErrorText(err, 'im.settings.avatarFailed', '头像保存失败，请重试', tr))
    } finally {
      setAvatarBusy(false)
    }
  }

  const saveNickname = async () => {
    setNicknameBusy(true)
    setNicknameError('')
    const value = nickname.trim()
    if (value.length > NICKNAME_MAX) {
      setNicknameError(t('im.settings.nicknameTooLong', { defaultValue: '昵称最多 {{max}} 个字符', max: NICKNAME_MAX }))
      setNicknameBusy(false)
      return
    }
    try {
      const resp = await imApi.updateNickname(value)
      if (resp && resp.success === false) throw new Error('IM_SAVE_REJECTED')
      // 昵称只写回 IM 展示用的字段；username 保持登录账号不变
      useAuthStore.setState(state => ({
        user: state.user ? { ...state.user, nickname: value || null } : state.user,
      }))
      void useImStore.getState().refreshConversations().catch(() => {})
      void useImStore.getState().refreshContacts().catch(() => {})
      useToastStore.getState().show(t('im.settings.nicknameSaved', '昵称已更新'))
    } catch (err) {
      setNicknameError(serverErrorText(err, 'im.settings.nicknameFailed', '昵称保存失败，请重试', tr))
    } finally {
      setNicknameBusy(false)
    }
  }

  const submitPassword = async () => {
    setPasswordError('')
    if (!oldPassword) { setPasswordError(t('auth.oldPasswordRequired', '请输入旧密码')); return }
    if (newPassword.length < 6) { setPasswordError(t('auth.passwordTooShort', '密码长度至少6位')); return }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('auth.passwordMismatch', '两次输入的密码不一致')); return
    }
    setPasswordBusy(true)
    try {
      await changePassword(oldPassword, newPassword, confirmPassword)
      if (desktopMode) {
        await desktopLoginApi.deleteLastLogin().catch(() => { /* 清除失败不阻断跳转 */ })
      }
      await logout()
    } catch (err: unknown) {
      const error = err as { message?: string; detail?: string } | null
      setPasswordError(error?.message || error?.detail || String(err))
      setPasswordBusy(false)
    }
  }

  const reloadStorage = async () => {
    const res: any = await desktopLoginApi.imStorageState()
    if (res?.data) {
      setStoragePath(res.data.path || '')
      setStorageDefault(res.data.default_path || '')
      setStorageUsage(res.data.usage || null)
    }
  }

  const applyStoragePath = async () => {
    setStorageBusy(true)
    setStorageError('')
    try {
      await desktopLoginApi.imStorageSetPath(storagePath)
      await reloadStorage()
      clearImAttachmentCache()
      useToastStore.getState().show(t('im.storage.applied', '保存路径已更新'))
    } catch (err) {
      setStorageError(serverErrorText(err, 'im.storage.applyFailed', '保存路径修改失败', tr))
    } finally {
      setStorageBusy(false)
    }
  }

  const pickStorageDir = async () => {
    try {
      const res: any = await desktopLoginApi.imStoragePickDirectory()
      if (res?.data?.picked) setStoragePath(res.data.picked)
    } catch {
      setStorageError(t('im.storage.pickFailed', '无法打开目录选择框，请手工输入路径'))
    }
  }

  const cleanStorage = async () => {
    setCleanBusy(true)
    setStorageError('')
    try {
      const res: any = await desktopLoginApi.imStorageClean()
      clearImAttachmentCache()
      await reloadStorage()
      useToastStore.getState().show(t('im.storage.cleaned', '已清理 {{count}} 个文件，释放 {{size}}',
        { count: res?.data?.deleted_files ?? 0, size: formatBytes(res?.data?.freed_bytes ?? 0) }))
    } catch (err) {
      setStorageError(serverErrorText(err, 'im.storage.cleanFailed', '清理失败，请重试', tr))
    } finally {
      setCleanBusy(false)
    }
  }

  const inputClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15'

  return (
    <div className="fixed inset-0 z-[7200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
         onClick={onClose}>
      <div className="flex max-h-[88vh] w-[440px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
           onClick={event => event.stopPropagation()}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Settings2 size={16} />
          </div>
          <h3 className="flex-1 text-sm font-semibold">{t('im.settings.title', '账号设置')}</h3>
          <button type="button" onClick={onClose} title={t('im.common.close', '关闭')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent cursor-pointer">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {/* 头像：两种模式共有 */}
          <section className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Camera size={13} /> {t('im.settings.avatarSection', '用户头像')}
            </h4>
            <div className="flex items-center gap-4">
              <ImAvatar name={imDisplayName(user)} avatar={avatar} kind="user" size={64} rounded="full" />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => fileRef.current?.click()}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent cursor-pointer">
                  {t('im.settings.chooseAvatar', '选择图片')}
                </button>
                <button type="button" onClick={() => setCameraOpen(true)}
                        className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent cursor-pointer">
                  <Camera size={12} /> {t('im.settings.takePhoto', '拍照')}
                </button>
                <button type="button" onClick={() => setAvatar(null)} disabled={!avatar}
                        className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40 cursor-pointer">
                  <Trash2 size={12} /> {t('im.settings.resetAvatar', '恢复默认')}
                </button>
                <button type="button" onClick={() => void saveAvatar()}
                        disabled={avatarBusy || avatar === (user.avatar ?? null)}
                        className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 disabled:opacity-40 cursor-pointer">
                  {avatarBusy && <Loader2 size={12} className="animate-spin" />}
                  {t('common.save', '保存')}
                </button>
              </div>
            </div>
            {avatarError && <p className="text-[11px] text-red-500">{avatarError}</p>}
            <input ref={fileRef} type="file" accept="image/*" hidden
                   onChange={event => { void pickAvatar(event.target.files?.[0]); event.target.value = '' }} />
          </section>

          <div className="h-px bg-border/60" />

          {/* 昵称：仅协作沟通入口 */}
          {mode === 'im' && (
            <section className="space-y-3">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <Settings2 size={13} /> {t('im.settings.nicknameSection', '用户昵称')}
              </h4>
              <input value={nickname} maxLength={NICKNAME_MAX + 8}
                     placeholder={t('im.settings.nicknamePlaceholder', '输入昵称，留空恢复账号名')}
                     className={inputClass}
                     onChange={event => setNickname(event.target.value)} />
              {nicknameError && <p className="text-[11px] text-red-500">{nicknameError}</p>}
              <button type="button" onClick={() => void saveNickname()}
                      disabled={nicknameBusy || nickname.trim() === (user.nickname ?? '')}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50 cursor-pointer">
                {nicknameBusy && <Loader2 size={12} className="animate-spin" />}
                {t('common.save', '保存')}
              </button>
            </section>
          )}

          {/* 本地存储：仅桌面端 + 项目沟通设置入口 */}
          {mode === 'im' && desktopMode && (
            <section className="space-y-3">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <HardDrive size={13} /> {t('im.storage.section', '本地存储与缓存')}
              </h4>
              <div className="rounded-xl border border-border/70 bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                {t('im.storage.current', '当前保存路径')}：
                <span className="break-all font-mono text-foreground">{storagePath || storageDefault || '—'}</span>
                {storageDefault && storagePath !== storageDefault && (
                  <> <br />{t('im.storage.default', '默认路径')}：
                    <span className="break-all font-mono">{storageDefault}</span></>
                )}
              </div>
              <input value={storagePath} onChange={event => setStoragePath(event.target.value)}
                     aria-label={t('im.storage.pathLabel', '聊天记录与文件保存路径')}
                     className={inputClass} />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void pickStorageDir()}
                        className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent cursor-pointer">
                  <FolderOpen size={13} /> {t('im.storage.browse', '浏览…')}
                </button>
                <button type="button" onClick={() => void applyStoragePath()}
                        disabled={storageBusy || !storagePath.trim() || storagePath === storageDefault}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50 cursor-pointer">
                  {storageBusy && <Loader2 size={12} className="mr-1 inline animate-spin" />}
                  {t('im.storage.apply', '应用并迁移')}
                </button>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border/70 bg-background/40 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">
                  {t('im.storage.usage', '可清理缓存：{{count}} 个文件 · {{size}}',
                    { count: storageUsage?.total_files ?? 0,
                      size: formatBytes(storageUsage?.total_bytes ?? 0) })}
                </span>
                <button type="button" onClick={() => void cleanStorage()}
                        disabled={cleanBusy || !storageUsage?.total_files}
                        className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40 cursor-pointer">
                  <Trash2 size={13} /> {t('im.storage.clean', '清理')}
                </button>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t('im.storage.hint', '仅清理本机临时文件与图片缓存；不会删除聊天消息、正式附件或服务器数据。')}
              </p>
              {storageError && <p className="text-[11px] text-red-500">{storageError}</p>}
            </section>
          )}

          {/* 修改密码：仅应用侧栏设置入口 */}
          {mode === 'app' && (
            <section className="space-y-3">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <KeyRound size={13} /> {t('auth.changePassword', '修改密码')}
              </h4>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('auth.changePasswordHint', '修改成功后将退出登录，请用新密码重新登录。')}
              </p>
              <div className="space-y-2">
                <input type="password" value={oldPassword} autoComplete="current-password"
                       placeholder={t('auth.oldPassword', '旧密码')} className={inputClass}
                       onChange={event => setOldPassword(event.target.value)} />
                <input type="password" value={newPassword} autoComplete="new-password"
                       placeholder={t('auth.newPassword', '新密码')} className={inputClass}
                       onChange={event => setNewPassword(event.target.value)} />
                <input type="password" value={confirmPassword} autoComplete="new-password"
                       placeholder={t('auth.confirmNewPassword', '确认新密码')} className={inputClass}
                       onChange={event => setConfirmPassword(event.target.value)} />
              </div>
              {passwordError && <p className="text-[11px] text-red-500">{passwordError}</p>}
              <button type="button" onClick={() => void submitPassword()} disabled={passwordBusy}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50 cursor-pointer">
                {passwordBusy && <Loader2 size={12} className="animate-spin" />}
                {t('auth.changePassword', '修改密码')}
              </button>
            </section>
          )}
        </div>
      </div>

      {cameraOpen && (
        <CameraCapture
          onClose={() => setCameraOpen(false)}
          onCapture={dataUrl => void onPhoto(dataUrl)}
        />
      )}
    </div>
  )
}

/** 电脑相机拍照：getUserMedia 预览 → 抓一帧 → 复用头像压缩链路 */
function CameraCapture({ onClose, onCapture }: {
  onClose: () => void
  onCapture: (dataUrl: string) => void
}) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  useEffect(() => {
    let cancelled = false
    const media = navigator.mediaDevices
    if (!media || typeof media.getUserMedia !== 'function') {
      setError(t('im.settings.cameraUnavailable', '当前环境不支持调用相机，请改用「选择图片」'))
      return
    }
    void media.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          void video.play().catch(() => {})
        }
      })
      .catch((err: unknown) => {
        const name = String((err as { name?: string } | null)?.name || '')
        setError(name === 'NotAllowedError' || name === 'SecurityError'
          ? t('im.settings.cameraDenied', '相机权限被拒绝，请在系统设置中允许后重试，或改用「选择图片」')
          : t('im.settings.cameraUnavailable', '无法打开相机，请改用「选择图片」'))
      })
    return () => { cancelled = true; stop() }
  }, [stop, t])

  const capture = async () => {
    const video = videoRef.current
    if (!video || busy) return
    setBusy(true)
    setError('')
    try {
      onCapture(await prepareAvatarFromVideo(video))
    } catch {
      setError(t('im.settings.cameraCaptureFailed', '拍摄失败，请重试或改用「选择图片」'))
      setBusy(false)
      return
    }
    stop()
  }

  return createPortal(
    <div className="fixed inset-0 z-[7300] flex items-center justify-center bg-black/70 p-4"
         onClick={onClose}>
      <div className="w-[420px] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
           onClick={event => event.stopPropagation()}>
        <header className="flex h-11 items-center gap-2 border-b border-border/60 px-4">
          <Camera size={15} className="text-primary" />
          <h4 className="flex-1 text-sm font-semibold">{t('im.settings.cameraTitle', '相机拍照')}</h4>
          <button type="button" onClick={onClose} title={t('im.common.close', '关闭')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent cursor-pointer">
            <X size={16} />
          </button>
        </header>
        <div className="relative aspect-video bg-black">
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
        </div>
        <p className="px-4 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          {t('im.settings.cameraHint', '对准镜头后点「拍摄」，照片会自动裁剪为方形并压缩。')}
        </p>
        {error && <p className="px-4 pt-2 text-[11px] text-red-500">{error}</p>}
        <div className="flex justify-end gap-2 px-4 py-3">
          <button type="button" onClick={onClose}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent cursor-pointer">
            {t('im.common.cancel', '取消')}
          </button>
          <button type="button" onClick={() => void capture()} disabled={busy || !!error}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 disabled:opacity-40 cursor-pointer">
            {busy && <Loader2 size={12} className="animate-spin" />}
            <Camera size={13} /> {t('im.settings.cameraCapture', '拍摄')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

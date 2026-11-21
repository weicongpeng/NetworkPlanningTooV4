/**
 * 自建群管理弹窗：群成员名单、群主剔除成员 / 添加成员 / 解散群 / 改群头像、
 * 普通成员主动退群。自动群与单聊不走这里（ImChatPanel 只在自建群显示管理入口）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Camera, Check, Loader2, LogOut, Search, Trash2, UserPlus, X,
} from 'lucide-react'

import { useAuthStore } from '../../store/authStore'
import { useImStore } from '../../store/imStore'
import { useToastStore } from '../../store/toastStore'
import { ImAvatar } from './ImAvatar'
import { prepareAvatar } from './avatarUtils'
import { imDisplayName, imUserId } from './types'
import type { ImConversation, ImMember } from './types'

interface Props {
  conversation: ImConversation
  onClose: () => void
}

/** selector 空数组必须稳定，否则每次渲染都拿到新引用 */
const EMPTY_MEMBERS: ImMember[] = []

export function ImGroupMembersDialog({ conversation, onClose }: Props) {
  const { t } = useTranslation()
  const myId = useAuthStore(s => imUserId(s.user))
  const members = useImStore(s => s.membersByConversation[conversation.id] ?? EMPTY_MEMBERS)
  const contacts = useImStore(s => s.contacts)
  const ensureMembers = useImStore(s => s.ensureMembers)
  const invalidateMembers = useImStore(s => s.invalidateMembers)
  const removeMember = useImStore(s => s.removeMember)
  const addGroupMembers = useImStore(s => s.addGroupMembers)
  const leaveGroup = useImStore(s => s.leaveGroup)
  const dissolveGroup = useImStore(s => s.dissolveGroup)
  const updateGroupAvatar = useImStore(s => s.updateGroupAvatar)
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  // 不用 window.confirm：WebView2 / pywebview 可能禁用 JS 原生对话框，导致按钮静默失效
  const [confirmState, setConfirmState] = useState<{
    message: string
    action: () => Promise<boolean>
    success: string
  } | null>(null)

  useEffect(() => {
    // 共享桌面模式成员列表每次回源都要走公网 relay；ensureMembers 自带 60s 缓存，
    // 打开弹窗不再强制失效，否则「看一下成员」就卡十几秒。成员变更走 afterChange。
    void ensureMembers(conversation.id)
  }, [conversation.id, ensureMembers])

  // Esc 只关本弹窗：ImWindow 有 window 级 Esc 监听会把整个协作沟通窗口关掉
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const ownerId = conversation.owner_id ?? null
  const isOwner = myId !== null && ownerId === myId
  const canManage = isOwner || conversation.my_role === 'admin'
  const isCustom = conversation.kind === 'custom_group'
  const groupName = conversation.name || t('im.sidebar.unnamedGroup', '未命名群组')

  const candidates = useMemo(() => {
    const joined = new Set(members.map(member => member.id))
    return (contacts?.users || []).filter(user => !joined.has(user.id) && user.id !== myId)
  }, [contacts, members, myId])

  const filteredCandidates = useMemo(() => {
    const keyword = addQuery.trim().toLowerCase()
    if (!keyword) return candidates
    return candidates.filter(user => [
      imDisplayName(user),
      user.username,
      user.city,
      user.operator,
    ].some(value => (value || '').toLowerCase().includes(keyword)))
  }, [addQuery, candidates])

  const afterChange = async () => {
    invalidateMembers(conversation.id)
    await ensureMembers(conversation.id)
  }

  const run = async (action: () => Promise<boolean>, successText: string, closeAfter = false) => {
    if (busy) return false
    setBusy(true)
    const ok = await action()
    setBusy(false)
    if (ok) {
      useToastStore.getState().show(successText)
      if (closeAfter) { onClose(); return true }
      await afterChange()
    }
    return ok
  }

  const onPickAvatar = async (file: File | undefined) => {
    if (!file) return
    try {
      const avatar = await prepareAvatar(file)
      setAvatarPreview(avatar)
      await run(() => updateGroupAvatar(conversation.id, avatar),
        t('im.groupManage.avatarSaved', '群头像已更新'))
      setAvatarPreview(null)
    } catch {
      useToastStore.getState().show(t('im.settings.avatarInvalid', '请选择有效的图片'))
    }
  }

  const resetAvatar = () => {
    void run(() => updateGroupAvatar(conversation.id, ''),
      t('im.groupManage.avatarSaved', '群头像已更新'))
  }

  const confirmAndRun = (message: string, action: () => Promise<boolean>, success: string) => {
    setConfirmState({ message, action, success })
  }

  const roleLabel = (role?: ImMember['role']) => role === 'owner'
    ? t('im.chat.roleOwner', '群主')
    : role === 'admin' ? t('im.chat.roleAdmin', '管理员')
      : t('im.chat.roleMember', '成员')

  const closeAddPanel = () => {
    setAddOpen(false)
    setSelected([])
    setAddQuery('')
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4"
         onClick={onClose}>
      <div className="flex max-h-full w-[360px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
           onClick={event => event.stopPropagation()}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <ImAvatar name={conversation.name || ''} avatar={avatarPreview || conversation.avatar}
                    kind="group" size={26} />
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t('im.chat.groupMembersTitle', {
              defaultValue: '群成员 · {{count}}', count: members.length,
            })}
          </h3>
          <button type="button" onClick={onClose}
                  className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-accent cursor-pointer">
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {members.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              <Loader2 size={14} className="mx-auto animate-spin" /> {t('im.chat.loading', '加载中')}
            </p>
          )}
          {members.map(member => (
            <div key={member.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/50">
              <ImAvatar name={imDisplayName(member)} avatar={member.avatar} kind="user" size={28} />
              <span className="min-w-0 flex-1 truncate text-xs">
                {imDisplayName(member)}{member.id === myId ? ` (${t('im.message.me', '我')})` : ''}
              </span>
              <span className="text-[10px] text-muted-foreground">{roleLabel(member.role)}</span>
              {canManage && member.id !== myId && member.role !== 'owner' && (
                <button type="button" disabled={busy}
                        title={t('im.groupManage.kick', '剔除成员')}
                        onClick={() => confirmAndRun(
                          t('im.groupManage.kickConfirm', {
                            defaultValue: '确定将「{{name}}」移出群组吗？移出后 TA 将无法查看群内消息。',
                            name: imDisplayName(member),
                          }),
                          () => removeMember(conversation.id, member.id),
                          t('im.groupManage.kicked', {
                            defaultValue: '已将「{{name}}」移出群组，群内已同步提示',
                            name: imDisplayName(member),
                          }),
                        )}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-40 cursor-pointer">
                  <X size={13} />
                </button>
              )}
            </div>
          ))}

          {addOpen && (
            <div className="mt-2 rounded-xl border border-border/70 bg-background/50 p-2">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                {t('im.groupManage.addTitle', '添加成员')}
              </p>
              <div className="relative mb-1.5">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus
                  value={addQuery}
                  onChange={event => setAddQuery(event.target.value)}
                  placeholder={t('im.groupManage.searchPlaceholder', '搜索成员（昵称 / 账号 / 地市 / 运营商）')}
                  className="h-7 w-full rounded-lg border border-border/60 bg-background/60 pl-7 pr-7 text-[11px] outline-none focus:border-primary/60"
                />
                {addQuery && (
                  <button type="button" onClick={() => setAddQuery('')}
                          title={t('im.common.clear', '清空')}
                          className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
                    <X size={11} />
                  </button>
                )}
              </div>
              <div className="max-h-[160px] space-y-0.5 overflow-y-auto">
                {candidates.length === 0 && (
                  <p className="py-3 text-center text-[11px] text-muted-foreground">
                    {t('im.groupManage.noCandidates', '没有可添加的联系人')}
                  </p>
                )}
                {candidates.length > 0 && filteredCandidates.length === 0 && (
                  <p className="py-3 text-center text-[11px] text-muted-foreground">
                    {t('im.groupManage.noMatches', '没有匹配的成员')}
                  </p>
                )}
                {filteredCandidates.map(user => (
                  <button key={user.id} type="button"
                          onClick={() => setSelected(list => list.includes(user.id)
                            ? list.filter(id => id !== user.id) : [...list, user.id])}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-accent/60 cursor-pointer">
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border
                      ${selected.includes(user.id) ? 'border-primary bg-primary text-white' : 'border-border'}`}>
                      {selected.includes(user.id) && <Check size={11} />}
                    </span>
                    <ImAvatar name={imDisplayName(user)} avatar={user.avatar} kind="user" size={20} />
                    <span className="min-w-0 flex-1 truncate text-[11px]">{imDisplayName(user)}</span>
                    {(user.city || user.operator) && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {[user.city, user.operator].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <button type="button" onClick={closeAddPanel}
                        className="rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-accent cursor-pointer">
                  {t('im.common.cancel', '取消')}
                </button>
                <button type="button" disabled={busy || selected.length === 0}
                        onClick={() => void (async () => {
                          const ok = await run(
                            () => addGroupMembers(conversation.id, selected),
                            t('im.groupManage.added', {
                              defaultValue: '已邀请 {{count}} 位成员加入群聊，群内已同步提示',
                              count: selected.length,
                            }))
                          if (ok) closeAddPanel()
                        })()}
                        className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40 cursor-pointer">
                  {t('im.groupManage.add', '添加')}
                </button>
              </div>
            </div>
          )}
        </div>

        {isCustom && (
          <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2.5">
            {canManage && (
              <>
                <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
                        title={t('im.groupManage.changeAvatar', '修改群头像')}
                        className="flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[11px] hover:bg-accent disabled:opacity-40 cursor-pointer">
                  <Camera size={12} /> {t('im.groupManage.avatar', '群头像')}
                </button>
                {conversation.avatar && (
                  <button type="button" disabled={busy} onClick={resetAvatar}
                          title={t('im.settings.resetAvatar', '恢复默认')}
                          className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 cursor-pointer">
                    <Trash2 size={12} />
                  </button>
                )}
                <button type="button" disabled={busy}
                        onClick={() => { if (addOpen) closeAddPanel(); else setAddOpen(true) }}
                        title={t('im.groupManage.addTitle', '添加成员')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 cursor-pointer">
                  <UserPlus size={12} />
                </button>
              </>
            )}
            <span className="flex-1" />
            {!isOwner && (
              <button type="button" disabled={busy}
              onClick={() => confirmAndRun(
                t('im.groupManage.leaveConfirm', {
                  defaultValue: '确定退出「{{name}}」吗？退出后将不再接收该群消息。', name: groupName,
                }),
                () => leaveGroup(conversation.id),
                t('im.groupManage.left', { defaultValue: '已退出「{{name}}」', name: groupName }),
              )}
                      className="flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40 cursor-pointer">
                <LogOut size={12} /> {t('im.groupManage.leave', '退群')}
              </button>
            )}
            {isOwner && (
              <button type="button" disabled={busy}
              onClick={() => confirmAndRun(
                t('im.groupManage.dissolveConfirm', {
                  defaultValue: '确定解散「{{name}}」吗？群消息与文件将全部删除且无法恢复，所有成员会自动退出。',
                  name: groupName,
                }),
                () => dissolveGroup(conversation.id),
                t('im.groupManage.dissolved', { defaultValue: '「{{name}}」已解散', name: groupName }),
              )}
                      className="flex h-7 items-center gap-1 rounded-lg border border-destructive/50 px-2 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-40 cursor-pointer">
                <Trash2 size={12} /> {t('im.groupManage.dissolve', '解散群')}
              </button>
            )}
          </footer>
        )}

        {confirmState && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 p-5">
            <div className="w-full rounded-xl border border-border bg-card p-4 shadow-xl">
              <p className="text-xs leading-relaxed">{confirmState.message}</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => setConfirmState(null)}
                        className="rounded-lg border border-border px-3 py-1.5 text-[11px] hover:bg-accent cursor-pointer">
                  {t('im.common.cancel', '取消')}
                </button>
                <button type="button" disabled={busy}
                        onClick={() => {
                          const state = confirmState
                          setConfirmState(null)
                          void run(state.action, state.success, true)
                        }}
                        className="rounded-lg bg-destructive px-3 py-1.5 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-40 cursor-pointer">
                  {t('common.confirm', '确定')}
                </button>
              </div>
            </div>
          </div>
        )}

        <input ref={fileRef} type="file" accept="image/*" hidden
               onChange={event => { void onPickAvatar(event.target.files?.[0]); event.target.value = '' }} />
      </div>
    </div>
  )
}

/** 左侧导航：消息 / 通讯录双 Tab、近期会话、在线离线联系人与群组。 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Building2, MessageSquare, Plus, Search, Settings2, Users,
} from 'lucide-react'

import { useAuthStore } from '../../store/authStore'
import { useImStore } from '../../store/imStore'
import { ImAvatar } from './ImAvatar'
import { systemNoticeText } from './ImSystemNotice'
import { openUserSettings } from './userSettingsBus'
import { conversationTitle, formatConversationTime, imDisplayName, parseSystemMessage } from './types'
import type { ImGroup, ImLastMessage, ImUser } from './types'

interface Props {
  /** 窄窗口下切到聊天区：点会话 / 点通讯录时立即调用，不再等会话请求返回 */
  onOpenChat: () => void
}

type Tr = (key: string, options?: Record<string, unknown>) => string

/** 会话列表预览：系统提示按语言渲染成友好短句，普通消息直接显示 preview 文本。 */
function lastMessagePreview(last: ImLastMessage | null, t: Tr): string {
  const noMessage = () => t('im.sidebar.noMessage', { defaultValue: '暂无消息' })
  if (!last) return noMessage()
  if (last.kind === 'system') {
    const payload = parseSystemMessage(last.preview)
    if (payload) return systemNoticeText(payload, t)
    return t('im.system.defaultNotice', { defaultValue: '群内通知' })
  }
  return last.preview || noMessage()
}

export function ImSidebar({ onOpenChat }: Props) {
  const { t } = useTranslation()
  // 包一层简单签名，避免 i18next TFunction 重载签名与纯函数类型不兼容
  const tr: Tr = (key, options) => String(t(key, options as never))
  const activeTab = useImStore(s => s.activeTab)
  const setTab = useImStore(s => s.setTab)
  const activeId = useImStore(s => s.activeConversationId)
  const conversations = useImStore(s => s.conversations)
  const contacts = useImStore(s => s.contacts)
  const online = useImStore(s => s.online)
  const openDirect = useImStore(s => s.openDirect)
  const openGroup = useImStore(s => s.openGroup)
  const setGroupDialog = useImStore(s => s.setGroupDialog)
  const currentUser = useAuthStore(s => s.user)
  const [query, setQuery] = useState('')

  const titleLabels = useMemo(() => ({
    unknownUser: t('im.sidebar.unknownUser', '用户'),
    unnamedGroup: t('im.sidebar.unnamedGroup', '未命名群组'),
    self: t('im.sidebar.self', '自己'),
    selfName: imDisplayName(currentUser),
  }), [t, currentUser])

  const filteredConversations = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return [...conversations]
      .filter(conv => !keyword || conversationTitle(conv, titleLabels).toLowerCase().includes(keyword)
        || lastMessagePreview(conv.last_message, tr).toLowerCase().includes(keyword))
      .sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''))
    // tr 由 t 派生，t 在语言切换时才变，这里跟随 titleLabels 一起刷新即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, query, titleLabels])

  const grouped = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const users = (contacts?.users || []).filter(u =>
      !keyword || u.username.toLowerCase().includes(keyword)
      || (u.nickname || '').toLowerCase().includes(keyword)
      || `${u.city}${u.operator}`.toLowerCase().includes(keyword))
    // 后端返回全站群（含 joined=false）。未加入的群没有消息读取权限，
    // 点进去只会 404 并停在空态，所以通讯录从源头只展示已加入的群。
    const groups = (contacts?.groups || []).filter(g =>
      g.joined && (!keyword || (g.name || '').toLowerCase().includes(keyword)))
    return {
      onlineUsers: users.filter(u => online[u.id] ?? u.is_online),
      offlineUsers: users.filter(u => !(online[u.id] ?? u.is_online)),
      autoGroups: groups.filter(g => g.is_auto),
      customGroups: groups.filter(g => !g.is_auto),
    }
  }, [contacts, online, query])

  const selectConversation = (id: number) => {
    onOpenChat()
    useImStore.getState().setActiveConversation(id)
  }

  // 通讯录点人/点群：先切视图（窄窗口立刻换到聊天区，store 内部也会先切 Tab +
  // 用本地资料占位），网络请求完全放到后台，点击不再等 1~3 个 RTT。
  const selectContact = (userId: number) => {
    onOpenChat()
    void openDirect(userId)
  }

  const selectGroup = (id: number) => {
    onOpenChat()
    void openGroup(id)
  }

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-border/60 bg-card/60 backdrop-blur-sm">
      <div className="shrink-0 px-3 pt-3">
        <div className="relative flex rounded-xl bg-muted/60 p-1">
          <div className={`absolute inset-y-1 w-[calc(50%-4px)] rounded-lg bg-card shadow-sm transition-transform duration-300
            ${activeTab === 'contacts' ? 'translate-x-[calc(100%+0px)]' : 'translate-x-0'}`}
               style={{ left: 4 }} />
          <button type="button" onClick={() => setTab('messages')}
                  className={`relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors cursor-pointer
                    ${activeTab === 'messages' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <MessageSquare size={14} /> {t('im.messages', '消息')}
          </button>
          <button type="button" onClick={() => setTab('contacts')}
                  className={`relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors cursor-pointer
                    ${activeTab === 'contacts' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <Users size={14} /> {t('im.contacts', '通讯录')}
          </button>
        </div>
        <div className="relative mt-2.5">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={activeTab === 'messages'
              ? t('im.sidebar.searchMessages', '搜索近期聊天')
              : t('im.sidebar.searchContacts', '搜索联系人或群组')}
            className="h-8 w-full rounded-lg border border-border/60 bg-background/60 pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {activeTab === 'messages' ? (
          <>
            {filteredConversations.length === 0 && (
              <EmptyHint text={query
                ? t('im.sidebar.noMatchConversation', '没有匹配的会话')
                : t('im.sidebar.noConversations', '暂无近期聊天，去通讯录发起对话')} />
            )}
            {filteredConversations.map(conv => {
              const selected = conv.id === activeId
              return (
                <button
                  type="button" key={conv.id}
                  onClick={() => selectConversation(conv.id)}
                  className={`relative mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors cursor-pointer
                    ${selected ? 'bg-primary/10' : 'hover:bg-accent/60'}`}
                >
                  {selected && <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-primary" />}
                  <ImAvatar
                    name={conversationTitle(conv, titleLabels)}
                    avatar={conv.kind === 'direct' ? conv.other_user?.avatar : conv.avatar}
                    kind={conv.kind === 'direct' ? 'user' : 'group'}
                    size={36}
                    online={conv.other_user ? (online[conv.other_user.id] ?? conv.other_user.is_online) : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                        {conversationTitle(conv, titleLabels)}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatConversationTime(conv.last_message_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {lastMessagePreview(conv.last_message, tr)}
                      </span>
                      {conv.unread > 0 && (
                        <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
                          {conv.unread > 99 ? '99+' : conv.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        ) : (
          <>
            <div className="mb-1 flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-semibold text-muted-foreground">
                {t('im.sidebar.onlineCount', {
                  defaultValue: '在线 · {{count}}',
                  count: contacts?.online_count ?? grouped.onlineUsers.length,
                })}
              </span>
              <button type="button" onClick={() => setGroupDialog(true)}
                      title={t('im.sidebar.newGroup', '新建群组')}
                      className="flex h-6 items-center gap-1 rounded-lg bg-primary/10 px-2 text-[11px] font-medium text-primary hover:bg-primary/20 cursor-pointer">
                <Plus size={12} /> {t('im.newGroup', '建群')}
              </button>
            </div>
            {grouped.onlineUsers.length === 0 && grouped.offlineUsers.length === 0 && (
              <EmptyHint text={query
                ? t('im.sidebar.noMatchContact', '没有匹配的联系人')
                : t('im.sidebar.noContacts', '暂无联系人')} />
            )}
            {grouped.onlineUsers.map(user => (
              <ContactRow key={user.id} user={user} online onSelect={selectContact} />
            ))}
            {grouped.offlineUsers.length > 0 && (
              <SectionLabel text={t('im.sidebar.offlineCount', {
                defaultValue: '离线 · {{count}}', count: grouped.offlineUsers.length,
              })} />
            )}
            {grouped.offlineUsers.map(user => (
              <ContactRow key={user.id} user={user} online={false} onSelect={selectContact} />
            ))}
            {grouped.autoGroups.length > 0 && (
              <SectionLabel text={t('im.sidebar.autoGroups', '数据组群（按地市 · 运营商自动建立）')} />
            )}
            {grouped.autoGroups.map(group => (
              <GroupRow key={group.id} group={group} onSelect={selectGroup} />
            ))}
            {grouped.customGroups.length > 0 && (
              <SectionLabel text={t('im.sidebar.customGroups', '自建群组')} />
            )}
            {grouped.customGroups.map(group => (
              <GroupRow key={group.id} group={group} onSelect={selectGroup} />
            ))}
          </>
        )}
      </div>

      {/* 协作沟通内的「用户头像 / 账号设置」入口（与左侧边栏冒泡框的「设置」共用弹窗） */}
      {currentUser && (
        <button type="button" onClick={() => openUserSettings('im')}
                title={t('im.settings.title', '设置')}
                className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2 text-left hover:bg-accent/60 cursor-pointer">
          <ImAvatar name={imDisplayName(currentUser)} avatar={currentUser.avatar} kind="user" size={28} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{imDisplayName(currentUser)}</span>
          <Settings2 size={14} className="shrink-0 text-muted-foreground" />
        </button>
      )}
    </aside>
  )
}

function SectionLabel({ text }: { text: string }) {
  return <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">{text}</p>
}

function EmptyHint({ text }: { text: string }) {
  return <p className="px-3 py-8 text-center text-[11px] leading-relaxed text-muted-foreground">{text}</p>
}

function ContactRow({ user, online, onSelect }: {
  user: ImUser
  online: boolean
  onSelect: (id: number) => void
}) {
  const { t } = useTranslation()
  return (
    <button type="button" onClick={() => void onSelect(user.id)}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-accent/60 cursor-pointer">
      <ImAvatar name={imDisplayName(user)} avatar={user.avatar} kind="user" size={32} online={online} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{imDisplayName(user)}</p>
        <p className="truncate text-[10px] text-muted-foreground">
          {[user.city, user.operator].filter(Boolean).join(' · ')
            || t('im.sidebar.unassignedGroup', '未分配数据组')}
        </p>
      </div>
      <span className="text-[10px] text-muted-foreground/70">
        {online ? t('im.online', '在线') : t('im.offline', '离线')}
      </span>
    </button>
  )
}

function GroupRow({ group, onSelect }: {
  group: ImGroup
  onSelect: (id: number) => void
}) {
  const { t } = useTranslation()
  return (
    <button type="button" onClick={() => void onSelect(group.id)}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-accent/60 cursor-pointer">
      {group.avatar || !group.is_auto
        ? <ImAvatar name={group.name} avatar={group.avatar} kind="group" size={32} />
        : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-sky-500 text-white">
            <Building2 size={15} />
          </div>
        )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{group.name}</p>
        <p className="truncate text-[10px] text-muted-foreground">
          {t('im.sidebar.memberCount', { defaultValue: '{{count}} 位成员', count: group.member_count })}
        </p>
      </div>
    </button>
  )
}

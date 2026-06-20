import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users, UserPlus, Search, Loader2, Trash2,
  RefreshCw, ChevronLeft, ChevronRight, Key, X, Circle, Ban, History
} from 'lucide-react'
import { adminUserApi } from '../services/api'
import type { UserInfo, UserSessionInfo } from '@shared/types'

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  } catch {
    return dateStr
  }
}

export function AppUsersPage() {
  const { t } = useTranslation()

  const [users, setUsers] = useState<UserInfo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showAddModal, setShowAddModal] = useState(false)
  const [showResetPwdModal, setShowResetPwdModal] = useState(false)
  const [editUser, setEditUser] = useState<UserInfo | null>(null)

  // Session modal
  const [sessionUser, setSessionUser] = useState<UserInfo | null>(null)
  const [sessions, setSessions] = useState<UserSessionInfo[]>([])
  const [showSessionModal, setShowSessionModal] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)

  // Form state
  const [formUsername, setFormUsername] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [formNewPassword, setFormNewPassword] = useState('')
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await adminUserApi.listAppUsers(page, pageSize, search || undefined)
      if (result.success && result.data) {
        setUsers(result.data.users)
        setTotal(result.data.total)
      }
    } catch (err: any) {
      setError(err?.message || t('admin.loadFailed', '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, t])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // --- Add User ---
  const handleAdd = async () => {
    if (formUsername.length < 3) { setFormError(t('admin.usernameTooShort')); return }
    if (formPassword.length < 6) { setFormError(t('auth.passwordTooShort')); return }
    setFormSubmitting(true)
    setFormError('')
    try {
      const result = await adminUserApi.createAppUser({
        username: formUsername,
        password: formPassword,
        confirm_password: formPassword,
      })
      if (result.success) {
        setShowAddModal(false)
        setFormUsername('')
        setFormPassword('')
        fetchUsers()
      }
    } catch (err: any) {
      setFormError(err?.message || t('admin.createFailed'))
    } finally {
      setFormSubmitting(false)
    }
  }

  // --- Reset Password ---
  const openResetPwd = (user: UserInfo) => {
    setEditUser(user)
    setFormNewPassword('')
    setFormError('')
    setShowResetPwdModal(true)
  }

  const handleResetPwd = async () => {
    if (!editUser) return
    if (formNewPassword.length < 6) { setFormError(t('auth.passwordTooShort')); return }
    setFormSubmitting(true)
    setFormError('')
    try {
      const result = await adminUserApi.resetPassword(editUser.id, { new_password: formNewPassword })
      if (result.success) {
        setShowResetPwdModal(false)
        setEditUser(null)
      }
    } catch (err: any) {
      setFormError(err?.message || t('admin.resetFailed'))
    } finally {
      setFormSubmitting(false)
    }
  }

  // --- Toggle Active ---
  const handleToggleActive = async (user: UserInfo) => {
    try {
      await adminUserApi.updateUser(user.id, { is_active: !user.is_active })
      fetchUsers()
    } catch { /* ignore */ }
  }

  // --- Delete ---
  const handleDelete = async (user: UserInfo) => {
    if (!confirm(t('admin.appUserDeleteConfirm', { username: user.username }))) return
    try {
      await adminUserApi.deleteUser(user.id)
      fetchUsers()
    } catch { /* ignore */ }
  }

  // --- View Sessions ---
  const openSessions = async (user: UserInfo) => {
    setSessionUser(user)
    setSessionLoading(true)
    setShowSessionModal(true)
    try {
      const result = await adminUserApi.getUser(user.id)
      if (result.success && result.data) {
        setSessions(result.data.sessions || [])
      }
    } catch {
      setSessions([])
    } finally {
      setSessionLoading(false)
    }
  }

  // --- Online count ---
  const onlineCount = users.filter(u => u.is_online).length

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Users size={24} className="text-primary" />
        </div>
        <h1 className="text-base font-bold text-foreground">{t('admin.appUserManagement', 'APP用户管理')}</h1>
      </div>

      {/* Stats */}
      <div className="flex gap-4 text-sm">
        <div className="px-3 py-2 bg-muted/30 rounded-lg border border-border">
          <span className="text-muted-foreground">{t('admin.totalUsers', '总用户数')}: </span>
          <span className="text-foreground font-medium">{total}</span>
        </div>
        <div className="px-3 py-2 bg-muted/30 rounded-lg border border-border">
          <span className="text-muted-foreground">{t('admin.onlineCount', '在线用户')}: </span>
          <span className="text-green-400 font-medium">{onlineCount}</span>
        </div>
      </div>

      {/* Search & Refresh & Add User */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            onKeyDown={(e) => { if (e.key === 'Enter') fetchUsers() }}
            placeholder={t('admin.searchPlaceholder', '搜索用户名...')}
            className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <button
          onClick={fetchUsers}
          className="px-3 py-2 border border-border rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <RefreshCw size={16} />
        </button>
        <button
          onClick={() => { setFormUsername(''); setFormPassword(''); setFormError(''); setShowAddModal(true) }}
          className="ml-auto px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <UserPlus size={16} />
          {t('admin.addAppUser', '添加APP用户')}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 flex items-center gap-2">
          <span>{error}</span>
          <button onClick={fetchUsers} className="text-primary hover:underline">{t('admin.retry', '重试')}</button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-muted-foreground" />
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          {t('admin.noAppUsers', '暂无APP用户')}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('auth.username', '用户名')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.status', '状态')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.sessionIp', 'IP地址')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.registrationTime', '注册时间')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.lastLogin', '最后登录')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.actions', '操作')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-border hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-foreground font-medium">{u.username}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${
                          u.is_online ? 'bg-green-400' : 'bg-muted-foreground/40'
                        }`} />
                        <span className={`text-xs ${u.is_online ? 'text-green-400' : 'text-muted-foreground'}`}>
                          {u.is_online ? t('admin.online', '在线') : t('admin.offline', '离线')}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{u.last_login_ip || '-'}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(u.created_at)}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(u.last_login)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleToggleActive(u)}
                          className={`p-1.5 rounded transition-colors ${
                            u.is_active
                              ? 'text-green-400 hover:bg-green-500/10'
                              : 'text-red-400 hover:bg-red-500/10'
                          }`}
                          title={u.is_active ? t('admin.active', '已启用') : t('admin.disabled', '已禁用')}
                        >
                          {u.is_active ? <Circle size={14} className="fill-current" /> : <Ban size={14} />}
                        </button>
                        <button
                          onClick={() => openResetPwd(u)}
                          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          title={t('admin.resetPassword', '重置密码')}
                        >
                          <Key size={14} />
                        </button>
                        <button
                          onClick={() => openSessions(u)}
                          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          title={t('admin.viewSessions', '查看登录记录')}
                        >
                          <History size={14} />
                        </button>
                        <button
                          onClick={() => handleDelete(u)}
                          className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                          title={t('admin.delete', '删除')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{t('admin.totalUsers', { count: total })}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-muted transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-muted-foreground px-2">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-muted transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Add User Modal */}
      {showAddModal && (
        <Modal title={t('admin.addAppUser', '添加APP用户')} onClose={() => setShowAddModal(false)}>
          <div className="space-y-4">
            {formError && <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400">{formError}</div>}
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.username')}</label>
              <input value={formUsername} onChange={(e) => setFormUsername(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.password')}</label>
              <input type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <button onClick={handleAdd} disabled={formSubmitting} className="w-full py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 flex items-center justify-center gap-2">
              {formSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('admin.createUser')}
            </button>
          </div>
        </Modal>
      )}

      {/* Reset Password Modal */}
      {showResetPwdModal && editUser && (
        <Modal title={`${t('admin.resetPassword', '重置密码')} - ${editUser.username}`} onClose={() => setShowResetPwdModal(false)}>
          <div className="space-y-4">
            {formError && <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400">{formError}</div>}
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.newPassword')}</label>
              <input type="password" value={formNewPassword} onChange={(e) => setFormNewPassword(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <button onClick={handleResetPwd} disabled={formSubmitting} className="w-full py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 flex items-center justify-center gap-2">
              {formSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('admin.resetPassword')}
            </button>
          </div>
        </Modal>
      )}

      {/* Session History Modal */}
      {showSessionModal && sessionUser && (
        <Modal title={`${t('admin.sessionHistory', '登录历史')} - ${sessionUser.username}`} onClose={() => setShowSessionModal(false)}>
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {sessionLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 size={24} className="animate-spin text-muted-foreground" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                {t('admin.noUsers', '暂无记录')}
              </div>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className="p-3 bg-muted/30 rounded-lg border border-border text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('admin.sessionTime', '登录时间')}:</span>
                    <span className="text-foreground">{formatDate(s.login_time)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('admin.sessionIp', '登录IP')}:</span>
                    <span className="text-foreground font-mono">{s.ip_address || '-'}</span>
                  </div>
                  {s.logout_time && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">登出时间:</span>
                      <span className="text-foreground">{formatDate(s.logout_time)}</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

// 内联 Modal 组件
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[6000] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl shadow-2xl p-6 w-96" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

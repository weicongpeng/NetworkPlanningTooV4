import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users, UserPlus, Search, Loader2, Shield, User, Pencil, Trash2,
  RefreshCw, ChevronLeft, ChevronRight, Key, X, Circle, Ban, History
} from 'lucide-react'
import { adminUserApi } from '../services/api'
import type { UserInfo, UserSessionInfo } from '@shared/types'

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}分钟`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return `${hours}小时${remainMins > 0 ? remainMins + '分钟' : ''}`
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  } catch {
    return dateStr
  }
}

export function AdminUsersPage() {
  const { t } = useTranslation()

  const [users, setUsers] = useState<UserInfo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showAddModal, setShowAddModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
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
  const [formIsAdmin, setFormIsAdmin] = useState(false)
  const [formLicenseExpiry, setFormLicenseExpiry] = useState('')
  const [formIsActive, setFormIsActive] = useState(true)
  const [formNewPassword, setFormNewPassword] = useState('')
  const [formCity, setFormCity] = useState('')
  const [formOperator, setFormOperator] = useState('')
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await adminUserApi.listUsers(page, pageSize, search || undefined)
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
      const result = await adminUserApi.createUser({
        username: formUsername,
        password: formPassword,
        confirm_password: formPassword,
        is_admin: formIsAdmin,
        license_expiry: formLicenseExpiry || null,
        city: formCity || undefined,
        operator: formOperator || undefined,
      })
      if (result.success) {
        setShowAddModal(false)
        resetForm()
        fetchUsers()
      }
    } catch (err: any) {
      setFormError(err?.message || t('admin.createFailed'))
    } finally {
      setFormSubmitting(false)
    }
  }

  // --- Edit User ---
  const openEdit = (user: UserInfo) => {
    setEditUser(user)
    setFormIsAdmin(user.is_admin)
    setFormIsActive(user.is_active)
    setFormLicenseExpiry(user.license_expiry ? user.license_expiry.slice(0, 10) : '')
    setFormCity(user.city || '')
    setFormOperator(user.operator || '')
    setFormError('')
    setShowEditModal(true)
  }

  const handleEdit = async () => {
    if (!editUser) return
    setFormSubmitting(true)
    setFormError('')
    try {
      const result = await adminUserApi.updateUser(editUser.id, {
        is_admin: formIsAdmin,
        is_active: formIsActive,
        license_expiry: formLicenseExpiry || null,
        city: formCity || null,
        operator: formOperator || null,
      })
      if (result.success) {
        setShowEditModal(false)
        resetForm()
        fetchUsers()
      }
    } catch (err: any) {
      setFormError(err?.message || t('admin.updateFailed'))
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
        resetForm()
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
    if (!confirm(t('admin.deleteConfirm', { username: user.username }))) return
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

  // --- Get APP latest session info ---
  const getAppSessionInfo = (userId: number) => {
    const appSession = sessions.find(s => s.client_type === 'app' && s.user_id === userId)
    return appSession || null
  }

  const resetForm = () => {
    setFormUsername('')
    setFormPassword('')
    setFormIsAdmin(false)
    setFormLicenseExpiry('')
    setFormIsActive(true)
    setFormNewPassword('')
    setFormCity('')
    setFormOperator('')
    setFormError('')
    setEditUser(null)
  }

  // APP session info map: store latest app session info per user from the list
  const [appSessionsCache, setAppSessionsCache] = useState<Record<number, UserSessionInfo | null>>({})

  // Fetch APP sessions for all users in current page
  useEffect(() => {
    const fetchAppSessions = async () => {
      const cache: Record<number, UserSessionInfo | null> = {}
      for (const u of users) {
        try {
          const result = await adminUserApi.getUser(u.id)
          if (result.success && result.data?.sessions) {
            const appSessions = result.data.sessions.filter(s => s.client_type === 'app')
            cache[u.id] = appSessions.length > 0 ? appSessions[0] : null
          }
        } catch {
          cache[u.id] = null
        }
      }
      setAppSessionsCache(cache)
    }
    if (users.length > 0) {
      fetchAppSessions()
    }
  }, [users])

  const onlineCount = users.filter(u => u.is_online).length

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Users size={24} className="text-primary" />
        </div>
        <h1 className="text-base font-bold text-foreground">{t('admin.title', '用户管理')}</h1>
      </div>

      {/* Stats */}
      <div className="flex gap-4 text-sm">
        <div className="px-3 py-2 bg-muted/30 rounded-lg border border-border">
          <span className="text-muted-foreground">{t('admin.totalUsers', '总用户数')}: </span>
          <span className="text-foreground font-medium">{total}</span>
        </div>
        <div className="px-3 py-2 bg-muted/30 rounded-lg border border-border">
          <span className="text-muted-foreground">PC在线: </span>
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
          title={t('admin.retry', '刷新')}
        >
          <RefreshCw size={16} />
        </button>
        <button
          onClick={() => { resetForm(); setShowAddModal(true) }}
          className="ml-auto px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <UserPlus size={16} />
          {t('admin.addUser', '添加用户')}
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
          {t('admin.noUsers', '暂无用户')}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('auth.username', '用户名')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.role', '角色')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('auth.city', '地市')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('auth.operator', '运营商')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.licenseExpiry', '许可证到期')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.clientType', '客户端')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.status', '状态')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.loginRecordIp', 'IP地址')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.registrationTime', '注册时间')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.lastLogin', '最后登录')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.usageDuration', '使用时长')}</th>
                  <th className="px-4 py-3 text-left text-muted-foreground font-medium">{t('admin.actions', '操作')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const appInfo = appSessionsCache[u.id]
                  return (
                    <tr key={u.id} className="border-t border-border hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-foreground font-medium" rowSpan={2}>{u.username}</td>
                      <td className="px-4 py-3" rowSpan={2}>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${u.is_admin ? 'bg-purple-500/10 text-purple-400' : 'bg-blue-500/10 text-blue-400'}`}>
                          {u.is_admin ? <Shield size={12} /> : <User size={12} />}
                          {u.is_admin ? t('admin.admin', '管理员') : t('admin.user', '普通用户')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs" rowSpan={2}>{u.city || '-'}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs" rowSpan={2}>{u.operator || '-'}</td>
                      <td className="px-4 py-3" rowSpan={2}>
                        {u.license_expiry ? (
                          <span className={`text-xs ${new Date(u.license_expiry) < new Date() ? 'text-red-400' : 'text-muted-foreground'}`}>
                            {u.license_expiry.slice(0, 10)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('admin.unlimited', '无限期')}</span>
                        )}
                      </td>
                      {/* PC row */}
                      <td className="px-4 py-3 text-xs text-muted-foreground">{t('admin.pcClient', 'PC端')}</td>
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
                      <td className="px-4 py-3 text-muted-foreground text-xs" rowSpan={2}>{formatDate(u.created_at)}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(u.last_login)}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{formatDuration(u.total_usage_seconds)}</td>
                      <td className="px-4 py-3" rowSpan={2}>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openEdit(u)}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title={t('admin.edit', '编辑')}
                          >
                            <Pencil size={14} />
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
                            title={t('admin.viewLoginRecords', '查看登录记录')}
                          >
                            <History size={14} />
                          </button>
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
                            onClick={() => handleDelete(u)}
                            disabled={u.is_admin}
                            className={`p-1.5 rounded transition-colors ${
                              u.is_admin
                                ? 'text-muted-foreground/30 cursor-not-allowed'
                                : 'hover:bg-red-500/10 text-muted-foreground hover:text-red-400'
                            }`}
                            title={u.is_admin ? t('admin.cannotDeleteAdmin', '不能删除管理员') : t('admin.delete', '删除')}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
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
        <Modal title={t('admin.addUser', '添加用户')} onClose={() => setShowAddModal(false)}>
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
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formIsAdmin} onChange={(e) => setFormIsAdmin(e.target.checked)} className="rounded" />
                <span className="text-sm text-foreground">{t('admin.adminPermission')}</span>
              </label>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.city')}</label>
              <input value={formCity} onChange={(e) => setFormCity(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" placeholder={t('auth.cityPlaceholder')} />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.operator')}</label>
              <select value={formOperator} onChange={(e) => setFormOperator(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">{t('auth.operatorPlaceholder')}</option>
                <option value="移动">{t('auth.operatorMobile')}</option>
                <option value="电信">{t('auth.operatorTelecom')}</option>
                <option value="联通">{t('auth.operatorUnicom')}</option>
                <option value="广电">{t('auth.operatorBroadcast')}</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('admin.licenseExpiryOptional')}</label>
              <input type="date" value={formLicenseExpiry} onChange={(e) => setFormLicenseExpiry(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <button onClick={handleAdd} disabled={formSubmitting} className="w-full py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 flex items-center justify-center gap-2">
              {formSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('admin.createUser')}
            </button>
          </div>
        </Modal>
      )}

      {/* Edit User Modal */}
      {showEditModal && editUser && (
        <Modal title={`${t('admin.editUser', '编辑用户')} - ${editUser.username}`} onClose={() => setShowEditModal(false)}>
          <div className="space-y-4">
            {formError && <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400">{formError}</div>}
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formIsAdmin} onChange={(e) => setFormIsAdmin(e.target.checked)} className="rounded" />
                <span className="text-sm text-foreground">{t('admin.adminPermission')}</span>
              </label>
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formIsActive} onChange={(e) => setFormIsActive(e.target.checked)} className="rounded" />
                <span className="text-sm text-foreground">{t('admin.enableAccount')}</span>
              </label>
            </div>
            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-sm text-blue-400">
                <span>📱 APP权限</span>
                <span className="text-muted-foreground">：{formIsActive ? '已启用' : '已禁用'}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">APP权限由账号启用状态统一控制</p>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.city')}</label>
              <input value={formCity} onChange={(e) => setFormCity(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" placeholder={t('auth.cityPlaceholder')} />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.operator')}</label>
              <select value={formOperator} onChange={(e) => setFormOperator(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">{t('auth.operatorPlaceholder')}</option>
                <option value="移动">{t('auth.operatorMobile')}</option>
                <option value="电信">{t('auth.operatorTelecom')}</option>
                <option value="联通">{t('auth.operatorUnicom')}</option>
                <option value="广电">{t('auth.operatorBroadcast')}</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('admin.licenseExpiryLabel')}</label>
              <input type="date" value={formLicenseExpiry} onChange={(e) => setFormLicenseExpiry(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <button onClick={handleEdit} disabled={formSubmitting} className="w-full py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 flex items-center justify-center gap-2">
              {formSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('admin.saveChanges')}
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
        <Modal title={`${t('admin.viewLoginRecords', '查看登录记录')} - ${sessionUser.username}`} onClose={() => setShowSessionModal(false)}>
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
                    <span className="text-muted-foreground">{t('admin.loginRecordTime', '登录时间')}:</span>
                    <span className="text-foreground">{formatDate(s.login_time)}</span>
                    <span className={`ml-auto px-1.5 py-0.5 rounded text-xs ${
                      s.client_type === 'app' ? 'bg-green-500/10 text-green-400' : 'bg-blue-500/10 text-blue-400'
                    }`}>
                      {s.client_type === 'app' ? t('admin.appClient', 'APP端') : t('admin.pcClient', 'PC端')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('admin.loginRecordIp', 'IP地址')}:</span>
                    <span className="font-mono">{s.ip_address || '-'}</span>
                  </div>
                  {s.logout_time && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">登出时间:</span>
                      <span>{formatDate(s.logout_time)}</span>
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

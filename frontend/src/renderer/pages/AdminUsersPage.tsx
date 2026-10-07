import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users, UserPlus, Search, Loader2, Shield, User, Pencil, Trash2,
  RefreshCw, Key, X, Circle, Ban, History
} from 'lucide-react'
import { adminUserApi, authApi } from '../services/api'
import type { UserInfo, UserSessionInfo, RegisterOptions } from '@shared/types'

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
  // 全量（跨所有页）在线统计，由后端返回
  const [onlineStats, setOnlineStats] = useState({ online: 0, pc: 0, app: 0 })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showAddModal, setShowAddModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showResetPwdModal, setShowResetPwdModal] = useState(false)
  // 组（地市+运营商）变更时的历史数据迁移范围选择弹窗
  const [showMigrateDialog, setShowMigrateDialog] = useState(false)
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
  const [groupOptions, setGroupOptions] = useState<RegisterOptions | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [formCanDataImport, setFormCanDataImport] = useState(false)
  const [formCanDataDelete, setFormCanDataDelete] = useState(false)
  const [formCanDataUpdate, setFormCanDataUpdate] = useState(false)
  const [formCanCellEntry, setFormCanCellEntry] = useState(false)
  const [formCanCellQueryUpdate, setFormCanCellQueryUpdate] = useState(false)
  const [formCanAssistant, setFormCanAssistant] = useState(false)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // 后端 page_size 上限 100，循环拉取全部用户（列表内部滚动，不再分页）
      const PAGE_SIZE = 100
      const first = await adminUserApi.listUsers(1, PAGE_SIZE, search || undefined)
      if (first.success && first.data) {
        let allUsers = first.data.users
        const totalCount = first.data.total
        const pageCount = Math.ceil(totalCount / PAGE_SIZE)
        for (let p = 2; p <= pageCount; p++) {
          const next = await adminUserApi.listUsers(p, PAGE_SIZE, search || undefined)
          if (next.success && next.data) allUsers = allUsers.concat(next.data.users)
        }
        setUsers(allUsers)
        setTotal(totalCount)
        setOnlineStats({
          online: first.data.online_users ?? 0,
          pc: first.data.online_pc ?? 0,
          app: first.data.online_app ?? 0,
        })
      }
    } catch (err: any) {
      setError(err?.message || t('admin.loadFailed', '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [search, t])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  // 地市/运营商下拉数据源：注册选项接口（与登录页注册一致）
  useEffect(() => {
    authApi.getOptions()
      .then(res => { if (res.success && res.data) setGroupOptions(res.data) })
      .catch(() => { /* 加载失败时下拉为空，后端保存时兜底校验 */ })
  }, [])

  // --- Add User ---
  const handleAdd = async () => {
    if (formUsername.length < 3) { setFormError(t('admin.usernameTooShort')); return }
    if (formPassword.length < 6) { setFormError(t('auth.passwordTooShort')); return }
    if (!formCity || !formOperator) { setFormError(t('auth.groupRequired', '请选择地市与运营商')); return }
    setFormSubmitting(true)
    setFormError('')
    try {
      const result = await adminUserApi.createUser({
        username: formUsername,
        password: formPassword,
        confirm_password: formPassword,
        is_admin: formIsAdmin,
        license_expiry: formLicenseExpiry || null,
        city: formCity,
        operator: formOperator,
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
    // 管理员默认享有全部权限：权限位一律显示为开启（编辑项不可操作）
    setFormCanDataImport(user.is_admin || !!user.can_data_import)
    setFormCanDataDelete(user.is_admin || !!user.can_data_delete)
    setFormCanDataUpdate(user.is_admin || !!user.can_data_update)
    setFormCanCellEntry(user.is_admin || !!user.can_cell_entry)
    setFormCanCellQueryUpdate(user.is_admin || !!user.can_cell_query_update)
    setFormCanAssistant(user.is_admin || !!user.can_assistant)
    setFormError('')
    setShowEditModal(true)
  }

  // 组是否发生变更（后端要求组变必须带迁移范围）
  const editGroupChanged = !!editUser &&
    ((formCity || null) !== (editUser.city || null) ||
     (formOperator || null) !== (editUser.operator || null))

  const submitEdit = async (migrateScope?: 'user' | 'group') => {
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
        ...(migrateScope ? { migrate_scope: migrateScope } : {}),
        can_data_import: formCanDataImport,
        can_data_delete: formCanDataDelete,
        can_data_update: formCanDataUpdate,
        can_cell_entry: formCanCellEntry,
        can_cell_query_update: formCanCellQueryUpdate,
        can_assistant: formCanAssistant,
      })
      if (result.success) {
        setShowMigrateDialog(false)
        setShowEditModal(false)
        resetForm()
        fetchUsers()
        const message = (result as any).message
        if (message) alert(message)
      }
    } catch (err: any) {
      setFormError(err?.message || t('admin.updateFailed'))
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleEdit = () => {
    if (!editUser) return
    // 组变更且新组完整：先让管理员选择历史数据迁移范围
    if (editGroupChanged && formCity && formOperator) {
      setFormError('')
      setShowMigrateDialog(true)
      return
    }
    submitEdit()
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
      const result = await adminUserApi.deleteUser(user.id)
      if (result.success) {
        fetchUsers()
      }
    } catch (err: any) {
      setError(err?.message || t('admin.deleteFailed'))
    }
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

  const resetForm = () => {
    setFormUsername('')
    setFormPassword('')
    setFormIsAdmin(false)
    setFormLicenseExpiry('')
    setFormIsActive(true)
    setFormNewPassword('')
    setFormCity('')
    setFormOperator('')
    setFormCanDataImport(false)
    setFormCanDataDelete(false)
    setFormCanDataUpdate(false)
    setFormCanCellEntry(false)
    setFormCanCellQueryUpdate(false)
    setFormCanAssistant(false)
    setFormError('')
    setEditUser(null)
  }

  // Per-user session cache: latest PC and APP session
  const [userSessionsCache, setUserSessionsCache] = useState<Record<number, { pc: UserSessionInfo | null; app: UserSessionInfo | null }>>({})

  // Fetch latest PC and APP session for each user in current list
  useEffect(() => {
    if (users.length === 0) {
      setUserSessionsCache({})
      return
    }
    let cancelled = false
    const fetchUserSessions = async () => {
      // 全量列表下逐个串行太慢，并发拉取
      const entries = await Promise.all(users.map(async (u) => {
        try {
          const result = await adminUserApi.getUser(u.id)
          const sessions = result.success ? result.data?.sessions : undefined
          return [u.id, {
            pc: sessions?.find((s: UserSessionInfo) => s.client_type === 'pc') || null,
            app: sessions?.find((s: UserSessionInfo) => s.client_type === 'app') || null,
          }] as const
        } catch {
          return [u.id, { pc: null, app: null }] as const
        }
      }))
      if (!cancelled) setUserSessionsCache(Object.fromEntries(entries))
    }
    fetchUserSessions()
    return () => { cancelled = true }
  }, [users])

  // 在线统计为全量（跨所有页），由后端基于全部用户计算
  const onlineCount = onlineStats.online
  const onlinePcCount = onlineStats.pc
  const onlineAppCount = onlineStats.app

  return (
    <div className="p-6 h-full min-h-0 flex flex-col gap-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Users size={24} className="text-primary" />
        </div>
        <h1 className="text-base font-bold text-foreground">{t('admin.title', '用户管理')}</h1>
      </div>

      {/* Search & Refresh & Stats & Add User */}
      <div className="flex gap-3 items-center shrink-0">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
        <div className="text-sm text-muted-foreground whitespace-nowrap">
          {t('admin.totalUsers', { count: total })}
          <span className="mx-2 text-border">|</span>
          {t('admin.onlineCount')}<span className="text-foreground font-medium mx-0.5">{onlineCount}</span>
          <span className="ml-1.5">{t('admin.pcCount')}<span className="text-green-400 font-medium mx-0.5">{onlinePcCount}</span></span>
          <span className="ml-1.5">{t('admin.appCount')}<span className="text-green-400 font-medium mx-0.5">{onlineAppCount}</span></span>
        </div>
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
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 flex items-center gap-2 shrink-0">
          <span>{error}</span>
          <button onClick={fetchUsers} className="text-primary hover:underline">{t('admin.retry', '重试')}</button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <Loader2 size={32} className="animate-spin text-muted-foreground" />
        </div>
      ) : users.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground">
          {t('admin.noUsers', '暂无用户')}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto bg-card border border-border rounded-lg shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0 z-10">
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
                  const sessionInfo = userSessionsCache[u.id] || { pc: null, app: null }
                  return (
                    <>
                      {/* PC 行 */}
                      <tr key={`${u.id}-pc`} className="border-t border-border hover:bg-muted/30 transition-colors">
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
                        <td className="px-4 py-3 text-xs text-muted-foreground">{t('admin.pcClient', 'PC端')}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={`inline-block w-2 h-2 rounded-full ${(u.is_online_pc ?? u.is_online) ? 'bg-green-400' : 'bg-muted-foreground/40'}`} />
                            <span className={`text-xs ${(u.is_online_pc ?? u.is_online) ? 'text-green-400' : 'text-muted-foreground'}`}>
                              {(u.is_online_pc ?? u.is_online) ? t('admin.online', '在线') : t('admin.offline', '离线')}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{sessionInfo.pc?.ip_address || u.last_login_ip || '-'}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs" rowSpan={2}>{formatDate(u.created_at)}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{sessionInfo.pc ? formatDate(sessionInfo.pc.login_time) : formatDate(u.last_login)}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{formatDuration(u.total_usage_seconds)}</td>
                        <td className="px-4 py-3" rowSpan={2}>
                          <div className="flex items-center gap-1">
                            <button onClick={() => openEdit(u)} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={t('admin.edit', '编辑')}>
                              <Pencil size={14} />
                            </button>
                            <button onClick={() => openResetPwd(u)} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={t('admin.resetPassword', '重置密码')}>
                              <Key size={14} />
                            </button>
                            <button onClick={() => openSessions(u)} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={t('admin.viewLoginRecords', '查看登录记录')}>
                              <History size={14} />
                            </button>
                            <button onClick={() => handleToggleActive(u)} className={`p-1.5 rounded transition-colors ${u.is_active ? 'text-green-400 hover:bg-green-500/10' : 'text-red-400 hover:bg-red-500/10'}`} title={u.is_active ? t('admin.active', '已启用') : t('admin.disabled', '已禁用')}>
                              {u.is_active ? <Circle size={14} className="fill-current" /> : <Ban size={14} />}
                            </button>
                            <button onClick={() => handleDelete(u)} disabled={u.is_admin} className={`p-1.5 rounded transition-colors ${u.is_admin ? 'text-muted-foreground/30 cursor-not-allowed' : 'hover:bg-red-500/10 text-muted-foreground hover:text-red-400'}`} title={u.is_admin ? t('admin.cannotDeleteAdmin', '不能删除管理员') : t('admin.delete', '删除')}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {/* APP 行 */}
                      <tr key={`${u.id}-app`} className="border-t border-border hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 text-xs text-muted-foreground">{t('admin.appClient', 'APP端')}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={`inline-block w-2 h-2 rounded-full ${u.is_online_app ? 'bg-green-400' : 'bg-muted-foreground/40'}`} />
                            <span className={`text-xs ${u.is_online_app ? 'text-green-400' : 'text-muted-foreground'}`}>
                              {u.is_online_app ? t('admin.online', '在线') : t('admin.offline', '离线')}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{sessionInfo.app?.ip_address || '-'}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{sessionInfo.app ? formatDate(sessionInfo.app.login_time) : '-'}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">-</td>
                      </tr>
                    </>
                  )
                })}
              </tbody>
            </table>
        </div>
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
              <select value={formCity} onChange={(e) => setFormCity(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">{t('auth.citySelectPlaceholder', '请选择地市')}</option>
                {(groupOptions?.cities || []).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.operator')}</label>
              <select value={formOperator} onChange={(e) => setFormOperator(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">{t('auth.operatorPlaceholder')}</option>
                {(groupOptions?.operators || ['移动', '联通', '电信', '广电']).map(op => (
                  <option key={op} value={op}>{op}</option>
                ))}
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
            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-sm text-blue-400 mb-2">
                <span>🖥️ {t('admin.pcDataPermissions', 'PC端数据权限')}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{t('admin.permissionsApplyToDataPage', '控制该用户在数据管理页面的操作权限')}</p>
              {editUser?.is_admin && (
                <p className="text-xs text-amber-500 mb-2">{t('admin.adminNotRestricted', '管理员不受此限制，开关不生效')}</p>
              )}
              <div className="space-y-1.5">
                {[
                  { key: 'can_data_import', label: t('admin.permDataImport', '数据导入'), value: formCanDataImport, setter: setFormCanDataImport },
                  { key: 'can_data_delete', label: t('admin.permDataDelete', '数据删除'), value: formCanDataDelete, setter: setFormCanDataDelete },
                  { key: 'can_data_update', label: t('admin.permDataUpdate', '工参更新'), value: formCanDataUpdate, setter: setFormCanDataUpdate },
                  { key: 'can_cell_entry', label: t('admin.permCellEntry', '新站录入'), value: formCanCellEntry, setter: setFormCanCellEntry },
                  { key: 'can_cell_query_update', label: t('admin.permCellQueryUpdate', '查询/修改'), value: formCanCellQueryUpdate, setter: setFormCanCellQueryUpdate },
                ].map((p) => (
                  <label key={p.key} className={`flex items-center gap-2 cursor-pointer ${editUser?.is_admin ? 'opacity-50 pointer-events-none' : ''}`}>
                    <input
                      type="checkbox"
                      checked={p.value}
                      onChange={(e) => p.setter(e.target.checked)}
                      disabled={!!editUser?.is_admin}
                      className="rounded"
                    />
                    <span className="text-sm text-foreground">{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-sm text-blue-400 mb-2">
                <span>🧩 {t('admin.pcFeaturePermissions', 'PC端功能权限')}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{t('admin.featurePermissionsHint', '控制该用户可访问的功能页面')}</p>
              {editUser?.is_admin && (
                <p className="text-xs text-amber-500 mb-2">{t('admin.adminNotRestricted', '管理员不受此限制，开关不生效')}</p>
              )}
              <div className="space-y-1.5">
                <label className={`flex items-center gap-2 cursor-pointer ${editUser?.is_admin ? 'opacity-50 pointer-events-none' : ''}`}>
                  <input
                    type="checkbox"
                    checked={formCanAssistant}
                    onChange={(e) => setFormCanAssistant(e.target.checked)}
                    disabled={!!editUser?.is_admin}
                    className="rounded"
                  />
                  <span className="text-sm text-foreground">{t('admin.permAssistant', '网优助手')}</span>
                </label>
              </div>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.city')}</label>
              <select value={formCity} onChange={(e) => setFormCity(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">{t('auth.citySelectPlaceholder', '请选择地市')}</option>
                {(groupOptions?.cities || []).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('auth.operator')}</label>
              <select value={formOperator} onChange={(e) => setFormOperator(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">{t('auth.operatorPlaceholder')}</option>
                {(groupOptions?.operators || ['移动', '联通', '电信', '广电']).map(op => (
                  <option key={op} value={op}>{op}</option>
                ))}
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

      {/* 组变更：历史数据迁移范围选择 */}
      {showMigrateDialog && editUser && (
        <Modal title={t('admin.migrateTitle', '数据组变更')} onClose={() => setShowMigrateDialog(false)}>
          <div className="space-y-4">
            {formError && <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400">{formError}</div>}
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('admin.migrateDesc', '用户的数据组将从 {{from}} 变更为 {{to}}，请选择历史数据（工参、规划任务、地理化数据、图层等）的迁移范围：', {
                from: `${editUser.city || '-'} / ${editUser.operator || '-'}`,
                to: `${formCity} / ${formOperator}`,
              })}
            </p>
            <button
              onClick={() => submitEdit('user')}
              disabled={formSubmitting}
              className="w-full text-left p-3 rounded-lg border border-primary/40 bg-primary/5 hover:bg-primary/10 disabled:opacity-50 transition-colors"
            >
              <div className="text-sm font-medium text-foreground flex items-center gap-2">
                {formSubmitting && <Loader2 size={14} className="animate-spin" />}
                {t('admin.migrateScopeUser', '仅迁移该用户的历史数据（推荐）')}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('admin.migrateScopeUserHint', '只迁移该用户本人产生的数据；同组其他成员共享的数据保留在原组。')}
              </div>
            </button>
            <button
              onClick={() => submitEdit('group')}
              disabled={formSubmitting}
              className="w-full text-left p-3 rounded-lg border border-orange-500/40 bg-orange-500/5 hover:bg-orange-500/10 disabled:opacity-50 transition-colors"
            >
              <div className="text-sm font-medium text-foreground flex items-center gap-2">
                {formSubmitting && <Loader2 size={14} className="animate-spin" />}
                {t('admin.migrateScopeGroup', '迁移整个旧组（含其他成员，谨慎）')}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('admin.migrateScopeGroupHint', '旧组下所有用户的数据全部改到新组；若旧组还有其他用户，他们将看不到原数据。')}
              </div>
            </button>
            <button
              onClick={() => setShowMigrateDialog(false)}
              disabled={formSubmitting}
              className="w-full py-2 border border-border rounded-lg text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              {t('common.cancel', '取消')}
            </button>
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

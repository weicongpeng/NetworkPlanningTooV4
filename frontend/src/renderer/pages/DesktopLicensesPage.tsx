import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Check, Copy, KeyRound, Pencil, Plus, RefreshCw, RotateCcw, Trash2, Unlink, X } from 'lucide-react'
import type { DesktopLicenseRecord } from '@shared/types'
import { authApi, desktopLicensesApi } from '../services/api'

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-blue-500/10 text-blue-500',
  issued: 'bg-amber-500/10 text-amber-600',
  active: 'bg-green-500/10 text-green-500',
  rejected: 'bg-red-500/10 text-red-500',
  disabled: 'bg-muted text-muted-foreground',
}

/**
 * 桌面版授权管理（管理员）：预建激活码 / 批准申请 / 禁用 / 解绑换机 / 重发码。
 * 客户端在「系统设置」页用激活码在线激活，或提交申请后由本页批准。
 */
export function DesktopLicensesPage() {
  const { t } = useTranslation()
  const [items, setItems] = useState<DesktopLicenseRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  // 共享模式登录会自动签发许可（无需管理），默认只看单机授权
  const [mode, setMode] = useState<'standalone' | 'shared' | ''>('standalone')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createOrg, setCreateOrg] = useState('')
  const [createLease, setCreateLease] = useState(30)
  const [createNote, setCreateNote] = useState('')
  const [createCity, setCreateCity] = useState('')
  const [createOperator, setCreateOperator] = useState('')
  const [createIdleLogout, setCreateIdleLogout] = useState(2)
  const [createUsername, setCreateUsername] = useState('')

  const [newCode, setNewCode] = useState<{ name: string; code: string } | null>(null)
  const [editing, setEditing] = useState<DesktopLicenseRecord | null>(null)
  const [editName, setEditName] = useState('')
  const [editOrg, setEditOrg] = useState('')
  const [editLease, setEditLease] = useState(30)
  const [editNote, setEditNote] = useState('')
  const [editCity, setEditCity] = useState('')
  const [editOperator, setEditOperator] = useState('')
  const [editIdleLogout, setEditIdleLogout] = useState(2)

  // 数据组下拉（地市 + 运营商）：决定该桌面端在共享模式下共享到哪一组的数据
  const [cities, setCities] = useState<string[]>([])
  const [operators, setOperators] = useState<string[]>([])

  useEffect(() => {
    authApi
      .getOptions()
      .then((res: any) => {
        if (res?.success) {
          setCities(res.data?.cities ?? [])
          setOperators(res.data?.operators ?? [])
        }
      })
      .catch(() => {})
  }, [])

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const res = await desktopLicensesApi.list(page, pageSize, status || undefined, keyword || undefined, mode || undefined)
      if (res.success) {
        setItems(res.data.items)
        setTotal(res.data.total)
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || t('desktopLicenses.loadFailed') })
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, status, keyword, mode, t])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const notify = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 6000)
  }

  const handleCreate = async () => {
    if (!createName.trim()) return
    try {
      const res: any = await desktopLicensesApi.create({
        licensee_username: createName.trim(),
        organization: createOrg.trim() || undefined,
        lease_days: createLease || undefined,
        note: createNote.trim() || undefined,
        city: createCity || null,
        operator: createOperator || null,
        idle_logout_days: createIdleLogout || undefined,
        username: createUsername.trim() || undefined,
      })
      if (res?.success) {
        setShowCreate(false)
        setNewCode({ name: res.data.licensee_username, code: res.data.activation_code })
        setCreateName('')
        setCreateOrg('')
        setCreateNote('')
        setCreateCity('')
        setCreateOperator('')
        setCreateUsername('')
        await fetchItems()
      }
    } catch (err: any) {
      notify('error', err?.message || t('desktopLicenses.createFailed'))
    }
  }

  const runAction = async (
    item: DesktopLicenseRecord,
    action: 'approve' | 'reject' | 'disable' | 'enable' | 'unbind' | 'regenerate-code',
  ) => {
    if (action === 'unbind' && !window.confirm(t('desktopLicenses.unbindConfirm', { name: item.licensee_username }))) {
      return
    }
    try {
      const res: any = await desktopLicensesApi.action(item.id, action)
      if (action === 'approve' || action === 'regenerate-code') {
        setNewCode({ name: item.licensee_username, code: res?.data?.activation_code || '' })
      } else if (action === 'unbind') {
        notify('success', t('desktopLicenses.unbindSuccess'))
      } else if (action === 'disable') {
        notify('success', t('desktopLicenses.disableSuccess'))
      } else if (action === 'enable') {
        notify('success', t('desktopLicenses.enableSuccess'))
      } else if (action === 'reject') {
        notify('success', t('desktopLicenses.rejectSuccess'))
      }
      await fetchItems()
    } catch (err: any) {
      notify('error', err?.message || t('desktopLicenses.actionFailed'))
    }
  }

  const handleDelete = async (item: DesktopLicenseRecord) => {
    if (!window.confirm(t('desktopLicenses.deleteConfirm', { name: item.licensee_username }))) return
    try {
      await desktopLicensesApi.remove(item.id)
      notify('success', t('desktopLicenses.deleteSuccess'))
      await fetchItems()
    } catch (err: any) {
      notify('error', err?.message || t('desktopLicenses.deleteFailed'))
    }
  }

  const openEdit = (item: DesktopLicenseRecord) => {
    setEditing(item)
    setEditName(item.licensee_username)
    setEditOrg(item.organization || '')
    setEditLease(item.lease_days)
    setEditNote(item.note || '')
    setEditCity((item as any).city || '')
    setEditOperator((item as any).operator || '')
    setEditIdleLogout(item.idle_logout_days ?? 2)
  }

  const submitEdit = async () => {
    if (!editing) return
    try {
      await desktopLicensesApi.update(editing.id, {
        licensee_username: editName.trim(),
        organization: editOrg.trim(),
        lease_days: editLease,
        note: editNote.trim(),
        city: editCity || null,
        operator: editOperator || null,
        idle_logout_days: editIdleLogout,
      })
      setEditing(null)
      notify('success', t('desktopLicenses.updateSuccess'))
      await fetchItems()
    } catch (err: any) {
      notify('error', err?.message || t('desktopLicenses.updateFailed'))
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      notify('success', t('license.copied'))
    } catch {
      notify('error', code)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const statusLabel = (value: string) =>
    t(`desktopLicenses.status_${value}`, { defaultValue: value })

  return (
    <div className="p-6 w-full space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={20} className="text-primary" />
          <h1 className="text-base font-bold">{t('desktopLicenses.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 text-sm font-medium flex items-center gap-1.5"
          >
            <Plus size={14} />
            {t('desktopLicenses.createButton')}
          </button>
          <button
            onClick={() => fetchItems()}
            className="p-2 hover:bg-muted rounded-lg"
            title={t('license.refresh')}
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 筛选 */}
      <div className="bg-card p-4 rounded-lg border border-border flex flex-wrap items-center gap-2">
        <select
          value={status}
          onChange={(e) => {
            setPage(1)
            setStatus(e.target.value)
          }}
          className="px-3 py-2 bg-background border border-border rounded-lg text-sm"
        >
          <option value="">{t('desktopLicenses.allStatus')}</option>
          <option value="pending">{t('desktopLicenses.status_pending')}</option>
          <option value="issued">{t('desktopLicenses.status_issued')}</option>
          <option value="active">{t('desktopLicenses.status_active')}</option>
          <option value="disabled">{t('desktopLicenses.status_disabled')}</option>
          <option value="rejected">{t('desktopLicenses.status_rejected')}</option>
        </select>
        <select
          value={mode}
          onChange={(e) => {
            setPage(1)
            setMode(e.target.value as 'standalone' | 'shared' | '')
          }}
          className="px-3 py-2 bg-background border border-border rounded-lg text-sm"
        >
          <option value="standalone">{t('desktopLicenses.modeStandalone', '单机授权')}</option>
          <option value="shared">{t('desktopLicenses.modeShared', '共享模式')}</option>
          <option value="">{t('desktopLicenses.allMode', '全部模式')}</option>
        </select>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(1)
              fetchItems()
            }
          }}
          placeholder={t('desktopLicenses.searchPlaceholder')}
          className="px-3 py-2 bg-background border border-border rounded-lg text-sm w-64"
        />
      </div>

      {message && (
        <div className={`p-3 rounded-lg flex items-center gap-2 ${
          message.type === 'success'
            ? 'bg-green-500/10 border border-green-500/20 text-green-500'
            : 'bg-red-500/10 border border-red-500/20 text-red-500'
        }`}>
          {message.type === 'success' ? <Check size={14} /> : <X size={14} />}
          <span className="text-xs">{message.text}</span>
        </div>
      )}

      {/* 新激活码提示 */}
      {newCode && (
        <div className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-1">
          <p className="text-xs text-muted-foreground">
            {t('desktopLicenses.codeFor', { name: newCode.name })}
          </p>
          <div className="flex items-center gap-2">
            <code className="text-sm font-mono tracking-wider">{newCode.code}</code>
            <button
              onClick={() => copyCode(newCode.code)}
              className="p-1.5 hover:bg-muted rounded"
              title={t('license.copy')}
            >
              <Copy size={14} />
            </button>
            <button onClick={() => setNewCode(null)} className="p-1.5 hover:bg-muted rounded">
              <X size={14} />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t('desktopLicenses.codeHint')}</p>
        </div>
      )}

      {/* 列表 */}
      <div className="bg-card rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm min-w-[1100px]">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colUser')}</th>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colStatus')}</th>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colCode')}</th>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colGroup')}</th>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colMachine')}</th>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colExpire')}</th>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colUsage', '登录情况')}</th>
              <th className="px-3 py-2 text-left">{t('desktopLicenses.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{item.licensee_username}</div>
                  {item.username && item.username !== item.licensee_username && (
                    <div className="text-xs text-muted-foreground">
                      {t('desktopLicenses.boundAccount', '账号')}: {item.username}
                    </div>
                  )}
                  {item.organization && (
                    <div className="text-xs text-muted-foreground">{item.organization}</div>
                  )}
                  {item.hostname && (
                    <div className="text-xs text-muted-foreground">{item.hostname}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_STYLE[item.status] || 'bg-muted'}`}>
                    {statusLabel(item.status)}
                  </span>
                  <div className="text-xs text-muted-foreground mt-1">
                    {item.source === 'approve' ? t('desktopLicenses.sourceApprove') : t('desktopLicenses.sourcePrecreate')}
                    {item.renewal_count > 0 && ` · ${t('desktopLicenses.renewCount', { count: item.renewal_count })}`}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {item.activation_code ? (
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs font-mono">{item.activation_code}</code>
                      <button
                        onClick={() => copyCode(item.activation_code as string)}
                        className="p-1 hover:bg-muted rounded"
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {(item as any).city && (item as any).operator ? (
                    <div className="text-xs">
                      {(item as any).city} / {(item as any).operator}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t('desktopLicenses.groupUnset')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className="text-xs font-mono">{item.machine_code || '-'}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="text-xs">{item.expire_date || '-'}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('desktopLicenses.leaseDays', { days: item.lease_days })}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="text-xs">
                    {t('desktopLicenses.loginCount', { count: item.login_count ?? 0 })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('desktopLicenses.idleLogoutDays', { days: item.idle_logout_days ?? 2 })}
                  </div>
                  {item.last_login_at && (
                    <div className="text-xs text-muted-foreground">
                      {item.last_login_at.slice(0, 16).replace('T', ' ')}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {item.status === 'pending' && (
                      <>
                        <button
                          onClick={() => runAction(item, 'approve')}
                          className="px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1"
                        >
                          <Check size={12} /> {t('desktopLicenses.approve')}
                        </button>
                        <button
                          onClick={() => runAction(item, 'reject')}
                          className="px-2 py-1 text-xs rounded border border-border hover:bg-muted flex items-center gap-1"
                        >
                          <X size={12} /> {t('desktopLicenses.reject')}
                        </button>
                      </>
                    )}
                    {item.status === 'disabled' ? (
                      <button
                        onClick={() => runAction(item, 'enable')}
                        className="px-2 py-1 text-xs rounded border border-border hover:bg-muted flex items-center gap-1"
                        title={t('desktopLicenses.enable')}
                      >
                        <RotateCcw size={12} /> {t('desktopLicenses.enable')}
                      </button>
                    ) : (
                      item.status !== 'pending' && (
                        <button
                          onClick={() => runAction(item, 'disable')}
                          className="px-2 py-1 text-xs rounded border border-border hover:bg-muted flex items-center gap-1"
                          title={t('desktopLicenses.disable')}
                        >
                          <Ban size={12} /> {t('desktopLicenses.disable')}
                        </button>
                      )
                    )}
                    {item.machine_code && item.status === 'active' && (
                      <button
                        onClick={() => runAction(item, 'unbind')}
                        className="px-2 py-1 text-xs rounded border border-border hover:bg-muted flex items-center gap-1"
                        title={t('desktopLicenses.unbind')}
                      >
                        <Unlink size={12} /> {t('desktopLicenses.unbind')}
                      </button>
                    )}
                    <button
                      onClick={() => runAction(item, 'regenerate-code')}
                      className="p-1.5 hover:bg-muted rounded"
                      title={t('desktopLicenses.regenerate')}
                    >
                      <KeyRound size={14} />
                    </button>
                    <button
                      onClick={() => openEdit(item)}
                      className="p-1.5 hover:bg-muted rounded"
                      title={t('desktopLicenses.edit')}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(item)}
                      className="p-1.5 hover:bg-muted rounded text-red-500"
                      title={t('desktopLicenses.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground text-sm">
                  {t('desktopLicenses.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4 text-sm">
        <span className="text-muted-foreground">
          {t('desktopLicenses.total', { total })} · {page}/{totalPages}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 border border-border rounded-lg hover:bg-muted disabled:opacity-50"
          >
            {t('desktopReleases.prev')}
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 border border-border rounded-lg hover:bg-muted disabled:opacity-50"
          >
            {t('desktopReleases.next')}
          </button>
        </div>
      </div>

      {/* 新建授权 */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg border border-border p-5 w-full max-w-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-semibold">{t('desktopLicenses.createTitle')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.nameLabel')}</label>
                <input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder={t('desktopLicenses.nameLabel')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.orgLabel')}</label>
                <input
                  value={createOrg}
                  onChange={(e) => setCreateOrg(e.target.value)}
                  placeholder={t('desktopLicenses.orgLabel')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  {t('desktopLicenses.usernameLabel', '绑定网页端账号')}
                </label>
                <input
                  value={createUsername}
                  onChange={(e) => setCreateUsername(e.target.value)}
                  placeholder={t('desktopLicenses.usernamePlaceholder', '留空则由该用户首次登录单机模式时认领')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.leaseLabel')}</label>
                <input
                  type="number"
                  min={1}
                  value={createLease}
                  onChange={(e) => setCreateLease(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  {t('desktopLicenses.idleLogoutLabel', '无操作退出登录时长（天）')}
                </label>
                <input
                  type="number"
                  min={1}
                  value={createIdleLogout}
                  onChange={(e) => setCreateIdleLogout(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.noteLabel')}</label>
                <input
                  value={createNote}
                  onChange={(e) => setCreateNote(e.target.value)}
                  placeholder={t('desktopLicenses.noteLabel')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.groupHint')}</label>
                <div className="flex gap-2">
                  <select
                    value={createCity}
                    onChange={(e) => setCreateCity(e.target.value)}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm"
                  >
                    <option value="">{t('desktopLicenses.groupCityPlaceholder')}</option>
                    {cities.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <select
                    value={createOperator}
                    onChange={(e) => setCreateOperator(e.target.value)}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm"
                  >
                    <option value="">{t('desktopLicenses.groupOperatorPlaceholder')}</option>
                    {operators.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('desktopLicenses.createHint')}</p>
            <div className="flex gap-2 justify-end pt-3 border-t border-border">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 border border-border rounded-lg hover:bg-muted text-sm"
              >
                {t('theme.cancel')}
              </button>
              <button
                onClick={handleCreate}
                disabled={!createName.trim()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium"
              >
                {t('desktopLicenses.createSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑授权 */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg border border-border p-5 w-full max-w-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-semibold">{t('desktopLicenses.editTitle')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.nameLabel')}</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={t('desktopLicenses.nameLabel')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.orgLabel')}</label>
                <input
                  value={editOrg}
                  onChange={(e) => setEditOrg(e.target.value)}
                  placeholder={t('desktopLicenses.orgLabel')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.leaseLabel')}</label>
                <input
                  type="number"
                  min={1}
                  value={editLease}
                  onChange={(e) => setEditLease(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  {t('desktopLicenses.idleLogoutLabel', '无操作退出登录时长（天）')}
                </label>
                <input
                  type="number"
                  min={1}
                  value={editIdleLogout}
                  onChange={(e) => setEditIdleLogout(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.noteLabel')}</label>
                <input
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder={t('desktopLicenses.noteLabel')}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopLicenses.groupHint')}</label>
                <div className="flex gap-2">
                  <select
                    value={editCity}
                    onChange={(e) => setEditCity(e.target.value)}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm"
                  >
                    <option value="">{t('desktopLicenses.groupCityPlaceholder')}</option>
                    {cities.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <select
                    value={editOperator}
                    onChange={(e) => setEditOperator(e.target.value)}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm"
                  >
                    <option value="">{t('desktopLicenses.groupOperatorPlaceholder')}</option>
                    {operators.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-3 border-t border-border">
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 border border-border rounded-lg hover:bg-muted text-sm"
              >
                {t('theme.cancel')}
              </button>
              <button
                onClick={submitEdit}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 text-sm font-medium"
              >
                {t('desktopReleases.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

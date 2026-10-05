import { useCallback, useEffect, useState } from 'react'
import { CloudOff, Cloud, RefreshCw, AlertTriangle, Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../store/authStore'
import { authApi, desktopCloudApi } from '../services/api'
import type { DesktopSyncStatus } from '../services/api'

/** 桌面版「运行模式与数据同步」卡片：共享模式 ⇄ 离线模式 */
export function DesktopSyncCard() {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const user = useAuthStore((s) => s.user)
  const fetchUser = useAuthStore((s) => s.fetchUser)

  const [status, setStatus] = useState<DesktopSyncStatus | null>(null)
  const [busy, setBusy] = useState<'' | 'sync' | 'resolve'>('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [cities, setCities] = useState<string[]>([])
  const [operators, setOperators] = useState<string[]>([])
  const [city, setCity] = useState(user?.city ?? '')
  const [operator, setOperator] = useState(user?.operator ?? '')
  const [savingGroup, setSavingGroup] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await desktopCloudApi.getSyncStatus()
      if (res.success) setStatus(res.data)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    if (!desktopMode) return
    refresh()
    authApi
      .getOptions()
      .then((res: any) => {
        if (res?.success) {
          setCities(res.data?.cities ?? [])
          setOperators(res.data?.operators ?? [])
        }
      })
      .catch(() => {})
  }, [desktopMode, refresh])

  useEffect(() => {
    setCity(user?.city ?? '')
    setOperator(user?.operator ?? '')
  }, [user?.city, user?.operator])

  if (!desktopMode) return null

  const shared = status?.run_mode === 'shared'

  const switchMode = async (mode: 'shared' | 'offline') => {
    setBusy('sync')
    setMessage(null)
    try {
      const res: any = await desktopCloudApi.setRunMode(mode)
      if (res?.success) {
        setStatus(typeof res.data === 'object' ? { ...status, ...res.data } as DesktopSyncStatus : status)
        setMessage({
          type: 'success',
          text: mode === 'shared' ? t('license.syncModeSwitchedShared') : t('license.syncModeSwitchedOffline'),
        })
        await refresh()
        await fetchUser()
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || t('license.syncModeSwitchFailed') })
    } finally {
      setBusy('')
    }
  }

  const syncNow = async () => {
    setBusy('sync')
    setMessage(null)
    try {
      const res: any = await desktopCloudApi.syncNow()
      if (res?.success) {
        setMessage({ type: 'success', text: res.message || t('license.syncDone') })
        await refresh()
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || t('license.syncFailed') })
    } finally {
      setBusy('')
    }
  }

  const resolve = async (dataId: string, resolution: 'server' | 'local') => {
    setBusy('resolve')
    setMessage(null)
    try {
      await desktopCloudApi.resolveConflict(dataId, resolution)
      setMessage({ type: 'success', text: t('license.syncConflictResolved') })
      await refresh()
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || t('license.syncFailed') })
    } finally {
      setBusy('')
    }
  }

  const saveGroup = async () => {
    if (!city || !operator) return
    setSavingGroup(true)
    setMessage(null)
    try {
      const res: any = await desktopCloudApi.updateGroup(city, operator)
      if (res?.success) {
        setMessage({ type: 'success', text: res.message || t('license.syncGroupSaved') })
        await fetchUser()
        await refresh()
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || t('license.syncGroupSaveFailed') })
    } finally {
      setSavingGroup(false)
    }
  }

  const groupChanged = (user?.city ?? '') !== city || (user?.operator ?? '') !== operator

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        {shared ? <Cloud size={18} /> : <CloudOff size={18} />}
        <h3 className="font-medium">{t('license.syncTitle')}</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          {status?.server_url ? `${t('license.syncServer')}: ${status.server_url}` : ''}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{t('license.syncDescription')}</p>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => switchMode('shared')}
          disabled={busy !== '' || shared}
          className="px-3 py-1.5 text-sm rounded border border-border disabled:opacity-50 hover:bg-muted"
        >
          {shared ? `✓ ${t('license.syncModeShared')}` : t('license.syncModeShared')}
        </button>
        <button
          onClick={() => switchMode('offline')}
          disabled={busy !== '' || !shared}
          className="px-3 py-1.5 text-sm rounded border border-border disabled:opacity-50 hover:bg-muted"
        >
          {!shared ? `✓ ${t('license.syncModeOffline')}` : t('license.syncModeOffline')}
        </button>
        <button
          onClick={syncNow}
          disabled={busy !== '' || !shared}
          className="px-3 py-1.5 text-sm rounded border border-border disabled:opacity-50 hover:bg-muted inline-flex items-center gap-1"
        >
          <RefreshCw size={14} className={busy === 'sync' ? 'animate-spin' : ''} />
          {t('license.syncNow')}
        </button>
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <div>
          {t('license.syncLastAt')}: {status?.last_sync_at || t('license.syncNever')}
        </div>
        <div className="flex gap-3">
          <span className="inline-flex items-center gap-1">
            <Database size={12} /> {t('license.syncDatasets')}: {status?.synced_datasets ?? 0}
          </span>
          <span>{t('license.syncPendingUploads')}: {status?.pending_uploads ?? 0}</span>
        </div>
        {status?.activated === false && (
          <div className="text-amber-500">{t('license.syncNeedActivation')}</div>
        )}
        {status?.last_error && <div className="text-red-500">{status.last_error}</div>}
      </div>

      <div className="border-t border-border pt-3 space-y-2">
        <div className="text-sm font-medium">{t('license.syncGroupTitle')}</div>
        <p className="text-xs text-muted-foreground">{t('license.syncGroupHint')}</p>
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="px-2 py-1.5 text-sm rounded border border-border bg-background"
          >
            <option value="">{t('license.syncSelectCity')}</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            className="px-2 py-1.5 text-sm rounded border border-border bg-background"
          >
            <option value="">{t('license.syncSelectOperator')}</option>
            {operators.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          <button
            onClick={saveGroup}
            disabled={!groupChanged || savingGroup || !city || !operator}
            className="px-3 py-1.5 text-sm rounded border border-border disabled:opacity-50 hover:bg-muted"
          >
            {savingGroup ? t('common.saving', '保存中…') : t('common.save', '保存')}
          </button>
        </div>
      </div>

      {!!status?.conflicts?.length && (
        <div className="border border-amber-500/40 rounded p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm text-amber-500">
            <AlertTriangle size={14} />
            {t('license.syncConflicts')}
          </div>
          {status.conflicts.map((c) => (
            <div key={c.data_id} className="flex items-center gap-2 text-sm">
              <span className="truncate flex-1">{c.name || c.data_id}</span>
              <button
                onClick={() => resolve(c.data_id, 'server')}
                disabled={busy !== ''}
                className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
              >
                {t('license.syncTakeServer')}
              </button>
              <button
                onClick={() => resolve(c.data_id, 'local')}
                disabled={busy !== ''}
                className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
              >
                {t('license.syncKeepLocal')}
              </button>
            </div>
          ))}
        </div>
      )}

      {message && (
        <div className={message.type === 'success' ? 'text-sm text-green-500' : 'text-sm text-red-500'}>
          {message.text}
        </div>
      )}
    </div>
  )
}

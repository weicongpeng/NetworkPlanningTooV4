import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, Loader2, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { appVersionsApi } from '../services/api'
import { parallelDownload } from '../utils/parallelDownload'

interface AppVersionItem {
  id: number
  version: string
  changelog?: string
  apk_filename: string
  file_size?: number
  file_size_display?: string
  file_time?: string | null
  is_latest: boolean
  download_count: number
  created_at: string
}

interface UploadDraft {
  file: File | null
  version: string
  changelog: string
  isLatest: boolean
}

interface VersionListResponse {
  success: boolean
  data: { total: number; items: AppVersionItem[] }
}

function formatPackageTime(value?: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false })
}

/** 切页签再回来保留已选文件与填写内容；上传进度独立，不与桌面端分发串台 */
let uploadDraft: UploadDraft = { file: null, version: '', changelog: '', isLatest: true }

interface UploadProgress {
  active: boolean
  percent: number
  fileName: string
}

const createProgressStore = () => {
  let state: UploadProgress = { active: false, percent: 0, fileName: '' }
  const listeners = new Set<(value: UploadProgress) => void>()
  return {
    get: () => state,
    set(patch: Partial<UploadProgress>) {
      state = { ...state, ...patch }
      listeners.forEach((listener) => listener(state))
    },
    subscribe(listener: (value: UploadProgress) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const apkUploadStore = createProgressStore()

/** 移动端分发（管理员）：表单常驻上传、设最新、编辑、删除、下载；APK 目录自动登记由后端完成。 */
export function MobileReleasesPage() {
  const { t } = useTranslation()
  const [items, setItems] = useState<AppVersionItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [draft, setDraft] = useState<UploadDraft>(() => uploadDraft)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>(() => apkUploadStore.get())
  useEffect(() => apkUploadStore.subscribe(setUploadProgress), [])
  useEffect(() => { uploadDraft = draft }, [draft])
  const uploading = uploadProgress.active

  const [editing, setEditing] = useState<AppVersionItem | null>(null)
  const [editVersion, setEditVersion] = useState('')
  const [editChangelog, setEditChangelog] = useState('')

  const notify = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 6000)
  }, [])

  const fetchVersions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await appVersionsApi.list(page, pageSize) as unknown as VersionListResponse
      if (res.success) {
        setItems(res.data.items || [])
        setTotal(res.data.total || 0)
      }
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, t, notify])

  useEffect(() => { fetchVersions() }, [fetchVersions])

  const handleUpload = async () => {
    if (!draft.file || uploading) return
    const form = new FormData()
    form.append('file', draft.file)
    form.append('version', draft.version.trim())
    form.append('changelog', draft.changelog)
    form.append('is_latest', draft.isLatest ? 'true' : 'false')
    apkUploadStore.set({ active: true, percent: 1, fileName: draft.file.name })
    try {
      await appVersionsApi.upload(form, (percent) => apkUploadStore.set({ percent }))
      notify('success', t('desktopReleases.uploadSuccess'))
      setDraft({ file: null, version: '', changelog: '', isLatest: true })
      await fetchVersions()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.uploadFailed'))
    } finally {
      apkUploadStore.set({ active: false, percent: 0, fileName: '' })
    }
  }

  const handleDelete = async (item: AppVersionItem) => {
    if (!window.confirm(t('desktopReleases.deleteConfirm', { version: item.version }))) return
    try {
      await appVersionsApi.delete(item.id)
      notify('success', t('desktopReleases.deleteSuccess'))
      await fetchVersions()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.deleteFailed'))
    }
  }

  const handleSetLatest = async (item: AppVersionItem) => {
    try {
      await appVersionsApi.update(item.id, { is_latest: true })
      notify('success', t('desktopReleases.setLatestSuccess'))
      await fetchVersions()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.setLatestFailed'))
    }
  }

  const openEdit = (item: AppVersionItem) => {
    setEditing(item)
    setEditVersion(item.version)
    setEditChangelog(item.changelog || '')
  }

  const submitEdit = async () => {
    if (!editing) return
    try {
      await appVersionsApi.update(editing.id, {
        version: editVersion.trim(),
        changelog: editChangelog,
      })
      setEditing(null)
      notify('success', t('desktopReleases.updateSuccess'))
      await fetchVersions()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.updateFailed'))
    }
  }

  const handleDownload = async (item: AppVersionItem) => {
    await parallelDownload(`/api/v1/app-versions/download/${item.id}`, {
      filename: item.apk_filename,
      chunks: 4,
      mime: 'application/vnd.android.package-archive',
    })
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="px-6 pb-6 pt-4 w-full space-y-5">
      <div className="flex justify-end">
        <button
          onClick={() => fetchVersions()}
          className="p-2 hover:bg-muted rounded-lg transition-colors"
          title={t('license.refresh')}
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="bg-card p-5 rounded-lg border border-border">
        <div className="flex items-center gap-2 mb-4">
          <Upload size={18} className="text-primary" />
          <h3 className="text-sm font-semibold">{t('desktopReleases.uploadTitle')}</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t('versionManagement.mobileFileLabel')}</label>
            <input
              type="file"
              accept=".apk"
              disabled={uploading}
              onChange={(e) => setDraft((d) => ({ ...d, file: e.target.files?.[0] || null }))}
              className="w-full text-sm disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.versionLabel')}</label>
            <input
              value={draft.version}
              disabled={uploading}
              onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))}
              placeholder="1.2.0"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm disabled:opacity-50"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.notesLabel')}</label>
            <textarea
              value={draft.changelog}
              disabled={uploading}
              onChange={(e) => setDraft((d) => ({ ...d, changelog: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm disabled:opacity-50"
            />
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isLatest}
              disabled={uploading}
              onChange={(e) => setDraft((d) => ({ ...d, isLatest: e.target.checked }))}
            />
            {t('desktopReleases.setLatestLabel')}
          </label>
          <button
            onClick={handleUpload}
            disabled={uploading || !draft.file || !draft.version.trim()}
            className="ml-auto px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading ? t('desktopReleases.uploading') : t('desktopReleases.uploadButton')}
          </button>
        </div>
        {uploading && (
          <div className="mt-3">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.max(2, Math.min(100, uploadProgress.percent))}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {t('desktopReleases.uploadProgress', {
                name: uploadProgress.fileName || draft.file?.name || '',
                percent: Math.min(100, uploadProgress.percent),
              })}
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-2">{t('desktopReleases.uploadHint')}</p>
        <p className="text-xs text-muted-foreground mt-1">{t('versionManagement.mobileImportHint')}</p>
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

      <div className="bg-card rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm npt-resizable">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">{t('desktopReleases.colVersion')}</th>
              <th className="px-3 py-2 text-left">{t('versionManagement.timeColumn')}</th>
              <th className="px-3 py-2 text-left">{t('desktopReleases.colSize')}</th>
              <th className="px-3 py-2 text-left">{t('desktopReleases.colNotes')}</th>
              <th className="px-3 py-2 text-left">{t('desktopReleases.colDownloads')}</th>
              <th className="px-3 py-2 text-left">{t('desktopReleases.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono">
                  {item.version || <span className="text-muted-foreground font-sans">{t('versionManagement.versionUnset')}</span>}
                  {item.is_latest && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs">
                      {t('desktopReleases.latestBadge')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatPackageTime(item.file_time)}</td>
                <td className="px-3 py-2">{item.file_size_display || '-'}</td>
                <td className="px-3 py-2 max-w-[280px] truncate" title={item.changelog || ''}>
                  {item.changelog || '-'}
                </td>
                <td className="px-3 py-2">{item.download_count}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleDownload(item)} className="p-1.5 hover:bg-muted rounded-lg" title={t('desktopReleases.download')}>
                      <Download size={15} />
                    </button>
                    <button
                      onClick={() => handleSetLatest(item)}
                      disabled={item.is_latest}
                      className="p-1.5 hover:bg-muted rounded-lg disabled:opacity-30"
                      title={t('desktopReleases.setLatest')}
                    >
                      <Check size={15} />
                    </button>
                    <button onClick={() => openEdit(item)} className="p-1.5 hover:bg-muted rounded-lg" title={t('desktopReleases.edit')}>
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => handleDelete(item)} className="p-1.5 hover:bg-muted rounded-lg text-red-500" title={t('desktopReleases.delete')}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground text-sm">
                  {t('desktopReleases.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('desktopReleases.total', { total })} · {page}/{totalPages}
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

      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg border border-border p-5 w-full max-w-lg space-y-4">
            <h3 className="text-sm font-semibold">{t('desktopReleases.editTitle')}</h3>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.versionLabel')}</label>
              <input
                value={editVersion}
                onChange={(e) => setEditVersion(e.target.value)}
                placeholder="1.2.0"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.notesLabel')}</label>
              <textarea
                value={editChangelog}
                onChange={(e) => setEditChangelog(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              />
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

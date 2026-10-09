import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, Loader2, MonitorDown, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import type { DesktopReleaseInfo } from '@shared/types'
import { desktopReleasesApi } from '../services/api'
import { parallelDownload } from '../utils/parallelDownload'
import { uploadStore } from '../store/uploadStore'

/** 上传表单草稿（模块级）：切到其他页面再回来时保留已选文件与填写内容 */
interface UploadDraft {
  file: File | null
  version: string
  channel: string
  releaseNotes: string
  isLatest: boolean
}

// 组件卸载后仍存活的模块级草稿；上传进度由同样模块级的 uploadStore 承载，
// 因此上传途中切换功能页面再回来时进度条仍显示当前进度
let uploadDraft: UploadDraft = { file: null, version: '', channel: 'stable', releaseNotes: '', isLatest: true }

/**
 * 桌面版安装包管理（管理员）：上传（1MB 分片）、设最新、编辑、删除、下载。
 * OTA 客户端通过公开接口 /api/v1/desktop-cloud/releases/latest 拉取。
 */
export function DesktopReleasesPage() {
  const { t } = useTranslation()
  const [items, setItems] = useState<DesktopReleaseInfo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [draft, setDraft] = useState<UploadDraft>(() => uploadDraft)
  // 模块级上传进度：uploadStore 跨组件实例存活，切页回来恢复当前进度
  const [uploadProgress, setUploadProgress] = useState(uploadStore.get())
  useEffect(() => uploadStore.subscribe(setUploadProgress), [])
  const uploading = uploadProgress.active

  // 草稿变化回写模块级变量（含文件名，供切页回来后展示）
  useEffect(() => { uploadDraft = draft }, [draft])

  const [editing, setEditing] = useState<DesktopReleaseInfo | null>(null)
  const [editVersion, setEditVersion] = useState('')
  const [editChannel, setEditChannel] = useState('stable')
  const [editNotes, setEditNotes] = useState('')

  const fetchReleases = useCallback(async () => {
    setLoading(true)
    try {
      const res = await desktopReleasesApi.list(page, pageSize)
      if (res.success) {
        setItems(res.data.items)
        setTotal(res.data.total)
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || t('desktopReleases.loadFailed') })
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, t])

  useEffect(() => {
    fetchReleases()
  }, [fetchReleases])

  const notify = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 6000)
  }

  const handleUpload = async () => {
    if (!draft.file || uploading) return
    const form = new FormData()
    form.append('file', draft.file)
    form.append('version', draft.version.trim())
    form.append('channel', draft.channel.trim() || 'stable')
    form.append('release_notes', draft.releaseNotes)
    form.append('is_latest', draft.isLatest ? 'true' : 'false')
    uploadStore._set({ active: true, percent: 1, step: 'uploading', sessionId: '', fileName: draft.file.name })
    try {
      await desktopReleasesApi.upload(form, (p) => uploadStore._set({ percent: p }))
      notify('success', t('desktopReleases.uploadSuccess'))
      setDraft({ file: null, version: '', channel: draft.channel, releaseNotes: '', isLatest: true })
      await fetchReleases()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.uploadFailed'))
    } finally {
      uploadStore._set({ active: false, percent: 0, step: '', sessionId: '', fileName: '' })
    }
  }

  const handleDelete = async (item: DesktopReleaseInfo) => {
    if (!window.confirm(t('desktopReleases.deleteConfirm', { version: item.version }))) return
    try {
      await desktopReleasesApi.delete(item.id)
      notify('success', t('desktopReleases.deleteSuccess'))
      await fetchReleases()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.deleteFailed'))
    }
  }

  const handleSetLatest = async (item: DesktopReleaseInfo) => {
    try {
      await desktopReleasesApi.setLatest(item.id)
      notify('success', t('desktopReleases.setLatestSuccess'))
      await fetchReleases()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.setLatestFailed'))
    }
  }

  const openEdit = (item: DesktopReleaseInfo) => {
    setEditing(item)
    setEditVersion(item.version)
    setEditChannel(item.channel)
    setEditNotes(item.release_notes || '')
  }

  const submitEdit = async () => {
    if (!editing) return
    try {
      await desktopReleasesApi.update(editing.id, {
        version: editVersion.trim(),
        channel: editChannel.trim() || 'stable',
        release_notes: editNotes,
      })
      setEditing(null)
      notify('success', t('desktopReleases.updateSuccess'))
      await fetchReleases()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.updateFailed'))
    }
  }

  const handleDownload = async (item: DesktopReleaseInfo) => {
    await parallelDownload(`/api/v1/desktop-cloud/releases/download/${item.id}`, {
      filename: item.filename,
      chunks: 4,
      mime: 'application/octet-stream',
    })
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="p-6 w-full space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorDown size={20} className="text-primary" />
          <h1 className="text-base font-bold">{t('desktopReleases.title')}</h1>
        </div>
        <button
          onClick={() => fetchReleases()}
          className="p-2 hover:bg-muted rounded-lg transition-colors"
          title={t('license.refresh')}
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 上传 */}
      <div className="bg-card p-5 rounded-lg border border-border">
        <div className="flex items-center gap-2 mb-4">
          <Upload size={18} className="text-primary" />
          <h2 className="text-sm font-semibold">{t('desktopReleases.uploadTitle')}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <div className="xl:col-span-2">
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.fileLabel')}</label>
            <input
              type="file"
              accept=".exe"
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
              placeholder="1.0.0"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.channelLabel')}</label>
            <input
              value={draft.channel}
              disabled={uploading}
              onChange={(e) => setDraft((d) => ({ ...d, channel: e.target.value }))}
              placeholder="stable"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm disabled:opacity-50"
            />
          </div>
          <div className="md:col-span-2 xl:col-span-4">
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.notesLabel')}</label>
            <textarea
              value={draft.releaseNotes}
              disabled={uploading}
              onChange={(e) => setDraft((d) => ({ ...d, releaseNotes: e.target.value }))}
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
        {/* 上传进度条（模块级 uploadStore：上传中切到其他页面，回来仍显示当前进度） */}
        {uploading && (
          <div className="mt-3">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.max(2, Math.min(100, uploadProgress.percent))}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-muted-foreground truncate">
                {t('desktopReleases.uploadProgress', {
                  name: uploadProgress.fileName || draft.file?.name || '',
                  percent: Math.min(100, uploadProgress.percent),
                })}
              </p>
              <span className="text-xs text-muted-foreground shrink-0">
                {uploadProgress.percent >= 99
                  ? t('desktopReleases.merging', 'Merging…')
                  : `${Math.min(100, uploadProgress.percent)}%`}
              </span>
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-2">{t('desktopReleases.uploadHint')}</p>
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

      {/* 列表 */}
      <div className="bg-card rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">{t('desktopReleases.colVersion')}</th>
              <th className="px-3 py-2 text-left">{t('desktopReleases.colChannel')}</th>
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
                  {item.version}
                  {item.is_latest && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs">
                      {t('desktopReleases.latestBadge')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{item.channel}</td>
                <td className="px-3 py-2">{item.file_size_display || '-'}</td>
                <td className="px-3 py-2 max-w-[280px] truncate" title={item.release_notes || ''}>
                  {item.release_notes || '-'}
                </td>
                <td className="px-3 py-2">{item.download_count}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDownload(item)}
                      className="p-1.5 hover:bg-muted rounded-lg"
                      title={t('desktopReleases.download')}
                    >
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
                    <button
                      onClick={() => openEdit(item)}
                      className="p-1.5 hover:bg-muted rounded-lg"
                      title={t('desktopReleases.edit')}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => handleDelete(item)}
                      className="p-1.5 hover:bg-muted rounded-lg text-red-500"
                      title={t('desktopReleases.delete')}
                    >
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

      <div className="flex items-center justify-between mt-4 text-sm">
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

      {/* 编辑弹窗 */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg border border-border p-5 w-full max-w-lg space-y-4">
            <h3 className="text-sm font-semibold">{t('desktopReleases.editTitle')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.versionLabel')}</label>
                <input
                  value={editVersion}
                  onChange={(e) => setEditVersion(e.target.value)}
                  placeholder="1.0.0"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.channelLabel')}</label>
                <input
                  value={editChannel}
                  onChange={(e) => setEditChannel(e.target.value)}
                  placeholder="stable"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.notesLabel')}</label>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={3}
                placeholder={t('desktopReleases.notesLabel')}
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

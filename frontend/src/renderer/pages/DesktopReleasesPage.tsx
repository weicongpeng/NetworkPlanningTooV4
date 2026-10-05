import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, Loader2, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import type { DesktopReleaseInfo } from '@shared/types'
import { desktopReleasesApi } from '../services/api'
import { parallelDownload } from '../utils/parallelDownload'

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

  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [version, setVersion] = useState('')
  const [channel, setChannel] = useState('stable')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [mandatory, setMandatory] = useState(false)
  const [isLatest, setIsLatest] = useState(true)

  const [editing, setEditing] = useState<DesktopReleaseInfo | null>(null)
  const [editVersion, setEditVersion] = useState('')
  const [editChannel, setEditChannel] = useState('stable')
  const [editNotes, setEditNotes] = useState('')
  const [editMandatory, setEditMandatory] = useState(false)

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
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('version', version.trim())
      form.append('channel', channel.trim() || 'stable')
      form.append('release_notes', releaseNotes)
      form.append('mandatory', mandatory ? 'true' : 'false')
      form.append('is_latest', isLatest ? 'true' : 'false')
      await desktopReleasesApi.upload(form)
      notify('success', t('desktopReleases.uploadSuccess'))
      setFile(null)
      setVersion('')
      setReleaseNotes('')
      setMandatory(false)
      setIsLatest(true)
      await fetchReleases()
    } catch (err: any) {
      notify('error', err?.message || t('desktopReleases.uploadFailed'))
    } finally {
      setUploading(false)
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
    setEditMandatory(item.mandatory)
  }

  const submitEdit = async () => {
    if (!editing) return
    try {
      await desktopReleasesApi.update(editing.id, {
        version: editVersion.trim(),
        channel: editChannel.trim() || 'stable',
        release_notes: editNotes,
        mandatory: editMandatory,
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
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-base font-bold">{t('desktopReleases.title')}</h1>
        <button
          onClick={() => fetchReleases()}
          className="p-1.5 hover:bg-muted rounded-lg transition-colors"
          title={t('license.refresh')}
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 上传 */}
      <div className="bg-card p-5 rounded-lg border border-border mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Upload size={18} className="text-primary" />
          <h2 className="text-sm font-semibold">{t('desktopReleases.uploadTitle')}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.fileLabel')}</label>
            <input
              type="file"
              accept=".exe"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.versionLabel')}</label>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.0.0"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.channelLabel')}</label>
            <input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="stable"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
          </div>
          <div className="md:col-span-4">
            <label className="block text-xs text-muted-foreground mb-1">{t('desktopReleases.notesLabel')}</label>
            <textarea
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isLatest} onChange={(e) => setIsLatest(e.target.checked)} />
            {t('desktopReleases.setLatestLabel')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
            {t('desktopReleases.mandatoryLabel')}
          </label>
          <div className="md:col-span-2 flex justify-end">
            <button
              onClick={handleUpload}
              disabled={uploading || !file || !version.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {uploading ? t('desktopReleases.uploading') : t('desktopReleases.uploadButton')}
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">{t('desktopReleases.uploadHint')}</p>
      </div>

      {message && (
        <div className={`mb-4 p-2 rounded flex items-center gap-2 ${
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
                  {item.mandatory && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 text-xs">
                      {t('desktopReleases.mandatoryBadge')}
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
          <div className="bg-card rounded-lg border border-border p-5 w-full max-w-md space-y-3">
            <h3 className="text-sm font-semibold">{t('desktopReleases.editTitle')}</h3>
            <input
              value={editVersion}
              onChange={(e) => setEditVersion(e.target.value)}
              placeholder={t('desktopReleases.versionLabel')}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
            <input
              value={editChannel}
              onChange={(e) => setEditChannel(e.target.value)}
              placeholder={t('desktopReleases.channelLabel')}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
            <textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              rows={3}
              placeholder={t('desktopReleases.notesLabel')}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editMandatory} onChange={(e) => setEditMandatory(e.target.checked)} />
              {t('desktopReleases.mandatoryLabel')}
            </label>
            <div className="flex gap-2 justify-end">
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

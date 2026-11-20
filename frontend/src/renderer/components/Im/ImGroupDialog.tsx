/** 新建跨组群：搜索全站用户、勾选成员、命名并创建。 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search, UsersRound, X } from 'lucide-react'

import { useImStore } from '../../store/imStore'

export function ImGroupDialog() {
  const { t } = useTranslation()
  const open = useImStore(s => s.groupDialog)
  const setOpen = useImStore(s => s.setGroupDialog)
  const contacts = useImStore(s => s.contacts)
  const createGroup = useImStore(s => s.createGroup)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)

  const users = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (contacts?.users || []).filter(user =>
      !keyword || user.username.toLowerCase().includes(keyword)
      || `${user.city}${user.operator}`.toLowerCase().includes(keyword))
  }, [contacts, query])

  if (!open) return null

  const toggle = (id: number) => {
    setSelected(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])
  }

  const submit = async () => {
    if (!name.trim() || selected.length === 0 || submitting) return
    setSubmitting(true)
    await createGroup(name.trim(), selected)
    setSubmitting(false)
    setName('')
    setSelected([])
    setQuery('')
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-5 backdrop-blur-[2px]"
         onClick={() => setOpen(false)}>
      <div className="flex max-h-full w-[440px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
           onClick={event => event.stopPropagation()}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <UsersRound size={15} />
          </div>
          <h3 className="flex-1 text-sm font-semibold">{t('im.group.title', '新建协作群组')}</h3>
          <button type="button" onClick={() => setOpen(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent cursor-pointer">
            <X size={16} />
          </button>
        </header>

        <div className="space-y-3 px-4 pt-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              {t('im.group.nameLabel', '群名称')}
            </label>
            <input
              value={name} onChange={event => setName(event.target.value)}
              placeholder={t('im.group.namePlaceholder', '例如：广州移动 5G 参数联合复核')}
              className="h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
            />
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query} onChange={event => setQuery(event.target.value)}
              placeholder={t('im.group.searchPlaceholder', '搜索全站用户（支持跨地市 / 运营商）')}
              className="h-8 w-full rounded-lg border border-border/60 bg-background/60 pl-8 pr-2 text-xs outline-none focus:border-primary/60"
            />
          </div>
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selected.map(id => {
                const user = contacts?.users.find(item => item.id === id)
                return (
                  <button key={id} type="button" onClick={() => toggle(id)}
                          className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20 cursor-pointer">
                    {user?.username || id} <X size={10} />
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {users.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {t('im.group.noMatchUsers', '没有匹配的用户')}
            </p>
          )}
          {users.map(user => {
            const checked = selected.includes(user.id)
            return (
              <button key={user.id} type="button" onClick={() => toggle(user.id)}
                      className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors cursor-pointer
                        ${checked ? 'bg-primary/10' : 'hover:bg-accent/60'}`}>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border
                  ${checked ? 'border-primary bg-primary text-white' : 'border-border'}`}>
                  {checked && <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{user.username}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {[user.city, user.operator].filter(Boolean).join(' · ')}
                </span>
              </button>
            )
          })}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-3">
          <span className="flex-1 text-[11px] text-muted-foreground">
            {t('im.group.selectedCount', { defaultValue: '已选 {{count}} 人', count: selected.length })}
          </span>
          <button type="button" onClick={() => setOpen(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent cursor-pointer">
            {t('im.common.cancel', '取消')}
          </button>
          <button type="button" onClick={() => void submit()}
                  disabled={!name.trim() || selected.length === 0 || submitting}
                  className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
            {submitting ? t('im.group.creating', '创建中…') : t('im.group.create', '创建群组')}
          </button>
        </footer>
      </div>
    </div>
  )
}

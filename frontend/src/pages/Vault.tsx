import { useQuery } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { fetchVault } from '../lib/api'

const fmtBytes = (b: number | null) => {
  if (b === null) return '—'
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${b} B`
}

const fmtRelative = (iso: string | null) => {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const fmtUptime = (iso: string | null) => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return '—'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  const text = ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
  return <span className={`text-xs ${text}`}>[{label}]</span>
}

function ItemRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between py-1.5 text-sm">
      <span className="text-[var(--color-text-dim)]">{label}</span>
      <span className="font-medium text-[var(--color-text)]">{count}</span>
    </div>
  )
}

export default function Vault() {
  const vault = useQuery({ queryKey: ['vault'], queryFn: fetchVault, refetchInterval: 60_000 })

  const data = vault.data
  const containerOk = Boolean(data?.container.running && (data?.container.healthy ?? true))
  const backupOk = data ? !data.backups.stale && data.backups.count > 0 : false

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// secure</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>vault<span className="cursor-blink">_</span></h1>
        </div>
        <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          [tailnet:100.96.237.89:8443]
        </div>
      </div>

      {vault.isLoading && !data ? (
        <Card><div className="text-sm text-[var(--color-text-dim)]">Loading…</div></Card>
      ) : vault.error || !data ? (
        <Card><div className="text-sm text-[var(--color-danger)]">Vault status unavailable</div></Card>
      ) : (
        <>
          <Card title="Service">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat
                label="Container"
                value={data.container.running ? 'Running' : 'Down'}
                sub={data.container.status ?? '—'}
              />
              <Stat
                label="Health"
                value={data.container.healthy === null ? '—' : data.container.healthy ? 'Healthy' : 'Unhealthy'}
                sub={data.container.healthy === null ? 'no healthcheck' : ''}
              />
              <Stat label="Uptime" value={fmtUptime(data.container.startedAt)} sub="vaultwarden" />
              <div className="flex flex-col gap-2">
                <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">State</div>
                <div className="flex flex-wrap gap-2">
                  <StatusPill ok={containerOk} label={containerOk ? 'service ok' : 'service issue'} />
                  <StatusPill ok={backupOk} label={backupOk ? 'backups ok' : 'backups stale'} />
                </div>
              </div>
            </div>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
            <Card title="Items">
              {data.items ? (
                <div className="space-y-4">
                  <div className="flex items-baseline gap-3">
                    <div className="text-4xl font-semibold tracking-tight text-[var(--color-text)]">{data.items.total}</div>
                    <div className="text-xs uppercase tracking-[0.22em] text-[var(--color-text-faint)]">total active items</div>
                  </div>
                  <div className="divide-y divide-[var(--color-border)]">
                    <ItemRow label="Logins" count={data.items.logins} />
                    <ItemRow label="Secure notes" count={data.items.notes} />
                    <ItemRow label="Cards" count={data.items.cards} />
                    <ItemRow label="Identities" count={data.items.identities} />
                    <ItemRow label="SSH keys" count={data.items.sshKeys} />
                    <ItemRow label="Folders" count={data.items.folders} />
                    <ItemRow label="Attachments" count={data.items.attachments} />
                    <ItemRow label="Sends" count={data.items.sends} />
                    <ItemRow label="In trash" count={data.items.trash} />
                    <ItemRow label="Users" count={data.items.users} />
                  </div>
                </div>
              ) : (
                <div className="text-sm text-[var(--color-warning)]">Item data unavailable</div>
              )}
            </Card>

            <Card title="Backups">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Stat
                    label="Last backup"
                    value={fmtRelative(data.backups.lastAt)}
                    sub={data.backups.lastAt ? new Date(data.backups.lastAt).toLocaleString() : 'no backups found'}
                  />
                  <Stat
                    label="Last size"
                    value={fmtBytes(data.backups.lastSize)}
                    sub=""
                  />
                  <Stat label="Backup count" value={data.backups.count} sub="files in archive" />
                  <Stat label="Total on disk" value={fmtBytes(data.backups.totalSize)} sub="all backups" />
                </div>
                {data.backups.stale && data.backups.count > 0 && (
                  <div className="border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
                    Last backup is more than 36 hours old — daily cron may have skipped.
                  </div>
                )}
                {data.backups.count === 0 && (
                  <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
                    No backup files found in /home/brendon/vaultwarden-backups.
                  </div>
                )}
              </div>
            </Card>
          </div>

          <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
            updated {fmtRelative(data.updatedAt)}
          </div>
        </>
      )}
    </div>
  )
}

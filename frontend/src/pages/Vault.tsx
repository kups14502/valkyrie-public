export default function Vault() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Vault</h1>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-dim)]">
        Vaultwarden status, last backup, item count. Direct vault access stays in the dedicated Vaultwarden UI.
      </div>
    </div>
  )
}

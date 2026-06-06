import { useCallback, useEffect, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { fetchAuthStatus, setupAuth, loginAuth, type AuthStatus } from '../lib/api'
import { hasToken, setToken, isAuthSkipped, setAuthSkipped, onAuthChange } from '../lib/auth'

// Gates the app behind self-hosted auth. Shows first-run setup (password →
// scannable TOTP QR) when no credential exists, otherwise a password + 6-digit
// login. While the backend isn't strict yet, offers a "skip for now" hatch so a
// login hiccup can never lock the owner out of the live dashboard.

type Phase = 'loading' | 'setup' | 'enroll' | 'login' | 'authed'

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [authed, setAuthed] = useState<boolean>(hasToken() || isAuthSkipped())

  // Re-evaluate the gate whenever the token changes (login, logout, 401, skip).
  useEffect(() => onAuthChange(() => setAuthed(hasToken() || isAuthSkipped())), [])

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchAuthStatus()
      setStatus(s)
      setPhase((p) => (p === 'enroll' ? 'enroll' : s.configured ? 'login' : 'setup'))
    } catch {
      // Backend unreachable — don't hard-block; surface a retry on the login card.
      setStatus({ configured: true, strict: false })
      setPhase('login')
    }
  }, [])

  useEffect(() => { if (!authed) void loadStatus() }, [authed, loadStatus])

  if (authed) return <>{children}</>
  if (phase === 'loading') {
    return (
      <Centered>
        <div className="text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; authorizing<span className="cursor-blink">_</span></div>
      </Centered>
    )
  }

  return (
    <Centered>
      <div className="w-full max-w-sm border border-[var(--color-border)] bg-[rgba(255,255,255,0.02)] p-6 shadow-[0_0_40px_rgba(0,255,65,0.06)]">
        <div className="mb-5 text-center">
          <div className="text-lg font-bold tracking-widest" style={{ color: 'var(--color-accent)', textShadow: '0 0 12px var(--color-accent)' }}>
            BRNDN<span className="opacity-40">//</span>SYS<span className="cursor-blink">_</span>
          </div>
          <div className="mt-1 text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">master control · secure access</div>
        </div>

        {phase === 'setup' && <SetupForm onEnrolled={() => setPhase('enroll')} />}
        {phase === 'enroll' && <EnrollNote onContinue={() => setPhase('login')} />}
        {phase === 'login' && <LoginForm onAuthed={() => setAuthed(true)} />}

        {status && !status.strict && (
          <button
            type="button"
            onClick={() => { setAuthSkipped(true); setAuthed(true) }}
            className="mt-4 w-full text-center text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
          >
            skip for now (migration)
          </button>
        )}
      </div>
    </Centered>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 text-[var(--color-text)]">
      {children}
    </div>
  )
}

// Module-scoped so EnrollNote can render the QR after SetupForm advances phases.
let lastEnroll: { otpauthUri: string; secret: string } | null = null

function SetupForm({ onEnrolled }: { onEnrolled: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) return setError('password must be at least 8 characters')
    if (password !== confirm) return setError('passwords do not match')
    setBusy(true)
    try {
      const { otpauthUri, secret } = await setupAuth(password)
      lastEnroll = { otpauthUri, secret }
      onEnrolled()
    } catch (err) {
      setError((err as { detail?: string })?.detail || 'setup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs leading-relaxed text-[var(--color-text-dim)]">First-time setup — choose a password. You'll then scan a QR into your authenticator app.</p>
      <Field label="password" type="password" value={password} onChange={setPassword} autoFocus />
      <Field label="confirm password" type="password" value={confirm} onChange={setConfirm} />
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      <SubmitButton busy={busy} label="create credential" />
    </form>
  )
}

function EnrollNote({ onContinue }: { onContinue: () => void }) {
  const [qr, setQr] = useState('')
  const enroll = lastEnroll
  useEffect(() => {
    if (enroll?.otpauthUri) QRCode.toDataURL(enroll.otpauthUri, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(''))
  }, [enroll])

  if (!enroll) return <LoginForm onAuthed={() => { /* fallthrough */ }} />
  return (
    <div className="space-y-3 text-center">
      <p className="text-xs leading-relaxed text-[var(--color-text-dim)]">Scan this in your authenticator app (or enter the key manually), then continue to sign in.</p>
      {qr && <img src={qr} alt="TOTP QR code" className="mx-auto rounded bg-white p-2" />}
      <div className="break-all rounded border border-[var(--color-border)] bg-black/30 px-2 py-1.5 font-mono text-[10px] text-[var(--color-text-dim)]">{enroll.secret}</div>
      <button type="button" onClick={onContinue} className="w-full border border-[var(--color-accent)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)]">i've added it — sign in</button>
    </div>
  )
}

function LoginForm({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { token, expiresAt } = await loginAuth(password, totp)
      setToken(token, expiresAt)
      onAuthed()
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status
      setError(status === 429 ? 'too many attempts — wait a few minutes' : 'invalid password or code')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="password" type="password" value={password} onChange={setPassword} autoFocus />
      <Field
        label="6-digit code"
        type="text"
        value={totp}
        onChange={(v) => setTotp(v.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        placeholder="000000"
        mono
      />
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      <SubmitButton busy={busy} label="sign in" />
    </form>
  )
}

function Field({ label, type, value, onChange, autoFocus, placeholder, inputMode, mono }: {
  label: string
  type: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  placeholder?: string
  inputMode?: 'numeric'
  mono?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">{label}</span>
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] ${mono ? 'font-mono tracking-[0.3em]' : ''}`}
      />
    </label>
  )
}

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button type="submit" disabled={busy} className="w-full border border-[var(--color-accent)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-50">
      {busy ? 'working…' : label}
    </button>
  )
}

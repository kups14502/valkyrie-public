import { Navigate, useSearchParams } from 'react-router-dom'
import { TERM_NAME_RE } from '../lib/term'
import { classicToV2 } from '../lib/deviceMode'

// What the Steam Frame app (xr/ in the repo) opened its panels on before its
// panels became v2 pages: /xr?s=<session>, /xr?page=<classic page>, or bare
// /xr for a picker. A layout the app saved then still names them, so each one
// lands on its v2 page: the session's pop-out terminal, the page's v2 screen,
// and AI > Sessions in place of the picker.

export default function XrPanel() {
  const [params] = useSearchParams()
  const s = params.get('s') ?? ''
  const page = params.get('page') ?? ''
  const to = TERM_NAME_RE.test(s)
    ? `/m/w/term/${encodeURIComponent(s)}`
    : (page && classicToV2(page)) || '/m/ai/sessions'
  return <Navigate to={to} replace />
}

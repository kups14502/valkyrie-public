import {
  File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, FileVideoCamera, type LucideIcon,
} from 'lucide-react'

// What a file in a project folder is, by its name: which icon the explorer
// shows and how the viewer opens it. thor serves text as text/plain whatever
// the extension, so the page decides markdown, code and plain text here.

export type ViewKind = 'markdown' | 'text' | 'image' | 'pdf' | 'none'

export const extOf = (name: string): string => {
  const base = (name.split('/').pop() ?? name).toLowerCase()
  const i = base.lastIndexOf('.')
  return i < 0 ? base : base.slice(i + 1)
}

const MARKDOWN = new Set(['md', 'markdown'])
const CODE = new Set([
  'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'sh', 'bash', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss',
  'html', 'htm', 'svg', 'sql', 'cs', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'kt', 'swift', 'vbs',
  'json', 'jsonl', 'yml', 'yaml', 'xml', 'toml', 'ini', 'cfg', 'conf', 'reg', 'tf', 'hcl', 'r', 'gradle',
  'dockerfile', 'gitignore', 'editorconfig', 'lock', 'properties',
])
const PLAIN = new Set(['txt', 'log', 'csv', 'tsv'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const SHEET = new Set(['xlsx', 'xls', 'xlsm', 'csv', 'tsv', 'ods'])
const DOC = new Set(['md', 'markdown', 'txt', 'log', 'doc', 'docx', 'rtf', 'odt', 'pdf', 'pptx', 'ppt', 'msg', 'eml'])
const ARCHIVE = new Set(['zip', '7z', 'rar', 'gz', 'tar', 'tgz'])
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav'])

export function viewKind(name: string): ViewKind {
  const e = extOf(name)
  if (MARKDOWN.has(e)) return 'markdown'
  if (CODE.has(e) || PLAIN.has(e)) return 'text'
  if (IMAGE.has(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  return 'none'
}

export function iconFor(name: string): LucideIcon {
  const e = extOf(name)
  if (IMAGE.has(e)) return FileImage
  if (SHEET.has(e)) return FileSpreadsheet
  if (ARCHIVE.has(e)) return FileArchive
  if (VIDEO.has(e)) return FileVideoCamera
  if (CODE.has(e)) return FileCode
  if (DOC.has(e)) return FileText
  return File
}

export const fmtBytes = (b: number): string =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`

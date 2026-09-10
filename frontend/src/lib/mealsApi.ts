import { api } from './api'

export type Meal = {
  id: string
  date: string
  time: string
  slot: string
  name: string
  servings: number
  calories: number
  protein: number
  carbs: number
  fat: number
  fiber: number
  note: string
  source: string
  photoId: string
  createdAt: string
  updatedAt: string
}

export type MacroTotals = { calories: number; protein: number; carbs: number; fat: number; fiber: number }
export type MacroTargets = {
  calories: number | null; protein: number | null; carbs: number | null; fat: number | null; fiber: number | null
  updatedAt: string | null
}

export type MealDay = { date: string; meals: Meal[]; totals: MacroTotals; targets: MacroTargets }
export type MealRange = {
  from: string; to: string
  days: { date: string; entries: number; totals: MacroTotals }[]
  targets: MacroTargets
}

export type EstimatedItem = {
  name: string
  portion: string
  servings: number
  calories: number
  protein: number
  carbs: number
  fat: number
  fiber: number
  confidence: 'high' | 'medium' | 'low'
}

export type Estimate = {
  ok: boolean
  photoId: string
  items: EstimatedItem[]
  notes: string
  model: string
  via: 'api-key' | 'cli'
}

export type NewMeal = Partial<Omit<Meal, 'id' | 'createdAt' | 'updatedAt'>> & { date: string; name: string }

export const fetchMealDay = async (date: string) =>
  (await api.get<MealDay>('/meals/day', { params: { date } })).data

export const fetchMealRange = async (from: string, to: string) =>
  (await api.get<MealRange>('/meals/range', { params: { from, to } })).data

export const createMeal = async (meal: NewMeal) =>
  (await api.post<{ ok: boolean; meal: Meal }>('/meals', meal)).data.meal

export const updateMeal = async (id: string, meal: Partial<NewMeal>) =>
  (await api.patch<{ ok: boolean; meal: Meal }>(`/meals/${id}`, meal)).data.meal

export const deleteMeal = async (id: string) =>
  (await api.delete<{ ok: boolean }>(`/meals/${id}`)).data

export const fetchMacroTargets = async () =>
  (await api.get<{ targets: MacroTargets }>('/meals/targets')).data.targets

export const saveMacroTargets = async (targets: Partial<MacroTargets>) =>
  (await api.put<{ ok: boolean; targets: MacroTargets }>('/meals/targets', targets)).data.targets

export const estimateMealPhoto = async (body: { imageBase64: string; mime: string; hint?: string }) =>
  (await api.post<Estimate>('/meals/estimate', body)).data

/** Where the backend serves a stored meal photo. */
export const mealPhotoUrl = (photoId: string): string =>
  `${api.defaults.baseURL ?? '/api'}/meals/photo/${photoId}`

const MAX_EDGE = 1400
const JPEG_QUALITY = 0.82

/**
 * Shrink a picked photo in the browser before it is posted.
 *
 * A modern phone camera writes 4 to 8 MB per shot, which is over the API's
 * 5 MB base64 ceiling and pointless for this: the plate is legible at 1400px.
 * Drawing through a canvas also strips EXIF, so orientation is baked in and
 * location metadata never leaves the device.
 */
export async function prepareImage(file: File): Promise<{ base64: string; mime: string; previewUrl: string }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  return { base64: dataUrl.split(',')[1] ?? '', mime: 'image/jpeg', previewUrl: dataUrl }
}

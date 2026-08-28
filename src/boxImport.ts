import type { BoxType } from './types'

type Column = 'name' | 'length' | 'width' | 'height' | 'quantity' | 'weight' | 'allowRotation'

const aliases: Record<Column, string[]> = {
  name: ['назва', 'name', 'коробка', 'тип', 'найменування'],
  length: ['довжина', 'д', 'length', 'l'],
  width: ['ширина', 'ш', 'width', 'w'],
  height: ['висота', 'в', 'height', 'h'],
  quantity: ['кількість', 'количество', 'quantity', 'qty', 'кільк'],
  weight: ['вага', 'вес', 'weight', 'kg', 'кг'],
  allowRotation: ['поворот', 'rotation', 'rotate'],
}

const normalize = (value: string) => value.trim().toLowerCase().replace(/[.,:()]/g, '').replace(/\s+/g, ' ')
const toNumber = (value: string, fallback: number) => {
  const parsed = Number(value.trim().replace(',', '.').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseRows(text: string, separator: string): string[][] {
  const rows: string[][] = []
  let cell = ''
  let row: string[] = []
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1 } else quoted = !quoted
    } else if (character === separator && !quoted) { row.push(cell.trim()); cell = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ''
    } else cell += character
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row)
  return rows
}

function columnIndexes(headers: string[]): Partial<Record<Column, number>> {
  const normalized = headers.map(normalize)
  return Object.fromEntries(Object.entries(aliases).flatMap(([column, names]) => {
    const index = normalized.findIndex((header) => names.includes(header))
    return index >= 0 ? [[column, index]] : []
  })) as Partial<Record<Column, number>>
}

export function googleSheetCsvUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim())
  const match = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/)
  if (!match) return url.toString()
  const gid = url.searchParams.get('gid') ?? url.hash.match(/gid=(\d+)/)?.[1] ?? '0'
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`
}

export function boxesFromCsv(text: string): BoxType[] {
  const separator = (text.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) > (text.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const [headers, ...rows] = parseRows(text.replace(/^\uFEFF/, ''), separator)
  if (!headers) throw new Error('Таблиця порожня.')
  const columns = columnIndexes(headers)
  if (columns.length === undefined || columns.width === undefined || columns.height === undefined) throw new Error('Не знайдено колонки «Довжина», «Ширина» та «Висота».')
  return rows.flatMap((row, index) => {
    const length = toNumber(row[columns.length!] ?? '', 0)
    const width = toNumber(row[columns.width!] ?? '', 0)
    const height = toNumber(row[columns.height!] ?? '', 0)
    if (!length || !width || !height) return []
    const rotationValue = normalize(row[columns.allowRotation ?? -1] ?? '')
    return [{
      id: crypto.randomUUID(), name: row[columns.name ?? -1]?.trim() || `Коробка ${index + 1}`,
      length, width, height, quantity: toNumber(row[columns.quantity ?? -1] ?? '', 1), weight: toNumber(row[columns.weight ?? -1] ?? '', 0),
      allowHorizontalRotation: !['ні', 'no', 'false', '0'].includes(rotationValue),
    }]
  })
}

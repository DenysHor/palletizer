import { jsPDF } from 'jspdf'
import tmkaLogo from './assets/tmka-logo.webp'
import wamLogo from './assets/wam-logo.webp'
import type { PalletLoad } from './calculator'
import { copy, type Language } from './i18n'
import type { BoxType, Pallet, Placement } from './types'

const page = { width: 1754, height: 1240, margin: 58 }
const colours = { ink: '#172033', muted: '#657087', line: '#dfe5ee', card: '#f4f6fa', accent: '#5263bd', success: '#1f7548' }
const brandLogo: Record<Language, string> = { uk: tmkaLogo, en: wamLogo }

type ReportData = {
  language: Language
  orderName: string
  pallet: Pallet
  boxes: BoxType[]
  pallets: PalletLoad[]
  totalWeight: number
  captures: string[]
}

type Context = CanvasRenderingContext2D

function createCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = page.width; canvas.height = page.height
  const context = canvas.getContext('2d')!
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, page.width, page.height)
  context.font = '400 24px Arial, sans-serif'; context.fillStyle = colours.ink
  return { canvas, context }
}

function text(context: Context, value: string, x: number, y: number, size = 24, weight = 400, colour = colours.ink) {
  context.font = `${weight} ${size}px Arial, sans-serif`; context.fillStyle = colour; context.fillText(value, x, y)
}

function line(context: Context, x1: number, y1: number, x2: number, y2: number) {
  context.strokeStyle = colours.line; context.lineWidth = 2; context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke()
}

function roundRect(context: Context, x: number, y: number, width: number, height: number, colour: string) {
  context.fillStyle = colour; context.beginPath(); context.roundRect(x, y, width, height, 14); context.fill()
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = dataUrl })
}

function drawImageContain(context: Context, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height)
  const drawWidth = image.width * scale; const drawHeight = image.height * scale
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

function formatWeight(weight: number, unit: string) { return `${Math.round((weight + Number.EPSILON) * 100) / 100} ${unit}` }
function formatVolume(volumeMm3: number) { return `${(volumeMm3 / 1_000_000_000).toFixed(3)} м³` }
function placementVolume(placement: Placement) { return placement.size[0] * placement.size[1] * placement.size[2] }
function fillPercentage(load: PalletLoad, pallet: Pallet) {
  const capacity = pallet.length * pallet.width * pallet.maxHeight
  return capacity ? Math.min(100, Math.round(load.placements.reduce((sum, item) => sum + placementVolume(item), 0) / capacity * 100)) : 0
}

function palletContents(load: PalletLoad, boxes: BoxType[], language: Language) {
  return boxes.flatMap((box) => {
    const placements = load.placements.filter((item) => item.boxId === box.id)
    if (!placements.length) return []
    const orientations = [...new Set(placements.map((item) => item.size.join(' × ')))]
    return [{ box, quantity: placements.length, orientation: orientations.length === 1 ? `${orientations[0]} ${copy[language].millimeters}` : copy[language].multipleOrientations }]
  })
}

function drawMetric(context: Context, x: number, y: number, width: number, label: string, value: string) {
  roundRect(context, x, y, width, 92, colours.card)
  text(context, label, x + 18, y + 33, 18, 700, colours.muted)
  text(context, value, x + 18, y + 68, 30, 700)
}

async function palletPage(data: ReportData, load: PalletLoad, index: number) {
  const { canvas, context } = createCanvas()
  const t = copy[data.language]
  const pdf = t.pdf
  const number = index + 1
  const logo = await loadImage(brandLogo[data.language])
  drawImageContain(context, logo, page.margin, 18, 230, 94)
  text(context, pdf.reportTitle, page.margin + 255, 58, 20, 700, colours.accent)
  text(context, data.orderName || t.untitledOrder, page.margin + 255, 105, 36, 700)
  text(context, `${t.pallet} ${number} · ${pdf.fill} ${fillPercentage(load, data.pallet)}%`, page.width - page.margin - 420, 90, 25, 700, colours.success)
  line(context, page.margin, 125, page.width - page.margin, 125)

  roundRect(context, page.margin, 160, 980, 650, '#f6f8fb')
  const image = await loadImage(data.captures[index])
  drawImageContain(context, image, page.margin + 18, 178, 944, 614)
  text(context, pdf.visualization, page.margin + 22, 786, 18, 700, colours.muted)

  const metricX = 1085; const metricWidth = 270
  drawMetric(context, metricX, 165, metricWidth, pdf.placed, `${load.placements.length} ${t.pieces}`)
  drawMetric(context, metricX + 300, 165, metricWidth, pdf.cargoHeight, `${load.usedHeight} ${t.millimeters}`)
  drawMetric(context, metricX, 277, metricWidth, pdf.cargoWeight, formatWeight(load.totalWeight, t.kilograms))
  drawMetric(context, metricX + 300, 277, metricWidth, pdf.grossWeight, formatWeight(load.totalWeight + data.pallet.weight, t.kilograms))

  text(context, pdf.boxesOnPallet, metricX, 440, 20, 700, colours.accent)
  text(context, pdf.name, metricX, 480, 17, 700, colours.muted); text(context, pdf.orientation, metricX + 240, 480, 17, 700, colours.muted); text(context, pdf.quantity, metricX + 510, 480, 17, 700, colours.muted)
  line(context, metricX, 495, page.width - page.margin, 495)
  let rowY = 530
  for (const item of palletContents(load, data.boxes, data.language)) {
    text(context, item.box.name, metricX, rowY, 22, 700)
    text(context, item.orientation, metricX + 240, rowY, 19, 400, colours.muted)
    text(context, `${item.quantity} ${t.pieces}`, metricX + 510, rowY, 22, 700)
    line(context, metricX, rowY + 17, page.width - page.margin, rowY + 17); rowY += 55
  }
  text(context, `${pdf.palletSize}: ${data.pallet.length} × ${data.pallet.width} ${t.millimeters} · ${pdf.maxHeight}: ${data.pallet.maxHeight} ${t.millimeters}`, page.margin, 888, 20, 400, colours.muted)
  text(context, `${pdf.page} ${number} ${pdf.pageOf} ${data.pallets.length + 1}`, page.width - page.margin - 200, page.height - 54, 18, 400, colours.muted)
  return canvas
}

async function orderSummaryPage(data: ReportData) {
  const { canvas, context } = createCanvas()
  const t = copy[data.language]
  const pdf = t.pdf
  const requestedBoxes = data.boxes.reduce((sum, box) => sum + Math.max(0, box.quantity), 0)
  const requestedWeight = data.boxes.reduce((sum, box) => sum + box.quantity * Math.max(0, box.weight), 0)
  const requestedVolume = data.boxes.reduce((sum, box) => sum + box.quantity * box.length * box.width * box.height, 0)
  const palletsWeight = data.pallets.length * data.pallet.weight

  const logo = await loadImage(brandLogo[data.language])
  drawImageContain(context, logo, page.margin, 18, 230, 94)
  text(context, pdf.reportTitle, page.margin + 255, 58, 20, 700, colours.accent)
  text(context, data.orderName || t.untitledOrder, page.margin + 255, 105, 36, 700)
  text(context, pdf.orderData, page.margin, 168, 28, 700)
  drawMetric(context, page.margin, 195, 245, pdf.totalBoxes, `${requestedBoxes} ${t.pieces}`)
  drawMetric(context, page.margin + 270, 195, 245, pdf.boxesVolume, formatVolume(requestedVolume))
  drawMetric(context, page.margin + 540, 195, 245, pdf.palletsNeeded, `${data.pallets.length} ${t.pieces}`)
  drawMetric(context, page.margin + 810, 195, 245, pdf.boxesWeight, formatWeight(requestedWeight, t.kilograms))
  drawMetric(context, page.margin + 1080, 195, 245, pdf.grossWeightOrder, formatWeight(data.totalWeight + palletsWeight, t.kilograms))
  text(context, `${pdf.totalVolume}: ${formatVolume(requestedVolume)} · ${pdf.palletsWeight}: ${formatWeight(palletsWeight, t.kilograms)}`, page.margin, 330, 21, 400, colours.muted)

  text(context, pdf.boxesList, page.margin, 405, 26, 700)
  const columns = [page.margin, 440, 700, 910, 1090, 1275, 1505]
  const headers = [pdf.name, pdf.dimensions, pdf.quantity, pdf.itemWeight, pdf.volume, pdf.totalWeight]
  headers.forEach((header, index) => text(context, header, columns[index], 445, 17, 700, colours.muted))
  line(context, page.margin, 462, page.width - page.margin, 462)
  let y = 505
  for (const box of data.boxes) {
    text(context, box.name, columns[0], y, 22, 700)
    text(context, `${box.length} × ${box.width} × ${box.height}`, columns[1], y, 20, 400, colours.muted)
    text(context, `${box.quantity} ${t.pieces}`, columns[2], y, 20)
    text(context, formatWeight(box.weight, t.kilograms), columns[3], y, 20)
    text(context, formatVolume(box.quantity * box.length * box.width * box.height), columns[4], y, 20)
    text(context, formatWeight(box.quantity * box.weight, t.kilograms), columns[5], y, 20, 700)
    line(context, page.margin, y + 18, page.width - page.margin, y + 18); y += 52
  }
  roundRect(context, page.margin, Math.max(y + 24, 600), page.width - page.margin * 2, 126, '#edf0ff')
  const totalY = Math.max(y + 65, 640)
  text(context, pdf.totals, page.margin + 25, totalY - 25, 19, 700, colours.accent)
  text(context, `${t.totalBoxes}: ${requestedBoxes} ${t.pieces}`, page.margin + 25, totalY + 18, 23, 700)
  text(context, `${pdf.volumeTotal}: ${formatVolume(requestedVolume)}`, page.margin + 410, totalY + 18, 23, 700)
  text(context, `${pdf.boxesWeightTotal}: ${formatWeight(requestedWeight, t.kilograms)}`, page.margin + 820, totalY + 18, 23, 700)
  text(context, `${t.grossWeight}: ${formatWeight(data.totalWeight + palletsWeight, t.kilograms)}`, page.margin + 25, totalY + 60, 23, 700)
  text(context, `${pdf.palletSize}: ${data.pallet.length} × ${data.pallet.width} ${t.millimeters} · ${pdf.maxHeight}: ${data.pallet.maxHeight} ${t.millimeters}`, page.margin + 410, totalY + 60, 20, 400, colours.muted)
  text(context, `${pdf.page} ${data.pallets.length + 1} ${pdf.pageOf} ${data.pallets.length + 1}`, page.width - page.margin - 200, page.height - 54, 18, 400, colours.muted)
  return canvas
}

export async function exportPalletPdf(data: ReportData) {
  const document = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })
  for (let index = 0; index < data.pallets.length; index += 1) {
    if (index > 0) document.addPage('a4', 'landscape')
    const canvas = await palletPage(data, data.pallets[index], index)
    document.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 297, 210, undefined, 'FAST')
  }
  if (data.pallets.length) document.addPage('a4', 'landscape')
  const summary = await orderSummaryPage(data)
  document.addImage(summary.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 297, 210, undefined, 'FAST')
  const fallbackName = data.language === 'uk' ? 'замовлення' : 'order'
  const fileName = `${copy[data.language].pdf.fileName}-${(data.orderName || fallbackName).replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || fallbackName}.pdf`
  document.save(fileName)
}

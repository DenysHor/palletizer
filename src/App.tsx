import { useMemo, useRef, useState } from 'react'
import { colourForIndex } from './boxColours'
import { boxesFromCsv, googleSheetCsvUrl } from './boxImport'
import { calculatePallet } from './calculator'
import { PalletScene } from './PalletScene'
import { exportPalletPdf } from './pdfReport'
import type { BoxType, Pallet } from './types'

const initialPallet: Pallet = { length: 1200, width: 800, maxHeight: 1600, weight: 15 }
const initialBoxes: BoxType[] = [
  { id: crypto.randomUUID(), name: 'Коробка A', length: 400, width: 300, height: 250, quantity: 24, weight: 12, allowHorizontalRotation: true },
  { id: crypto.randomUUID(), name: 'Коробка B', length: 300, width: 200, height: 180, quantity: 30, weight: 7, allowHorizontalRotation: true },
]
const toNumber = (value: string) => Math.max(0, Number(value) || 0)
const storageKey = 'palletizer.saved-orders.v1'
const googleSheetTemplateCopyUrl = 'https://docs.google.com/spreadsheets/d/1tjanmhmIUI14_jO73fEvnXd9kJNRfS5R3p3cX0GLInk/copy'
type SavedOrder = { id: string; name: string; pallet: Pallet; boxes: BoxType[] }

function freshInitialBoxes(): BoxType[] { return initialBoxes.map((box) => ({ ...box, id: crypto.randomUUID() })) }
function loadSavedOrders(): SavedOrder[] {
  try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]') as SavedOrder[] } catch { return [] }
}
function persistSavedOrders(orders: SavedOrder[]) { localStorage.setItem(storageKey, JSON.stringify(orders)) }

export default function App() {
  const [pallet, setPallet] = useState(initialPallet)
  const [boxes, setBoxes] = useState(freshInitialBoxes)
  const [selectedPallet, setSelectedPallet] = useState(0)
  const [orderName, setOrderName] = useState('')
  const [savedOrders, setSavedOrders] = useState(loadSavedOrders)
  const [savedOrderId, setSavedOrderId] = useState<string>()
  const [highlightedBoxId, setHighlightedBoxId] = useState<string>()
  const [importUrl, setImportUrl] = useState('')
  const [importStatus, setImportStatus] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [isExportingPdf, setIsExportingPdf] = useState(false)
  const [pdfStatus, setPdfStatus] = useState('')
  const sceneCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const palletWithDefaults = { ...initialPallet, ...pallet }
  const calculation = useMemo(() => calculatePallet(palletWithDefaults, boxes), [palletWithDefaults, boxes])
  const allPlaced = calculation.results.every((result) => result.remaining === 0)
  const activePallet = calculation.pallets[Math.min(selectedPallet, calculation.pallets.length - 1)] ?? { placements: [], usedHeight: 0, totalWeight: 0 }
  const activeContents = boxes.map((box, index) => ({ box, index, quantity: activePallet.placements.filter((placement) => placement.boxId === box.id).length })).filter((item) => item.quantity > 0)
  const totalBoxes = boxes.reduce((total, box) => total + Math.max(0, box.quantity), 0)
  const palletsWeight = calculation.pallets.length * palletWithDefaults.weight
  const grossWeight = calculation.totalWeight + palletsWeight

  const updatePallet = (key: keyof Pallet, value: string) => setPallet((current) => ({ ...initialPallet, ...current, [key]: toNumber(value) }))
  const updateBox = (id: string, key: keyof BoxType, value: string | boolean) => setBoxes((items) => items.map((box) => box.id === id ? { ...box, [key]: typeof value === 'string' && key !== 'name' ? toNumber(value) : value } : box))
  const addBox = () => setBoxes((items) => [...items, { id: crypto.randomUUID(), name: `Коробка ${String.fromCharCode(65 + items.length)}`, length: 300, width: 200, height: 200, quantity: 1, weight: 0, allowHorizontalRotation: true }])
  const saveOrder = () => {
    const name = orderName.trim()
    if (!name) return
    const saved: SavedOrder = { id: savedOrderId ?? crypto.randomUUID(), name, pallet: palletWithDefaults, boxes }
    setSavedOrders((current) => {
      const next = current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]
      persistSavedOrders(next)
      return next
    })
    setSavedOrderId(saved.id)
  }
  const openOrder = (id: string) => {
    const saved = savedOrders.find((item) => item.id === id)
    if (!saved) return
    setOrderName(saved.name); setPallet({ ...initialPallet, ...saved.pallet }); setBoxes(saved.boxes); setSavedOrderId(saved.id); setSelectedPallet(0)
  }
  const newOrder = () => { setOrderName(''); setPallet(initialPallet); setBoxes(freshInitialBoxes()); setSavedOrderId(undefined); setSelectedPallet(0) }
  const importBoxes = async () => {
    if (!importUrl.trim()) return
    setIsImporting(true); setImportStatus('Завантажуємо таблицю…')
    try {
      const response = await fetch(googleSheetCsvUrl(importUrl))
      if (!response.ok) throw new Error('Посилання не відкрилося.')
      const imported = boxesFromCsv(await response.text())
      if (!imported.length) throw new Error('У таблиці немає коректних рядків коробок.')
      setBoxes((current) => [...current, ...imported])
      setImportStatus(`Додано типів коробок: ${imported.length}.`)
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : 'Не вдалося імпортувати таблицю.')
    } finally { setIsImporting(false) }
  }
  const exportPdf = async () => {
    if (!calculation.pallets.length || isExportingPdf) return
    const previousPallet = selectedPallet
    const previousHighlight = highlightedBoxId
    setPdfStatus('')
    setIsExportingPdf(true)
    try {
      const captures: string[] = []
      for (let index = 0; index < calculation.pallets.length; index += 1) {
        setSelectedPallet(index)
        setHighlightedBoxId(undefined)
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120))
        if (!sceneCanvasRef.current) throw new Error('Не вдалося підготувати 3D-візуалізацію.')
        captures.push(sceneCanvasRef.current.toDataURL('image/png'))
      }
      await exportPalletPdf({ orderName, pallet: palletWithDefaults, boxes, pallets: calculation.pallets, totalPlaced: calculation.totalPlaced, totalWeight: calculation.totalWeight, captures })
    } catch (error) {
      setPdfStatus(error instanceof Error ? error.message : 'Не вдалося створити PDF-звіт.')
    } finally {
      setSelectedPallet(previousPallet)
      setHighlightedBoxId(previousHighlight)
      setIsExportingPdf(false)
    }
  }

  return <main>
    <header><div><p className="eyebrow">MVP</p><h1>Калькулятор палетизації</h1><p>Вкажіть габарити, а ми покажемо базову схему укладки.</p></div><span className={allPlaced ? 'status good' : 'status'}>{allPlaced ? `Розкладено на палетах: ${calculation.pallets.length}` : 'Частина коробок не вмістилась'}</span></header>
    <div className="layout">
      <section className="controls">
        <label className="field order-name"><span>Назва замовлення</span><input type="text" placeholder="Наприклад, Замовлення № 184" value={orderName} onChange={(event) => setOrderName(event.target.value)} /></label>
        <div className="order-actions"><button className="secondary" disabled={!orderName.trim()} onClick={saveOrder}>Зберегти</button><button className="new-order" onClick={newOrder}>Нове замовлення</button></div>
        {savedOrders.length > 0 && <label className="field saved-orders"><span>Збережені замовлення</span><select value={savedOrderId ?? ''} onChange={(event) => openOrder(event.target.value)}><option value="" disabled>Оберіть замовлення</option>{savedOrders.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}</select></label>}
        <h2>Палета</h2><div className="field-grid pallet-fields">
          <Field label="Довжина, мм" value={palletWithDefaults.length} onChange={(value) => updatePallet('length', value)} />
          <Field label="Ширина, мм" value={palletWithDefaults.width} onChange={(value) => updatePallet('width', value)} />
          <Field label="Макс. висота вантажу, мм" value={palletWithDefaults.maxHeight} onChange={(value) => updatePallet('maxHeight', value)} />
          <Field label="Вага палети, кг" value={palletWithDefaults.weight} onChange={(value) => updatePallet('weight', value)} />
        </div>
        <p className="hint">Коробки не виходять за межі палети. Допустимий звіс верхнього шару над нижнім — до 100 мм.</p>
        <div className="import-box"><h2>Імпорт коробок</h2><p>Створіть копію готового шаблону у своєму Google Drive, заповніть рядки та вставте посилання нижче. Імпорт додасть їх до списку.</p><a className="template-link" href={googleSheetTemplateCopyUrl} target="_blank" rel="noreferrer">+ Створити Google Таблицю за шаблоном</a><div className="import-actions"><input aria-label="Посилання на Google Таблицю або CSV" type="url" placeholder="https://docs.google.com/spreadsheets/d/..." value={importUrl} onChange={(event) => setImportUrl(event.target.value)} /><button className="secondary" disabled={isImporting || !importUrl.trim()} onClick={importBoxes}>{isImporting ? 'Імпорт…' : 'Імпортувати'}</button></div>{importStatus && <small className={importStatus.startsWith('Додано') ? 'import-success' : 'import-status'}>{importStatus}</small>}<small className="import-help">Колонки: Назва, Довжина, Ширина, Висота; додатково — Кількість, Вага, Поворот.</small></div>
        <div className="section-heading"><h2>Типи коробок</h2><button className="secondary" onClick={addBox}>+ Додати</button></div>
        <div className="box-list">{boxes.map((box, index) => <article className="box-card" key={box.id}>
          <div className="card-title"><span className="colour-dot" style={{ backgroundColor: colourForIndex(index) }} aria-hidden="true" /><input aria-label="Назва коробки" value={box.name} onChange={(event) => updateBox(box.id, 'name', event.target.value)} />{boxes.length > 1 && <button className="remove" aria-label="Видалити коробку" onClick={() => setBoxes((items) => items.filter((item) => item.id !== box.id))}>×</button>}</div>
          <div className="field-grid compact">
            <Field label="Д, мм" value={box.length} onChange={(value) => updateBox(box.id, 'length', value)} />
            <Field label="Ш, мм" value={box.width} onChange={(value) => updateBox(box.id, 'width', value)} />
            <Field label="В, мм" value={box.height} onChange={(value) => updateBox(box.id, 'height', value)} />
            <Field label="Кількість" value={box.quantity} onChange={(value) => updateBox(box.id, 'quantity', value)} />
            <Field label="Вага, кг" value={box.weight} onChange={(value) => updateBox(box.id, 'weight', value)} />
          </div>
          <label className="check"><input type="checkbox" checked={box.allowHorizontalRotation} onChange={(event) => updateBox(box.id, 'allowHorizontalRotation', event.target.checked)} /> Дозволити поворот коробки в усіх площинах</label>
          <small>Тип {index + 1}</small>
        </article>)}</div>
      </section>
      <section className="result"><div className="result-head"><div><p className="eyebrow">3D-схема</p><h2>{orderName ? `Укладка: ${orderName}` : 'Укладка на палеті'}</h2></div><div className="result-actions"><p>Перетягуйте, щоб повернути модель</p><button className="pdf-export" disabled={!calculation.pallets.length || isExportingPdf} onClick={exportPdf}>{isExportingPdf ? 'Створюємо PDF…' : 'Експортувати PDF'}</button></div></div>
        {calculation.pallets.length > 1 && <div className="pallet-tabs" aria-label="Вибір палети">{calculation.pallets.map((load, index) => <button key={index} className={index === Math.min(selectedPallet, calculation.pallets.length - 1) ? 'active' : ''} onClick={() => setSelectedPallet(index)}>Палета {index + 1} · {palletFillPercentage(load.placements, palletWithDefaults)}%</button>)}</div>}
        <PalletScene pallet={palletWithDefaults} boxes={boxes} placements={activePallet.placements} highlightedBoxId={highlightedBoxId} onCanvasReady={(canvas) => { sceneCanvasRef.current = canvas }} />
        {pdfStatus && <p className="pdf-status">{pdfStatus}</p>}
        <div className="metrics"><Metric label="Розміщено на цій палеті" value={`${activePallet.placements.length} шт.`} /><Metric label="Висота вантажу" value={`${activePallet.usedHeight} мм`} /><Metric label="Вага вантажу" value={`${activePallet.totalWeight} кг`} /></div>
        <section className="report"><div><p className="eyebrow">Звіт</p><h3>Підсумок замовлення</h3></div><div className="report-grid"><Metric label="Усього коробок" value={`${totalBoxes} шт.`} /><Metric label="Розміщено коробок" value={`${calculation.totalPlaced} шт.`} /><Metric label="Палет потрібно" value={`${calculation.pallets.length} шт.`} /><Metric label="Вага коробок" value={formatWeight(calculation.totalWeight)} /><Metric label="Вага палет" value={formatWeight(palletsWeight)} /><Metric label="Вага з палетами" value={formatWeight(grossWeight)} /></div></section>
        <div className="pallet-contents"><h3>На цій палеті</h3><p>Наведіть на тип коробки, щоб підсвітити його у 3D.</p>{activeContents.map(({ box, index, quantity }) => <div className="pallet-content-row" key={box.id} tabIndex={0} onMouseEnter={() => setHighlightedBoxId(box.id)} onMouseLeave={() => setHighlightedBoxId(undefined)} onFocus={() => setHighlightedBoxId(box.id)} onBlur={() => setHighlightedBoxId(undefined)}><span className="colour-dot" style={{ backgroundColor: colourForIndex(index) }} aria-hidden="true" /><span>{box.name}</span><strong>{quantity} шт.</strong></div>)}</div>
        <div className="summary"><h3>Результат за типами</h3>{calculation.results.map((item) => { const box = boxes.find((candidate) => candidate.id === item.boxId); return <div className="summary-row" key={item.boxId}><span>{box?.name}</span><span>{item.placed} / {box?.quantity} шт.</span><span className={item.remaining ? 'warning' : 'success'}>{item.remaining ? `Залишок: ${item.remaining}` : 'Вмістилось'}</span><small>{item.orientation}</small></div> })}</div>
      </section>
    </div>
  </main>
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return <label className="field"><span>{label}</span><input type="number" min="0" value={value} onChange={(event) => onChange(event.target.value)} /></label>
}
function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function formatWeight(weight: number) { return `${Number.isInteger(weight) ? weight : weight.toFixed(1)} кг` }
function palletFillPercentage(placements: { size: [number, number, number] }[], pallet: Pallet) {
  const palletVolume = pallet.length * pallet.width * pallet.maxHeight
  const boxesVolume = placements.reduce((total, placement) => total + placement.size[0] * placement.size[1] * placement.size[2], 0)
  return palletVolume > 0 ? Math.min(100, Math.round(boxesVolume / palletVolume * 100)) : 0
}

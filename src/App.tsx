import { useEffect, useMemo, useRef, useState } from 'react'
import tmkaLogo from './assets/tmka-logo.webp'
import wamLogo from './assets/wam-logo.webp'
import { colourForIndex } from './boxColours'
import { boxesFromCsv, googleSheetCsvUrl } from './boxImport'
import { calculatePallet } from './calculator'
import { copy, detectBrowserLanguage, languageLabel, type Language } from './i18n'
import { PalletScene } from './PalletScene'
import { exportPalletPdf } from './pdfReport'
import type { BoxType, Pallet } from './types'

const initialPallet: Pallet = { length: 1200, width: 800, maxHeight: 1600, weight: 15 }
const toNumber = (value: string) => Math.max(0, Number(value) || 0)
const storageKey = 'palletizer.saved-orders.v1'
const languageStorageKey = 'palletizer.language.v1'
const googleSheetTemplateCopyUrl = 'https://docs.google.com/spreadsheets/d/1tjanmhmIUI14_jO73fEvnXd9kJNRfS5R3p3cX0GLInk/copy'
const targetFillPercent = 90
const brandLogo: Record<Language, string> = { uk: tmkaLogo, en: wamLogo }
const brandName: Record<Language, string> = { uk: 'Tmka', en: 'Wam' }
type SavedOrder = { id: string; name: string; pallet: Pallet; boxes: BoxType[] }
type CalculationInput = { pallet: Pallet; boxes: BoxType[] }

function freshInitialBoxes(language: Language): BoxType[] {
  const box = copy[language].box
  return [
    { id: crypto.randomUUID(), name: `${box} A`, length: 400, width: 300, height: 250, quantity: 24, weight: 12, allowHorizontalRotation: true },
    { id: crypto.randomUUID(), name: `${box} B`, length: 300, width: 200, height: 180, quantity: 30, weight: 7, allowHorizontalRotation: true },
  ]
}
function loadSavedOrders(): SavedOrder[] {
  try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]') as SavedOrder[] } catch { return [] }
}
function persistSavedOrders(orders: SavedOrder[]) { localStorage.setItem(storageKey, JSON.stringify(orders)) }
function copyCalculationInput(pallet: Pallet, boxes: BoxType[]): CalculationInput { return { pallet: { ...pallet }, boxes: boxes.map((box) => ({ ...box })) } }
function initialLanguage(): Language {
  try {
    const savedLanguage = localStorage.getItem(languageStorageKey)
    if (savedLanguage === 'uk' || savedLanguage === 'en') return savedLanguage
  } catch { /* Browser language remains the safe fallback. */ }
  return detectBrowserLanguage()
}

export default function App() {
  const [language, setLanguage] = useState<Language>(initialLanguage)
  const t = copy[language]
  const [pallet, setPallet] = useState(initialPallet)
  const [initialBoxState] = useState<BoxType[]>(() => freshInitialBoxes(language))
  const [boxes, setBoxes] = useState<BoxType[]>(initialBoxState)
  const [calculationInput, setCalculationInput] = useState<CalculationInput>(() => copyCalculationInput(initialPallet, initialBoxState))
  const [selectedPallet, setSelectedPallet] = useState(0)
  const [orderName, setOrderName] = useState('')
  const [savedOrders, setSavedOrders] = useState(loadSavedOrders)
  const [savedOrderId, setSavedOrderId] = useState<string>()
  const [highlightedBoxId, setHighlightedBoxId] = useState<string>()
  const [importUrl, setImportUrl] = useState('')
  const [importStatus, setImportStatus] = useState('')
  const [importSucceeded, setImportSucceeded] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isExportingPdf, setIsExportingPdf] = useState(false)
  const [pdfStatus, setPdfStatus] = useState('')
  const sceneCanvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => { document.documentElement.lang = language; document.title = t.appTitle; localStorage.setItem(languageStorageKey, language) }, [language, t.appTitle])
  const palletWithDefaults = useMemo(() => ({ ...initialPallet, ...pallet }), [pallet])
  const calculatedPallet = useMemo(() => ({ ...initialPallet, ...calculationInput.pallet }), [calculationInput.pallet])
  const calculation = useMemo(() => calculatePallet(calculatedPallet, calculationInput.boxes), [calculatedPallet, calculationInput.boxes])
  const currentLayoutKey = useMemo(() => JSON.stringify({ pallet: palletWithDefaults, boxes }), [palletWithDefaults, boxes])
  const calculatedLayoutKey = useMemo(() => JSON.stringify({ pallet: calculatedPallet, boxes: calculationInput.boxes }), [calculatedPallet, calculationInput.boxes])
  const needsRecalculation = currentLayoutKey !== calculatedLayoutKey
  const allPlaced = calculation.results.every((result) => result.remaining === 0)
  const underfilledPallets = calculation.pallets.slice(0, -1).filter((load) => palletFillPercentage(load.placements, calculatedPallet) < targetFillPercent)
  const meetsFillTarget = allPlaced && underfilledPallets.length === 0
  const activePallet = calculation.pallets[Math.min(selectedPallet, calculation.pallets.length - 1)] ?? { placements: [], usedHeight: 0, totalWeight: 0 }
  const activeContents = calculationInput.boxes.map((box, index) => ({ box, index, quantity: activePallet.placements.filter((placement) => placement.boxId === box.id).length })).filter((item) => item.quantity > 0)
  const totalBoxes = calculationInput.boxes.reduce((total, box) => total + Math.max(0, box.quantity), 0)
  const totalVolume = calculationInput.boxes.reduce((total, box) => total + Math.max(0, box.quantity) * box.length * box.width * box.height, 0)
  const targetPalletVolume = calculatedPallet.length * calculatedPallet.width * calculatedPallet.maxHeight * targetFillPercent / 100
  const maximumPalletsAtTarget = targetPalletVolume > 0 ? Math.floor(totalVolume / targetPalletVolume) + 1 : 0
  const targetIsImpossibleByVolume = targetPalletVolume > 0 && calculation.pallets.length > maximumPalletsAtTarget
  const palletsWeight = calculation.pallets.length * calculatedPallet.weight
  const grossWeight = calculation.totalWeight + palletsWeight

  const updatePallet = (key: keyof Pallet, value: string) => setPallet((current) => ({ ...initialPallet, ...current, [key]: toNumber(value) }))
  const updateBox = (id: string, key: keyof BoxType, value: string | boolean) => setBoxes((items) => items.map((box) => box.id === id ? { ...box, [key]: typeof value === 'string' && key !== 'name' ? toNumber(value) : value } : box))
  const addBox = () => setBoxes((items) => [...items, { id: crypto.randomUUID(), name: `${t.box} ${String.fromCharCode(65 + items.length)}`, length: 300, width: 200, height: 200, quantity: 1, weight: 0, allowHorizontalRotation: true }])
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
  const calculateLayout = () => {
    setCalculationInput(copyCalculationInput(palletWithDefaults, boxes))
    setSelectedPallet(0)
    setHighlightedBoxId(undefined)
    setPdfStatus('')
  }
  const openOrder = (id: string) => {
    const saved = savedOrders.find((item) => item.id === id)
    if (!saved) return
    const savedPallet = { ...initialPallet, ...saved.pallet }
    const savedBoxes = saved.boxes.map((box) => ({ ...box }))
    setOrderName(saved.name); setPallet(savedPallet); setBoxes(savedBoxes); setCalculationInput(copyCalculationInput(savedPallet, savedBoxes)); setSavedOrderId(saved.id); setSelectedPallet(0); setHighlightedBoxId(undefined); setPdfStatus('')
  }
  const deleteOrder = () => {
    const saved = savedOrders.find((item) => item.id === savedOrderId)
    if (!saved || !window.confirm(t.deleteOrderConfirmation(saved.name))) return
    setSavedOrders((current) => {
      const next = current.filter((item) => item.id !== saved.id)
      persistSavedOrders(next)
      return next
    })
    setSavedOrderId(undefined)
  }
  const newOrder = () => {
    const newPallet = { ...initialPallet }
    const newBoxes = freshInitialBoxes(language)
    setOrderName(''); setPallet(newPallet); setBoxes(newBoxes); setCalculationInput(copyCalculationInput(newPallet, newBoxes)); setSavedOrderId(undefined); setSelectedPallet(0); setHighlightedBoxId(undefined); setPdfStatus('')
  }
  const importBoxes = async () => {
    if (!importUrl.trim()) return
    setIsImporting(true); setImportSucceeded(false); setImportStatus(t.importLoading)
    try {
      const response = await fetch(googleSheetCsvUrl(importUrl))
      if (!response.ok) throw new Error(t.importUrlFailed)
      const imported = boxesFromCsv(await response.text(), { box: t.box, empty: t.importEmpty, missingColumns: t.importMissingColumns })
      if (!imported.length) throw new Error(t.importEmpty)
      setBoxes((current) => [...current, ...imported])
      setImportStatus(t.importAdded(imported.length)); setImportSucceeded(true)
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : t.importFailed); setImportSucceeded(false)
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
        if (!sceneCanvasRef.current) throw new Error(t.pdfPreparingError)
        captures.push(sceneCanvasRef.current.toDataURL('image/png'))
      }
      await exportPalletPdf({ language, orderName, pallet: calculatedPallet, boxes: calculationInput.boxes, pallets: calculation.pallets, totalWeight: calculation.totalWeight, captures })
    } catch (error) {
      setPdfStatus(error instanceof Error ? error.message : t.pdfFailed)
    } finally {
      setSelectedPallet(previousPallet)
      setHighlightedBoxId(previousHighlight)
      setIsExportingPdf(false)
    }
  }

  return <main>
    <header>
      <div className="brand-heading"><img className="brand-logo" src={brandLogo[language]} alt={brandName[language]} /><div><p className="eyebrow">MVP</p><h1>{t.appTitle}</h1><p>{t.appSubtitle}</p></div></div>
      <div className="header-actions">
        <label className="language-switch"><span>{t.language}</span><select aria-label={t.language} value={language} onChange={(event) => setLanguage(event.target.value as Language)}>{(Object.keys(languageLabel) as Language[]).map((item) => <option key={item} value={item}>{languageLabel[item]}</option>)}</select></label>
        <span className={!needsRecalculation && meetsFillTarget ? 'status good' : 'status'}>{needsRecalculation ? t.stale : !allPlaced ? t.boxesDoNotFit : targetIsImpossibleByVolume ? t.targetImpossible(calculation.pallets.length) : underfilledPallets.length ? t.underfilled(underfilledPallets.length) : t.placedOnPallets(calculation.pallets.length)}</span>
      </div>
    </header>
    <div className="layout">
      <section className="controls">
        <label className="field order-name"><span>{t.orderName}</span><input type="text" placeholder={t.orderPlaceholder} value={orderName} onChange={(event) => setOrderName(event.target.value)} /></label>
        <div className="order-actions"><button className="secondary" disabled={!orderName.trim()} onClick={saveOrder}>{t.save}</button><button className="new-order" onClick={newOrder}>{t.newOrder}</button></div>
        {savedOrders.length > 0 && <div className="saved-order-controls"><label className="field saved-orders"><span>{t.savedOrders}</span><select value={savedOrderId ?? ''} onChange={(event) => openOrder(event.target.value)}><option value="" disabled>{t.chooseOrder}</option>{savedOrders.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}</select></label><button className="delete-saved-order" disabled={!savedOrderId} onClick={deleteOrder}>{t.deleteOrder}</button></div>}
        <div className="calculation-actions"><button className="calculate" onClick={calculateLayout}>{t.calculate}</button>{needsRecalculation && <span>{t.recalculationNeeded}</span>}</div>
        <h2>{t.pallet}</h2><div className="field-grid pallet-fields">
          <Field label={t.palletLength} value={palletWithDefaults.length} onChange={(value) => updatePallet('length', value)} />
          <Field label={t.palletWidth} value={palletWithDefaults.width} onChange={(value) => updatePallet('width', value)} />
          <Field label={t.maxCargoHeight} value={palletWithDefaults.maxHeight} onChange={(value) => updatePallet('maxHeight', value)} />
          <Field label={t.palletWeight} value={palletWithDefaults.weight} onChange={(value) => updatePallet('weight', value)} />
        </div>
        <p className="hint">{t.palletHint}</p>
        <div className="import-box"><h2>{t.importBoxes}</h2><p>{t.importDescription}</p><a className="template-link" href={googleSheetTemplateCopyUrl} target="_blank" rel="noreferrer">{t.createTemplate}</a><div className="import-actions"><input aria-label={t.importUrl} type="url" placeholder={t.importPlaceholder} value={importUrl} onChange={(event) => setImportUrl(event.target.value)} /><button className="secondary" disabled={isImporting || !importUrl.trim()} onClick={importBoxes}>{isImporting ? t.importing : t.import}</button></div>{importStatus && <small className={importSucceeded ? 'import-success' : 'import-status'}>{importStatus}</small>}<small className="import-help">{t.importColumns}</small></div>
        <div className="section-heading"><h2>{t.boxTypes}</h2><button className="secondary" onClick={addBox}>{t.add}</button></div>
        <div className="box-list">{boxes.map((box, index) => <article className="box-card" key={box.id}>
          <div className="card-title"><span className="colour-dot" style={{ backgroundColor: colourForIndex(index) }} aria-hidden="true" /><input aria-label={t.boxName} value={box.name} onChange={(event) => updateBox(box.id, 'name', event.target.value)} />{boxes.length > 1 && <button className="remove" aria-label={t.removeBox} onClick={() => setBoxes((items) => items.filter((item) => item.id !== box.id))}>×</button>}</div>
          <div className="field-grid compact">
            <Field label={t.length} value={box.length} onChange={(value) => updateBox(box.id, 'length', value)} />
            <Field label={t.width} value={box.width} onChange={(value) => updateBox(box.id, 'width', value)} />
            <Field label={t.height} value={box.height} onChange={(value) => updateBox(box.id, 'height', value)} />
            <Field label={t.quantity} value={box.quantity} onChange={(value) => updateBox(box.id, 'quantity', value)} />
            <Field label={t.weight} value={box.weight} onChange={(value) => updateBox(box.id, 'weight', value)} />
          </div>
          <label className="check"><input type="checkbox" checked={box.allowHorizontalRotation} onChange={(event) => updateBox(box.id, 'allowHorizontalRotation', event.target.checked)} /> {t.rotateAll}</label>
          <small>{t.type(index + 1)}</small>
        </article>)}</div>
      </section>
      <section className="result"><div className="result-head"><div><p className="eyebrow">{t.diagram}</p><h2>{orderName ? t.orderLayout(orderName) : t.layout}</h2></div><div className="result-actions"><p>{t.rotateHint}</p><button className="pdf-export" disabled={!calculation.pallets.length || isExportingPdf || needsRecalculation} onClick={exportPdf}>{isExportingPdf ? t.exportingPdf : t.exportPdf}</button></div></div>
        {calculation.pallets.length > 1 && <div className="pallet-tabs" aria-label={t.selectPallet}>{calculation.pallets.map((load, index) => { const fill = palletFillPercentage(load.placements, calculatedPallet); const isUnderfilled = index < calculation.pallets.length - 1 && fill < targetFillPercent; return <button key={index} className={[index === Math.min(selectedPallet, calculation.pallets.length - 1) ? 'active' : '', isUnderfilled ? 'underfilled' : ''].filter(Boolean).join(' ')} onClick={() => setSelectedPallet(index)}>{t.palletTab(index + 1, fill)}</button> })}</div>}
        <PalletScene pallet={calculatedPallet} boxes={calculationInput.boxes} placements={activePallet.placements} highlightedBoxId={highlightedBoxId} onCanvasReady={(canvas) => { sceneCanvasRef.current = canvas }} />
        {pdfStatus && <p className="pdf-status">{pdfStatus}</p>}
        <div className="metrics"><Metric label={t.placedHere} value={`${activePallet.placements.length} ${t.pieces}`} /><Metric label={t.cargoHeight} value={`${activePallet.usedHeight} ${t.millimeters}`} /><Metric label={t.cargoWeight} value={formatWeight(activePallet.totalWeight, t.kilograms)} /></div>
        <section className="report"><div><p className="eyebrow">{t.report}</p><h3>{t.orderSummary}</h3></div><div className="report-grid"><Metric label={t.totalBoxes} value={`${totalBoxes} ${t.pieces}`} /><Metric label={t.totalVolume} value={formatVolume(totalVolume)} /><Metric label={t.palletsNeeded} value={`${calculation.pallets.length} ${t.pieces}`} /><Metric label={t.boxesWeight} value={formatWeight(calculation.totalWeight, t.kilograms)} /><Metric label={t.palletsWeight} value={formatWeight(palletsWeight, t.kilograms)} /><Metric label={t.grossWeight} value={formatWeight(grossWeight, t.kilograms)} /></div>{targetIsImpossibleByVolume && <p className="target-warning">{t.targetWarning(maximumPalletsAtTarget, calculation.pallets.length)}</p>}</section>
        <div className="pallet-contents"><h3>{t.onThisPallet}</h3><p>{t.highlightHint}</p>{activeContents.map(({ box, index, quantity }) => <div className="pallet-content-row" key={box.id} tabIndex={0} onMouseEnter={() => setHighlightedBoxId(box.id)} onMouseLeave={() => setHighlightedBoxId(undefined)} onFocus={() => setHighlightedBoxId(box.id)} onBlur={() => setHighlightedBoxId(undefined)}><span className="colour-dot" style={{ backgroundColor: colourForIndex(index) }} aria-hidden="true" /><span>{box.name} ({box.length} × {box.width} × {box.height} {t.millimeters})</span><strong>{quantity} {t.pieces}</strong></div>)}</div>
        <div className="summary"><h3>{t.resultsByType}</h3>{calculation.results.map((item) => { const box = calculationInput.boxes.find((candidate) => candidate.id === item.boxId); const orientation = item.multipleOrientations ? t.multipleOrientations : item.orientation || t.notPlaced; return <div className="summary-row" key={item.boxId}><span>{box?.name}</span><span>{item.placed} / {box?.quantity} {t.pieces}</span><span className={item.remaining ? 'warning' : 'success'}>{item.remaining ? t.remaining(item.remaining) : t.fits}</span><small>{orientation}</small></div> })}</div>
      </section>
    </div>
  </main>
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return <label className="field"><span>{label}</span><input type="number" min="0" value={value} onChange={(event) => onChange(event.target.value)} /></label>
}
function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function formatWeight(weight: number, unit: string) { return `${Math.round((weight + Number.EPSILON) * 100) / 100} ${unit}` }
function formatVolume(volumeMm3: number) { return `${(volumeMm3 / 1_000_000_000).toFixed(3)} м³` }
function palletFillPercentage(placements: { size: [number, number, number] }[], pallet: Pallet) {
  const palletVolume = pallet.length * pallet.width * pallet.maxHeight
  const boxesVolume = placements.reduce((total, placement) => total + placement.size[0] * placement.size[1] * placement.size[2], 0)
  return palletVolume > 0 ? Math.min(100, Math.round(boxesVolume / palletVolume * 100)) : 0
}

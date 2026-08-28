import { useMemo, useState } from 'react'
import { calculatePallet } from './calculator'
import { PalletScene } from './PalletScene'
import type { BoxType, Pallet } from './types'

const initialPallet: Pallet = { length: 1200, width: 800, maxHeight: 1600 }
const initialBoxes: BoxType[] = [
  { id: crypto.randomUUID(), name: 'Коробка A', length: 400, width: 300, height: 250, quantity: 24, weight: 12, allowHorizontalRotation: true },
  { id: crypto.randomUUID(), name: 'Коробка B', length: 300, width: 200, height: 180, quantity: 30, weight: 7, allowHorizontalRotation: true },
]
const toNumber = (value: string) => Math.max(0, Number(value) || 0)

export default function App() {
  const [pallet, setPallet] = useState(initialPallet)
  const [boxes, setBoxes] = useState(initialBoxes)
  const [selectedPallet, setSelectedPallet] = useState(0)
  const calculation = useMemo(() => calculatePallet(pallet, boxes), [pallet, boxes])
  const allPlaced = calculation.results.every((result) => result.remaining === 0)
  const activePallet = calculation.pallets[Math.min(selectedPallet, calculation.pallets.length - 1)] ?? { placements: [], usedHeight: 0, totalWeight: 0 }

  const updatePallet = (key: keyof Pallet, value: string) => setPallet((current) => ({ ...current, [key]: toNumber(value) }))
  const updateBox = (id: string, key: keyof BoxType, value: string | boolean) => setBoxes((items) => items.map((box) => box.id === id ? { ...box, [key]: typeof value === 'string' && key !== 'name' ? toNumber(value) : value } : box))
  const addBox = () => setBoxes((items) => [...items, { id: crypto.randomUUID(), name: `Коробка ${String.fromCharCode(65 + items.length)}`, length: 300, width: 200, height: 200, quantity: 1, weight: 0, allowHorizontalRotation: true }])

  return <main>
    <header><div><p className="eyebrow">MVP</p><h1>Калькулятор палетизації</h1><p>Вкажіть габарити, а ми покажемо базову схему укладки.</p></div><span className={allPlaced ? 'status good' : 'status'}>{allPlaced ? `Розкладено на палетах: ${calculation.pallets.length}` : 'Частина коробок не вмістилась'}</span></header>
    <div className="layout">
      <section className="controls">
        <h2>Палета</h2><div className="field-grid">
          <Field label="Довжина, мм" value={pallet.length} onChange={(value) => updatePallet('length', value)} />
          <Field label="Ширина, мм" value={pallet.width} onChange={(value) => updatePallet('width', value)} />
          <Field label="Макс. висота вантажу, мм" value={pallet.maxHeight} onChange={(value) => updatePallet('maxHeight', value)} />
        </div>
        <div className="section-heading"><h2>Типи коробок</h2><button className="secondary" onClick={addBox}>+ Додати</button></div>
        <div className="box-list">{boxes.map((box, index) => <article className="box-card" key={box.id}>
          <div className="card-title"><input aria-label="Назва коробки" value={box.name} onChange={(event) => updateBox(box.id, 'name', event.target.value)} />{boxes.length > 1 && <button className="remove" aria-label="Видалити коробку" onClick={() => setBoxes((items) => items.filter((item) => item.id !== box.id))}>×</button>}</div>
          <div className="field-grid compact">
            <Field label="Д, мм" value={box.length} onChange={(value) => updateBox(box.id, 'length', value)} />
            <Field label="Ш, мм" value={box.width} onChange={(value) => updateBox(box.id, 'width', value)} />
            <Field label="В, мм" value={box.height} onChange={(value) => updateBox(box.id, 'height', value)} />
            <Field label="Кількість" value={box.quantity} onChange={(value) => updateBox(box.id, 'quantity', value)} />
            <Field label="Вага, кг" value={box.weight} onChange={(value) => updateBox(box.id, 'weight', value)} />
          </div>
          <label className="check"><input type="checkbox" checked={box.allowHorizontalRotation} onChange={(event) => updateBox(box.id, 'allowHorizontalRotation', event.target.checked)} /> Дозволити горизонтальний поворот</label>
          <small>Тип {index + 1}</small>
        </article>)}</div>
      </section>
      <section className="result"><div className="result-head"><div><p className="eyebrow">3D-схема</p><h2>Укладка на палеті</h2></div><p>Перетягуйте, щоб повернути модель</p></div>
        {calculation.pallets.length > 1 && <div className="pallet-tabs" aria-label="Вибір палети">{calculation.pallets.map((_, index) => <button key={index} className={index === Math.min(selectedPallet, calculation.pallets.length - 1) ? 'active' : ''} onClick={() => setSelectedPallet(index)}>Палета {index + 1}</button>)}</div>}
        <PalletScene pallet={pallet} boxes={boxes} placements={activePallet.placements} />
        <div className="metrics"><Metric label="Розміщено на цій палеті" value={`${activePallet.placements.length} шт.`} /><Metric label="Висота вантажу" value={`${activePallet.usedHeight} мм`} /><Metric label="Вага вантажу" value={`${activePallet.totalWeight} кг`} /></div>
        <div className="summary"><h3>Результат за типами</h3>{calculation.results.map((item) => { const box = boxes.find((candidate) => candidate.id === item.boxId); return <div className="summary-row" key={item.boxId}><span>{box?.name}</span><span>{item.placed} / {box?.quantity} шт.</span><span className={item.remaining ? 'warning' : 'success'}>{item.remaining ? `Залишок: ${item.remaining}` : 'Вмістилось'}</span><small>{item.orientation}</small></div> })}</div>
      </section>
    </div>
  </main>
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return <label className="field"><span>{label}</span><input type="number" min="0" value={value} onChange={(event) => onChange(event.target.value)} /></label>
}
function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }

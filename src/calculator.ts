import type { BoxResult, BoxType, Pallet, Placement } from './types'

export type PalletLoad = { placements: Placement[]; usedHeight: number; totalWeight: number }
export type Calculation = { pallets: PalletLoad[]; results: BoxResult[]; totalPlaced: number; totalWeight: number }

const valid = (value: number) => Number.isFinite(value) && value > 0

/**
 * MVP packing rule: box types are packed in the displayed order into complete
 * horizontal layers. Each type uses the permitted horizontal orientation with
 * the most boxes per layer. This keeps the result deterministic and layers
 * collision-free while leaving room for a future mixed-load optimiser.
 */
export function calculatePallet(pallet: Pallet, boxTypes: BoxType[]): Calculation {
  if (![pallet.length, pallet.width, pallet.maxHeight].every(valid)) {
    return { pallets: [], results: [], totalPlaced: 0, totalWeight: 0 }
  }

  const pallets: PalletLoad[] = []
  const results: BoxResult[] = []
  let current: PalletLoad = { placements: [], usedHeight: 0, totalWeight: 0 }
  let totalPlaced = 0
  let totalWeight = 0

  for (const box of boxTypes) {
    if (![box.length, box.width, box.height, box.quantity].every(valid)) continue
    const options = [{ length: box.length, width: box.width }]
    if (box.allowHorizontalRotation && box.length !== box.width) options.push({ length: box.width, width: box.length })
    const chosen = options.reduce<{ length: number; width: number; capacity: number }>((best, option) => {
      const capacity = Math.floor(pallet.length / option.length) * Math.floor(pallet.width / option.width)
      return capacity > best.capacity ? { ...option, capacity } : best
    }, { ...options[0], capacity: 0 })

    let placed = 0
    while (placed < box.quantity && chosen.capacity > 0) {
      if (current.usedHeight + box.height > pallet.maxHeight) {
        // A box taller than the allowed load cannot be placed even on an empty pallet.
        if (current.placements.length === 0) break
        pallets.push(current)
        current = { placements: [], usedHeight: 0, totalWeight: 0 }
        continue
      }
      const inLayer = Math.min(chosen.capacity, box.quantity - placed)
      for (let index = 0; index < inLayer; index += 1) {
        const column = index % Math.floor(pallet.length / chosen.length)
        const row = Math.floor(index / Math.floor(pallet.length / chosen.length))
        current.placements.push({
          boxId: box.id,
          position: [column * chosen.length + chosen.length / 2, current.usedHeight + box.height / 2, row * chosen.width + chosen.width / 2],
          size: [chosen.length, box.height, chosen.width],
        })
      }
      placed += inLayer
      current.usedHeight += box.height
      current.totalWeight += inLayer * Math.max(0, box.weight || 0)
    }
    totalPlaced += placed
    totalWeight += placed * Math.max(0, box.weight || 0)
    results.push({ boxId: box.id, placed, remaining: Math.max(0, box.quantity - placed), orientation: `${chosen.length} × ${chosen.width} мм` })
  }
  if (current.placements.length > 0) pallets.push(current)
  return { pallets, results, totalPlaced, totalWeight }
}

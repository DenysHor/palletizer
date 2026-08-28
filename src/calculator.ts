import type { BoxResult, BoxType, Pallet, Placement } from './types'

export type Calculation = { placements: Placement[]; results: BoxResult[]; usedHeight: number; totalWeight: number }

const valid = (value: number) => Number.isFinite(value) && value > 0

/**
 * MVP packing rule: box types are packed in the displayed order into complete
 * horizontal layers. Each type uses the permitted horizontal orientation with
 * the most boxes per layer. This keeps the result deterministic and layers
 * collision-free while leaving room for a future mixed-load optimiser.
 */
export function calculatePallet(pallet: Pallet, boxTypes: BoxType[]): Calculation {
  if (![pallet.length, pallet.width, pallet.maxHeight].every(valid)) {
    return { placements: [], results: [], usedHeight: 0, totalWeight: 0 }
  }

  const placements: Placement[] = []
  const results: BoxResult[] = []
  let z = 0
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
    while (z + box.height <= pallet.maxHeight && placed < box.quantity && chosen.capacity > 0) {
      const inLayer = Math.min(chosen.capacity, box.quantity - placed)
      for (let index = 0; index < inLayer; index += 1) {
        const column = index % Math.floor(pallet.length / chosen.length)
        const row = Math.floor(index / Math.floor(pallet.length / chosen.length))
        placements.push({
          boxId: box.id,
          position: [column * chosen.length + chosen.length / 2, z + box.height / 2, row * chosen.width + chosen.width / 2],
          size: [chosen.length, box.height, chosen.width],
        })
      }
      placed += inLayer
      z += box.height
    }
    totalWeight += placed * Math.max(0, box.weight || 0)
    results.push({ boxId: box.id, placed, remaining: Math.max(0, box.quantity - placed), orientation: `${chosen.length} × ${chosen.width} мм` })
  }
  return { placements, results, usedHeight: z, totalWeight }
}

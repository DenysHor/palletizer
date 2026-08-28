import type { BoxResult, BoxType, Pallet, Placement } from './types'

const MAX_OVERHANG = 100
const EPSILON = 0.001

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }
type Orientation = { length: number; width: number; height: number }

export type PalletLoad = { placements: Placement[]; layers: Placement[][]; usedHeight: number; totalWeight: number }
export type Calculation = { pallets: PalletLoad[]; results: BoxResult[]; totalPlaced: number; totalWeight: number }

const valid = (value: number) => Number.isFinite(value) && value > 0
const emptyLoad = (): PalletLoad => ({ placements: [], layers: [], usedHeight: 0, totalWeight: 0 })

function footprint(placement: Placement): Bounds {
  const [x, , z] = placement.position
  const [length, , width] = placement.size
  return { minX: x - length / 2, maxX: x + length / 2, minZ: z - width / 2, maxZ: z + width / 2 }
}

function boundsOf(placements: Placement[]): Bounds {
  return placements.reduce<Bounds>((bounds, placement) => {
    const item = footprint(placement)
    return { minX: Math.min(bounds.minX, item.minX), maxX: Math.max(bounds.maxX, item.maxX), minZ: Math.min(bounds.minZ, item.minZ), maxZ: Math.max(bounds.maxZ, item.maxZ) }
  }, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity })
}

/** Returns true only when the whole requested area is covered by the layer below. */
function hasFullSupport(target: Bounds, supports: Placement[]): boolean {
  const intersections = supports.map(footprint).map((item) => ({
    minX: Math.max(target.minX, item.minX), maxX: Math.min(target.maxX, item.maxX), minZ: Math.max(target.minZ, item.minZ), maxZ: Math.min(target.maxZ, item.maxZ),
  })).filter((item) => item.minX < item.maxX - EPSILON && item.minZ < item.maxZ - EPSILON)
  const xStops = [...new Set([target.minX, target.maxX, ...intersections.flatMap((item) => [item.minX, item.maxX])])].sort((a, b) => a - b)
  for (let index = 0; index < xStops.length - 1; index += 1) {
    const minX = xStops[index]
    const maxX = xStops[index + 1]
    if (maxX - minX <= EPSILON) continue
    const intervals = intersections.filter((item) => item.minX <= minX + EPSILON && item.maxX >= maxX - EPSILON)
      .map((item) => [item.minZ, item.maxZ] as const).sort((a, b) => a[0] - b[0])
    let coveredUntil = target.minZ
    for (const [start, end] of intervals) {
      if (start > coveredUntil + EPSILON) break
      coveredUntil = Math.max(coveredUntil, end)
      if (coveredUntil >= target.maxZ - EPSILON) break
    }
    if (coveredUntil < target.maxZ - EPSILON) return false
  }
  return true
}

function boundsForNextLayer(pallet: Pallet, supports: Placement[]): Bounds {
  if (supports.length === 0) return { minX: 0, maxX: pallet.length, minZ: 0, maxZ: pallet.width }
  const support = boundsOf(supports)
  return {
    minX: Math.max(0, support.minX - MAX_OVERHANG), maxX: Math.min(pallet.length, support.maxX + MAX_OVERHANG),
    minZ: Math.max(0, support.minZ - MAX_OVERHANG), maxZ: Math.min(pallet.width, support.maxZ + MAX_OVERHANG),
  }
}

/**
 * The upper box may project no more than 100 mm beyond the outer edge of the
 * layer below, but its part above that layer's footprint must be fully held.
 */
function isSupportedWithAllowedOverhang(target: Bounds, supports: Placement[]): boolean {
  const support = boundsOf(supports)
  if (target.minX < support.minX - MAX_OVERHANG - EPSILON || target.maxX > support.maxX + MAX_OVERHANG + EPSILON || target.minZ < support.minZ - MAX_OVERHANG - EPSILON || target.maxZ > support.maxZ + MAX_OVERHANG + EPSILON) return false
  const heldPart = {
    minX: Math.max(target.minX, support.minX), maxX: Math.min(target.maxX, support.maxX),
    minZ: Math.max(target.minZ, support.minZ), maxZ: Math.min(target.maxZ, support.maxZ),
  }
  return heldPart.minX < heldPart.maxX - EPSILON && heldPart.minZ < heldPart.maxZ - EPSILON && hasFullSupport(heldPart, supports)
}

function orientations(box: BoxType): Orientation[] {
  if (!box.allowHorizontalRotation) return [{ length: box.length, width: box.width, height: box.height }]
  const values = [box.length, box.width, box.height]
  const options: Orientation[] = []
  for (const [lengthIndex, widthIndex, heightIndex] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const length = values[lengthIndex]
    const width = values[widthIndex]
    const height = values[heightIndex]
    if (!options.some((option) => option.length === length && option.width === width && option.height === height)) options.push({ length, width, height })
  }
  return options
}

function layerPositions(bounds: Bounds, orientation: Orientation, y: number, supports: Placement[]): Placement[] {
  const columns = Math.floor((bounds.maxX - bounds.minX) / orientation.length)
  const rows = Math.floor((bounds.maxZ - bounds.minZ) / orientation.width)
  if (!columns || !rows) return []
  const startX = bounds.minX + ((bounds.maxX - bounds.minX) - columns * orientation.length) / 2
  const startZ = bounds.minZ + ((bounds.maxZ - bounds.minZ) - rows * orientation.width) / 2
  const positions: Placement[] = []
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const placement: Placement = { boxId: '', position: [startX + column * orientation.length + orientation.length / 2, y, startZ + row * orientation.width + orientation.width / 2], size: [orientation.length, 0, orientation.width] }
    if (supports.length === 0 || isSupportedWithAllowedOverhang(footprint(placement), supports)) positions.push(placement)
  }
  return positions
}

type Candidate = { box: BoxType; orientation: Orientation; positions: Placement[]; score: number }

function chooseLayer(pallet: Pallet, boxes: BoxType[], placedById: Map<string, number>, load: PalletLoad): Candidate | undefined {
  const supports = load.layers.at(-1) ?? []
  const bounds = boundsForNextLayer(pallet, supports)
  const supportArea = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ)
  let best: Candidate | undefined

  for (const box of boxes) {
    const remaining = box.quantity - (placedById.get(box.id) ?? 0)
    if (![box.length, box.width, box.height, remaining].every(valid)) continue
    for (const orientation of orientations(box)) {
      if (load.usedHeight + orientation.height > pallet.maxHeight) continue
      const cells = layerPositions(bounds, orientation, load.usedHeight + orientation.height / 2, supports)
      const positions = cells.slice(0, remaining).map((item) => ({ ...item, boxId: box.id, size: [orientation.length, orientation.height, orientation.width] as [number, number, number] }))
      if (!positions.length) continue
      const score = positions.length * orientation.length * orientation.width / supportArea
      if (!best || score > best.score + EPSILON || (Math.abs(score - best.score) <= EPSILON && orientation.height < best.orientation.height)) best = { box, orientation, positions, score }
    }
  }
  return best
}

/**
 * Greedy, bottom-up palletisation. For every next layer it picks the remaining
 * box type and allowed orientation that covers the largest share of the
 * currently supported surface. Boxes never extend beyond the pallet. An upper
 * layer may project up to 100 mm over the lower layer only where the remaining
 * part of the box is fully supported.
 */
export function calculatePallet(pallet: Pallet, boxTypes: BoxType[]): Calculation {
  if (![pallet.length, pallet.width, pallet.maxHeight].every(valid)) return { pallets: [], results: [], totalPlaced: 0, totalWeight: 0 }

  const placedById = new Map(boxTypes.map((box) => [box.id, 0]))
  const pallets: PalletLoad[] = []
  const orientationsByBox = new Map(boxTypes.map((box) => [box.id, new Set<string>()]))
  let current = emptyLoad()
  let totalPlaced = 0
  let totalWeight = 0

  while (true) {
    const candidate = chooseLayer(pallet, boxTypes, placedById, current)
    if (candidate) {
      current.layers.push(candidate.positions)
      current.placements.push(...candidate.positions)
      current.usedHeight += candidate.orientation.height
      current.totalWeight += candidate.positions.length * Math.max(0, candidate.box.weight || 0)
      placedById.set(candidate.box.id, (placedById.get(candidate.box.id) ?? 0) + candidate.positions.length)
      orientationsByBox.get(candidate.box.id)?.add(`${candidate.orientation.length} × ${candidate.orientation.width} × ${candidate.orientation.height} мм`)
      totalPlaced += candidate.positions.length
      totalWeight += candidate.positions.length * Math.max(0, candidate.box.weight || 0)
      continue
    }
    if (current.placements.length > 0) {
      pallets.push(current)
      current = emptyLoad()
      continue
    }
    break
  }

  const results: BoxResult[] = boxTypes.filter((box) => [box.length, box.width, box.height, box.quantity].every(valid)).map((box) => {
    const placed = placedById.get(box.id) ?? 0
    const usedOrientations = [...(orientationsByBox.get(box.id) ?? [])]
    return { boxId: box.id, placed, remaining: Math.max(0, box.quantity - placed), orientation: usedOrientations.length === 1 ? usedOrientations[0] : usedOrientations.length > 1 ? 'Кілька орієнтацій' : 'Не розміщено' }
  })
  return { pallets, results, totalPlaced, totalWeight }
}

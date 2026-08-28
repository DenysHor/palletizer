import type { BoxResult, BoxType, Pallet, Placement } from './types'

const MAX_OVERHANG = 100
const EPSILON = 0.001
const MAX_EXTREME_POINTS = 800
const MAX_POINTS_PER_LEVEL = 80
const MAX_PLACEMENTS_PER_PALLET = 2_000
const TARGET_FILL = 0.8

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }
type Point = { x: number; y: number; z: number }
type Orientation = { length: number; width: number; height: number }
type Strategy = 'surface' | 'volume' | 'height' | 'stack' | 'hard'

type PackedPlacement = { box: BoxType; placement: Placement; origin: Point }
type Candidate = { box: BoxType; placement: Placement; origin: Point; score: number }

export type PalletLoad = { placements: Placement[]; layers: Placement[][]; usedHeight: number; totalWeight: number }
export type Calculation = { pallets: PalletLoad[]; results: BoxResult[]; totalPlaced: number; totalWeight: number }

const valid = (value: number) => Number.isFinite(value) && value > 0
const volumeOf = (placement: Placement) => placement.size[0] * placement.size[1] * placement.size[2]

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

/** The part of the box above the supporting plane must be held continuously. */
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

function isSupported(target: Placement, bottom: number, placed: PackedPlacement[]): boolean {
  if (bottom <= EPSILON) return true
  const supports = placed.filter((item) => Math.abs(item.origin.y + item.placement.size[1] - bottom) <= EPSILON).map((item) => item.placement)
  if (!supports.length) return false
  const support = boundsOf(supports)
  const base = footprint(target)
  if (base.minX < support.minX - MAX_OVERHANG - EPSILON || base.maxX > support.maxX + MAX_OVERHANG + EPSILON || base.minZ < support.minZ - MAX_OVERHANG - EPSILON || base.maxZ > support.maxZ + MAX_OVERHANG + EPSILON) return false
  const heldPart = {
    minX: Math.max(base.minX, support.minX), maxX: Math.min(base.maxX, support.maxX), minZ: Math.max(base.minZ, support.minZ), maxZ: Math.min(base.maxZ, support.maxZ),
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

function packingDifficulty(pallet: Pallet, box: BoxType) {
  const minimumHeight = Math.min(...orientations(box).filter((orientation) => orientation.length <= pallet.length + EPSILON && orientation.width <= pallet.width + EPSILON && orientation.height <= pallet.maxHeight + EPSILON).map((orientation) => orientation.height))
  return Number.isFinite(minimumHeight) ? minimumHeight / pallet.maxHeight : 1
}

function overlaps(a: Placement, b: Placement): boolean {
  const [aX, aY, aZ] = a.position
  const [aLength, aHeight, aWidth] = a.size
  const [bX, bY, bZ] = b.position
  const [bLength, bHeight, bWidth] = b.size
  return Math.abs(aX - bX) < (aLength + bLength) / 2 - EPSILON
    && Math.abs(aY - bY) < (aHeight + bHeight) / 2 - EPSILON
    && Math.abs(aZ - bZ) < (aWidth + bWidth) / 2 - EPSILON
}

function placementAt(origin: Point, orientation: Orientation, boxId: string): Placement {
  return {
    boxId,
    position: [origin.x + orientation.length / 2, origin.y + orientation.height / 2, origin.z + orientation.width / 2],
    size: [orientation.length, orientation.height, orientation.width],
  }
}

function addExtremePoints(points: Point[], origin: Point, placement: Placement, placed: PackedPlacement[], pallet: Pallet) {
  const [length, height, width] = placement.size
  return prunePoints([
    ...points,
    { x: origin.x + length, y: origin.y, z: origin.z },
    { x: origin.x, y: origin.y + height, z: origin.z },
    { x: origin.x, y: origin.y, z: origin.z + width },
    { x: origin.x + length, y: origin.y, z: origin.z + width },
    { x: origin.x + length, y: origin.y + height, z: origin.z },
    { x: origin.x, y: origin.y + height, z: origin.z + width },
  ], placed, pallet)
}

function fits(pallet: Pallet, placement: Placement, origin: Point, placed: PackedPlacement[]): boolean {
  const [length, height, width] = placement.size
  if (origin.x < -EPSILON || origin.y < -EPSILON || origin.z < -EPSILON || origin.x + length > pallet.length + EPSILON || origin.y + height > pallet.maxHeight + EPSILON || origin.z + width > pallet.width + EPSILON) return false
  if (placed.some((item) => overlaps(placement, item.placement))) return false
  return isSupported(placement, origin.y, placed)
}

function pointKey(point: Point) { return `${point.x}|${point.y}|${point.z}` }

function prunePoints(points: Point[], placed: PackedPlacement[], pallet: Pallet): Point[] {
  const unique = new Map<string, Point>()
  for (const point of points) {
    if (point.x < -EPSILON || point.y < -EPSILON || point.z < -EPSILON || point.x > pallet.length + EPSILON || point.y > pallet.maxHeight + EPSILON || point.z > pallet.width + EPSILON) continue
    const isInsideBox = placed.some(({ origin, placement }) => point.x > origin.x + EPSILON && point.x < origin.x + placement.size[0] - EPSILON && point.y > origin.y + EPSILON && point.y < origin.y + placement.size[1] - EPSILON && point.z > origin.z + EPSILON && point.z < origin.z + placement.size[2] - EPSILON)
    if (!isInsideBox) unique.set(pointKey(point), point)
  }
  const perLevel = new Map<number, number>()
  return [...unique.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x).filter((point) => {
    const count = perLevel.get(point.y) ?? 0
    if (count >= MAX_POINTS_PER_LEVEL) return false
    perLevel.set(point.y, count + 1)
    return true
  }).slice(0, MAX_EXTREME_POINTS)
}

function scoreCandidate(candidate: Candidate, pallet: Pallet, strategy: Strategy, difficultyById: Map<string, number>): number {
  const [length, height, width] = candidate.placement.size
  const baseArea = length * width
  const volume = length * height * width
  const footprintRatio = baseArea / (pallet.length * pallet.width)
  if (strategy === 'surface') return baseArea * 10_000 + volume
  if (strategy === 'height') return height * 1_000_000 + baseArea * 1_000 + volume
  if (strategy === 'stack') return (candidate.origin.y + height) * 1_000_000 + baseArea * 1_000 + volume
  if (strategy === 'hard') return (difficultyById.get(candidate.box.id) ?? 0) * 1_000_000_000 + volume
  return volume + footprintRatio * volume
}

function chooseCandidate(pallet: Pallet, boxes: BoxType[], remaining: Map<string, number>, placed: PackedPlacement[], points: Point[], strategy: Strategy, difficultyById: Map<string, number>): Candidate | undefined {
  let best: Candidate | undefined
  let level = points[0]?.y
  for (const origin of points) {
    if (strategy !== 'stack' && level !== undefined && origin.y > level + EPSILON && best) return best
    if (level !== undefined && origin.y > level + EPSILON) level = origin.y
    for (const box of boxes) {
      if ((remaining.get(box.id) ?? 0) <= 0 || ![box.length, box.width, box.height].every(valid)) continue
      for (const orientation of orientations(box)) {
        const placement = placementAt(origin, orientation, box.id)
        if (!fits(pallet, placement, origin, placed)) continue
        const candidate = { box, placement, origin, score: scoreCandidate({ box, placement, origin, score: 0 }, pallet, strategy, difficultyById) }
        if (!best || candidate.score > best.score + EPSILON || (Math.abs(candidate.score - best.score) <= EPSILON && (origin.z < best.origin.z - EPSILON || (Math.abs(origin.z - best.origin.z) <= EPSILON && origin.x < best.origin.x - EPSILON)))) best = candidate
      }
    }
  }
  return best
}

function loadFromPacked(placed: PackedPlacement[]): PalletLoad {
  const placements = placed.map((item) => item.placement)
  const levels = new Map<number, Placement[]>()
  for (const item of placed) levels.set(item.origin.y, [...(levels.get(item.origin.y) ?? []), item.placement])
  return {
    placements,
    layers: [...levels.entries()].sort(([a], [b]) => a - b).map(([, layer]) => layer),
    usedHeight: placed.reduce((height, item) => Math.max(height, item.origin.y + item.placement.size[1]), 0),
    totalWeight: placed.reduce((weight, item) => weight + Math.max(0, item.box.weight || 0), 0),
  }
}

/**
 * Mixed 3D packing with extreme points. Every placement is evaluated against
 * every still-available box type and each allowed orientation. The algorithm
 * uses several packing strategies and keeps the fullest result for a pallet.
 */
function buildPallet(pallet: Pallet, boxes: BoxType[], available: Map<string, number>, strategy: Strategy, targetVolume?: number, seed: PackedPlacement[] = []): PalletLoad {
  const remaining = new Map(available)
  const difficultyById = new Map(boxes.map((box) => [box.id, packingDifficulty(pallet, box)]))
  const placed: PackedPlacement[] = seed.map((item) => ({ ...item, placement: { ...item.placement, position: [...item.placement.position], size: [...item.placement.size] } as Placement, origin: { ...item.origin } }))
  for (const item of placed) remaining.set(item.box.id, (remaining.get(item.box.id) ?? 0) - 1)
  let points: Point[] = [{ x: 0, y: 0, z: 0 }]
  for (const item of placed) points = addExtremePoints(points, item.origin, item.placement, placed, pallet)
  let packedVolume = placed.reduce((total, item) => total + volumeOf(item.placement), 0)
  while (placed.length < MAX_PLACEMENTS_PER_PALLET) {
    if (targetVolume !== undefined && packedVolume >= targetVolume - EPSILON) break
    const candidate = chooseCandidate(pallet, boxes, remaining, placed, points, strategy, difficultyById)
    if (!candidate) break
    placed.push({ box: candidate.box, placement: candidate.placement, origin: candidate.origin })
    packedVolume += volumeOf(candidate.placement)
    remaining.set(candidate.box.id, (remaining.get(candidate.box.id) ?? 0) - 1)
    points = addExtremePoints(points, candidate.origin, candidate.placement, placed, pallet)
  }
  return loadFromPacked(placed)
}

function loadVolume(load: PalletLoad) { return load.placements.reduce((total, placement) => total + volumeOf(placement), 0) }
function loadFill(load: PalletLoad, pallet: Pallet) { return loadVolume(load) / (pallet.length * pallet.width * pallet.maxHeight) }

function loadDifficulty(load: PalletLoad, pallet: Pallet, boxes: BoxType[]) {
  const byId = new Map(boxes.map((box) => [box.id, box]))
  return load.placements.reduce((total, placement) => total + volumeOf(placement) * packingDifficulty(pallet, byId.get(placement.boxId)!), 0)
}

function deckSeeds(pallet: Pallet, boxes: BoxType[], available: Map<string, number>): PackedPlacement[][] {
  const representatives = new Map<string, BoxType>()
  for (const box of boxes) {
    const key = [box.length, box.width, box.height].sort((a, b) => a - b).join('|')
    const current = representatives.get(key)
    if (!current || (available.get(box.id) ?? 0) > (available.get(current.id) ?? 0)) representatives.set(key, box)
  }
  return [...representatives.values()].flatMap((box) => orientations(box).filter((orientation) => orientation.length <= pallet.length && orientation.width <= pallet.width && orientation.height <= pallet.maxHeight && orientation.height >= pallet.maxHeight * 0.4).map((orientation) => ({ box, orientation })))
    .map(({ box, orientation }) => {
      const columns = Math.floor(pallet.length / orientation.length)
      const rows = Math.floor(pallet.width / orientation.width)
      const quantity = Math.min(available.get(box.id) ?? 0, columns * rows)
      const seed: PackedPlacement[] = []
      for (let index = 0; index < quantity; index += 1) {
        const origin = { x: index % columns * orientation.length, y: 0, z: Math.floor(index / columns) * orientation.width }
        seed.push({ box, origin, placement: placementAt(origin, orientation, box.id) })
      }
      return { seed, score: quantity * orientation.length * orientation.width * orientation.height }
    }).sort((a, b) => b.score - a.score).slice(0, 8).map(({ seed }) => seed)
}

function bestPallet(pallet: Pallet, boxes: BoxType[], available: Map<string, number>, targetVolume?: number): PalletLoad {
  const attempts = (['surface', 'volume', 'height', 'stack', 'hard'] as const).map((strategy) => buildPallet(pallet, boxes, available, strategy, targetVolume))
  if (targetVolume !== undefined) attempts.push(...deckSeeds(pallet, boxes, available).map((seed) => buildPallet(pallet, boxes, available, 'surface', targetVolume, seed)))
  const meetingTarget = targetVolume === undefined ? [] : attempts.filter((load) => loadVolume(load) >= targetVolume - EPSILON)
  const candidates = meetingTarget.length ? meetingTarget : attempts
  return candidates.reduce((best, load) => {
    if (meetingTarget.length) {
      return loadDifficulty(load, pallet, boxes) > loadDifficulty(best, pallet, boxes) + EPSILON || (Math.abs(loadDifficulty(load, pallet, boxes) - loadDifficulty(best, pallet, boxes)) <= EPSILON && loadVolume(load) < loadVolume(best) - EPSILON) ? load : best
    }
    return loadVolume(load) > loadVolume(best) + EPSILON || (Math.abs(loadVolume(load) - loadVolume(best)) <= EPSILON && load.placements.length > best.placements.length) ? load : best
  })
}

function placedCounts(load: PalletLoad): Map<string, number> {
  return load.placements.reduce((counts, placement) => counts.set(placement.boxId, (counts.get(placement.boxId) ?? 0) + 1), new Map<string, number>())
}

function sortLoads(loads: PalletLoad[], pallet: Pallet): PalletLoad[] {
  return [...loads].sort((a, b) => loadFill(b, pallet) - loadFill(a, pallet))
}

function remainingVolume(boxes: BoxType[], remaining: Map<string, number>) {
  return boxes.reduce((total, box) => total + box.length * box.width * box.height * (remaining.get(box.id) ?? 0), 0)
}

export function calculatePallet(pallet: Pallet, boxTypes: BoxType[]): Calculation {
  if (![pallet.length, pallet.width, pallet.maxHeight].every(valid)) return { pallets: [], results: [], totalPlaced: 0, totalWeight: 0 }

  const validBoxes = boxTypes.filter((box) => [box.length, box.width, box.height, box.quantity].every(valid))
  const remaining = new Map(validBoxes.map((box) => [box.id, box.quantity]))
  const placedById = new Map(validBoxes.map((box) => [box.id, 0]))
  const orientationsByBox = new Map(validBoxes.map((box) => [box.id, new Set<string>()]))
  const loads: PalletLoad[] = []
  let totalPlaced = 0
  let totalWeight = 0
  const capacity = pallet.length * pallet.width * pallet.maxHeight
  const acceptLoad = (load: PalletLoad) => {
    loads.push(load)
    for (const [boxId, quantity] of placedCounts(load)) {
      remaining.set(boxId, (remaining.get(boxId) ?? 0) - quantity)
      placedById.set(boxId, (placedById.get(boxId) ?? 0) + quantity)
    }
    for (const placement of load.placements) orientationsByBox.get(placement.boxId)?.add(`${placement.size[0]} × ${placement.size[2]} × ${placement.size[1]} мм`)
    totalPlaced += load.placements.length
    totalWeight += load.totalWeight
  }

  while ([...remaining.values()].some((quantity) => quantity > 0)) {
    const volumeLeft = remainingVolume(validBoxes, remaining)
    const palletsNeeded = Math.ceil(volumeLeft / capacity)
    const targetVolume = palletsNeeded > 1 ? Math.max(capacity * TARGET_FILL, volumeLeft - (palletsNeeded - 1) * capacity) : undefined
    const load = bestPallet(pallet, validBoxes, remaining, targetVolume)
    if (!load.placements.length) break
    acceptLoad(load)
  }

  const results: BoxResult[] = validBoxes.map((box) => {
    const placed = placedById.get(box.id) ?? 0
    const usedOrientations = [...(orientationsByBox.get(box.id) ?? [])]
    return { boxId: box.id, placed, remaining: Math.max(0, box.quantity - placed), orientation: usedOrientations.length === 1 ? usedOrientations[0] : usedOrientations.length > 1 ? 'Кілька орієнтацій' : 'Не розміщено' }
  })
  return { pallets: sortLoads(loads, pallet), results, totalPlaced, totalWeight }
}

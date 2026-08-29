import type { BoxResult, BoxType, Pallet, Placement } from './types'

const MAX_OVERHANG = 100
const EPSILON = 0.001
const MAX_EXTREME_POINTS = 800
const MAX_POINTS_PER_LEVEL = 80
const MAX_PLACEMENTS_PER_PALLET = 2_000
const TARGET_FILL = 0.9
const GLOBAL_BEAM_WIDTH = 2
const LOAD_OPTIONS_PER_STATE = 2

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }
type Point = { x: number; y: number; z: number }
type Orientation = { length: number; width: number; height: number }
type Strategy = 'surface' | 'volume' | 'height' | 'stack' | 'hard'

type PackedPlacement = { box: BoxType; placement: Placement; origin: Point }
type Candidate = { box: BoxType; placement: Placement; origin: Point; score: number }

export type PalletLoad = { placements: Placement[]; layers: Placement[][]; usedHeight: number; totalWeight: number }
export type Calculation = { pallets: PalletLoad[]; results: BoxResult[]; totalPlaced: number; totalWeight: number }
type PlanState = { remaining: Map<string, number>; loads: PalletLoad[] }

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

function loadProfile(load: PalletLoad) {
  return [...placedCounts(load).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([boxId, quantity]) => `${boxId}:${quantity}`).join('|')
}

function nextRemaining(remaining: Map<string, number>, load: PalletLoad) {
  const next = new Map(remaining)
  for (const [boxId, quantity] of placedCounts(load)) next.set(boxId, Math.max(0, (next.get(boxId) ?? 0) - quantity))
  return next
}

function remainingKey(remaining: Map<string, number>, boxes: BoxType[]) {
  return boxes.map((box) => remaining.get(box.id) ?? 0).join('|')
}

function underfilledCount(loads: PalletLoad[], pallet: Pallet) {
  return sortLoads(loads, pallet).slice(0, -1).filter((load) => loadFill(load, pallet) < TARGET_FILL - EPSILON).length
}

function planScore(state: PlanState, pallet: Pallet, boxes: BoxType[]) {
  const packedFill = state.loads.reduce((total, load) => total + loadFill(load, pallet), 0)
  const difficultFill = state.loads.reduce((total, load) => total + loadDifficulty(load, pallet, boxes) / (pallet.length * pallet.width * pallet.maxHeight), 0)
  return -underfilledCount(state.loads, pallet) * 10_000 + packedFill * 100 + difficultFill
}

function chooseLoadOptions(pallet: Pallet, boxes: BoxType[], available: Map<string, number>, targetVolume?: number) {
  const attempts = (['surface', 'volume', 'height', 'stack', 'hard'] as const).map((strategy) => buildPallet(pallet, boxes, available, strategy))
  if (targetVolume !== undefined) attempts.push(...deckSeeds(pallet, boxes, available).slice(0, 2).map((seed) => buildPallet(pallet, boxes, available, 'surface', undefined, seed)))
  const unique = new Map<string, PalletLoad>()
  for (const load of attempts) {
    if (!load.placements.length) continue
    const profile = loadProfile(load)
    const existing = unique.get(profile)
    if (!existing || loadVolume(load) > loadVolume(existing) + EPSILON) unique.set(profile, load)
  }
  const loads = [...unique.values()]
  const reachingTarget = targetVolume === undefined ? loads : loads.filter((load) => loadVolume(load) >= targetVolume - EPSILON)
  const candidates = reachingTarget.length ? reachingTarget : loads
  return candidates.sort((a, b) => loadVolume(b) - loadVolume(a) || loadDifficulty(b, pallet, boxes) - loadDifficulty(a, pallet, boxes) || b.placements.length - a.placements.length).slice(0, LOAD_OPTIONS_PER_STATE)
}

function choosePlanStates(states: PlanState[], pallet: Pallet, boxes: BoxType[]) {
  const unique = new Map<string, PlanState>()
  for (const state of states) {
    const key = remainingKey(state.remaining, boxes)
    const existing = unique.get(key)
    if (!existing || planScore(state, pallet, boxes) > planScore(existing, pallet, boxes) + EPSILON) unique.set(key, state)
  }
  return [...unique.values()].sort((a, b) => planScore(b, pallet, boxes) - planScore(a, pallet, boxes)).slice(0, GLOBAL_BEAM_WIDTH)
}

function compareCompletedPlans(a: PlanState, b: PlanState, pallet: Pallet, boxes: BoxType[]) {
  if (a.loads.length !== b.loads.length) return a.loads.length - b.loads.length
  const underfilledDifference = underfilledCount(a.loads, pallet) - underfilledCount(b.loads, pallet)
  if (underfilledDifference) return underfilledDifference
  const aFill = a.loads.reduce((total, load) => total + loadFill(load, pallet), 0)
  const bFill = b.loads.reduce((total, load) => total + loadFill(load, pallet), 0)
  if (Math.abs(aFill - bFill) > EPSILON) return bFill - aFill
  return planScore(b, pallet, boxes) - planScore(a, pallet, boxes)
}

function optimiseHighTargetPlan(pallet: Pallet, boxes: BoxType[], initialRemaining: Map<string, number>) {
  const remaining = new Map(initialRemaining)
  const loads: PalletLoad[] = []
  const capacity = pallet.length * pallet.width * pallet.maxHeight
  while ([...remaining.values()].some((quantity) => quantity > 0)) {
    const volumeLeft = remainingVolume(boxes, remaining)
    const palletsNeeded = Math.ceil(volumeLeft / capacity)
    const targetVolume = palletsNeeded > 1 ? Math.max(capacity * TARGET_FILL, volumeLeft - (palletsNeeded - 1) * capacity) : undefined
    const load = bestPallet(pallet, boxes, remaining, targetVolume)
    if (!load.placements.length) break
    loads.push(load)
    for (const [boxId, quantity] of placedCounts(load)) remaining.set(boxId, Math.max(0, (remaining.get(boxId) ?? 0) - quantity))
  }
  return { loads, remaining }
}

function compareOrderPlans(a: { loads: PalletLoad[]; remaining: Map<string, number> }, b: { loads: PalletLoad[]; remaining: Map<string, number> }, pallet: Pallet, boxes: BoxType[]) {
  const aUnplaced = remainingVolume(boxes, a.remaining)
  const bUnplaced = remainingVolume(boxes, b.remaining)
  if (Math.abs(aUnplaced - bUnplaced) > EPSILON) return aUnplaced - bUnplaced
  if (a.loads.length !== b.loads.length) return a.loads.length - b.loads.length
  const underfilledDifference = underfilledCount(a.loads, pallet) - underfilledCount(b.loads, pallet)
  if (underfilledDifference) return underfilledDifference
  const aFill = a.loads.reduce((total, load) => total + loadFill(load, pallet), 0)
  const bFill = b.loads.reduce((total, load) => total + loadFill(load, pallet), 0)
  return bFill - aFill
}

/**
 * Searches several complete order plans at once instead of committing to the
 * first locally good pallet. Candidate plans are compared by pallet count,
 * the number of sub-target pallets (except the final pallet), and total fill.
 */
function optimiseWholeOrder(pallet: Pallet, boxes: BoxType[], initialRemaining: Map<string, number>) {
  const capacity = pallet.length * pallet.width * pallet.maxHeight
  const maximumPallets = boxes.reduce((total, box) => total + Math.max(0, initialRemaining.get(box.id) ?? 0), 0)
  let frontier: PlanState[] = [{ remaining: new Map(initialRemaining), loads: [] }]
  let bestPartial = frontier[0]

  for (let step = 0; step < maximumPallets && frontier.length; step += 1) {
    const next: PlanState[] = []
    const completed: PlanState[] = []
    for (const state of frontier) {
      const volumeLeft = remainingVolume(boxes, state.remaining)
      const palletsNeeded = Math.ceil(volumeLeft / capacity)
      const targetVolume = palletsNeeded > 1 ? Math.max(capacity * TARGET_FILL, volumeLeft - (palletsNeeded - 1) * capacity) : undefined
      for (const load of chooseLoadOptions(pallet, boxes, state.remaining, targetVolume)) {
        const candidate = { remaining: nextRemaining(state.remaining, load), loads: [...state.loads, load] }
        if ([...candidate.remaining.values()].every((quantity) => quantity <= 0)) completed.push(candidate)
        else next.push(candidate)
      }
    }
    if (completed.length) return completed.sort((a, b) => compareCompletedPlans(a, b, pallet, boxes))[0].loads
    if (!next.length) break
    frontier = choosePlanStates(next, pallet, boxes)
    if (planScore(frontier[0], pallet, boxes) > planScore(bestPartial, pallet, boxes) + EPSILON) bestPartial = frontier[0]
  }
  return bestPartial.loads
}

function optimiseOrder(pallet: Pallet, boxes: BoxType[], initialRemaining: Map<string, number>) {
  const globalLoads = optimiseWholeOrder(pallet, boxes, initialRemaining)
  const globalRemaining = new Map(initialRemaining)
  for (const load of globalLoads) for (const [boxId, quantity] of placedCounts(load)) globalRemaining.set(boxId, Math.max(0, (globalRemaining.get(boxId) ?? 0) - quantity))
  const globalPlan = { loads: globalLoads, remaining: globalRemaining }
  const highTargetPlan = optimiseHighTargetPlan(pallet, boxes, initialRemaining)
  return [globalPlan, highTargetPlan].sort((a, b) => compareOrderPlans(a, b, pallet, boxes))[0].loads
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

  for (const load of optimiseOrder(pallet, validBoxes, remaining)) acceptLoad(load)

  const results: BoxResult[] = validBoxes.map((box) => {
    const placed = placedById.get(box.id) ?? 0
    const usedOrientations = [...(orientationsByBox.get(box.id) ?? [])]
    return { boxId: box.id, placed, remaining: Math.max(0, box.quantity - placed), orientation: usedOrientations.length === 1 ? usedOrientations[0] : '', multipleOrientations: usedOrientations.length > 1 }
  })
  return { pallets: sortLoads(loads, pallet), results, totalPlaced, totalWeight }
}

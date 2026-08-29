export type Pallet = { length: number; width: number; maxHeight: number; weight: number }

export type BoxType = {
  id: string
  name: string
  length: number
  width: number
  height: number
  quantity: number
  weight: number
  allowHorizontalRotation: boolean
}

export type Placement = {
  boxId: string
  position: [number, number, number]
  size: [number, number, number]
}

export type BoxResult = { boxId: string; placed: number; remaining: number; orientation: string; multipleOrientations: boolean }

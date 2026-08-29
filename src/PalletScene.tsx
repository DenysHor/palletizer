import { Edges, OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { colourForIndex } from './boxColours'
import type { BoxType, Pallet, Placement } from './types'

type Props = { pallet: Pallet; boxes: BoxType[]; placements: Placement[]; highlightedBoxId?: string; onCanvasReady?: (canvas: HTMLCanvasElement) => void }

export function PalletScene({ pallet, boxes, placements, highlightedBoxId, onCanvasReady }: Props) {
  const colourFor = (id: string) => colourForIndex(boxes.findIndex((box) => box.id === id))
  const scale = 1 / Math.max(pallet.length, pallet.width, pallet.maxHeight, 1)
  return <div className="scene">
    <Canvas gl={{ preserveDrawingBuffer: true }} onCreated={({ gl }) => onCanvasReady?.(gl.domElement)} camera={{ position: [1.8, 1.55, 1.8], fov: 43 }}>
      <color attach="background" args={['#f6f8fb']} />
      <ambientLight intensity={1.3} />
      <directionalLight position={[3, 5, 4]} intensity={1.8} castShadow />
      <group scale={scale} position={[-pallet.length * scale / 2, 0, -pallet.width * scale / 2]}>
        <mesh position={[pallet.length / 2, -35, pallet.width / 2]} receiveShadow>
          <boxGeometry args={[pallet.length, 70, pallet.width]} />
          <meshStandardMaterial color="#9b6b3e" roughness={0.75} />
        </mesh>
        {placements.map((placement, index) => {
          const isHighlighted = highlightedBoxId === placement.boxId
          const isDimmed = Boolean(highlightedBoxId) && !isHighlighted
          return <mesh key={index} position={placement.position} castShadow>
          <boxGeometry args={placement.size} />
          <meshStandardMaterial color={colourFor(placement.boxId)} roughness={0.55} emissive={isHighlighted ? colourFor(placement.boxId) : '#000000'} emissiveIntensity={isHighlighted ? 0.3 : 0} transparent={isDimmed} opacity={isDimmed ? 0.18 : 1} />
          <Edges color={isHighlighted ? '#ffffff' : '#111827'} threshold={15} />
        </mesh>
        })}
      </group>
      <OrbitControls makeDefault minDistance={1.4} maxDistance={5} />
    </Canvas>
  </div>
}

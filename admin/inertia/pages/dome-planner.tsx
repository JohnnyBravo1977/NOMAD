import { Head } from '@inertiajs/react'
import { useMemo, useRef, useState } from 'react'
import AppLayout from '~/layouts/AppLayout'
import api from '~/lib/api'

type Dome = {
  id: string
  name: string
  x: number
  y: number
  diameterFt: number
  heightFt: number
  stemWallFt: number
  notes: string
}

type PlannerLineLayer = 'wall' | 'power' | 'water' | 'drain' | 'sewer' | 'ethernet'

type PlannerLine = {
  id: string
  name: string
  layer: PlannerLineLayer
  x1: number
  y1: number
  x2: number
  y2: number
  geometryMode: 'straight' | 'dome_arc'
  domeId: string
  radiusOffsetFt: number
  startAngleDeg: number
  endAngleDeg: number
  notes: string
}

type PlannerFixtureType = 'sink' | 'stove' | 'toilet' | 'fridge' | 'washer' | 'dryer' | 'light' | 'wall_plug' | 'shower'

type PlannerFixture = {
  id: string
  name: string
  type: PlannerFixtureType
  x: number
  y: number
  widthFt: number
  heightFt: number
  notes: string
}

type PlannerState = {
  version: number
  projectName: string
  units: 'feet'
  domes: Dome[]
  lines: PlannerLine[]
  fixtures: PlannerFixture[]
  updatedAt: string
}

type PlannerLogEntry = {
  id: string
  actor: string
  kind: 'plan' | 'edit' | 'review' | 'note'
  summary: string
  expectedOutcome: string
  actualOutcome: string
  correction: string
  createdAt: string
}

type GorePoint = {
  division: number
  thetaDeg: number
  arcHeightFt: number
  fullWidthFt: number
  halfWidthFt: number
}

type SelectedElement =
  | { kind: 'dome'; id: string }
  | { kind: 'line'; id: string }
  | { kind: 'fixture'; id: string }

type DragState =
  | { kind: 'dome'; id: string; startPointerX: number; startPointerY: number; originX: number; originY: number; moved: boolean }
  | { kind: 'dome-resize'; id: string }
  | { kind: 'fixture'; id: string; startPointerX: number; startPointerY: number; originX: number; originY: number; moved: boolean }
  | { kind: 'fixture-resize'; id: string }
  | { kind: 'line-start'; id: string }
  | { kind: 'line-end'; id: string }
  | { kind: 'line-body'; id: string; lastX: number; lastY: number; moved: boolean }

type ContextMenuState = {
  x: number
  y: number
  target: SelectedElement
}

const lineLayerMeta: Record<PlannerLineLayer, { label: string; stroke: string; strokeWidth: number }> = {
  wall: { label: 'Wall', stroke: '#111827', strokeWidth: 0.9 },
  power: { label: 'Power', stroke: '#dc2626', strokeWidth: 0.45 },
  water: { label: 'Water', stroke: '#2563eb', strokeWidth: 0.45 },
  drain: { label: 'Drain', stroke: '#8b5cf6', strokeWidth: 0.45 },
  sewer: { label: 'Sewer', stroke: '#92400e', strokeWidth: 0.55 },
  ethernet: { label: 'Ethernet', stroke: '#16a34a', strokeWidth: 0.45 },
}

type LayerVisibility = {
  domes: boolean
  wall: boolean
  power: boolean
  water: boolean
  drain: boolean
  sewer: boolean
  ethernet: boolean
  fixtures: boolean
}

const fixtureTypeMeta: Record<
  PlannerFixtureType,
  { label: string; shortLabel: string; widthFt: number; heightFt: number; fill: string; stroke: string }
> = {
  sink: { label: 'Sink', shortLabel: 'S', widthFt: 2.5, heightFt: 1.75, fill: 'rgba(14,165,233,0.12)', stroke: '#0369a1' },
  stove: { label: 'Stove', shortLabel: 'ST', widthFt: 2.5, heightFt: 2.5, fill: 'rgba(249,115,22,0.12)', stroke: '#c2410c' },
  toilet: { label: 'Toilet', shortLabel: 'T', widthFt: 2.25, heightFt: 3, fill: 'rgba(168,85,247,0.12)', stroke: '#7e22ce' },
  fridge: { label: 'Fridge', shortLabel: 'F', widthFt: 3, heightFt: 3, fill: 'rgba(71,85,105,0.12)', stroke: '#334155' },
  washer: { label: 'Washer', shortLabel: 'W', widthFt: 2.5, heightFt: 2.5, fill: 'rgba(59,130,246,0.12)', stroke: '#2563eb' },
  dryer: { label: 'Dryer', shortLabel: 'D', widthFt: 2.5, heightFt: 2.5, fill: 'rgba(239,68,68,0.12)', stroke: '#dc2626' },
  light: { label: 'Light', shortLabel: 'L', widthFt: 1.2, heightFt: 1.2, fill: 'rgba(250,204,21,0.16)', stroke: '#ca8a04' },
  wall_plug: { label: 'Wall Plug', shortLabel: 'P', widthFt: 0.8, heightFt: 0.8, fill: 'rgba(16,185,129,0.12)', stroke: '#047857' },
  shower: { label: 'Shower', shortLabel: 'SH', widthFt: 3, heightFt: 3, fill: 'rgba(6,182,212,0.12)', stroke: '#0e7490' },
}

const domePresetMeta = {
  dome_13_10_5: { label: '13 ft / 10.5 ft', diameterFt: 13, heightFt: 10.5, stemWallFt: 8 },
  dome_15_11_5: { label: '15 ft / 11.5 ft', diameterFt: 15, heightFt: 11.5, stemWallFt: 8 },
  dome_18_13: { label: '18 ft / 13 ft', diameterFt: 18, heightFt: 13, stemWallFt: 8 },
  dome_24_16: { label: '24 ft / 16 ft', diameterFt: 24, heightFt: 16, stemWallFt: 8 },
  dome_30_19: { label: '30 ft / 19 ft', diameterFt: 30, heightFt: 19, stemWallFt: 8 },
} as const

type DomePresetKey = keyof typeof domePresetMeta

function normalizePlannerState(state: PlannerState | (PlannerState & { lines?: PlannerLine[]; fixtures?: PlannerFixture[] })) {
  return {
    ...state,
    domes: Array.isArray(state.domes)
      ? state.domes.map((dome) => ({
          ...dome,
          stemWallFt: Number.isFinite(dome.stemWallFt) ? dome.stemWallFt : 8,
        }))
      : [],
    lines: Array.isArray(state.lines)
      ? state.lines.map((line) => ({
          ...line,
          geometryMode: line.geometryMode === 'dome_arc' ? 'dome_arc' : 'straight',
          domeId: typeof line.domeId === 'string' ? line.domeId : '',
          radiusOffsetFt: Number.isFinite(line.radiusOffsetFt) ? line.radiusOffsetFt : 0,
          startAngleDeg: Number.isFinite(line.startAngleDeg) ? line.startAngleDeg : 0,
          endAngleDeg: Number.isFinite(line.endAngleDeg) ? line.endAngleDeg : 90,
        }))
      : [],
    fixtures: Array.isArray(state.fixtures) ? state.fixtures : [],
  }
}

function formatNumber(value: number, digits = 2) {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(digits)
}

function feetToFeetInches(value: number) {
  if (!Number.isFinite(value)) return '0\' 0"'
  const sign = value < 0 ? '-' : ''
  const absolute = Math.abs(value)
  const feet = Math.floor(absolute)
  const inches = Math.round((absolute - feet) * 12 * 16) / 16
  const normalizedFeet = inches >= 12 ? feet + 1 : feet
  const normalizedInches = inches >= 12 ? 0 : inches
  return `${sign}${normalizedFeet}' ${normalizedInches.toFixed(2)}"`
}

function formatStamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getLineLength(line: Pick<PlannerLine, 'x1' | 'y1' | 'x2' | 'y2'>) {
  return Math.sqrt((line.x2 - line.x1) ** 2 + (line.y2 - line.y1) ** 2)
}

function normalizeDegrees(value: number) {
  let normalized = value % 360
  if (normalized < 0) normalized += 360
  return normalized
}

function pointOnCircle(centerX: number, centerY: number, radius: number, angleDeg: number) {
  const radians = (angleDeg * Math.PI) / 180
  return {
    x: centerX + Math.cos(radians) * radius,
    y: centerY + Math.sin(radians) * radius,
  }
}

function angleFromPoint(centerX: number, centerY: number, x: number, y: number) {
  return normalizeDegrees((Math.atan2(y - centerY, x - centerX) * 180) / Math.PI)
}

function getArcAngleDelta(startDeg: number, endDeg: number) {
  let delta = endDeg - startDeg
  while (delta > 180) delta -= 360
  while (delta < -180) delta += 360
  return delta
}

function getLineRenderData(line: PlannerLine, domes: Dome[]) {
  if (line.geometryMode === 'dome_arc') {
    const dome = domes.find((entry) => entry.id === line.domeId)
    if (dome) {
      const radius = Math.max(0.25, dome.diameterFt / 2 + line.radiusOffsetFt)
      const start = pointOnCircle(dome.x, dome.y, radius, line.startAngleDeg)
      const end = pointOnCircle(dome.x, dome.y, radius, line.endAngleDeg)
      const delta = getArcAngleDelta(line.startAngleDeg, line.endAngleDeg)
      const sweepFlag = delta >= 0 ? 1 : 0
      const largeArcFlag = Math.abs(delta) > 180 ? 1 : 0
      const path = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`
      const midAngle = line.startAngleDeg + delta / 2
      const labelPoint = pointOnCircle(dome.x, dome.y, radius, midAngle)
      return {
        kind: 'arc' as const,
        length: Math.abs((delta * Math.PI) / 180) * radius,
        start,
        end,
        mid: labelPoint,
        path,
        radius,
      }
    }
  }

  return {
    kind: 'straight' as const,
    length: getLineLength(line),
    start: { x: line.x1, y: line.y1 },
    end: { x: line.x2, y: line.y2 },
    mid: { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 },
    path: '',
    radius: 0,
  }
}

function EyeIcon(props: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {props.open ? (
        <>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.7 5.2A12.6 12.6 0 0 1 12 5c6.5 0 10 7 10 7a17.2 17.2 0 0 1-4 4.8" />
          <path d="M6.2 6.2C3.7 8 2 12 2 12s3.5 7 10 7c1.2 0 2.4-.2 3.4-.5" />
        </>
      )}
    </svg>
  )
}

export default function DomePlanner(props: {
  planner: {
    state: PlannerState
    aiLog: PlannerLogEntry[]
  }
}) {
  const [plannerState, setPlannerState] = useState<PlannerState>(normalizePlannerState(props.planner.state))
  const [aiLog, setAiLog] = useState<PlannerLogEntry[]>(props.planner.aiLog)
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(
    props.planner.state.domes[0]?.id ? { kind: 'dome', id: props.planner.state.domes[0].id } : null
  )
  const [activeDomeId, setActiveDomeId] = useState<string>(props.planner.state.domes[0]?.id || '')
  const [status, setStatus] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [undoStack, setUndoStack] = useState<PlannerState[]>([])
  const [canvasScale, setCanvasScale] = useState(1)
  const [selectedDomePreset, setSelectedDomePreset] = useState<DomePresetKey>('dome_24_16')
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({
    domes: true,
    wall: true,
    power: true,
    water: true,
    drain: true,
    sewer: true,
    ethernet: true,
    fixtures: true,
  })
  const [goreCountMode, setGoreCountMode] = useState<'auto' | 'manual'>('auto')
  const [manualGoreCount, setManualGoreCount] = useState(12)
  const [materialWidthFt, setMaterialWidthFt] = useState(5)
  const [seamAllowanceIn, setSeamAllowanceIn] = useState(1)
  const [lateralDivisions, setLateralDivisions] = useState(12)
  const [logDraft, setLogDraft] = useState({
    actor: 'quinn',
    kind: 'note' as PlannerLogEntry['kind'],
    summary: '',
    expectedOutcome: '',
    actualOutcome: '',
    correction: '',
  })
  const svgRef = useRef<SVGSVGElement | null>(null)
  const DRAG_THRESHOLD_FT = 0.35

  const selectedDome =
    selectedElement?.kind === 'dome' ? plannerState.domes.find((dome) => dome.id === selectedElement.id) || null : null
  const selectedLine =
    selectedElement?.kind === 'line' ? plannerState.lines.find((line) => line.id === selectedElement.id) || null : null
  const selectedFixture =
    selectedElement?.kind === 'fixture'
      ? plannerState.fixtures.find((fixture) => fixture.id === selectedElement.id) || null
      : null
  const activeDome = plannerState.domes.find((dome) => dome.id === activeDomeId) || null
  const selectedLineLength = selectedLine ? getLineRenderData(selectedLine, plannerState.domes).length : 0

  const clonePlannerState = (state: PlannerState): PlannerState => JSON.parse(JSON.stringify(state)) as PlannerState

  const pushUndoSnapshot = () => {
    setUndoStack((current) => [...current.slice(-49), clonePlannerState(plannerState)])
  }

  const goreData = useMemo(() => {
    if (!selectedDome) return null

    const diameterFt = Math.max(Number(selectedDome.diameterFt) || 0, 0.01)
    const riseFt = Math.max(Number(selectedDome.heightFt) || 0, 0.01)
    const baseRadiusFt = diameterFt / 2
    const sphereRadiusFt = (baseRadiusFt ** 2 + riseFt ** 2) / (2 * riseFt)
    const thetaMax = Math.acos((sphereRadiusFt - riseFt) / sphereRadiusFt)
    const thetaMaxDeg = (thetaMax * 180) / Math.PI
    const meridianArcFt = sphereRadiusFt * thetaMax
    const baseCircumferenceFt = 2 * Math.PI * baseRadiusFt
    const seamAllowanceFt = seamAllowanceIn / 12
    const seamBothSidesFt = seamAllowanceFt * 2
    const usableMaterialWidthFt = Math.max(materialWidthFt - seamBothSidesFt, 0.01)
    const suggestedGores = Math.max(3, Math.ceil(baseCircumferenceFt / usableMaterialWidthFt))
    const goreCount = goreCountMode === 'manual' ? Math.max(3, Math.round(manualGoreCount)) : suggestedGores
    const baseWidthPerGoreFt = baseCircumferenceFt / goreCount
    const baseCutWidthPerGoreFt = baseWidthPerGoreFt + seamBothSidesFt
    const divisions = Math.max(2, Math.round(lateralDivisions))

    const points: GorePoint[] = []
    for (let i = 0; i <= divisions; i += 1) {
      const t = i / divisions
      const theta = thetaMax * t
      const fullWidthFt = (2 * Math.PI * sphereRadiusFt * Math.sin(theta)) / goreCount
      points.push({
        division: i,
        thetaDeg: (theta * 180) / Math.PI,
        arcHeightFt: sphereRadiusFt * theta,
        fullWidthFt,
        halfWidthFt: fullWidthFt / 2,
      })
    }

    return {
      diameterFt,
      riseFt,
      baseRadiusFt,
      sphereRadiusFt,
      thetaMaxDeg,
      meridianArcFt,
      baseCircumferenceFt,
      goreCount,
      suggestedGores,
      seamAllowanceFt,
      seamBothSidesFt,
      materialWidthFt,
      usableMaterialWidthFt,
      baseWidthPerGoreFt,
      baseCutWidthPerGoreFt,
      totalMaterialLengthFt: meridianArcFt * goreCount,
      surfaceAreaSqFt: 2 * Math.PI * sphereRadiusFt * riseFt,
      points,
    }
  }, [
    selectedDome,
    goreCountMode,
    manualGoreCount,
    materialWidthFt,
    seamAllowanceIn,
    lateralDivisions,
  ])

  const viewBox = useMemo(() => {
    const padding = 10
    const xs = [
      ...plannerState.domes.flatMap((dome) => [dome.x - dome.diameterFt / 2, dome.x + dome.diameterFt / 2]),
      ...plannerState.lines.flatMap((line) => [line.x1, line.x2]),
      ...plannerState.fixtures.flatMap((fixture) => [fixture.x - fixture.widthFt / 2, fixture.x + fixture.widthFt / 2]),
    ]
    const ys = [
      ...plannerState.domes.flatMap((dome) => [dome.y - dome.diameterFt / 2, dome.y + dome.diameterFt / 2]),
      ...plannerState.lines.flatMap((line) => [line.y1, line.y2]),
      ...plannerState.fixtures.flatMap((fixture) => [fixture.y - fixture.heightFt / 2, fixture.y + fixture.heightFt / 2]),
    ]
    if (xs.length === 0 || ys.length === 0) return '-30 -30 60 60'
    const minX = Math.min(...xs) - padding
    const maxX = Math.max(...xs) + padding
    const minY = Math.min(...ys) - padding
    const maxY = Math.max(...ys) + padding
    return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`
  }, [plannerState.domes, plannerState.lines, plannerState.fixtures])

  const updateSelectedDome = (field: keyof Dome, value: string | number) => {
    if (!selectedDome) return
    pushUndoSnapshot()
    setPlannerState((current) => ({
      ...current,
      domes: current.domes.map((dome) =>
        dome.id === selectedDome.id
          ? {
              ...dome,
              [field]:
                field === 'x' || field === 'y' || field === 'diameterFt' || field === 'heightFt' || field === 'stemWallFt'
                  ? Number(value)
                  : value,
            }
          : dome
      ),
    }))
  }

  const updateSelectedLine = (field: keyof PlannerLine, value: string | number) => {
    if (!selectedLine) return
    pushUndoSnapshot()
    setPlannerState((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.id === selectedLine.id
          ? {
              ...line,
              [field]:
                field === 'x1' ||
                field === 'y1' ||
                field === 'x2' ||
                field === 'y2' ||
                field === 'radiusOffsetFt' ||
                field === 'startAngleDeg' ||
                field === 'endAngleDeg'
                  ? Number(value)
                  : value,
            }
          : line
      ),
    }))
  }

  const updateSelectedFixture = (field: keyof PlannerFixture, value: string | number) => {
    if (!selectedFixture) return
    pushUndoSnapshot()
    setPlannerState((current) => ({
      ...current,
      fixtures: current.fixtures.map((fixture) =>
        fixture.id === selectedFixture.id
          ? {
              ...fixture,
              [field]:
                field === 'x' || field === 'y' || field === 'widthFt' || field === 'heightFt'
                  ? Number(value)
                  : value,
            }
          : fixture
      ),
    }))
  }

  const updateSelectedLineLength = (lengthFt: number) => {
    if (!selectedLine) return
    pushUndoSnapshot()
    const safeLength = Math.max(0.25, Number(lengthFt) || 0.25)
    if (selectedLine.geometryMode === 'dome_arc') {
      const dome = plannerState.domes.find((entry) => entry.id === selectedLine.domeId)
      if (!dome) return
      const radius = Math.max(0.25, dome.diameterFt / 2 + selectedLine.radiusOffsetFt)
      const currentDelta = getArcAngleDelta(selectedLine.startAngleDeg, selectedLine.endAngleDeg)
      const direction = currentDelta >= 0 ? 1 : -1
      const nextDeltaDeg = (safeLength / radius) * (180 / Math.PI) * direction
      const nextEndAngle = selectedLine.startAngleDeg + nextDeltaDeg
      setPlannerState((current) => ({
        ...current,
        lines: current.lines.map((line) =>
          line.id === selectedLine.id
            ? {
                ...line,
                endAngleDeg: Number(nextEndAngle.toFixed(2)),
              }
            : line
        ),
      }))
      return
    }
    const dx = selectedLine.x2 - selectedLine.x1
    const dy = selectedLine.y2 - selectedLine.y1
    const currentLength = Math.sqrt(dx ** 2 + dy ** 2)
    const angle = currentLength > 0 ? Math.atan2(dy, dx) : 0
    const nextX2 = selectedLine.x1 + Math.cos(angle) * safeLength
    const nextY2 = selectedLine.y1 + Math.sin(angle) * safeLength
    setPlannerState((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.id === selectedLine.id
          ? {
              ...line,
              x2: Number(nextX2.toFixed(2)),
              y2: Number(nextY2.toFixed(2)),
            }
          : line
      ),
    }))
  }

  const updateDomePosition = (domeId: string, x: number, y: number) => {
    setPlannerState((current) => ({
      ...current,
      domes: current.domes.map((dome) =>
        dome.id === domeId
          ? {
              ...dome,
              x: Number(x.toFixed(2)),
              y: Number(y.toFixed(2)),
            }
          : dome
      ),
    }))
  }

  const updateLinePoint = (lineId: string, endpoint: 'start' | 'end', x: number, y: number) => {
    setPlannerState((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              ...(endpoint === 'start'
                ? { x1: Number(x.toFixed(2)), y1: Number(y.toFixed(2)) }
                : { x2: Number(x.toFixed(2)), y2: Number(y.toFixed(2)) }),
            }
          : line
      ),
    }))
  }

  const moveLineByDelta = (lineId: string, deltaX: number, deltaY: number) => {
    setPlannerState((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              x1: Number((line.x1 + deltaX).toFixed(2)),
              y1: Number((line.y1 + deltaY).toFixed(2)),
              x2: Number((line.x2 + deltaX).toFixed(2)),
              y2: Number((line.y2 + deltaY).toFixed(2)),
            }
          : line
      ),
    }))
  }

  const updateFixturePosition = (fixtureId: string, x: number, y: number) => {
    setPlannerState((current) => ({
      ...current,
      fixtures: current.fixtures.map((fixture) =>
        fixture.id === fixtureId
          ? {
              ...fixture,
              x: Number(x.toFixed(2)),
              y: Number(y.toFixed(2)),
            }
          : fixture
      ),
    }))
  }

  const updateDomeDiameter = (domeId: string, diameterFt: number) => {
    setPlannerState((current) => ({
      ...current,
      domes: current.domes.map((dome) =>
        dome.id === domeId
          ? {
              ...dome,
              diameterFt: Number(Math.max(1, diameterFt).toFixed(2)),
            }
          : dome
      ),
    }))
  }

  const updateFixtureSize = (fixtureId: string, widthFt: number, heightFt: number) => {
    setPlannerState((current) => ({
      ...current,
      fixtures: current.fixtures.map((fixture) =>
        fixture.id === fixtureId
          ? {
              ...fixture,
              widthFt: Number(Math.max(0.5, widthFt).toFixed(2)),
              heightFt: Number(Math.max(0.5, heightFt).toFixed(2)),
            }
          : fixture
      ),
    }))
  }

  const clientPointToSvgPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const screenCTM = svg.getScreenCTM()
    if (!screenCTM) return null
    return point.matrixTransform(screenCTM.inverse())
  }

  const beginDomeDrag = (event: React.PointerEvent<SVGGElement>, domeId: string) => {
    event.preventDefault()
    event.stopPropagation()
    const dome = plannerState.domes.find((entry) => entry.id === domeId)
    const point = clientPointToSvgPoint(event.clientX, event.clientY)
    if (!dome || !point) return
    pushUndoSnapshot()
    setSelectedElement({ kind: 'dome', id: domeId })
    setActiveDomeId(domeId)
    setContextMenu(null)
    setDragState({
      kind: 'dome',
      id: domeId,
      startPointerX: point.x,
      startPointerY: point.y,
      originX: dome.x,
      originY: dome.y,
      moved: false,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    setStatus('Dome selected.')
  }

  const beginLineDrag = (
    event: React.PointerEvent<SVGElement>,
    lineId: string,
    kind: 'line-start' | 'line-end' | 'line-body'
  ) => {
    event.preventDefault()
    event.stopPropagation()
    pushUndoSnapshot()
    setSelectedElement({ kind: 'line', id: lineId })
    setContextMenu(null)
    if (kind === 'line-body') {
      const point = clientPointToSvgPoint(event.clientX, event.clientY)
      if (!point) return
      setDragState({ kind, id: lineId, lastX: point.x, lastY: point.y, moved: false })
    } else {
      setDragState({ kind, id: lineId })
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setStatus(kind === 'line-body' ? 'Line selected.' : 'Dragging line endpoint...')
  }

  const beginFixtureDrag = (event: React.PointerEvent<SVGGElement>, fixtureId: string) => {
    event.preventDefault()
    event.stopPropagation()
    const fixture = plannerState.fixtures.find((entry) => entry.id === fixtureId)
    const point = clientPointToSvgPoint(event.clientX, event.clientY)
    if (!fixture || !point) return
    pushUndoSnapshot()
    setSelectedElement({ kind: 'fixture', id: fixtureId })
    setContextMenu(null)
    setDragState({
      kind: 'fixture',
      id: fixtureId,
      startPointerX: point.x,
      startPointerY: point.y,
      originX: fixture.x,
      originY: fixture.y,
      moved: false,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    setStatus('Fixture selected.')
  }

  const beginDomeResize = (event: React.PointerEvent<SVGCircleElement>, domeId: string) => {
    event.preventDefault()
    event.stopPropagation()
    pushUndoSnapshot()
    setSelectedElement({ kind: 'dome', id: domeId })
    setActiveDomeId(domeId)
    setContextMenu(null)
    setDragState({ kind: 'dome-resize', id: domeId })
    event.currentTarget.setPointerCapture(event.pointerId)
    setStatus('Resizing dome...')
  }

  const beginFixtureResize = (event: React.PointerEvent<SVGRectElement>, fixtureId: string) => {
    event.preventDefault()
    event.stopPropagation()
    pushUndoSnapshot()
    setSelectedElement({ kind: 'fixture', id: fixtureId })
    setContextMenu(null)
    setDragState({ kind: 'fixture-resize', id: fixtureId })
    event.currentTarget.setPointerCapture(event.pointerId)
    setStatus('Resizing fixture...')
  }

  const dragSelected = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return
    const point = clientPointToSvgPoint(event.clientX, event.clientY)
    if (!point) return
    if (dragState.kind === 'dome') {
      const deltaX = point.x - dragState.startPointerX
      const deltaY = point.y - dragState.startPointerY
      if (!dragState.moved && Math.sqrt(deltaX ** 2 + deltaY ** 2) < DRAG_THRESHOLD_FT) return
      updateDomePosition(dragState.id, dragState.originX + deltaX, dragState.originY + deltaY)
      if (!dragState.moved) setDragState({ ...dragState, moved: true })
      return
    }
    if (dragState.kind === 'fixture') {
      const deltaX = point.x - dragState.startPointerX
      const deltaY = point.y - dragState.startPointerY
      if (!dragState.moved && Math.sqrt(deltaX ** 2 + deltaY ** 2) < DRAG_THRESHOLD_FT) return
      updateFixturePosition(dragState.id, dragState.originX + deltaX, dragState.originY + deltaY)
      if (!dragState.moved) setDragState({ ...dragState, moved: true })
      return
    }
    if (dragState.kind === 'dome-resize') {
      const dome = plannerState.domes.find((entry) => entry.id === dragState.id)
      if (!dome) return
      const radius = Math.sqrt((point.x - dome.x) ** 2 + (point.y - dome.y) ** 2)
      updateDomeDiameter(dragState.id, radius * 2)
      return
    }
    if (dragState.kind === 'fixture-resize') {
      const fixture = plannerState.fixtures.find((entry) => entry.id === dragState.id)
      if (!fixture) return
      const width = Math.abs(point.x - fixture.x) * 2
      const height = Math.abs(point.y - fixture.y) * 2
      updateFixtureSize(dragState.id, width, height)
      return
    }
    if (dragState.kind === 'line-start') {
      const line = plannerState.lines.find((entry) => entry.id === dragState.id)
      if (line?.geometryMode === 'dome_arc') {
        const dome = plannerState.domes.find((entry) => entry.id === line.domeId)
        if (!dome) return
        const angle = angleFromPoint(dome.x, dome.y, point.x, point.y)
        setPlannerState((current) => ({
          ...current,
          lines: current.lines.map((entry) =>
            entry.id === dragState.id ? { ...entry, startAngleDeg: Number(angle.toFixed(2)) } : entry
          ),
        }))
        return
      }
      updateLinePoint(dragState.id, 'start', point.x, point.y)
      return
    }
    if (dragState.kind === 'line-end') {
      const line = plannerState.lines.find((entry) => entry.id === dragState.id)
      if (line?.geometryMode === 'dome_arc') {
        const dome = plannerState.domes.find((entry) => entry.id === line.domeId)
        if (!dome) return
        const angle = angleFromPoint(dome.x, dome.y, point.x, point.y)
        setPlannerState((current) => ({
          ...current,
          lines: current.lines.map((entry) =>
            entry.id === dragState.id ? { ...entry, endAngleDeg: Number(angle.toFixed(2)) } : entry
          ),
        }))
        return
      }
      updateLinePoint(dragState.id, 'end', point.x, point.y)
      return
    }
    if (dragState.kind === 'line-body') {
      const line = plannerState.lines.find((entry) => entry.id === dragState.id)
      if (line?.geometryMode === 'dome_arc') {
        const dome = plannerState.domes.find((entry) => entry.id === line.domeId)
        if (!dome) return
        const previousAngle = angleFromPoint(dome.x, dome.y, dragState.lastX, dragState.lastY)
        const currentAngle = angleFromPoint(dome.x, dome.y, point.x, point.y)
        let delta = currentAngle - previousAngle
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        if (!dragState.moved && Math.abs(delta) < 1.5) return
        setPlannerState((current) => ({
          ...current,
          lines: current.lines.map((entry) =>
            entry.id === dragState.id
              ? {
                  ...entry,
                  startAngleDeg: Number((entry.startAngleDeg + delta).toFixed(2)),
                  endAngleDeg: Number((entry.endAngleDeg + delta).toFixed(2)),
                }
              : entry
          ),
        }))
        setDragState({ ...dragState, lastX: point.x, lastY: point.y, moved: true })
        return
      }
      const deltaX = point.x - dragState.lastX
      const deltaY = point.y - dragState.lastY
      if (!dragState.moved && Math.sqrt(deltaX ** 2 + deltaY ** 2) < DRAG_THRESHOLD_FT) return
      moveLineByDelta(dragState.id, deltaX, deltaY)
      setDragState({ ...dragState, lastX: point.x, lastY: point.y, moved: true })
    }
  }

  const endDrag = () => {
    if (!dragState) return
    const message =
      dragState.kind === 'dome' || dragState.kind === 'dome-resize'
        ? dragState.kind === 'dome' && !dragState.moved
          ? 'Dome selected.'
          : 'Dome moved locally. Save to persist it.'
        : dragState.kind === 'fixture' || dragState.kind === 'fixture-resize'
          ? dragState.kind === 'fixture' && !dragState.moved
            ? 'Fixture selected.'
            : 'Fixture moved locally. Save to persist it.'
          : dragState.kind === 'line-body' && !dragState.moved
            ? 'Line selected.'
            : 'Line updated locally. Save to persist it.'
    setDragState(null)
    setStatus(message)
  }

  const addDome = () => {
    pushUndoSnapshot()
    const nextIndex = plannerState.domes.length + 1
    const preset = domePresetMeta[selectedDomePreset]
    const newDome: Dome = {
      id: `dome-${Date.now()}`,
      name: `Dome ${nextIndex}`,
      x: 0,
      y: nextIndex * -28,
      diameterFt: preset.diameterFt,
      heightFt: preset.heightFt,
      stemWallFt: preset.stemWallFt,
      notes: '',
    }

    setPlannerState((current) => ({
      ...current,
      domes: [...current.domes, newDome],
    }))
    setSelectedElement({ kind: 'dome', id: newDome.id })
    setActiveDomeId(newDome.id)
    setStatus(`Added a new ${preset.label} dome locally. Save when it looks right.`)
  }

  const addLine = (layer: PlannerLineLayer) => {
    pushUndoSnapshot()
    const nextIndex = plannerState.lines.filter((line) => line.layer === layer).length + 1
    const newLine: PlannerLine = {
      id: `line-${Date.now()}`,
      name: `${lineLayerMeta[layer].label} ${nextIndex}`,
      layer,
      x1: -6,
      y1: 0,
      x2: 6,
      y2: 0,
      geometryMode: 'straight',
      domeId: activeDome?.id || plannerState.domes[0]?.id || '',
      radiusOffsetFt: 0,
      startAngleDeg: 0,
      endAngleDeg: 90,
      notes: '',
    }
    setPlannerState((current) => ({
      ...current,
      lines: [...current.lines, newLine],
    }))
    setSelectedElement({ kind: 'line', id: newLine.id })
    setStatus(`Added a ${lineLayerMeta[layer].label.toLowerCase()} line locally. Save when it looks right.`)
  }

  const snapSelectedLineToSelectedDome = () => {
    if (!selectedLine || !activeDome) return
    pushUndoSnapshot()

    const nextStartAngle = angleFromPoint(activeDome.x, activeDome.y, selectedLine.x1, selectedLine.y1)
    const nextEndAngle = angleFromPoint(activeDome.x, activeDome.y, selectedLine.x2, selectedLine.y2)
    const startDistance = Math.sqrt((selectedLine.x1 - activeDome.x) ** 2 + (selectedLine.y1 - activeDome.y) ** 2)
    const endDistance = Math.sqrt((selectedLine.x2 - activeDome.x) ** 2 + (selectedLine.y2 - activeDome.y) ** 2)
    const averageDistance = (startDistance + endDistance) / 2
    const nextOffset = Number((averageDistance - activeDome.diameterFt / 2).toFixed(2))

    setPlannerState((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.id === selectedLine.id
          ? {
              ...line,
              geometryMode: 'dome_arc',
              domeId: activeDome.id,
              radiusOffsetFt: nextOffset,
              startAngleDeg: Number(nextStartAngle.toFixed(2)),
              endAngleDeg: Number(nextEndAngle.toFixed(2)),
            }
          : line
      ),
    }))

    setStatus(`Snapped ${selectedLine.name} to ${activeDome.name}'s outside curve locally. Save to persist it.`)
  }

  const addFixture = (type: PlannerFixtureType) => {
    pushUndoSnapshot()
    const nextIndex = plannerState.fixtures.length + 1
    const meta = fixtureTypeMeta[type]
    const newFixture: PlannerFixture = {
      id: `fixture-${Date.now()}`,
      name: `${meta.label} ${nextIndex}`,
      type,
      x: 0,
      y: 0,
      widthFt: meta.widthFt,
      heightFt: meta.heightFt,
      notes: '',
    }
    setPlannerState((current) => ({
      ...current,
      fixtures: [...current.fixtures, newFixture],
    }))
    setSelectedElement({ kind: 'fixture', id: newFixture.id })
    setStatus(`Added a ${meta.label.toLowerCase()} locally. Save when it looks right.`)
  }

  const toggleLayer = (layer: keyof LayerVisibility) => {
    setLayerVisibility((current) => ({
      ...current,
      [layer]: !current[layer],
    }))
  }

  const zoomCanvas = (direction: 'in' | 'out') => {
    setCanvasScale((current) => {
      const next = direction === 'in' ? current * 1.12 : current / 1.12
      return Number(Math.min(4, Math.max(0.35, next)).toFixed(3))
    })
  }

  const handleCanvasWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    zoomCanvas(event.deltaY < 0 ? 'in' : 'out')
  }

  const removeSelectedDome = () => {
    if (!selectedDome) return
    pushUndoSnapshot()
    const remaining = plannerState.domes.filter((dome) => dome.id !== selectedDome.id)
    setPlannerState((current) => ({ ...current, domes: remaining }))
    setSelectedElement(remaining[0]?.id ? { kind: 'dome', id: remaining[0].id } : null)
    if (activeDomeId === selectedDome.id) setActiveDomeId(remaining[0]?.id || '')
    setStatus(`Removed ${selectedDome.name} locally. Save to persist it.`)
  }

  const removeSelectedLine = () => {
    if (!selectedLine) return
    pushUndoSnapshot()
    setPlannerState((current) => ({
      ...current,
      lines: current.lines.filter((line) => line.id !== selectedLine.id),
    }))
    setSelectedElement(null)
    setStatus(`Removed ${selectedLine.name} locally. Save to persist it.`)
  }

  const removeSelectedFixture = () => {
    if (!selectedFixture) return
    pushUndoSnapshot()
    setPlannerState((current) => ({
      ...current,
      fixtures: current.fixtures.filter((fixture) => fixture.id !== selectedFixture.id),
    }))
    setSelectedElement(null)
    setStatus(`Removed ${selectedFixture.name} locally. Save to persist it.`)
  }

  const savePlanner = async () => {
    setIsSaving(true)
    setStatus('Saving planner...')
    const response = await api.saveDomePlanner(plannerState)
    if (!response?.success || !response?.state) {
      setStatus('Planner save failed.')
      setIsSaving(false)
      return
    }

    setPlannerState(normalizePlannerState(response.state as PlannerState))
    setStatus('Planner saved.')
    setIsSaving(false)
  }

  const refreshPlanner = async () => {
    setStatus('Refreshing from saved planner state...')
    const response = await api.getDomePlanner()
    if (!response?.state) {
      setStatus('Refresh failed.')
      return
    }

    const normalized = normalizePlannerState(response.state as PlannerState)
    setPlannerState(normalized)
    setAiLog((response.aiLog || []) as PlannerLogEntry[])
    setSelectedElement(normalized.domes[0]?.id ? { kind: 'dome', id: normalized.domes[0].id } : null)
    setActiveDomeId(normalized.domes[0]?.id || '')
    setStatus('Planner refreshed from storage.')
  }

  const submitLogEntry = async () => {
    if (!logDraft.summary.trim()) {
      setStatus('Log summary is required.')
      return
    }

    setStatus('Saving AI log entry...')
    const response = await api.addDomePlannerLog(logDraft)
    if (!response?.success || !response?.aiLog) {
      setStatus('AI log save failed.')
      return
    }

    setAiLog(response.aiLog as PlannerLogEntry[])
    setLogDraft({
      actor: logDraft.actor,
      kind: 'note',
      summary: '',
      expectedOutcome: '',
      actualOutcome: '',
      correction: '',
    })
    setStatus('AI log entry saved.')
  }

  const handleContextMenu = (
    event: React.MouseEvent<SVGElement | SVGGElement>,
    target: SelectedElement
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedElement(target)
    if (target.kind === 'dome') setActiveDomeId(target.id)
    setContextMenu({ x: event.clientX, y: event.clientY, target })
  }

  const removeSelectedElement = () => {
    if (selectedElement?.kind === 'dome') {
      removeSelectedDome()
    } else if (selectedElement?.kind === 'line') {
      removeSelectedLine()
    } else if (selectedElement?.kind === 'fixture') {
      removeSelectedFixture()
    }
    setContextMenu(null)
  }

  const undoLastChange = () => {
    setUndoStack((current) => {
      const previous = current[current.length - 1]
      if (!previous) return current
      setPlannerState(previous)
      setContextMenu(null)
      setStatus('Undid the last planner change.')
      return current.slice(0, -1)
    })
  }

  return (
    <AppLayout>
      <Head title="Dome Planner" />
      <div className="p-4 space-y-4">
        <div className="rounded border border-border-subtle bg-card p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Dome Planner</h1>
              <p className="text-sm text-text-secondary">
                Shared dome layout workspace inside NOMAD, with an audit log for Quinn and human design moves.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded border border-border-subtle px-4 py-2 disabled:opacity-50"
                disabled={undoStack.length === 0}
                onClick={undoLastChange}
              >
                Undo
              </button>
              <button className="rounded bg-desert-green px-4 py-2 text-white" onClick={addDome}>
                Add Dome
              </button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={() => addLine('wall')}>
                Add Wall
              </button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={() => addLine('power')}>
                Add Power
              </button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={() => addLine('water')}>
                Add Water
              </button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={() => addLine('drain')}>
                Add Drain
              </button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={() => addLine('sewer')}>
                Add Sewer
              </button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={() => addLine('ethernet')}>
                Add Ethernet
              </button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={() => addFixture('sink')}>Add Sink</button>
              <button className="rounded border border-border-subtle px-4 py-2" onClick={refreshPlanner}>
                Refresh
              </button>
              <button
                className="rounded bg-desert-orange px-4 py-2 text-white disabled:opacity-60"
                disabled={isSaving}
                onClick={savePlanner}
              >
                {isSaving ? 'Saving...' : 'Save Planner'}
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-text-secondary">
            <span>Project: {plannerState.projectName}</span>
            <span>Units: {plannerState.units}</span>
            <span>Domes: {plannerState.domes.length}</span>
            <span>Last saved: {formatStamp(plannerState.updatedAt)}</span>
          </div>
          {status ? <p className="mt-3 text-sm text-desert-orange">{status}</p> : null}
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_0.9fr]">
          <div className="rounded border border-border-subtle bg-card p-4">
            <div className="mb-4 rounded border border-border-subtle bg-sand-light/20 p-3">
              <h3 className="text-sm font-semibold text-text-primary">Shape Toolbar</h3>
              <p className="mt-1 text-xs text-text-secondary">
                Drop in layout shapes fast, then drag on the canvas to move them. Selected domes and fixtures get resize handles.
              </p>
              <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                <label className="block">
                  <span className="mb-1 block text-xs text-text-secondary">Dome Preset</span>
                  <select
                    className="w-full rounded border border-border-subtle px-3 py-2 text-sm"
                    value={selectedDomePreset}
                    onChange={(event) => setSelectedDomePreset(event.target.value as DomePresetKey)}
                  >
                    {Object.entries(domePresetMeta).map(([key, preset]) => (
                      <option key={key} value={key}>
                        {preset.label} · 8 ft stem wall
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="rounded bg-desert-green px-3 py-2 text-sm text-white" onClick={addDome}>
                  Dome
                </button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addLine('wall')}>
                  Wall
                </button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addLine('power')}>
                  Power
                </button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addLine('water')}>
                  Water
                </button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addLine('drain')}>
                  Drain
                </button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addLine('sewer')}>
                  Sewer
                </button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addLine('ethernet')}>
                  Ethernet
                </button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('sink')}>Sink</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('stove')}>Stove</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('toilet')}>Toilet</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('fridge')}>Fridge</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('washer')}>Washer</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('dryer')}>Dryer</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('light')}>Light</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('wall_plug')}>Wall Plug</button>
                <button className="rounded border border-border-subtle px-3 py-2 text-sm" onClick={() => addFixture('shower')}>Shower</button>
              </div>
            </div>
            <h2 className="text-lg font-semibold text-text-primary">Layout Workspace</h2>
            <p className="mt-1 text-sm text-text-secondary">
              This is the shared geometry layer Quinn can reason over later. Coordinates are in feet.
            </p>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-text-secondary">
              {Object.entries(lineLayerMeta).map(([layer, meta]) => (
                <div key={layer} className="flex items-center gap-2">
                  <span className="inline-block h-0.5 w-6 rounded" style={{ backgroundColor: meta.stroke }} />
                  <span>{meta.label}</span>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-5 rounded border border-slate-500 bg-slate-100" />
                <span>Fixtures</span>
              </div>
            </div>
            <div className="mt-3 rounded border border-border-subtle bg-sand-light/20 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Layers</div>
              <div className="flex flex-wrap gap-2">
                {([
                  ['domes', 'Domes'],
                  ['wall', 'Walls'],
                  ['power', 'Power'],
                  ['water', 'Water'],
                  ['drain', 'Drain'],
                  ['sewer', 'Sewer'],
                  ['ethernet', 'Ethernet'],
                  ['fixtures', 'Fixtures'],
                ] as const).map(([key, label]) => {
                  const visible = layerVisibility[key]
                  return (
                    <button
                      key={key}
                      className={`inline-flex items-center gap-2 rounded border px-3 py-1.5 text-xs ${
                        visible
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-border-subtle/60 bg-transparent text-text-secondary'
                      }`}
                      onClick={() => toggleLayer(key)}
                    >
                      <EyeIcon open={visible} />
                      <span>{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-border-subtle bg-sand-light/20 p-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Canvas Zoom</div>
                <div className="mt-1 text-sm text-text-primary">{formatNumber(canvasScale * 100, 0)}%</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="rounded border border-border-subtle px-3 py-1.5 text-sm" onClick={() => zoomCanvas('out')}>
                  -
                </button>
                <button className="rounded border border-border-subtle px-3 py-1.5 text-sm" onClick={() => setCanvasScale(1)}>
                  Reset
                </button>
                <button className="rounded border border-border-subtle px-3 py-1.5 text-sm" onClick={() => zoomCanvas('in')}>
                  +
                </button>
              </div>
            </div>
            <div
              className="relative mt-4 overflow-hidden rounded border border-border-subtle bg-white p-3 overscroll-contain"
              onPointerDown={() => setContextMenu(null)}
            >
              <div
                onWheel={handleCanvasWheel}
                onWheelCapture={handleCanvasWheel}
              >
              <svg
                ref={svgRef}
                viewBox={viewBox}
                className="h-[36rem] w-full touch-none"
                preserveAspectRatio="xMidYMid meet"
                style={{ transform: `scale(${canvasScale})`, transformOrigin: 'center center' }}
                onPointerMove={dragSelected}
                onPointerUp={endDrag}
                onPointerLeave={endDrag}
                onContextMenu={(event) => event.preventDefault()}
              >
                <defs>
                  <pattern id="planner-grid" width="6" height="6" patternUnits="userSpaceOnUse">
                    <path d="M 6 0 L 0 0 0 6" fill="none" stroke="#e5e7eb" strokeWidth="0.25" />
                  </pattern>
                </defs>
                <rect x="-1000" y="-1000" width="2000" height="2000" fill="url(#planner-grid)" />
                {plannerState.lines.filter((line) => layerVisibility[line.layer]).map((line) => {
                  const selected = line.id === selectedLine?.id
                  const meta = lineLayerMeta[line.layer]
                  const render = getLineRenderData(line, plannerState.domes)
                  const midX = render.mid.x
                  const midY = render.mid.y
                  const lineLength = render.length
                  return (
                    <g key={line.id}>
                      {render.kind === 'arc' ? (
                        <path
                          d={render.path}
                          fill="none"
                          stroke={meta.stroke}
                          strokeWidth={meta.strokeWidth}
                          strokeLinecap="round"
                          onClick={() => setSelectedElement({ kind: 'line', id: line.id })}
                          onContextMenu={(event) => handleContextMenu(event, { kind: 'line', id: line.id })}
                          onPointerDown={(event) => beginLineDrag(event, line.id, 'line-body')}
                          className="cursor-move"
                        />
                      ) : (
                        <line
                          x1={render.start.x}
                          y1={render.start.y}
                          x2={render.end.x}
                          y2={render.end.y}
                          stroke={meta.stroke}
                          strokeWidth={meta.strokeWidth}
                          strokeLinecap="round"
                          onClick={() => setSelectedElement({ kind: 'line', id: line.id })}
                          onContextMenu={(event) => handleContextMenu(event, { kind: 'line', id: line.id })}
                          onPointerDown={(event) => beginLineDrag(event, line.id, 'line-body')}
                          className="cursor-move"
                        />
                      )}
                      {selected ? (
                        <>
                          <circle
                            cx={render.start.x}
                            cy={render.start.y}
                            r={0.9}
                            fill="#ffffff"
                            stroke={meta.stroke}
                            strokeWidth={0.35}
                            onPointerDown={(event) => beginLineDrag(event, line.id, 'line-start')}
                            className="cursor-pointer"
                          />
                          <circle
                            cx={render.end.x}
                            cy={render.end.y}
                            r={0.9}
                            fill="#ffffff"
                            stroke={meta.stroke}
                            strokeWidth={0.35}
                            onPointerDown={(event) => beginLineDrag(event, line.id, 'line-end')}
                            className="cursor-pointer"
                          />
                        </>
                      ) : null}
                      <text x={midX} y={midY - 1.4} textAnchor="middle" fontSize="1.8" fill={meta.stroke}>
                        {line.name}
                      </text>
                      {selected ? (
                        <text x={midX} y={midY + 1.4} textAnchor="middle" fontSize="1.5" fill={meta.stroke}>
                          {formatNumber(lineLength)} ft
                        </text>
                      ) : null}
                    </g>
                  )
                })}
                {layerVisibility.fixtures
                  ? plannerState.fixtures.map((fixture) => {
                  const selected = fixture.id === selectedFixture?.id
                  const fixtureMeta = fixtureTypeMeta[fixture.type]
                  const x = fixture.x - fixture.widthFt / 2
                  const y = fixture.y - fixture.heightFt / 2
                  const resizeX = fixture.x + fixture.widthFt / 2
                  const resizeY = fixture.y + fixture.heightFt / 2
                  return (
                    <g
                      key={fixture.id}
                      onClick={() => setSelectedElement({ kind: 'fixture', id: fixture.id })}
                      onContextMenu={(event) => handleContextMenu(event, { kind: 'fixture', id: fixture.id })}
                      onPointerDown={(event) => beginFixtureDrag(event, fixture.id)}
                      className="cursor-grab active:cursor-grabbing"
                    >
                      <rect
                        x={x}
                        y={y}
                        width={fixture.widthFt}
                        height={fixture.heightFt}
                        rx={0.4}
                        fill={selected ? fixtureMeta.fill.replace('0.12', '0.24').replace('0.16', '0.28') : fixtureMeta.fill}
                        stroke={fixtureMeta.stroke}
                        strokeWidth={0.45}
                      />
                      <ellipse
                        cx={fixture.x}
                        cy={fixture.y}
                        rx={Math.max(0.5, fixture.widthFt * 0.28)}
                        ry={Math.max(0.3, fixture.heightFt * 0.22)}
                        fill="none"
                        stroke={fixtureMeta.stroke}
                        strokeWidth={0.24}
                      />
                      <text x={fixture.x} y={fixture.y + 0.55} textAnchor="middle" fontSize="1.8" fill={fixtureMeta.stroke}>
                        {fixtureMeta.shortLabel}
                      </text>
                      <text x={fixture.x} y={fixture.y + fixture.heightFt / 2 + 1.8} textAnchor="middle" fontSize="1.8" fill="#0f172a">
                        {fixture.name}
                      </text>
                      {selected ? (
                        <rect
                          x={resizeX - 0.55}
                          y={resizeY - 0.55}
                          width={1.1}
                          height={1.1}
                          fill="#ffffff"
                          stroke={fixtureMeta.stroke}
                          strokeWidth={0.24}
                          onPointerDown={(event) => beginFixtureResize(event, fixture.id)}
                          className="cursor-se-resize"
                        />
                      ) : null}
                    </g>
                  )
                  })
                  : null}
                {layerVisibility.domes
                  ? plannerState.domes.map((dome) => {
                  const selected = dome.id === selectedDome?.id
                  const resizeX = dome.x + dome.diameterFt / 2
                  return (
                    <g
                      key={dome.id}
                      onClick={() => {
                        setSelectedElement({ kind: 'dome', id: dome.id })
                        setActiveDomeId(dome.id)
                      }}
                      onContextMenu={(event) => handleContextMenu(event, { kind: 'dome', id: dome.id })}
                      onPointerDown={(event) => beginDomeDrag(event, dome.id)}
                      className="cursor-grab active:cursor-grabbing"
                    >
                      <circle
                        cx={dome.x}
                        cy={dome.y}
                        r={dome.diameterFt / 2}
                        fill={selected ? 'rgba(201, 135, 51, 0.20)' : 'rgba(59, 130, 246, 0.12)'}
                        stroke={selected ? '#c98733' : '#2563eb'}
                        strokeWidth={0.6}
                      />
                      <circle cx={dome.x} cy={dome.y} r={0.65} fill={selected ? '#c98733' : '#2563eb'} />
                      <text x={dome.x} y={dome.y} textAnchor="middle" fontSize="2.4" fill="#111827">
                        {dome.name}
                      </text>
                      <text x={dome.x} y={dome.y + 3.2} textAnchor="middle" fontSize="1.8" fill="#4b5563">
                        {dome.diameterFt}ft / {dome.heightFt}ft
                      </text>
                      <text x={dome.x} y={dome.y + 5.2} textAnchor="middle" fontSize="1.5" fill="#6b7280">
                        stem {dome.stemWallFt}ft
                      </text>
                      {selected ? (
                        <circle
                          cx={resizeX}
                          cy={dome.y}
                          r={0.95}
                          fill="#ffffff"
                          stroke="#c98733"
                          strokeWidth={0.3}
                          onPointerDown={(event) => beginDomeResize(event, dome.id)}
                          className="cursor-ew-resize"
                        />
                      ) : null}
                    </g>
                  )
                  })
                  : null}
              </svg>
              </div>
              {contextMenu ? (
                <div
                  className="fixed z-50 min-w-44 rounded border border-border-subtle bg-white p-1 shadow-xl"
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                  <button
                    className="block w-full rounded px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
                    onClick={removeSelectedElement}
                  >
                    Remove selected item
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded border border-border-subtle bg-card p-4">
              <h2 className="text-lg font-semibold text-text-primary">Selected Element</h2>
              {selectedDome ? (
                <div className="mt-4 space-y-3">
                  <div className="text-sm font-medium text-text-secondary">Dome</div>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Name</span>
                    <input
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedDome.name}
                      onChange={(event) => updateSelectedDome('name', event.target.value)}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">X (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedDome.x}
                        onChange={(event) => updateSelectedDome('x', event.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Y (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedDome.y}
                        onChange={(event) => updateSelectedDome('y', event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Diameter (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedDome.diameterFt}
                        onChange={(event) => updateSelectedDome('diameterFt', event.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Height (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedDome.heightFt}
                        onChange={(event) => updateSelectedDome('heightFt', event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Stem Wall (ft)</span>
                    <input
                      type="number"
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedDome.stemWallFt}
                      onChange={(event) => updateSelectedDome('stemWallFt', event.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Notes</span>
                    <textarea
                      className="min-h-24 w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedDome.notes}
                      onChange={(event) => updateSelectedDome('notes', event.target.value)}
                    />
                  </label>
                  <button className="rounded border border-red-300 px-4 py-2 text-red-700" onClick={removeSelectedDome}>
                    Remove Selected Dome
                  </button>
                </div>
              ) : selectedLine ? (
                <div className="mt-4 space-y-3">
                  <div className="text-sm font-medium text-text-secondary">Line · {lineLayerMeta[selectedLine.layer].label}</div>
                  <div className="rounded border border-border-subtle bg-sand-light/30 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-sm font-medium text-text-primary">Quick Dome Snap</div>
                        <div className="text-xs text-text-secondary">
                          Convert this run to a curve that follows the active snap dome.
                        </div>
                        <div className="mt-1 text-xs text-text-secondary">
                          Snap target: <span className="font-medium text-text-primary">{activeDome?.name || 'None selected'}</span>
                        </div>
                      </div>
                      <button
                        className="rounded border border-border-subtle px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!activeDome}
                        onClick={snapSelectedLineToSelectedDome}
                      >
                        {activeDome ? `Snap to ${activeDome.name}` : 'Select a dome first'}
                      </button>
                    </div>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Name</span>
                    <input
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedLine.name}
                      onChange={(event) => updateSelectedLine('name', event.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Layer</span>
                    <select
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedLine.layer}
                      onChange={(event) => updateSelectedLine('layer', event.target.value)}
                    >
                      {Object.entries(lineLayerMeta).map(([layer, meta]) => (
                        <option key={layer} value={layer}>
                          {meta.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Geometry</span>
                    <select
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedLine.geometryMode}
                      onChange={(event) => updateSelectedLine('geometryMode', event.target.value)}
                    >
                      <option value="straight">Straight</option>
                      <option value="dome_arc">Snap to Dome Curve</option>
                    </select>
                  </label>
                  {selectedLine.geometryMode === 'dome_arc' ? (
                    <>
                      <label className="block">
                        <span className="mb-1 block text-sm text-text-secondary">Attached Dome</span>
                        <select
                          className="w-full rounded border border-border-subtle px-3 py-2"
                          value={selectedLine.domeId}
                          onChange={(event) => updateSelectedLine('domeId', event.target.value)}
                        >
                          <option value="">Select dome</option>
                          {plannerState.domes.map((dome) => (
                            <option key={dome.id} value={dome.id}>
                              {dome.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="mb-1 block text-sm text-text-secondary">Start Angle (deg)</span>
                          <input
                            type="number"
                            step="0.1"
                            className="w-full rounded border border-border-subtle px-3 py-2"
                            value={selectedLine.startAngleDeg}
                            onChange={(event) => updateSelectedLine('startAngleDeg', event.target.value)}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-sm text-text-secondary">End Angle (deg)</span>
                          <input
                            type="number"
                            step="0.1"
                            className="w-full rounded border border-border-subtle px-3 py-2"
                            value={selectedLine.endAngleDeg}
                            onChange={(event) => updateSelectedLine('endAngleDeg', event.target.value)}
                          />
                        </label>
                      </div>
                      <label className="block">
                        <span className="mb-1 block text-sm text-text-secondary">Outside Offset (ft)</span>
                        <input
                          type="number"
                          step="0.1"
                          className="w-full rounded border border-border-subtle px-3 py-2"
                          value={selectedLine.radiusOffsetFt}
                          onChange={(event) => updateSelectedLine('radiusOffsetFt', event.target.value)}
                        />
                      </label>
                    </>
                  ) : null}
                  {selectedLine.geometryMode === 'straight' ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="mb-1 block text-sm text-text-secondary">X1 (ft)</span>
                          <input
                            type="number"
                            className="w-full rounded border border-border-subtle px-3 py-2"
                            value={selectedLine.x1}
                            onChange={(event) => updateSelectedLine('x1', event.target.value)}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-sm text-text-secondary">Y1 (ft)</span>
                          <input
                            type="number"
                            className="w-full rounded border border-border-subtle px-3 py-2"
                            value={selectedLine.y1}
                            onChange={(event) => updateSelectedLine('y1', event.target.value)}
                          />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="mb-1 block text-sm text-text-secondary">X2 (ft)</span>
                          <input
                            type="number"
                            className="w-full rounded border border-border-subtle px-3 py-2"
                            value={selectedLine.x2}
                            onChange={(event) => updateSelectedLine('x2', event.target.value)}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-sm text-text-secondary">Y2 (ft)</span>
                          <input
                            type="number"
                            className="w-full rounded border border-border-subtle px-3 py-2"
                            value={selectedLine.y2}
                            onChange={(event) => updateSelectedLine('y2', event.target.value)}
                          />
                        </label>
                      </div>
                    </>
                  ) : (
                    <div className="rounded border border-border-subtle p-3 text-sm text-text-secondary">
                      This run is attached to a dome curve. Use the dome, angle, and offset controls above, or drag the arc handles on the canvas.
                    </div>
                  )}
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Length (ft)</span>
                    <input
                      type="number"
                      step="0.01"
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={Number(selectedLineLength.toFixed(2))}
                      onChange={(event) => updateSelectedLineLength(Number(event.target.value))}
                    />
                  </label>
                  <div className="rounded border border-border-subtle p-3 text-sm text-text-secondary">
                    Current run: <span className="font-medium text-text-primary">{formatNumber(selectedLineLength)} ft</span>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Notes</span>
                    <textarea
                      className="min-h-24 w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedLine.notes}
                      onChange={(event) => updateSelectedLine('notes', event.target.value)}
                    />
                  </label>
                  <button className="rounded border border-red-300 px-4 py-2 text-red-700" onClick={removeSelectedLine}>
                    Remove Selected Line
                  </button>
                </div>
              ) : selectedFixture ? (
                <div className="mt-4 space-y-3">
                  <div className="text-sm font-medium text-text-secondary">Fixture · {fixtureTypeMeta[selectedFixture.type].label}</div>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Name</span>
                    <input
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedFixture.name}
                      onChange={(event) => updateSelectedFixture('name', event.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Type</span>
                    <select
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedFixture.type}
                      onChange={(event) => updateSelectedFixture('type', event.target.value)}
                    >
                      {Object.entries(fixtureTypeMeta).map(([type, meta]) => (
                        <option key={type} value={type}>
                          {meta.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">X (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedFixture.x}
                        onChange={(event) => updateSelectedFixture('x', event.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Y (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedFixture.y}
                        onChange={(event) => updateSelectedFixture('y', event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Width (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedFixture.widthFt}
                        onChange={(event) => updateSelectedFixture('widthFt', event.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Height (ft)</span>
                      <input
                        type="number"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={selectedFixture.heightFt}
                        onChange={(event) => updateSelectedFixture('heightFt', event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Notes</span>
                    <textarea
                      className="min-h-24 w-full rounded border border-border-subtle px-3 py-2"
                      value={selectedFixture.notes}
                      onChange={(event) => updateSelectedFixture('notes', event.target.value)}
                    />
                  </label>
                  <button className="rounded border border-red-300 px-4 py-2 text-red-700" onClick={removeSelectedFixture}>
                    Remove Selected Fixture
                  </button>
                </div>
              ) : (
                <p className="mt-4 text-sm text-text-secondary">Select a dome, line, or sink.</p>
              )}
            </div>

            <div className="rounded border border-border-subtle bg-card p-4">
              <h2 className="text-lg font-semibold text-text-primary">AI Design Log</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Log what Quinn did, what he should have done, and how we want to tune him next time.
              </p>
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Actor</span>
                    <input
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={logDraft.actor}
                      onChange={(event) => setLogDraft((current) => ({ ...current, actor: event.target.value }))}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm text-text-secondary">Kind</span>
                    <select
                      className="w-full rounded border border-border-subtle px-3 py-2"
                      value={logDraft.kind}
                      onChange={(event) =>
                        setLogDraft((current) => ({
                          ...current,
                          kind: event.target.value as PlannerLogEntry['kind'],
                        }))
                      }
                    >
                      <option value="note">Note</option>
                      <option value="plan">Plan</option>
                      <option value="edit">Edit</option>
                      <option value="review">Review</option>
                    </select>
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-sm text-text-secondary">Summary</span>
                  <textarea
                    className="min-h-20 w-full rounded border border-border-subtle px-3 py-2"
                    value={logDraft.summary}
                    onChange={(event) => setLogDraft((current) => ({ ...current, summary: event.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-text-secondary">Expected Outcome</span>
                  <textarea
                    className="min-h-20 w-full rounded border border-border-subtle px-3 py-2"
                    value={logDraft.expectedOutcome}
                    onChange={(event) =>
                      setLogDraft((current) => ({ ...current, expectedOutcome: event.target.value }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-text-secondary">Actual Outcome</span>
                  <textarea
                    className="min-h-20 w-full rounded border border-border-subtle px-3 py-2"
                    value={logDraft.actualOutcome}
                    onChange={(event) =>
                      setLogDraft((current) => ({ ...current, actualOutcome: event.target.value }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-text-secondary">Correction / Tuning Note</span>
                  <textarea
                    className="min-h-20 w-full rounded border border-border-subtle px-3 py-2"
                    value={logDraft.correction}
                    onChange={(event) => setLogDraft((current) => ({ ...current, correction: event.target.value }))}
                  />
                </label>
                <button className="rounded bg-desert-green px-4 py-2 text-white" onClick={submitLogEntry}>
                  Save Log Entry
                </button>
              </div>

              <div className="mt-6 space-y-3">
                {aiLog.map((entry) => (
                  <div key={entry.id} className="rounded border border-border-subtle p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium text-text-primary">
                        {entry.actor} · {entry.kind}
                      </div>
                      <div className="text-xs text-text-secondary">{formatStamp(entry.createdAt)}</div>
                    </div>
                    <p className="mt-2 text-sm text-text-primary">{entry.summary}</p>
                    {entry.expectedOutcome ? (
                      <p className="mt-2 text-sm text-text-secondary">
                        <strong>Expected:</strong> {entry.expectedOutcome}
                      </p>
                    ) : null}
                    {entry.actualOutcome ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        <strong>Actual:</strong> {entry.actualOutcome}
                      </p>
                    ) : null}
                    {entry.correction ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        <strong>Correction:</strong> {entry.correction}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded border border-border-subtle bg-card p-4">
              <h2 className="text-lg font-semibold text-text-primary">Gore Calculator</h2>
              <p className="mt-1 text-sm text-text-secondary">
                First pass based on spherical-cap gore math for dome air-form patterning. It is wired to the selected dome so you can size gores from the actual layout.
              </p>
              {goreData ? (
                <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Gore Count Mode</span>
                      <select
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={goreCountMode}
                        onChange={(event) => setGoreCountMode(event.target.value as 'auto' | 'manual')}
                      >
                        <option value="auto">Auto from material width</option>
                        <option value="manual">Manual</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Material Width (ft)</span>
                      <input
                        type="number"
                        step="0.01"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={materialWidthFt}
                        onChange={(event) => setMaterialWidthFt(Number(event.target.value) || 0)}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Seam Allowance Per Side (in)</span>
                      <input
                        type="number"
                        step="0.25"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={seamAllowanceIn}
                        onChange={(event) => setSeamAllowanceIn(Number(event.target.value) || 0)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Lateral Divisions</span>
                      <input
                        type="number"
                        min="2"
                        step="1"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={lateralDivisions}
                        onChange={(event) => setLateralDivisions(Number(event.target.value) || 2)}
                      />
                    </label>
                  </div>
                  {goreCountMode === 'manual' ? (
                    <label className="block">
                      <span className="mb-1 block text-sm text-text-secondary">Manual Gore Count</span>
                      <input
                        type="number"
                        min="3"
                        step="1"
                        className="w-full rounded border border-border-subtle px-3 py-2"
                        value={manualGoreCount}
                        onChange={(event) => setManualGoreCount(Number(event.target.value) || 3)}
                      />
                    </label>
                  ) : null}

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Selected dome</div>
                      <div className="font-medium text-text-primary">{selectedDome?.name}</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Recommended gores</div>
                      <div className="font-medium text-text-primary">{goreData.suggestedGores}</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Using gores</div>
                      <div className="font-medium text-text-primary">{goreData.goreCount}</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Meridian arc length</div>
                      <div className="font-medium text-text-primary">{formatNumber(goreData.meridianArcFt)} ft</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Sphere radius</div>
                      <div className="font-medium text-text-primary">{formatNumber(goreData.sphereRadiusFt)} ft</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Cap angle</div>
                      <div className="font-medium text-text-primary">{formatNumber(goreData.thetaMaxDeg)}°</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Base width per gore</div>
                      <div className="font-medium text-text-primary">{formatNumber(goreData.baseWidthPerGoreFt)} ft</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Base cut width w/ seams</div>
                      <div className="font-medium text-text-primary">{formatNumber(goreData.baseCutWidthPerGoreFt)} ft</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Usable material width</div>
                      <div className="font-medium text-text-primary">{formatNumber(goreData.usableMaterialWidthFt)} ft</div>
                    </div>
                    <div className="rounded border border-border-subtle p-3">
                      <div className="text-text-secondary">Total material length</div>
                      <div className="font-medium text-text-primary">{formatNumber(goreData.totalMaterialLengthFt)} ft</div>
                    </div>
                  </div>

                  <div className="rounded border border-border-subtle p-3 text-sm text-text-secondary">
                    <p>
                      Formula basis: sphere radius from dome diameter/rise, meridian arc length for the centerline, and gore width at each division from dome circumference at that latitude divided by gore count.
                    </p>
                    <p className="mt-2">
                      Quick read: {feetToFeetInches(goreData.baseCutWidthPerGoreFt)} base cut width per gore and {feetToFeetInches(goreData.meridianArcFt)} centerline length.
                    </p>
                  </div>

                  <div className="max-h-80 overflow-auto rounded border border-border-subtle">
                    <table className="min-w-full text-sm">
                      <thead className="bg-sand-light/40 text-left text-text-secondary">
                        <tr>
                          <th className="px-3 py-2">Div</th>
                          <th className="px-3 py-2">Angle</th>
                          <th className="px-3 py-2">Arc Height (ft)</th>
                          <th className="px-3 py-2">Full Width (ft)</th>
                          <th className="px-3 py-2">Half Width (ft)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {goreData.points.map((point) => (
                          <tr key={point.division} className="border-t border-border-subtle">
                            <td className="px-3 py-2">{point.division}</td>
                            <td className="px-3 py-2">{formatNumber(point.thetaDeg)}°</td>
                            <td className="px-3 py-2">{formatNumber(point.arcHeightFt)}</td>
                            <td className="px-3 py-2">{formatNumber(point.fullWidthFt)}</td>
                            <td className="px-3 py-2">{formatNumber(point.halfWidthFt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-text-secondary">Select a dome to calculate its gore pattern.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  )
}

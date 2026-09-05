import type { StructuralRole } from './types.js'

export interface PetStructuralUnitDefinition {
  id: string
  from: StructuralRole
  to: StructuralRole
  minimumCells: number
  preferredCells: number
  weight: number
  hard: boolean
}

export interface PetCrossSectionDefinition {
  id: string
  regionIds: readonly string[]
  minimumCells: number
  preferredCells: number
  weight: number
  hard: boolean
}

export const petStructureSchema = Object.freeze({
  id: 'quadruped-profile-v4',
  sources: Object.freeze([
    'mmpose/animalpose@v1.3.2',
    'mmpose/ap10k@v1.3.2',
    'deeplabcut/superanimal-quadruped@v3.0.1',
  ]),
})

export const petSkeletonEdges: readonly (readonly [StructuralRole, StructuralRole])[] = Object.freeze([
  ['neck-base', 'shoulder'],
  ['shoulder', 'back-middle'],
  ['back-middle', 'tail-root'],
  ['shoulder', 'chest-center'],
  ['chest-center', 'front-knee'],
  ['front-knee', 'front-paw'],
  ['tail-root', 'hip'],
  ['hip', 'rear-knee'],
  ['rear-knee', 'rear-paw'],
  ['tail-root', 'tail-tip'],
])

export const petOccupancyPathEdges: readonly (readonly [StructuralRole, StructuralRole])[] = Object.freeze([
  ['ear-tip', 'ear-root'],
  ['nose-tip', 'upper-jaw'],
  ['nose-tip', 'lower-jaw'],
  ['neck-base', 'shoulder'],
  ['shoulder', 'back-middle'],
  ['back-middle', 'tail-root'],
  ['shoulder', 'chest-center'],
  ['chest-center', 'front-knee'],
  ['front-knee', 'front-paw'],
  ['tail-root', 'hip'],
  ['hip', 'rear-knee'],
  ['rear-knee', 'rear-paw'],
  ['tail-root', 'tail-tip'],
])

export const petStructuralUnits: readonly PetStructuralUnitDefinition[] = Object.freeze([
  { id: 'eye-muzzle-span', from: 'eye-center', to: 'nose-tip', minimumCells: 2, preferredCells: 3, weight: 1.25, hard: true },
  { id: 'ear-span', from: 'ear-tip', to: 'ear-root', minimumCells: 2, preferredCells: 3, weight: 1.35, hard: true },
  { id: 'muzzle-depth', from: 'upper-jaw', to: 'lower-jaw', minimumCells: 2, preferredCells: 3, weight: 1.45, hard: true },
  { id: 'front-lower-leg', from: 'front-knee', to: 'front-paw', minimumCells: 3, preferredCells: 4, weight: 1.1, hard: true },
  { id: 'rear-lower-leg', from: 'rear-knee', to: 'rear-paw', minimumCells: 3, preferredCells: 4, weight: 1, hard: true },
  { id: 'torso-axis', from: 'shoulder', to: 'tail-root', minimumCells: 6, preferredCells: 10, weight: 0.9, hard: true },
  { id: 'tail-free-span', from: 'tail-root', to: 'tail-tip', minimumCells: 2, preferredCells: 4, weight: 0.75, hard: false },
])

export const petCrossSections: readonly PetCrossSectionDefinition[] = Object.freeze([
  {
    id: 'tail-width',
    regionIds: ['pet-tail', 'tail'],
    minimumCells: 2,
    preferredCells: 3,
    weight: 1.15,
    hard: true,
  },
  {
    id: 'front-leg-width',
    regionIds: ['pet-foreleg-visible', 'foreleg', 'front-leg'],
    minimumCells: 2,
    preferredCells: 3,
    weight: 1,
    hard: true,
  },
  {
    id: 'rear-leg-width',
    regionIds: ['pet-hindleg-visible', 'hindleg', 'rear-leg'],
    minimumCells: 2,
    preferredCells: 3,
    weight: 0.95,
    hard: true,
  },
])

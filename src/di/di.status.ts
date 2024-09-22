export const STATUS_DI = {
  Created: {
    status: 'CREATED',
    description: 'Created by manager and not sent to coordinator',
    role: ['Manager', 'Admin_Manager'],
    future_status: ['Pending 1'],
  },
  Pending1: {
    status: 'PENDING1',
    description: 'Sent to diagnostic',
    role: ['Coordinator'],
    future_status: ['Diagnostic'],
  },
  Diagnostic: {
    status: 'DIAGNOSTIC',
    description: 'Waiting for Diagnostic',
    role: ['Tech'],
    future_status: ['DiagnosticInPause'],
  },
  DiagnosticInPause: {
    status: 'DIAGNOSTIC_Pause',
    description: 'Waiting for Repair',
    role: ['Tech'],
    future_status: ['InDiagnostic'],
  },
  InDiagnostic: {
    status: 'INDIAGNOSTIC',
    description: 'Diagnostic in progress',
    role: ['Tech'],
    future_status: ['Pending2'],
  },
  MagasinEstimation: {
    status: 'MagasinEstimation',
    description: 'Magasin doing the Estimation before the negotiation starts',
    role: ['Magasin'],
    future_status: ['Pending2'],
  },
  InMagasin: {
    status: 'INMAGASIN',
    description: 'In Magasin',
    role: ['Magasin'],
    future_status: ['Pending2'],
  },
  Pending2: {
    status: 'PENDING2',
    description: 'Sent to admins for pricing',
    role: ['Coordinator'],
    future_status: ['Pricing'],
  },
  Pricing: {
    status: 'PRICING',
    description: 'Pricing in progress by one of the admins',
    role: ['Admin_Manager', 'Admin_Tech'],
    future_status: ['Negotiation'],
  },
  Negotiation1: {
    status: 'NEGOTIATION1',
    description: 'Negotiation in progress (0%-20% discount or cancel)',
    role: ['Manager'],
    future_status: ['Pending3', 'Annuler', 'Negotiation2'],
  },
  Negotiation2: {
    status: 'NEGOTIATION2',
    description: 'Negotiation in progress (20%-25% discount or price change)',
    role: ['Admin_Manager'],
    future_status: ['Pending3', 'Annuler'],
  },
  Pending3: {
    status: 'PENDING3',
    description: 'Sent to repair',
    role: ['Coordinator'],
    future_status: ['Repair'],
  },
  Reparation: {
    status: 'REPARATION',
    description: 'Waiting for Repair',
    role: ['Tech'],
    future_status: ['REPARATION_Pause'],
  },
  ReparationInPause: {
    status: 'REPARATION_Pause',
    description: 'Waiting for Repair',
    role: ['Tech'],
    future_status: ['InReparation'],
  },
  InReparation: {
    status: 'INREPARATION',
    description: 'Repair in progress by tech',
    role: ['Tech'],
    future_status: ['Finished'],
  },
  Finished: {
    status: 'FINISHED',
    description: 'DI process completed',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['Retour1'],
  },
  Annuler: {
    status: 'ANNULER',
    description: 'Cancelled by manager',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['Negotiation1'],
  },
  Retour1: {
    status: 'RETOUR1',
    description: 'Retour1',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: ['Retour2'],
  },
  Retour2: {
    status: 'RETOUR2',
    description: 'Retour2',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: ['Retour3'],
  },
  Retour3: {
    status: 'RETOUR3',
    description: 'Alert generale',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: null,
  },
};

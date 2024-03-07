export const STATUS_DI = {
  Created: {
    status: 'CREATED',
    description: 'Created by manager and not sent to coordinator',
    color: '#FFA500', // Orange
    role: ['Manager', 'Admin_Manager'],
    future_status: ['Pending 1'],
  },
  Pending1: {
    status: 'PENDING1',
    description: 'Sent to diagnostic',
    color: '#FFFF00', // Yellow
    role: ['Coordinator'],
    future_status: ['Diagnostic'],
  },
  Diagnostic: {
    status: 'DIAGNOSTIC',
    description: 'Waiting for Diagnostic',
    color: '#00FF00', // Green
    role: ['Tech'],
    future_status: ['InDiagnostic'],
  },
  InDiagnostic: {
    status: 'INDIAGNOSTIC',
    description: 'Diagnostic in progress',
    color: '#00FFFF', // Cyan
    role: ['Tech'],
    future_status: ['Pending2'],
  },
  InMagasin: {
    status: 'INMAGASIN',
    description: 'In Magasin',
    color: '#0000FF', // Blue
    role: ['Magasin'],
    future_status: ['Pending2'],
  },
  Pending2: {
    status: 'PENDING2',
    description: 'Sent to admins for pricing',
    color: '#800080', // Purple
    role: ['Coordinator'],
    future_status: ['Pricing'],
  },
  Pricing: {
    status: 'PRICING',
    description: 'Pricing in progress by one of the admins',
    color: '#FF00FF', // Magenta
    role: ['Admin_Manager', 'Admin_Tech'],
    future_status: ['Negotiation'],
  },
  Negotiation1: {
    status: 'NEGOTIATION1',
    description: 'Negotiation in progress (0%-20% discount or cancel)',
    color: '#FF0000', // Red
    role: ['Manager'],
    future_status: ['Pending3', 'Annuler', 'Negotiation2'],
  },
  Negotiation2: {
    status: 'NEGOTIATION2',
    description: 'Negotiation in progress (20%-25% discount or price change)',
    color: '#FF1493', // Deep Pink
    role: ['Admin_Manager'],
    future_status: ['Pending3', 'Annuler'],
  },
  Pending3: {
    status: 'PENDING3',
    description: 'Sent to repair',
    color: '#008000', // Dark Green
    role: ['Coordinator'],
    future_status: ['Repair'],
  },
  Reparation: {
    status: 'REPARATION',
    description: 'Waiting for Repair',
    color: '#000000', // Black
    role: ['Tech'],
    future_status: ['InReparation'],
  },
  InReparation: {
    status: 'INREPARATION',
    description: 'Repair in progress by tech',
    color: '#808080', // Gray
    role: ['Tech'],
    future_status: ['Finished'],
  },
  Finished: {
    status: 'FINISHED',
    description: 'DI process completed',
    color: '#800000', // Maroon
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['Retour1'],
  },
  Annuler: {
    status: 'ANNULER',
    description: 'Cancelled by manager',
    color: '#FF6347', // Tomato
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['Negotiation1'],
  },
  Retour1: {
    status: 'RETOUR1',
    description: 'Retour1',
    color: '#6A5ACD', // Slate Blue
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: ['Retour2'],
  },
  Retour2: {
    status: 'RETOUR2',
    description: 'Retour2',
    color: '#4682B4', // Steel Blue
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: ['Retour3'],
  },
  Retour3: {
    status: 'RETOUR3',
    description: 'Alert generale',
    color: '#6495ED', // Cornflower Blue
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: null,
  },
};

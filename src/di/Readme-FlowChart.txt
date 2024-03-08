import { createMachine, assign } from "xstate";

export const machine = createMachine({
  context: {
    role: [],
    status: "",
    future_status: [],
  },
  id: "DI",
  initial: "Created",
  states: {
    Created: {
      on: {
        proceed: {
          target: "Pending1",
          actions: {
            type: "C bon",
          },
        },
      },
      description:
        "The DI has just been created by either a Manager or an Admin_Manager.",
    },
    Pending1: {
      on: {
        proceed: {
          target: "Diagnostic",
          actions: {
            type: "C bon",
          },
        },
      },
      description: "The DI is pending and currently with the Coordinator.",
    },
    Diagnostic: {
      on: {
        proceed: {
          target: "InDiagnostic",
          actions: {
            type: "C bon",
          },
        },
      },
      description: "The DI is undergoing diagnostics by a Tech.",
    },
    InDiagnostic: {
      on: {
        proceed: {
          target: "Pending2",
          actions: {
            type: "C bon",
          },
        },
        ifPDr: {
          target: "InMagasin",
        },
      },
      description: "The DI is still in diagnostics.",
    },
    Pending2: {
      on: {
        proceed: {
          target: "Pricing",
          actions: {
            type: "c bon",
          },
        },
      },
      description: "The DI is pending again and with the Coordinator.",
    },
    InMagasin: {
      on: {
        proceed: {
          target: "Pending2",
          actions: assign({
            role: () => ["Coordinator"],
            status: () => "PENDING2",
            future_status: () => ["Pricing"],
          }),
        },
      },
      description: "The DI is in the store (Magasin).",
    },
    Pricing: {
      on: {
        proceed: {
          target: "Negotiation1",
          actions: {
            type: "C bon",
          },
        },
      },
      description:
        "Pricing is being determined by Admin_Manager or Admin_Tech.",
    },
    Negotiation1: {
      on: {
        proceed_to_pending: {
          target: "Pending3",
          actions: {
            type: "c bon",
          },
        },
        cancel: {
          target: "Annuler",
          actions: assign({
            role: () => ["Manager", "Admin_Tech", "Admin_Manager"],
            status: () => "ANNULER",
            future_status: () => ["Negotiation1"],
          }),
        },
        proceed_to_negotiation2: {
          target: "Negotiation2",
          actions: assign({
            role: () => ["Admin_Manager"],
            status: () => "NEGOTIATION2",
            future_status: () => ["Pending3", "Annuler"],
          }),
        },
      },
      description:
        "The DI is in the first stage of negotiation, handled by the Manager.",
    },
    Pending3: {
      on: {
        proceed: {
          target: "Repair",
          actions: assign({
            role: () => ["Tech"],
            status: () => "REPAIR",
            future_status: () => ["InReparation"],
          }),
        },
      },
      description:
        "The DI is pending for the third time, back with the Coordinator.",
    },
    Annuler: {
      on: {
        proceed: {
          target: "Negotiation1",
          actions: assign({
            role: () => ["Manager"],
            status: () => "NEGOTIATION1",
            future_status: () => ["Pending3", "Annuler", "Negotiation2"],
          }),
        },
      },
      description: "The DI has been canceled and may return to Negotiation1.",
    },
    Negotiation2: {
      on: {
        proceed: {
          target: "Pending3",
          actions: assign({
            role: () => ["Coordinator"],
            status: () => "PENDING3",
            future_status: () => ["Repair"],
          }),
        },
        cancel: {
          target: "Annuler",
          actions: assign({
            role: () => ["Manager", "Admin_Tech", "Admin_Manager"],
            status: () => "ANNULER",
            future_status: () => ["Negotiation1"],
          }),
        },
      },
      description:
        "The DI is in the second stage of negotiation, handled by the Admin_Manager.",
    },
    Repair: {
      on: {
        proceed: {
          target: "InReparation",
          actions: assign({
            role: () => ["Tech"],
            status: () => "INREPARATION",
            future_status: () => ["Finished"],
          }),
        },
      },
      description: "The DI is being repaired by a Tech.",
    },
    InReparation: {
      on: {
        proceed: {
          target: "Finished",
          actions: assign({
            role: () => ["Manager", "Admin_Tech", "Admin_Manager"],
            status: () => "FINISHED",
            future_status: () => ["Retour1"],
          }),
        },
      },
      description: "The DI is still under repair.",
    },
    Finished: {
      on: {
        proceed: {
          target: "Retour1",
          actions: assign({
            role: () => ["Manager", "Admin_Tech", "Admin_Manager"],
            status: () => "RETOUR1",
            future_status: () => ["Retour2"],
          }),
        },
      },
      description: "The DI is finished with the repair process.",
    },
    Retour1: {
      on: {
        proceed: {
          target: "Retour2",
          actions: assign({
            role: () => ["Manager", "Admin_Tech", "Admin_Manager"],
            status: () => "RETOUR2",
            future_status: () => ["Retour3"],
          }),
        },
      },
      description: "The DI is in the first return phase.",
    },
    Retour2: {
      on: {
        proceed: {
          target: "Retour3",
          actions: assign({
            role: () => ["Manager", "Admin_Tech", "Admin_Manager"],
            status: () => "RETOUR3",
            future_status: () => null,
          }),
        },
      },
      description: "The DI is in the second return phase.",
    },
    Retour3: {
      type: "final",
      description:
        "The DI is in the final return phase, concluding the process.",
    },
  },
}).withConfig({
  actions: {
    "C bon": assign({
      role: () => ["Manager"],
      status: () => "NEGOTIATION1",
      future_status: () => ["Pending3", "Annuler", "Negotiation2"],
    }),
    "c bon": assign({
      role: () => ["Coordinator"],
      status: () => "PENDING3",
      future_status: () => ["Repair"],
    }),
  },
});
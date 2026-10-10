import type { AdvisorUnavailable } from "./advisor-unavailable.ts"
import type { ConsultationTimedOut } from "./consultation-timed-out.ts"
import type { HostError } from "./host-error.ts"
import type { InvalidModel } from "./invalid-model.ts"

/** Every reason a consultation can end without advice. */
type ConsultationError =
  | AdvisorUnavailable
  | ConsultationTimedOut
  | HostError
  | InvalidModel

export type { ConsultationError }

/**
 * Lifecycle module — registers emergency_stop + resume_processing
 * system actions.
 *
 * Imported (for side-effect registration) from src/index.ts after
 * delivery polls are started.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleEmergencyStop, handleResumeProcessing } from './actions.js';

registerDeliveryAction('emergency_stop', handleEmergencyStop);
registerDeliveryAction('resume_processing', handleResumeProcessing);
